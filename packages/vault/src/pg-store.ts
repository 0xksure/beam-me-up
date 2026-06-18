/**
 * PgCredentialStore — the real Postgres CredentialStore.
 *
 * Find-or-creates the users row, envelope-seals on write, decrypts on read, and
 * refreshes OAuth access tokens on near-expiry inside a SELECT … FOR UPDATE
 * transaction (so a concurrent /mcp request blocks then reads the rotated row).
 * Only the gated integration test (BEAM_VAULT_DATABASE_URL set) exercises this;
 * offline runs use the in-memory store.
 */
import type { Pool, PoolClient } from "pg";
import type {
  ProviderToken,
  DbEngine,
  NeonCreds,
  UpstashCreds,
} from "@beam-me-up/adapters";
import { EnvelopeCrypto, type SealedConnection } from "./crypto/envelope.js";
import type { AadBinding, EnvelopedSecret } from "./crypto/types.js";
import type { Subject } from "./subject.js";
import { assertSubject } from "./subject.js";
import {
  type AnyProvider,
  type ConnectionStatus,
  type ConnectionSummary,
  type CredentialStore,
  type Provider,
  type ProviderRefreshFn,
  type UpsertConnectionInput,
  dbEngineToProvider,
} from "./store.js";

const REFRESH_SKEW_SECONDS = 60;

export interface PgCredentialStoreDeps {
  pool: Pool;
  crypto: EnvelopeCrypto;
  /** P3 fills these; absent => no refresh path for that provider. */
  refreshFns?: Partial<Record<Provider, ProviderRefreshFn>>;
  /** Epoch seconds; defaults to Date.now()/1000. */
  now?: () => number;
}

type ConnRow = {
  id: string;
  provider: AnyProvider;
  provider_account_id: string;
  scopes: string[];
  access_token_ciphertext: Buffer;
  access_token_nonce: Buffer;
  access_token_tag: Buffer;
  refresh_token_ciphertext: Buffer | null;
  refresh_token_nonce: Buffer | null;
  refresh_token_tag: Buffer | null;
  wrapped_dek: Buffer;
  key_id: string;
  access_token_expires_at: Date | null;
  refresh_token_expires_at: Date | null;
  status: ConnectionStatus;
};

function toEpoch(d: Date | null): number | null {
  return d ? Math.floor(d.getTime() / 1000) : null;
}

function toTimestamp(epoch: number | null | undefined): Date | null {
  return epoch === null || epoch === undefined ? null : new Date(epoch * 1000);
}

export function createPgCredentialStore(deps: PgCredentialStoreDeps): CredentialStore {
  const { pool, crypto } = deps;
  const refreshFns = deps.refreshFns ?? {};
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  function aadBase(
    subject: Subject,
    provider: AnyProvider,
    providerAccountId: string,
  ): Omit<AadBinding, "field"> {
    return {
      oauthIssuer: subject.issuer,
      oauthSubject: subject.sub,
      provider,
      providerAccountId,
    };
  }

  async function findOrCreateUser(client: PoolClient, subject: Subject): Promise<string> {
    const insert = await client.query<{ id: string }>(
      `INSERT INTO users (oauth_issuer, oauth_subject)
         VALUES ($1, $2)
         ON CONFLICT (oauth_issuer, oauth_subject)
         DO UPDATE SET last_seen_at = now()
         RETURNING id`,
      [subject.issuer, subject.sub],
    );
    return insert.rows[0]!.id;
  }

  function rowAccessSecret(row: ConnRow): EnvelopedSecret {
    return {
      ciphertext: row.access_token_ciphertext,
      nonce: row.access_token_nonce,
      tag: row.access_token_tag,
    };
  }

  function rowRefreshSecret(row: ConnRow): EnvelopedSecret | null {
    if (!row.refresh_token_ciphertext || !row.refresh_token_nonce || !row.refresh_token_tag) {
      return null;
    }
    return {
      ciphertext: row.refresh_token_ciphertext,
      nonce: row.refresh_token_nonce,
      tag: row.refresh_token_tag,
    };
  }

  async function openAccess(subject: Subject, row: ConnRow): Promise<string> {
    const plain = await crypto.open({
      secret: rowAccessSecret(row),
      wrappedDek: row.wrapped_dek,
      keyId: row.key_id,
      aad: { ...aadBase(subject, row.provider, row.provider_account_id), field: "access_token" },
    });
    return plain.toString("utf8");
  }

  async function openRefresh(subject: Subject, row: ConnRow): Promise<string | null> {
    const secret = rowRefreshSecret(row);
    if (!secret) return null;
    const plain = await crypto.open({
      secret,
      wrappedDek: row.wrapped_dek,
      keyId: row.key_id,
      aad: { ...aadBase(subject, row.provider, row.provider_account_id), field: "refresh_token" },
    });
    return plain.toString("utf8");
  }

  async function writeSealed(
    client: PoolClient,
    id: string,
    sealed: SealedConnection,
    accessExpiresAt: number | null,
    refreshExpiresAt: number | null,
  ): Promise<void> {
    await client.query(
      `UPDATE provider_connections SET
         access_token_ciphertext = $2,
         access_token_nonce      = $3,
         access_token_tag        = $4,
         refresh_token_ciphertext = $5,
         refresh_token_nonce      = $6,
         refresh_token_tag        = $7,
         wrapped_dek = $8,
         key_id      = $9,
         access_token_expires_at  = $10,
         refresh_token_expires_at = $11,
         updated_at = now()
       WHERE id = $1`,
      [
        id,
        sealed.access.ciphertext,
        sealed.access.nonce,
        sealed.access.tag,
        sealed.refresh?.ciphertext ?? null,
        sealed.refresh?.nonce ?? null,
        sealed.refresh?.tag ?? null,
        sealed.wrappedDek,
        sealed.keyId,
        toTimestamp(accessExpiresAt),
        toTimestamp(refreshExpiresAt),
      ],
    );
  }

  async function upsertConnection(input: UpsertConnectionInput): Promise<void> {
    const subject = assertSubject(input.subject);
    const providerAccountId = input.providerAccountId ?? "";
    const sealed = await crypto.sealConnection({
      accessToken: Buffer.from(input.accessToken, "utf8"),
      refreshToken: input.refreshToken ? Buffer.from(input.refreshToken, "utf8") : undefined,
      aadBase: aadBase(subject, input.provider, providerAccountId),
    });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const userId = await findOrCreateUser(client, subject);
      await client.query(
        `INSERT INTO provider_connections (
            user_id, provider, provider_account_id, scopes,
            access_token_ciphertext, access_token_nonce, access_token_tag,
            refresh_token_ciphertext, refresh_token_nonce, refresh_token_tag,
            wrapped_dek, key_id,
            access_token_expires_at, refresh_token_expires_at, status
         ) VALUES (
            $1,$2,$3,$4,
            $5,$6,$7,
            $8,$9,$10,
            $11,$12,
            $13,$14,'active'
         )
         ON CONFLICT (user_id, provider, provider_account_id) DO UPDATE SET
            scopes = EXCLUDED.scopes,
            access_token_ciphertext = EXCLUDED.access_token_ciphertext,
            access_token_nonce      = EXCLUDED.access_token_nonce,
            access_token_tag        = EXCLUDED.access_token_tag,
            refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
            refresh_token_nonce      = EXCLUDED.refresh_token_nonce,
            refresh_token_tag        = EXCLUDED.refresh_token_tag,
            wrapped_dek = EXCLUDED.wrapped_dek,
            key_id      = EXCLUDED.key_id,
            access_token_expires_at  = EXCLUDED.access_token_expires_at,
            refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
            status = 'active',
            updated_at = now()`,
        [
          userId,
          input.provider,
          providerAccountId,
          input.scopes,
          sealed.access.ciphertext,
          sealed.access.nonce,
          sealed.access.tag,
          sealed.refresh?.ciphertext ?? null,
          sealed.refresh?.nonce ?? null,
          sealed.refresh?.tag ?? null,
          sealed.wrappedDek,
          sealed.keyId,
          toTimestamp(input.accessTokenExpiresAt ?? null),
          toTimestamp(input.refreshTokenExpiresAt ?? null),
        ],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function lockActiveRow(
    client: PoolClient,
    subject: Subject,
    provider: AnyProvider,
  ): Promise<ConnRow | null> {
    const { rows } = await client.query<ConnRow>(
      `SELECT pc.* FROM provider_connections pc
         JOIN users u ON u.id = pc.user_id
        WHERE u.oauth_issuer = $1 AND u.oauth_subject = $2
          AND pc.provider = $3 AND pc.status = 'active'
        ORDER BY pc.updated_at DESC
        LIMIT 1
        FOR UPDATE OF pc`,
      [subject.issuer, subject.sub, provider],
    );
    return rows[0] ?? null;
  }

  async function getProviderToken(
    subject: Subject,
    provider: Provider,
  ): Promise<ProviderToken | null> {
    assertSubject(subject);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const row = await lockActiveRow(client, subject, provider);
      if (!row) {
        await client.query("COMMIT");
        return null;
      }

      const expiresAt = toEpoch(row.access_token_expires_at);
      const needsRefresh = expiresAt !== null && expiresAt - now() < REFRESH_SKEW_SECONDS;
      const refreshFn = refreshFns[provider];

      if (needsRefresh && refreshFn) {
        const refreshToken = await openRefresh(subject, row);
        if (refreshToken) {
          let result: Awaited<ReturnType<ProviderRefreshFn>>;
          try {
            result = await refreshFn(refreshToken);
          } catch {
            await client.query(
              "UPDATE provider_connections SET status='revoked', updated_at=now() WHERE id=$1",
              [row.id],
            );
            await client.query("COMMIT");
            return null;
          }
          if ("reuseDetected" in result) {
            await client.query(
              "UPDATE provider_connections SET status='revoked', updated_at=now() WHERE id=$1",
              [row.id],
            );
            await client.query("COMMIT");
            return null;
          }
          const sealed = await crypto.sealConnection({
            accessToken: Buffer.from(result.accessToken, "utf8"),
            refreshToken: Buffer.from(result.refreshToken ?? refreshToken, "utf8"),
            aadBase: aadBase(subject, row.provider, row.provider_account_id),
          });
          await writeSealed(
            client,
            row.id,
            sealed,
            result.accessTokenExpiresAt ?? null,
            result.refreshTokenExpiresAt ?? toEpoch(row.refresh_token_expires_at),
          );
          await client.query("COMMIT");
          const teamId = row.provider_account_id || undefined;
          return teamId ? { token: result.accessToken, teamId } : { token: result.accessToken };
        }
        // refreshFn is configured but there is no stored refresh token: the
        // access token is at/past expiry and cannot be renewed -> signal
        // "reconnect needed" rather than handing back a doomed token.
        await client.query("COMMIT");
        return null;
      }

      const token = await openAccess(subject, row);
      await client.query("COMMIT");
      const teamId = row.provider_account_id || undefined;
      return teamId ? { token, teamId } : { token };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function getDbCredentials(
    subject: Subject,
    engine: DbEngine,
  ): Promise<NeonCreds | UpstashCreds | null> {
    assertSubject(subject);
    const provider = dbEngineToProvider(engine);
    const client = await pool.connect();
    try {
      const { rows } = await client.query<ConnRow>(
        `SELECT pc.* FROM provider_connections pc
           JOIN users u ON u.id = pc.user_id
          WHERE u.oauth_issuer = $1 AND u.oauth_subject = $2
            AND pc.provider = $3 AND pc.status = 'active'
          ORDER BY pc.updated_at DESC
          LIMIT 1`,
        [subject.issuer, subject.sub, provider],
      );
      const row = rows[0];
      if (!row) return null;
      const secret = await openAccess(subject, row);
      if (provider === "neon") {
        return { apiKey: secret } satisfies NeonCreds;
      }
      return { email: row.provider_account_id, apiKey: secret } satisfies UpstashCreds;
    } finally {
      client.release();
    }
  }

  async function listConnections(subject: Subject): Promise<ConnectionSummary[]> {
    assertSubject(subject);
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{
        provider: AnyProvider;
        provider_account_id: string;
        scopes: string[];
        status: ConnectionStatus;
        access_token_expires_at: Date | null;
        updated_at: Date;
      }>(
        `SELECT pc.provider, pc.provider_account_id, pc.scopes, pc.status,
                pc.access_token_expires_at, pc.updated_at
           FROM provider_connections pc
           JOIN users u ON u.id = pc.user_id
          WHERE u.oauth_issuer = $1 AND u.oauth_subject = $2
          ORDER BY pc.provider, pc.provider_account_id`,
        [subject.issuer, subject.sub],
      );
      return rows.map((r) => ({
        provider: r.provider,
        providerAccountId: r.provider_account_id,
        scopes: r.scopes,
        status: r.status,
        accessTokenExpiresAt: toEpoch(r.access_token_expires_at),
        updatedAt: Math.floor(r.updated_at.getTime() / 1000),
      }));
    } finally {
      client.release();
    }
  }

  async function revoke(subject: Subject, provider: AnyProvider): Promise<void> {
    assertSubject(subject);
    const client = await pool.connect();
    try {
      await client.query(
        `DELETE FROM provider_connections pc
           USING users u
          WHERE pc.user_id = u.id
            AND u.oauth_issuer = $1 AND u.oauth_subject = $2
            AND pc.provider = $3`,
        [subject.issuer, subject.sub, provider],
      );
    } finally {
      client.release();
    }
  }

  return {
    getProviderToken,
    getDbCredentials,
    upsertConnection,
    listConnections,
    revoke,
  };
}

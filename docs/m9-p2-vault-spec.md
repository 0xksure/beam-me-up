# Beam Me Up — M9 P2: Per-User Credential Vault — Build Spec

Status: implementer-ready. Scope: the credential vault subsystem (`@beam-me-up/vault`), its envelope crypto, the P1 `CredentialContext` wiring + sub-rejection guard, lifecycle (refresh/revoke/oauth_states), the offline test strategy with its merge-blocking gate, and the P2a/P2b phase split. Everything below is grounded in the repo as it exists on `main` today; deviations from the prior design sketch are called out where they were verified to be wrong.

---

## 0. Overview and honest scoping note

The vault gives each authenticated MCP user their own encrypted-at-rest provider credentials, keyed on `(oauth_issuer, oauth_subject)`. Tools resolve a per-request `CredentialContext` instead of reading process env, so one hosted server can serve many users without any of them sharing a token.

**This is a net-new subsystem, not three additive tables on an existing DB.** Two facts were verified in the repo and must shape the build:

1. **The "Neon adapter" cannot store Beam's rows.** `packages/adapters/src/db/neon/client.ts` is a REST client against `https://console.neon.tech/api/v2` whose job is to *provision databases for end users* (`DbProvisioner.provision()` returns connection-string env vars). It is not a SQL connection Beam writes to. The vault needs a **separate, Beam-owned Postgres metadata database**, reached over the wire protocol with a real driver. Where the original design said "on the existing Neon Postgres," read it as *a Beam-owned Neon project*, never a user's provisioned DB.

2. **No persistence/crypto/secrets dependency exists anywhere.** The root and all six `package.json` files declare only `@beam-me-up/*`, `@types/node`, `tsx`, `typescript`. There is no `pg`, no `jose`, no `@aws-sdk/client-kms`, no `@google-cloud/kms`, no redis driver. The vault is built from scratch: persistence (`pg`) + envelope crypto (`node:crypto`) + a pluggable KEK.

Two more verified facts the wiring depends on:

- **Identity seam.** `packages/server/src/auth/oauth/verifier.ts` returns `AuthInfo = { subject?: string; scopes; expiresAt?; clientId?; claims }`, where `subject = claims.sub` and `claims.iss` carries the issuer. `subject` is **optional**, so the vault must treat a missing/empty `sub` as an auth failure on the hosted path — never as a wildcard and never falling back to `clientId`.
- **The success branch discards auth today.** `packages/server/src/server/http.ts` (the `if (guard) { … }` block, ~lines 170-180) checks `result.ok` and then drops `result.auth` on the floor; `createServer()` (~line 186) is called with no context. This is exactly where the per-request `ctx` gets built.

**Monorepo DAG** (from `tsconfig.solution.json`): `core <- detect <- templates <- adapters <- tools <- server`. The vault must sit at or below `adapters`, because `adapters/src/token.ts` consumes it.

---

## 1. Dependencies, package, and config surface

### 1.1 New workspace package: `@beam-me-up/vault`

Create `packages/vault`. It depends on `@beam-me-up/core` only and is depended on by `@beam-me-up/adapters` (the `CredentialContext` resolvers call into it) and `@beam-me-up/server` (the Connect web surface, P3). Placing it **below `adapters`** lets `adapters/src/token.ts` import it without a cycle.

Why a dedicated package rather than a module inside `adapters`: the vault introduces the only heavy/optional-native deps in the repo (`pg`, optional KMS SDKs). Isolating them keeps the `tools`/`server` build dependency-light, lets the `stdio`/self-host/loopback build tree-shake the vault out entirely (the env-var fallback path needs none of it), and gives migrations a natural home.

`packages/vault/package.json`:

```json
{
  "name": "@beam-me-up/vault",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "dependencies": {
    "@beam-me-up/core": "*",
    "pg": "^8.13.0"
  },
  "optionalDependencies": {
    "@aws-sdk/client-kms": "^3.700.0",
    "@google-cloud/kms": "^4.5.0"
  },
  "devDependencies": {
    "@types/pg": "^8.11.0"
  }
}
```

| Dependency | Version | Scope | Why |
|---|---|---|---|
| `pg` | `^8.13.0` | prod | Postgres wire-protocol client + built-in connection `Pool` for the Beam-owned metadata DB. Pure-JS by default (no native build). Parameterized queries (`$1`), `bytea` ↔ `Buffer`, transactions for refresh rotation, `ON CONFLICT` upserts. This is the dependency the repo entirely lacks. |
| `@types/pg` | `^8.11.0` | dev | Types for `pg`. |
| `@aws-sdk/client-kms` | `^3.700.0` | **optional** | AWS-KMS `KekProvider` (Encrypt/Decrypt to wrap/unwrap DEKs). Optional so self-host installs don't pull the AWS SDK; loaded via dynamic `import()` only when `BEAM_KEK_PROVIDER=aws-kms`. |
| `@google-cloud/kms` | `^4.5.0` | **optional** | GCP-KMS `KekProvider`. Same dynamic-import rationale. |

**Crypto needs no dependency.** Envelope crypto (DEK generation, AES-256-GCM, AAD, nonce, tag) and the local-dev KEK use `node:crypto` only — consistent with the repo's Node-only (`node:http` + `node:crypto`) stance. The `oauth_states` signed-state HMAC (P3) is also `node:crypto.createHmac`; this spec only persists the state row.

### 1.2 Migration approach — no migration framework

Per the repo's dependency-light ethos, use plain numbered, idempotent SQL files applied by a tiny in-package runner. No `prisma`/`drizzle`/`node-pg-migrate`.

- Files: `packages/vault/migrations/NNNN_name.sql`, lexicographically ordered, **forward-only**, each wrapped in `BEGIN/COMMIT` and written idempotently (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).
- A `schema_migrations(version text primary key, applied_at timestamptz default now())` ledger. The runner applies any file whose `NNNN` prefix is absent from the ledger, each inside its own transaction, under `pg_advisory_lock` so concurrent hosted instances don't race on boot.
- Runner: `packages/vault/src/migrate.ts` exporting `runMigrations(pool: Pool): Promise<{ applied: string[] }>`; invoked on server boot (hosted) and exposed as `npm run vault:migrate`.

### 1.3 Environment / config surface

```
BEAM_VAULT_DATABASE_URL   # postgres conn string to the Beam-OWNED metadata DB (NOT a user DB)
BEAM_VAULT_PG_SSL         # "require" in hosted; sets pg ssl
BEAM_TIER                 # "hosted" | "self-host"  (controls the two guardrails below)
BEAM_KEK_PROVIDER         # "local-dev" | "aws-kms" | "gcp-kms"  (hosted MUST NOT be local-dev)
BEAM_KEK_LOCAL_SECRET     # base64 32-byte KEK, DEV-ONLY; ignored unless provider=local-dev
BEAM_KMS_KEY_ID           # aws: KMS key ARN/alias; gcp: full CryptoKeyVersion resource name
```

**Two mandatory hosted guardrails, enforced as code (not comments):**

1. **No local KEK on hosted.** At boot, if `BEAM_TIER=hosted` and `BEAM_KEK_PROVIDER` is `local-dev` or unset, `buildKekProvider` throws and the server refuses to start. A KMS-backed KEK is mandatory for hosted; there is no single-static-key fallback for that tier. (Mirrors `http.ts` already refusing an unauthenticated non-loopback start.)
2. **Mandatory `sub` on hosted.** See §3.2 — a verified token with empty/missing `sub` (or `iss`) is rejected 401 before the vault is ever consulted.

### 1.4 Wiring into the build

- Add `{ "path": "packages/vault" }` to `tsconfig.solution.json` `references`, between `core` and `adapters`.
- Add `"@beam-me-up/vault": "*"` to `packages/adapters/package.json` dependencies.
- Add to root `package.json` scripts: `"vault:migrate": "tsx packages/vault/src/migrate.ts"` and `"test:m9": "tsx test/m9.test.ts"`.

---

## 2. Postgres schema — concrete DDL

Three tables plus the ledger, in one migration. `bytea` round-trips as `Buffer` through `pg`. UUIDs via `gen_random_uuid()` (`pgcrypto`, available on Neon). The schema stores access/refresh tokens and the PKCE verifier as **envelope-encrypted** triples (`*_ciphertext`, `*_nonce`, `*_tag`) under a per-row wrapped DEK plus the `key_id` that wrapped it.

`packages/vault/migrations/0001_init.sql`:

```sql
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- users — one row per authenticated MCP identity. THE TENANT KEY is the
-- (oauth_issuer, oauth_subject) pair from the verified JWT (verifier.ts:
-- AuthInfo.subject = claims.sub; issuer = claims.iss). NEVER clientId.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oauth_issuer   text NOT NULL,
  oauth_subject  text NOT NULL,
  email          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_issuer_subject_key UNIQUE (oauth_issuer, oauth_subject)
);

-- ---------------------------------------------------------------------------
-- provider_connections — one row per (user, provider, provider account).
-- Holds envelope-encrypted access + refresh tokens (one shared per-row DEK),
-- the wrapped DEK, and the key_id of the KEK that wrapped it (for rotation).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_connections (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider                    text NOT NULL
                                CHECK (provider IN
                                  ('vercel','digitalocean','neon','upstash','github')),
  provider_account_id         text NOT NULL DEFAULT '',   -- '' when provider has no account id
  scopes                      text[] NOT NULL DEFAULT '{}',

  -- envelope crypto, access token (AES-256-GCM, per-row DEK)
  access_token_ciphertext     bytea NOT NULL,
  access_token_nonce          bytea NOT NULL,             -- 12 bytes (GCM IV)
  access_token_tag            bytea NOT NULL,             -- 16 bytes (GCM tag)

  -- envelope crypto, refresh token (NULL when the provider issues none)
  refresh_token_ciphertext    bytea,
  refresh_token_nonce         bytea,                      -- 12 bytes; NULL iff ciphertext NULL
  refresh_token_tag           bytea,                      -- 16 bytes; NULL iff ciphertext NULL

  wrapped_dek                 bytea NOT NULL,             -- per-row DEK, encrypted under the KEK
  key_id                      text  NOT NULL,             -- KEK key/version that wrapped wrapped_dek

  access_token_expires_at     timestamptz,
  refresh_token_expires_at    timestamptz,
  status                      text NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active','expired','revoked')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT provider_connections_uniq
    UNIQUE (user_id, provider, provider_account_id),
  CONSTRAINT refresh_triple_pairing
    CHECK ((refresh_token_ciphertext IS NULL) = (refresh_token_nonce IS NULL)
       AND (refresh_token_ciphertext IS NULL) = (refresh_token_tag   IS NULL))
);

-- Hot path: resolve (user, provider) -> active connection.
CREATE INDEX IF NOT EXISTS provider_connections_user_provider_idx
  ON provider_connections (user_id, provider)
  WHERE status = 'active';

-- Background sweeper for soon-to-expire access tokens.
CREATE INDEX IF NOT EXISTS provider_connections_access_expiry_idx
  ON provider_connections (access_token_expires_at)
  WHERE status = 'active';

-- Operational: re-wrap rows still on an old KEK during key rotation.
CREATE INDEX IF NOT EXISTS provider_connections_key_id_idx
  ON provider_connections (key_id);

-- ---------------------------------------------------------------------------
-- oauth_states — the ONLY short-lived stateful piece. One row per in-flight
-- Connect handshake; single-use, <=10 min TTL, deleted on consume. The PKCE
-- verifier is itself enveloped so a DB reader cannot replay an authorization.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_states (
  state                     text PRIMARY KEY,             -- random 256-bit, base64url
  user_id                   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider                  text NOT NULL,
  pkce_verifier_ciphertext  bytea NOT NULL,
  pkce_verifier_nonce       bytea NOT NULL,               -- 12 bytes
  pkce_verifier_tag         bytea NOT NULL,               -- 16 bytes
  pkce_wrapped_dek          bytea NOT NULL,
  pkce_key_id               text  NOT NULL,
  redirect_after            text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  expires_at                timestamptz NOT NULL          -- app enforces <= now()+10min
);

CREATE INDEX IF NOT EXISTS oauth_states_expires_at_idx
  ON oauth_states (expires_at);

COMMIT;
```

Design notes:
- `provider_account_id` is `NOT NULL DEFAULT ''` so the `UNIQUE(user_id, provider, provider_account_id)` key is total — Postgres treats `NULL`s as distinct, which would silently permit duplicate connections; `''` makes "no account id" a single deduplicated slot.
- `ON DELETE CASCADE` on both child tables: deleting a `users` row drops all its connections and in-flight states.
- One shared per-row DEK encrypts both the access and refresh token (so the row has a single `wrapped_dek`/`key_id`); the two are kept distinct by AAD `field` (§3).

---

## 3. EnvelopeCrypto + pluggable KEK

Location: `packages/vault/src/crypto/`. `node:crypto` only; AES-256-GCM with a per-row 256-bit DEK, 12-byte nonce, 16-byte tag, and an AAD that binds the ciphertext to its owner so a row cannot be swapped between users.

### 3.1 Wire types and AAD

```ts
// packages/vault/src/crypto/types.ts

/** One enveloped secret (maps to *_ciphertext / *_nonce / *_tag + the row's
 *  shared wrapped_dek/key_id). All binary fields are Buffers (pg bytea). */
export interface EnvelopedSecret {
  ciphertext: Buffer;   // AES-256-GCM ciphertext (no tag appended; tag is separate)
  nonce: Buffer;        // 12 bytes (GCM IV)
  tag: Buffer;          // 16 bytes (GCM tag)
}

/** Canonical, order-fixed binding that becomes the GCM AAD. A row cannot be
 *  decrypted under a different owner/provider/field — swapping a ciphertext
 *  between users makes GCM tag verification fail. */
export interface AadBinding {
  oauthIssuer: string;
  oauthSubject: string;       // JWT sub
  provider: string;           // vercel | digitalocean | neon | upstash | github
  providerAccountId: string;  // '' when none
  field: "access_token" | "refresh_token" | "pkce_verifier";
}
```

```ts
// packages/vault/src/crypto/aad.ts
import { Buffer } from "node:buffer";
import type { AadBinding } from "./types.js";

/** Deterministic, injective encoding (length-prefixed parts so no concat
 *  ambiguity). This exact byte string is the GCM AAD for both seal and open. */
export function canonicalAad(b: AadBinding): Buffer {
  const parts = [
    "beam-vault-aad-v1",
    b.oauthIssuer, b.oauthSubject, b.provider, b.providerAccountId, b.field,
  ];
  const out: Buffer[] = [];
  for (const p of parts) {
    const u = Buffer.from(p, "utf8");
    const len = Buffer.allocUnsafe(4);
    len.writeUInt32BE(u.length, 0);
    out.push(len, u);
  }
  return Buffer.concat(out);
}
```

### 3.2 The crypto core

```ts
// packages/vault/src/crypto/envelope.ts
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type { KekProvider } from "./kek/interface.js";
import type { AadBinding, EnvelopedSecret } from "./types.js";
import { canonicalAad } from "./aad.js";

const ALG = "aes-256-gcm";
const DEK_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** A sealed row: one shared DEK wraps both tokens; key_id pins the KEK. */
export interface SealedConnection {
  access: EnvelopedSecret;
  refresh?: EnvelopedSecret;
  wrappedDek: Buffer;
  keyId: string;
}

export class EnvelopeCrypto {
  constructor(private readonly kek: KekProvider) {}

  /** Seal access (+ optional refresh) under ONE fresh per-row DEK, so the row
   *  has a single wrapped_dek/key_id (matching the schema). Distinct nonces and
   *  field-distinguished AAD keep the two ciphertexts unconfusable. The plaintext
   *  DEK never leaves this call. */
  async sealConnection(input: {
    accessToken: Buffer;
    refreshToken?: Buffer;
    aadBase: Omit<AadBinding, "field">;
  }): Promise<SealedConnection> {
    const dek = randomBytes(DEK_BYTES);
    try {
      const access = this.gcmSeal(dek, input.accessToken,
        { ...input.aadBase, field: "access_token" });
      const refresh = input.refreshToken
        ? this.gcmSeal(dek, input.refreshToken,
            { ...input.aadBase, field: "refresh_token" })
        : undefined;
      const { wrappedDek, keyId } = await this.kek.wrap(dek);
      return { access, refresh, wrappedDek, keyId };
    } finally {
      dek.fill(0); // best-effort zeroize
    }
  }

  /** Seal a single secret (used for the PKCE verifier in oauth_states). */
  async seal(plaintext: Buffer, aad: AadBinding): Promise<EnvelopedSecret & {
    wrappedDek: Buffer; keyId: string;
  }> {
    const dek = randomBytes(DEK_BYTES);
    try {
      const s = this.gcmSeal(dek, plaintext, aad);
      const { wrappedDek, keyId } = await this.kek.wrap(dek);
      return { ...s, wrappedDek, keyId };
    } finally {
      dek.fill(0);
    }
  }

  /** Unwrap the DEK under the KEK named by keyId, then AES-256-GCM-decrypt with
   *  the SAME aad. Throws if the tag fails (tamper / wrong owner / wrong field). */
  async open(args: {
    secret: EnvelopedSecret; wrappedDek: Buffer; keyId: string; aad: AadBinding;
  }): Promise<Buffer> {
    const dek = await this.kek.unwrap(args.wrappedDek, args.keyId);
    try {
      const d = createDecipheriv(ALG, dek, args.secret.nonce, { authTagLength: TAG_BYTES });
      d.setAAD(canonicalAad(args.aad));
      d.setAuthTag(args.secret.tag);
      return Buffer.concat([d.update(args.secret.ciphertext), d.final()]);
    } finally {
      dek.fill(0);
    }
  }

  /** Rotation WITHOUT re-encrypting tokens: unwrap the DEK under its old KEK,
   *  re-wrap under the current KEK, return the new (wrappedDek, keyId). The
   *  ciphertext/nonce/tag columns are untouched. */
  async rewrapDek(wrappedDek: Buffer, oldKeyId: string)
    : Promise<{ wrappedDek: Buffer; keyId: string }> {
    const dek = await this.kek.unwrap(wrappedDek, oldKeyId);
    try {
      return await this.kek.wrap(dek);
    } finally {
      dek.fill(0);
    }
  }

  private gcmSeal(dek: Buffer, plaintext: Buffer, aad: AadBinding): EnvelopedSecret {
    const nonce = randomBytes(NONCE_BYTES);
    const c = createCipheriv(ALG, dek, nonce, { authTagLength: TAG_BYTES });
    c.setAAD(canonicalAad(aad));
    const ciphertext = Buffer.concat([c.update(plaintext), c.final()]);
    return { ciphertext, nonce, tag: c.getAuthTag() };
  }
}
```

`rewrapDek` is the crown-jewel property: a KEK rotation iterates `provider_connections WHERE key_id = <old>`, calls `rewrapDek`, and writes back only `wrapped_dek` + `key_id` per row in a transaction. Token ciphertext/nonce/tag are never touched, so no plaintext token is materialized during rotation.

### 3.3 Pluggable KekProvider

```ts
// packages/vault/src/crypto/kek/interface.ts

/** Wraps/unwraps per-row DEKs. For the KMS impls the KEK material never enters
 *  Beam's address space (wrap/unwrap are remote calls); only local-dev holds
 *  key bytes, and only for self-host. */
export interface KekProvider {
  /** The KEK/version this provider currently wraps with; stored as key_id so
   *  unwrap targets the right key even after rotation. */
  readonly currentKeyId: string;
  /** Encrypt a 32-byte DEK under the KEK. */
  wrap(dek: Buffer): Promise<{ wrappedDek: Buffer; keyId: string }>;
  /** Decrypt a wrapped DEK using the KEK named by keyId (may differ from
   *  currentKeyId during/after rotation). */
  unwrap(wrappedDek: Buffer, keyId: string): Promise<Buffer>;
}
```

Local-dev (self-host only), `node:crypto` AES-256-GCM wrap of the DEK:

```ts
// packages/vault/src/crypto/kek/local-dev.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KekProvider } from "./interface.js";

/**
 * DEV-ONLY. KEK = 32-byte secret from BEAM_KEK_LOCAL_SECRET (base64). Wraps the
 * DEK as nonce||ciphertext||tag. NOT permitted on hosted — buildKekProvider
 * throws if BEAM_TIER=hosted and provider=local-dev. The KEK lives in-process,
 * so this is the weaker fallback the spec forbids for hosted.
 */
export class LocalDevKekProvider implements KekProvider {
  readonly currentKeyId = "local-dev/v1";
  constructor(private readonly kek: Buffer /* 32 bytes */) {}

  async wrap(dek: Buffer) {
    const nonce = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.kek, nonce, { authTagLength: 16 });
    const body = Buffer.concat([c.update(dek), c.final()]);
    return { wrappedDek: Buffer.concat([nonce, body, c.getAuthTag()]), keyId: this.currentKeyId };
  }
  async unwrap(wrappedDek: Buffer, _keyId: string) {
    const nonce = wrappedDek.subarray(0, 12);
    const tag = wrappedDek.subarray(wrappedDek.length - 16);
    const body = wrappedDek.subarray(12, wrappedDek.length - 16);
    const d = createDecipheriv("aes-256-gcm", this.kek, nonce, { authTagLength: 16 });
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]);
  }
}
```

KMS adapter shapes (dynamic-imported; `optionalDependencies`):

```ts
// packages/vault/src/crypto/kek/aws-kms.ts
// const { KMSClient, EncryptCommand, DecryptCommand } = await import("@aws-sdk/client-kms");
export class AwsKmsKekProvider /* implements KekProvider */ {
  // currentKeyId = BEAM_KMS_KEY_ID (key ARN or alias).
  // wrap(dek):     KMS Encrypt { KeyId: currentKeyId, Plaintext: dek }
  //                -> { wrappedDek: CiphertextBlob, keyId: <KeyId from response> }
  // unwrap(b, id): KMS Decrypt { CiphertextBlob: b, KeyId: id }  // pin the key
  //                -> Plaintext (the DEK; exists only transiently in-process)
}

// packages/vault/src/crypto/kek/gcp-kms.ts
export class GcpKmsKekProvider /* implements KekProvider */ {
  // currentKeyId = full CryptoKeyVersion resource name.
  // wrap:   kms.encrypt({ name: <cryptoKey>, plaintext: dek }) -> ciphertext
  // unwrap: kms.decrypt({ name: <cryptoKey>, ciphertext })     -> plaintext (DEK)
}
```

Factory with the hosted guardrail:

```ts
// packages/vault/src/crypto/kek/factory.ts
import type { KekProvider } from "./interface.js";

export async function buildKekProvider(opts: { hosted: boolean }): Promise<KekProvider> {
  const kind = process.env.BEAM_KEK_PROVIDER ?? "local-dev";
  if (opts.hosted && kind === "local-dev") {
    throw new Error(
      "BEAM_KEK_PROVIDER=local-dev is forbidden when BEAM_TIER=hosted; " +
      "a KMS-backed KEK is mandatory for hosted (no single-static-key fallback).",
    );
  }
  switch (kind) {
    case "local-dev": /* new LocalDevKekProvider(decodeBase64(BEAM_KEK_LOCAL_SECRET)) */;
    case "aws-kms":   /* dynamic import @aws-sdk/client-kms -> new AwsKmsKekProvider(...) */;
    case "gcp-kms":   /* dynamic import @google-cloud/kms   -> new GcpKmsKekProvider(...) */;
    default: throw new Error(`Unknown BEAM_KEK_PROVIDER: ${kind}`);
  }
}
```

---

## 4. CredentialStore API

The store is keyed on `Subject = { issuer, sub }`. It find-or-creates the `users` row, envelope-seals on write, decrypts on read, and refreshes access tokens on near-expiry. The provider type set spans deploy providers (`vercel`/`digitalocean`/`github`) and DB engines (`neon`/`upstash`); `getProviderToken` returns the repo's `ProviderToken`, `getDbCredentials` returns the repo's `NeonCreds | UpstashCreds`.

```ts
// packages/vault/src/subject.ts
/** The tenant key. NEVER clientId. */
export type Subject = { issuer: string; sub: string };

/** Build a Subject from a verified AuthInfo; throws if sub/iss are absent/empty. */
export function subjectFromAuth(
  auth: { claims: { iss?: string }; subject?: string },
): Subject {
  const sub = auth.subject?.trim();
  const issuer = auth.claims.iss?.trim();
  if (!sub || !issuer) {
    throw new Error("subjectFromAuth: token must carry non-empty iss and sub");
  }
  return { issuer, sub };
}
```

```ts
// packages/vault/src/store.ts
import type { Pool } from "pg";
// NOTE the real package id + barrel export (verified): the adapters package is
// "@beam-me-up/adapters" and re-exports these from its index. There is no
// "@beam/adapters" and no deep subpath export.
import type { ProviderToken } from "@beam-me-up/adapters";
import type { DbEngine, NeonCreds, UpstashCreds } from "@beam-me-up/adapters";
import type { Subject } from "./subject.js";
import type { EnvelopeCrypto } from "./crypto/envelope.js";

export type Provider = "vercel" | "digitalocean" | "github";
export type AnyProvider = Provider | "neon" | "upstash";
export type ConnectionStatus = "active" | "expired" | "revoked";

export type ConnectionSummary = {
  provider: AnyProvider;
  providerAccountId: string;          // '' when none
  scopes: string[];
  status: ConnectionStatus;
  accessTokenExpiresAt: number | null; // epoch seconds
  updatedAt: number;                   // epoch seconds
};

export type UpsertConnectionInput = {
  subject: Subject;
  provider: AnyProvider;
  providerAccountId?: string;          // defaults to ''
  scopes: string[];
  accessToken: string;
  refreshToken?: string | null;
  accessTokenExpiresAt?: number | null;  // epoch seconds
  refreshTokenExpiresAt?: number | null;
};

/** Injected per provider so refresh-on-expiry is testable offline (P3 fills these). */
export type ProviderRefreshFn = (refreshToken: string) => Promise<
  | { accessToken: string; refreshToken?: string;
      accessTokenExpiresAt?: number; refreshTokenExpiresAt?: number }
  | { reuseDetected: true }
>;

export interface CredentialStore {
  /**
   * Read + decrypt the ACTIVE provider connection for (subject, provider) and
   * refresh-on-near-expiry (skew ~60s) before returning. Returns null when there
   * is no active connection (caller surfaces a /connect/<provider> URL). On a
   * refused/reuse-detected refresh, marks status='revoked' and returns null.
   */
  getProviderToken(subject: Subject, provider: Provider): Promise<ProviderToken | null>;

  /**
   * Same contract for DB engines. 'postgres' -> Neon creds, 'redis' -> Upstash
   * creds. Paste-a-key rows have no refresh path: decrypt and return.
   */
  getDbCredentials(subject: Subject, engine: DbEngine): Promise<NeonCreds | UpstashCreds | null>;

  /**
   * Find-or-create the users row (by issuer+sub), envelope-seal the tokens, and
   * UPSERT provider_connections (ON CONFLICT (user_id, provider,
   * provider_account_id) DO UPDATE) in ONE transaction. Sets status='active'.
   * Idempotent on the unique key. Used by the Connect callback and by refresh.
   */
  upsertConnection(input: UpsertConnectionInput): Promise<void>;

  /** This subject's connections (NO plaintext tokens) for the /connections page
   *  + check_credentials. */
  listConnections(subject: Subject): Promise<ConnectionSummary[]>;

  /**
   * RFC 7009 disconnect: best-effort provider revoke (done by caller/connector),
   * THEN hard-delete the row (or set status='revoked') in the same logical op.
   * Idempotent: ok even if no row exists or the provider call fails.
   */
  revoke(subject: Subject, provider: AnyProvider): Promise<void>;

  /**
   * KEK rotation: for each row WHERE key_id=<old>, rewrapDek() and write back
   * wrapped_dek+key_id only (tokens NOT re-encrypted). Batched, transactional
   * per row. Returns the count rewrapped.
   */
  rewrapAll(oldKeyId: string): Promise<{ rewrapped: number }>;
}
```

Two implementations behind the same interface:

```ts
// packages/vault/src/pg-store.ts
import type { Pool } from "pg";
export function createPgCredentialStore(deps: {
  pool: Pool;
  crypto: EnvelopeCrypto;
  refreshFns: Partial<Record<Provider, ProviderRefreshFn>>; // P3 fills these
  now?: () => number; // epoch seconds; default Date.now()/1000
}): CredentialStore;

// packages/vault/src/memory-store.ts — the offline-test seam (no DB, no KMS)
export function createInMemoryCredentialStore(opts?: {
  crypto?: EnvelopeCrypto;                 // default: EnvelopeCrypto over a static test KEK
  refreshFns?: Partial<Record<Provider, ProviderRefreshFn>>;
  now?: () => number;
}): CredentialStore;
```

**Refresh-on-read semantics inside `getProviderToken`** (the hot path `ctx.resolve` triggers):

1. `SELECT … FOR UPDATE` the active row (locks against a concurrent `/mcp` refresh).
2. If `accessTokenExpiresAt - now() < 60s` and a refresh token exists, decrypt it and call the provider's `ProviderRefreshFn`.
3. On success: `sealConnection` the new access (+ rotated refresh if returned) under a **fresh DEK**, overwrite `*_ciphertext/_nonce/_tag/wrapped_dek/key_id/*_expires_at`, bump `updated_at`, `COMMIT`, return the live token. A second concurrent request blocks on the row lock, then reads the already-rotated row.
4. On `{ reuseDetected: true }` or a `4xx`: set `status='revoked'`, `COMMIT`, return `null` so the tool surfaces its `/connect/<provider>` re-link URL.

Paste-a-key DB rows (`neon`/`upstash`) have no refresh path: decrypt and return.

---

## 5. P1 wiring: CredentialContext + sub-rejection guard

### 5.1 The `CredentialContext` type (authored in `packages/adapters/src/token.ts`)

`CredentialContext` does not exist yet. Author it in `token.ts`. Because the real store is async (DB + KMS), the resolvers are **async** — this is a deliberate amendment to the design's synchronous P1 sketch; flag it at the P1→P2 boundary so every tool call site already `await`s.

```ts
// packages/adapters/src/token.ts  (NEW exported type)
import type { ProviderToken } from "./deploy/interface.js";
import type { DbEngine, NeonCreds, UpstashCreds } from "./db/interface.js";

export type CredentialContext = {
  /** The JWT sub (principal). The issuer is carried alongside by the builder in
   *  http.ts; resolvers close over the full Subject. */
  subject: string;
  resolve(provider: "vercel" | "digitalocean"): Promise<ProviderToken | null>;
  resolveDb(engine: DbEngine): Promise<NeonCreds | UpstashCreds | null>;
};
```

The two existing functions gain an optional `ctx` and prefer it; the env path stays as the self-host/stdio fallback:

```ts
export async function getProviderToken(
  provider: "vercel" | "digitalocean",
  ctx?: CredentialContext,
): Promise<ProviderToken | null> {
  if (ctx) return ctx.resolve(provider);
  // ... existing process.env reads (token.ts lines 26-41) unchanged ...
}

export async function getDbCredentials(
  engine: DbEngine,
  ctx?: CredentialContext,
): Promise<NeonCreds | UpstashCreds | null> {
  if (ctx) return ctx.resolveDb(engine);
  // ... existing process.env reads (token.ts lines 58-72) unchanged ...
}
```

`createServer(ctx?)` forwards `ctx` into the 5 credentialed tools + `check_credentials` (the P1 wiring); here those call sites simply become `await getProviderToken(provider, ctx)`.

### 5.2 `http.ts`: per-request ctx + the sub-rejection guard

Replace the discarding success branch in `createBeamHttpServer` (the `if (guard) { … }` block, ~lines 170-180; today it returns on `!result.ok` and otherwise falls through to `createServer()` at ~line 186). The store is constructed **once** in `createBeamHttpServer()` (a singleton `Pool` + `EnvelopeCrypto` + `KekProvider`); only `ctx` is per-request, preserving the stateless fresh-server-per-request shape.

```ts
const isHostedTier = process.env.BEAM_TIER === "hosted";

// ... inside the request handler, where the guard block is:
let ctx: CredentialContext | undefined;
if (guard) {
  const result = await guard.authorize(req.headers.authorization);
  if (!result.ok) {
    res.writeHead(result.status, {
      "Content-Type": "application/json",
      "WWW-Authenticate": result.wwwAuthenticate,
    });
    res.end(JSON.stringify(result.body));
    return;
  }

  // SUB-REJECTION GUARD: on the hosted path a token MUST carry a non-empty
  // string sub and iss. Key ONLY on (issuer, sub) — never clientId.
  const sub = result.auth.subject;
  const issuer = result.auth.claims.iss;
  if (
    isHostedTier &&
    (typeof sub !== "string" || sub.trim() === "" ||
     typeof issuer !== "string" || issuer.trim() === "")
  ) {
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": result.wwwAuthenticate,
    });
    res.end(JSON.stringify({
      error: "invalid_token",
      error_description: "Token must carry a non-empty subject (sub) claim.",
    }));
    return;
  }

  // Build the per-request ctx ONLY when we have a real subject (hosted path).
  if (typeof sub === "string" && sub.trim() !== "" &&
      typeof issuer === "string" && issuer.trim() !== "") {
    const subject: Subject = { issuer, sub };
    ctx = {
      subject: sub,
      resolve: (p) => store.getProviderToken(subject, p),
      resolveDb: (e) => store.getDbCredentials(subject, e),
    };
    // Also populate the SDK auth channel so extra.authInfo is correct. The SDK
    // AuthInfo has no `sub` field, so carry it in `extra`.
    // (req as any).auth = { ..., extra: { subject: sub, issuer } };
  }
}

// ... later, replacing createServer() at ~line 186:
const server = createServer(ctx); // ctx undefined => env fallback (stdio/self-host)
```

Behavior matrix:
- **Hosted + OAuth on:** `sub`/`iss` mandatory; missing → 401 `invalid_token`, vault never consulted with a `clientId`. With a valid subject, `ctx` resolves through the store.
- **Self-host / loopback / no-auth:** `guard` is null (or `BEAM_TIER` ≠ `hosted`), `ctx` stays `undefined`, tools fall back to env. The loopback build never loads `pg`/KMS.

---

## 6. /healthz and oauth_states semantics

### 6.1 /healthz → readiness

`http.ts` currently returns a static `{ status: "ok" }` (lines 140-144). Upgrade it to a real readiness probe that drains a sick hosted instance:

```
GET /healthz  (unauthenticated, exempt from the Host/Origin guard — LB probes use arbitrary Hosts)
  - DB:  SELECT 1 on the pool with a short timeout.
  - KMS: a cheap KEK encrypt/describe probe; "skip" when local-dev / self-host.
  Body: { status: "ok"|"degraded", checks: { db: "ok"|"fail", kms: "ok"|"skip"|"fail" } }
  On hosted, a failed db OR kms check returns 503 so the load balancer drains the instance.
```

### 6.2 oauth_states single-use consume

`oauth_states` lands in **P2a** (not deferred), so single-use is a DB transaction from day one. Consume-and-delete is one statement; the `RETURNING` row is the proof of single-use:

```sql
DELETE FROM oauth_states
 WHERE state = $1 AND expires_at > now()
 RETURNING user_id, provider, pkce_verifier_ciphertext, pkce_verifier_nonce,
           pkce_verifier_tag, pkce_wrapped_dek, pkce_key_id, redirect_after;
```

```ts
// packages/vault/src/states.ts
import type { Subject } from "./subject.js";

export interface OAuthStateStore {
  /** Insert a freshly-minted state (random 256-bit), bound to the user + the
   *  enveloped PKCE verifier; TTL <= 10 min. */
  mint(input: {
    subject: Subject; provider: string; pkceVerifier: string;
    redirectAfter: string; ttlSeconds?: number;
  }): Promise<{ state: string }>;

  /**
   * Atomically consume (DELETE…RETURNING). Returns the bound row exactly once;
   * a second consume of the same state returns null (single-use, fail-closed).
   * The P3 callback derives the subject ONLY from this returned row — never from
   * a query param or cookie.
   */
  consume(state: string): Promise<
    { subject: Subject; provider: string; pkceVerifier: string; redirectAfter: string } | null
  >;
}
```

The PKCE verifier is enveloped with the same `EnvelopeCrypto` machinery (`field: "pkce_verifier"`), so a DB reader cannot replay an in-flight authorization. The web routes that call `mint`/`consume` are P3; only the store + single-use transaction ship here.

---

## 7. Offline test strategy and the merge-blocking gate

All default suites stay offline and driverless, matching the repo convention (`test:m1`…`test:m8` = `tsx test/mN.test.ts`, no DB). Add `test/m9.test.ts` (`"test:m9": "tsx test/m9.test.ts"`) and a separate **gated** `test/m9.integration.test.ts`.

**EnvelopeCrypto unit tests** (no Postgres, no KMS — `LocalDevKekProvider` with a fixed test KEK):
1. **Round-trip:** `sealConnection` → `open` returns the original token bytes.
2. **AAD-mismatch rejection** (the isolation crown jewel): `open` with an AAD whose `oauthSubject` differs **throws** (GCM tag fails). Proves a row cannot be swapped between users.
3. **Tamper rejection:** flip one byte of `ciphertext` or `tag` → `open` throws.
4. **Field separation:** the access ciphertext cannot be opened with `field: "refresh_token"` AAD (throws).
5. **Rotation:** `rewrapDek` under a new keyId still `open`s with the new wrapped DEK; ciphertext/nonce/tag unchanged.

**CredentialStore tests** against `createInMemoryCredentialStore` (no DB):
6. `upsertConnection` then `getProviderToken` returns the token; `listConnections` shows it `active` with no plaintext.
7. **Null on no active connection:** `getProviderToken(subject, "vercel")` with nothing stored → `null`.
8. **Refresh-on-near-expiry:** seed `accessTokenExpiresAt = now+30s` + an injected `refreshFn`; `getProviderToken` returns the refreshed token and the stored refresh token is rotated.
9. **Refused refresh → revoked:** `refreshFn` returns `{ reuseDetected: true }` (or throws) → row becomes `status='revoked'`, returns `null`.
10. **Revoke idempotency:** `revoke` deletes/marks the row; a second `revoke` is a no-op ok.
11. **Tenant isolation:** two `Subject`s with the **same clientId but different sub** get separate connections; neither can read the other's.

**P1-seam tests** (offline):
12. `ctx` resolver wins over env; absent `ctx` falls back to env; stdio unaffected.
13. **Sub-rejection guard:** a verified token with empty/missing `sub` on the hosted path → 401 `invalid_token`; the vault is never consulted with a `clientId`.
14. **oauth_states single-use (in-memory):** a second `consume` of the same state returns `null`.

**Gated real-Postgres integration** (`test/m9.integration.test.ts`): runs only when `BEAM_TEST_DATABASE_URL` is set, otherwise prints `skipped: no BEAM_TEST_DATABASE_URL` and exits 0. It runs migrations against a throwaway DB, exercises `createPgCredentialStore` round-trip and the `oauth_states` `DELETE…RETURNING` single-use transaction, then truncates. Never wired into `npm test`, keeping the default suite offline.

**First merge-blocking test — the P2b gate:** EnvelopeCrypto **round-trip + AAD-mismatch rejection** (tests 1 + 2). No vault row may be written until `open` provably rejects a foreign-owner AAD.

**First merge-blocking test — the P2a gate:** the `oauth_states` **single-use** check — the in-memory unit test (14) plus the gated integration assertion that a second `consume` returns `null` (fail-closed).

---

## 8. P2a / P2b phase split + ordered task checklist

The original monolithic "P2" splits into **P2a** (DB plumbing + seam) and **P2b** (crypto + store). Both land before any Connect UI (P3); `oauth_states`/single-use ships in P2a, not deferred.

### P2a — DB + pool + migrations + deps + healthz + async P1 seam + oauth_states

1. Create `packages/vault` workspace (`package.json` §1.1, `tsconfig.json` referencing `../core`). Add `{ "path": "packages/vault" }` to `tsconfig.solution.json` (between `core` and `adapters`) and `"@beam-me-up/vault": "*"` to `packages/adapters/package.json`. Add the `vault:migrate` and `test:m9` root scripts.
2. `src/pool.ts` — `makePool(): Pool` from `BEAM_VAULT_DATABASE_URL` (+ `ssl` from `BEAM_VAULT_PG_SSL`), as a process singleton.
3. `migrations/0001_init.sql` (§2) + `src/migrate.ts` (`runMigrations`, advisory-locked, ledger-checked). Wire boot-time migrate on hosted.
4. `src/subject.ts` — `Subject` + `subjectFromAuth` (§4).
5. `src/states.ts` — `OAuthStateStore` with the `DELETE…RETURNING` single-use consume (§6.2). (PKCE-verifier enveloping calls into P2b crypto; for P2a, the in-memory states store can use the static test crypto.)
6. Author `CredentialContext` (async resolvers) in `packages/adapters/src/token.ts`; thread the optional `ctx` through `getProviderToken`/`getDbCredentials` keeping the env fallback (§5.1).
7. `packages/server/src/server/http.ts`: add the sub-rejection guard + per-request `ctx` builder + `BEAM_TIER` flag; pass `ctx` into `createServer(ctx)`; ensure `createServer(ctx?)` forwards into the credentialed tools (the P1 change), now `await`ing the resolvers. At this point `ctx` may resolve against env (no store yet) — this proves the seam + guard end-to-end.
8. Upgrade `/healthz` to DB(+KMS) readiness returning 503 on hosted failure (§6.1).
9. Tests 12, 13, 14 (seam + guard + in-memory single-use). **P2a gate:** the `oauth_states` single-use check.

### P2b — EnvelopeCrypto + CredentialStore

10. `src/crypto/types.ts`, `src/crypto/aad.ts`, `src/crypto/envelope.ts` (§3.1-3.2).
11. `src/crypto/kek/interface.ts`, `local-dev.ts`, `aws-kms.ts`, `gcp-kms.ts`, `factory.ts` with the hosted guardrail (§3.3). Startup throws if `BEAM_TIER=hosted` without KMS.
12. `src/store.ts` interface (§4); `src/memory-store.ts`; `src/pg-store.ts` implementing read+decrypt, refresh-on-expiry (`SELECT … FOR UPDATE` + transactional rotation), upsert, list, RFC 7009 revoke, `rewrapAll`.
13. `src/index.ts` barrel: `CredentialStore`, `createPgCredentialStore`, `createInMemoryCredentialStore`, `EnvelopeCrypto`, `buildKekProvider`, `runMigrations`, `OAuthStateStore`, `Subject`, `subjectFromAuth`.
14. `http.ts`: construct the real singleton store (`Pool` + `EnvelopeCrypto` + `KekProvider`) in `createBeamHttpServer()`; `ctx.resolve/resolveDb` now hit the store; env remains the self-host fallback.
15. Tests 1-11. **P2b gate (overall vault gate):** EnvelopeCrypto round-trip + AAD-mismatch rejection — no vault row is written until a foreign-owner AAD provably fails to decrypt.

### Sequencing invariants (must remain true)
- The metadata DB + EnvelopeCrypto + one round-trip test land **before any Connect UI (P3)**.
- KMS-backed KEK is **mandatory** for `BEAM_TIER=hosted`; no static-key fallback there.
- Vault keyed on `(oauth_issuer, sub)` **only**, never `clientId`; the sub-rejection guard is enforced code.
- AAD binds `(issuer, sub, provider, providerAccountId, field)`, so a stolen DB row cannot be replayed under another user; the AAD-mismatch test is merge-blocking.
- `oauth_states` single-use is a `DELETE…RETURNING` transaction shipped in **P2a**; the P3 callback derives the subject only from the returned row.

---

## Files this phase creates/touches (absolute paths)

New:
- `/Users/Kristoffer.Berg/github/beam-me-up/packages/vault/package.json`, `/tsconfig.json`
- `/Users/Kristoffer.Berg/github/beam-me-up/packages/vault/migrations/0001_init.sql`
- `/Users/Kristoffer.Berg/github/beam-me-up/packages/vault/src/`: `index.ts`, `pool.ts`, `migrate.ts`, `subject.ts`, `store.ts`, `memory-store.ts`, `pg-store.ts`, `states.ts`, `crypto/types.ts`, `crypto/aad.ts`, `crypto/envelope.ts`, `crypto/kek/interface.ts`, `crypto/kek/factory.ts`, `crypto/kek/local-dev.ts`, `crypto/kek/aws-kms.ts`, `crypto/kek/gcp-kms.ts`
- `/Users/Kristoffer.Berg/github/beam-me-up/test/m9.test.ts` (offline), `/Users/Kristoffer.Berg/github/beam-me-up/test/m9.integration.test.ts` (gated on `BEAM_TEST_DATABASE_URL`)

Modified:
- `/Users/Kristoffer.Berg/github/beam-me-up/packages/adapters/src/token.ts` (add `CredentialContext`; async, ctx-aware resolvers)
- `/Users/Kristoffer.Berg/github/beam-me-up/packages/server/src/server/http.ts` (sub-rejection guard + per-request ctx builder + singleton store + `/healthz` readiness)
- `/Users/Kristoffer.Berg/github/beam-me-up/packages/server/src/mcp/server.ts` (`createServer(ctx?)` forwarding; resolvers now awaited)
- `/Users/Kristoffer.Berg/github/beam-me-up/tsconfig.solution.json` (add `packages/vault` reference)
- `/Users/Kristoffer.Berg/github/beam-me-up/packages/adapters/package.json` (add `@beam-me-up/vault`)
- `/Users/Kristoffer.Berg/github/beam-me-up/package.json` (`vault:migrate`, `test:m9` scripts)

---

**Repo-verified corrections folded in:** the adapters package is `@beam-me-up/adapters` with a single barrel export (Part B's `@beam/adapters/...` deep imports were wrong); `ProviderToken = { token; teamId? }`, `NeonCreds = { apiKey }`, `UpstashCreds = { email; apiKey }`, `DbEngine = "postgres" | "redis"` (from `packages/adapters/src/deploy/interface.ts` and `db/interface.ts`); `AuthInfo.subject` is optional and `claims.iss` carries the issuer (`verifier.ts`); `http.ts` currently discards `result.auth` and returns a static `/healthz`; `tsconfig.solution.json` DAG is `core → detect → templates → adapters → tools → server`.

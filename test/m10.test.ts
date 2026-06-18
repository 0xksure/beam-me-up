/**
 * m10.test.ts - offline tests for the M9 P2 per-user credential VAULT package
 * (@beam-me-up/vault): envelope crypto, the KEK factory's hosted guardrail, the
 * in-memory CredentialStore, and the buildCredentialContext factory.
 *
 * 100% offline (no network, no DB, no KMS). The PgCredentialStore + migrate
 * integration checks are GATED behind BEAM_VAULT_DATABASE_URL and SKIP cleanly
 * (printed note) when it is unset, so offline runs stay green.
 *
 * Wired to `npm run test:m10` (tsx test/m10.test.ts). Mirrors the tiny check()
 * harness in test/m5.test.ts.
 */
import { randomBytes } from "node:crypto";

import {
  EnvelopeCrypto,
  LocalDevKekProvider,
  buildKekProvider,
  createInMemoryCredentialStore,
  buildCredentialContext,
  type AadBinding,
  type Subject,
} from "@beam-me-up/vault";
import type { NeonCreds } from "@beam-me-up/adapters";

/* ------------------------------------------------------------------ */
/* Tiny assertion harness with PASS/FAIL printing (mirrors m5)         */
/* ------------------------------------------------------------------ */

let passCount = 0;
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    process.stdout.write(`  FAIL  ${msg}\n`);
    throw new Error(`assertion failed: ${msg}`);
  }
  passCount += 1;
  process.stdout.write(`  PASS  ${msg}\n`);
}

async function expectThrows(fn: () => Promise<unknown> | unknown, msg: string): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  check(threw, msg);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function testCrypto(): EnvelopeCrypto {
  return new EnvelopeCrypto(new LocalDevKekProvider(randomBytes(32)));
}

const AAD_BASE = {
  oauthIssuer: "https://issuer.example",
  oauthSubject: "user-123",
  provider: "vercel",
  providerAccountId: "",
};

/* ================================================================== */
/* (1) EnvelopeCrypto round-trip                                       */
/* ================================================================== */

async function testRoundTrip(): Promise<void> {
  process.stdout.write("\n[1] EnvelopeCrypto round-trip\n");
  const crypto = testCrypto();
  const accessToken = Buffer.from("super-secret-access-token", "utf8");
  const refreshToken = Buffer.from("super-secret-refresh-token", "utf8");

  const sealed = await crypto.sealConnection({ accessToken, refreshToken, aadBase: AAD_BASE });

  const openedAccess = await crypto.open({
    secret: sealed.access,
    wrappedDek: sealed.wrappedDek,
    keyId: sealed.keyId,
    aad: { ...AAD_BASE, field: "access_token" },
  });
  check(openedAccess.equals(accessToken), "access token round-trips to the original bytes");

  check(sealed.refresh !== undefined, "refresh envelope is present when a refresh token is sealed");
  const openedRefresh = await crypto.open({
    secret: sealed.refresh!,
    wrappedDek: sealed.wrappedDek,
    keyId: sealed.keyId,
    aad: { ...AAD_BASE, field: "refresh_token" },
  });
  check(openedRefresh.equals(refreshToken), "refresh token round-trips to the original bytes");

  check(sealed.access.nonce.length === 12, "GCM nonce is 12 bytes");
  check(sealed.access.tag.length === 16, "GCM tag is 16 bytes");
}

/* ================================================================== */
/* (2) AAD-mismatch rejection (cross-user-swap guard)                  */
/* ================================================================== */

async function testAadMismatch(): Promise<void> {
  process.stdout.write("\n[2] AAD-mismatch rejection (cross-user-swap guard)\n");
  const crypto = testCrypto();
  const sealed = await crypto.sealConnection({
    accessToken: Buffer.from("tok", "utf8"),
    aadBase: AAD_BASE,
  });

  // A DIFFERENT subject's AAD must FAIL the GCM tag (the row cannot be swapped).
  await expectThrows(
    () =>
      crypto.open({
        secret: sealed.access,
        wrappedDek: sealed.wrappedDek,
        keyId: sealed.keyId,
        aad: { ...AAD_BASE, oauthSubject: "ATTACKER", field: "access_token" },
      }),
    "open with a foreign oauthSubject AAD THROWS (cross-user swap rejected)",
  );

  // A different issuer / provider also fails.
  await expectThrows(
    () =>
      crypto.open({
        secret: sealed.access,
        wrappedDek: sealed.wrappedDek,
        keyId: sealed.keyId,
        aad: { ...AAD_BASE, provider: "digitalocean", field: "access_token" },
      }),
    "open with a foreign provider AAD THROWS",
  );

  // Field separation: the access ciphertext can't be opened as refresh_token.
  await expectThrows(
    () =>
      crypto.open({
        secret: sealed.access,
        wrappedDek: sealed.wrappedDek,
        keyId: sealed.keyId,
        aad: { ...AAD_BASE, field: "refresh_token" },
      }),
    "access ciphertext cannot be opened with refresh_token AAD (field separation)",
  );
}

/* ================================================================== */
/* (3) Tamper (bad tag / ciphertext) rejection                         */
/* ================================================================== */

async function testTamper(): Promise<void> {
  process.stdout.write("\n[3] Tamper rejection\n");
  const crypto = testCrypto();
  const sealed = await crypto.sealConnection({
    accessToken: Buffer.from("tok", "utf8"),
    aadBase: AAD_BASE,
  });

  const badTag = Buffer.from(sealed.access.tag);
  badTag[0] = badTag[0]! ^ 0xff;
  await expectThrows(
    () =>
      crypto.open({
        secret: { ...sealed.access, tag: badTag },
        wrappedDek: sealed.wrappedDek,
        keyId: sealed.keyId,
        aad: { ...AAD_BASE, field: "access_token" },
      }),
    "flipped auth tag byte -> open THROWS",
  );

  const badCt = Buffer.from(sealed.access.ciphertext);
  badCt[0] = badCt[0]! ^ 0xff;
  await expectThrows(
    () =>
      crypto.open({
        secret: { ...sealed.access, ciphertext: badCt },
        wrappedDek: sealed.wrappedDek,
        keyId: sealed.keyId,
        aad: { ...AAD_BASE, field: "access_token" },
      }),
    "flipped ciphertext byte -> open THROWS",
  );
}

/* ================================================================== */
/* (4) Key rotation re-wrap preserves plaintext                        */
/* ================================================================== */

async function testRotation(): Promise<void> {
  process.stdout.write("\n[4] Key rotation re-wrap preserves plaintext\n");
  // OLD KEK seals; NEW KEK is a different provider. rewrapDek bridges them.
  const oldKek = new LocalDevKekProvider(randomBytes(32));
  const oldCrypto = new EnvelopeCrypto(oldKek);
  const accessToken = Buffer.from("rotate-me", "utf8");
  const sealed = await oldCrypto.sealConnection({ accessToken, aadBase: AAD_BASE });

  // The rotation operator runs over the same crypto (single KEK provider here),
  // re-wrapping the DEK without touching the ciphertext/nonce/tag.
  const { wrappedDek: newWrapped, keyId: newKeyId } = await oldCrypto.rewrapDek(
    sealed.wrappedDek,
    sealed.keyId,
  );

  check(
    !newWrapped.equals(sealed.wrappedDek),
    "re-wrapped DEK ciphertext differs from the original wrap",
  );

  const opened = await oldCrypto.open({
    secret: sealed.access, // ciphertext/nonce/tag UNCHANGED by rotation
    wrappedDek: newWrapped,
    keyId: newKeyId,
    aad: { ...AAD_BASE, field: "access_token" },
  });
  check(opened.equals(accessToken), "token still decrypts with the re-wrapped DEK");
}

/* ================================================================== */
/* (5) buildKekProvider hosted-guardrail THROWS on local-dev           */
/* ================================================================== */

async function testHostedGuardrail(): Promise<void> {
  process.stdout.write("\n[5] buildKekProvider hosted guardrail\n");

  // Hosted + local-dev -> THROW.
  await expectThrows(
    () =>
      buildKekProvider({
        hosted: true,
        env: { BEAM_KEK_PROVIDER: "local-dev", BEAM_KEK_LOCAL_SECRET: "x".repeat(44) },
      }),
    "BEAM_TIER=hosted + provider=local-dev -> buildKekProvider THROWS",
  );

  // Hosted + UNSET provider (defaults to local-dev) -> THROW.
  await expectThrows(
    () => buildKekProvider({ hosted: true, env: {} }),
    "BEAM_TIER=hosted + provider UNSET -> buildKekProvider THROWS",
  );

  // Self-host + local-dev with a valid 32-byte secret -> OK.
  const secret = randomBytes(32).toString("base64");
  const provider = await buildKekProvider({
    hosted: false,
    env: { BEAM_KEK_PROVIDER: "local-dev", BEAM_KEK_LOCAL_SECRET: secret },
  });
  check(provider.currentKeyId === "local-dev/v1", "self-host local-dev builds a LocalDevKekProvider");
}

/* ================================================================== */
/* (6) InMemoryCredentialStore upsert/get/list/revoke                  */
/* ================================================================== */

const SUBJECT: Subject = { issuer: "https://issuer.example", sub: "user-123" };

async function testInMemoryStore(): Promise<void> {
  process.stdout.write("\n[6] InMemoryCredentialStore upsert / get / list / revoke\n");
  const store = createInMemoryCredentialStore();

  // No connection yet -> null.
  check(
    (await store.getProviderToken(SUBJECT, "vercel")) === null,
    "getProviderToken with nothing stored -> null",
  );

  // Upsert a vercel token + a neon db credential.
  await store.upsertConnection({
    subject: SUBJECT,
    provider: "vercel",
    scopes: ["deploy"],
    accessToken: "vercel-access",
    refreshToken: "vercel-refresh",
  });
  await store.upsertConnection({
    subject: SUBJECT,
    provider: "neon",
    scopes: [],
    accessToken: "neon-api-key",
  });

  const vt = await store.getProviderToken(SUBJECT, "vercel");
  check(vt !== null && vt.token === "vercel-access", "getProviderToken returns the upserted token");

  const db = (await store.getDbCredentials(SUBJECT, "postgres")) as NeonCreds | null;
  check(db !== null && db.apiKey === "neon-api-key", "getDbCredentials(postgres) returns the neon key");

  const list = await store.listConnections(SUBJECT);
  check(list.length === 2, `listConnections shows 2 connections (got ${list.length})`);
  check(
    list.every((c) => c.status === "active"),
    "listed connections are active",
  );
  // No plaintext token leaks into the summary type.
  check(
    !JSON.stringify(list).includes("vercel-access"),
    "listConnections does NOT leak the plaintext token",
  );

  // Idempotent upsert (same unique key) overwrites, count stays 2.
  await store.upsertConnection({
    subject: SUBJECT,
    provider: "vercel",
    scopes: ["deploy"],
    accessToken: "vercel-access-2",
  });
  const vt2 = await store.getProviderToken(SUBJECT, "vercel");
  check(vt2 !== null && vt2.token === "vercel-access-2", "upsert overwrites on the unique key");
  check((await store.listConnections(SUBJECT)).length === 2, "idempotent upsert keeps count at 2");

  // Revoke vercel, then it resolves null; revoke again is a no-op.
  await store.revoke(SUBJECT, "vercel");
  check((await store.getProviderToken(SUBJECT, "vercel")) === null, "revoke removes the connection");
  await store.revoke(SUBJECT, "vercel"); // idempotent
  check((await store.listConnections(SUBJECT)).length === 1, "revoke is idempotent; neon remains");
}

/* ================================================================== */
/* (6b) Refresh-on-near-expiry + refused-refresh -> revoked            */
/* ================================================================== */

async function testRefreshSemantics(): Promise<void> {
  process.stdout.write("\n[6b] refresh-on-near-expiry + refused refresh\n");
  let nowSec = 1_000_000;
  const refreshed: string[] = [];
  const store = createInMemoryCredentialStore({
    now: () => nowSec,
    refreshFns: {
      vercel: async (rt) => {
        refreshed.push(rt);
        return { accessToken: "fresh-access", refreshToken: "fresh-refresh", accessTokenExpiresAt: nowSec + 3600 };
      },
    },
  });

  await store.upsertConnection({
    subject: SUBJECT,
    provider: "vercel",
    scopes: [],
    accessToken: "stale-access",
    refreshToken: "stale-refresh",
    accessTokenExpiresAt: nowSec + 30, // within the 60s skew -> refresh
  });

  const tok = await store.getProviderToken(SUBJECT, "vercel");
  check(tok !== null && tok.token === "fresh-access", "near-expiry token is refreshed on read");
  check(refreshed[0] === "stale-refresh", "refresh used the stored refresh token");

  // A second read after refresh returns the fresh token without re-refreshing.
  const tok2 = await store.getProviderToken(SUBJECT, "vercel");
  check(tok2 !== null && tok2.token === "fresh-access", "second read returns the rotated token");
  check(refreshed.length === 1, "no spurious second refresh while still fresh");

  // Refused refresh (reuseDetected) -> row revoked -> null.
  const store2 = createInMemoryCredentialStore({
    now: () => nowSec,
    refreshFns: { vercel: async () => ({ reuseDetected: true as const }) },
  });
  await store2.upsertConnection({
    subject: SUBJECT,
    provider: "vercel",
    scopes: [],
    accessToken: "x",
    refreshToken: "y",
    accessTokenExpiresAt: nowSec + 5,
  });
  check(
    (await store2.getProviderToken(SUBJECT, "vercel")) === null,
    "reuse-detected refresh -> getProviderToken returns null",
  );
  const summary = await store2.listConnections(SUBJECT);
  check(summary[0]?.status === "revoked", "reuse-detected refresh marks the row revoked");
}

/* ================================================================== */
/* (7) buildCredentialContext: resolve-wins / isolation / sub-reject   */
/* ================================================================== */

async function testContextFactory(): Promise<void> {
  process.stdout.write("\n[7] buildCredentialContext resolve / isolation / sub-rejection\n");
  const store = createInMemoryCredentialStore();

  const subjA: Subject = { issuer: "iss", sub: "alice" };
  const subjB: Subject = { issuer: "iss", sub: "bob" };

  await store.upsertConnection({
    subject: subjA,
    provider: "vercel",
    scopes: [],
    accessToken: "alice-vercel",
  });
  await store.upsertConnection({
    subject: subjB,
    provider: "neon",
    scopes: [],
    accessToken: "bob-neon",
  });

  const ctxA = buildCredentialContext(store, subjA);
  const ctxB = buildCredentialContext(store, subjB);

  check(ctxA.subject === "alice", "context carries the sub as subject");

  const aVercel = await ctxA.resolve("vercel");
  check(aVercel !== null && aVercel.token === "alice-vercel", "ctxA resolves alice's vercel token");

  // Two subjects are isolated: alice has no neon, bob has no vercel.
  check((await ctxA.resolveDb("postgres")) === null, "ctxA cannot read bob's neon (isolation)");
  check((await ctxB.resolve("vercel")) === null, "ctxB cannot read alice's vercel (isolation)");
  const bNeon = (await ctxB.resolveDb("postgres")) as NeonCreds | null;
  check(bNeon !== null && bNeon.apiKey === "bob-neon", "ctxB resolves bob's neon credential");

  // Sub-rejection: empty / missing sub throws; never keyed on clientId.
  await expectThrows(
    () => buildCredentialContext(store, { issuer: "iss", sub: "" }),
    "buildCredentialContext with an empty sub THROWS",
  );
  await expectThrows(
    () => buildCredentialContext(store, { issuer: "iss", sub: "   " }),
    "buildCredentialContext with a whitespace sub THROWS",
  );
  await expectThrows(
    () => buildCredentialContext(store, { claims: { iss: "iss" }, subject: undefined }),
    "buildCredentialContext with a missing subject THROWS (no clientId fallback)",
  );
  await expectThrows(
    () => buildCredentialContext(store, { issuer: "", sub: "alice" }),
    "buildCredentialContext with an empty issuer THROWS",
  );

  // AuthInfo-like identity (claims.iss + subject) works.
  const ctxFromAuth = buildCredentialContext(store, {
    claims: { iss: "iss" },
    subject: "alice",
  });
  const fromAuth = await ctxFromAuth.resolve("vercel");
  check(fromAuth !== null && fromAuth.token === "alice-vercel", "context from AuthInfo resolves correctly");
}

/* ================================================================== */
/* (8) GATED: PgCredentialStore + migrate (BEAM_VAULT_DATABASE_URL)    */
/* ================================================================== */

async function testPgGated(): Promise<void> {
  process.stdout.write("\n[8] PgCredentialStore + migrate (gated on BEAM_VAULT_DATABASE_URL)\n");
  const url = process.env.BEAM_VAULT_DATABASE_URL;
  if (!url) {
    process.stdout.write("  SKIP  no BEAM_VAULT_DATABASE_URL set (offline-green skip)\n");
    return;
  }

  const { Pool } = await import("pg");
  const { runMigrations, createPgCredentialStore, EnvelopeCrypto: EC, LocalDevKekProvider: LDK } =
    await import("@beam-me-up/vault");
  const pool = new Pool({ connectionString: url });
  try {
    const { applied } = await runMigrations(pool);
    process.stdout.write(`  note  migrations applied: ${applied.join(", ") || "(none/up-to-date)"}\n`);

    const crypto = new EC(new LDK(randomBytes(32)));
    const store = createPgCredentialStore({ pool, crypto });
    const subject: Subject = { issuer: "https://it.example", sub: `it-${randomBytes(4).toString("hex")}` };

    await store.upsertConnection({
      subject,
      provider: "vercel",
      scopes: ["deploy"],
      accessToken: "pg-access",
      refreshToken: "pg-refresh",
    });
    const tok = await store.getProviderToken(subject, "vercel");
    check(tok !== null && tok.token === "pg-access", "pg: getProviderToken round-trips");

    const list = await store.listConnections(subject);
    check(list.length === 1, "pg: listConnections returns the row");

    await store.revoke(subject, "vercel");
    check((await store.getProviderToken(subject, "vercel")) === null, "pg: revoke removes the row");

    // Cleanup our test user (cascade drops connections).
    await pool.query("DELETE FROM users WHERE oauth_issuer=$1 AND oauth_subject=$2", [
      subject.issuer,
      subject.sub,
    ]);
  } finally {
    await pool.end();
  }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await testRoundTrip();
  await testAadMismatch();
  await testTamper();
  await testRotation();
  await testHostedGuardrail();
  await testInMemoryStore();
  await testRefreshSemantics();
  await testContextFactory();
  await testPgGated();
  process.stdout.write(`\nm10.test: PASS (${passCount} checks)\n`);
}

main().catch((err) => {
  process.stderr.write(`\nm10.test: FAIL - ${String(err)}\n`);
  process.exit(1);
});

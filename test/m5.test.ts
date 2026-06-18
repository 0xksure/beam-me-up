/**
 * m5.test.ts - offline tests for the M5 HTTP-transport OAuth layer.
 *
 * 100% offline: tokens are minted in-test with node:crypto (HS256 with a test
 * secret, and RS256 with a generated keypair), and the HTTP integration binds
 * the real server to an ephemeral port (listen(0)) on localhost. No network.
 *
 * Levels:
 *   Pure (src/auth/oauth/jwt.ts):
 *     - verifyJwt accepts a well-formed HS256 token (correct secret/iss/aud) and
 *       returns its claims; rejects a tampered signature ("bad-signature"), an
 *       expired token ("expired"), a wrong issuer ("issuer"), a wrong audience
 *       ("audience"), and an alg mismatch / "none" ("alg-mismatch"). Same happy
 *       + tampered checks for RS256 with a generated keypair (wrong key fails).
 *   Pure (metadata.ts / verifier.ts):
 *     - buildProtectedResourceMetadata: resource, authorization_servers:[issuer],
 *       bearer_methods_supported:["header"]. wwwAuthenticate includes
 *       resource_metadata="…" and the error when given.
 *     - createJwtVerifier: valid token -> AuthInfo (subject/scopes); a token
 *       missing a required scope -> AuthError code "insufficient_scope" (403).
 *   Guard (guard.ts, with OAUTH_* env set):
 *     - authorize(undefined) -> { ok:false, status:401, error "missing_token" };
 *       authorize("Bearer bad") -> 401 "invalid_token"; authorize a valid
 *       "Bearer <token>" -> { ok:true }.
 *   HTTP integration (createBeamHttpServer on listen(0)):
 *     - With OAuth env set: GET /.well-known/oauth-protected-resource -> 200 with
 *       the metadata; POST /mcp with no token -> 401 + a WWW-Authenticate header
 *       carrying resource_metadata; POST /mcp with a bad token -> 401; POST /mcp
 *       with a VALID token (initialize request) -> NOT 401 (reaches the MCP
 *       server, 200).
 *     - With OAuth env UNSET: POST /mcp with no token -> NOT 401 (back-compat
 *       no-auth localhost mode); the metadata route is 404.
 *
 * Wired to `npm run test:m5` (tsx test/m5.test.ts). Save/restore the OAUTH_* env
 * around the runs.
 */
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { verifyJwt, JwtError } from "@beam-me-up/server";
import {
  createJwtVerifier,
  AuthError,
} from "@beam-me-up/server";
import {
  buildProtectedResourceMetadata,
  wwwAuthenticate,
} from "@beam-me-up/server";
import { resolveOAuthGuard } from "@beam-me-up/server";
import { getOAuthConfig, type OAuthConfig } from "@beam-me-up/server";
import { createBeamHttpServer } from "@beam-me-up/server";
import { createJwksResolver, type JwksFetch } from "@beam-me-up/server";

/* ------------------------------------------------------------------ */
/* Tiny assertion harness with PASS/FAIL printing                      */
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

/**
 * Run a function that is expected to throw a JwtError and return its `code`.
 * Returns undefined if it did NOT throw a JwtError (the caller's check fails).
 */
function jwtErrorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof JwtError) return err.code;
    return `<non-JwtError: ${String(err)}>`;
  }
  return undefined;
}

/**
 * Await an async fn expected to throw an AuthError, and assert its code+status.
 */
async function assertAuthError(
  fn: () => Promise<unknown>,
  code: string,
  status: number,
  msg: string,
): Promise<void> {
  let e: AuthError | undefined;
  try {
    await fn();
  } catch (err) {
    if (err instanceof AuthError) e = err;
    else {
      check(false, `${msg} (threw non-AuthError: ${String(err)})`);
      return;
    }
  }
  check(
    e !== undefined && e.code === code && e.status === status,
    `${msg} (got ${e ? `${e.code}/${e.status}` : "<no throw>"})`,
  );
}

/* ------------------------------------------------------------------ */
/* Canonical test values (mirror the PINNED M5 CONTRACT)               */
/* ------------------------------------------------------------------ */

const ISSUER = "https://auth.example.com";
const AUDIENCE = "beam-me-up";
const HS256_SECRET = "test-hs256-secret-0123456789";
const RESOURCE_URL = "http://localhost:3000/mcp";
/** A fixed clock so exp/iat are deterministic. */
const NOW = 1_700_000_000;

/* ------------------------------------------------------------------ */
/* Token minting helpers (node:crypto only)                            */
/* ------------------------------------------------------------------ */

/** base64url-encode a UTF-8 string (no padding, URL-safe alphabet). */
function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

/** base64url-encode raw bytes (for signatures). */
function base64urlBytes(buf: Buffer): string {
  return buf.toString("base64url");
}

/**
 * Mint a compact JWS. The signer is chosen by `header.alg` so this same helper
 * can produce HS256 tokens, RS256 tokens, AND deliberately-broken tokens (e.g.
 * a header claiming "none"/"RS256" while we actually HMAC-sign with HS256).
 */
function mintToken(args: {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  /** how to actually produce the signature bytes */
  sign:
    | { kind: "hs256"; secret: string }
    | { kind: "rs256"; privateKey: string }
    | { kind: "none" };
}): string {
  const h = base64url(JSON.stringify(args.header));
  const p = base64url(JSON.stringify(args.payload));
  const signingInput = `${h}.${p}`;
  let sig = "";
  if (args.sign.kind === "hs256") {
    sig = base64urlBytes(
      crypto.createHmac("sha256", args.sign.secret).update(signingInput).digest(),
    );
  } else if (args.sign.kind === "rs256") {
    sig = base64urlBytes(
      crypto.createSign("RSA-SHA256").update(signingInput).sign(args.sign.privateKey),
    );
  } else {
    // "none": still emit a non-empty placeholder so the structural 3-part
    // check passes and the alg-confusion guard is what rejects it.
    sig = base64url("sig");
  }
  return `${h}.${p}.${sig}`;
}

/** A canonical, valid HS256 access-token payload (now-relative). */
function basePayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "user-1",
    scope: "deploy admin",
    iat: NOW,
    exp: NOW + 3600,
    ...over,
  };
}

/** A valid HS256 token signed with the canonical secret. */
function validHs256(
  over: Record<string, unknown> = {},
  secret: string = HS256_SECRET,
): string {
  return mintToken({
    header: { alg: "HS256", typ: "JWT" },
    payload: basePayload(over),
    sign: { kind: "hs256", secret },
  });
}

/* ------------------------------------------------------------------ */
/* Generate one RSA keypair (and a SECOND, different one) for RS256     */
/* ------------------------------------------------------------------ */

function genRsa(): { publicKey: string; privateKey: string } {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

/* ------------------------------------------------------------------ */
/* Env snapshot/restore (every OAUTH_* var the layer reads)            */
/* ------------------------------------------------------------------ */

const OAUTH_ENV_KEYS = [
  "OAUTH_ISSUER",
  "OAUTH_AUDIENCE",
  "OAUTH_JWT_SECRET",
  "OAUTH_JWT_PUBLIC_KEY",
  "OAUTH_JWT_ALG",
  "OAUTH_JWKS_URI",
  "OAUTH_RESOURCE_URL",
  "OAUTH_REQUIRED_SCOPES",
  "PORT",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of OAUTH_ENV_KEYS) saved[k] = process.env[k];
  return saved;
}
function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const k of OAUTH_ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
/** Clear every OAUTH_* var so the layer resolves to "disabled". */
function clearOAuthEnv(): void {
  for (const k of OAUTH_ENV_KEYS) {
    if (k !== "PORT") delete process.env[k];
  }
}
/** Set the CANONICAL HS256 env (no required scopes). */
function setCanonicalEnv(): void {
  clearOAuthEnv();
  process.env.OAUTH_ISSUER = ISSUER;
  process.env.OAUTH_AUDIENCE = AUDIENCE;
  process.env.OAUTH_JWT_SECRET = HS256_SECRET;
  process.env.OAUTH_RESOURCE_URL = RESOURCE_URL;
  process.env.OAUTH_REQUIRED_SCOPES = "";
}

/* ------------------------------------------------------------------ */
/* HTTP helpers: bind to an ephemeral port, then close                 */
/* ------------------------------------------------------------------ */

function listenEphemeral(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo | null;
      if (addr === null || typeof addr === "string") {
        reject(new Error("could not read ephemeral port"));
        return;
      }
      resolve(addr.port);
    });
  });
}
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A minimal JSON-RPC `initialize` request body (what an MCP client sends). */
function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "m5-test", version: "0.0.0" },
    },
  });
}

/* ================================================================== */
/* [pure jwt] verifyJwt                                                */
/* ================================================================== */

function testPureJwt(): void {
  process.stdout.write("\n[pure jwt] verifyJwt HS256 + RS256\n");

  const hsOpts = {
    alg: "HS256" as const,
    secret: HS256_SECRET,
    issuer: ISSUER,
    audience: AUDIENCE,
    now: NOW,
  };

  /* ---- valid HS256 -> claims.sub === "user-1" -------------------- */
  const good = validHs256();
  const claims = verifyJwt(good, hsOpts);
  check(claims.sub === "user-1", `valid HS256 verifies, sub === "user-1" (got "${claims.sub}")`);
  check(
    Array.isArray(claims.aud) ? false : claims.aud === AUDIENCE,
    `valid HS256 carries aud "${AUDIENCE}" (got ${JSON.stringify(claims.aud)})`,
  );

  /* ---- tampered signature -> "bad-signature" --------------------- */
  const parts = good.split(".");
  // Flip the last char of the signature segment to a definitely-different one.
  const sig = parts[2] ?? "";
  const lastChar = sig.charAt(sig.length - 1);
  const flipped = (lastChar === "A" ? "B" : "A");
  const tampered = `${parts[0]}.${parts[1]}.${sig.slice(0, -1)}${flipped}`;
  check(
    jwtErrorCode(() => verifyJwt(tampered, hsOpts)) === "bad-signature",
    "tampered HS256 signature -> JwtError code \"bad-signature\"",
  );

  /* ---- expired (exp in the past) -> "expired" -------------------- */
  const expired = validHs256({ exp: NOW - 3600, iat: NOW - 7200 });
  check(
    jwtErrorCode(() => verifyJwt(expired, hsOpts)) === "expired",
    "expired HS256 token -> JwtError code \"expired\"",
  );

  /* ---- wrong issuer -> "issuer" ---------------------------------- */
  const wrongIss = validHs256({ iss: "https://evil.example.com" });
  check(
    jwtErrorCode(() => verifyJwt(wrongIss, hsOpts)) === "issuer",
    "wrong issuer -> JwtError code \"issuer\"",
  );

  /* ---- wrong audience -> "audience" ------------------------------ */
  const wrongAud = validHs256({ aud: "some-other-resource" });
  check(
    jwtErrorCode(() => verifyJwt(wrongAud, hsOpts)) === "audience",
    "wrong audience -> JwtError code \"audience\"",
  );

  /* ---- alg "none" header while opts.alg "HS256" -> "alg-mismatch" - */
  const algNone = mintToken({
    header: { alg: "none", typ: "JWT" },
    payload: basePayload(),
    sign: { kind: "none" },
  });
  check(
    jwtErrorCode(() => verifyJwt(algNone, hsOpts)) === "alg-mismatch",
    "header alg \"none\" -> JwtError code \"alg-mismatch\"",
  );

  /* ---- alg "RS256" header while opts.alg "HS256" -> "alg-mismatch" */
  // Sign the bytes with HMAC but LIE in the header that it's RS256: the
  // alg-confusion guard must reject on the header mismatch, never trusting it.
  const algLie = mintToken({
    header: { alg: "RS256", typ: "JWT" },
    payload: basePayload(),
    sign: { kind: "hs256", secret: HS256_SECRET },
  });
  check(
    jwtErrorCode(() => verifyJwt(algLie, hsOpts)) === "alg-mismatch",
    "header alg \"RS256\" while expecting HS256 -> JwtError code \"alg-mismatch\"",
  );

  /* ---- RS256: sign with private key, verify with public PEM ------ */
  const kp = genRsa();
  const rsOpts = {
    alg: "RS256" as const,
    publicKeyPem: kp.publicKey,
    issuer: ISSUER,
    audience: AUDIENCE,
    now: NOW,
  };
  const rsToken = mintToken({
    header: { alg: "RS256", typ: "JWT" },
    payload: basePayload(),
    sign: { kind: "rs256", privateKey: kp.privateKey },
  });
  const rsClaims = verifyJwt(rsToken, rsOpts);
  check(rsClaims.sub === "user-1", `valid RS256 verifies, sub === "user-1" (got "${rsClaims.sub}")`);

  /* ---- RS256 verified with a DIFFERENT public key -> "bad-signature" */
  const otherKp = genRsa();
  check(
    jwtErrorCode(() =>
      verifyJwt(rsToken, { ...rsOpts, publicKeyPem: otherKp.publicKey }),
    ) === "bad-signature",
    "RS256 verified with a different public key -> JwtError code \"bad-signature\"",
  );
}

/* ================================================================== */
/* [metadata/verifier]                                                 */
/* ================================================================== */

/** Build an OAuthConfig the unit tests can pass directly. */
function buildConfig(over: Partial<OAuthConfig> = {}): OAuthConfig {
  const resourceUrl = over.resourceUrl ?? RESOURCE_URL;
  const metadataPath = "/.well-known/oauth-protected-resource";
  return {
    issuer: ISSUER,
    audience: AUDIENCE,
    resourceUrl,
    alg: "HS256",
    secret: HS256_SECRET,
    requiredScopes: [],
    metadataPath,
    metadataUrl: new URL(metadataPath, resourceUrl).toString(),
    ...over,
  };
}

async function testMetadataAndVerifier(): Promise<void> {
  process.stdout.write("\n[metadata/verifier] buildProtectedResourceMetadata + wwwAuthenticate + createJwtVerifier\n");

  const config = buildConfig();

  /* ---- buildProtectedResourceMetadata ---------------------------- */
  const md = buildProtectedResourceMetadata(config);
  check(md.resource === RESOURCE_URL, `metadata.resource === resourceUrl (got "${md.resource}")`);
  check(
    Array.isArray(md.authorization_servers) &&
      md.authorization_servers.length === 1 &&
      md.authorization_servers[0] === ISSUER,
    `metadata.authorization_servers === [issuer] (got ${JSON.stringify(md.authorization_servers)})`,
  );
  check(
    Array.isArray(md.bearer_methods_supported) &&
      md.bearer_methods_supported.length === 1 &&
      md.bearer_methods_supported[0] === "header",
    `metadata.bearer_methods_supported === ["header"] (got ${JSON.stringify(md.bearer_methods_supported)})`,
  );

  /* ---- wwwAuthenticate carries the metadata pointer + error ------- */
  const wwwa = wwwAuthenticate(config, { error: "invalid_token" });
  check(
    wwwa.includes('resource_metadata="'),
    `wwwAuthenticate contains 'resource_metadata="' (got ${JSON.stringify(wwwa)})`,
  );
  check(
    wwwa.includes('error="invalid_token"'),
    `wwwAuthenticate contains 'error="invalid_token"' (got ${JSON.stringify(wwwa)})`,
  );

  /* ---- createJwtVerifier with requiredScopes ["deploy"] ---------- */
  const scopedConfig = buildConfig({ requiredScopes: ["deploy"] });
  const verifier = createJwtVerifier(scopedConfig);

  // The verifier uses the real clock (no `now` injection), so mint a token that
  // is valid for a long window around the present moment.
  const realNow = Math.floor(Date.now() / 1000);
  const okToken = validHs256({ iat: realNow, exp: realNow + 3600, scope: "deploy admin" });
  const authInfo = await verifier.verify(okToken);
  check(authInfo.subject === "user-1", `verifier accepts scope "deploy admin", subject "user-1" (got "${authInfo.subject}")`);
  check(
    authInfo.scopes.includes("deploy") && authInfo.scopes.includes("admin"),
    `verifier extracts scopes ["deploy","admin"] (got ${JSON.stringify(authInfo.scopes)})`,
  );

  /* ---- a token missing the required scope -> insufficient_scope --- */
  const lowScopeToken = validHs256({ iat: realNow, exp: realNow + 3600, scope: "read" });
  let scopeErr: AuthError | undefined;
  try {
    await verifier.verify(lowScopeToken);
  } catch (err) {
    if (err instanceof AuthError) scopeErr = err;
  }
  check(
    scopeErr !== undefined && scopeErr.code === "insufficient_scope",
    `token with scope "read" missing required "deploy" -> AuthError "insufficient_scope" (got ${scopeErr ? scopeErr.code : "<none>"})`,
  );
  check(
    scopeErr !== undefined && scopeErr.status === 403,
    `insufficient_scope maps to HTTP 403 (got ${scopeErr ? scopeErr.status : "<none>"})`,
  );
}

/* ================================================================== */
/* [jwks] RS256 verification via a rotating JWKS endpoint (by kid)      */
/* ================================================================== */

/** Export a public-key PEM as a JWK with a kid (what an AS publishes). */
function jwkOf(publicKeyPem: string, kid: string): Record<string, unknown> {
  const jwk = crypto
    .createPublicKey(publicKeyPem)
    .export({ format: "jwk" }) as Record<string, unknown>;
  return { ...jwk, kid, alg: "RS256", use: "sig" };
}

/** A stub JWKS fetch that counts calls and returns a fixed document. */
function makeJwksFetch(
  doc: { keys: unknown[] },
  counter: { n: number },
): JwksFetch {
  return async () => {
    counter.n += 1;
    return { ok: true, status: 200, json: async () => doc };
  };
}

async function testJwks(): Promise<void> {
  process.stdout.write("\n[jwks] RS256 verification via a JWKS endpoint (by kid)\n");

  /* ---- env: OAUTH_JWKS_URI (no secret/PEM) -> enabled RS256 config ---- */
  const saved = snapshotEnv();
  try {
    clearOAuthEnv();
    process.env.OAUTH_ISSUER = ISSUER;
    process.env.OAUTH_AUDIENCE = AUDIENCE;
    process.env.OAUTH_JWKS_URI = "https://auth.example.com/oauth2/jwks";
    const cfg = getOAuthConfig();
    check(
      cfg !== null &&
        cfg.alg === "RS256" &&
        cfg.jwksUri === "https://auth.example.com/oauth2/jwks" &&
        cfg.secret === undefined,
      `env OAUTH_JWKS_URI (no secret/PEM) -> enabled RS256 config w/ jwksUri (got ${cfg ? `${cfg.alg}/${String(cfg.jwksUri)}` : "null"})`,
    );
    if (cfg !== null) {
      const md = buildProtectedResourceMetadata(cfg);
      check(
        md.authorization_servers[0] === ISSUER,
        `metadata.authorization_servers[0] byte-for-byte === issuer (got ${JSON.stringify(md.authorization_servers[0])})`,
      );
    }
  } finally {
    restoreEnv(saved);
  }

  /* ---- resolver + verifier against an injected JWKS endpoint ---------- */
  const kp = genRsa();
  const KID = "test-key-1";
  const jwks = { keys: [jwkOf(kp.publicKey, KID)] };
  const counter = { n: 0 };
  let clockMs = NOW * 1000;
  const resolver = createJwksResolver({
    jwksUri: "https://auth.example.com/oauth2/jwks",
    issuer: ISSUER,
    fetchImpl: makeJwksFetch(jwks, counter),
    now: () => clockMs,
    cooldownMs: 30_000,
    ttlMs: 600_000,
  });
  const jwksConfig = buildConfig({
    alg: "RS256",
    secret: undefined,
    publicKeyPem: undefined,
    jwksUri: "https://auth.example.com/oauth2/jwks",
  });
  const verifier = createJwtVerifier(jwksConfig, { jwksResolver: resolver });

  const realNow = Math.floor(Date.now() / 1000);
  const mkRs = (
    over: Record<string, unknown> = {},
    header: Record<string, unknown> = {},
  ): string =>
    mintToken({
      header: { alg: "RS256", typ: "JWT", kid: KID, ...header },
      payload: basePayload({ iat: realNow, exp: realNow + 3600, ...over }),
      sign: { kind: "rs256", privateKey: kp.privateKey },
    });

  /* valid RS256 resolved by kid -> subject; exactly one fetch */
  const ok = await verifier.verify(mkRs());
  check(ok.subject === "user-1", `JWKS valid RS256 (kid=${KID}) -> subject "user-1" (got "${ok.subject}")`);
  check(counter.n === 1, `JWKS fetched the key set once for the first verify (got ${counter.n})`);

  /* second verify reuses the cache (no extra fetch) */
  await verifier.verify(mkRs());
  check(counter.n === 1, `JWKS cached key reused on a second verify, still 1 fetch (got ${counter.n})`);

  /* wrong iss / wrong aud / expired -> invalid_token 401 (never fail open) */
  await assertAuthError(() => verifier.verify(mkRs({ iss: "https://evil.example.com" })), "invalid_token", 401, "JWKS wrong issuer -> invalid_token 401");
  await assertAuthError(() => verifier.verify(mkRs({ aud: "some-other-resource" })), "invalid_token", 401, "JWKS wrong audience -> invalid_token 401");
  await assertAuthError(() => verifier.verify(mkRs({ iat: realNow - 7200, exp: realNow - 3600 })), "invalid_token", 401, "JWKS expired token -> invalid_token 401");

  /* alg-confusion still rejected THROUGH the JWKS path */
  const algLie = mintToken({
    header: { alg: "HS256", typ: "JWT", kid: KID },
    payload: basePayload({ iat: realNow, exp: realNow + 3600 }),
    sign: { kind: "hs256", secret: HS256_SECRET },
  });
  await assertAuthError(() => verifier.verify(algLie), "invalid_token", 401, 'JWKS header alg "HS256" while RS256 expected -> invalid_token (alg-confusion guard holds)');
  const algNone = mintToken({
    header: { alg: "none", typ: "JWT", kid: KID },
    payload: basePayload({ iat: realNow, exp: realNow + 3600 }),
    sign: { kind: "none" },
  });
  await assertAuthError(() => verifier.verify(algNone), "invalid_token", 401, 'JWKS header alg "none" -> invalid_token (rejected)');

  /* unknown kid: bounded refresh. Within cooldown of the last fetch, NO refetch. */
  const fetchesBefore = counter.n;
  await assertAuthError(() => verifier.verify(mkRs({}, { kid: "rotated-2" })), "invalid_token", 401, "JWKS unknown kid -> invalid_token 401");
  check(counter.n === fetchesBefore, `JWKS unknown kid within cooldown does NOT refetch (bounded) (got +${counter.n - fetchesBefore})`);

  /* after the cooldown elapses, an unknown kid is allowed exactly ONE refresh */
  clockMs += 31_000;
  await assertAuthError(() => verifier.verify(mkRs({}, { kid: "rotated-2" })), "invalid_token", 401, "JWKS unknown kid after cooldown -> invalid_token 401");
  check(counter.n === fetchesBefore + 1, `JWKS unknown kid after cooldown triggers exactly one refresh (got +${counter.n - fetchesBefore})`);

  /* immediately again -> still bounded (no further fetch this cooldown) */
  await assertAuthError(() => verifier.verify(mkRs({}, { kid: "rotated-2" })), "invalid_token", 401, "JWKS repeated unknown kid -> invalid_token 401");
  check(counter.n === fetchesBefore + 1, `JWKS repeated unknown kid stays bounded to one refresh per cooldown (got +${counter.n - fetchesBefore})`);

  /* the KNOWN kid still verifies after all the rotation churn */
  const stillOk = await verifier.verify(mkRs());
  check(stillOk.subject === "user-1", `JWKS known kid still verifies after refreshes (got "${stillOk.subject}")`);

  /* https-only construction guard */
  let ctorErr = false;
  try {
    createJwksResolver({ jwksUri: "http://auth.example.com/jwks", issuer: ISSUER });
  } catch {
    ctorErr = true;
  }
  check(ctorErr, "JWKS resolver refuses a non-https (and non-loopback) JWKS URI");
}

/* ================================================================== */
/* [jwks] failure-path rate limiting + stale-on-error                  */
/* ================================================================== */

type FetchMode =
  | { ok: true; body: { keys: unknown[] } }
  | { ok: false };

/** A JWKS fetch whose behavior (success/failure/body) is switchable mid-test. */
function makeSwitchableFetch(state: { mode: FetchMode; n: number }): JwksFetch {
  return async () => {
    state.n += 1;
    if (!state.mode.ok) return { ok: false, status: 503, json: async () => ({}) };
    const body = state.mode.body;
    return { ok: true, status: 200, json: async () => body };
  };
}

async function testJwksFailureModes(): Promise<void> {
  process.stdout.write("\n[jwks] failure-path rate limiting + stale-on-error\n");

  const kp = genRsa();
  const KID = "k1";
  const state = { mode: { ok: true, body: { keys: [jwkOf(kp.publicKey, KID)] } } as FetchMode, n: 0 };
  let clk = NOW * 1000;
  const resolver = createJwksResolver({
    jwksUri: "https://auth.example.com/oauth2/jwks",
    issuer: ISSUER,
    fetchImpl: makeSwitchableFetch(state),
    now: () => clk,
    cooldownMs: 30_000,
    ttlMs: 600_000,
  });
  const cfg = buildConfig({
    alg: "RS256",
    secret: undefined,
    publicKeyPem: undefined,
    jwksUri: "https://auth.example.com/oauth2/jwks",
  });
  const verifier = createJwtVerifier(cfg, { jwksResolver: resolver });
  const realNow = Math.floor(Date.now() / 1000);
  const tok = (header: Record<string, unknown> = {}): string =>
    mintToken({
      header: { alg: "RS256", typ: "JWT", kid: KID, ...header },
      payload: basePayload({ iat: realNow, exp: realNow + 3600 }),
      sign: { kind: "rs256", privateKey: kp.privateKey },
    });

  /* prime the cache from a healthy AS */
  await verifier.verify(tok());
  // Read the count through a boolean local so the `asserts` helper doesn't pin
  // state.n to a literal type (it mutates at runtime via the fetch closure).
  const primedFetches: number = state.n;
  check(primedFetches === 1, `failure-modes: primed cache with 1 fetch (got ${primedFetches})`);

  /* AS now FAILING (503). An unknown-kid flood must be bounded to ONE fetch
     per cooldown EVEN on the failure path (the key bug the review caught). */
  state.mode = { ok: false };
  clk += 31_000; // allow exactly one attempt
  await assertAuthError(() => verifier.verify(tok({ kid: "x1" })), "invalid_token", 401, "failure-modes: unknown kid while AS failing -> 401");
  await assertAuthError(() => verifier.verify(tok({ kid: "x2" })), "invalid_token", 401, "failure-modes: 2nd unknown kid, same window -> 401");
  await assertAuthError(() => verifier.verify(tok({ kid: "x3" })), "invalid_token", 401, "failure-modes: 3rd unknown kid, same window -> 401");
  const boundedFetches: number = state.n;
  check(boundedFetches === 2, `failure-modes: unknown-kid flood bounded to ONE fetch per cooldown even while AS fails (got ${boundedFetches - 1} extra)`);

  /* stale-on-error: the KNOWN key still verifies from the retained cache */
  const okStale = await verifier.verify(tok());
  check(okStale.subject === "user-1", `failure-modes: stale-on-error keeps serving the known key while AS is down (got "${okStale.subject}")`);

  /* an empty-but-200 JWKS must NOT wipe the good cache (treated as failure) */
  state.mode = { ok: true, body: { keys: [] } };
  clk += 31_000;
  await assertAuthError(() => verifier.verify(tok({ kid: "y1" })), "invalid_token", 401, "failure-modes: empty JWKS, unknown kid -> 401");
  const okAfterEmpty = await verifier.verify(tok());
  check(okAfterEmpty.subject === "user-1", `failure-modes: an empty JWKS did NOT wipe the good cache (got "${okAfterEmpty.subject}")`);
}

/* ================================================================== */
/* [guard] resolveOAuthGuard().authorize(...)                          */
/* ================================================================== */

async function testGuard(): Promise<void> {
  process.stdout.write("\n[guard] resolveOAuthGuard().authorize\n");

  const saved = snapshotEnv();
  try {
    setCanonicalEnv();

    // Sanity: the canonical env resolves to an ENABLED config.
    const cfg = getOAuthConfig();
    check(cfg !== null, "canonical env -> getOAuthConfig() is non-null (OAuth enabled)");

    const guard = resolveOAuthGuard();
    check(guard !== null, "canonical env -> resolveOAuthGuard() is non-null");
    if (guard === null) return;

    /* ---- no header -> 401 missing_token -------------------------- */
    const missing = await guard.authorize(undefined);
    check(missing.ok === false, "authorize(undefined) -> ok:false");
    if (missing.ok === false) {
      check(missing.status === 401, `authorize(undefined) -> status 401 (got ${missing.status})`);
      check(
        missing.body.error === "missing_token",
        `authorize(undefined) -> body.error "missing_token" (got "${missing.body.error}")`,
      );
      check(
        missing.wwwAuthenticate.includes("resource_metadata"),
        "authorize(undefined) -> WWW-Authenticate carries resource_metadata",
      );
    }

    /* ---- malformed bearer token -> 401 invalid_token ------------- */
    const bad = await guard.authorize("Bearer not.a.jwt");
    check(bad.ok === false, 'authorize("Bearer not.a.jwt") -> ok:false');
    if (bad.ok === false) {
      check(bad.status === 401, `bad token -> status 401 (got ${bad.status})`);
      check(
        bad.body.error === "invalid_token",
        `bad token -> body.error "invalid_token" (got "${bad.body.error}")`,
      );
    }

    /* ---- a valid bearer token -> ok:true, subject "user-1" ------- */
    // Real clock here (the guard's verifier does not inject `now`).
    const realNow = Math.floor(Date.now() / 1000);
    const token = validHs256({ iat: realNow, exp: realNow + 3600 });
    const okResult = await guard.authorize(`Bearer ${token}`);
    check(okResult.ok === true, "authorize(valid Bearer) -> ok:true");
    if (okResult.ok === true) {
      check(
        okResult.auth.subject === "user-1",
        `authorize(valid Bearer) -> auth.subject "user-1" (got "${okResult.auth.subject}")`,
      );
    }
  } finally {
    restoreEnv(saved);
  }
}

/* ================================================================== */
/* [http] createBeamHttpServer on listen(0)                            */
/* ================================================================== */

async function testHttpWithAuth(): Promise<void> {
  process.stdout.write("\n[http] createBeamHttpServer WITH OAuth env\n");

  const saved = snapshotEnv();
  setCanonicalEnv();
  const server = createBeamHttpServer();
  try {
    const port = await listenEphemeral(server);
    const base = `http://127.0.0.1:${port}`;

    /* ---- GET /healthz -> 200 {status:"ok"} even with OAuth ON ----- */
    const health = await fetch(`${base}/healthz`);
    check(health.status === 200, `GET /healthz -> 200 even with auth on (got ${health.status})`);
    const healthJson = (await health.json()) as { status?: unknown };
    check(
      healthJson.status === "ok",
      `/healthz body { status: "ok" } (got ${JSON.stringify(healthJson)})`,
    );

    /* ---- GET metadata -> 200 + resource === resourceUrl ---------- */
    const mdRes = await fetch(`${base}/.well-known/oauth-protected-resource`);
    check(mdRes.status === 200, `GET metadata -> 200 (got ${mdRes.status})`);
    const mdJson = (await mdRes.json()) as { resource?: unknown };
    check(
      mdJson.resource === RESOURCE_URL,
      `metadata.resource === resourceUrl (got ${JSON.stringify(mdJson.resource)})`,
    );

    /* ---- POST /mcp no Authorization -> 401 + WWW-Authenticate ----- */
    const noAuth = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: initializeBody(),
    });
    check(noAuth.status === 401, `POST /mcp no token -> 401 (got ${noAuth.status})`);
    const wwwa = noAuth.headers.get("www-authenticate") ?? "";
    check(
      wwwa.includes("resource_metadata"),
      `POST /mcp no token -> WWW-Authenticate carries resource_metadata (got ${JSON.stringify(wwwa)})`,
    );
    // Drain the body so the socket can be reused/closed cleanly.
    await noAuth.text();

    /* ---- POST /mcp bad token -> 401 ------------------------------ */
    const badAuth = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer bad",
      },
      body: initializeBody(),
    });
    check(badAuth.status === 401, `POST /mcp "Bearer bad" -> 401 (got ${badAuth.status})`);
    await badAuth.text();

    /* ---- POST /mcp VALID token -> NOT 401 (auth passed) ---------- */
    const realNow = Math.floor(Date.now() / 1000);
    const token = validHs256({ iat: realNow, exp: realNow + 3600 });
    const okAuth = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: initializeBody(),
    });
    check(
      okAuth.status !== 401,
      `POST /mcp valid token -> NOT 401, reaches MCP server (got ${okAuth.status})`,
    );
    await okAuth.text();
  } finally {
    await closeServer(server);
    restoreEnv(saved);
  }
}

async function testHttpNoAuth(): Promise<void> {
  process.stdout.write("\n[http] createBeamHttpServer WITHOUT OAuth env (back-compat)\n");

  const saved = snapshotEnv();
  clearOAuthEnv();
  // Confirm the layer really is disabled before we build the server.
  check(getOAuthConfig() === null, "no OAUTH_* env -> getOAuthConfig() is null (disabled)");
  check(resolveOAuthGuard() === null, "no OAUTH_* env -> resolveOAuthGuard() is null (disabled)");

  const server = createBeamHttpServer();
  try {
    const port = await listenEphemeral(server);
    const base = `http://127.0.0.1:${port}`;

    /* ---- POST /mcp with NO token -> NOT 401 (no-auth mode) -------- */
    const noToken = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: initializeBody(),
    });
    check(
      noToken.status !== 401,
      `no-auth mode: POST /mcp no token -> NOT 401 (got ${noToken.status})`,
    );
    await noToken.text();

    /* ---- the metadata route is NOT served when disabled -> 404 --- */
    const md = await fetch(`${base}/.well-known/oauth-protected-resource`);
    check(
      md.status === 404,
      `no-auth mode: GET metadata path -> 404 (got ${md.status})`,
    );
    await md.text();
  } finally {
    await closeServer(server);
    restoreEnv(saved);
  }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  testPureJwt();
  await testMetadataAndVerifier();
  await testJwks();
  await testJwksFailureModes();
  await testGuard();
  await testHttpWithAuth();
  await testHttpNoAuth();
  process.stdout.write(`\nm5.test: PASS (${passCount} checks)\n`);
}

main().catch((err) => {
  process.stderr.write(`\nm5.test: FAIL - ${String(err)}\n`);
  process.exit(1);
});

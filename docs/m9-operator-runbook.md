# Beam Me Up — Hosted Connector Go-Live Runbook (Operator)

**Audience:** the project owner / operator. **Goal:** take the hosted Beam Me Up remote MCP connector LIVE so a non-technical user adds one URL in Claude, signs in with Google, and deploys to their own provider accounts.

**What is already true in the repo (do not re-build):** Beam is a spec-correct OAuth 2.0 **Resource Server** — it verifies bearer JWTs (HS256/RS256, alg-confusion guarded; `iss`/`aud`/`exp`/`nbf`/scopes checked in `packages/server/src/auth/oauth/{config,jwt,verifier,guard}.ts`) and publishes RFC 9728 Protected Resource Metadata at `/.well-known/oauth-protected-resource` with a `WWW-Authenticate` 401 challenge. The PRM `authorization_servers` field derives from `OAUTH_ISSUER`. **No Authorization Server code is needed** — you only stand up a managed AS and wire env vars. The container (`Dockerfile`) binds `0.0.0.0`, refuses to start without OAuth on a non-loopback bind, and exposes `GET /healthz`.

**Prerequisites on your machine:** `doctl` (authenticated to your DO account), `docker` with `buildx`, `git`, Node 20+, and Claude (desktop/web) for the acceptance test.

> **Secrets handling (read first, applies to every step):** the KEK / KMS key, every provider OAuth **client secret**, the AuthKit values, and `BEAM_VAULT_DATABASE_URL` live **only** in the platform secret store (DO App Platform encrypted env vars marked `type: SECRET`) and KMS — **never** in the repo, never in `.env` committed to git, never echoed in chat. The repo's `.env.example` documents the keys but holds no values. A single Postgres dump + KEK compromise exposes every user's live cloud credentials, so KMS-backed wrapping is mandatory (Step 3) and there is no static-key fallback on the hosted tier.

---

## Step 1 — Authorization Server: WorkOS AuthKit (delegated; no AS code in Beam)

Beam delegates login + token issuance to a managed MCP-native IdP. **WorkOS AuthKit** is the recommendation: it natively advertises MCP support (DCR + CIMD + PRM + S256 PKCE), gives a hosted Google sign-in, and lets Claude self-register with zero manual setup. **Fallbacks if you hit connector-OAuth quirks: Stytch or Scalekit** (both also do MCP DCR/CIMD); avoid self-hosting your own AS.

1.1 Create a WorkOS account → create a **Project** (use a dedicated "production" environment, not "staging").

1.2 In the AuthKit dashboard, **enable Google social login** (User Management → Authentication → Social login → Google). This is the only login button your non-technical users need. AuthKit's hosted login screen renders it; you write no login UI.

1.3 **Enable the MCP / DCR + CIMD option** (Dashboard → Connect / Configuration → "MCP" / Dynamic Client Registration). Confirm the AS metadata advertises `code_challenge_methods_supported: ["S256"]`, a `registration_endpoint` (DCR), **and** `client_id_metadata_document_supported: true` (CIMD) — both on, so the production Claude client never falls through to a manual `client_id` prompt regardless of which it picks.

1.4 **Capture two values from AuthKit:**
- the **Issuer URL** (e.g. `https://<your-tenant>.authkit.app` or the WorkOS-published issuer) — this is the exact string AuthKit puts in `iss`,
- the **JWKS URI** (from the AS's `/.well-known/oauth-authorization-server` or OIDC discovery doc).

1.5 **Set Beam's OAuth env** (these become DO App Platform env vars in Step 4; verified against `config.ts`). Prefer **RS256-via-JWKS** so no secret is shared with the IdP — set `OAUTH_JWKS_URI` (do **not** set `OAUTH_JWT_SECRET`):

```bash
OAUTH_ISSUER=https://<authkit-issuer>          # MUST equal the token `iss`, byte-for-byte
OAUTH_AUDIENCE=https://<public-host>/mcp        # MUST appear in the token `aud`
OAUTH_RESOURCE_URL=https://<public-host>/mcp    # this resource's public HTTPS /mcp URL
OAUTH_JWKS_URI=https://<authkit-issuer>/oauth2/jwks   # RS256 via JWKS (rotating keys by `kid`)
```

> **Byte-for-byte issuer match (RFC 8414 discovery):** `OAUTH_ISSUER` must equal the `iss` AuthKit mints **and** the issuer string AuthKit publishes — including scheme, host, path, and **trailing slash**. Beam's PRM `authorization_servers` is derived from `OAUTH_ISSUER`; if it differs by even a trailing `/`, Claude's RFC 8414 discovery resolves to the wrong document and Connect silently fails. Set `OAUTH_AUDIENCE` and `OAUTH_RESOURCE_URL` to the **public** `https://<host>/mcp` (not `localhost`), so the audience AuthKit binds the token to equals what Beam verifies. Configure AuthKit so its minted access tokens carry `aud = OAUTH_RESOURCE_URL` (RFC 8707 `resource` parameter) and `iss = OAUTH_ISSUER`, signed RS256 with a key in the JWKS.

**Cost:** WorkOS AuthKit is **free up to 1,000,000 monthly active users** including social login (then ~$2,500/M MAU); enterprise SSO/SCIM is a separate paid upsell you do **not** need here. Confirm current free-tier terms and that MCP DCR/CIMD is GA at your expected MAU before launch.

---

## Step 2 — Provider OAuth apps (self-serve MVP set: GitHub, DigitalOcean, Vercel)

These are the three providers with genuine self-serve user-delegated OAuth and **no commercial-partnership gate**. Register one OAuth app per provider; each app's **client id is non-secret** (env var, set normally) and each **client secret is a platform SECRET** (Step 4 / secret store). The redirect URI is always `https://<public-host>/oauth/callback/<provider>` (Beam's Connect web surface — `/connect/:provider` → `/oauth/callback/:provider`). Scope to the **minimum** Beam actually uses; never request write/admin you don't use.

**2.1 GitHub** (cleanest, instant). Register at GitHub → Settings → Developer settings → **OAuth Apps** (or a **GitHub App** for least privilege). Authorize `https://github.com/login/oauth/authorize`, token `https://github.com/login/oauth/access_token`.
- **Scope:** GitHub App fine-grained **`contents:read`** (least privilege to read the repo files the host AI ships). OAuth-App fallback: `public_repo` (public only) or `repo` (incl. private) only if you must.
- **Redirect URI:** `https://<public-host>/oauth/callback/github`
- **Env:** `GITHUB_OAUTH_CLIENT_ID` (normal), `GITHUB_OAUTH_CLIENT_SECRET` (**SECRET**).
- **Cost:** $0 to register and use.

**2.2 DigitalOcean** (self-serve; covers App Platform + DOCR image pull). Register at DO control panel → **API → OAuth Applications**. Authorize `https://cloud.digitalocean.com/v1/oauth/authorize`, token `https://cloud.digitalocean.com/v1/oauth/token`.
- **Scope:** **`app:read app:create`** (App Platform create + deploy; add `app:update` for redeploys) **+ `registry:read`** (pull the container image from DOCR). DO requires the matching `*:read` alongside any non-read scope.
- **Redirect URI:** `https://<public-host>/oauth/callback/digitalocean`
- **Env:** `DIGITALOCEAN_OAUTH_CLIENT_ID` (normal), `DIGITALOCEAN_OAUTH_CLIENT_SECRET` (**SECRET**).
- **Cost:** $0 to register and use.

**2.3 Vercel** (via a "connectable-account" integration; light review, no partner gate). Create at Vercel → **Integrations Console** → new integration; accept the Marketplace Agreement (gives a "Community" badge, installable immediately via your own Connect button — the 500-install public-listing threshold does **not** apply). Token exchange `POST https://api.vercel.com/v2/oauth/access_token`.
- **Scope (API Scopes, per-resource):** **Projects = Read/Write**, **Deployments = Read/Write** (create projects + trigger deploys on the user's behalf).
- **Redirect URL:** `https://<public-host>/oauth/callback/vercel`
- **Env:** `VERCEL_OAUTH_CLIENT_ID` (normal), `VERCEL_OAUTH_CLIENT_SECRET` (**SECRET**).
- **Cost:** $0; budget a little lead time for the integration form (no blocking partner approval).

**2.4 Database providers — paste-a-key, NOT OAuth (and DB is deferred):**
- **Neon** has a real OAuth server with the right scopes **but client registration is partner-gated** ("OAuth integrations only for partners with active commercial relationships") — not self-serve. Start that partnership conversation in parallel, but for launch Neon is **vaulted paste-a-key**.
- **Upstash has NO OAuth at all** — only an email + management API key (Bearer). It is **strictly vaulted paste-a-key**.
- **Product decision: DEPLOY-WITHOUT-DB first.** A successful deploy of an app that needs a DB returns the `db_needs_managed` state ("Your app's online! It'll need a database… one-click setup coming very soon"), never a chat key-paste. The paste-a-key path, when it ships, is a **dedicated guided page** (`connectUrl` → screenshots + instant validation), stored envelope-encrypted in the vault — never a chat paste. So Neon/Upstash env (`NEON_API_KEY`, `UPSTASH_EMAIL`/`UPSTASH_API_KEY`) is **not required** for go-live.

---

## Step 3 — Vault Postgres + KEK (KMS-backed, mandatory on hosted)

The `beam-me-up-vault` managed Postgres already exists (DO, `fra1`, `db-s-1vcpu-1gb`, id `3d99617c-5026-44d5-a57c-4dd99ba5bf67`). It is a **separate, Beam-owned** metadata DB (not a user's provisioned DB) holding `users` / `provider_connections` / `oauth_states`, with all tokens envelope-encrypted (AES-256-GCM per-row DEK, KMS-wrapped KEK, AAD binding `(issuer, sub, provider, account, field)`).

3.1 **Fetch the connection URI** and set it as a SECRET:

```bash
doctl databases connection 3d99617c-5026-44d5-a57c-4dd99ba5bf67 --format URI --no-header
# -> BEAM_VAULT_DATABASE_URL=<that postgres URI>
```

3.2 **Restrict the DB to trusted sources** (don't leave it open to the internet). Add the App Platform app (or its trusted IPs/tag) as the only inbound source:

```bash
doctl databases firewalls append 3d99617c-5026-44d5-a57c-4dd99ba5bf67 --rule app:<your-app-uuid>
# (after Step 4 you'll have the app uuid; until then restrict to your deploy IP)
doctl databases firewalls list 3d99617c-5026-44d5-a57c-4dd99ba5bf67   # verify
```

3.3 **TLS verification — pin the DO CA** so the cert is actually verified (not just `sslmode=require` with no CA):

```bash
doctl databases ca get 3d99617c-5026-44d5-a57c-4dd99ba5bf67 --format Certificate --no-header
# store that PEM as the SECRET env var BEAM_VAULT_PG_CA, and set:
BEAM_VAULT_PG_SSL=require
```

3.4 **Tier + KEK env** (KMS-backed KEK is **MANDATORY on hosted** — `buildKekProvider` throws and the server refuses to start if `BEAM_TIER=hosted` and `BEAM_KEK_PROVIDER` is `local-dev` or unset; there is no static-key fallback for this tier):

```bash
BEAM_TIER=hosted
BEAM_KEK_PROVIDER=aws-kms          # or gcp-kms
BEAM_KMS_KEY_ID=<KMS key ARN/alias (aws) | full CryptoKeyVersion resource name (gcp)>
# (BEAM_KEK_LOCAL_SECRET is DEV-ONLY and ignored unless provider=local-dev — do NOT set it on hosted)
```
Create the KMS key first in your AWS/GCP account (a single symmetric encrypt/decrypt key is enough; grant the running app's role `Encrypt`/`Decrypt` only). The KEK material never enters Beam's address space — wrap/unwrap are remote KMS calls.

3.5 **Run the migration** (idempotent, advisory-locked; creates the three tables + `schema_migrations` ledger):

```bash
BEAM_VAULT_DATABASE_URL=<uri> BEAM_VAULT_PG_SSL=require npm run vault:migrate
```

**Cost:** the `db-s-1vcpu-1gb` managed Postgres is ~**$15/mo** (already provisioned). KMS: a few cents/month per key + ~$0.03 per 10k requests (negligible at MVP volume).

---

## Step 4 — Deploy to DigitalOcean App Platform

Build and push the image (the included `Dockerfile`: `node:22-alpine` multi-stage, non-root, `CMD node packages/server/dist/server/http.js`, binds `0.0.0.0`) to your **`ai-trainer` DOCR**, then create the App with the env from Steps 1–3. **TLS terminates at the platform load balancer** — the container speaks plain HTTP behind it.

4.1 **Build + push to DOCR** (must be `linux/amd64`):

```bash
doctl registry login
docker buildx build --platform linux/amd64 \
  -t registry.digitalocean.com/ai-trainer/beam-me-up:latest \
  --push .
```

4.2 **Create the App spec** with the public domain and all env (mark every secret `type: SECRET`). Minimal spec shape:

```yaml
# beam-app.yaml
name: beam-me-up
region: fra
services:
  - name: web
    image:
      registry_type: DOCR
      repository: beam-me-up
      tag: latest
    http_port: 3000
    instance_size_slug: basic-xxs
    health_check:
      http_path: /healthz
    envs:
      - { key: BEAM_HTTP_HOST, value: "0.0.0.0" }
      - { key: PORT, value: "3000" }
      - { key: BEAM_HTTP_ALLOWED_HOSTS,   value: "<public-host>" }
      - { key: BEAM_HTTP_ALLOWED_ORIGINS, value: "https://<public-host>" }
      - { key: OAUTH_ISSUER,       value: "https://<authkit-issuer>" }
      - { key: OAUTH_AUDIENCE,     value: "https://<public-host>/mcp" }
      - { key: OAUTH_RESOURCE_URL, value: "https://<public-host>/mcp" }
      - { key: OAUTH_JWKS_URI,     value: "https://<authkit-issuer>/oauth2/jwks" }
      - { key: BEAM_TIER,          value: "hosted" }
      - { key: BEAM_KEK_PROVIDER,  value: "aws-kms" }
      - { key: BEAM_VAULT_PG_SSL,  value: "require" }
      - { key: BEAM_KMS_KEY_ID,                type: SECRET, value: "<kms-key-id>" }
      - { key: BEAM_VAULT_DATABASE_URL,        type: SECRET, value: "<vault-uri>" }
      - { key: BEAM_VAULT_PG_CA,               type: SECRET, value: "<DO CA PEM>" }
      - { key: GITHUB_OAUTH_CLIENT_ID,         value: "<id>" }
      - { key: GITHUB_OAUTH_CLIENT_SECRET,     type: SECRET, value: "<secret>" }
      - { key: DIGITALOCEAN_OAUTH_CLIENT_ID,   value: "<id>" }
      - { key: DIGITALOCEAN_OAUTH_CLIENT_SECRET, type: SECRET, value: "<secret>" }
      - { key: VERCEL_OAUTH_CLIENT_ID,         value: "<id>" }
      - { key: VERCEL_OAUTH_CLIENT_SECRET,     type: SECRET, value: "<secret>" }
domains:
  - domain: <public-host>
    type: PRIMARY
```

```bash
doctl apps create --spec beam-app.yaml
# capture the app uuid -> feed it back into Step 3.2 firewall rule
doctl apps list
```

Notes: `BEAM_HTTP_HOST=0.0.0.0` is required to accept platform traffic; the container **refuses to start without OAuth** on that bind (Step 1 env satisfies it — do **not** set `BEAM_HTTP_ALLOW_INSECURE`). `BEAM_HTTP_ALLOWED_HOSTS`/`ALLOWED_ORIGINS` must list the public domain or the DNS-rebinding guard in `http.ts` returns 403. Point your DNS at the App Platform domain so AuthKit redirects and the public `/mcp` URL resolve.

4.3 **Confirm health + PRM** once live:

```bash
curl -fsS https://<public-host>/healthz        # -> {"status":"ok"} (or readiness body)
curl -fsS https://<public-host>/.well-known/oauth-protected-resource | python3 -m json.tool
# verify authorization_servers[0] == OAUTH_ISSUER byte-for-byte (incl. trailing slash)
```

**Cost:** `basic-xxs` App Platform instance ~**$5/mo**; DOCR storage on the existing `ai-trainer` registry (basic tier ~$5/mo if not already counted). Domain/TLS is included by the platform.

---

## Step 5 — Acceptance test (go/no-go gate)

This path **cannot be unit-tested** — it needs a real Claude ↔ AuthKit ↔ Beam round-trip including refresh and a container restart. Run it against the live host.

5.1 **Add the connector in Claude:** add custom connector URL `https://<public-host>/mcp`. Claude hits `/mcp` → 401 with `WWW-Authenticate resource_metadata` → reads PRM → discovers AuthKit via RFC 8414 → **self-registers (CIMD/DCR)** with no manual client_id prompt. **PASS criteria:** no "enter client id" prompt appears.

5.2 **Google login:** Claude opens AuthKit in the browser → user clicks **Sign in with Google** → consents → Claude replays `/mcp` with `Authorization: Bearer`. **PASS:** Beam accepts the token (no repeated 401 loop).

5.3 **Pure tool call:** ask Claude to run `route_target` on any repo (no provider connection needed). **PASS:** it returns a Vercel-vs-container recommendation — proves identity + transport + tool dispatch work end-to-end.

5.4 **Connect round-trip (one provider):** trigger a deploy so Beam returns `needsConnect` for GitHub (or Vercel) → user clicks **Connect** → `/connect/github` 302s to GitHub authorize (PKCE) → approves → `/oauth/callback/github` exchanges the code, envelope-encrypts, upserts `provider_connections`, renders **"You're connected to GitHub."** → chat auto-resumes. **PASS:** the connection lands in the vault and the resumed tool returns `needsConfirmation`/`ok`, not another `needsConnect`.

5.5 **A deploy lands in the operator test account:** confirm the destination-confirmation gate fires ("Quick check before I create anything…"), tap **Yes**, and verify the app actually appears in **your test provider account** at a live URL.

**Known connector-OAuth quirks to watch — these are the go/no-go gates:**
- **Token persistence across restart.** After 5.2 passes, **redeploy/restart the App Platform instance** (`doctl apps create-deployment <app-uuid>`) and confirm the existing Claude session still works **without re-login**. (Documented Claude/WorkOS issue: tokens failing to persist across restart.) Because Beam is stateless and verifies via JWKS, a restart must be transparent — if it forces re-login, investigate before launch.
- **Issuer trailing-slash / discovery mismatch.** If Connect hangs or loops at the authorize step, re-check that `OAUTH_ISSUER`, the PRM `authorization_servers[0]`, and the `iss` in a decoded token are **identical byte-for-byte** (the #1 silent failure). Also confirm a JWKS `kid` rotation is handled (token verifies after AuthKit rotates keys).
- **Cross-user binding sanity.** Confirm the callback derives the user from the signed single-use `oauth_states` row (not a query param/cookie), and that a token missing `sub` is rejected 401 — two different Google users must get **isolated** vaults.

**GO** only when 5.1–5.5 pass **and** the restart-persistence + issuer-match gates are green. If WorkOS connector OAuth misbehaves, repoint `OAUTH_ISSUER`/`OAUTH_JWKS_URI` to **Stytch or Scalekit** (standard OAuth/JWT — low lock-in) and re-run Step 5.

---

### Env var quick-reference (all set in Step 4's App spec)

| Var | Value | Store |
|---|---|---|
| `OAUTH_ISSUER` | AuthKit issuer (trailing-slash exact) | env |
| `OAUTH_AUDIENCE` / `OAUTH_RESOURCE_URL` | `https://<host>/mcp` | env |
| `OAUTH_JWKS_URI` | AuthKit JWKS URL | env |
| `BEAM_TIER` | `hosted` | env |
| `BEAM_KEK_PROVIDER` / `BEAM_KMS_KEY_ID` | `aws-kms`/`gcp-kms` + key id | id is **SECRET** |
| `BEAM_VAULT_DATABASE_URL` | `doctl databases connection 3d99617c-…` | **SECRET** |
| `BEAM_VAULT_PG_SSL` / `BEAM_VAULT_PG_CA` | `require` + DO CA PEM | CA is **SECRET** |
| `BEAM_HTTP_HOST` | `0.0.0.0` | env |
| `BEAM_HTTP_ALLOWED_HOSTS` / `_ORIGINS` | public host / `https://`host | env |
| `<PROVIDER>_OAUTH_CLIENT_ID` | GitHub/DigitalOcean/Vercel client ids | env |
| `<PROVIDER>_OAUTH_CLIENT_SECRET` | GitHub/DigitalOcean/Vercel secrets | **SECRET** |

**Total run-rate at MVP scale:** ~$5 (app) + ~$15 (vault Postgres) + ~$5 (DOCR) + ~$0 (AuthKit free ≤1M MAU) + cents (KMS) ≈ **~$25/mo**. Provider OAuth app registration and end-user deploys run on the users' own free tiers — Beam adds no fee.

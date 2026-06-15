# Beam Me Up

An MCP server that orchestrates taking a repo from "it runs locally" to "it's
live" — by handing the host AI (Claude Code / Cursor) an ordered plan and a set
of pure, deterministic tools it can call along the way.

> **Milestone M0** — the runnable skeleton: **one prompt + three pure
> (no-network) tools**, so you can connect it to an MCP client and watch the
> "beam me up" plan fire.
>
> **Milestone M1 (now live)** — **real Vercel deploys**: four new tools
> (`create_deploy_target`, `set_env_vars`, `deploy`, `get_deploy_logs`) that talk
> to the Vercel REST API behind a pluggable `DeployTarget` adapter. See
> [Real deploys with Vercel (M1)](#real-deploys-with-vercel-m1) below.
>
> **Milestone M2 (now live)** — **headless database provisioning**: one new tool
> (`provision_database`) that creates a managed database behind a pluggable
> `DbProvisioner` adapter and hands back connection-string env vars —
> `postgres` → **Neon**, `redis` → **Upstash**. Creds come from env vars
> (`NEON_API_KEY`, `UPSTASH_EMAIL` + `UPSTASH_API_KEY`). See
> [Provision a database (M2)](#provision-a-database-m2) below.
>
> **Milestone M3 (now live)** — **preflight scan**: one new pure tool
> (`preflight_scan`) that reviews the repo for security + functionality. It
> detects the stack (frontend / backend / databases) and services, finds
> hardcoded secrets and emits a gitignored-`.env` migration plan (secret values
> are masked in the findings), flags access-control gaps, and returns a detected
> install/build/test/start plan with ordered instructions. See
> [Preflight scan (M3)](#preflight-scan-m3) below.
>
> **Milestone M4 (now live)** — **DigitalOcean deploys**: the deploy tools
> (`create_deploy_target`, `set_env_vars`, `deploy`, `get_deploy_logs`) now also
> target **DigitalOcean App Platform** via a container image — `provider:
> "digitalocean"` with `DIGITALOCEAN_TOKEN`, behind the same `DeployTarget`
> adapter. The host AI builds + pushes the image (DOCR / Docker Hub / GHCR) and
> `deploy` rolls it out; `create_deploy_target` is idempotent (reuses an existing
> app by name, so "beam me up" on an already-deployed app just redeploys). See
> [Deploy to DigitalOcean (M4)](#deploy-to-digitalocean-m4) below.
>
> **Milestone M5 (now live)** — **OAuth on the HTTP transport**: the Streamable
> HTTP server can now require a verified bearer token on `/mcp` and publishes
> RFC 9728 protected-resource metadata, so it is safe to run off-localhost.
> Configure it with `OAUTH_ISSUER` / `OAUTH_AUDIENCE` + a key (HS256 secret or
> RS256 public key); unconfigured, it stays no-auth for local dev. See
> [OAuth on the HTTP transport (M5)](#oauth-on-the-http-transport-m5) below. The
> remaining milestone, M6 (monorepo split + packaging), is now done too — the
> codebase is an npm-workspaces monorepo under `packages/*`.

---

## What M0 is

M0 is a single TypeScript package (ESM, Node 20+) that exposes, over the MCP
protocol:

- **1 prompt** — `beam_me_up`: returns the ordered, numbered orchestration plan
  the host AI follows. Each step is tagged `[HOST-AI]`, `[MCP-TOOL: <name>]`, or
  `[CONFIRM]`, and steps that aren't live in M0 are marked **coming soon**.
- **3 pure tools** (deterministic, no network):
  - `route_target` — decide Vercel (serverless) vs a container host
    (DigitalOcean) from repo signals; returns target, recommended provider,
    confidence, and human-readable reasons.
  - `validate_compose` — validate a provided `docker-compose.yml`, or generate
    one from detected services.
  - `write_todo` — produce `TODO.md` (manual setup, security follow-ups, ship
    checklist, operate) plus a structured ship checklist.

The host AI uses **its own file tools** to read/write the repo; the MCP server
itself never touches the filesystem or the network.

### M0 status of the implementation areas

The SDK wiring, schemas, and entrypoints are complete, and all four logic
areas — the plan renderer, signal detection + routing, compose
generation/validation, and the TODO writer — are **implemented**. `npm run
typecheck`, `npm run build`, and `npm test` all pass, and both the stdio and
HTTP entrypoints start and serve the prompt + three tools.

---

## Requirements

- Node.js >= 20
- npm

## Install

```bash
npm install
```

## Run

Two transports are provided.

### stdio (recommended for Claude Code / Cursor)

```bash
npm run dev:stdio        # tsx packages/server/src/server/stdio.ts
# or, after `npm run build`:
npm run start:stdio      # node packages/server/dist/server/stdio.js
```

### Streamable HTTP

```bash
npm run dev:http         # tsx packages/server/src/server/http.ts  (PORT defaults to 3000)
# or, after `npm run build`:
npm run start:http       # node packages/server/dist/server/http.js
```

The HTTP server listens on `http://localhost:3000/mcp`. By default it runs with
**no auth** (localhost dev). To make it **safe off-localhost, configure OAuth**
(M5): set `OAUTH_ISSUER` + `OAUTH_AUDIENCE` + a key and every `/mcp` request must
carry a verified bearer token. See
[OAuth on the HTTP transport (M5)](#oauth-on-the-http-transport-m5) below.

## Other scripts

```bash
npm run typecheck        # tsc --noEmit
npm run build            # tsc -> dist/
npm test                 # tsx src/smoke-test.ts (M0 in-memory client test)
npm run test:m1          # tsx test/m1.test.ts (M1 deploy tests, mocked Vercel API)
npm run test:m2          # tsx test/m2.test.ts (M2 DB-provision tests, mocked Neon/Upstash APIs)
npm run test:m3          # tsx test/m3.test.ts (M3 preflight_scan tests, pure / no network)
npm run test:m4          # tsx test/m4.test.ts (M4 DigitalOcean deploy tests, mocked DO API)
npm run test:m5          # tsx test/m5.test.ts (M5 OAuth HTTP tests, pure crypto + ephemeral-port HTTP)
```

---

## Connect to Claude Code

### stdio

```bash
claude mcp add beam-me-up -- npx tsx /Users/Kristoffer.Berg/github/beam-me-up/packages/server/src/server/stdio.ts
```

### Streamable HTTP

Start the HTTP server first (`npm run dev:http`), then:

```bash
claude mcp add --transport http beam-me-up-http http://localhost:3000/mcp
```

Once connected, invoke the `beam_me_up` prompt and let the host AI follow the
plan, calling `route_target`, `validate_compose`, and `write_todo` as it goes.

---

## Real deploys with Vercel (M1)

M1 makes the deploy step **live for Vercel**. The server now exposes four
additional tools, all routed through a single pluggable `DeployTarget` adapter
(`src/adapters/deploy/interface.ts`); the Vercel implementation lives under
`src/adapters/deploy/vercel/`:

- **`create_deploy_target`** — create the Vercel project (`POST /v10/projects`)
  and return its `targetId` + dashboard URL.
- **`set_env_vars`** — upsert environment variables
  (`POST /v10/projects/{id}/env?upsert=true`). Secret vars are stored as Vercel
  `sensitive` (write-only) values and are **never echoed back**.
- **`deploy`** — two-phase deploy: SHA1-hash and upload each file
  (`POST /v2/files` with an `x-vercel-digest` header), then create the
  deployment (`POST /v13/deployments`). Returns `deploymentId`, the live `url`,
  and a normalised `status` (`queued` / `building` / `ready` / `error` /
  `canceled`).
- **`get_deploy_logs`** — read a deployment's build events
  (`GET /v3/deployments/{id}/events`) so the host AI can diagnose a failed build.

M1 shipped Vercel deploys; M4 adds **DigitalOcean** behind the same four tools
(see [Deploy to DigitalOcean (M4)](#deploy-to-digitalocean-m4)). For the Vercel
flow below, pass `provider: "vercel"`.

### 1. Get a Vercel token

Create a token at **Vercel → Account Settings → Tokens**
(<https://vercel.com/account/tokens>). If your project lives under a Vercel
**Team**, also grab the team id from **Team Settings → General → Team ID** (or
the `team_…` value in your dashboard URL).

### 2. Export your credentials

The deploy tools read credentials from the environment (full remote OAuth is a
separate upcoming milestone — see the roadmap):

```bash
export VERCEL_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxx   # required
export VERCEL_TEAM_ID=team_xxxxxxxxxxxx        # optional; only for team projects
```

When `VERCEL_TEAM_ID` is set it is appended as `?teamId=…` to every Vercel API
call. If `VERCEL_TOKEN` is missing, the tools return a clear *"set the
VERCEL_TOKEN environment variable"* error rather than attempting a call.

Launch the server with those vars in scope, e.g.:

```bash
VERCEL_TOKEN=… VERCEL_TEAM_ID=… npm run start:stdio
```

or, when registering with Claude Code, ensure the vars are exported in the shell
that launches the MCP server.

### 3. The host-AI flow

With the token in place, the host AI (Claude Code / Cursor) follows the
`beam_me_up` plan and now actually ships:

1. Inventory the repo and call **`route_target`** → confirm Vercel fits
   (serverless app, no long-lived process). If it routes to a container host,
   use the DigitalOcean flow instead (see
   [Deploy to DigitalOcean (M4)](#deploy-to-digitalocean-m4)).
2. Call **`create_deploy_target`** with `{ provider: "vercel", projectName,
   framework? }` → get back a `targetId`.
3. Call **`set_env_vars`** with `{ provider: "vercel", targetId, vars: [...] }`
   to push the app's env (DB URL, OAuth client id/secret, app secrets,
   `ALLOWED_EMAILS` / `ALLOWED_DOMAIN`). Mark sensitive values `secret: true`.
4. The host AI reads the build output with **its own file tools** and calls
   **`deploy`** with `{ provider: "vercel", targetId, projectName, framework?,
   files: [{ path, content | contentBase64 }], target?: "production" |
   "preview" }` → get back the `deploymentId` and live `url`.
5. Poll **`get_deploy_logs`** with `{ provider: "vercel", deploymentId }` to
   watch the build and surface any failure summary.
6. Call **`write_todo`** with the `liveUrl` to produce the final `TODO.md` +
   ship checklist.

> **Safety:** the only network the server ever touches is `api.vercel.com`, and
> only when a deploy tool is invoked with a valid token. The M1 test suite
> (`npm run test:m1`) runs the entire flow against an offline mock of
> `globalThis.fetch` and **fails loudly if any request escapes to a non-Vercel
> host or an unmocked endpoint** — so no real Vercel call happens during tests.

### Run the M1 tests

```bash
npm run test:m1          # tsx test/m1.test.ts — fully offline, mocked Vercel API
```

---

## Provision a database (M2)

M2 makes the database step **live and headless**. One new tool,
**`provision_database`**, creates a managed database behind a pluggable
`DbProvisioner` adapter and returns the connection-string env vars to push onto
your deploy target with `set_env_vars`:

- **`engine: "postgres"`** → **Neon**. Returns `envVars` with a pooled
  `DATABASE_URL` (host contains `-pooler`) plus a direct `DATABASE_URL_UNPOOLED`.
  Needs `NEON_API_KEY`.
- **`engine: "redis"`** → **Upstash**. Returns `envVars` with `REDIS_URL`
  (`rediss://default:…`), `UPSTASH_REDIS_REST_URL` and
  `UPSTASH_REDIS_REST_TOKEN`. Needs `UPSTASH_EMAIL` + `UPSTASH_API_KEY`.

Other engines return `"M2 supports postgres (Neon) and redis (Upstash) only"`,
and a missing credential returns a clear error naming the env var(s) to set.

Under the hood (verified against the live provider APIs on 2026-06-15):

- **Neon** (`https://console.neon.tech/api/v2`, `Authorization: Bearer
  $NEON_API_KEY`): `POST /projects` creates the project, then
  `GET /projects/{id}/connection_uri?database_name=…&role_name=…&pooled=true`
  fetches the pooled URI. `DATABASE_URL` is the pooled URI; `DATABASE_URL_UNPOOLED`
  is the direct `connection_uri` from the create response.
- **Upstash** (`https://api.upstash.com/v2`, HTTP Basic
  `base64("$UPSTASH_EMAIL:$UPSTASH_API_KEY")`): `POST /redis/database` with the
  **real** body `{ database_name, primary_region, platform: "aws", tls: true }`
  (the optional `region` input maps to `primary_region`, default `us-east-1`).
  Note the field is `database_name`, not `name`, and `platform` is required by the
  real API — the adapter, the offline mock, and the test all pin this real shape.

### Get your database credentials

```bash
# postgres -> Neon: create an API key at https://console.neon.tech/app/settings/api-keys
export NEON_API_KEY=neon_xxxxxxxxxxxxxxxx
# redis -> Upstash: account email + API key from https://console.upstash.com/account/api
export UPSTASH_EMAIL=you@example.com
export UPSTASH_API_KEY=xxxxxxxxxxxxxxxx
```

### The host-AI flow

1. Call **`provision_database`** with `{ engine: "postgres", name: "myapp-db" }`
   (or `{ engine: "redis", … }`). Capture the returned `envVars`.
2. Pass those `envVars` straight into **`set_env_vars`** for your deploy target.
3. Deploy. The credential and connection strings are **never echoed back** in
   the tool result.

> **Safety:** the only hosts the server touches for M2 are `console.neon.tech`
> and `api.upstash.com`, and only when `provision_database` is invoked with valid
> credentials. The M2 test suite (`npm run test:m2`) runs the whole flow against
> an offline mock of `globalThis.fetch` and **fails loudly if any request
> escapes to another host or an unmocked endpoint** — no real DB is created
> during tests.

### Run the M2 tests

```bash
npm run test:m2          # tsx test/m2.test.ts — fully offline, mocked Neon/Upstash APIs
```

---

## Preflight scan (M3)

M3 makes the **review step real**. One new **pure** tool, **`preflight_scan`**
(no filesystem, no network — like `route_target`/`validate_compose`/`write_todo`),
is the "front door" of the plan: the host AI reads the repo with its own tools
and passes the files in, and the scan returns a structural + security read in one
call.

Call it with `{ files: [{ path, content }], mode?: "product" | "internal" }`. It
returns:

- **`signals`** (via the existing `deriveSignals`) + **`services`** + **`stack`**
  (frontend / backend / databases / languages, plus Dockerfile/compose paths) —
  **reuse these for `route_target` and `validate_compose`** instead of deriving
  them by hand.
- **`secrets`** — hardcoded credentials found in source (private keys, cloud +
  provider API keys, connection strings, JWTs, generic secret assignments). The
  matched value is **masked** in the finding (e.g. `sk_live_…prST`); the raw
  value is never echoed in `secrets`, `summary`, or `securityFollowups`.
- **`envPlan`** — the `.env` migration: `envFileContent` (the real values, for
  the gitignored `.env` you write locally), `envExampleContent` (blank
  placeholders to commit), `gitignoreAdditions` (e.g. `.env`), and `replacements`
  (swap each inline literal for a `process.env.X` reference).
- **`accessControl`** — heuristic posture findings: wildcard CORS, missing auth
  middleware, an unguarded `/admin` route, debug enabled, a weak/committed
  framework secret, and (for `mode: "internal"`) a missing `ALLOWED_EMAILS` /
  `ALLOWED_DOMAIN` allowlist.
- **`build`** — the detected `packageManager` and `install`/`build`/`test`/
  `start`/`typecheck` commands + ordered `instructions` to **verify the app
  builds and runs before deploying** (detect-and-instruct; the tool never runs
  anything).
- **`securityFollowups`** + **`instructions`** + **`summary`** — feed
  `securityFollowups` straight into `write_todo` (step 12 of the plan).

> **Why a tool and not just the host AI:** the detection is deterministic and
> testable in isolation (secret regexes, stack/compose parsing, access-control
> heuristics), and the masking guarantee — that a found secret never leaks back
> into the findings or summary — is enforced and unit-tested. Real dependency
> CVE scanning stays the host AI's job (run `npm audit` etc.); `preflight_scan`
> is pure and offline.

### Run the M3 tests

```bash
npm run test:m3          # tsx test/m3.test.ts — pure, no network, no mock
```

---

## Deploy to DigitalOcean (M4)

M4 makes the **container path real**. When `route_target` sends an app to a
container host (websockets, workers, multi-service compose, long-running
handlers, persistent disk, or an always-on listener), deploy it to **DigitalOcean
App Platform** with the *same four deploy tools* — just pass
`provider: "digitalocean"`.

DigitalOcean's model differs from Vercel's: an App Platform **app is one spec**
that holds both the container image and the env vars, and `POST`/`PUT /v2/apps`
each trigger a deployment. The adapter maps the shared `DeployTarget` flow onto
that:

- **`create_deploy_target`** `{ provider: "digitalocean", projectName }` —
  **idempotent**: if an app with that name already exists it is reused (so
  re-running "beam me up" on an already-deployed app just redeploys); otherwise
  the app is created with a placeholder image that the first real `deploy`
  replaces. Returns the app `targetId` + dashboard URL.
- **`set_env_vars`** — merges the vars into the app spec's service (`secret: true`
  → DO `SECRET` type, encrypted). Never echoed back.
- **`deploy`** `{ provider: "digitalocean", targetId, projectName, image }` — the
  host AI **builds the repo's Dockerfile and pushes the image** to a registry
  with its own tools, then passes the reference as `image`. Accepted forms:
  `registry.digitalocean.com/<reg>/<repo>:<tag>` (DOCR),
  `docker.io/<org>/<repo>:<tag>` or `<org>/<repo>:<tag>` (Docker Hub),
  `ghcr.io/<org>/<repo>:<tag>` (GHCR). DO pulls + rolls it out (it does **not**
  accept uploaded files). Returns `{ deploymentId, url, status }`.
- **`get_deploy_logs`** — reads the deployment phase and fetches the build log
  from its presigned URL.

### 1. Get a DigitalOcean token

Create a personal access token with App Platform write scope at
**DigitalOcean → API → Tokens** (<https://cloud.digitalocean.com/account/api/tokens>),
then export it:

```bash
export DIGITALOCEAN_TOKEN=dop_v1_xxxxxxxxxxxxxxxx
```

If it is unset the deploy tools return a clear *"set the DIGITALOCEAN_TOKEN
environment variable"* error rather than attempting a call.

> **Safety:** the only host the server touches for DigitalOcean is
> `api.digitalocean.com` (plus the presigned log URLs a deployment hands back),
> and only when a deploy tool is invoked with a valid token. The M4 test suite
> (`npm run test:m4`) runs the whole flow against an offline mock of
> `globalThis.fetch` and **fails loudly if any request escapes** to another host
> or an unmocked endpoint — so no real app is created during tests.

### Run the M4 tests

```bash
npm run test:m4          # tsx test/m4.test.ts — fully offline, mocked DigitalOcean API
```

---

## OAuth on the HTTP transport (M5)

The stdio transport is local by construction, but the **Streamable HTTP**
transport needs protecting once it is reachable off-localhost. M5 makes the
Beam Me Up server an OAuth 2.0 **Resource Server**: it does not issue tokens, it
**verifies** tokens an external Authorization Server (AS) issued.

When OAuth is configured, the HTTP server:

- requires `Authorization: Bearer <token>` on every `/mcp` request; a missing or
  malformed token gets **401**, an invalid/expired token **401**, and a token
  lacking a required scope **403** — each with a
  `WWW-Authenticate: Bearer resource_metadata="…"` header;
- publishes **RFC 9728 protected-resource metadata** at
  `/.well-known/oauth-protected-resource` (the `resource` + the `authorization_servers`
  the client should use).

Tokens are verified with **`node:crypto` only** (no new deps): JWT signature
(**HS256** shared secret or **RS256** public key), with the **alg-confusion guard**
(the header `alg` must match the configured algorithm — `none` and
RS256↔HS256 downgrades are rejected) and `exp` / `nbf` / `iss` / `aud` checks.

### Configure it

OAuth is **enabled** as soon as an issuer, an audience, and a key are present;
with none set, the server stays no-auth for local dev.

```bash
export OAUTH_ISSUER=https://your-auth-server.example.com   # must equal the token `iss`
export OAUTH_AUDIENCE=beam-me-up                           # must appear in the token `aud`

# one of:
export OAUTH_JWT_SECRET=…            # HS256 shared secret, or
export OAUTH_JWT_PUBLIC_KEY="$(cat as-public-key.pem)"     # RS256 PEM public key

# optional:
export OAUTH_RESOURCE_URL=https://beam.example.com/mcp     # default http://localhost:$PORT/mcp
export OAUTH_REQUIRED_SCOPES="deploy"                      # space/comma-separated; default none
```

> The AS, token issuance, and (optionally) JWKS-URL key rotation live outside
> this server — M5 is the resource-server half (metadata + verification). A
> JWKS-URL fetcher and a full embedded AS are possible later add-ons.

### Run the M5 tests

```bash
npm run test:m5          # tsx test/m5.test.ts — pure crypto + an ephemeral-port HTTP server, no network
```

---

## Project layout

M6 split the codebase into an **npm-workspaces monorepo** under `packages/*`.
Each package is a real `@beam-me-up/<name>` package with its own `package.json`
+ `tsconfig.json`; the dependency graph is a clean DAG (no cycles):

```
core  ←  detect      ←  adapters  ←  tools  ←  server
core  ←  templates   ←  tools
```

```
package.json               # root: workspaces, scripts (typecheck/build/test)
tsconfig.base.json         # shared compiler options
tsconfig.json              # typecheck config (paths @beam-me-up/* -> packages/*/src)
tsconfig.solution.json     # build solution (`tsc -b`): references every package
packages/
  core/        @beam-me-up/core        (deps: zod)
    src/schemas.ts           # zod raw shapes + z.objects + inferred types; the shared contract
  detect/      @beam-me-up/detect      (deps: core)         — pure repo analysis
    src/signals.ts           # deriveSignals(files) -> RepoSignals
    src/secrets.ts           # M3: detectSecrets + buildEnvPlan (masked findings + .env plan)
    src/stack.ts             # M3: detectStack / detectServices / detectBuild
    src/access-control.ts    # M3: detectAccessControl(files, mode)
    src/route-target.ts      # routeTarget(input) -> RouteTargetOutput
    src/preflight-scan.ts    # M3: preflightScan(input) (composes the detectors)
  templates/   @beam-me-up/templates   (deps: core, yaml)
    src/compose.ts           # generateCompose(services) -> docker-compose yaml
    src/todo.ts              # renderTodoMarkdown(...) + shipChecklist(...)
  adapters/    @beam-me-up/adapters    (deps: core, detect) — provider plumbing
    src/registry.ts          # selectAdapter(provider, token) -> DeployTarget
    src/token.ts             # getProviderToken + getDbCredentials (provider/DB env vars)
    src/deploy/interface.ts  # DeployTarget contract
    src/deploy/vercel/*      # VercelClient + VercelAdapter (M1)
    src/deploy/digitalocean/* # DigitalOceanClient + app-spec + DigitalOceanAdapter (M4)
    src/db/{interface,registry}.ts + db/neon/* + db/upstash/*  # DbProvisioner (M2)
  tools/       @beam-me-up/tools       (deps: core, templates, adapters)
    src/validate-compose.ts  # validateCompose(input)
    src/write-todo.ts        # writeTodo(input)
    src/deploy-tools.ts      # M1/M4: create_deploy_target / set_env_vars / deploy / get_deploy_logs
    src/db-tools.ts          # M2: provisionDatabaseTool
    src/plan/beam-me-up-plan.ts # renderBeamMeUpPlan(args) -> orchestration plan (markdown)
  server/      @beam-me-up/server      (deps: core, detect, tools, @modelcontextprotocol/sdk)
    src/mcp/server.ts        # createServer(): McpServer — registers the prompt + 9 tools
    src/server/stdio.ts      # stdio entrypoint (bin)
    src/server/http.ts       # Streamable HTTP entrypoint (createBeamHttpServer; OAuth when OAUTH_* set)
    src/auth/oauth/*         # M5: config / jwt / verifier / metadata / guard
    src/smoke-test.ts        # M0 in-memory MCP client test
test/                        # top-level suites importing the package barrels (@beam-me-up/*)
  m1.test.ts + vercel-mock.ts          # M1 (mocked Vercel API)
  m2.test.ts + db-mock.ts              # M2 (mocked Neon/Upstash)
  m3.test.ts                           # M3 (pure)
  m4.test.ts + digitalocean-mock.ts    # M4 (mocked DO API)
  m5.test.ts                           # M5 (pure crypto + ephemeral-port HTTP)
```

`route_target` + `preflight_scan` live in **detect** (not tools): they are pure
repo-analysis, and putting them there breaks the would-be `adapters ↔ tools`
cycle (an adapter's `detectFit` reuses `routeTarget`). Dev + tests run straight
off the TypeScript sources via `tsx` (the root `tsconfig` maps `@beam-me-up/*` to
`packages/*/src`); `npm run build` does a project-references `tsc -b` to per-
package `dist/`.

---

## Design notes

- **Vercel-first, DigitalOcean fallback.** `route_target` recommends a container
  host when the repo needs a long-lived process (websocket server, background
  workers, multiple compose app services, long handlers, persistent filesystem
  writes, or a long-lived port listener). A bare `Dockerfile` is *not* decisive
  on its own. Otherwise it recommends Vercel. On container or low-confidence
  outcomes the plan instructs the host AI to **ask the user**.
- **Nothing hard-blocks shipping.** Ship-checklist items (e.g. register OAuth
  app, rotate secrets) are surfaced as `blocking: false` reminders.

---

## Roadmap

| Milestone | Scope |
| --------- | ----- |
| **M0** *(done)* | Runnable MCP server: `beam_me_up` prompt + 3 pure tools (`route_target`, `validate_compose`, `write_todo`). stdio + local HTTP (no auth). In-memory smoke test. |
| **M1** *(done)* | Real **Vercel** deploys — `create_deploy_target`, `set_env_vars`, `deploy`, `get_deploy_logs` behind a pluggable `DeployTarget` adapter. Token via `VERCEL_TOKEN` / `VERCEL_TEAM_ID`. Fully-mocked offline test suite (`npm run test:m1`). |
| **M2** *(done)* | Headless **database provisioning** — `provision_database` behind a pluggable `DbProvisioner` adapter (`postgres` → Neon, `redis` → Upstash). Returns pooled connection-string env vars. Creds via `NEON_API_KEY` / `UPSTASH_EMAIL` + `UPSTASH_API_KEY`. Fully-mocked offline test suite (`npm run test:m2`). |
| **M3** *(done)* | **Preflight scan** — `preflight_scan` (pure, no network): stack/services detection, hardcoded-secret findings (masked) + a gitignored-`.env` migration plan, access-control heuristics, and a detected build/test/start plan. Feeds `route_target` + `write_todo`. Pure offline test suite (`npm run test:m3`). _(CVE scanning is delegated to the host AI; the OAuth/auth scaffold is deferred to a later milestone.)_ |
| **M4** *(done)* | **DigitalOcean** deploys — `provider: "digitalocean"` on the same four deploy tools, behind the same `DeployTarget` adapter. App Platform container-image deploys (DOCR / Docker Hub / GHCR); image + env vars live in one app spec; idempotent create (redeploy by name); logs via the deployment's presigned URLs. Token via `DIGITALOCEAN_TOKEN`. Fully-mocked offline test suite (`npm run test:m4`). |
| **M5** *(done)* | **OAuth on the Streamable HTTP transport** — RFC 9728 protected-resource metadata + bearer-token verification (JWT, HS256/RS256 via `node:crypto`, alg-confusion guarded) with 401/403 + `WWW-Authenticate`, env-gated (`OAUTH_*`); unconfigured = no-auth localhost. Pure + ephemeral-port HTTP test suite (`npm run test:m5`). _(JWKS-URL fetch + a full embedded Authorization Server are possible later add-ons.)_ |
| **M6** *(done)* | **Monorepo split** — npm workspaces under `packages/*`: `@beam-me-up/core` (schemas), `detect` (incl. `route_target` + `preflight_scan`), `templates`, `adapters`, `tools`, `server`. Clean acyclic dependency graph, per-package barrels, project-references build (`tsc -b`), tests run off source via `tsx`. _(The live end-to-end "beam me up" run against real providers needs your tokens, so it stays a manual step.)_ |

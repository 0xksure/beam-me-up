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
> [Preflight scan (M3)](#preflight-scan-m3) below. A DigitalOcean target and
> OAuth on the HTTP transport are later milestones.

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
npm run dev:stdio        # tsx src/server/stdio.ts
# or, after `npm run build`:
npm run start:stdio      # node dist/server/stdio.js
```

### Streamable HTTP (local dev, no auth)

```bash
npm run dev:http         # tsx src/server/http.ts  (PORT defaults to 3000)
# or, after `npm run build`:
npm run start:http       # node dist/server/http.js
```

The HTTP server listens on `http://localhost:3000/mcp`. **It has no
authentication yet** — keep it on localhost. OAuth on the HTTP transport is a
separate upcoming milestone (see roadmap); M1 added real Vercel deploys over the
existing transports, not HTTP auth.

## Other scripts

```bash
npm run typecheck        # tsc --noEmit
npm run build            # tsc -> dist/
npm test                 # tsx src/smoke-test.ts (M0 in-memory client test)
npm run test:m1          # tsx test/m1.test.ts (M1 deploy tests, mocked Vercel API)
npm run test:m2          # tsx test/m2.test.ts (M2 DB-provision tests, mocked Neon/Upstash APIs)
npm run test:m3          # tsx test/m3.test.ts (M3 preflight_scan tests, pure / no network)
```

---

## Connect to Claude Code

### stdio

```bash
claude mcp add beam-me-up -- npx tsx /Users/Kristoffer.Berg/github/beam-me-up/src/server/stdio.ts
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

`provider` must be `"vercel"` in M1 — any other value (e.g. `"digitalocean"`)
returns a friendly *"DigitalOcean lands in M4"* error instead of calling out.

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
   Vercel is the wrong target — that path lands in M4.
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

## Project layout

```
package.json
tsconfig.json
.gitignore
.env.example
README.md
src/
  schemas.ts                 # zod raw shapes + z.objects + inferred types (tool I/O, prompt args, domain types)
  plan/beam-me-up-plan.ts    # renderBeamMeUpPlan(args) -> orchestration plan (markdown)
  detect/signals.ts          # deriveSignals(files) -> RepoSignals
  detect/secrets.ts          # M3: detectSecrets(files) + buildEnvPlan(files, secrets) (masked findings + .env plan)
  detect/stack.ts            # M3: detectStack / detectServices / detectBuild (frontend/backend/db + build plan)
  detect/access-control.ts   # M3: detectAccessControl(files, mode) -> AccessControlFinding[]
  tools/route-target.ts      # routeTarget(input) -> RouteTargetOutput
  tools/preflight-scan.ts    # M3: preflightScan(input) -> PreflightScanOutput (pure; composes the detectors)
  tools/validate-compose.ts  # validateCompose(input) -> ValidateComposeOutput
  templates/compose.ts       # generateCompose(services) -> docker-compose yaml
  tools/write-todo.ts        # writeTodo(input) -> WriteTodoOutput
  templates/todo.ts          # renderTodoMarkdown(...) + shipChecklist(...)
  tools/deploy-tools.ts      # M1: create_deploy_target / set_env_vars / deploy / get_deploy_logs handlers
  tools/db-tools.ts          # M2: provisionDatabaseTool handler (dispatch by engine, resolve creds)
  adapters/registry.ts       # selectAdapter(provider, token) -> DeployTarget
  adapters/deploy/interface.ts        # DeployTarget contract + ProviderToken/DeployStatus/DeployFile/EnvVar
  adapters/deploy/vercel/client.ts    # VercelClient — typed fetch wrapper (Bearer + teamId), VercelApiError
  adapters/deploy/vercel/index.ts     # VercelAdapter implements DeployTarget
  adapters/deploy/vercel/projects.ts  # createProjectImpl + setEnvVarsImpl
  adapters/deploy/vercel/deploy.ts    # deployImpl (two-phase SHA upload) + getLogsImpl + getUrlImpl
  adapters/db/interface.ts            # DbProvisioner contract + DbEngine/NeonCreds/UpstashCreds/ProvisionResult
  adapters/db/registry.ts             # selectDbProvisioner(engine, creds) -> DbProvisioner (postgres->Neon, redis->Upstash)
  adapters/db/neon/client.ts          # NeonClient — typed fetch wrapper (Bearer NEON_API_KEY)
  adapters/db/neon/index.ts           # NeonProvisioner implements DbProvisioner (project -> pooled DATABASE_URL)
  adapters/db/upstash/client.ts       # UpstashClient — typed fetch wrapper (Basic email:apiKey)
  adapters/db/upstash/index.ts        # UpstashProvisioner implements DbProvisioner (redis -> REDIS_URL + REST url/token)
  auth/token.ts              # getProviderToken(provider) + getDbCredentials(engine) — read provider/DB env vars
  mcp/server.ts              # createServer(): McpServer — registers prompt + 9 tools
  server/stdio.ts            # stdio entrypoint
  server/http.ts             # Streamable HTTP entrypoint (no auth yet; OAuth is a later milestone)
  smoke-test.ts              # M0 in-memory MCP client test
test/
  m1.test.ts                 # M1 offline deploy tests (mocked Vercel API)
  vercel-mock.ts             # installVercelMock() — offline fake for globalThis.fetch
  m2.test.ts                 # M2 offline DB-provision tests (mocked Neon/Upstash APIs)
  db-mock.ts                 # installDbMock() — offline fake for globalThis.fetch (Neon + Upstash)
  m3.test.ts                 # M3 preflight_scan tests (pure; no network, no mock)
```

The single-package layout is intentionally structured so it can later split
into a monorepo (detect / tools / templates / server boundaries).

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
| **M4** | DigitalOcean deploy adapter behind the same `DeployTarget` interface (container apps for the routes M1 sends to a container host). |
| **M5** | OAuth on the Streamable HTTP transport (authorization-server metadata + bearer-token verification) so it is safe to run off-localhost. |
| **M6** | Monorepo split + hardening: packaging the detect / tools / templates / server / adapters boundaries as separate packages, end-to-end "beam me up" run. |

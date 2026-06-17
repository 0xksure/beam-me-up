# Beam Me Up

An MCP server that takes a vibe-coded repo from "it runs locally" to "it's live."
You connect it to an MCP host (Claude Code / Cursor), open your project, and say:

> **beam me up**

The host AI then follows an ordered plan, calling this server's tools to review
the code, pick where to deploy, provision the database, and ship it — asking you
to confirm anything risky along the way. If the project is already deployed,
"beam me up" just builds and redeploys.

The server is **pure**: it never touches your filesystem or the network for
analysis. The host AI reads and writes your files with its own tools and passes
the contents in; only the deploy/provision tools make real provider API calls,
reading their tokens from the environment. Secrets are never echoed back.

---

## What it does

When you say "beam me up", the host AI works through this flow:

1. **Check credentials** — which providers are usable (`check_credentials`).
2. **Inventory the repo** — read the files (host AI's own tools).
3. **Review** — `preflight_scan` returns the detected stack (frontend / backend /
   databases), hardcoded secrets (masked) with a gitignored-`.env` migration
   plan, access-control + login findings, and a build/run plan. `review_code`
   adds a deeper vulnerability pass.
4. **Apply fixes** — move secrets into `.env`, address findings; if there's no
   login, the host AI offers to add Google sign-in (`scaffold_auth`).
5. **Route** — `route_target` decides Vercel (serverless) vs a container host
   (DigitalOcean); `validate_compose` validates/generates a `docker-compose.yml`
   when needed.
6. **Provision** — `provision_database` creates a managed Postgres (Neon) or
   Redis (Upstash) and returns its connection-string env vars.
7. **Deploy** — `create_deploy_target` → `set_env_vars` → `deploy` →
   `get_deploy_logs`, on Vercel or DigitalOcean App Platform.
8. **Hand off** — `write_todo` produces a `TODO.md` ship checklist; the host AI
   prints the live URL.

You can also call any tool directly ("review this repo", "provision a Postgres
DB", "add Google login") — the plan is just the default end-to-end path.

## Get started

Two ways to use Beam Me Up — pick one:

### 1. Use our hosted server (nothing to install)

Point your MCP client at the hosted endpoint:

```bash
claude mcp add --transport http beam-me-up https://<beam-me-up-host>/mcp
```

> Replace `<beam-me-up-host>` with the published endpoint. The hosted server
> requires a bearer token — set it as an `Authorization` header in your client's
> MCP config.

Then open your project and say **beam me up**. Deploys still use *your* provider
tokens — see [Configuration](#configuration).

### 2. Download the repo and run it yourself

Requires Node.js 20+ and npm. Clone, install, and connect it over stdio:

```bash
git clone https://github.com/0xksure/beam-me-up.git
cd beam-me-up
npm install
claude mcp add beam-me-up -- npx tsx "$PWD/packages/server/src/server/stdio.ts"
# or, after `npm run build`: node packages/server/dist/server/stdio.js
```

Prefer HTTP? Run your own local API instead:

```bash
npm run dev:http     # serves http://127.0.0.1:3000/mcp (loopback, no-auth dev)
claude mcp add --transport http beam-me-up-http http://localhost:3000/mcp
```

The local HTTP server is loopback-only and unauthenticated by default; to expose
it, see [Running it as a shared API](#running-it-as-a-shared-api).

Once connected, invoke the `beam_me_up` prompt (or just say "beam me up").

## The tools

**Pure** (deterministic, no filesystem/network — the host AI applies the output):

| Tool | What it does |
| --- | --- |
| `check_credentials` | Reports which provider tokens are present (booleans; values never read out). |
| `preflight_scan` | Repo review: stack/services, masked hardcoded-secret findings + `.env` migration plan, access-control posture, a positive login assessment, and a build/test/start plan. |
| `review_code` | Heuristic vulnerability review (XSS, SQL/command injection, info-disclosure, disabled TLS, missing auth/headers/rate-limit, eval, weak crypto, open redirect) with fixes. |
| `route_target` | Recommends Vercel vs a container host from repo signals, with confidence + reasons. |
| `validate_compose` | Validates a `docker-compose.yml`, or generates one from detected services. |
| `scaffold_auth` | Generates a Google sign-in scaffold (Next.js / Express / generic; optional internal-mode email allowlist). |
| `build_image_plan` | Emits the exact `docker buildx … --push` recipe (incl. the `linux/amd64` requirement) for a container deploy. |
| `write_todo` | Produces `TODO.md` (manual setup, security follow-ups, ship checklist, operate) + a structured checklist. |

**Live** (real provider API calls; tokens from the environment; secrets never echoed):

| Tool | What it does |
| --- | --- |
| `provision_database` | Creates a managed DB and returns its env vars — `postgres` → Neon, `redis` → Upstash. |
| `create_deploy_target` | Creates (or reuses) a Vercel project or a DigitalOcean App Platform app. |
| `set_env_vars` | Upserts environment variables onto the deploy target. |
| `deploy` | Deploys — Vercel uploads local files; DigitalOcean rolls out a container image. |
| `get_deploy_logs` | Reads build logs to confirm success or diagnose a failure. |

---

## Integrations

What it can deploy to today:

| Kind | Supported |
| --- | --- |
| **Hosting** | **Vercel** (serverless) · **DigitalOcean App Platform** (containers) |
| **Databases** | **Neon** (Postgres) · **Upstash** (Redis) |
| **Container registries** | DigitalOcean Container Registry (DOCR) · Docker Hub · GitHub Container Registry (GHCR) |
| **App auth** | Google sign-in scaffolding for the deployed app (Next.js / Express) |

`route_target` chooses Vercel vs a container host automatically. See
[Deploy targets](#deploy-targets) and [Databases](#databases) for the details.

---

## Configuration

All credentials are read from the environment of the process that launches the
server, and only when the relevant tool is called. Export them in the shell that
starts the MCP server (or your client's MCP env config). Nothing is needed for
the pure analysis tools.

```bash
# Deploy to Vercel
export VERCEL_TOKEN=…            # https://vercel.com/account/tokens
export VERCEL_TEAM_ID=team_…     # optional; only for projects under a Vercel Team

# Deploy to DigitalOcean App Platform
export DIGITALOCEAN_TOKEN=dop_v1_…   # https://cloud.digitalocean.com/account/api/tokens

# Provision a database
export NEON_API_KEY=neon_…       # postgres → Neon: https://console.neon.tech/app/settings/api-keys
export UPSTASH_EMAIL=you@…       # redis → Upstash: https://console.upstash.com/account/api
export UPSTASH_API_KEY=…
```

If a required token is unset, the tool returns a clear error naming the variable
to set rather than attempting a call.

---

## Deploy targets

The deploy tools (`create_deploy_target`, `set_env_vars`, `deploy`,
`get_deploy_logs`) work for both providers behind one pluggable adapter; pass
`provider: "vercel"` or `provider: "digitalocean"`.

**Vercel** (serverless). `deploy` does a two-phase upload: SHA-hash and upload
each file, then create the deployment. The host AI passes the files to ship as
`{ path, content | contentBase64 }`. Returns the live URL + a normalized status.

**DigitalOcean App Platform** (containers). An app is one spec holding the image
and env vars. The host AI builds and pushes the image itself (use
`build_image_plan` for the exact `docker buildx --platform linux/amd64 … --push`
recipe), then `deploy` references it as `image` (DOCR / Docker Hub / GHCR).
`create_deploy_target` is **idempotent** — re-running "beam me up" on an existing
app just redeploys.

## Databases

`provision_database` creates a managed database and returns the connection-string
env vars to feed straight into `set_env_vars`:

- **`engine: "postgres"` → Neon** — `DATABASE_URL` (pooled) +
  `DATABASE_URL_UNPOOLED` (direct). Needs `NEON_API_KEY`.
- **`engine: "redis"` → Upstash** — `REDIS_URL`, `UPSTASH_REDIS_REST_URL`,
  `UPSTASH_REDIS_REST_TOKEN`. Needs `UPSTASH_EMAIL` + `UPSTASH_API_KEY`.

The connection strings are returned so the host can wire them up; treat the tool
output as sensitive (don't log it).

## Security & login review

`preflight_scan` and `review_code` are pure, best-effort **heuristic** reviews —
useful pre-deploy hygiene, not a full SAST/pentest:

- **Secrets** — hardcoded credentials (private keys, cloud/provider keys incl.
  Google OAuth client secrets, connection strings, JWTs) are flagged with the
  value **masked**, plus a `.env` migration plan (what to write, gitignore, and
  the `process.env` replacements).
- **Access control** — wildcard CORS, missing auth middleware, unguarded
  `/admin` routes, debug-on, weak/committed framework secrets, and (in
  `mode: "internal"`) a missing `ALLOWED_EMAILS` / `ALLOWED_DOMAIN` allowlist.
- **Login** — a positive `auth` read: whether login is implemented, the detected
  mechanisms/providers, a confidence, and the signals behind it. When there's no
  login but the app serves requests, the plan offers to add **Google sign-in**
  via `scaffold_auth`, which returns the dependencies, env vars, OAuth redirect
  URIs, and files to write — tailored to Next.js (Auth.js), Express
  (passport-google-oauth20), or a generic fallback.

Dependency CVE scanning stays the host AI's job (e.g. `npm audit`).

## Running it as a shared API

The stdio transport is local by construction. The HTTP transport can drive real
deploys, so it's hardened for exposure:

- Binds **`127.0.0.1` by default**; set `BEAM_HTTP_HOST` (e.g. `0.0.0.0`) to
  expose it — but it then **refuses to start without OAuth** unless you set
  `BEAM_HTTP_ALLOW_INSECURE=1`.
- The `/mcp` endpoint validates the `Host`/`Origin` headers (DNS-rebinding
  protection); allowlist extra ones via `BEAM_HTTP_ALLOWED_HOSTS` /
  `BEAM_HTTP_ALLOWED_ORIGINS`.

**OAuth.** The server is an OAuth 2.0 **Resource Server**: it verifies bearer
tokens an external Authorization Server issued (it does not issue them). When
configured, every `/mcp` request needs a valid `Authorization: Bearer <token>`
(401/403 with `WWW-Authenticate`), and RFC 9728 protected-resource metadata is
published at `/.well-known/oauth-protected-resource`. Tokens are verified with
`node:crypto` (HS256 or RS256, alg-confusion guarded; `exp`/`nbf`/`iss`/`aud`
checked). OAuth turns on as soon as an issuer, audience, and key are set:

```bash
export OAUTH_ISSUER=https://your-auth-server.example.com   # must equal the token `iss`
export OAUTH_AUDIENCE=beam-me-up                           # must appear in the token `aud`
# one of:
export OAUTH_JWT_SECRET=…                                  # HS256 shared secret, or
export OAUTH_JWT_PUBLIC_KEY="$(cat as-public-key.pem)"     # RS256 PEM public key
# optional:
export OAUTH_RESOURCE_URL=https://beam.example.com/mcp     # default http://localhost:$PORT/mcp
export OAUTH_REQUIRED_SCOPES="deploy"                      # space/comma-separated; default none
```

---

## Project layout

An npm-workspaces monorepo under `packages/*`. Each package is a real
`@beam-me-up/<name>` package; the dependency graph is a clean DAG:

```
core  ←  detect      ←  adapters  ←  tools  ←  server
core  ←  templates   ←  tools
```

```
packages/
  core/        @beam-me-up/core        (deps: zod)
    src/schemas.ts           # zod shapes + inferred types; the shared contract
  detect/      @beam-me-up/detect      (deps: core) — pure repo analysis
    src/signals.ts           # deriveSignals(files) -> RepoSignals
    src/secrets.ts           # detectSecrets + buildEnvPlan (masked findings + .env plan)
    src/stack.ts             # detectStack / detectServices / detectBuild
    src/access-control.ts    # detectAccessControl(files, mode)
    src/auth-detect.ts       # detectAuth(files) -> positive login/auth assessment
    src/route-target.ts      # routeTarget(input) -> RouteTargetOutput
    src/preflight-scan.ts    # preflightScan(input) (composes the detectors)
    src/review.ts            # reviewCode(input) -> vulnerability findings + fixes
  templates/   @beam-me-up/templates   (deps: core, yaml)
    src/compose.ts           # generateCompose(services) -> docker-compose yaml
    src/todo.ts              # renderTodoMarkdown(...) + shipChecklist(...)
  adapters/    @beam-me-up/adapters    (deps: core, detect) — provider plumbing
    src/token.ts             # getProviderToken + getDbCredentials (env vars)
    src/deploy/interface.ts  # DeployTarget contract
    src/deploy/vercel/*       # Vercel adapter
    src/deploy/digitalocean/* # DigitalOcean App Platform adapter
    src/db/{neon,upstash}/*   # DbProvisioner adapters
  tools/       @beam-me-up/tools       (deps: core, templates, adapters)
    src/check-credentials.ts # which provider creds are present (no values)
    src/build-image-plan.ts  # docker build/push recipe + amd64 warning
    src/validate-compose.ts  # validateCompose(input)
    src/write-todo.ts        # writeTodo(input)
    src/scaffold-auth.ts     # scaffoldAuth(input) -> Google sign-in scaffold
    src/deploy-tools.ts      # create_deploy_target / set_env_vars / deploy / get_deploy_logs
    src/db-tools.ts          # provisionDatabaseTool
    src/plan/beam-me-up-plan.ts # renderBeamMeUpPlan(args) -> the orchestration plan
  server/      @beam-me-up/server      (deps: core, detect, tools, @modelcontextprotocol/sdk)
    src/mcp/server.ts        # createServer(): registers the prompt + 13 tools
    src/server/stdio.ts      # stdio entrypoint
    src/server/http.ts       # Streamable HTTP (loopback default, OAuth + Host/Origin guard)
    src/auth/oauth/*         # OAuth resource-server: config / jwt / verifier / metadata / guard
test/                        # offline suites importing the package barrels
```

`route_target` + `preflight_scan` live in **detect** (not tools): they're pure
repo-analysis, and that placement keeps the `adapters → tools` graph acyclic.

## Design notes

- **Vercel-first, DigitalOcean fallback.** `route_target` picks a container host
  only when the repo needs a long-lived process (websockets, workers, multiple
  services, long handlers, persistent disk, or an always-on listener). A bare
  `Dockerfile` isn't decisive. On container/low-confidence outcomes the plan
  tells the host AI to **ask the user**.
- **Nothing hard-blocks shipping.** Ship-checklist items (rotate secrets,
  register OAuth, …) are surfaced as `blocking: false` reminders.

## Development

```bash
npm run typecheck    # tsc --noEmit -p tsconfig.json
npm run build        # tsc -b tsconfig.solution.json -> per-package dist/
npm test             # in-memory MCP client smoke test
```

The suites under `test/` are all **offline** — provider APIs are mocked (and the
mocks fail loudly if any request escapes to a real host) or pure. Dev and tests
run straight off the TypeScript sources via `tsx`; `npm run build` does a
project-references `tsc -b` to per-package `dist/`.

```bash
npm run test:m1   # Vercel deploy tools (mocked)
npm run test:m2   # database provisioning, Neon/Upstash (mocked)
npm run test:m3   # preflight_scan (pure)
npm run test:m4   # DigitalOcean deploy tools (mocked)
npm run test:m5   # HTTP transport + OAuth (pure crypto + ephemeral-port server)
npm run test:m7   # review_code (pure)
npm run test:m8   # login detection + scaffold_auth + HTTP hardening (pure)
```

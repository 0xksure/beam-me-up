# Beam Me Up

You built something with Claude (or Cursor) and it works on your computer. Beam Me Up gets it **online** — a real web address other people can open — without you clicking through a hosting dashboard yourself.

Here's the whole idea: open your project in Claude Code or Cursor and type:

> **beam me up**

Claude then reviews your code, fixes a few common problems, picks a good place to host it, sets up a database if your app needs one, and ships it live — checking in with you before anything risky. When it's done, you get a link you can share with anyone. If your app is already online, "beam me up" just updates it with your latest changes.

Beam Me Up is **free, open-source software**. It doesn't host your app or charge you anything — it just automates the setup-and-clicking you'd otherwise do by hand. The rest of this page shows you how to set it up, answers the questions people usually ask, and — further down — has a full technical reference for developers who want to look under the hood.

---

## Get started

This is the path that works **today**. You'll connect Beam Me Up to Claude once, add a couple of keys for the services it deploys to, and then you can say "beam me up" in any project.

**You'll need two things on your computer first:**

- **Claude Code or Cursor** — the AI coding tool you already build with.
- **Node.js 20 or newer** — the free engine that runs Beam Me Up. If you've built apps with Claude, you very likely already have it. To check, open a terminal and type `node --version`; if you see `v20` or higher, you're set. If not, download the "LTS" version from [nodejs.org](https://nodejs.org) and run the installer. (npm, used below, comes bundled with it.)

**1. Download Beam Me Up to your computer.**
This copies the program onto your machine so you can run it. In a terminal:

```bash
git clone https://github.com/0xksure/beam-me-up.git
cd beam-me-up
npm install
```

`git clone` downloads it, `cd` steps into the folder, and `npm install` fetches the helper pieces it depends on — you only do this once. (Don't have `git`? Install it from [git-scm.com](https://git-scm.com), or download the project as a ZIP from the GitHub page and unzip it.)

**2. Connect it to Claude.**
This one command tells Claude "you can use Beam Me Up now." Run it from inside the `beam-me-up` folder, so `$PWD` points at the right place:

```bash
claude mcp add beam-me-up -- npx tsx "$PWD/packages/server/src/server/stdio.ts"
```

You only do this once. (Using Cursor or another MCP-aware tool instead? It works too — see [Connecting other AI tools](#connecting-other-ai-tools).)

**3. Give it keys for the services it deploys to.**
Beam Me Up ships your app to **your own** accounts on the usual providers — Vercel for hosting, Neon for a database, and so on — so you stay in control. To act on your behalf, it needs an access key (a **token** — think of it as an app-specific password) from each provider you want to use. These are free to create. You only need the ones you'll actually use; for a typical web app, a Vercel token is enough to start.

See [Set up your provider keys](#set-up-your-provider-keys) just below for exactly where to click and what to paste. You can add a database provider later if your app needs one.

**4. Open your project and say it.**
Go to your app's folder, start Claude, and type:

> **beam me up**

Claude walks through reviewing, fixing, hosting, and shipping — pausing to ask you before anything risky. At the end, it prints your **live URL** (the web address where your app now lives). Share it with anyone.

> **Already online?** Saying "beam me up" again on a project that's already deployed just rebuilds and ships your latest changes. Nothing gets duplicated.

> **Prefer not to install anything?** A hosted version — where you'd connect to a web address instead of running Beam Me Up yourself — is **coming soon, but it's not available yet.** For now, the steps above are the way to go. See the [FAQ](#faq) below for the plain-English version.

---

## FAQ

**How is this free, compared to Vercel that I normally click through to get my Claude-made app live?**

Fair question — and the honest answer matters. Beam Me Up is free *software*, not a free *host*. It does **not** host your app, and it's **not** a cheaper magic alternative to Vercel — we don't run any servers your app lands on.

What it actually does is automate the exact clicking-through you already do. When you deploy today, you log into Vercel, create a project, paste in some settings, and hit deploy. Beam Me Up does those same steps for you, through the same providers, using **your own accounts** (Vercel, plus Neon, Upstash, or DigitalOcean if your app needs a database or a different kind of server) — on those providers' normal **free tiers**. So the cost story is identical to what you have now: small apps usually fit inside the free limits, and you only start paying a provider if your app grows past them — exactly as it works today. **Beam Me Up never adds a fee on top.** It just saves you the clicking.

**Do I need to be a developer to use this?**

No. If you can copy-paste a few lines into a terminal once (the [Get started](#get-started) steps), and you already chat with Claude to build apps, you can use Beam Me Up.

**What's an "endpoint" or a "URL"?**

Both just mean a web address — like `https://myapp.vercel.app`. An "endpoint" is simply a web address that one program talks to. Your live app's link is a URL; that's the thing you'll share with people.

**What's a "token" or "bearer token"?**

A password-like key you copy from a provider and paste into your setup. It lets Beam Me Up act in *your* account without ever knowing your actual password. Treat it like a password: don't share it, post it publicly, or commit it to a repo.

**Do I need a GitHub account?**

Not for the recommended path above — the `git clone` command just copies public code, no account needed. You'll only need accounts at the providers you deploy *to* (for example a free Vercel account, and maybe a database provider), where your app actually lives. Those are also free to sign up for.

**Is there a hosted version so I don't have to install anything?**

**Not yet.** A hosted Beam Me Up server — where you'd connect to a web address instead of running it on your own machine — is planned but **not live**. There is no public address to point to today, so for now follow the [Get started](#get-started) steps, which run it on your own computer. (If you're a developer and see a `<beam-me-up-host>` placeholder later on this page, that's exactly this not-yet-live option — a placeholder, not a working address.)

**Is it safe? Will it change my code or leak my secrets?**

Beam Me Up only changes files when you confirm it — for example, moving a hardcoded password out of your code and into a safe `.env` file. Its review tools run locally and don't phone home; the only time it contacts a provider is to actually deploy or create a database, using the tokens you provided. Secrets it finds are shown masked, never printed back out in plain text. The deeper version of how it stays hands-off is in [How it works](#how-it-works).

---

## Set up your provider keys

Beam Me Up reads each key from your environment when — and only when — it needs it. Nothing is required for the code-review steps; you only add a provider's key when you actually deploy to it or provision from it. Create just the keys for the services you want to use. Each link below takes you to the page where you generate that provider's key; copy it and `export` it in the terminal where Claude runs (or add it to your client's MCP env config).

```bash
# To deploy your app to Vercel (most common starting point)
export VERCEL_TOKEN=…            # https://vercel.com/account/tokens
export VERCEL_TEAM_ID=team_…     # optional; only if your project lives under a Vercel Team

# To deploy to DigitalOcean App Platform instead
export DIGITALOCEAN_TOKEN=dop_v1_…   # https://cloud.digitalocean.com/account/api/tokens

# To give your app a database
export NEON_API_KEY=neon_…       # Postgres → Neon: https://console.neon.tech/app/settings/api-keys
export UPSTASH_EMAIL=you@…       # Redis → Upstash: https://console.upstash.com/account/api
export UPSTASH_API_KEY=…
```

If a key is missing when it's needed, the tool stops and tells you exactly which variable to set — it won't guess or fail silently.

---

## Connecting other AI tools

The [Get started](#get-started) steps use Claude Code, but Beam Me Up is a standard MCP server, so other MCP-aware tools (like Cursor) can use it too. Point your client at the same stdio entry point you registered in step 2:

```
npx tsx "$PWD/packages/server/src/server/stdio.ts"
```

Consult your tool's docs for where to add an MCP server (Cursor has an "Add MCP server" screen in its settings); the command above is the one to give it. Once connected, open a project and say **beam me up** (or invoke the `beam_me_up` prompt).

Prefer to run it as a local HTTP service instead of stdio? See [Self-hosting the HTTP server](#self-hosting-the-http-server).

---

## For developers

Everything below is the technical reference: the orchestration flow, the tools, the deploy targets and databases, the security model, how to run it as a shared HTTP API, the repo layout, and development. Nothing above this line is required reading to use the tool; nothing below changes how the basic "beam me up" experience works.

### What happens when you say "beam me up"

When you say "beam me up", the host AI (Claude Code / Cursor) works through this ordered plan, calling the server's tools and asking you to confirm anything risky:

1. **Check credentials** — which providers are usable (`check_credentials`).
2. **Inventory the repo** — read the files (host AI's own tools).
3. **Review** — `preflight_scan` returns the detected stack (frontend / backend / databases), hardcoded secrets (masked) with a gitignored-`.env` migration plan, access-control + login findings, and a build/run plan. `review_code` adds a deeper vulnerability pass.
4. **Apply fixes** — move secrets into `.env`, address findings; if there's no login, the host AI offers to add Google sign-in (`scaffold_auth`).
5. **Route** — `route_target` decides Vercel (serverless) vs a container host (DigitalOcean); `validate_compose` validates/generates a `docker-compose.yml` when needed.
6. **Provision** — `provision_database` creates a managed Postgres (Neon) or Redis (Upstash) and returns its connection-string env vars.
7. **Deploy** — `create_deploy_target` → `set_env_vars` → `deploy` → `get_deploy_logs`, on Vercel or DigitalOcean App Platform.
8. **Hand off** — `write_todo` produces a `TODO.md` ship checklist; the host AI prints the live URL.

You can also call any tool directly ("review this repo", "provision a Postgres DB", "add Google login") — the plan is just the default end-to-end path.

### The tools

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

### Integrations

What it can deploy to today:

| Kind | Supported |
| --- | --- |
| **Hosting** | **Vercel** (serverless) · **DigitalOcean App Platform** (containers) |
| **Databases** | **Neon** (Postgres) · **Upstash** (Redis) |
| **Container registries** | DigitalOcean Container Registry (DOCR) · Docker Hub · GitHub Container Registry (GHCR) |
| **App auth** | Google sign-in scaffolding for the deployed app (Next.js / Express) |

`route_target` chooses Vercel vs a container host automatically. See [Deploy targets](#deploy-targets) and [Databases](#databases) for the details.

### Configuration

All credentials are read from the environment of the process that launches the server, and only when the relevant tool is called. Export them in the shell that starts the MCP server (or your client's MCP env config). Nothing is needed for the pure analysis tools. The full list and where to get each key is in [Set up your provider keys](#set-up-your-provider-keys) above:

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

If a required token is unset, the tool returns a clear error naming the variable to set rather than attempting a call.

### Deploy targets

The deploy tools (`create_deploy_target`, `set_env_vars`, `deploy`, `get_deploy_logs`) work for both providers behind one pluggable adapter; pass `provider: "vercel"` or `provider: "digitalocean"`.

**Vercel** (serverless). `deploy` does a two-phase upload: SHA-hash and upload each file, then create the deployment. The host AI passes the files to ship as `{ path, content | contentBase64 }`. Returns the live URL + a normalized status.

**DigitalOcean App Platform** (containers). An app is one spec holding the image and env vars. The host AI builds and pushes the image itself (use `build_image_plan` for the exact `docker buildx --platform linux/amd64 … --push` recipe), then `deploy` references it as `image` (DOCR / Docker Hub / GHCR). `create_deploy_target` is **idempotent** — re-running "beam me up" on an existing app just redeploys.

### Databases

`provision_database` creates a managed database and returns the connection-string env vars to feed straight into `set_env_vars`:

- **`engine: "postgres"` → Neon** — `DATABASE_URL` (pooled) + `DATABASE_URL_UNPOOLED` (direct). Needs `NEON_API_KEY`.
- **`engine: "redis"` → Upstash** — `REDIS_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`. Needs `UPSTASH_EMAIL` + `UPSTASH_API_KEY`.

The connection strings are returned so the host can wire them up; treat the tool output as sensitive (don't log it).

### Security & login review

`preflight_scan` and `review_code` are pure, best-effort **heuristic** reviews — useful pre-deploy hygiene, not a full SAST/pentest:

- **Secrets** — hardcoded credentials (private keys, cloud/provider keys incl. Google OAuth client secrets, connection strings, JWTs) are flagged with the value **masked**, plus a `.env` migration plan (what to write, gitignore, and the `process.env` replacements).
- **Access control** — wildcard CORS, missing auth middleware, unguarded `/admin` routes, debug-on, weak/committed framework secrets, and (in `mode: "internal"`) a missing `ALLOWED_EMAILS` / `ALLOWED_DOMAIN` allowlist.
- **Login** — a positive `auth` read: whether login is implemented, the detected mechanisms/providers, a confidence, and the signals behind it. When there's no login but the app serves requests, the plan offers to add **Google sign-in** via `scaffold_auth`, which returns the dependencies, env vars, OAuth redirect URIs, and files to write — tailored to Next.js (Auth.js), Express (passport-google-oauth20), or a generic fallback.

Dependency CVE scanning stays the host AI's job (e.g. `npm audit`).

### Self-hosting the HTTP server

The download-and-connect steps in [Get started](#get-started) use the **stdio** transport — a direct local pipe, the simplest setup, which needs no auth. If you'd rather run Beam Me Up as an HTTP service, you have two options.

**Local HTTP (loopback, for development).** Requires Node.js 20+ and npm.

```bash
npm run dev:http     # serves http://127.0.0.1:3000/mcp (loopback, no-auth dev)
claude mcp add --transport http beam-me-up-http http://localhost:3000/mcp
```

The local HTTP server is loopback-only (reachable only from your own machine) and unauthenticated by default; to expose it to others, harden it as described in [Running it as a shared API](#running-it-as-a-shared-api).

Already ran `npm run build`? You can launch the stdio server from the compiled output instead of the TypeScript source:

```bash
claude mcp add beam-me-up -- node "$PWD/packages/server/dist/server/stdio.js"
```

**Hosted HTTP (coming soon).** A public hosted endpoint is planned but **not live yet**, so there is no working URL to point at today. (An *endpoint* here just means the web address your AI talks to.) When it ships, connecting will look like this — the `<beam-me-up-host>` part is a placeholder for the real address, which doesn't exist yet, so this command won't work until then:

```bash
# Not available yet — <beam-me-up-host> is a placeholder, not a working address.
claude mcp add --transport http beam-me-up https://<beam-me-up-host>/mcp
```

The hosted server will require a **bearer token** (a password-like key) set as an `Authorization` header in your client's MCP config. Either way, deploys still use *your* provider tokens — see [Configuration](#configuration).

### Running it as a shared API

The stdio transport is local by construction. The HTTP transport can drive real deploys, so it's hardened for exposure:

- Binds **`127.0.0.1` by default**; set `BEAM_HTTP_HOST` (e.g. `0.0.0.0`) to expose it — but it then **refuses to start without OAuth** unless you set `BEAM_HTTP_ALLOW_INSECURE=1`.
- The `/mcp` endpoint validates the `Host`/`Origin` headers (DNS-rebinding protection); allowlist extra ones via `BEAM_HTTP_ALLOWED_HOSTS` / `BEAM_HTTP_ALLOWED_ORIGINS`.

**OAuth.** The server is an OAuth 2.0 **Resource Server**: it verifies bearer tokens an external Authorization Server issued (it does not issue them). When configured, every `/mcp` request needs a valid `Authorization: Bearer <token>` (401/403 with `WWW-Authenticate`), and RFC 9728 protected-resource metadata is published at `/.well-known/oauth-protected-resource`. Tokens are verified with `node:crypto` (HS256 or RS256, alg-confusion guarded; `exp`/`nbf`/`iss`/`aud` checked). OAuth turns on as soon as an issuer, audience, and key are set:

```bash
export OAUTH_ISSUER=https://your-auth-server.example.com   # must equal the token `iss`
export OAUTH_AUDIENCE=beam-me-up                           # must appear in the token `aud`
# one key:
export OAUTH_JWT_SECRET=…                                  # HS256 shared secret, or
export OAUTH_JWT_PUBLIC_KEY="$(cat as-public-key.pem)"     # RS256 static PEM, or
export OAUTH_JWKS_URI=https://your-auth-server.example.com/oauth2/jwks  # RS256 via JWKS
# optional:
export OAUTH_RESOURCE_URL=https://beam.example.com/mcp     # default http://localhost:$PORT/mcp
export OAUTH_REQUIRED_SCOPES="deploy"                      # space/comma-separated; default none
```

To run it as a **remote connector** users add in Claude (like the GitHub/Mixpanel
connectors), point a managed MCP-native identity provider (e.g. WorkOS AuthKit)
at this resource and set `OAUTH_JWKS_URI` to its JWKS endpoint — Beam fetches and
caches the rotating signing keys by `kid` rather than pinning a static PEM. A
`Dockerfile` is included; the container binds `0.0.0.0` and refuses to start
without OAuth, and exposes `GET /healthz` for a load-balancer probe.

### How it works

The server is **pure**: it never touches your filesystem or the network for analysis. The host AI (Claude / Cursor) reads and writes your files with its own tools and passes the contents in; only the deploy/provision tools make real provider API calls, reading their tokens from the environment. Secrets are never echoed back.

That design is why the review steps are safe to run on any repo, and why connecting is just adding an MCP server: the analysis tools can't reach out anywhere, and the only tools that touch the outside world are the ones that deploy or provision — and those run on *your* keys, with your confirmation. Your code never leaves your machine except when you explicitly deploy.

### Project layout

An npm-workspaces monorepo under `packages/*`. Each package is a real `@beam-me-up/<name>` package; the dependency graph is a clean DAG:

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

`route_target` + `preflight_scan` live in **detect** (not tools): they're pure repo-analysis, and that placement keeps the `adapters → tools` graph acyclic.

### Design notes

- **Vercel-first, DigitalOcean fallback.** `route_target` picks a container host only when the repo needs a long-lived process (websockets, workers, multiple services, long handlers, persistent disk, or an always-on listener). A bare `Dockerfile` isn't decisive. On container/low-confidence outcomes the plan tells the host AI to **ask the user**.
- **Nothing hard-blocks shipping.** Ship-checklist items (rotate secrets, register OAuth, …) are surfaced as `blocking: false` reminders.

### Development

```bash
npm run typecheck    # tsc --noEmit -p tsconfig.json
npm run build        # tsc -b tsconfig.solution.json -> per-package dist/
npm test             # in-memory MCP client smoke test
```

The suites under `test/` are all **offline** — provider APIs are mocked (and the mocks fail loudly if any request escapes to a real host) or pure. Dev and tests run straight off the TypeScript sources via `tsx`; `npm run build` does a project-references `tsc -b` to per-package `dist/`.

```bash
npm run test:m1   # Vercel deploy tools (mocked)
npm run test:m2   # database provisioning, Neon/Upstash (mocked)
npm run test:m3   # preflight_scan (pure)
npm run test:m4   # DigitalOcean deploy tools (mocked)
npm run test:m5   # HTTP transport + OAuth (pure crypto + ephemeral-port server)
npm run test:m7   # review_code (pure)
npm run test:m8   # login detection + scaffold_auth + HTTP hardening (pure)
```

/**
 * renderBeamMeUpPlan - returns the ordered, numbered orchestration plan the
 * host AI follows (markdown string) with [HOST-AI] / [MCP-TOOL: <name>] /
 * [CONFIRM] tags.
 *
 * This is the script the connected agent (Claude Code / Cursor / etc.) reads
 * top-to-bottom to take a repo from "works on my machine" to "live on the
 * internet". In milestone M0 only a subset of the steps are backed by real
 * MCP tools; the rest are described so the agent knows what is coming and can
 * still drive the live portions today.
 *
 * Tag legend used throughout the plan:
 *   [HOST-AI]          - the host agent does this itself using ITS OWN tools
 *                        (file read/write/search, shell, git). The MCP server
 *                        is pure and never touches the filesystem or network.
 *   [MCP-TOOL: <name>] - call this Beam Me Up MCP tool with the noted input.
 *   [CONFIRM]          - stop and get explicit user confirmation before
 *                        continuing.
 *
 * Each future step is also tagged "(coming soon)" so the agent does not try to
 * call a tool that does not exist yet in M0.
 */

/**
 * Tools that are live and callable today: the M0 decision/generation tools, the
 * M3 preflight_scan, and the deploy tools (create_deploy_target / set_env_vars /
 * deploy / get_deploy_logs). The deploy tools are LIVE for both providers —
 * vercel (M1) and digitalocean (M4, App Platform container-image deploys).
 */
const LIVE_TOOLS = [
  "check_credentials",
  "list_connections",
  "build_image_plan",
  "preflight_scan",
  "review_code",
  "scaffold_auth",
  "route_target",
  "validate_compose",
  "write_todo",
  "create_deploy_target",
  "set_env_vars",
  "deploy",
  "get_deploy_logs",
  "provision_database",
] as const;

export function renderBeamMeUpPlan(args: {
  goal?: string;
  mode?: "product" | "internal";
}): string {
  const goal = args.goal?.trim();
  const mode = args.mode ?? "product";
  const isInternal = mode === "internal";

  const goalLine = goal
    ? `**Goal (from the user):** ${goal}`
    : `**Goal (from the user):** _not specified — ask the user what they want shipped, in one sentence, before you begin._`;

  const modeLine = isInternal
    ? `**Mode:** \`internal\` — this app is for a known set of people (a team / your own account), NOT the public. You MUST lock access down to an allowlist (see step 13).`
    : `**Mode:** \`product\` — this app is meant for real end users. Default to public sign-in with proper OAuth, but never leave secrets or admin routes exposed.`;

  return `# Beam Me Up — orchestration plan

You are the host AI assistant connected to the **Beam Me Up** MCP server. Your
job is to take the user's project from local code to a live, reachable URL by
following the numbered steps below **in order**.

${goalLine}
${modeLine}

---

## How to read this plan

- **[HOST-AI]** — do it yourself with your OWN tools. The Beam Me Up MCP server
  is **pure**: it has no filesystem access and makes no network calls. So every
  time you need to *read* a repo file, *write* a file (TODO.md, docker-compose.yml,
  auth scaffolding, env files), run a shell command, or use git, **use your own
  built-in tools** — do not expect an MCP tool to do file or network I/O.
- **[MCP-TOOL: name]** — call that Beam Me Up tool. Pass it the data you gathered
  yourself ([HOST-AI]); the tool returns a decision or generated text, which you
  then act on. Pass tool output back into the next step.
- **[CONFIRM]** — pause and get the user's explicit go-ahead before proceeding.
  Never deploy, rotate secrets, or change access policy without confirmation.

### How to render a tool RESULT (the result-envelope contract)

Beam is an MCP server: it returns *tool results*, not UI. Every credentialed
tool result carries a top-level **\`status\`** discriminator — \`ok\`,
\`needsConnect\`, \`needsConfirmation\`, or \`error\` — and every non-\`ok\` result
carries a server-owned **\`host\`** block (\`speak\` + \`buttons\`).

**Host-AI rendering rule:** *If a tool result has a \`host\` block, render
\`host.speak\` VERBATIM as a chat message and each \`host.buttons[i]\` as a tappable
button. Do NOT show the raw \`error\` string. Do NOT invent next steps — a
button's \`action\` is the entire path forward. Branch ONLY on \`status\`:*
- \`status: "ok"\` — the side effect happened (or the read succeeded). Surface the
  success copy and any \`costSoFar\`.
- \`status: "needsConnect"\` — the user has no usable connection for a provider.
  Speak the pre-framing first, then open the Connect button's URL; re-call the
  original tool (\`resumeHint: "autoProbe"\`) so the chat resumes automatically.
- \`status: "needsConfirmation"\` — a create/change is gated. STOP and ask: render
  the two buttons and DO NOT proceed until the user taps the "Yes" button (which
  re-invokes the SAME tool with the SAME args plus the \`confirmToken\`). A
  creating/mutating tool without a valid \`confirmToken\` performs NO side effect.
- \`status: "error"\` — a genuine failure; render \`host.speak\` + buttons.

**Transport-layer failures (HTTP 401 / 503, no \`host\` block).** A few failures
happen at the connection layer BEFORE any tool runs, so they carry only an HTTP
status + a short \`error_description\` and NO \`host.speak\`. Speak these in plain,
reassuring language and NEVER repeat machine words (vault, token, subject,
server). For a **503**: say it's a brief hiccup on our end, the user's app and
accounts are safe and nothing was charged, and offer a single **"Try again"**.
For a **401** (we couldn't verify their sign-in): ask them to sign in again; if it
keeps failing after a couple of tries, tell them it's on us, STOP retrying, and
point them to support rather than looping forever.

**Free-tier promise (standing rule):** at the roadmap, before EACH hand-off, and
on success, reassure the user that this is free — Beam only ever uses free tiers
and warns them long before anything could cost money. Before each browser
hand-off add: *"On the next screen, ignore anything about paid plans or upgrades
— always pick the free option. We'll never put you on a paid plan."* Keep
\`costSoFar: "$0"\` visible on confirm + success.

### Live now vs. coming later

The **deploy path is real, end to end, for BOTH providers**: create the target,
set env vars, deploy, and read build logs are all live MCP tools — \`vercel\`
(M1) and \`digitalocean\` (M4, App Platform container-image deploys).

- **LIVE now** — the \`beam_me_up\` prompt (this plan) and these MCP tools:
  ${LIVE_TOOLS.map((t) => `\`${t}\``).join(", ")}.
  - \`create_deploy_target\`, \`set_env_vars\`, \`deploy\`, and \`get_deploy_logs\`
    are **live for \`provider: "vercel"\` and \`provider: "digitalocean"\`**.
    Vercel reads \`VERCEL_TOKEN\` (+ optional \`VERCEL_TEAM_ID\`); DigitalOcean
    reads \`DIGITALOCEAN_TOKEN\`. If the relevant token is unset the tool returns
    a clear error asking you to set it. The two providers differ at \`deploy\`:
    Vercel uploads local \`files\`, DigitalOcean deploys a registry \`image\`
    (see step 10).
  - \`scaffold_auth\` is **live** — when \`preflight_scan\`'s \`auth\` shows the app
    has no login, it generates a ready-to-apply **Google sign-in** scaffold
    (step 14). Like the other pure tools it returns files/steps; you write them.
- **Every step in this plan is backed by a real tool** — there are no
  "coming soon" placeholders left to fall back from.

---

## The plan

### 0a. [HOST-AI] Show the roadmap FIRST — **LIVE**
The FIRST time the user asks to ship (e.g. "beam me up"), BEFORE any tool call,
say in their words: *"Getting your app online takes about 2–3 minutes and is
completely free. Here's the whole plan: we'll connect where your code lives,
where your app runs, and (when it's ready) your database — I'll confirm exactly
where everything goes before I create anything, and walk you through each step.
Ready?"* Offer a **[Let's go]** button. Then keep a visible checklist —
**☐ Code storage ☐ Hosting ☐ Database** — and tick a box on each connect (the
\`progress\` object on every needsConnect / recovery / resume result drives the
"N of 3" tally). This is the single anti-abandonment lever for the mid-chat
Connect hand-offs.

### 0. [MCP-TOOL: check_credentials] What can we actually ship with? — **LIVE**
Call **\`check_credentials\`** FIRST (no input) for cheap HOST ROUTING +
progress. It returns booleans for \`vercel\` / \`digitalocean\` / \`neon\` /
\`upstash\`, a \`connections[]\` rollup, a \`progress\` tally, and (per-user) a
\`host\` directive — values are never echoed.

For anything the USER sees (showing accounts, switching where the app goes), call
**\`list_connections\`** instead: it returns plain status lines (GitHub, Vercel,
DigitalOcean, your database, your cache) with connect/switch/disconnect actions
— never internal IDs or developer terms.
- Use it to **route around gaps before doing expensive work.** If the provider
  you'd route to (or the DB you'd provision) is in \`missing\`, tell the user
  up front which env var to set (e.g. \`DIGITALOCEAN_TOKEN\`, \`NEON_API_KEY\`)
  and either pause for it or fall back to the provider's CLI (\`doctl\`,
  \`vercel\`, \`neonctl\`) — don't discover the gap after you've built an image.
- The pure analysis steps (1–6) work with zero credentials, so you can still
  preflight + route while waiting on tokens.

### 1. [HOST-AI] Inventory the repo
Use your own file tools to understand the project before touching anything.
- List the file tree; read \`package.json\` (or \`pyproject.toml\` / \`go.mod\` / etc.).
- Identify the **stack/framework** (Next.js, plain Node/Express, Vite SPA, Python,
  etc.), the start command, the build command, and the listening port (if any).
- Note the presence of: \`Dockerfile\`, \`docker-compose.yml\`/\`compose.yaml\`,
  \`.env\`/\`.env.example\`, websocket servers, background workers/queues, cron jobs,
  long-running request handlers, and any code that writes to the local filesystem.
- Note any **databases / caches** the app expects (Postgres, MySQL, Mongo, Redis).
- You do NOT have to assemble \`RepoSignals\` by hand: **\`preflight_scan\`
  (step 2) derives the \`signals\`, \`services\`, and \`stack\` for you** from the
  files you read. Gather the file list + contents and pass them in next.

### 2. [MCP-TOOL: preflight_scan] Review security + functionality — **LIVE**
Pass the repo files you read as \`{ files: [{ path, content }], mode: "${mode}" }\`.
\`preflight_scan\` is **pure** (no filesystem/network) and returns a full read of
the repo:
- \`signals\` + \`services\` + \`stack\` (frontend / backend / databases / languages,
  plus Dockerfile/compose paths) — **reuse these for \`route_target\` (step 5) and
  \`validate_compose\` (step 4)** instead of deriving them yourself.
- \`secrets\` — hardcoded credentials found in source (the value is **masked**;
  the tool never echoes a full secret), each with a \`suggestedEnvKey\` and severity.
- \`envPlan\` — the \`.env\` migration: \`envFileContent\` (real values, for the
  gitignored \`.env\` you write locally), \`envExampleContent\`, \`gitignoreAdditions\`
  (e.g. \`.env\`), and \`replacements\` (swap each inline literal for the env reference).
- \`accessControl\` — heuristic security-posture findings (CORS wildcard, missing
  auth, debug enabled, missing allowlist for internal mode, …).
- \`auth\` — a positive login read: \`loginImplemented\`, the detected
  \`mechanisms\`/\`providers\`, a \`confidence\`, the \`signals\` behind it, and
  \`offerGoogleAuth\`. When \`offerGoogleAuth\` is true (no login but the app serves
  requests), **offer the user Google sign-in in step 14**.
- \`build\` — the detected install/build/test/start commands + ordered
  \`instructions\` to verify the app builds and runs **before** deploying.
- \`securityFollowups\` + \`instructions\` + \`summary\` — feed \`securityFollowups\`
  straight into \`write_todo\` (step 12).
- \`notProvided\` — relevant files the scan did NOT receive (e.g. \`.gitignore\`),
  each with the finding it leaves unverified. The scan's quality depends on the
  files you pass, so for a faithful result include the \`.gitignore\`, the
  manifest (\`package.json\` / \`pyproject.toml\` / …) and lockfile — then **pass
  the missing files and re-run** to clear the gap.
- \`mode\` (\`"${mode}"\` here): \`internal\` additionally flags a missing
  \`ALLOWED_EMAILS\`/\`ALLOWED_DOMAIN\` allowlist; \`product\` does not.

### 3. [CONFIRM] Apply the secret → .env migration + fixes
Using \`preflight_scan\`'s \`envPlan\` and findings, propose the concrete edits to
the user and get a yes before applying:
- [HOST-AI] write the gitignored \`.env\` (from \`envFileContent\`) and a committed
  \`.env.example\` (from \`envExampleContent\`), add \`gitignoreAdditions\` to
  \`.gitignore\`, and apply each \`replacements\` entry (swap the inline secret for a
  \`process.env.X\` reference). **Never auto-rotate a secret without confirmation**;
  any already-committed secret must be rotated (track it in \`securityFollowups\`).
- Address (or defer to the ship checklist) the high-severity \`accessControl\`
  findings. Run the \`build.instructions\` to confirm the app still builds + runs.
- **Deeper code review:** for a fuller security pass beyond \`preflight_scan\`'s
  posture checks, call **\`review_code\`** with \`{ files }\`. It returns
  prioritised \`findings\` (XSS, SQL/command injection, error info-disclosure,
  disabled TLS verification, missing auth/headers/rate-limit, eval, weak crypto,
  open redirect) each with a concrete \`recommendation\`. [HOST-AI] apply the
  recommendations with your own file tools and **[CONFIRM]** anything risky (auth
  changes, dependency additions) with the user before applying.

### 4. [MCP-TOOL: validate_compose] Validate or generate docker-compose
Decide whether this project needs container orchestration (multiple services,
its own database, a websocket/worker process).
- If a compose file exists: [HOST-AI] read its contents, then call
  **\`validate_compose\`** with \`{ composeYaml }\`. It checks structure (top-level
  \`services\` map, each service has \`image\` or \`build\`) and warns about missing
  healthchecks / \`depends_on\` on database services.
- If no compose file but you detected services in step 1: call
  **\`validate_compose\`** with \`{ detectedServices }\`. It will generate a valid
  \`docker-compose.yml\` (app + db/cache with healthchecks, \`depends_on:
  { condition: service_healthy }\`, named volumes, port mappings, \`env_file: [.env]\`).
- Take the returned \`composeYaml\` and, if the user wants it, [HOST-AI] write it
  to disk yourself. Surface any \`errors\`/\`warnings\` to the user.

### 5. [MCP-TOOL: route_target] Choose where to deploy
Gather the repo signals from step 1 into a \`RepoSignals\` object and call
**\`route_target\`** with \`{ stack, services, signals }\`.
- It returns \`target\` (\`"vercel"\` | \`"container"\`),
  \`recommendedProvider\` (\`"vercel"\` | \`"digitalocean"\`), a \`confidence\` in
  [0,1], and human-readable \`reasons[]\`.
- Routing is **Vercel-first**: stateless web/edge apps go to Vercel. Anything that
  needs a long-lived process — websockets, background workers, >1 app service,
  long-running handlers, persistent filesystem writes, or a long-lived port
  listener — routes to a **container** host (DigitalOcean fallback). A bare
  \`Dockerfile\` alone does NOT force a container.
- Always show the user the \`reasons[]\` and the \`confidence\`.

### 6. [CONFIRM] Confirm the deploy target
- If \`target === "container"\` **or** \`confidence\` is low (mixed/ambiguous
  signals): **stop and ask the user** to choose between **Vercel** and
  **DigitalOcean**, presenting the tradeoffs from \`reasons[]\`. Use their choice.
- If \`target === "vercel"\` with high confidence: state your recommendation and
  proceed unless the user objects.
- Lock in the chosen \`DeployTargetId\` (\`"vercel"\` or \`"digitalocean"\`) — you will
  pass it to \`write_todo\` in step 12.

### 7. [MCP-TOOL: provision_database] Provision the database — **LIVE (Neon / Upstash)**
Headlessly creates a managed database and returns its connection-string env
vars. Call **\`provision_database\`** with \`{ engine, name, region? }\`:
- \`engine: "postgres"\` provisions **Neon** (needs \`NEON_API_KEY\`). It returns
  \`envVars\` with a pooled \`DATABASE_URL\` plus a direct \`DATABASE_URL_UNPOOLED\`.
- \`engine: "redis"\` provisions **Upstash** (needs \`UPSTASH_EMAIL\` +
  \`UPSTASH_API_KEY\`). It returns \`envVars\` with \`REDIS_URL\`,
  \`UPSTASH_REDIS_REST_URL\` and \`UPSTASH_REDIS_REST_TOKEN\`.
- It returns \`{ provider, resourceId, envVars }\`. **Take \`envVars\` straight
  into \`set_env_vars\` (step 9)** so the app can reach its database. Credentials
  are never echoed back; if a required env var is unset the tool returns a clear
  error naming it.
- **TLS gotcha when wiring \`DATABASE_URL\` into a Node \`pg\` app:** a modern
  \`pg\` client treats \`sslmode=require\` strictly and can reject a managed-PG
  self-signed CA ("self-signed certificate in certificate chain"). Neon's URL
  uses a real CA so it works as-is; for a self-hosted / DigitalOcean managed
  Postgres, use the provider's CA cert or set the client
  \`ssl: { rejectUnauthorized: false }\` (\`sslmode=no-verify\`).
- Other engines (MySQL/Mongo) are not wired in M2: the tool returns "M2 supports
  postgres (Neon) and redis (Upstash) only." For those, use the manual fallback
  ([HOST-AI] + user): create the DB in the provider dashboard and capture the
  (pooled/private) connection string for the env step.

### 8. [MCP-TOOL: create_deploy_target] Create the deploy target — **LIVE (Vercel + DigitalOcean)**
Use the \`provider\` you confirmed in step 6. Call **\`create_deploy_target\`**
with \`{ provider, projectName, framework? }\`.
- \`provider: "vercel"\` creates a Vercel project (needs \`VERCEL_TOKEN\`,
  optional \`VERCEL_TEAM_ID\`). \`provider: "digitalocean"\` creates (or, if one
  with that name already exists, reuses) a DigitalOcean App Platform app (needs
  \`DIGITALOCEAN_TOKEN\`). If the relevant token is unset the tool returns an
  error telling you to set it.
- It returns \`{ provider, targetId, dashboardUrl }\`. **Keep \`targetId\`** — you
  pass it to \`set_env_vars\` (step 9) and \`deploy\` (step 10).

### 9. [MCP-TOOL: set_env_vars] Set environment variables — **LIVE (Vercel + DigitalOcean)**
Pushes the required env vars (DB URL, OAuth client id/secret, app secrets,
\`ALLOWED_EMAILS\`/\`ALLOWED_DOMAIN\`) onto the target.
- [HOST-AI] gather the needed variables from \`.env.example\` and \`preflight_scan\`,
  marking which are secrets. Then call **\`set_env_vars\`** with
  \`{ provider, targetId, vars: [{ key, value, secret?, targets? }] }\`. Secrets
  are stored as sensitive/encrypted values. Vars are upserted (on DigitalOcean
  they are merged into the app spec).
- It returns \`{ setCount, applied }\`. **Never print secret values back to the
  chat** — only confirm the \`applied\` key names.

### 10. [MCP-TOOL: deploy] Deploy — **LIVE (Vercel + DigitalOcean)**
The deploy *source* depends on the provider:
- **Vercel** — [HOST-AI] read the files to ship from disk and pass them as
  \`files\` (\`{ path, content }\` for text, or \`{ path, contentBase64 }\` for
  binary): \`deploy { provider: "vercel", targetId, projectName, framework?,
  files, target? }\`.
- **DigitalOcean** — [HOST-AI] build + push the image yourself, then
  \`deploy { provider: "digitalocean", targetId, projectName, image }\`. The
  build/push is the single most error-prone step, so do it precisely:
  - **Registry name (DOCR):** get it with \`doctl registry get\` — its
    \`Endpoint\` is \`registry.digitalocean.com/<name>\`, so the image ref is
    \`registry.digitalocean.com/<name>/<repo>:<tag>\`. Pin a real \`<tag>\` (a
    version or git SHA), **not \`latest\`**, so redeploys are reproducible.
  - **Get the exact recipe from the tool:** call **\`build_image_plan\`** with
    \`{ repository, registry?, tag? }\` — it returns the ordered \`commands\`
    (\`doctl registry login\`, \`docker buildx build --platform linux/amd64 …
    --push\`), the \`prerequisites\` to check (docker daemon, buildx, registry
    auth), and \`warnings\` (the linux/amd64 footgun). Run those commands.
  - Then \`deploy { provider: "digitalocean", targetId, projectName, image: "<ref>" }\`.
    DO pulls + rolls it out (it does not accept uploaded files); \`image\` may be a
    DOCR / Docker Hub / GHCR ref.
  - **If the app uses a managed database, bind it** so DigitalOcean auto-manages
    the firewall: attach the DB as an app component (\`databases:\` section +
    reference \`\${db.DATABASE_URL}\` in the env) instead of a raw \`DATABASE_URL\`
    secret. A raw secret leaves the cluster's **trusted sources** manual — the app
    cannot reach the DB until you add it by hand.
- It returns \`{ deploymentId, url?, status }\`. Capture the **live URL** and the
  \`deploymentId\` (you need it for step 11). The initial status is
  queued/building; use \`get_deploy_logs\` to follow the build to ready or error.

### 11. [MCP-TOOL: get_deploy_logs] Read deploy logs — **LIVE (Vercel + DigitalOcean)**
Reads build logs so you can confirm success or diagnose a failed deploy. Call
**\`get_deploy_logs\`** with \`{ provider, deploymentId, type?: "build"
| "runtime" }\` (build is the focus; runtime logs are limited).
- It returns \`{ status, logText, summary? }\`. If \`status\` is \`error\`, read
  \`summary\`/\`logText\`, fix the problem with your own [HOST-AI] tools, and
  redeploy (back to step 10).

### 12. [MCP-TOOL: write_todo] Generate TODO.md + ship checklist
Now produce the user's handoff document. Call **\`write_todo\`** with:
\`{ stack, target, authNeeded, mode: "${mode}", databases?, manualItems?, securityFollowups?, liveUrl? }\`
- \`target\` = the \`DeployTargetId\` confirmed in step 6.
- \`authNeeded\` = true if the app has (or should have) sign-in.
- \`databases\` = the engines from \`preflight_scan\`'s \`stack.databases\` (e.g.
  \`["postgres"]\`). The checklist + Operate notes tailor to this — DB connection
  string, the managed-PG TLS footgun, and (on DigitalOcean) the trusted-sources
  binding only appear when a database is present. The checklist is now tailored:
  OAuth only when \`authNeeded\`, the allowlist only for internal mode, etc.
- \`securityFollowups\` = the list you accumulated in steps 2–3.
- \`liveUrl\` = the URL from step 10 if you have one.
- It returns \`todoMarkdown\` (with **Manual setup**, **Security follow-ups**,
  **Ship checklist**, and **Operate** sections) and a structured \`shipChecklist\`.
- [HOST-AI] **write \`todoMarkdown\` to \`TODO.md\` yourself** using your own file
  tools — the MCP tool only returns the text, it does not write the file.

### 13. ${
    isInternal
      ? `[HOST-AI] Lock the allowlist (mode = internal)`
      : `[HOST-AI] Confirm access policy`
  }
${
  isInternal
    ? `Because mode is **internal**, this app must NOT be open to the public:
- Set **\`ALLOWED_EMAILS\`** (explicit list) and/or **\`ALLOWED_DOMAIN\`** (e.g.
  \`@yourcompany.com\`) as environment variables on the deploy target.
- Enforce the allowlist in the auth callback / middleware so any email outside
  it is rejected — locking the allowlist is a **blocking** concern for internal
  apps. Verify a non-allowlisted account cannot get in.
- Make sure these vars are part of step 9's env set, and that "confirm
  ALLOWED_EMAILS/ALLOWED_DOMAIN for the mode" stays on the ship checklist.`
    : `Mode is **product**, so public sign-in is expected. Still confirm with the
user who should be able to access admin-only or privileged routes, and ensure
those are protected. (If you later switch to an internal/team-only app, you must
set \`ALLOWED_EMAILS\`/\`ALLOWED_DOMAIN\` and lock the allowlist.)`
}

### 14. [MCP-TOOL: scaffold_auth] Offer + scaffold Google sign-in — **LIVE**
If \`preflight_scan\`'s \`auth.loginImplemented\` is \`false\` and the app should have
sign-in (\`auth.offerGoogleAuth\` is true, or the user wants login):
- **[CONFIRM] offer it first:** tell the user the app has no login and ask if they
  want **Google sign-in** added. Only proceed on a yes.
- Call **\`scaffold_auth\`** with \`{ provider: "google", framework, stack?, mode: "${mode}", appUrl?, allowedDomain? }\`.
  \`framework\` is \`"nextjs"\` | \`"express"\` | \`"generic"\` (pass it, or pass the
  \`stack\` hint and let it infer). \`appUrl\` = the live URL (for the redirect URI);
  \`allowedDomain\` gates sign-in to a domain in \`internal\` mode.
- It returns \`{ dependencies, envVars, redirectUris, files, steps, warnings }\`.
  [HOST-AI] **write the \`files\` yourself** (action \`create\`/\`merge\`), install
  \`dependencies\`, register the \`redirectUris\` in the Google console, and set the
  \`envVars\` (use \`set_env_vars\` for the deployed app). **[CONFIRM]** the auth
  changes with the user before applying — this adds dependencies and routes.
- If login already exists (\`auth.loginImplemented\` true), skip scaffolding; just
  verify the existing auth is applied to protected routes and (internal mode)
  gated to the allowlist.

### 15. [CONFIRM] Present the ship checklist
Show the user the **Ship checklist** from \`write_todo\` (rendered as markdown
checkboxes). Walk through each item: rotate any committed secrets, register OAuth
app(s), confirm \`ALLOWED_EMAILS\`/\`ALLOWED_DOMAIN\` for the mode, review
RLS/access-control findings, apply outstanding CVE upgrades, set a custom domain
(optional), confirm the pooled/private DB string in prod, and verify no \`.env\` is
tracked in git.
- Nothing here hard-blocks the deploy, but **[CONFIRM]** the user has seen the
  list and knows what is still outstanding before you call it done.

### 16. [HOST-AI] Print the live URL
Finish by clearly printing the **live URL** (from step 10) so the user can open
their shipped app. Restate any remaining unchecked items from the ship checklist
and where TODO.md lives.
${
  isInternal
    ? `- Remind the user the app is locked to the allowlist — only allowlisted
  emails/domain can sign in.`
    : ``
}

---

**Reminder:** for all repository reading, file writing, shell, and git actions,
use your OWN host tools ([HOST-AI]). The analysis/decision/generation tools
(\`preflight_scan\`, \`review_code\`, \`scaffold_auth\`, \`route_target\`,
\`validate_compose\`, \`write_todo\`) are pure and touch nothing — they return
findings/files/text and you apply them.
The deploy tools (\`create_deploy_target\`, \`set_env_vars\`, \`deploy\`,
\`get_deploy_logs\`) DO make real calls to the provider API — Vercel using
\`VERCEL_TOKEN\`, or DigitalOcean App Platform using \`DIGITALOCEAN_TOKEN\`.
`;
}

# Beam Me Up — M9 Non-Technical Experience: UX + Tool-Output Contract Spec

**Status:** Build-ready. Implementer can build straight from this.
**Scope:** The complete non-technical (Sam) experience for Beam Me Up, expressed as concrete **tool-output contracts**, because Beam is an MCP server: it **cannot render UI**. It returns *tool results*; the host AI (Claude) turns the structured result + plain-language strings into chat text and buttons. The only Beam-rendered web surface is the Connect routes (`/connect/:provider` → `/oauth/callback/:provider`) and the `/connections` page.

This document merges two design tracks into one coherent contract:
1. The **destination-confirmation** gate before every create.
2. The **mid-chat Connect round-trip** (`needsConnect` result + pre-framing + browser success-page copy + auto-resume).
3. The **full error-recovery copy deck**, each as a structured tool result, none naming tokens/keys.
4. The **connections surface** (tool + `/connections` page).
5. The **trust / roadmap / progress** layer.

It ends with the exact replacements for today's `Set the X environment variable` messages and a **definition-of-done checklist** tied to the four non-negotiables.

---

## 0. The one shared result envelope

### 0.1 Why this exists

Today every credentialed tool returns either its success output or a flat `{ error: string }` (verified in repo: `deploy-tools.ts:65`, `db-tools.ts:63–68`, `ToolError` from `@beam-me-up/core`). That single flat `error` string is the root cause of developer-speak leaking to Sam (e.g. `Set the VERCEL_TOKEN environment variable…`). We replace the boundary so every credentialed tool can return one of four states, and every non-success state carries server-owned plain-language copy plus button affordances.

### 0.2 The discriminator

Every credentialed tool result carries a top-level **`status`** discriminator:

```ts
type ResultStatus = "ok" | "needsConnect" | "needsConfirmation" | "error";
```

- `status: "ok"` — the side effect happened (or the read succeeded).
- `status: "needsConnect"` — no usable connection for `(subject, provider)`; the user must do the browser Connect round-trip (§2).
- `status: "needsConfirmation"` — a destructive/creating call arrived **without** a valid `confirmToken`; STOP and ask (§1).
- `status: "error"` — a genuine failure. **Only** this state sets `isError: true` on the MCP result.

The host AI branches on `status`. `isError` is set **only** for `status: "error"`.

### 0.3 The `host` directive — copy is server-owned

Every non-`ok` result carries a **`host`** block. This keeps all user-facing copy server-side (single source of truth, lint-testable) while letting the host render it natively.

```ts
type HostButtonAction =
  | { kind: "callTool"; tool: string; args: Record<string, unknown> } // re-invoke a Beam tool
  | { kind: "openUrl"; url: string }                                  // open Connect/connections in browser
  | { kind: "cancel" };                                               // abandon, no tool call

type HostButton = { label: string; action: HostButtonAction };

type HostDirective = {
  speak: string;        // verbatim plain-language string the host surfaces as chat text
  buttons: HostButton[];
  progress?: Progress;  // optional running tally, see §5.2
};

type Progress = { connected: number; total: number; nextRole?: string; label?: string };
```

**Host-AI rendering rule** (also documented in `beam-me-up-plan.ts`): *“If a tool result has a `host` block, render `host.speak` verbatim as a chat message and each `host.buttons[i]` as a tappable button. Do NOT show the raw `error` string. Do NOT invent next steps — a button’s `action` is the entire path forward. Branch only on `status`.”*

### 0.4 The fallback path is unchanged

`status: "needsConnect"` / `needsConfirmation` are only emitted in the **per-user (`ctx` present)** path. In the no-`ctx` self-host/stdio path (a developer running Beam locally with env vars), the existing env-var messages are retained verbatim — that audience *wants* `Set the VERCEL_TOKEN…`. The `ctx`-aware resolver decides which world it’s in.

### 0.5 The copy lint (merge-blocking)

No user-facing string emitted in any `host.speak`, button `label`, `headline`, `reassurance`, `statusLine`, or page-copy field may contain any of:

> *token, env var, environment variable, API key, secret, scope, OAuth, client ID, console.*

This is enforced as a **merge-blocking test** that scans every emitted user-facing field. Provider display names are fixed: **GitHub, Vercel, DigitalOcean** (never “DO”), **your database**, **your cache**.

---

## 1. Destination confirmation — the gate before any create

Maps to `optimalUxFlow` step 7 and the `prioritizedChanges` “MANDATORY plain-language destination confirmation” (must-have-for-launch, all personas). Today `deploy-tools.ts` / `db-tools.ts` contain **zero** account/team/org confirmation logic — they create immediately. This adds an enforced STOP-and-ask phase in front of every mutating call.

### 1.1 Which tools gate, and on what

| Tool | Creates / mutates | Destination label(s) it must echo |
|---|---|---|
| `create_deploy_target` | Vercel project / DO app | hosting account + **team/org** label |
| `provision_database` | Neon project / Upstash DB | DB account label + **free-tier** note |
| `deploy` | live deployment | hosting account + team + repo/project name |
| `set_env_vars` | mutates target config | hosting account + team (lower-stakes; gate once per session — §1.6) |
| `get_deploy_logs` | read-only | **does not gate** |

### 1.2 The stop is enforced server-side, not a host convention

On a creating/mutating call that lacks a valid `confirmToken`, the tool returns `status: "needsConfirmation"` and **does not create**. The host renders `host.speak` + the two buttons and must NOT proceed until the user taps **Yes**. The “Yes” button re-invokes the **same tool with the same args plus `confirmToken`**. The tool performs the side effect **only** when a valid, unexpired, single-use `confirmToken` is present. A `deploy` call without `confirmToken` can therefore *never* create — the gate is structural.

### 1.3 Where the labels come from (never invented by host or args)

Labels are read from the **vaulted connection row** for `(subject, provider)`, resolved by `CredentialContext`. The `provider_connections` row stores, alongside the enveloped token, a non-secret **`account_label`** captured at Connect time (e.g. Vercel `team.name` / `user.username`, GitHub `login` + primary email, Neon project owner). The confirmation tool reads these display labels; it never decrypts or echoes the token. If a provider exposes multiple teams/orgs (Vercel “personal” vs “work”), the row stores the **default selected** team plus the alternatives, so “Use a different account” can be offered without a second round-trip.

### 1.4 `needsConfirmation` result schema

```ts
type DestinationLabel = {
  provider: "vercel" | "digitalocean" | "github" | "neon" | "upstash";
  role: "hosting" | "code" | "database";   // what this destination is FOR, in Sam's terms
  accountLabel: string;     // e.g. "sam@gmail.com" (from vault row, non-secret)
  teamLabel?: string;       // e.g. "Sam's personal" (Vercel team / GitHub org; omit if none)
  freeTier?: boolean;       // true -> host surfaces the "$0 / free tier" reassurance
};

type NeedsConfirmationResult = {
  status: "needsConfirmation";
  tool: string;                     // the tool that will run on confirm, e.g. "deploy"
  actionSummary: string;            // one plain sentence: what will be created
  destinations: DestinationLabel[]; // every place something will be created/changed
  resourceName: string;             // the thing being made, e.g. "recipe-app"
  confirmToken: string;             // opaque, single-use, short-TTL; echoed back on Yes
  confirmTokenExpiresAt: string;    // ISO; host re-requests if expired
  costSoFar: "$0";                  // standing money promise, §5.4
  host: HostDirective;
};
```

### 1.5 `confirmToken` constraints

HMAC-signed with the server key; **single-use** (consumed when the create succeeds); TTL ≤ 10 min; **bound to `(subject, tool, hash(args), destinations)`**. A token minted for one `(subject, args, destination)` cannot authorize a different create — a stale “Yes” can never deploy to a destination Sam didn’t see. If expired, the tool re-emits `needsConfirmation` with a fresh token.

### 1.6 Per-user persisted target + re-confirm-on-change

After the first confirmed deploy, the chosen destination is persisted per `(subject, app)` (the `prioritizedChanges` “persist the chosen target per user” requirement). Subsequent same-app, same-destination operations within a session **skip** confirmation (no nagging). The gate **re-triggers** when: (a) the resolved destination label differs from the persisted one, (b) a new provider is involved, or (c) it’s a fresh session and the action is a *create* (deploy/provision) rather than a benign re-run. `set_env_vars` against an already-confirmed target does **not** re-gate.

### 1.7 Confirmation copy (host renders `host.speak` verbatim)

**Canonical combined deploy + DB confirm (the Sam case, `optimalUxFlow` step 7):**

> `speak`: “Quick check before I create anything: I’ll put your app live on your **Vercel** account under the team **“Sam’s personal”**, and save your code to **GitHub** (**sam@gmail.com**) as a new private project **“recipe-app”**. Your database is on the **free tier** — \$0. Nothing’s been created yet. Look right?”
>
> buttons:
> - **“Yes, deploy”** → `callTool { tool: "deploy", args: { …original…, confirmToken } }`
> - **“Use a different account”** → `callTool { tool: "route_target", args: { reconfigure: true } }` (re-opens account picker; if a stored alternative team exists, host offers it inline; routes to the Connections surface §4)

**Team/org ambiguity (multiple Vercel teams) — append one explainer line:**

> “You have more than one Vercel space. Pick your **personal** one unless this app is for work.”

**Database-only confirm (`provision_database`):**

> `speak`: “I’ll create a free database for your app on **Neon**, under **sam@gmail.com**. It’s on the free tier, so this costs \$0. Nothing’s been created yet. Go ahead?”
> buttons: **“Yes, create it”** → `callTool { tool: "provision_database", args: { …, confirmToken } }`; **“Use a different account”** → re-pick.

**Deploy-target create (`create_deploy_target`, standalone):**

> `speak`: “I’ll set up your hosting on **Vercel** under **“Sam’s personal”** (**sam@gmail.com**). Nothing goes live yet — this just makes the spot for your app. Sound right?”
> buttons: **“Yes”** → re-call with `confirmToken`; **“Use a different account”**.

### 1.8 On the confirmed (`status: "ok"`) result — keep the money promise visible

Per `optimalUxFlow` step 8, success outputs (`DeployOutput`, etc.) gain a `host` directive and a `costSoFar` field:

```ts
// added to DeployOutput / CreateDeployTargetOutput / ProvisionResult
costSoFar: "$0";
host: HostDirective;
```

> `speak`: “Done! Your **recipe app** is live at **{url}** — send it to your sister. It’s on the **free tier**; I’ll warn you long before anything could ever cost money. **Cost so far: \$0.**”

---

## 2. The mid-chat Connect round-trip

Maps to `optimalUxFlow` steps 3–6, 9 and the `prioritizedChanges` confused-deputy-proof bridge item. Today, when a token is missing, `deploy-tools.ts:40–43` returns `"No Vercel token found. Set the VERCEL_TOKEN environment variable…"` and `db-tools.ts:33–38` returns `"…Set the NEON_API_KEY environment variable…"` — a hard wall for Sam. We replace this (in the `ctx` path) with a `needsConnect` result that drives a pre-framed browser hand-off and auto-resume.

### 2.1 The trigger: no connection for `(subject, provider)`

In the per-user path, `getProviderToken(provider, ctx)` / `getDbCredentials(engine, ctx)` return a structured *reason* (not just `null`) when the vault has no usable connection for `(subject, provider)`. The resolver layer (`resolveAdapter` / `provisionDatabaseTool`) detects this **and** the presence of `ctx`, and emits a `needsConnect` envelope rather than `{ error }`. In the no-`ctx` path the env-var message is retained (§0.4).

### 2.2 `needsConnect` result schema

```ts
type NeedsConnectResult = {
  status: "needsConnect";
  provider: "github" | "vercel" | "digitalocean" | "neon" | "upstash";
  role: "code" | "hosting" | "database";   // Sam-facing purpose
  connectUrl: string;                       // https://<beam-host>/connect/<provider>?state=<signed>
  reason: "no_connection" | "expired" | "revoked";
  progress?: Progress;                      // "1 of 3", drives §5.2
  safety: { free: true; canSpendMoney: false; disconnectable: true }; // drives reassurance copy
  resumeHint: "autoProbe";                  // see §2.7
  host: HostDirective;
};
```

`connectUrl` carries the **signed, single-use, PKCE-bound state** (the confused-deputy fix): state is minted **only after** a verified MCP JWT, HMAC-signed, persisted in Postgres (`oauth_states`), single-use via `DELETE…RETURNING` in the same transaction as the connection upsert, TTL ≤ 10 min, carrying `subject + issuer + provider + PKCE verifier + exact redirect_uri`. The callback derives `subject` **exclusively** from the validated state row — never a query param or cookie. The host receives only the opaque URL. (State-minting/single-use enforcement is owned by the Connect-surface track; this spec owns the copy and the field that carries the URL.)

### 2.3 Pre-framing copy (chat, BEFORE the browser opens — `optimalUxFlow` steps 3 & 5)

**GitHub / code hand-off:**

> `speak`: “Next you’ll see a **GitHub** screen. GitHub is **free online storage for your app’s code** — if you don’t have an account I’ll help you make one (about 30 seconds). It’ll ask permission so Beam can **save YOUR app there, nothing else** — and you can **disconnect anytime**. It **can’t spend money**. On that screen, ignore anything about paid plans — always pick the free option. Click the green **Authorize** button, then **come right back here**.”
> buttons: **“Connect GitHub”** → `openUrl { connectUrl }`

**Hosting (Vercel / DigitalOcean) hand-off:**

> `speak`: “Next is a **Vercel** screen — Vercel is **where your app will run online, for free**. It’ll ask permission so Beam can **put your app live for you**. It **won’t charge anything** and you can **disconnect anytime**. Ignore anything about paid plans or upgrades. Click the **Authorize**/**Continue** button, then **come right back**.”
> buttons: **“Connect Vercel”** → `openUrl { connectUrl }`

**Database hand-off — default path is one-click Connect like the others, NOT a key paste** (`optimalUxFlow` step 6; `prioritizedChanges` “remove chat-paste-a-key as the default”):

> `speak`: “Last one — your **database** (where your recipes are saved). It’s **free**, and connecting it works just like the others. Click **Connect**, approve, and **come right back**.”
> buttons: **“Connect database”** → `openUrl { connectUrl }`

> **Fallback** (only if a provider has no OAuth — e.g. Neon partner-gated, Upstash none): `connectUrl` points at a **dedicated guided page** with numbered screenshots and instant validation — NEVER a chat paste. The `needsConnect.host.speak` stays identical (“Click Connect… come right back”); the difference is entirely on the browser page.

### 2.4 Progress copy on the return (`optimalUxFlow` steps 4–6)

When `progress` is present, the host **prepends it on the return message** (not the pre-frame). After GitHub lands (`progress: { connected: 1, total: 3, nextRole: "hosting" }`):

> “Great — **GitHub connected!** That’s **1 of 3** done. One more after this.”

After hosting: “**2 of 3** done.” After DB: “**3 of 3 — and your database is free too.**”

### 2.5 Browser pages — `/connect/:provider` and `/oauth/callback/:provider`

The one Beam-owned web surface besides `/connections`.

**`GET /connect/:provider`** — no visible page; validates signed state, 302-redirects to the provider authorize URL with PKCE. If state is invalid/expired, render a small page:
> *“This link expired. Head back to your chat and ask Claude to try again — it only takes a second.”*

**`GET /oauth/callback/:provider`** — on success: exchange code + verifier, envelope-encrypt, upsert `provider_connections` (capturing `account_label`), then render a large, plain success page (provider name interpolated):
> **“You’re connected to GitHub.”**
> “You can **close this tab** and **return to your chat** with Claude. We’ll pick up right where you left off.”
> (Vercel → “You’re connected to Vercel.” etc. No tokens, scopes, or IDs shown.)

**Callback failure page** (user denied / exchange failed):
> **“That didn’t finish.”**
> “No problem — **close this tab, return to your chat**, and Claude will offer to try again.”

### 2.6 Auto-resume mechanism (so Sam is never stranded — `optimalUxFlow` steps 4 & 9)

The chat must not sit silent after the callback. Three layers, in order of preference:

1. **Tool re-probe (primary).** `needsConnect.resumeHint = "autoProbe"` instructs the host: after opening the Connect URL, **re-call the original tool** (same args) on a short backoff while the user is in the browser. The moment the connection row lands, the credentialed tool returns `status: "ok"` (or the next `needsConnect` / `needsConfirmation` in the chain). This seam makes resume automatic.
2. **“I’m back” nudge (fallback).** If the host cannot auto-poll, the very next user message of *any kind* after a Connect hand-off triggers a re-probe. The cheap `check_credentials(ctx)` / `list_connections(ctx)` tool confirms landing and produces the “1 of 3” message without re-running the expensive tool.
3. **Abandoned-Connect recovery (`optimalUxFlow` step 9).** If the connection still isn’t present on the next message, the re-probe returns `needsConnect` again with `reason: "no_connection"` and the `connect_abandoned` copy from §3.

---

## 3. Error-recovery copy deck — each as a structured tool result

Each row below is a concrete result the host renders. These **replace** the current developer-speak (verified):
- `deploy-tools.ts:40–43` `missingTokenMessage()` → *“…Set the VERCEL_TOKEN environment variable…”* / *“…Set the DIGITALOCEAN_TOKEN environment variable…”*
- `db-tools.ts:33–38` `MISSING_NEON_MESSAGE` / `MISSING_UPSTASH_MESSAGE` → *“…Set the NEON_API_KEY environment variable…”* / *“…Set the UPSTASH_EMAIL and UPSTASH_API_KEY environment variables…”*
- `check-credentials.ts:32` `missing: [...] (set ${env})` → leaks `VERCEL_TOKEN`, `NEON_API_KEY`, etc.

### 3.1 The recovery payload

All recovery states ride either on `status: "needsConnect"` (with `reason` set) or on `status: "error"` with a `host` directive. To keep them lint-testable and uniform, every recovery result also carries a stable machine code and a structured `recovery` block (the `host.speak`/`buttons` are derived from it; the structured block is for tests and host bookkeeping, never shown):

```ts
type RecoveryKind =
  | "connect"            // never connected this provider
  | "reconnect_expired"  // was connected, aged out
  | "reconnect_failed"   // silent refresh failed
  | "reconnect_revoked"  // turned off provider-side
  | "wrong_account"      // connected, but not the account they want
  | "connect_abandoned"  // started Connect, never finished
  | "db_needs_managed";  // deploy succeeded; managed DB needed, one-click not ready

type Recovery = {
  kind: RecoveryKind;
  provider: "github" | "vercel" | "digitalocean" | "neon" | "upstash" | "database";
  errorCode: string;     // stable, e.g. "vercel.expired" — host bookkeeping only, NEVER shown
  headline: string;      // one friendly sentence (→ host.speak line 1)
  reassurance: string;   // "your app is safe / this is normal / it's free" (→ host.speak line 2)
  // the two buttons are emitted in host.buttons; mirrored here for tests:
  primaryAction: { label: string; action: HostButtonAction };
  secondaryAction?: { label: string; action: HostButtonAction };
  progress?: Progress;
};
```

The resolver threads a *reason* from the CredentialStore (never-connected / expired / refresh-failed / revoked / wrong-account / abandoned) so it picks the right row. `connectUrl` values in `openUrl` actions point at the Connect surface and carry the signed state (§2.2).

### 3.2 The copy table

`{acct}` / `{team}` come from the vaulted connection’s `account_label` (read by the resolver, never invented).

| `kind` / `errorCode` | When | `headline` | `reassurance` | primary button | secondary button |
|---|---|---|---|---|---|
| `connect` / `vercel.connect` | Never connected (replaces `missingTokenMessage`, vercel) | “To put your app online, connect your Vercel account.” | “It’s free, and your app’s already built — this just gives it a home. No copying or pasting anything.” | **“Connect Vercel”** → `openUrl{connectUrl}` | — |
| `connect` / `digitalocean.connect` | Never connected (replaces `missingTokenMessage`, DO) | “To put your app online, connect your DigitalOcean account.” | “It’s free to set up, and this just gives your app a home. Nothing to copy or paste.” | **“Connect DigitalOcean”** → `openUrl{connectUrl}` | — |
| `connect` / `github.connect` | Never connected | “Let’s connect GitHub so your app’s code has a safe home online.” | “GitHub is free online storage for your code. Beam can only save *your* app there — nothing else — and you can disconnect anytime.” | **“Connect GitHub”** → `openUrl{connectUrl}` | — |
| `reconnect_expired` / `vercel.expired` | Token aged out | “Your Vercel connection expired — this is totally normal, it happens every so often for security.” | “Your app is still live and safe. Reconnecting takes about 10 seconds.” | **“Reconnect Vercel”** → `openUrl{connectUrl}` | — |
| `reconnect_failed` / `vercel.refresh_failed` | Silent refresh failed | “I couldn’t refresh your Vercel connection just now.” | “Nothing’s broken and your app is safe — a quick reconnect fixes it.” | **“Reconnect Vercel”** → `openUrl{connectUrl}` | — |
| `reconnect_revoked` / `github.revoked` | Revoked provider-side | “It looks like GitHub access was switched off.” | “That’s an easy fix and your code is safe. Reconnect to keep going.” | **“Reconnect GitHub”** → `openUrl{connectUrl}` | — |
| `wrong_account` / `github.wrong_account` | Connected, wrong identity | “Heads up — this is connected to your **{acct}** account. Want your app to go there?” | “Easy to change. Nothing’s been created yet.” | **“Switch account”** → `openUrl{connectUrl}` (forces account chooser) | **“Keep {acct}”** → `callTool` re-run with current account |
| `connect_abandoned` / `vercel.abandoned` | Started, never finished | “Looks like the Vercel sign-in didn’t quite finish — no problem at all.” | “Nothing went wrong and nothing was charged. Want to give it another quick try?” | **“Connect Vercel”** → `openUrl{connectUrl}` (fresh state) | **“Not now”** → `cancel` |
| `db_needs_managed` / `database.needs_managed` | Deploy succeeded; DB needed, one-click not ready | “Your app’s online! It’ll need a database before the parts that save data will work — and one-click database setup is coming very soon.” | “Your app is live right now and this is free when it lands. I’ll set it up for you automatically the moment it’s ready — you’ll never have to copy or paste anything.” | **“Remind me when it’s ready”** → `callTool { tool: "write_todo", … }` | **“Set one up with a guide”** → `openUrl{guideUrl}` |

### 3.3 Notes per state (tied to the panel)

- **`connect` / `reconnect_*`** directly replace the developer-speak in `blockersForNonTechnical` #4. Every one ends in a single button and says *“your app is safe”* (`optimalUxFlow` step 9).
- **`wrong_account`** closes `blockersForNonTechnical` #5 (the most likely real-world mistake). The secondary **“Keep {acct}”** makes “this *is* the right account” a one-tap, so Sam is never forced into the connections page.
- **`connect_abandoned`** is the partial state: the resolver detects an `oauth_states` row for `(subject, provider)` but no active connection. The host surfaces it **proactively on Sam’s next message**, not only on retry (`optimalUxFlow` step 9).
- **`db_needs_managed`** is the “deploy-without-DB first” decision made concrete. It is **not an error** — it is reached on a *successful* deploy of an app that needs a DB. It keeps Sam’s app live, promises free + automatic, and offers the guided page only as the secondary action (never the default, never a chat paste). The current `MISSING_NEON_MESSAGE` / `MISSING_UPSTASH_MESSAGE` strings are removed entirely from the non-technical path.

### 3.4 The two confirmation states already covered

`needsConfirmation` (§1) is the create-time gate; its strings live in §1.7. The recovery deck and the confirmation gate share the same plain-language voice and the same copy lint (§0.5).

---

## 4. The Connections surface — “Your connected accounts”

Two deliverables: a **tool** (so chat can surface accounts and link to the page) and the **`/connections` page copy** (the only browser surface besides the callback).

### 4.1 `check_credentials` becomes per-user (host routing only)

`check-credentials.ts` becomes `checkCredentials(ctx?)`: reads the vault by `subject`, not env. It keeps the `vercel/digitalocean/neon/upstash` booleans — but each now means *“does this user have an active connection”* — and stops naming env vars. Replace the `missing` projection (`check-credentials.ts:32`) `"${name} (set ${env})"` → `"${name} (not connected)"`, and add `account_label` + `connectUrl` for missing providers plus a `progress` rollup:

```ts
type CheckCredentialsOutput = {
  connections: Array<{
    provider: "github" | "vercel" | "digitalocean" | "neon" | "upstash";
    role: "code" | "hosting" | "database";
    connected: boolean;
    accountLabel?: string;   // present when connected (non-secret, from vault)
    connectUrl?: string;     // present when NOT connected
    status?: "active" | "expired" | "revoked";
  }>;
  progress: { connected: number; total: number };
  // legacy, retained for technical/host routing (now per-user, no env names):
  vercel: boolean; digitalocean: boolean; neon: boolean; upstash: boolean;
  configured: string[];
  missing: string[];          // "neon (not connected)" — NEVER "(set NEON_API_KEY)"
  host: HostDirective;        // e.g. "You've connected 2 of 3."
};
```

This tool is for **host routing** (cheap re-probe + progress). For anything **Sam sees**, the host calls `list_connections` (§4.2).

### 4.2 New tool: `list_connections` (the Sam-facing view)

```ts
type Connection = {
  provider: "github" | "vercel" | "digitalocean" | "neon" | "upstash";
  displayName: string;        // "GitHub" | "Vercel" | "DigitalOcean" | "Your database" | "Your cache"
  status: "connected" | "expired" | "revoked" | "not_connected";
  accountLabel?: string;      // "sam@gmail.com"
  teamLabel?: string;         // "Sam's personal" (omit if none)
  statusLine: string;         // plain status; NO scopes/timestamps. e.g. "Connected as sam@gmail.com (Sam's personal)"
  actions: Array<{ kind: "switch" | "disconnect" | "connect" | "reconnect"; label: string; href: string }>;
  details?: { scopes: string[]; connectedAt: string; lastRefreshedAt?: string }; // behind a "details" toggle ONLY
  manageUrl: string;          // link to the /connections page
};

function listConnections(ctx?: CredentialContext): {
  connections: Connection[];
  headline: string;           // "Your connected accounts"
  manageUrl: string;
  host: HostDirective;
};
```

**Copy rules:**
- `displayName` + `statusLine` are the only things shown by default. `statusLine` examples: `"Connected as sam@gmail.com (Sam's personal)"`, `"Connection expired — reconnect anytime"`, `"Not connected yet"`. **No scopes, no timestamps, no env names** in the default view.
- `details` carries scopes/timestamps but is flagged so the host renders it behind a **“details”** affordance only (`prioritizedChanges` “scopes and timestamps hidden behind a ‘details’ affordance”).
- `actions[].label` are plain: **“Switch account”**, **“Disconnect”**, **“Connect”**, **“Reconnect”**. `disconnect` hrefs hit `POST /connections/:provider/disconnect` (CSRF-protected by the web-hardening track).

The host surfaces this from chat whenever Sam wants to change where her app goes, and as the secondary-action target of `wrong_account` (§3) and the “Use a different account” button in `needsConfirmation` (§1.7).

### 4.3 `/connections` page copy (browser surface)

Rendered server-side by the Connect web surface (that track owns route + session cookie); the **copy** is:
- **Title:** “Your connected accounts”
- **Subhead:** “These are the accounts Beam uses to put your apps online. Everything here is free.”
- **Per row:** big `displayName`, then `statusLine`; right-aligned **[Switch account]** and **[Disconnect]** (or **[Connect]** when not connected).
- **Details toggle:** a small **“Show technical details”** link that expands scopes/timestamps in plain framing (“What Beam can do: save your app’s code”). Collapsed by default.
- **Disconnect confirm:** “Disconnect GitHub? Your live apps keep running — this just means Beam can’t make new changes there until you reconnect. **[Disconnect] [Cancel]**”
- **Footer reassurance:** “Disconnecting never deletes your apps or your data, and you’re never charged for anything here.”

The disconnect confirm reassures that *the live app survives* — Sam’s #1 fear is “breaking my app.”

---

## 5. Trust / roadmap / progress layer

Each item maps to a `beam-me-up-plan.ts` string the host reads, or a result field above.

### 5.1 First-run friendly roadmap (~2–3 min, free, 3 steps)

Add a new step **0a** at the very top of `renderBeamMeUpPlan()` (before the current step 0 / `check_credentials` at `beam-me-up-plan.ts:111`), emitted the first time Sam says “beam me up”:

> **0a. [HOST-AI] Show the roadmap first — LIVE.** Before any tool call, say in Sam’s words:
> *“Getting your app online takes about 2–3 minutes and is completely free. Here’s the whole plan: we’ll connect where your code lives, where your app runs, and (when it’s ready) your database — I’ll confirm exactly where everything goes before I create anything, and walk you through each step. Ready? **[Let’s go]**”*
> Then keep a visible checklist: **☐ Code storage ☐ Hosting ☐ Database**.

Maps to `optimalUxFlow` step 2 and `prioritizedChanges` “add an up-front friendly roadmap.” The checklist is the same `progress` object the recovery/connect results carry, so “Let’s go” → each Connect ticks one box.

### 5.2 Visible progress checklist

Every `needsConnect` / recovery result and each in-chat resume message carries `host.progress = { connected, total, nextRole?, label? }`. On each successful return the host renders the running tally (§2.4: “Great — GitHub connected! That’s 1 of 3 done.”). This is the single anti-abandonment lever for the mid-chat hand-off (`blockersForNonTechnical` #1: each context switch is a drop-off point).

### 5.3 Repeated “this is free / we’ll never surprise-charge you” promise

Three placements, all concrete strings:
1. **Roadmap (5.1):** “…completely free.”
2. **Every provider hand-off** (plan hand-off steps): host appends *“This is free — Beam only ever uses free tiers, and I’ll warn you long before anything could ever cost money.”* Add as a standing instruction in the plan’s hand-off steps.
3. **Success message** (§1.8) and `db_needs_managed.reassurance` (§3): “It’s on the free tier.”

### 5.4 “Cost so far: \$0” indicator

Add advisory field `costSoFar: "$0"` to the deploy success output (§1.8) and to `NeedsConfirmationResult` (§1.4) so the host can surface it inline. Maps to `prioritizedChanges` “make ‘this is free…’ a repeated, visible promise.”

### 5.5 “If a screen mentions paid plans, pick the free option” pre-warning

Add to the consent pre-framing the host says before each browser hand-off (already woven into §2.3 strings, and as a standing rule in the plan’s “How to read this plan” section, `beam-me-up-plan.ts:73`):

> *“On the next screen, ignore anything about paid plans or upgrades — always pick the free option. We’ll never put you on a paid plan.”*

Paired with the consent pre-frame itself (`optimalUxFlow` steps 3 & 5): *“You’ll see a {Provider} screen asking permission so Beam can {save your code / put your app online} — that’s exactly what we need, nothing else, and you can disconnect anytime. Click the green Authorize button, then come right back here.”* These live as standing host instructions on each hand-off step, not in a tool result (the consent screen is the provider’s, pre-framed in chat).

---

## 6. Exact replacements for the current “Set the X environment variable” messages

The `ctx`-present (per-user) path replaces each developer-speak string with a structured result. The no-`ctx` path keeps the originals.

| File / location | Current string (verbatim) | Replacement (ctx path) |
|---|---|---|
| `deploy-tools.ts:41–42` (`missingTokenMessage`, vercel) | `"No Vercel token found. Set the VERCEL_TOKEN environment variable (and optionally VERCEL_TEAM_ID) to deploy to Vercel."` | `NeedsConnectResult` / `Recovery{kind:"connect", errorCode:"vercel.connect"}` — headline *“To put your app online, connect your Vercel account.”* + **“Connect Vercel”** (§3.2) |
| `deploy-tools.ts:43` (`missingTokenMessage`, DO) | `"No DigitalOcean token found. Set the DIGITALOCEAN_TOKEN environment variable to deploy to DigitalOcean App Platform."` | `Recovery{kind:"connect", errorCode:"digitalocean.connect"}` — *“To put your app online, connect your DigitalOcean account.”* + **“Connect DigitalOcean”** |
| `db-tools.ts:33–34` (`MISSING_NEON_MESSAGE`) | `"No Neon credentials found. Set the NEON_API_KEY environment variable to provision a Postgres database on Neon."` | `needsConnect` (role: database, OAuth-style §2.3) or `Recovery{kind:"db_needs_managed"}` (§3.2) — never a key paste |
| `db-tools.ts:37–38` (`MISSING_UPSTASH_MESSAGE`) | `"No Upstash credentials found. Set the UPSTASH_EMAIL and UPSTASH_API_KEY environment variables to provision a Redis database on Upstash."` | `needsConnect` (role: database) — *“…your cache… connecting it works just like the others.”* + **“Connect”** (guided page fallback if no OAuth) |
| `check-credentials.ts:32` (`missing` projection) | `missing: rows.filter(...).map((r) => `${r.name} (set ${r.env})`)` → e.g. `"neon (set NEON_API_KEY)"`, `"upstash (set UPSTASH_EMAIL + UPSTASH_API_KEY)"` | `"${name} (not connected)"` (e.g. `"neon (not connected)"`); plus the new `connections[]` / `progress` / `host` fields (§4.1). For Sam-facing surfaces the host calls `list_connections` instead. |
| `deploy-tools.ts:17–18` / `:64–65`, `db-tools.ts:14–19` / `:62–68` (the contract doc-comments + null branches that reference the env-var messages) | doc-comment text naming `VERCEL_TOKEN` / `DIGITALOCEAN_TOKEN` / `NEON_API_KEY` / `UPSTASH_*` | update doc-comments to describe the `ctx`-aware branch: `null` usable creds **+ `ctx`** → `needsConnect` (no env names in user-facing output); env-var message retained only for no-`ctx` self-host |

---

## 7. Build checklist (where each contract lands)

| File | Change |
|---|---|
| `packages/core` (types) | Add `ResultStatus`, `HostDirective`/`HostButton`/`HostButtonAction`, `NeedsConnectResult`, `NeedsConfirmationResult`, `Recovery`, `Connection`, `Progress`; add `costSoFar?` + `host?` to deploy/provision success outputs. Additive — pure tools and success paths unchanged. |
| `packages/tools/src/deploy-tools.ts` | Remove `missingTokenMessage` (40–43); make `resolveAdapter(provider, ctx?)` return `NeedsConnectResult`/`Recovery` from a ctx-aware token result keyed on connection status; add `confirmToken` gate to `createDeployTarget` / `deployTool` / `setEnvVarsTool` (emit `NeedsConfirmationResult` when no valid token). |
| `packages/tools/src/db-tools.ts` | Remove `MISSING_NEON_MESSAGE` / `MISSING_UPSTASH_MESSAGE` (33–38); `provisionDatabaseTool(args, ctx?)`: null creds + `ctx` → `needsConnect` (database role, OAuth-style) or `db_needs_managed`; add `confirmToken` gate. |
| `packages/tools/src/check-credentials.ts` | `checkCredentials(ctx?)` per-user vault read; stop emitting `(set ${env})` at line 32 → `(not connected)`; add `connections[]` + `connectUrl` + `accountLabel` + `progress` + `host`. Add new `list_connections(ctx?)` tool returning `Connection[]` + page copy. |
| `packages/adapters/src/token.ts` | `getProviderToken` / `getDbCredentials` ctx-aware: return a structured *reason* (never-connected / expired / refresh-failed / revoked / wrong-account / abandoned) + `account_label`, instead of bare `null`, when `ctx` is present. |
| `packages/tools/src/plan/beam-me-up-plan.ts` | Add step **0a** roadmap (before line 111); add standing host rules for `status` branching + `host`-directive rendering, consent pre-framing, free-tier promise, paid-plan pre-warning, and `costSoFar`; point step 0 at `list_connections` for anything user-facing and `check_credentials` for host routing only. |
| `packages/server/src/server/http.ts` | Connect/callback routes (`/connect/:provider`, `/oauth/callback/:provider`) + `/connections` + `POST /connections/:provider/disconnect`; build `ctx` from `result.auth.subject`; render the exact page copy in §2.5 and §4.3. |
| New | `ProviderConnector` interface + `account_label` capture at Connect time; `oauth_states` single-use signed/PKCE state; `confirmToken` HMAC mint/verify bound to `(subject, tool, hash(args), destinations)`; the merge-blocking copy-lint test (§0.5). |

**Dependencies not owned here:** the CredentialStore must expose *why* a token is unusable and the connection’s account/team display label; the Connect-surface track owns state-minting + single-use enforcement + session cookie for `/connections`.

---

## 8. Definition of Done — tied to the four non-negotiables

A change is **done** only when all four non-negotiables pass:

### NN-1 — No developer-speak ever reaches Sam
- [ ] The copy-lint test (§0.5) runs in CI and **blocks merge** on any user-facing field containing *token, env var, environment variable, API key, secret, scope, OAuth, client ID, console.*
- [ ] All five legacy strings (§6) are removed from the `ctx`/per-user path: `missingTokenMessage` (both branches), `MISSING_NEON_MESSAGE`, `MISSING_UPSTASH_MESSAGE`, and `check-credentials.ts:32` no longer emit `(set ${env})`.
- [ ] Provider names render as **GitHub / Vercel / DigitalOcean / your database / your cache** — never abbreviations or internal IDs.

### NN-2 — Mid-chat Connect round-trip is confused-deputy-proof and never strands Sam
- [ ] `needsConnect` (§2.2) is returned (not `{ error }`) whenever `ctx` is present and there is no usable connection; `connectUrl` carries signed, single-use, PKCE-bound state; callback derives `subject` **only** from the validated state row.
- [ ] Pre-framing copy (§2.3) is spoken **before** the browser opens; success/failure pages (§2.5) render the exact strings; `resumeHint:"autoProbe"` drives re-probe so the chat resumes automatically (§2.6); abandoned-Connect recovery (`connect_abandoned`, §3) fires proactively on the next message.
- [ ] Database default path is one-click Connect, **not** a chat key-paste; the only paste-free fallback is a guided page.

### NN-3 — Mandatory plain-language destination confirmation gates every create
- [ ] `create_deploy_target` / `provision_database` / `deploy` / `set_env_vars` return `needsConfirmation` and **do not create** without a valid `confirmToken` (server-enforced); `get_deploy_logs` does not gate.
- [ ] Labels come from the vaulted `account_label` (§1.3); `confirmToken` is HMAC-signed, single-use, TTL ≤ 10 min, bound to `(subject, tool, hash(args), destinations)`.
- [ ] Chosen target persists per `(subject, app)`; same-app/same-destination re-runs skip the gate; destination change / new provider / fresh-session create re-triggers it (§1.6).

### NN-4 — Trust layer makes “free + safe + in-progress” continuously visible
- [ ] First-run roadmap step **0a** (§5.1) is emitted before any tool call, with the ☐ Code / ☐ Hosting / ☐ Database checklist.
- [ ] `progress` is present on every connect/recovery/resume result and rendered as “N of 3” (§5.2).
- [ ] The free-tier promise appears at roadmap, each hand-off, and success (§5.3); `costSoFar:"$0"` is on the confirm and success results (§5.4); the “pick the free option / never a paid plan” pre-warning precedes each hand-off (§5.5).
- [ ] The Connections surface (§4) renders plain `statusLine`s with scopes/timestamps behind a “details” toggle, and the disconnect-confirm reassures the live app survives.

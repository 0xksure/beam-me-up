/**
 * copy-deck — the server-owned plain-language UX copy for M9 P3a.
 *
 * Beam is an MCP server: it returns tool results, not UI. Every user-facing
 * string the host renders lives HERE (single source of truth, lint-testable).
 * No string in this file may name developer concepts (token, env var, API key,
 * secret, scope, OAuth, client id, console) — enforced by the merge-blocking
 * copy lint in test/m12.test.ts.
 *
 * Provider display names are fixed: GitHub, Vercel, DigitalOcean (never "DO"),
 * "your database", "your cache".
 */
import type {
  ConnectionRole,
  DestinationLabel,
  HostButton,
  HostDirective,
  NeedsConfirmationResult,
  NeedsConnectResult,
  Progress,
  ProviderName,
  Recovery,
  RecoveryProvider,
} from "@beam-me-up/core";

/* ------------------------------------------------------------------ */
/* Provider display names + roles                                      */
/* ------------------------------------------------------------------ */

/** The fixed, Sam-facing display name for each provider. */
export function providerDisplayName(provider: RecoveryProvider): string {
  switch (provider) {
    case "github":
      return "GitHub";
    case "vercel":
      return "Vercel";
    case "digitalocean":
      return "DigitalOcean";
    case "neon":
    case "database":
      return "your database";
    case "upstash":
      return "your cache";
  }
}

/** What a provider is FOR, in Sam's terms. */
export function providerRole(provider: ProviderName): ConnectionRole {
  switch (provider) {
    case "github":
      return "code";
    case "vercel":
    case "digitalocean":
      return "hosting";
    case "neon":
    case "upstash":
      return "database";
  }
}

/* ------------------------------------------------------------------ */
/* Connect URL placeholder (real /connect routes are P3b)              */
/* ------------------------------------------------------------------ */

/**
 * The /connect/<provider> URL the host opens. In P3a this carries no signed
 * state (the state-minting + single-use enforcement + real provider OAuth are
 * P3b); it is a placeholder the host can already render as a button.
 */
export function connectUrl(provider: ProviderName): string {
  const base = process.env.BEAM_PUBLIC_BASE_URL?.trim() || "https://app.beammeup.dev";
  return `${base}/connect/${provider}`;
}

/* ------------------------------------------------------------------ */
/* needsConnect (the mid-chat Connect round-trip, §2)                  */
/* ------------------------------------------------------------------ */

/** The pre-framing `speak` string per role (spec §2.3). */
function connectSpeak(provider: ProviderName): string {
  const role = providerRole(provider);
  if (role === "code") {
    return (
      "Let’s connect GitHub so your app’s code has a safe home online. " +
      "GitHub is free online storage for your code — if you don’t have an " +
      "account I’ll help you make one (about 30 seconds). Beam can only save " +
      "YOUR app there, nothing else, and you can disconnect anytime. It can’t " +
      "ever cost money. On the next screen, ignore anything about paid plans — " +
      "always pick the free option — then come right back here."
    );
  }
  if (role === "hosting") {
    const name = providerDisplayName(provider);
    return (
      `Next is a ${name} screen — ${name} is where your app will run online, ` +
      "for free. It’ll ask permission so Beam can put your app live for you. " +
      "It won’t charge anything and you can disconnect anytime. Ignore anything " +
      "about paid plans or upgrades — always pick the free option — then come " +
      "right back here."
    );
  }
  // database / cache
  const noun = provider === "upstash" ? "your cache" : "your database";
  return (
    `Last one — ${noun} (where your recipes are saved). It’s free, and ` +
    "connecting it works just like the others. Click Connect, approve, and " +
    "come right back here. We’ll never put you on a paid plan."
  );
}

/** The Connect button label per provider (plain, never "authorize a token"). */
function connectButtonLabel(provider: ProviderName): string {
  const role = providerRole(provider);
  if (role === "database") return "Connect database";
  return `Connect ${providerDisplayName(provider)}`;
}

export function buildNeedsConnect(opts: {
  provider: ProviderName;
  reason: "no_connection" | "expired" | "revoked";
  progress?: Progress;
}): NeedsConnectResult {
  const url = connectUrl(opts.provider);
  const button: HostButton = {
    label: connectButtonLabel(opts.provider),
    action: { kind: "openUrl", url },
  };
  const host: HostDirective = {
    speak: connectSpeak(opts.provider),
    buttons: [button],
    ...(opts.progress ? { progress: opts.progress } : {}),
  };
  return {
    status: "needsConnect",
    provider: opts.provider,
    role: providerRole(opts.provider),
    connectUrl: url,
    reason: opts.reason,
    ...(opts.progress ? { progress: opts.progress } : {}),
    safety: { free: true, canSpendMoney: false, disconnectable: true },
    resumeHint: "autoProbe",
    host,
  };
}

/* ------------------------------------------------------------------ */
/* Recovery copy deck (§3) — each as a structured result               */
/* ------------------------------------------------------------------ */

type RecoveryRow = {
  headline: string;
  reassurance: string;
  primaryLabel: string;
  /** "connect" -> openUrl(connectUrl); "remind" -> callTool write_todo. */
  primaryKind: "openUrl" | "writeTodo";
  secondary?: { label: string; kind: "cancel" | "guideUrl" };
};

/** Build the structured Recovery block for a (kind, provider). */
export function buildRecovery(
  kind: Recovery["kind"],
  provider: RecoveryProvider,
): Recovery {
  const name = providerDisplayName(provider);
  const url = provider === "database" ? connectUrl("neon") : connectUrl(provider as ProviderName);
  const guideUrl =
    (process.env.BEAM_PUBLIC_BASE_URL?.trim() || "https://app.beammeup.dev") +
    "/guide/database";

  const errorCode = `${provider}.${recoveryCodeSuffix(kind)}`;

  const row = recoveryRow(kind, provider, name);
  const primaryAction: Recovery["primaryAction"] = {
    label: row.primaryLabel,
    action:
      row.primaryKind === "writeTodo"
        ? {
            kind: "callTool",
            tool: "write_todo",
            args: { reminder: "managed database" },
          }
        : { kind: "openUrl", url },
  };
  const secondaryAction: Recovery["secondaryAction"] | undefined = row.secondary
    ? {
        label: row.secondary.label,
        action:
          row.secondary.kind === "cancel"
            ? { kind: "cancel" }
            : { kind: "openUrl", url: guideUrl },
      }
    : undefined;

  return {
    kind,
    provider,
    errorCode,
    headline: row.headline,
    reassurance: row.reassurance,
    primaryAction,
    ...(secondaryAction ? { secondaryAction } : {}),
  };
}

function recoveryCodeSuffix(kind: Recovery["kind"]): string {
  switch (kind) {
    case "connect":
      return "connect";
    case "reconnect_expired":
      return "expired";
    case "reconnect_failed":
      return "refresh_failed";
    case "reconnect_revoked":
      return "revoked";
    case "wrong_account":
      return "wrong_account";
    case "connect_abandoned":
      return "abandoned";
    case "db_needs_managed":
      return "needs_managed";
  }
}

function recoveryRow(
  kind: Recovery["kind"],
  provider: RecoveryProvider,
  name: string,
): RecoveryRow {
  switch (kind) {
    case "connect": {
      if (provider === "github") {
        return {
          headline:
            "Let’s connect GitHub so your app’s code has a safe home online.",
          reassurance:
            "GitHub is free online storage for your code. Beam can only save " +
            "your app there — nothing else — and you can disconnect anytime.",
          primaryLabel: "Connect GitHub",
          primaryKind: "openUrl",
        };
      }
      return {
        headline: `To put your app online, connect your ${name} account.`,
        reassurance:
          provider === "digitalocean"
            ? "It’s free to set up, and this just gives your app a home. Nothing to copy or paste."
            : "It’s free, and your app’s already built — this just gives it a home. No copying or pasting anything.",
        primaryLabel: `Connect ${name}`,
        primaryKind: "openUrl",
      };
    }
    case "reconnect_expired":
      return {
        headline: `Your ${name} connection expired — this is totally normal, it happens every so often to keep things safe.`,
        reassurance: "Your app is still live and safe. Reconnecting takes about 10 seconds.",
        primaryLabel: `Reconnect ${name}`,
        primaryKind: "openUrl",
      };
    case "reconnect_failed":
      return {
        headline: `I couldn’t refresh your ${name} connection just now.`,
        reassurance: "Nothing’s broken and your app is safe — a quick reconnect fixes it.",
        primaryLabel: `Reconnect ${name}`,
        primaryKind: "openUrl",
      };
    case "reconnect_revoked":
      return {
        headline: `It looks like ${name} access was switched off.`,
        reassurance: "That’s an easy fix and your code is safe. Reconnect to keep going.",
        primaryLabel: `Reconnect ${name}`,
        primaryKind: "openUrl",
      };
    case "wrong_account":
      return {
        headline: `Heads up — this is connected to a different ${name} account. Want your app to go there?`,
        reassurance: "Easy to change. Nothing’s been created yet.",
        primaryLabel: "Switch account",
        primaryKind: "openUrl",
        secondary: { label: "Keep this one", kind: "cancel" },
      };
    case "connect_abandoned":
      return {
        headline: `Looks like the ${name} sign-in didn’t quite finish — no problem at all.`,
        reassurance: "Nothing went wrong and nothing was charged. Want to give it another quick try?",
        primaryLabel: `Connect ${name}`,
        primaryKind: "openUrl",
        secondary: { label: "Not now", kind: "cancel" },
      };
    case "db_needs_managed":
      return {
        headline:
          "Your app’s online! It’ll need a database before the parts that save data will work — and one-click database setup is coming very soon.",
        reassurance:
          "Your app is live right now and this is free when it lands. I’ll set it up for you automatically the moment it’s ready — you’ll never have to copy or paste anything.",
        primaryLabel: "Remind me when it’s ready",
        primaryKind: "writeTodo",
        secondary: { label: "Set one up with a guide", kind: "guideUrl" },
      };
  }
}

/** Turn a Recovery into the host directive the user actually sees. */
export function recoveryHost(recovery: Recovery): HostDirective {
  const buttons: HostButton[] = [
    { label: recovery.primaryAction.label, action: recovery.primaryAction.action },
  ];
  if (recovery.secondaryAction) {
    buttons.push({
      label: recovery.secondaryAction.label,
      action: recovery.secondaryAction.action,
    });
  }
  return {
    speak: `${recovery.headline} ${recovery.reassurance}`,
    buttons,
    ...(recovery.progress ? { progress: recovery.progress } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* needsConfirmation (the destination gate, §1)                        */
/* ------------------------------------------------------------------ */

/** A short plain sentence describing what each tool will create/change. */
function actionSummaryFor(tool: string, resourceName: string): string {
  switch (tool) {
    case "deploy":
      return `Put your app “${resourceName}” live on the internet.`;
    case "create_deploy_target":
      return `Set up the hosting spot for your app “${resourceName}”.`;
    case "provision_database":
      return `Create a free database for your app “${resourceName}”.`;
    case "set_env_vars":
      return `Save your app’s settings for “${resourceName}”.`;
    default:
      return `Make changes for your app “${resourceName}”.`;
  }
}

/** The confirm `speak` string per tool (spec §1.7). */
function confirmSpeak(
  tool: string,
  resourceName: string,
  destinations: DestinationLabel[],
): string {
  const hosting = destinations.find((d) => d.role === "hosting");
  const code = destinations.find((d) => d.role === "code");
  const db = destinations.find((d) => d.role === "database");

  if (tool === "provision_database" && db) {
    const name = providerDisplayName(db.provider);
    return (
      `I’ll create a free database for your app on ${name}, under ` +
      `${db.accountLabel}. It’s on the free tier, so this costs $0. ` +
      "Nothing’s been created yet. Go ahead?"
    );
  }

  if (tool === "create_deploy_target" && hosting) {
    const name = providerDisplayName(hosting.provider);
    const team = hosting.teamLabel ? ` under “${hosting.teamLabel}”` : "";
    return (
      `I’ll set up your hosting on ${name}${team} (${hosting.accountLabel}). ` +
      "Nothing goes live yet — this just makes the spot for your app. " +
      "Sound right?"
    );
  }

  // deploy (and set_env_vars): the combined Sam case.
  if (hosting) {
    const name = providerDisplayName(hosting.provider);
    const team = hosting.teamLabel ? ` under the space “${hosting.teamLabel}”` : "";
    let line =
      `Quick check before I create anything: I’ll put your app live on your ` +
      `${name} account${team}`;
    if (code) {
      line += `, and save your code to GitHub (${code.accountLabel}) as a new private project “${resourceName}”`;
    }
    line += ". ";
    if (db?.freeTier) {
      line += "Your database is on the free tier — $0. ";
    }
    line += "Nothing’s been created yet. Look right?";
    return line;
  }

  if (tool === "set_env_vars") {
    return (
      `I’ll save your app’s settings for “${resourceName}”. ` +
      "Nothing new gets created and this stays free. Look right?"
    );
  }

  return `Quick check before I create anything for “${resourceName}”. Nothing’s been created yet. Look right?`;
}

/** The "Yes" button label per tool. */
function confirmYesLabel(tool: string): string {
  switch (tool) {
    case "deploy":
      return "Yes, deploy";
    case "provision_database":
      return "Yes, create it";
    default:
      return "Yes";
  }
}

export function buildNeedsConfirmation(opts: {
  tool: string;
  resourceName: string;
  destinations: DestinationLabel[];
  /** The ORIGINAL tool args, echoed back with confirmToken on the Yes button. */
  args: Record<string, unknown>;
  confirmToken: string;
  confirmTokenExpiresAt: string;
}): NeedsConfirmationResult {
  const speak = confirmSpeak(opts.tool, opts.resourceName, opts.destinations);

  const yesButton: HostButton = {
    label: confirmYesLabel(opts.tool),
    action: {
      kind: "callTool",
      tool: opts.tool,
      args: { ...opts.args, confirmToken: opts.confirmToken },
    },
  };
  const differentButton: HostButton = {
    label: "Use a different account",
    action: { kind: "callTool", tool: "route_target", args: { reconfigure: true } },
  };

  return {
    status: "needsConfirmation",
    tool: opts.tool,
    actionSummary: actionSummaryFor(opts.tool, opts.resourceName),
    destinations: opts.destinations,
    resourceName: opts.resourceName,
    confirmToken: opts.confirmToken,
    confirmTokenExpiresAt: opts.confirmTokenExpiresAt,
    costSoFar: "$0",
    host: { speak, buttons: [yesButton, differentButton] },
  };
}

/* ------------------------------------------------------------------ */
/* Success copy (§1.8) — the money promise stays visible               */
/* ------------------------------------------------------------------ */

export function deploySuccessHost(opts: {
  resourceName: string;
  url?: string;
}): HostDirective {
  const where = opts.url ? ` at ${opts.url}` : "";
  return {
    speak:
      `Done! Your app “${opts.resourceName}” is live${where} — send it to ` +
      "your friends. It’s on the free tier; I’ll warn you long before anything " +
      "could ever cost money. Cost so far: $0.",
    buttons: [],
  };
}

/**
 * checkCredentials - report which provider connections this user has, so the
 * host AI can route around missing providers before expensive work and re-probe
 * cheaply after a Connect hand-off.
 *
 * Two worlds (M9):
 *   - ctx path (per-user vault): each boolean means "does THIS user have an
 *     ACTIVE connection". `missing` reads "<name> (not connected)" — NEVER
 *     "(set NEON_API_KEY)". Adds `connections[]` (with `connectUrl` for missing
 *     providers), a `progress` rollup, and a `host` directive.
 *   - no-ctx path (self-host/stdio): presence is read from env; the legacy
 *     `missing` projection keeps the env-var hint (that audience wants it).
 *
 * It never reads out or echoes a credential value. No network, no filesystem.
 */
import type {
  CheckCredentialsConnection,
  CheckCredentialsOutput,
  Connection,
  HostDirective,
  ListConnectionsOutput,
  Progress,
  ProviderName,
} from "@beam-me-up/core";
import {
  getDbCredentials,
  getProviderToken,
  type ConnectionInfo,
  type CredentialContext,
} from "@beam-me-up/adapters";
import { connectUrl, providerDisplayName, providerRole } from "./ux/index.js";

/** The three connectable roles Sam cares about (code is handled by P3b). */
const PROVIDER_ROW_ORDER: ProviderName[] = [
  "vercel",
  "digitalocean",
  "neon",
  "upstash",
];

export async function checkCredentials(
  ctx?: CredentialContext,
): Promise<CheckCredentialsOutput> {
  const vercel = (await getProviderToken("vercel", ctx)) !== null;
  const digitalocean = (await getProviderToken("digitalocean", ctx)) !== null;
  const neon = (await getDbCredentials("postgres", ctx)) !== null;
  const upstash = (await getDbCredentials("redis", ctx)) !== null;

  const presence: Record<ProviderName, boolean> = {
    vercel,
    digitalocean,
    neon,
    upstash,
    github: false,
  };

  // Per-user connection status (ctx path) so a row can say expired/revoked.
  let summaries: ConnectionInfo[] = [];
  if (ctx?.listConnections) {
    try {
      summaries = await ctx.listConnections();
    } catch {
      summaries = [];
    }
  }

  const connections: CheckCredentialsConnection[] = PROVIDER_ROW_ORDER.map(
    (provider) => {
      const connected = presence[provider];
      const summary = summaries.find((s) => s.provider === provider);
      const row: CheckCredentialsConnection = {
        provider,
        role: providerRole(provider),
        connected,
      };
      if (connected) {
        if (summary?.providerAccountId) row.accountLabel = summary.providerAccountId;
        row.status = summary?.status ?? "active";
      } else {
        row.connectUrl = connectUrl(provider);
      }
      return row;
    },
  );

  const connectedCount = connections.filter((c) => c.connected).length;
  const progress: Progress = { connected: connectedCount, total: connections.length };

  // The `missing` projection differs by world (NN-1: no env names on ctx path).
  const rows: { name: ProviderName; ok: boolean; env: string }[] = [
    { name: "vercel", ok: vercel, env: "VERCEL_TOKEN" },
    { name: "digitalocean", ok: digitalocean, env: "DIGITALOCEAN_TOKEN" },
    { name: "neon", ok: neon, env: "NEON_API_KEY" },
    { name: "upstash", ok: upstash, env: "UPSTASH_EMAIL + UPSTASH_API_KEY" },
  ];
  const configured = rows.filter((r) => r.ok).map((r) => r.name);
  const missing = rows
    .filter((r) => !r.ok)
    .map((r) => (ctx ? `${r.name} (not connected)` : `${r.name} (set ${r.env})`));

  const out: CheckCredentialsOutput = {
    connections,
    progress,
    vercel,
    digitalocean,
    neon,
    upstash,
    configured,
    missing,
  };

  if (ctx) out.host = progressHost(progress);
  return out;
}

/** A plain "you've connected N of M" directive (ctx path). */
function progressHost(progress: Progress): HostDirective {
  const { connected, total } = progress;
  const speak =
    connected === 0
      ? `Let’s get your app online — it’s free and takes about 2–3 minutes. Nothing connected yet; we’ll set up ${total} things together.`
      : connected === total
        ? `All set — you’ve connected all ${total}. Everything here is free.`
        : `You’ve connected ${connected} of ${total}. Just ${total - connected} more, and it’s all free.`;
  return { speak, buttons: [], progress };
}

/* ================================================================== */
/* list_connections (M9 P3a, §4.2) — the Sam-facing view              */
/* ================================================================== */

/** The /connections management page URL. */
function manageUrl(): string {
  const base = process.env.BEAM_PUBLIC_BASE_URL?.trim() || "https://app.beammeup.dev";
  return `${base}/connections`;
}

/**
 * listConnections — the Sam-facing "Your connected accounts" view. Reads the
 * vault by subject (ctx path) and returns plain `statusLine`s with NO scopes,
 * timestamps, or env names. On the no-ctx path it reflects env presence with
 * the same plain copy.
 */
export async function listConnections(
  ctx?: CredentialContext,
): Promise<ListConnectionsOutput> {
  const creds = await checkCredentials(ctx);
  const manage = manageUrl();

  const connections: Connection[] = creds.connections.map((row) => {
    const display = providerDisplayName(row.provider);
    const connected = row.connected;
    const viewStatus: Connection["status"] = !connected
      ? "not_connected"
      : row.status === "expired"
        ? "expired"
        : row.status === "revoked"
          ? "revoked"
          : "connected";

    let statusLine: string;
    if (viewStatus === "connected") {
      statusLine = row.accountLabel
        ? `Connected as ${row.accountLabel}`
        : "Connected";
    } else if (viewStatus === "expired") {
      statusLine = "Connection expired — reconnect anytime";
    } else if (viewStatus === "revoked") {
      statusLine = "Connection turned off — reconnect anytime";
    } else {
      statusLine = "Not connected yet";
    }

    const actions: Connection["actions"] =
      viewStatus === "not_connected"
        ? [{ kind: "connect", label: "Connect", href: row.connectUrl ?? connectUrl(row.provider) }]
        : viewStatus === "connected"
          ? [
              { kind: "switch", label: "Switch account", href: connectUrl(row.provider) },
              { kind: "disconnect", label: "Disconnect", href: `${manage}/${row.provider}/disconnect` },
            ]
          : [{ kind: "reconnect", label: "Reconnect", href: connectUrl(row.provider) }];

    const out: Connection = {
      provider: row.provider,
      displayName: display,
      status: viewStatus,
      statusLine,
      actions,
      manageUrl: manage,
    };
    if (row.accountLabel) out.accountLabel = row.accountLabel;
    return out;
  });

  const connectedCount = connections.filter((c) => c.status === "connected").length;
  const total = connections.length;
  const host: HostDirective = {
    speak:
      connectedCount === total
        ? `Here are your connected accounts — all ${total} are set, and everything here is free.`
        : `Here are your connected accounts. ${connectedCount} of ${total} connected so far — everything here is free.`,
    buttons: [{ label: "Manage accounts", action: { kind: "openUrl", url: manage } }],
    progress: { connected: connectedCount, total },
  };

  return {
    connections,
    headline: "Your connected accounts",
    manageUrl: manage,
    host,
  };
}

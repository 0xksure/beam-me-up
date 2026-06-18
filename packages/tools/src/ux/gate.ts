/**
 * gate — the ctx-aware UX helpers the credentialed tools call to (a) turn a
 * missing/expired/revoked connection into a `needsConnect` envelope and (b)
 * enforce the destination-confirmation gate (`needsConfirmation` + a structural
 * confirmToken check) BEFORE any side effect (M9 P3a, spec §1–§3).
 *
 * These run ONLY on the per-user (`ctx` present) path. The no-`ctx`
 * self-host/stdio path keeps the existing env-var messages (behaviour
 * unchanged there) — the tools branch on `ctx` before calling in here.
 */
import type { CredentialContext, ConnectionInfo } from "@beam-me-up/adapters";
import type {
  DestinationLabel,
  NeedsConfirmationResult,
  NeedsConnectResult,
  ProviderName,
} from "@beam-me-up/core";
import {
  buildNeedsConnect,
  buildNeedsConfirmation,
  providerRole,
} from "./copy-deck.js";
import {
  mintConfirmToken,
  verifyConfirmToken,
} from "./confirm-token.js";

/** Read this subject's connection summaries, or [] when ctx can't list them. */
export async function readConnections(
  ctx: CredentialContext,
): Promise<ConnectionInfo[]> {
  if (!ctx.listConnections) return [];
  try {
    return await ctx.listConnections();
  } catch {
    return [];
  }
}

/** Find the connection summary for a provider (or undefined). */
export function findConnection(
  connections: ConnectionInfo[],
  provider: ProviderName,
): ConnectionInfo | undefined {
  return connections.find((c) => c.provider === provider);
}

/**
 * Map a connection's presence/status to a needsConnect envelope when there is
 * no USABLE connection (missing / expired / revoked). Returns null when the
 * connection is active (the tool should proceed).
 */
export function needsConnectFor(
  connections: ConnectionInfo[],
  provider: ProviderName,
  progress?: NeedsConnectResult["progress"],
): NeedsConnectResult | null {
  const conn = findConnection(connections, provider);
  if (!conn) {
    return buildNeedsConnect({ provider, reason: "no_connection", progress });
  }
  if (conn.status === "expired") {
    return buildNeedsConnect({ provider, reason: "expired", progress });
  }
  if (conn.status === "revoked") {
    return buildNeedsConnect({ provider, reason: "revoked", progress });
  }
  return null;
}

/** The non-secret destination label read from the vault connection row. */
export function destinationLabelFor(
  connections: ConnectionInfo[],
  provider: ProviderName,
  freeTier?: boolean,
): DestinationLabel {
  const conn = findConnection(connections, provider);
  const accountLabel =
    conn && conn.providerAccountId ? conn.providerAccountId : "your account";
  return {
    provider,
    role: providerRole(provider),
    accountLabel,
    ...(freeTier !== undefined ? { freeTier } : {}),
  };
}

/**
 * The destination-confirmation GATE. Given the tool, subject, the original
 * args, and the destination labels read from the vault:
 *
 *   - if a valid `confirmToken` is present in the args -> returns null (the
 *     tool proceeds to its side effect);
 *   - otherwise -> mints a fresh confirmToken bound to
 *     (subject, tool, hash(args), destinations) and returns a
 *     `needsConfirmation` envelope with NO side effect performed.
 *
 * The token is STATELESS HMAC (see confirm-token.ts); a tampered/expired/
 * wrong-destination token fails verification and the gate re-fires. This gives
 * the structural "a deploy without a valid confirmToken cannot create"
 * guarantee fully offline.
 */
export function confirmationGate(opts: {
  tool: string;
  subject: string;
  resourceName: string;
  args: Record<string, unknown>;
  destinations: DestinationLabel[];
}): NeedsConfirmationResult | null {
  const provided = typeof opts.args.confirmToken === "string"
    ? (opts.args.confirmToken as string)
    : undefined;

  if (provided) {
    const ok = verifyConfirmToken({
      token: provided,
      tool: opts.tool,
      subject: opts.subject,
      args: opts.args,
      destinations: opts.destinations,
    });
    if (ok) return null; // valid token -> proceed (side effect allowed)
  }

  // No token, or an invalid/expired/tampered one -> STOP and ask. Mint a fresh
  // token bound to exactly this (subject, tool, args, destinations).
  const minted = mintConfirmToken({
    tool: opts.tool,
    subject: opts.subject,
    args: opts.args,
    destinations: opts.destinations,
  });
  return buildNeedsConfirmation({
    tool: opts.tool,
    resourceName: opts.resourceName,
    destinations: opts.destinations,
    args: opts.args,
    confirmToken: minted.token,
    confirmTokenExpiresAt: minted.expiresAtIso,
  });
}

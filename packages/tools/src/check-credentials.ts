/**
 * checkCredentials - report which provider credentials are present in the
 * server's environment, so the host AI can route around missing providers
 * before doing expensive work (building images, provisioning a DB, etc.).
 *
 * Reads only PRESENCE via the existing getProviderToken / getDbCredentials
 * resolvers; it never reads out or echoes a credential value. No network, no
 * filesystem.
 *
 * M9 P1: when a per-user CredentialContext is supplied, presence is probed via
 * ctx.resolve/ctx.resolveDb (non-null => present) so an authenticated user sees
 * THEIR connected providers; without ctx the behaviour is unchanged (env).
 */
import type { CheckCredentialsOutput } from "@beam-me-up/core";
import {
  getDbCredentials,
  getProviderToken,
  type CredentialContext,
} from "@beam-me-up/adapters";

export async function checkCredentials(
  ctx?: CredentialContext,
): Promise<CheckCredentialsOutput> {
  const vercel = (await getProviderToken("vercel", ctx)) !== null;
  const digitalocean = (await getProviderToken("digitalocean", ctx)) !== null;
  const neon = (await getDbCredentials("postgres", ctx)) !== null;
  const upstash = (await getDbCredentials("redis", ctx)) !== null;

  const rows: { name: string; ok: boolean; env: string }[] = [
    { name: "vercel", ok: vercel, env: "VERCEL_TOKEN" },
    { name: "digitalocean", ok: digitalocean, env: "DIGITALOCEAN_TOKEN" },
    { name: "neon", ok: neon, env: "NEON_API_KEY" },
    { name: "upstash", ok: upstash, env: "UPSTASH_EMAIL + UPSTASH_API_KEY" },
  ];

  return {
    vercel,
    digitalocean,
    neon,
    upstash,
    configured: rows.filter((r) => r.ok).map((r) => r.name),
    missing: rows.filter((r) => !r.ok).map((r) => `${r.name} (set ${r.env})`),
  };
}

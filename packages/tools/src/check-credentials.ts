/**
 * checkCredentials - report which provider credentials are present in the
 * server's environment, so the host AI can route around missing providers
 * before doing expensive work (building images, provisioning a DB, etc.).
 *
 * Reads only PRESENCE via the existing getProviderToken / getDbCredentials
 * resolvers (which read env vars); it never reads out or echoes a credential
 * value. No network, no filesystem.
 */
import type { CheckCredentialsOutput } from "@beam-me-up/core";
import { getDbCredentials, getProviderToken } from "@beam-me-up/adapters";

export function checkCredentials(): CheckCredentialsOutput {
  const vercel = getProviderToken("vercel") !== null;
  const digitalocean = getProviderToken("digitalocean") !== null;
  const neon = getDbCredentials("postgres") !== null;
  const upstash = getDbCredentials("redis") !== null;

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

/**
 * selectAdapter - the single place that maps a provider id to a concrete
 * DeployTarget. M1 ships Vercel; DigitalOcean is reserved for M4 and throws a
 * clear "not implemented until M4" error so callers fail loudly (the deploy
 * tools turn this into a friendly isError result before it ever bubbles up).
 */
import type { DeployTarget, ProviderToken } from "./deploy/interface.js";
import { VercelAdapter } from "./deploy/vercel/index.js";

export function selectAdapter(
  provider: "vercel" | "digitalocean",
  token: ProviderToken,
): DeployTarget {
  switch (provider) {
    case "vercel":
      return new VercelAdapter(token);
    case "digitalocean":
      throw new Error(
        "DigitalOcean adapter is not implemented until M4 — use provider: vercel for now.",
      );
    default: {
      // Exhaustiveness guard: if a new provider id is added to the union, this
      // line will fail to compile until selectAdapter handles it.
      const _never: never = provider;
      throw new Error(`Unknown deploy provider: ${String(_never)}`);
    }
  }
}

/**
 * selectAdapter - the single place that maps a provider id to a concrete
 * DeployTarget. M1 ships Vercel; M4 adds DigitalOcean (App Platform,
 * container-image deploys). Both implement the same DeployTarget contract.
 */
import type { DeployTarget, ProviderToken } from "./deploy/interface.js";
import { VercelAdapter } from "./deploy/vercel/index.js";
import { DigitalOceanAdapter } from "./deploy/digitalocean/index.js";

export function selectAdapter(
  provider: "vercel" | "digitalocean",
  token: ProviderToken,
): DeployTarget {
  switch (provider) {
    case "vercel":
      return new VercelAdapter(token);
    case "digitalocean":
      return new DigitalOceanAdapter(token);
    default: {
      // Exhaustiveness guard: if a new provider id is added to the union, this
      // line will fail to compile until selectAdapter handles it.
      const _never: never = provider;
      throw new Error(`Unknown deploy provider: ${String(_never)}`);
    }
  }
}

/**
 * selectDbProvisioner - the single place that maps a database engine to a
 * concrete DbProvisioner. Mirrors src/adapters/registry.ts (the M1 deploy
 * registry): postgres -> Neon, redis -> Upstash.
 *
 * The creds union is narrowed by engine: postgres expects NeonCreds, redis
 * expects UpstashCreds. The exhaustiveness guard makes adding a new engine to
 * the DbEngine union a compile error until this function handles it.
 */
import type {
  DbEngine,
  DbProvisioner,
  NeonCreds,
  UpstashCreds,
} from "./interface.js";
import { NeonProvisioner } from "./neon/index.js";
import { UpstashProvisioner } from "./upstash/index.js";

export function selectDbProvisioner(
  engine: DbEngine,
  creds: NeonCreds | UpstashCreds,
): DbProvisioner {
  switch (engine) {
    case "postgres":
      return new NeonProvisioner(creds as NeonCreds);
    case "redis":
      return new UpstashProvisioner(creds as UpstashCreds);
    default: {
      // Exhaustiveness guard: if a new engine id is added to the union, this
      // line will fail to compile until selectDbProvisioner handles it.
      const _never: never = engine;
      throw new Error(`Unknown database engine: ${String(_never)}`);
    }
  }
}

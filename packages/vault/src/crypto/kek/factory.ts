/**
 * buildKekProvider — selects a KekProvider from the environment with the
 * MANDATORY hosted guardrail.
 *
 * Guardrail: if BEAM_TIER=hosted and BEAM_KEK_PROVIDER is `local-dev` (or
 * unset), this THROWS — a KMS-backed KEK is mandatory for hosted; there is no
 * single-static-key fallback for that tier. (Mirrors http.ts already refusing
 * an unauthenticated non-loopback start.)
 *
 * The KMS providers are loaded via dynamic import() so self-host installs never
 * pull the AWS / GCP SDKs. In M9 P2 only the local-dev path is exercised end to
 * end; the KMS adapters are shapes.
 */
import type { KekProvider } from "./interface.js";
import { LocalDevKekProvider, decodeLocalKek } from "./local-dev.js";

export type KekProviderKind = "local-dev" | "aws-kms" | "gcp-kms";

export interface BuildKekOptions {
  /** True when BEAM_TIER=hosted; enforces the no-local-dev guardrail. */
  hosted: boolean;
  /** Read-from defaults to process.env; injectable for tests. */
  env?: NodeJS.ProcessEnv;
}

export async function buildKekProvider(opts: BuildKekOptions): Promise<KekProvider> {
  const env = opts.env ?? process.env;
  const kind = (env.BEAM_KEK_PROVIDER ?? "local-dev") as KekProviderKind;

  // ----- Hosted guardrail: no in-process KEK on hosted. -------------------
  if (opts.hosted && (kind === "local-dev" || !env.BEAM_KEK_PROVIDER)) {
    throw new Error(
      "BEAM_KEK_PROVIDER=local-dev is forbidden when BEAM_TIER=hosted; " +
        "a KMS-backed KEK is mandatory for hosted (no single-static-key fallback).",
    );
  }

  switch (kind) {
    case "local-dev": {
      const secret = env.BEAM_KEK_LOCAL_SECRET;
      if (!secret) {
        throw new Error(
          "BEAM_KEK_LOCAL_SECRET is required for BEAM_KEK_PROVIDER=local-dev.",
        );
      }
      return new LocalDevKekProvider(decodeLocalKek(secret));
    }
    case "aws-kms": {
      const keyId = env.BEAM_KMS_KEY_ID;
      if (!keyId) {
        throw new Error("BEAM_KMS_KEY_ID is required for BEAM_KEK_PROVIDER=aws-kms.");
      }
      const { AwsKmsKekProvider } = await import("./aws-kms.js");
      return new AwsKmsKekProvider({ keyId });
    }
    case "gcp-kms": {
      const keyId = env.BEAM_KMS_KEY_ID;
      if (!keyId) {
        throw new Error("BEAM_KMS_KEY_ID is required for BEAM_KEK_PROVIDER=gcp-kms.");
      }
      const { GcpKmsKekProvider } = await import("./gcp-kms.js");
      return new GcpKmsKekProvider({ keyId });
    }
    default:
      throw new Error(`Unknown BEAM_KEK_PROVIDER: ${String(kind)}`);
  }
}

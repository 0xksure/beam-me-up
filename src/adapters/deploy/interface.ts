/**
 * DeployTarget - the pluggable adapter contract for "create a project, set its
 * env, upload local files + deploy, read the logs" against a hosting provider.
 *
 * M1 ships the Vercel adapter (src/adapters/deploy/vercel). DigitalOcean (M4)
 * slots in behind the same interface later.
 *
 * The deploy tools (src/tools/deploy-tools.ts) only ever talk to a DeployTarget;
 * they never reach into a provider's REST API directly. The registry
 * (src/adapters/registry.ts) hands them the right adapter for a provider id.
 */
import type { RepoSignals } from "../../schemas.js";

/** Credentials for a provider: the API token + optional team/org scope. */
export type ProviderToken = { token: string; teamId?: string };

/** Normalised deploy status across providers. */
export type DeployStatus =
  | "queued"
  | "building"
  | "ready"
  | "error"
  | "canceled";

/**
 * A single file to upload as part of a deployment. Exactly one of `content`
 * (utf-8 text) or `contentBase64` (binary, base64-encoded) should be set.
 */
export type DeployFile = {
  path: string;
  content?: string;
  contentBase64?: string;
};

/** An environment variable to set on a deploy target. */
export type EnvVar = {
  key: string;
  value: string;
  /** When true, store as a sensitive/secret value (never read back). */
  secret?: boolean;
  /** Deploy environments this var applies to, e.g. ["production","preview"]. */
  targets?: string[];
};

/**
 * The provider-agnostic deploy adapter. Every method is a thin, typed promise
 * over a provider REST call (or a pure decision, in detectFit's case).
 */
export interface DeployTarget {
  /** Stable provider id this adapter implements. */
  readonly id: "vercel" | "digitalocean";

  /**
   * Pure fitness check: given the repo signals, does this target make sense?
   * Mirrors routeTarget's logic from the adapter's point of view.
   */
  detectFit(signals: RepoSignals): {
    fits: boolean;
    confidence: number;
    reasons: string[];
  };

  /** Create (or look up) the project/app on the provider. */
  createProject(input: {
    name: string;
    framework?: string;
  }): Promise<{ targetId: string; dashboardUrl: string }>;

  /** Upsert environment variables on the target. */
  setEnvVars(input: {
    targetId: string;
    vars: EnvVar[];
  }): Promise<{ setCount: number; applied: string[] }>;

  /** Upload the local files and create a deployment. */
  deploy(input: {
    targetId: string;
    projectName: string;
    framework?: string;
    files: DeployFile[];
    target?: "production" | "preview";
  }): Promise<{ deploymentId: string; url?: string; status: DeployStatus }>;

  /** Read build (or runtime) logs for a deployment. */
  getLogs(input: {
    deploymentId: string;
    type?: "build" | "runtime";
  }): Promise<{ status: DeployStatus; logText: string; summary?: string }>;

  /** Resolve the (public) URL of a deployment. */
  getUrl(input: { deploymentId: string }): Promise<{ url: string }>;
}

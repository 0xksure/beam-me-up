/**
 * VercelAdapter - implements the DeployTarget contract for Vercel by composing:
 *   - VercelClient        (low-level REST wrapper, swappable global fetch)
 *   - projects.ts         (createProjectImpl, setEnvVarsImpl)
 *   - deploy.ts           (deployImpl, getLogsImpl, getUrlImpl)
 *
 * The adapter itself is thin: each DeployTarget method constructs the client
 * once (in the ctor) and delegates to the matching *Impl function. detectFit is
 * pure and reuses the project's routeTarget decision logic so the adapter and
 * the route_target tool never disagree about whether Vercel fits a repo.
 */
import type { RepoSignals } from "@beam-me-up/core";
import { routeTarget } from "@beam-me-up/detect";
import type {
  DeployFile,
  DeployStatus,
  DeployTarget,
  EnvVar,
  ProviderToken,
} from "../interface.js";
import { VercelClient } from "./client.js";
import { createProjectImpl, setEnvVarsImpl } from "./projects.js";
import { deployImpl, getLogsImpl, getUrlImpl } from "./deploy.js";

export class VercelAdapter implements DeployTarget {
  readonly id = "vercel" as const;

  readonly #client: VercelClient;

  constructor(token: ProviderToken) {
    this.#client = new VercelClient(token);
  }

  /**
   * Pure fitness check. Reuses routeTarget: Vercel "fits" when the routing
   * decision is target:"vercel". Confidence + reasons come straight from the
   * shared decision logic so this never drifts from route_target.
   */
  detectFit(signals: RepoSignals): {
    fits: boolean;
    confidence: number;
    reasons: string[];
  } {
    const decision = routeTarget({ signals });
    return {
      fits: decision.target === "vercel",
      confidence: decision.confidence,
      reasons: decision.reasons,
    };
  }

  createProject(input: {
    name: string;
    framework?: string;
  }): Promise<{ targetId: string; dashboardUrl: string }> {
    return createProjectImpl(this.#client, input);
  }

  setEnvVars(input: {
    targetId: string;
    vars: EnvVar[];
  }): Promise<{ setCount: number; applied: string[] }> {
    return setEnvVarsImpl(this.#client, input);
  }

  deploy(input: {
    targetId: string;
    projectName: string;
    framework?: string;
    files: DeployFile[];
    target?: "production" | "preview";
  }): Promise<{ deploymentId: string; url?: string; status: DeployStatus }> {
    return deployImpl(this.#client, input);
  }

  getLogs(input: {
    deploymentId: string;
    type?: "build" | "runtime";
  }): Promise<{ status: DeployStatus; logText: string; summary?: string }> {
    return getLogsImpl(this.#client, input);
  }

  getUrl(input: { deploymentId: string }): Promise<{ url: string }> {
    return getUrlImpl(this.#client, input);
  }
}

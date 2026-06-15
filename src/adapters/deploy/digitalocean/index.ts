/**
 * DigitalOceanAdapter - implements the DeployTarget contract for DigitalOcean
 * App Platform (container-image deploys) by composing DigitalOceanClient (the
 * REST plumbing) and the pure app-spec helpers.
 *
 * Mirrors VercelAdapter (src/adapters/deploy/vercel/index.ts): thin methods over
 * the provider API. Verified against the DO OpenAPI spec on 2026-06-15.
 *
 * KEY MODEL DIFFERENCE vs Vercel: a DO "app" is ONE spec that holds the image
 * AND the env vars; POST /v2/apps and PUT /v2/apps/{id} both auto-trigger a
 * deployment (read its id from response `app.pending_deployment.id`). So:
 *
 *   detectFit(signals): pure container-fitness — fits=true when a
 *     container-forcing signal is present (wsServer / workers /
 *     composeAppServices>1 / longHandlers / persistentFsWrites / listensOnPort),
 *     or a Dockerfile is present (supporting, weaker). Mirror routeTarget's
 *     container branch for reasons + confidence; fits=false (low confidence)
 *     for a clean stateless app (that one belongs on Vercel).
 *
 *   createProject({ name }): IDEMPOTENT.
 *     1. GET /v2/apps (page through if needed) and find an app whose
 *        spec.name === name. If found -> return its id (this is the "redeploy an
 *        already-deployed app" path).
 *     2. Else POST /v2/apps { spec: buildPlaceholderSpec(name) } — a valid spec
 *        using PLACEHOLDER_IMAGE so the app exists for setEnvVars; the first real
 *        deploy() replaces the image.
 *     Return { targetId: app.id, dashboardUrl:
 *       `https://cloud.digitalocean.com/apps/${app.id}` }.
 *
 *   setEnvVars({ targetId, vars }):
 *     1. GET /v2/apps/{targetId} -> app.spec.
 *     2. spec = mergeEnvs(spec, vars)  (upsert into services[0].envs; secret ->
 *        type "SECRET", else "GENERAL"; scope "RUN_AND_BUILD_TIME"). Existing
 *        SECRET values come back encrypted on GET — keep them as-is on PUT.
 *     3. PUT /v2/apps/{targetId} { spec }.
 *     Return { setCount: vars.length, applied: vars.map(v => v.key) }.
 *
 *   deploy({ targetId, image }):  (the deploy tool guarantees `image` is set)
 *     1. GET /v2/apps/{targetId} -> app.spec.
 *     2. spec = setServiceImage(spec, image)  (parseImageRef under the hood).
 *     3. PUT /v2/apps/{targetId} { spec } -> response app.
 *     4. deploymentId = encodeDeploymentId(targetId, app.pending_deployment.id);
 *        url = httpsUrl(app.live_url ?? app.default_ingress);
 *        status = mapPhase(app.pending_deployment.phase).
 *
 *   getLogs({ deploymentId, type }):
 *     1. { appId, deploymentId } = decodeDeploymentId(deploymentId).
 *     2. GET /v2/apps/{appId}/deployments/{deploymentId} -> phase + progress;
 *        status = mapPhase(phase).
 *     3. GET /v2/apps/{appId}/deployments/{deploymentId}/logs?type=BUILD (map the
 *        optional `type`: "runtime" -> RUN, else BUILD) -> { historic_urls,
 *        live_url }. If historic_urls[0] exists, client.fetchLogText(it) for the
 *        real text; else fall back to a short note about live_url.
 *     4. summary = a one-line phase/progress summary (e.g. "phase ERROR
 *        (3/5 steps, 1 error)"); on an ERROR phase include the error step name
 *        if present. Return { status, logText, summary }.
 *
 *   getUrl({ deploymentId }): decode -> GET /v2/apps/{appId} ->
 *     { url: httpsUrl(app.live_url ?? app.default_ingress) }.
 *
 * Tokens / secret env values are never logged.
 *
 * STUB (M4 skeleton): the bodies are filled in by the implementer; the
 * signatures are final.
 */
import type { RepoSignals } from "../../../schemas.js";
import { routeTarget } from "../../../tools/route-target.js";
import type {
  DeployFile,
  DeployStatus,
  DeployTarget,
  EnvVar,
  ProviderToken,
} from "../interface.js";
import { DigitalOceanClient } from "./client.js";
import {
  type DoAppSpec,
  buildPlaceholderSpec,
  decodeDeploymentId,
  encodeDeploymentId,
  mapPhase,
  mergeEnvs,
  setServiceImage,
} from "./app-spec.js";

/* ------------------------------------------------------------------ */
/* Raw DO response shapes (only the fields we read)                    */
/* ------------------------------------------------------------------ */

/** A deployment created by POST/PUT, surfaced on the app as `pending_deployment`. */
type DoPendingDeployment = {
  id: string;
  phase: string;
};

/** A DO App Platform app (`apps_get` / wrapped in `{ app }`). */
type DoApp = {
  id: string;
  default_ingress?: string;
  live_url?: string;
  spec?: DoAppSpec;
  pending_deployment?: DoPendingDeployment;
};

/** A DO deployment record (`apps_get_deployment`, wrapped in `{ deployment }`). */
type DoDeploymentProgress = {
  total_steps?: number;
  success_steps?: number;
  error_steps?: number;
  pending_steps?: number;
  running_steps?: number;
  steps?: { name?: string; status?: string; reason?: { code?: string } }[];
};

type DoDeployment = {
  id: string;
  phase: string;
  progress?: DoDeploymentProgress;
};

/** GET .../logs response: log files live behind presigned URLs. */
type DoLogsResponse = {
  historic_urls?: string[];
  live_url?: string;
};

type DoAppsListResponse = {
  apps?: DoApp[];
  links?: { pages?: { next?: string } };
  meta?: { total?: number };
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Prefix a bare DO host (e.g. "web-app-abc.ondigitalocean.app") with https://
 * Idempotent if the value is already an absolute http(s) URL. Returns "" for an
 * absent/empty host so getUrl always yields a string.
 */
function httpsUrl(url: string | undefined): string {
  if (url === undefined || url.length === 0) return "";
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * Build a one-line phase/progress summary, e.g.
 * "phase ACTIVE (5/5 steps)" or "phase ERROR (3/5 steps, 1 error: build)".
 * On an ERROR phase the first failing step name is appended when present.
 */
function summarize(
  phase: string,
  progress: DoDeploymentProgress | undefined,
): string {
  const total = progress?.total_steps ?? 0;
  const success = progress?.success_steps ?? 0;
  const errors = progress?.error_steps ?? 0;

  let line = `phase ${phase} (${success}/${total} steps`;
  if (errors > 0) {
    line += `, ${errors} error${errors === 1 ? "" : "s"}`;
    if (phase.toUpperCase() === "ERROR") {
      const failed = (progress?.steps ?? []).find(
        (s) => (s.status ?? "").toUpperCase() === "ERROR",
      );
      if (failed?.name) line += `: ${failed.name}`;
    }
  }
  return `${line})`;
}

export class DigitalOceanAdapter implements DeployTarget {
  readonly id = "digitalocean" as const;

  readonly #client: DigitalOceanClient;

  constructor(token: ProviderToken) {
    this.#client = new DigitalOceanClient(token);
  }

  /**
   * Pure container-fitness check. Reuses routeTarget so the adapter never drifts
   * from the route_target tool: DigitalOcean (a container host) "fits" exactly
   * when the routing decision is target:"container". A clean stateless app
   * routes to Vercel, so fits=false there. Confidence + reasons come straight
   * from the shared decision logic.
   */
  detectFit(signals: RepoSignals): {
    fits: boolean;
    confidence: number;
    reasons: string[];
  } {
    const decision = routeTarget({ signals });
    return {
      fits: decision.target === "container",
      confidence: decision.confidence,
      reasons: decision.reasons,
    };
  }

  /**
   * Create (or look up) the DO app. Idempotent: an existing app whose
   * spec.name matches is reused (the redeploy path); otherwise a placeholder
   * app is created so setEnvVars has something to write to before the first
   * real deploy() swaps in the user's image.
   */
  async createProject(input: {
    name: string;
    framework?: string;
  }): Promise<{ targetId: string; dashboardUrl: string }> {
    const existing = await this.#findAppByName(input.name);
    if (existing) {
      return {
        targetId: existing.id,
        dashboardUrl: `https://cloud.digitalocean.com/apps/${existing.id}`,
      };
    }

    const res = await this.#client.request<{ app: DoApp }>("POST", "/v2/apps", {
      body: { spec: buildPlaceholderSpec(input.name) },
    });
    return {
      targetId: res.app.id,
      dashboardUrl: `https://cloud.digitalocean.com/apps/${res.app.id}`,
    };
  }

  /**
   * Upsert env vars into the app's single service. Existing SECRET values come
   * back encrypted on GET and are written straight back on PUT (we never log or
   * mutate them). PUT auto-triggers a deployment but we only report the upsert.
   */
  async setEnvVars(input: {
    targetId: string;
    vars: EnvVar[];
  }): Promise<{ setCount: number; applied: string[] }> {
    const { app } = await this.#client.request<{ app: DoApp }>(
      "GET",
      `/v2/apps/${input.targetId}`,
    );
    const spec = mergeEnvs(this.#requireSpec(app), input.vars);
    await this.#client.request<{ app: DoApp }>(
      "PUT",
      `/v2/apps/${input.targetId}`,
      { body: { spec } },
    );
    return {
      setCount: input.vars.length,
      applied: input.vars.map((v) => v.key),
    };
  }

  /**
   * Deploy a registry image: read the current spec, swap services[0].image to
   * the parsed image source, PUT it back (DO auto-creates the deployment), and
   * surface the pending deployment's composite id, public URL, and status.
   * The deploy tool guarantees `image` is present for DigitalOcean.
   */
  async deploy(input: {
    targetId: string;
    projectName: string;
    framework?: string;
    files?: DeployFile[];
    image?: string;
    target?: "production" | "preview";
  }): Promise<{ deploymentId: string; url?: string; status: DeployStatus }> {
    if (!input.image) {
      throw new Error(
        "DigitalOceanAdapter.deploy requires an `image` reference.",
      );
    }

    const { app } = await this.#client.request<{ app: DoApp }>(
      "GET",
      `/v2/apps/${input.targetId}`,
    );
    const spec = setServiceImage(this.#requireSpec(app), input.image);

    const res = await this.#client.request<{ app: DoApp }>(
      "PUT",
      `/v2/apps/${input.targetId}`,
      { body: { spec } },
    );

    const pending = res.app.pending_deployment;
    if (!pending) {
      throw new Error(
        "DigitalOcean did not return a pending deployment for the spec update.",
      );
    }

    const url = httpsUrl(res.app.live_url ?? res.app.default_ingress);
    return {
      deploymentId: encodeDeploymentId(input.targetId, pending.id),
      url: url.length > 0 ? url : undefined,
      status: mapPhase(pending.phase),
    };
  }

  /**
   * Read build (default) or runtime logs for a deployment. The composite
   * deploymentId decodes to { appId, deploymentId }; we read the deployment for
   * status + progress, then fetch the (presigned) historic log file for real
   * text, falling back to a note about the live stream when none exists yet.
   */
  async getLogs(input: {
    deploymentId: string;
    type?: "build" | "runtime";
  }): Promise<{ status: DeployStatus; logText: string; summary?: string }> {
    const { appId, deploymentId } = decodeDeploymentId(input.deploymentId);

    const { deployment } = await this.#client.request<{
      deployment: DoDeployment;
    }>("GET", `/v2/apps/${appId}/deployments/${deploymentId}`);

    const status = mapPhase(deployment.phase);
    const logType = input.type === "runtime" ? "RUN" : "BUILD";

    const logs = await this.#client.request<DoLogsResponse>(
      "GET",
      `/v2/apps/${appId}/deployments/${deploymentId}/logs`,
      { query: { type: logType } },
    );

    const historic = logs.historic_urls?.[0];
    let logText: string;
    if (historic) {
      logText = await this.#client.fetchLogText(historic);
    } else if (logs.live_url) {
      logText = `No historic log file yet; live logs stream at ${logs.live_url}`;
    } else {
      logText = "";
    }

    return {
      status,
      logText,
      summary: summarize(deployment.phase, deployment.progress),
    };
  }

  /** Resolve the app's public URL from its live_url / default_ingress. */
  async getUrl(input: { deploymentId: string }): Promise<{ url: string }> {
    const { appId } = decodeDeploymentId(input.deploymentId);
    const { app } = await this.#client.request<{ app: DoApp }>(
      "GET",
      `/v2/apps/${appId}`,
    );
    return { url: httpsUrl(app.live_url ?? app.default_ingress) };
  }

  /* ------------------------------------------------------------------ */
  /* internals                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Page through GET /v2/apps and return the first app whose spec.name matches,
   * or undefined. Follows `links.pages.next` (an absolute URL) when present.
   */
  async #findAppByName(name: string): Promise<DoApp | undefined> {
    let path = "/v2/apps";
    // Bound the paging so a pathological account can't loop forever.
    for (let page = 0; page < 100; page += 1) {
      const res = await this.#client.request<DoAppsListResponse>("GET", path);
      const match = (res.apps ?? []).find((a) => a.spec?.name === name);
      if (match) return match;

      const next = res.links?.pages?.next;
      if (!next) return undefined;
      // `next` is an absolute api.digitalocean.com URL; reduce it to a path.
      path = next.replace(/^https?:\/\/[^/]+/i, "");
    }
    return undefined;
  }

  /** Narrow an app's optional spec to a present one (DO always returns it). */
  #requireSpec(app: DoApp): DoAppSpec {
    if (!app.spec) {
      throw new Error(`DigitalOcean app ${app.id} returned no spec.`);
    }
    return app.spec;
  }
}

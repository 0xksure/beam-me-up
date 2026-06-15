/**
 * Pure helpers for building + reading DigitalOcean App Platform specs (M4).
 *
 * No network, no fetch — just data shaping, so they are unit-tested directly.
 * Verified against the DO OpenAPI spec (apps_create / app_spec /
 * apps_image_source_spec / app_variable_definition / apps_deployment_phase) on
 * 2026-06-15.
 *
 * Exports (all pure):
 *   parseImageRef(image)            -> DoImageSource
 *   buildPlaceholderSpec(name,...)  -> DoAppSpec   (used by createProject)
 *   setServiceImage(spec, image)    -> DoAppSpec   (used by deploy)
 *   mergeEnvs(spec, vars)           -> DoAppSpec   (used by setEnvVars)
 *   mapPhase(phase)                 -> DeployStatus
 *   encodeDeploymentId(appId, depId)-> string  ("<appId>:<depId>")
 *   decodeDeploymentId(id)          -> { appId, deploymentId }
 *
 * Image-ref parsing (DO registry_type is DOCKER_HUB | DOCR | GHCR):
 *   - "registry.digitalocean.com/<reg>/<repo>:<tag>" -> { registry_type:"DOCR",
 *       repository:"<repo>", tag } — `registry` is LEFT EMPTY for DOCR (DO infers
 *       it from the account); the "<reg>" path segment is dropped.
 *   - "ghcr.io/<owner>/<repo>:<tag>" -> { registry_type:"GHCR",
 *       registry:"<owner>", repository:"<repo>", tag }.
 *   - "docker.io/<owner>/<repo>:<tag>" or "registry.hub.docker.com/..." or a
 *       bare "<owner>/<repo>:<tag>" -> { registry_type:"DOCKER_HUB",
 *       registry:"<owner>", repository:"<repo>", tag }.
 *   - a bare official image "<repo>:<tag>" (no slash) -> DOCKER_HUB with
 *       registry "library".
 *   - tag defaults to "latest". A "<...>@sha256:<digest>" ref sets `digest`
 *       instead of `tag` (the two are mutually exclusive in the DO spec).
 *   - An unsupported registry host (e.g. gcr.io, quay.io) THROWS with a clear
 *       message — the adapter turns it into a friendly { error }.
 *
 * mapPhase (DO deployment phase -> normalised DeployStatus):
 *   UNKNOWN -> "queued"; PENDING_BUILD/PENDING_DEPLOY -> "queued";
 *   BUILDING/DEPLOYING -> "building"; ACTIVE -> "ready"; ERROR -> "error";
 *   CANCELED/SUPERSEDED -> "canceled".
 *
 * STUB (M4 skeleton): the bodies are filled in by the implementer; the
 * signatures + the exported types are final.
 */
import type { DeployStatus, EnvVar } from "../interface.js";

/** A DO App Platform service `image` source. */
export type DoImageSource = {
  registry_type: "DOCKER_HUB" | "DOCR" | "GHCR";
  registry?: string;
  repository: string;
  tag?: string;
  digest?: string;
};

/** A DO env var (`app_variable_definition`). */
export type DoEnvVar = {
  key: string;
  value: string;
  type: "GENERAL" | "SECRET";
  scope: "RUN_AND_BUILD_TIME" | "RUN_TIME" | "BUILD_TIME";
};

/** A DO App Platform service (`app_service_spec`), image-based subset. */
export type DoServiceSpec = {
  name: string;
  image: DoImageSource;
  instance_size_slug: string;
  instance_count: number;
  http_port: number;
  envs?: DoEnvVar[];
};

/** A DO App Platform app spec (`app_spec`), the subset we produce. */
export type DoAppSpec = {
  name: string;
  region?: string;
  services: DoServiceSpec[];
};

/** Defaults for a tiny service (current valid DO values, see research). */
export const DEFAULT_REGION = "nyc";
export const DEFAULT_INSTANCE_SIZE = "apps-s-1vcpu-0.5gb";
export const DEFAULT_INSTANCE_COUNT = 1;
export const DEFAULT_HTTP_PORT = 8080;

/**
 * The placeholder image createProject uses so the app spec is valid before the
 * real image is known (the first real `deploy` replaces it). A tiny, public
 * Docker Hub image.
 */
export const PLACEHOLDER_IMAGE: DoImageSource = {
  registry_type: "DOCKER_HUB",
  registry: "library",
  repository: "nginx",
  tag: "alpine",
};

/**
 * Parse a docker image reference into a DO `image` source.
 *
 * Splits an optional `@sha256:<digest>` suffix first (digest and tag are
 * mutually exclusive in the DO spec), then a trailing `:<tag>` (tag defaults
 * to "latest" when neither digest nor tag is given), then routes on the
 * registry host:
 *   - registry.digitalocean.com -> DOCR (registry dropped, DO infers it).
 *   - ghcr.io                   -> GHCR (registry = owner).
 *   - docker.io / registry.hub.docker.com / a bare ref -> DOCKER_HUB.
 *   - a bare official image with no slash -> DOCKER_HUB, registry "library".
 *   - any other host (gcr.io, quay.io, ...) THROWS.
 */
export function parseImageRef(image: string): DoImageSource {
  const ref = image.trim();
  if (ref.length === 0) {
    throw new Error("image reference is empty");
  }

  // Peel an optional "@sha256:<digest>" suffix off the end first.
  let digest: string | undefined;
  let rest = ref;
  const atIndex = rest.indexOf("@");
  if (atIndex !== -1) {
    digest = rest.slice(atIndex + 1);
    rest = rest.slice(0, atIndex);
  }

  // Then peel a trailing ":<tag>". A ":" only counts as a tag separator when
  // it appears in the LAST path segment (host ports would also contain a ":",
  // but the supported hosts here never carry one).
  let tag: string | undefined;
  const lastSlash = rest.lastIndexOf("/");
  const lastColon = rest.lastIndexOf(":");
  if (lastColon > lastSlash) {
    tag = rest.slice(lastColon + 1);
    rest = rest.slice(0, lastColon);
  }

  // `rest` is now "<host>/<...path>" or a bare "<repo>" / "<owner>/<repo>".
  const segments = rest.split("/");
  const first = segments[0] ?? "";
  const hasHost = segments.length > 1 && /[.:]/.test(first);

  let result: DoImageSource;
  if (hasHost) {
    const host = first;
    const pathSegments = segments.slice(1);
    if (host === "registry.digitalocean.com") {
      // registry.digitalocean.com/<reg>/<repo> -> DOCR, drop <reg>, no registry.
      const repository = pathSegments.slice(1).join("/");
      result = { registry_type: "DOCR", repository };
    } else if (host === "ghcr.io") {
      const registry = pathSegments[0];
      const repository = pathSegments.slice(1).join("/");
      result = { registry_type: "GHCR", registry, repository };
    } else if (host === "docker.io" || host === "registry.hub.docker.com") {
      const registry = pathSegments[0];
      const repository = pathSegments.slice(1).join("/");
      result = { registry_type: "DOCKER_HUB", registry, repository };
    } else {
      throw new Error(`unsupported image registry host: ${host}`);
    }
  } else if (segments.length > 1) {
    // Bare "<owner>/<repo>" -> Docker Hub.
    const registry = first;
    const repository = segments.slice(1).join("/");
    result = { registry_type: "DOCKER_HUB", registry, repository };
  } else {
    // Bare official image "<repo>" (no slash) -> Docker Hub "library".
    result = {
      registry_type: "DOCKER_HUB",
      registry: "library",
      repository: first,
    };
  }

  if (digest !== undefined) {
    result.digest = digest;
  } else {
    result.tag = tag ?? "latest";
  }
  return result;
}

/**
 * Build a minimal-but-valid app spec for `createProject`, using the
 * PLACEHOLDER_IMAGE so the spec is accepted before the real image is known.
 * The first real `deploy` swaps the image in via setServiceImage.
 */
export function buildPlaceholderSpec(
  name: string,
  opts?: { region?: string },
): DoAppSpec {
  return {
    name,
    region: opts?.region ?? DEFAULT_REGION,
    services: [
      {
        name: "web",
        image: { ...PLACEHOLDER_IMAGE },
        instance_size_slug: DEFAULT_INSTANCE_SIZE,
        instance_count: DEFAULT_INSTANCE_COUNT,
        http_port: DEFAULT_HTTP_PORT,
        envs: [],
      },
    ],
  };
}

/**
 * Replace the first service's `image` with the parsed `image` ref, returning a
 * new spec (the input is not mutated). Other service fields are preserved.
 */
export function setServiceImage(spec: DoAppSpec, image: string): DoAppSpec {
  const services = spec.services.map((svc, index) =>
    index === 0 ? { ...svc, image: parseImageRef(image) } : svc,
  );
  return { ...spec, services };
}

/**
 * Upsert `vars` into the first service's `envs` by key, returning a new spec.
 * Each var becomes a SECRET when `secret` is truthy (else GENERAL), with scope
 * RUN_AND_BUILD_TIME. Existing envs not present in `vars` are preserved.
 */
export function mergeEnvs(spec: DoAppSpec, vars: EnvVar[]): DoAppSpec {
  const services = spec.services.map((svc, index) => {
    if (index !== 0) return svc;
    const envs: DoEnvVar[] = [...(svc.envs ?? [])];
    for (const v of vars) {
      const entry: DoEnvVar = {
        key: v.key,
        value: v.value,
        type: v.secret ? "SECRET" : "GENERAL",
        scope: "RUN_AND_BUILD_TIME",
      };
      const existing = envs.findIndex((e) => e.key === v.key);
      if (existing === -1) {
        envs.push(entry);
      } else {
        envs[existing] = entry;
      }
    }
    return { ...svc, envs };
  });
  return { ...spec, services };
}

/** Map a DO deployment phase to a normalised DeployStatus. */
export function mapPhase(phase: string): DeployStatus {
  switch (phase) {
    case "PENDING_BUILD":
    case "PENDING_DEPLOY":
    case "UNKNOWN":
      return "queued";
    case "BUILDING":
    case "DEPLOYING":
      return "building";
    case "ACTIVE":
      return "ready";
    case "ERROR":
      return "error";
    case "CANCELED":
    case "SUPERSEDED":
      return "canceled";
    default:
      return "queued";
  }
}

/**
 * Encode an (appId, deploymentId) pair into our single opaque deployment id.
 * DO ids contain no ":", so a ":" is a safe, reversible separator.
 */
export function encodeDeploymentId(appId: string, deploymentId: string): string {
  return `${appId}:${deploymentId}`;
}

/** Reverse encodeDeploymentId, splitting on the FIRST ":". */
export function decodeDeploymentId(id: string): {
  appId: string;
  deploymentId: string;
} {
  const sep = id.indexOf(":");
  if (sep === -1) {
    throw new Error(`malformed deployment id: ${id}`);
  }
  return {
    appId: id.slice(0, sep),
    deploymentId: id.slice(sep + 1),
  };
}

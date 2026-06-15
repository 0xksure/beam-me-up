import type {
  RepoSignals,
  RouteTargetInput,
  RouteTargetOutput,
} from "@beam-me-up/core";

/**
 * routeTarget - pure decision logic for Vercel vs container.
 *
 * Locked design: Vercel-first, DigitalOcean fallback. Recommend a container
 * host (target:"container", recommendedProvider:"digitalocean") when ANY of
 * the following "container-forcing" signals are present:
 *
 *   - signals.wsServer            (long-lived websocket server)
 *   - signals.workers             (background job processors)
 *   - signals.composeAppServices > 1 (multi-service app)
 *   - signals.longHandlers        (long-running / streaming handlers)
 *   - signals.persistentFsWrites  (needs a durable disk)
 *   - signals.listensOnPort       (a long-lived listener / always-on server)
 *
 * A bare Dockerfile is NOT decisive on its own (you can still deploy a
 * containerised-but-stateless app to Vercel). Otherwise -> Vercel.
 *
 * Confidence in [0,1]: high when signals are unanimous (all point one way),
 * lower when they are mixed/ambiguous (e.g. a couple of weak container
 * signals, or a serverless-friendly framework that nonetheless trips a
 * single container heuristic).
 */
export function routeTarget(input: RouteTargetInput): RouteTargetOutput {
  const signals = input.signals;
  const reasons: string[] = [];

  // Collect the container-forcing reasons in priority order.
  const containerReasons: string[] = [];

  if (signals.wsServer) {
    containerReasons.push(
      "Detected a server-side WebSocket server, which needs a long-lived process (not serverless functions).",
    );
  }
  if (signals.workers) {
    containerReasons.push(
      "Detected background workers / job queues (bull, celery, sidekiq, agenda or cron loops) that must run continuously.",
    );
  }
  if (signals.composeAppServices > 1) {
    containerReasons.push(
      `docker-compose declares ${signals.composeAppServices} application services; a multi-service app maps cleanly onto a container host.`,
    );
  }
  if (signals.longHandlers) {
    containerReasons.push(
      "Detected long-running / streaming request handlers that can exceed serverless execution limits.",
    );
  }
  if (signals.persistentFsWrites) {
    containerReasons.push(
      "Detected persistent filesystem writes (outside /tmp); serverless filesystems are ephemeral, so a durable disk is required.",
    );
  }
  if (signals.listensOnPort) {
    containerReasons.push(
      "App binds a long-lived listener (app.listen on a PORT); an always-on server fits a container, not request-scoped functions.",
    );
  }

  const isContainer = containerReasons.length > 0;

  if (isContainer) {
    reasons.push(...containerReasons);

    // Note the Dockerfile as supporting (not decisive) context.
    if (signals.hasDockerfile) {
      reasons.push(
        "A Dockerfile is already present, so a container image is ready to build (supporting evidence, not the deciding factor).",
      );
    }
    if (signals.framework) {
      reasons.push(`Framework detected: ${signals.framework}.`);
    }

    return {
      target: "container",
      recommendedProvider: "digitalocean",
      confidence: computeContainerConfidence(signals, containerReasons.length),
      reasons,
    };
  }

  // ---- Vercel path ----------------------------------------------------
  reasons.push(
    "No container-forcing signals detected (no websocket server, workers, multi-service compose, long/streaming handlers, persistent disk writes, or always-on listener).",
  );

  if (signals.framework) {
    reasons.push(
      `Framework detected: ${signals.framework}${isServerlessFriendlyFramework(signals.framework) ? " (serverless-friendly on Vercel)." : "."}`,
    );
  }
  if (signals.hasDockerfile) {
    reasons.push(
      "A Dockerfile exists but is not decisive on its own; the app still looks stateless and request-scoped, so Vercel is recommended.",
    );
  }
  if (signals.composeAppServices === 1) {
    reasons.push(
      "Only a single application service is declared in docker-compose, which does not force a container host.",
    );
  }

  return {
    target: "vercel",
    recommendedProvider: "vercel",
    confidence: computeVercelConfidence(signals),
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* Confidence scoring                                                  */
/* ------------------------------------------------------------------ */

/**
 * Container confidence rises with the number (and strength) of independent
 * container-forcing signals, and is dampened when the framework is one that
 * is strongly serverless-oriented (Next/Nuxt/Remix/etc.) -> "mixed signals".
 */
function computeContainerConfidence(
  signals: RepoSignals,
  forcingCount: number,
): number {
  let confidence: number;

  if (forcingCount >= 3) {
    confidence = 0.95;
  } else if (forcingCount === 2) {
    confidence = 0.85;
  } else {
    // Exactly one forcing signal: how trustworthy depends on which one.
    confidence = singleSignalConfidence(signals);
  }

  // A Dockerfile is strong corroboration once we've already decided container:
  // the author packaged the app to run as a container. Boost meaningfully (a
  // Dockerfile + a port listener is a slam-dunk container deploy, ~0.9).
  if (signals.hasDockerfile) {
    confidence = Math.min(1, confidence + 0.2);
  }

  // Serverless-first framework + only weak container evidence = mixed signal.
  if (isServerlessFriendlyFramework(signals.framework) && forcingCount === 1) {
    confidence -= 0.15;
  }

  return clamp01(round2(confidence));
}

/**
 * The lone-signal case. Strong, unambiguous signals (websocket server,
 * workers, persistent disk) get higher confidence than softer ones
 * (a single long-handler heuristic, or just listensOnPort which many
 * serverless-friendly servers also do locally).
 */
function singleSignalConfidence(signals: RepoSignals): number {
  if (signals.wsServer) return 0.85;
  if (signals.workers) return 0.85;
  if (signals.persistentFsWrites) return 0.8;
  if (signals.composeAppServices > 1) return 0.82;
  if (signals.longHandlers) return 0.65; // heuristic, can false-positive
  // A persistent port listener is a solid always-on signal (serverless
  // functions don't app.listen); softer than ws/workers but still real.
  if (signals.listensOnPort) return 0.7;
  return 0.7;
}

/**
 * Vercel confidence is highest when the repo is "clean" (no container hints
 * at all) and a serverless-friendly framework is detected. A bare Dockerfile
 * or a borderline framework lowers it (mixed signals).
 */
function computeVercelConfidence(signals: RepoSignals): number {
  let confidence = 0.8;

  if (isServerlessFriendlyFramework(signals.framework)) {
    confidence = 0.9;
  } else if (signals.framework === undefined) {
    // Unknown stack with no container signals: reasonable but less certain.
    confidence = 0.7;
  } else {
    // A server-ish framework (express/fastify/...) with no forcing signals:
    // plausible on Vercel but more ambiguous.
    confidence = 0.72;
  }

  // A Dockerfile suggests the author may intend a container -> mixed signal.
  if (signals.hasDockerfile) {
    confidence -= 0.12;
  }
  // A single compose app service is a (mild) container-leaning hint.
  if (signals.composeAppServices === 1) {
    confidence -= 0.05;
  }

  return clamp01(round2(confidence));
}

function isServerlessFriendlyFramework(framework?: string): boolean {
  if (!framework) return false;
  return [
    "next",
    "nuxt",
    "remix",
    "sveltekit",
    "astro",
  ].includes(framework.toLowerCase());
}

/* ------------------------------------------------------------------ */
/* numeric helpers                                                     */
/* ------------------------------------------------------------------ */

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Vercel deployment operations: two-phase SHA file upload + deployment create,
 * status polling, and build-log reading.
 *
 * Implementation notes (kept in sync with the DeployTarget contract):
 *   deployImpl (TWO PHASE):
 *     phase 1, per file: bytes = utf8(content) or base64-decode(contentBase64);
 *       sha = lowercase hex SHA1 of the bytes (node:crypto createHash("sha1"));
 *       POST /v2/files with headers { "Content-Type":"application/octet-stream",
 *       "x-vercel-digest": sha, "Content-Length": String(bytes.length) } and
 *       raw body = bytes.
 *     phase 2: POST /v13/deployments?skipAutoDetectionConfirmation=1 with body
 *       { name: projectName, project: targetId,
 *         files: [{ file: path, sha, size }],
 *         projectSettings: { framework }, target: target ?? "production" }
 *       -> { id, url, readyState }. deploymentId = id; url = "https://" + url;
 *       status = mapReadyState(readyState).
 *   getLogsImpl: GET /v3/deployments/{deploymentId}/events -> array of
 *     { type, text, created, ... }; logText = joined text lines; summary = last
 *     error line when status is error. Also GET /v13/deployments/{id} for the
 *     readyState -> status mapping.
 *   getUrlImpl: GET /v13/deployments/{deploymentId} -> { url }; return
 *     { url: "https://" + url }.
 *   mapReadyState: QUEUED/INITIALIZING->queued, BUILDING->building, READY->ready,
 *     ERROR->error, CANCELED->canceled.
 */
import { createHash } from "node:crypto";
import type { VercelClient } from "./client.js";
import type { DeployFile, DeployStatus } from "../interface.js";

/* ------------------------------------------------------------------ */
/* Raw Vercel response shapes (only the fields we read)               */
/* ------------------------------------------------------------------ */

type VercelDeploymentResponse = {
  id: string;
  url?: string;
  readyState?: string;
};

type VercelEvent = {
  type?: string;
  text?: string;
  created?: number;
  payload?: { text?: string };
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Decode a DeployFile into its raw bytes. Exactly one of `content` (utf-8 text)
 * or `contentBase64` (binary) is expected; `content` wins if both are present,
 * and an absent body is treated as an empty file.
 */
function fileBytes(file: DeployFile): Uint8Array {
  if (file.content !== undefined) {
    return new Uint8Array(Buffer.from(file.content, "utf8"));
  }
  if (file.contentBase64 !== undefined) {
    return new Uint8Array(Buffer.from(file.contentBase64, "base64"));
  }
  return new Uint8Array(0);
}

/** Lowercase hex SHA1 of the given bytes (node:crypto). */
function sha1Hex(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

/** Map a Vercel readyState onto the normalised DeployStatus. */
function mapReadyState(readyState: string | undefined): DeployStatus {
  switch ((readyState ?? "").toUpperCase()) {
    case "QUEUED":
    case "INITIALIZING":
      return "queued";
    case "BUILDING":
      return "building";
    case "READY":
      return "ready";
    case "ERROR":
      return "error";
    case "CANCELED":
    case "CANCELLED":
      return "canceled";
    default:
      // Unknown/absent state: treat as still queued so callers can poll.
      return "queued";
  }
}

/** Prefix a bare Vercel host with https:// (idempotent if already absolute). */
function toHttpsUrl(url: string | undefined): string | undefined {
  if (url === undefined || url.length === 0) return undefined;
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/* ------------------------------------------------------------------ */
/* deploy                                                              */
/* ------------------------------------------------------------------ */

export async function deployImpl(
  c: VercelClient,
  input: {
    targetId: string;
    projectName: string;
    framework?: string;
    files: DeployFile[];
    target?: "production" | "preview";
  },
): Promise<{ deploymentId: string; url?: string; status: DeployStatus }> {
  // Phase 1: upload each file's raw bytes keyed by its SHA1 digest.
  const manifest: { file: string; sha: string; size: number }[] = [];
  for (const file of input.files) {
    const bytes = fileBytes(file);
    const sha = sha1Hex(bytes);
    await c.request<unknown>("POST", "/v2/files", {
      raw: bytes,
      headers: {
        "Content-Type": "application/octet-stream",
        "x-vercel-digest": sha,
        "Content-Length": String(bytes.length),
      },
    });
    manifest.push({ file: file.path, sha, size: bytes.length });
  }

  // Phase 2: create the deployment referencing the uploaded SHAs.
  const res = await c.request<VercelDeploymentResponse>(
    "POST",
    "/v13/deployments",
    {
      query: { skipAutoDetectionConfirmation: "1" },
      body: {
        name: input.projectName,
        project: input.targetId,
        files: manifest,
        projectSettings: { framework: input.framework ?? null },
        target: input.target ?? "production",
      },
    },
  );

  return {
    deploymentId: res.id,
    url: toHttpsUrl(res.url),
    status: mapReadyState(res.readyState),
  };
}

/* ------------------------------------------------------------------ */
/* getLogs                                                             */
/* ------------------------------------------------------------------ */

export async function getLogsImpl(
  c: VercelClient,
  input: { deploymentId: string; type?: "build" | "runtime" },
): Promise<{ status: DeployStatus; logText: string; summary?: string }> {
  // Current status comes from the deployment record itself.
  const dep = await c.request<VercelDeploymentResponse>(
    "GET",
    `/v13/deployments/${input.deploymentId}`,
  );
  const status = mapReadyState(dep.readyState);

  // Build events carry the human-readable log lines.
  const events = await c.request<VercelEvent[]>(
    "GET",
    `/v3/deployments/${input.deploymentId}/events`,
  );

  const lines = (Array.isArray(events) ? events : [])
    .map((e) => e.text ?? e.payload?.text)
    .filter((t): t is string => typeof t === "string");

  const logText = lines.join("\n");

  // On error, surface the last log line as a one-shot summary.
  const summary =
    status === "error" && lines.length > 0
      ? lines[lines.length - 1]
      : undefined;

  return { status, logText, summary };
}

/* ------------------------------------------------------------------ */
/* getUrl                                                              */
/* ------------------------------------------------------------------ */

export async function getUrlImpl(
  c: VercelClient,
  input: { deploymentId: string },
): Promise<{ url: string }> {
  const dep = await c.request<VercelDeploymentResponse>(
    "GET",
    `/v13/deployments/${input.deploymentId}`,
  );
  return { url: toHttpsUrl(dep.url) ?? "" };
}

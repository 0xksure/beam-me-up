/**
 * Vercel project + env operations.
 *
 * Thin, typed wrappers over the Vercel REST API via VercelClient:
 *   - createProjectImpl: POST /v10/projects with body { name, framework } ->
 *     { id, name, accountId }. targetId = id; dashboardUrl =
 *     https://vercel.com/dashboard.
 *   - setEnvVarsImpl: POST /v10/projects/{targetId}/env?upsert=true with a body
 *     that is an ARRAY of { key, value, type: secret? "sensitive":"encrypted",
 *     target: vars.targets ?? ["production","preview","development"] }.
 *     applied = the keys set; setCount = applied.length.
 *
 * The client appends the configured teamId to every request and never logs the
 * token. Secret env values are sent as type "sensitive" so they are write-only.
 */
import type { VercelClient } from "./client.js";
import type { EnvVar } from "../interface.js";

/** Default deploy environments an env var applies to when none are specified. */
const DEFAULT_ENV_TARGETS = ["production", "preview", "development"] as const;

/** Shape of the Vercel POST /v10/projects success response (fields we use). */
type CreateProjectResponse = {
  id: string;
  name?: string;
  accountId?: string;
};

/** One entry in the env upsert request array. */
type EnvUpsertEntry = {
  key: string;
  value: string;
  type: "sensitive" | "encrypted";
  target: string[];
};

/**
 * Create (or look up) a Vercel project.
 *
 * POST /v10/projects  body { name, framework? } -> { id, name, accountId }.
 * Returns the project id as targetId plus the dashboard URL.
 */
export async function createProjectImpl(
  c: VercelClient,
  input: { name: string; framework?: string },
): Promise<{ targetId: string; dashboardUrl: string }> {
  const body: { name: string; framework?: string } = { name: input.name };
  if (input.framework !== undefined) {
    body.framework = input.framework;
  }

  const res = await c.request<CreateProjectResponse>(
    "POST",
    "/v10/projects",
    { body },
  );

  return {
    targetId: res.id,
    dashboardUrl: "https://vercel.com/dashboard",
  };
}

/**
 * Upsert environment variables on a Vercel project.
 *
 * POST /v10/projects/{targetId}/env?upsert=true with an ARRAY body, one entry
 * per var. Secret vars are stored as type "sensitive" (write-only); the rest as
 * "encrypted". Each var applies to its own `targets` or the default trio
 * (production, preview, development).
 *
 * Returns the list of keys applied and the count.
 */
export async function setEnvVarsImpl(
  c: VercelClient,
  input: { targetId: string; vars: EnvVar[] },
): Promise<{ setCount: number; applied: string[] }> {
  const body: EnvUpsertEntry[] = input.vars.map((v) => ({
    key: v.key,
    value: v.value,
    type: v.secret ? "sensitive" : "encrypted",
    target: v.targets ?? [...DEFAULT_ENV_TARGETS],
  }));

  await c.request<unknown>(
    "POST",
    `/v10/projects/${input.targetId}/env`,
    { body, query: { upsert: "true" } },
  );

  const applied = input.vars.map((v) => v.key);
  return { setCount: applied.length, applied };
}

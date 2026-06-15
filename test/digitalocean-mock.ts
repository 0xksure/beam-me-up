/**
 * digitalocean-mock - an offline fake for globalThis.fetch targeting the
 * DigitalOcean API (api.digitalocean.com) + the presigned log URLs the App
 * Platform logs endpoint points at. Modeled on test/vercel-mock.ts.
 *
 * installDigitalOceanMock() swaps globalThis.fetch for a recorder and returns a
 * handle exposing the recorded calls + a restore(). Every request is recorded as
 * { method, url, headers, body }. DO wraps single resources: responses are
 * { app }, { apps }, { deployment }, etc.
 *
 * CANNED RESPONSES (EXACT — the test asserts these literal values):
 *   GET  /v2/apps                         -> { apps: [], links: {}, meta: { total: 0 } }
 *                                            (empty -> createProject POSTs a new app)
 *   POST /v2/apps                         -> { app: APP_CREATED }
 *   GET  /v2/apps/app_do_123              -> { app: APP_WITH_SPEC }
 *   PUT  /v2/apps/app_do_123              -> { app: APP_UPDATED }
 *   GET  /v2/apps/app_do_123/deployments/dep_do_2        -> { deployment: DEPLOYMENT_ACTIVE }
 *   GET  /v2/apps/app_do_123/deployments/dep_do_2/logs   -> { historic_urls:
 *         ["https://api.digitalocean.com/_mock/build.log"], live_url: "wss://logs/build" }
 *   GET  /_mock/build.log                 -> text/plain "Pulling image\nBuild completed\n"
 *
 * where (exported so the test can assert against them):
 *   APP_CREATED   = { id: "app_do_123",
 *                     default_ingress: "web-app-abc.ondigitalocean.app",
 *                     live_url: "https://web-app-abc.ondigitalocean.app",
 *                     pending_deployment: { id: "dep_do_1", phase: "PENDING_BUILD" },
 *                     spec: <the spec from the POST body> }
 *   APP_WITH_SPEC = { id: "app_do_123",
 *                     live_url: "https://web-app-abc.ondigitalocean.app",
 *                     default_ingress: "web-app-abc.ondigitalocean.app",
 *                     spec: { name: "web-app", region: "nyc", services: [
 *                       { name: "web",
 *                         image: { registry_type: "DOCKER_HUB", registry: "library",
 *                                  repository: "nginx", tag: "alpine" },
 *                         instance_size_slug: "apps-s-1vcpu-0.5gb",
 *                         instance_count: 1, http_port: 8080, envs: [] } ] } }
 *   APP_UPDATED   = { ...APP_WITH_SPEC, spec: <the spec from the PUT body>,
 *                     pending_deployment: { id: "dep_do_2", phase: "BUILDING" } }
 *   DEPLOYMENT_ACTIVE = { id: "dep_do_2", phase: "ACTIVE",
 *                     progress: { total_steps: 5, success_steps: 5, error_steps: 0,
 *                                 pending_steps: 0, running_steps: 0, steps: [] } }
 *   BUILD_LOG_TEXT = "Pulling image\nBuild completed\n"
 *
 * Host guard: allow ONLY api.digitalocean.com. Any other host -> blocked
 * { reason: "non-do-host" } + a 599 (NEVER the real network). A recognised host
 * but an unmocked path -> blocked { reason: "unmocked-path" } + 404.
 *
 * STUB (M4 skeleton): the recorder + canned-response routing is filled in by the
 * test implementer; the exported shape is final.
 */

/** A single recorded request. */
export type RecordedCall = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

export type DigitalOceanMock = {
  calls: RecordedCall[];
  blocked: {
    method: string;
    url: string;
    reason: "non-do-host" | "unmocked-path";
  }[];
  restore: () => void;
};

/** The canned app id every happy-path test threads through. */
export const APP_ID = "app_do_123";
export const DEPLOYMENT_ID = "dep_do_2";
export const LIVE_URL = "https://web-app-abc.ondigitalocean.app";
export const BUILD_LOG_TEXT = "Pulling image\nBuild completed\n";

/** Build a JSON Response with the given status. */
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Build a text/plain Response with the given status (presigned log URLs). */
function textResponse(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

/** The argument types of the ambient global `fetch` (typed by @types/node). */
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

/**
 * Normalise the various fetch input shapes to { method, url } and capture the
 * request headers and body as a plain record.
 */
function describeRequest(
  input: FetchInput,
  init: FetchInit,
): { method: string; url: string; headers: Record<string, string> } {
  let url: string;
  let method = "GET";
  const headers: Record<string, string> = {};

  if (typeof input === "string") {
    url = input;
  } else if (input instanceof URL) {
    url = input.toString();
  } else {
    // A Request object.
    url = input.url;
    method = input.method;
    input.headers.forEach((v: string, k: string) => {
      headers[k] = v;
    });
  }

  if (init?.method) method = init.method;

  // init headers win over / extend a Request's headers.
  if (init?.headers) {
    const h = new Headers(init.headers);
    h.forEach((v: string, k: string) => {
      headers[k] = v;
    });
  }

  return { method: method.toUpperCase(), url, headers };
}

/** Capture the body: parse JSON when possible, else keep the raw value. */
function captureBody(init: FetchInit): unknown {
  const raw = init?.body;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  // Binary upload (Uint8Array / ArrayBuffer / Buffer).
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return raw;
}

/** Pull `body.spec` out of a captured request body (POST/PUT /v2/apps). */
function specOf(body: unknown): unknown {
  if (body && typeof body === "object" && "spec" in body) {
    return (body as { spec?: unknown }).spec;
  }
  return undefined;
}

/**
 * Route a recognised api.digitalocean.com request to its canned response.
 *
 * Returns `{ response, matched }`. `matched` is false when the path/method was
 * not recognised (a 404 envelope is returned) so the caller can record the miss
 * as a real-network-escape candidate and the suite can fail loudly on it.
 */
function cannedResponse(
  method: string,
  url: string,
  body: unknown,
): { response: Response; matched: boolean } {
  const u = new URL(url);
  const path = u.pathname;

  // GET /v2/apps  -> list apps (empty -> createProject POSTs a new app)
  if (method === "GET" && path === "/v2/apps") {
    return {
      matched: true,
      response: jsonResponse({ apps: [], links: {}, meta: { total: 0 } }),
    };
  }

  // POST /v2/apps  -> create app (echoes the spec from the POST body)
  if (method === "POST" && path === "/v2/apps") {
    return {
      matched: true,
      response: jsonResponse({
        app: {
          id: APP_ID,
          default_ingress: "web-app-abc.ondigitalocean.app",
          live_url: LIVE_URL,
          pending_deployment: { id: "dep_do_1", phase: "PENDING_BUILD" },
          spec: specOf(body),
        },
      }),
    };
  }

  // GET /v2/apps/app_do_123  -> fetch app + spec
  if (method === "GET" && path === `/v2/apps/${APP_ID}`) {
    return {
      matched: true,
      response: jsonResponse({
        app: {
          id: APP_ID,
          live_url: LIVE_URL,
          default_ingress: "web-app-abc.ondigitalocean.app",
          spec: {
            name: "web-app",
            region: "nyc",
            services: [
              {
                name: "web",
                image: {
                  registry_type: "DOCKER_HUB",
                  registry: "library",
                  repository: "nginx",
                  tag: "alpine",
                },
                instance_size_slug: "apps-s-1vcpu-0.5gb",
                instance_count: 1,
                http_port: 8080,
                envs: [],
              },
            ],
          },
        },
      }),
    };
  }

  // PUT /v2/apps/app_do_123  -> update app (echoes the spec from the PUT body)
  if (method === "PUT" && path === `/v2/apps/${APP_ID}`) {
    return {
      matched: true,
      response: jsonResponse({
        app: {
          id: APP_ID,
          live_url: LIVE_URL,
          default_ingress: "web-app-abc.ondigitalocean.app",
          spec: specOf(body),
          pending_deployment: { id: DEPLOYMENT_ID, phase: "BUILDING" },
        },
      }),
    };
  }

  // GET /v2/apps/app_do_123/deployments/dep_do_2/logs  -> log url envelope
  // (checked before the bare deployment route so the longer path wins)
  if (
    method === "GET" &&
    path === `/v2/apps/${APP_ID}/deployments/${DEPLOYMENT_ID}/logs`
  ) {
    return {
      matched: true,
      response: jsonResponse({
        historic_urls: ["https://api.digitalocean.com/_mock/build.log"],
        live_url: "wss://logs/build",
      }),
    };
  }

  // GET /v2/apps/app_do_123/deployments/dep_do_2  -> deployment status
  if (
    method === "GET" &&
    path === `/v2/apps/${APP_ID}/deployments/${DEPLOYMENT_ID}`
  ) {
    return {
      matched: true,
      response: jsonResponse({
        deployment: {
          id: DEPLOYMENT_ID,
          phase: "ACTIVE",
          progress: {
            total_steps: 5,
            success_steps: 5,
            error_steps: 0,
            pending_steps: 0,
            running_steps: 0,
            steps: [],
          },
        },
      }),
    };
  }

  // GET /_mock/build.log  -> presigned build-log text (text/plain, not JSON)
  if (method === "GET" && path === "/_mock/build.log") {
    return { matched: true, response: textResponse(BUILD_LOG_TEXT) };
  }

  return {
    matched: false,
    response: jsonResponse(
      {
        id: "not_found",
        message: `digitalocean-mock: no canned response for ${method} ${path}`,
      },
      404,
    ),
  };
}

export function installDigitalOceanMock(): DigitalOceanMock {
  const calls: RecordedCall[] = [];
  const blocked: DigitalOceanMock["blocked"] = [];
  const original = globalThis.fetch;

  const mockFetch: typeof fetch = async (input, init) => {
    const { method, url, headers } = describeRequest(input, init);
    const body = captureBody(init);

    calls.push({ method, url, headers, body });

    // Guard: this mock is strictly for the DigitalOcean API. Any other host
    // means the code under test tried to reach the real network - record it as
    // a blocked escape and answer with a loud 599 (never the real network).
    const host = new URL(url).host;
    if (host !== "api.digitalocean.com") {
      blocked.push({ method, url, reason: "non-do-host" });
      return jsonResponse(
        {
          id: "blocked",
          message: `digitalocean-mock: refusing non-do host ${host}`,
        },
        599,
      );
    }

    const { response, matched } = cannedResponse(method, url, body);
    // A recognised host but an unmocked path: record it so the suite can fail
    // loudly rather than let a silently-swallowed 404 hide a wrong endpoint.
    if (!matched) {
      blocked.push({ method, url, reason: "unmocked-path" });
    }
    return response;
  };

  globalThis.fetch = mockFetch;

  return {
    calls,
    blocked,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

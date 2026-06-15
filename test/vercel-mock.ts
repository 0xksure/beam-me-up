/**
 * vercel-mock - an offline fake for globalThis.fetch targeting api.vercel.com.
 *
 * installVercelMock() swaps globalThis.fetch for a recorder and returns a handle
 * exposing the recorded calls + a restore(). Every request is recorded as
 * { method, url, headers, body }; responses are canned, keyed by path:
 *
 *   POST /v10/projects                      -> { id:"prj_123", name, accountId }
 *   POST /v10/projects/{id}/env?upsert=true -> { created:[...] }
 *   POST /v2/files                          -> 200 {}
 *   POST /v13/deployments                   -> { id:"dpl_456",
 *                                                url:"chatify-abc.vercel.app",
 *                                                readyState:"BUILDING" }
 *   GET  /v13/deployments/dpl_456           -> { readyState:"READY",
 *                                                url:"chatify-abc.vercel.app" }
 *   GET  /v3/deployments/dpl_456/events     -> [{ type:"stdout",
 *                                                 text:"Build completed" }]
 *
 * Anything unrecognised returns a 404 JSON error envelope so a wrong call fails
 * loudly rather than silently.
 *
 * restore() puts the original fetch back. The mock NEVER touches the network.
 */

/** A single recorded request. */
export type RecordedCall = {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Parsed JSON body when JSON, the raw string/bytes otherwise, or undefined. */
  body: unknown;
};

export type VercelMock = {
  /** Every request the wrapped fetch saw, in order. */
  calls: RecordedCall[];
  /**
   * Requests the mock REFUSED: either a non-api.vercel.com host (a real-network
   * escape attempt) or a recognised host but an unmocked path. A non-empty array
   * after a happy-path run means the code under test tried to reach somewhere the
   * test never canned a response for - the suite asserts this stays empty.
   */
  blocked: { method: string; url: string; reason: "non-vercel-host" | "unmocked-path" }[];
  /** Restore the original globalThis.fetch. */
  restore: () => void;
};

/** Build a JSON Response with the given status. */
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
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

/**
 * Route a recognised api.vercel.com request to its canned response.
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

  // POST /v10/projects  -> create project
  if (method === "POST" && path === "/v10/projects") {
    const name =
      body && typeof body === "object" && "name" in body
        ? (body as { name?: unknown }).name
        : undefined;
    return {
      matched: true,
      response: jsonResponse({
        id: "prj_123",
        name: typeof name === "string" ? name : "project",
        accountId: "acc_test",
      }),
    };
  }

  // POST /v10/projects/{id}/env  -> set env vars
  if (method === "POST" && /^\/v10\/projects\/[^/]+\/env$/.test(path)) {
    return { matched: true, response: jsonResponse({ created: [] }) };
  }

  // POST /v2/files  -> file upload (two-phase deploy, phase 1)
  if (method === "POST" && path === "/v2/files") {
    return { matched: true, response: jsonResponse({}) };
  }

  // POST /v13/deployments  -> create deployment (phase 2)
  if (method === "POST" && path === "/v13/deployments") {
    return {
      matched: true,
      response: jsonResponse({
        id: "dpl_456",
        url: "chatify-abc.vercel.app",
        readyState: "BUILDING",
      }),
    };
  }

  // GET /v13/deployments/{id}  -> status poll / url lookup
  if (method === "GET" && /^\/v13\/deployments\/[^/]+$/.test(path)) {
    return {
      matched: true,
      response: jsonResponse({
        readyState: "READY",
        url: "chatify-abc.vercel.app",
      }),
    };
  }

  // GET /v3/deployments/{id}/events  -> build logs
  if (method === "GET" && /^\/v3\/deployments\/[^/]+\/events$/.test(path)) {
    return {
      matched: true,
      response: jsonResponse([{ type: "stdout", text: "Build completed" }]),
    };
  }

  return {
    matched: false,
    response: jsonResponse(
      {
        error: {
          code: "not_found",
          message: `vercel-mock: no canned response for ${method} ${path}`,
        },
      },
      404,
    ),
  };
}

export function installVercelMock(): VercelMock {
  const calls: RecordedCall[] = [];
  const blocked: VercelMock["blocked"] = [];
  const original = globalThis.fetch;

  const mockFetch: typeof fetch = async (input, init) => {
    const { method, url, headers } = describeRequest(input, init);
    const body = captureBody(init);

    calls.push({ method, url, headers, body });

    // Guard: this mock is strictly for the Vercel API. Any other host means the
    // code under test tried to reach the real network - record it as a blocked
    // escape and answer with a loud 599 (never the real network).
    const host = new URL(url).host;
    if (host !== "api.vercel.com") {
      blocked.push({ method, url, reason: "non-vercel-host" });
      return jsonResponse(
        {
          error: {
            code: "blocked",
            message: `vercel-mock: refusing non-vercel host ${host}`,
          },
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

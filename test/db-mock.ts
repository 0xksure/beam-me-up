/**
 * db-mock - an offline fake for globalThis.fetch targeting the M2 database
 * providers: console.neon.tech (Neon) and api.upstash.com (Upstash).
 *
 * Modeled on test/vercel-mock.ts. installDbMock() swaps globalThis.fetch for a
 * recorder and returns a handle exposing the recorded calls + a restore().
 * Every request is recorded as { method, url, headers, body }; responses are
 * canned per the PINNED API shapes:
 *
 *   NEON (https://console.neon.tech/api/v2):
 *     POST .../projects                       -> { project:{id},
 *                                                  connection_uris:[{connection_uri}],
 *                                                  roles:[{name}],
 *                                                  databases:[{name}] }
 *     GET  .../projects/{id}/connection_uri   -> { uri }  (host has "-pooler")
 *
 *   UPSTASH (https://api.upstash.com/v2):
 *     POST .../redis/database                  -> { database_id, endpoint,
 *                                                   port, password, rest_token }
 *     GET  .../redis/database/{id}             -> full details
 *
 * Anything from any other host is REFUSED (no real network) and recorded in the
 * `blocked` escape ledger; a recognised host with an unmocked path is recorded
 * too so the suite can fail loudly. restore() puts the original fetch back.
 *
 * The mock is deliberately tolerant about WHERE in the URL the version prefix
 * sits (the Neon/Upstash client implementers may fold `/api/v2` or `/v2` into
 * the base URL or pass it through the path). It routes on the recognisable path
 * SUFFIX/segments, not an anchored pathname, so it agrees with the adapters
 * regardless of that implementation choice - while still matching exactly one
 * endpoint per request.
 */

/* ------------------------------------------------------------------ */
/* Canned response data (the single source of truth the asserts pin)   */
/* ------------------------------------------------------------------ */

/** The Neon project id every canned create returns; also the resourceId. */
export const NEON_PROJECT_ID = "proj_neon_123";
/** The role + database names the create response advertises. */
export const NEON_ROLE_NAME = "neondb_owner";
export const NEON_DATABASE_NAME = "neondb";
/**
 * The DIRECT (unpooled) connection uri the create response carries. Its host
 * has NO "-pooler" - that distinguishes it from the pooled uri below so the
 * test can prove DATABASE_URL (pooled) vs DATABASE_URL_UNPOOLED (direct).
 */
export const NEON_DIRECT_URI =
  "postgresql://neondb_owner:npg_pw@ep-cool-darkness-123456.us-east-2.aws.neon.tech/neondb?sslmode=require";
/** The POOLED connection uri the GET /connection_uri?pooled=true returns. */
export const NEON_POOLED_URI =
  "postgresql://neondb_owner:npg_pw@ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";

/** The Upstash database id every canned create returns; also the resourceId. */
export const UPSTASH_DATABASE_ID = "db_upstash_456";
export const UPSTASH_ENDPOINT = "cool-redis-12345.upstash.io";
export const UPSTASH_PORT = 6379;
export const UPSTASH_PASSWORD = "pw_redis";
export const UPSTASH_REST_TOKEN = "tok_redis";

/** A single recorded request. */
export type RecordedCall = {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Parsed JSON body when JSON, the raw string/bytes otherwise, or undefined. */
  body: unknown;
};

export type DbMock = {
  /** Every request the wrapped fetch saw, in order. */
  calls: RecordedCall[];
  /**
   * Requests the mock REFUSED: a non-(neon|upstash) host (a real-network escape
   * attempt) or a recognised host but an unmocked path. A non-empty array after
   * a happy-path run means the code under test tried to reach somewhere the test
   * never canned a response for - the suite asserts this stays empty.
   */
  blocked: {
    method: string;
    url: string;
    reason: "non-db-host" | "unmocked-path";
  }[];
  /** Restore the original globalThis.fetch. */
  restore: () => void;
};

/** The two hosts this mock will answer; everything else is a network escape. */
const NEON_HOST = "console.neon.tech";
const UPSTASH_HOST = "api.upstash.com";

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
 * request headers as a plain record.
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
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return raw;
}

/**
 * Route a recognised Neon request to its canned response, matching on the path
 * SUFFIX so the base-URL construction choice of the client does not matter.
 *
 * Returns `{ response, matched }`; `matched` is false for an unrecognised path
 * (a loud 404 envelope) so the caller records the miss as an escape candidate.
 */
function cannedNeon(
  method: string,
  url: string,
  neonProjects: Array<{ id: string; name: string }>,
): { response: Response; matched: boolean } {
  const u = new URL(url);
  const path = u.pathname;

  // GET .../projects/{id}/connection_uri  -> pooled (default) or direct uri.
  if (method === "GET" && /\/projects\/[^/]+\/connection_uri\/?$/.test(path)) {
    const direct = u.searchParams.get("pooled") === "false";
    return {
      matched: true,
      response: jsonResponse({ uri: direct ? NEON_DIRECT_URI : NEON_POOLED_URI }),
    };
  }

  // GET .../projects/{id}/databases  -> default database (idempotent reuse path).
  if (method === "GET" && /\/projects\/[^/]+\/databases\/?$/.test(path)) {
    return {
      matched: true,
      response: jsonResponse({ databases: [{ name: NEON_DATABASE_NAME }] }),
    };
  }

  // GET .../projects/{id}/roles  -> owner role (idempotent reuse path).
  if (method === "GET" && /\/projects\/[^/]+\/roles\/?$/.test(path)) {
    return {
      matched: true,
      response: jsonResponse({ roles: [{ name: NEON_ROLE_NAME }] }),
    };
  }

  // GET .../projects  -> list (dedup-by-name lookup). Seeded for the dedup test.
  if (method === "GET" && /\/projects\/?$/.test(path)) {
    return {
      matched: true,
      response: jsonResponse({ projects: neonProjects, pagination: {} }),
    };
  }

  // POST .../projects  -> create project.
  if (method === "POST" && /\/projects\/?$/.test(path)) {
    return {
      matched: true,
      response: jsonResponse({
        project: { id: NEON_PROJECT_ID },
        connection_uris: [{ connection_uri: NEON_DIRECT_URI }],
        roles: [{ name: NEON_ROLE_NAME }],
        databases: [{ name: NEON_DATABASE_NAME }],
      }),
    };
  }

  return {
    matched: false,
    response: jsonResponse(
      {
        message: `db-mock(neon): no canned response for ${method} ${path}`,
      },
      404,
    ),
  };
}

/** Route a recognised Upstash request to its canned response (suffix match). */
function cannedUpstash(
  method: string,
  url: string,
): { response: Response; matched: boolean } {
  const u = new URL(url);
  const path = u.pathname;

  // POST .../redis/database  -> create redis database
  if (method === "POST" && /\/redis\/database\/?$/.test(path)) {
    return {
      matched: true,
      response: jsonResponse({
        database_id: UPSTASH_DATABASE_ID,
        endpoint: UPSTASH_ENDPOINT,
        port: UPSTASH_PORT,
        password: UPSTASH_PASSWORD,
        rest_token: UPSTASH_REST_TOKEN,
      }),
    };
  }

  // GET .../redis/database/{id}  -> full details (fallback when create omits
  // password/rest_token).
  if (method === "GET" && /\/redis\/database\/[^/]+\/?$/.test(path)) {
    return {
      matched: true,
      response: jsonResponse({
        database_id: UPSTASH_DATABASE_ID,
        endpoint: UPSTASH_ENDPOINT,
        port: UPSTASH_PORT,
        password: UPSTASH_PASSWORD,
        rest_token: UPSTASH_REST_TOKEN,
      }),
    };
  }

  return {
    matched: false,
    response: jsonResponse(
      {
        message: `db-mock(upstash): no canned response for ${method} ${path}`,
      },
      404,
    ),
  };
}

export function installDbMock(
  opts: { neonProjects?: Array<{ id: string; name: string }> } = {},
): DbMock {
  const neonProjects = opts.neonProjects ?? [];
  const calls: RecordedCall[] = [];
  const blocked: DbMock["blocked"] = [];
  const original = globalThis.fetch;

  const mockFetch: typeof fetch = async (input, init) => {
    const { method, url, headers } = describeRequest(input, init);
    const body = captureBody(init);

    calls.push({ method, url, headers, body });

    // Guard: this mock is strictly for the Neon + Upstash APIs. Any other host
    // means the code under test tried to reach the real network - record it as a
    // blocked escape and answer with a loud 599 (never the real network).
    const host = new URL(url).host;
    if (host !== NEON_HOST && host !== UPSTASH_HOST) {
      blocked.push({ method, url, reason: "non-db-host" });
      return jsonResponse(
        {
          message: `db-mock: refusing non-db host ${host} (no real network)`,
        },
        599,
      );
    }

    const { response, matched } =
      host === NEON_HOST
        ? cannedNeon(method, url, neonProjects)
        : cannedUpstash(method, url);

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

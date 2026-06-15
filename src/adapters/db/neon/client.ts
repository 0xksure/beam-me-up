/**
 * NeonClient - a thin, typed wrapper over the Neon REST API
 * (https://console.neon.tech/api/v2).
 *
 * Design (mirrors VercelClient, src/adapters/deploy/vercel/client.ts):
 *   - Uses the GLOBAL `fetch` so tests can swap globalThis.fetch for a recording
 *     mock with zero network access.
 *   - Always sends `Authorization: Bearer <apiKey>` plus Accept +
 *     Content-Type application/json.
 *   - JSON-encodes a `body` and parses JSON responses.
 *   - Appends any `query` params to the URL.
 *   - On a non-2xx response it throws a typed NeonApiError carrying the HTTP
 *     status + Neon message.
 *
 * The apiKey is never logged.
 *
 * Verified against the live Neon OpenAPI spec (https://neon.com/api_spec/release/v2.json,
 * checked 2026-06-15):
 *   - Neon's error envelope is FLAT: { message, code, request_id } (NOT nested
 *     under `error` like Vercel). extractNeonError handles that shape.
 */
import type { NeonCreds } from "../interface.js";

const NEON_BASE = "https://console.neon.tech/api/v2";

/** Error thrown for any non-2xx Neon response. */
export class NeonApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly path: string;

  constructor(args: {
    status: number;
    message: string;
    code?: string;
    path: string;
  }) {
    super(args.message);
    this.name = "NeonApiError";
    this.status = args.status;
    this.code = args.code;
    this.path = args.path;
  }
}

export type NeonRequestOpts = {
  /** JSON body to send. */
  body?: unknown;
  /** Extra query params to append to the URL. */
  query?: Record<string, string>;
};

export class NeonClient {
  readonly #apiKey: string;

  constructor(creds: NeonCreds) {
    this.#apiKey = creds.apiKey;
  }

  /**
   * Perform a request against the Neon REST API and return the parsed JSON body
   * typed as T.
   */
  async request<T>(
    method: string,
    path: string,
    opts: NeonRequestOpts = {},
  ): Promise<T> {
    const url = this.#buildUrl(path, opts.query);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: "application/json",
    };

    let body: string | undefined;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(url, { method, headers, body });

    const text = await res.text();
    const parsed = text.length > 0 ? safeJsonParse(text) : undefined;

    if (!res.ok) {
      const errInfo = extractNeonError(parsed);
      throw new NeonApiError({
        status: res.status,
        message:
          errInfo.message ??
          `Neon API ${method} ${path} failed with status ${res.status}`,
        code: errInfo.code,
        path,
      });
    }

    return parsed as T;
  }

  /** Build the absolute URL, appending any caller-supplied query params. */
  #buildUrl(path: string, query?: Record<string, string>): string {
    const url = new URL(path.startsWith("http") ? path : `${NEON_BASE}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }
}

/** Parse JSON without throwing; returns undefined on malformed input. */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Pull a { message, code } out of a Neon error envelope, if present.
 *
 * Neon returns a FLAT GeneralError shape: { message: string, code: string,
 * request_id?: string } (verified against the live OpenAPI spec). We also
 * tolerate a nested `{ error: { message, code } }` shape defensively.
 */
function extractNeonError(parsed: unknown): {
  message?: string;
  code?: string;
} {
  if (!parsed || typeof parsed !== "object") return {};

  // Flat shape: { message, code }
  const flat = readMessageCode(parsed);
  if (flat.message !== undefined || flat.code !== undefined) return flat;

  // Defensive: nested { error: { message, code } }
  if ("error" in parsed) {
    const err = (parsed as { error?: unknown }).error;
    if (err && typeof err === "object") return readMessageCode(err);
  }

  return {};
}

/** Read string `message`/`code` fields off an object. */
function readMessageCode(obj: unknown): { message?: string; code?: string } {
  const o = obj as { message?: unknown; code?: unknown };
  const message = typeof o.message === "string" ? o.message : undefined;
  const code = typeof o.code === "string" ? o.code : undefined;
  return { message, code };
}

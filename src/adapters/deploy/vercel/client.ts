/**
 * VercelClient - a thin, typed wrapper over the Vercel REST API.
 *
 * Design points:
 *   - Uses the GLOBAL `fetch` (Node >=18) so tests can swap globalThis.fetch
 *     for a recording mock with zero network access.
 *   - Always sends `Authorization: Bearer <token>`.
 *   - When a teamId is configured it is appended as `?teamId=<id>` to EVERY
 *     request (merged with any caller-supplied query).
 *   - JSON-encodes a `body` (unless a `raw` Uint8Array is given for file
 *     uploads), and parses JSON responses.
 *   - On a non-2xx response it throws a typed VercelApiError carrying the HTTP
 *     status and the Vercel error message.
 *
 * The token is never logged.
 */
import type { ProviderToken } from "../interface.js";

const VERCEL_BASE = "https://api.vercel.com";

/** Error thrown for any non-2xx Vercel response. */
export class VercelApiError extends Error {
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
    this.name = "VercelApiError";
    this.status = args.status;
    this.code = args.code;
    this.path = args.path;
  }
}

export type VercelRequestOpts = {
  /** JSON body to send (ignored when `raw` is provided). */
  body?: unknown;
  /** Extra headers, merged over the defaults. */
  headers?: Record<string, string>;
  /** Raw bytes to send as the body (used for /v2/files uploads). */
  raw?: Uint8Array;
  /** Extra query params, merged with the configured teamId. */
  query?: Record<string, string>;
};

export class VercelClient {
  readonly #token: string;
  readonly #teamId?: string;

  constructor(token: ProviderToken) {
    this.#token = token.token;
    this.#teamId = token.teamId;
  }

  /**
   * Perform a request against the Vercel REST API and return the parsed JSON
   * body typed as T.
   */
  async request<T>(
    method: string,
    path: string,
    opts: VercelRequestOpts = {},
  ): Promise<T> {
    const url = this.#buildUrl(path, opts.query);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#token}`,
      ...(opts.headers ?? {}),
    };

    let body: string | Uint8Array | undefined;
    if (opts.raw !== undefined) {
      // Raw binary upload (e.g. /v2/files). Caller sets Content-Type/Length.
      // Copy into a fresh Uint8Array so the body is not a shared buffer view.
      body = new Uint8Array(opts.raw);
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      if (headers["Content-Type"] === undefined) {
        headers["Content-Type"] = "application/json";
      }
    }

    const res = await fetch(url, { method, headers, body });

    const text = await res.text();
    const parsed = text.length > 0 ? safeJsonParse(text) : undefined;

    if (!res.ok) {
      const errInfo = extractVercelError(parsed);
      throw new VercelApiError({
        status: res.status,
        message:
          errInfo.message ??
          `Vercel API ${method} ${path} failed with status ${res.status}`,
        code: errInfo.code,
        path,
      });
    }

    return parsed as T;
  }

  /** Build the absolute URL, appending the configured teamId + caller query. */
  #buildUrl(path: string, query?: Record<string, string>): string {
    const url = new URL(path.startsWith("http") ? path : `${VERCEL_BASE}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, v);
      }
    }
    if (this.#teamId !== undefined && !url.searchParams.has("teamId")) {
      url.searchParams.set("teamId", this.#teamId);
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

/** Pull a { message, code } out of a Vercel error envelope, if present. */
function extractVercelError(parsed: unknown): {
  message?: string;
  code?: string;
} {
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const err = (parsed as { error?: unknown }).error;
    if (err && typeof err === "object") {
      const message =
        "message" in err && typeof (err as { message?: unknown }).message === "string"
          ? (err as { message: string }).message
          : undefined;
      const code =
        "code" in err && typeof (err as { code?: unknown }).code === "string"
          ? (err as { code: string }).code
          : undefined;
      return { message, code };
    }
  }
  return {};
}

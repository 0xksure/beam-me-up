/**
 * UpstashClient - a thin, typed wrapper over the Upstash Developer API
 * (https://api.upstash.com/v2).
 *
 * Design (mirrors VercelClient, src/adapters/deploy/vercel/client.ts):
 *   - Uses the GLOBAL `fetch` so tests can swap globalThis.fetch for a recording
 *     mock with zero network access.
 *   - Authenticates with HTTP Basic: `Authorization: Basic
 *     base64("<email>:<apiKey>")` (built with Buffer; no extra deps). Verified
 *     against upstash.com/docs/devops/developer-api/authentication: "Upstash API
 *     uses HTTP Basic authentication. You should pass EMAIL and API_KEY as basic
 *     authentication username and password respectively."
 *   - JSON-encodes a `body` and parses JSON responses.
 *   - On a non-2xx response it throws a typed UpstashApiError carrying the HTTP
 *     status and the Upstash error message.
 *
 * The apiKey/email are never logged.
 */
import type { UpstashCreds } from "../interface.js";

const UPSTASH_BASE = "https://api.upstash.com/v2";

/** Error thrown for any non-2xx Upstash response. */
export class UpstashApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(args: { status: number; message: string; path: string }) {
    super(args.message);
    this.name = "UpstashApiError";
    this.status = args.status;
    this.path = args.path;
  }
}

export type UpstashRequestOpts = {
  /** JSON body to send. */
  body?: unknown;
};

export class UpstashClient {
  readonly #email: string;
  readonly #apiKey: string;

  constructor(creds: UpstashCreds) {
    this.#email = creds.email;
    this.#apiKey = creds.apiKey;
  }

  /**
   * Perform a request against the Upstash Developer API and return the parsed
   * JSON body typed as T.
   */
  async request<T>(
    method: string,
    path: string,
    opts: UpstashRequestOpts = {},
  ): Promise<T> {
    const url = path.startsWith("http") ? path : `${UPSTASH_BASE}${path}`;

    const headers: Record<string, string> = {
      Authorization: this.#authHeader(),
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
      throw new UpstashApiError({
        status: res.status,
        message:
          extractUpstashError(parsed) ??
          `Upstash API ${method} ${path} failed with status ${res.status}`,
        path,
      });
    }

    return parsed as T;
  }

  /** Build the `Basic base64("<email>:<apiKey>")` Authorization header value. */
  #authHeader(): string {
    const encoded = Buffer.from(`${this.#email}:${this.#apiKey}`).toString(
      "base64",
    );
    return `Basic ${encoded}`;
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
 * Pull a human-readable error message out of an Upstash error response. The
 * Developer API returns errors either as a bare JSON string or as an object
 * with an `error`/`message` field; cover both.
 */
function extractUpstashError(parsed: unknown): string | undefined {
  if (typeof parsed === "string" && parsed.length > 0) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.error === "string" && obj.error.length > 0) return obj.error;
    if (typeof obj.message === "string" && obj.message.length > 0) {
      return obj.message;
    }
  }
  return undefined;
}

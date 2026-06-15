/**
 * DigitalOceanClient - a thin, typed wrapper over the DigitalOcean REST API
 * (https://api.digitalocean.com), used by the App Platform deploy adapter.
 *
 * Design (mirrors VercelClient, src/adapters/deploy/vercel/client.ts):
 *   - Uses the GLOBAL `fetch` so tests can swap globalThis.fetch for a recording
 *     mock with zero network access.
 *   - Always sends `Authorization: Bearer <token>` plus Accept +
 *     Content-Type application/json.
 *   - JSON-encodes a `body` and parses JSON responses.
 *   - Appends any `query` params to the URL.
 *   - On a non-2xx response it throws a typed DigitalOceanApiError carrying the
 *     HTTP status + the DO error message (DO errors look like
 *     { id, message, request_id }).
 *
 * The token is never logged.
 *
 * App Platform logs are URL-indirected: GET .../logs returns
 * { historic_urls: [...], live_url } rather than inline text. fetchLogText()
 * GETs one of those (presigned, no auth) URLs and returns its body text, so the
 * adapter can surface real build-log text. fetchLogText must tolerate any host
 * (the presigned URLs live on DO Spaces / a CDN, not api.digitalocean.com).
 *
 * STUB (M4 skeleton): the real REST plumbing is filled in by the implementer;
 * the signatures are final.
 */
import type { ProviderToken } from "../interface.js";

const DIGITALOCEAN_BASE = "https://api.digitalocean.com";

/** Error thrown for any non-2xx DigitalOcean response. */
export class DigitalOceanApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(args: { status: number; message: string; path: string }) {
    super(args.message);
    this.name = "DigitalOceanApiError";
    this.status = args.status;
    this.path = args.path;
  }
}

export type DigitalOceanRequestOpts = {
  /** JSON body to send. */
  body?: unknown;
  /** Extra query params to append to the URL. */
  query?: Record<string, string>;
};

export class DigitalOceanClient {
  readonly #token: string;

  constructor(token: ProviderToken) {
    this.#token = token.token;
  }

  /**
   * Perform a request against https://api.digitalocean.com and return the parsed
   * JSON body typed as T. `path` is the path part, e.g. "/v2/apps".
   */
  async request<T>(
    method: string,
    path: string,
    opts: DigitalOceanRequestOpts = {},
  ): Promise<T> {
    const url = this.#buildUrl(path, opts.query);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    let body: string | undefined;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
    }

    const res = await fetch(url, { method, headers, body });

    const text = await res.text();
    const parsed = text.length > 0 ? safeJsonParse(text) : undefined;

    if (!res.ok) {
      const message = extractDigitalOceanError(parsed);
      throw new DigitalOceanApiError({
        status: res.status,
        message:
          message ??
          `DigitalOcean API ${method} ${path} failed with status ${res.status}`,
        path,
      });
    }

    return parsed as T;
  }

  /**
   * GET an absolute (presigned) log-file URL and return its raw text body.
   * No auth header (the URL is presigned). Used to read App Platform build logs
   * whose `historic_urls` point at object storage rather than the DO API.
   */
  async fetchLogText(url: string): Promise<string> {
    const res = await fetch(url, { method: "GET" });
    return res.text();
  }

  /** Build the absolute URL, appending any caller-supplied query params. */
  #buildUrl(path: string, query?: Record<string, string>): string {
    const url = new URL(
      path.startsWith("http") ? path : `${DIGITALOCEAN_BASE}${path}`,
    );
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
 * Pull a human-readable message out of a DigitalOcean error envelope, if
 * present. DO errors look like { id, message, request_id }.
 */
function extractDigitalOceanError(parsed: unknown): string | undefined {
  if (parsed && typeof parsed === "object" && "message" in parsed) {
    const message = (parsed as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return undefined;
}

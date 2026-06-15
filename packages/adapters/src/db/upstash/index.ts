/**
 * UpstashProvisioner - implements the DbProvisioner contract for Redis on
 * Upstash by composing the UpstashClient (low-level REST wrapper, swappable
 * global fetch).
 *
 * Mirrors VercelAdapter (src/adapters/deploy/vercel/index.ts): the provisioner
 * is thin and delegates the REST plumbing to the client.
 *
 * Verified against the official Upstash Developer API OpenAPI spec
 * (upstash/docs devops/developer-api/openapi.yml) + the create/get-database and
 * authentication docs on 2026-06-15. NOTE: the real request/response shapes
 * differ from the originally pinned shapes (see the report returned to the
 * orchestrator); this implementation follows the REAL API:
 *
 *   1. POST /redis/database
 *        body { database_name, primary_region, platform: "aws", tls: true }
 *        - `database_name` is the real field (NOT `name`).
 *        - `primary_region` is the real field (NOT `region`); we map the
 *          optional `input.region` onto it, defaulting to "us-east-1".
 *        - `platform` is REQUIRED by the real API; we send "aws".
 *        -> Database object { database_id, endpoint, port, password,
 *           rest_token, ... } (credentials are present on create).
 *   2. If `password`/`rest_token` are absent (e.g. a future variant that hides
 *      credentials), GET /redis/database/{database_id} for the full details.
 *
 *   envVars:
 *     REDIS_URL                = "rediss://default:<password>@<endpoint>:<port>"
 *     UPSTASH_REDIS_REST_URL   = "https://<endpoint>"
 *     UPSTASH_REDIS_REST_TOKEN = <rest_token>
 *   resourceId = database_id; provider = "upstash".
 */
import type {
  DbProvisioner,
  ProvisionResult,
  UpstashCreds,
} from "../interface.js";
import { UpstashClient } from "./client.js";

/**
 * The fields of the Upstash Database object we consume. The Developer API's
 * Database response carries many more fields (db_*, region, state, ...); we only
 * type what we read. `password` / `rest_token` / `read_only_rest_token` are
 * returned by the live API on create + on GET (unless `?credentials=hide`),
 * even though the published OpenAPI schema omits them, so we treat them as
 * optional and fall back to a GET when they are absent.
 */
type UpstashDatabase = {
  database_id: string;
  endpoint: string;
  port: number;
  password?: string;
  rest_token?: string;
  read_only_rest_token?: string;
};

/** Default primary region when the caller does not specify one. */
const DEFAULT_PRIMARY_REGION = "us-east-1";

export class UpstashProvisioner implements DbProvisioner {
  readonly provider = "upstash" as const;

  readonly #client: UpstashClient;

  constructor(creds: UpstashCreds) {
    this.#client = new UpstashClient(creds);
  }

  async provision(input: {
    name: string;
    region?: string;
  }): Promise<ProvisionResult> {
    // 1. Create the database. `platform` is required by the real API.
    const created = await this.#client.request<UpstashDatabase>(
      "POST",
      "/redis/database",
      {
        body: {
          database_name: input.name,
          primary_region: input.region ?? DEFAULT_PRIMARY_REGION,
          platform: "aws",
          tls: true,
        },
      },
    );

    const databaseId = created.database_id;

    // 2. If the create response did not include credentials, fetch details.
    let db = created;
    if (!db.password || !db.rest_token) {
      db = await this.#client.request<UpstashDatabase>(
        "GET",
        `/redis/database/${databaseId}`,
      );
    }

    const password = db.password ?? "";
    const restToken = db.rest_token ?? "";

    const envVars: Record<string, string> = {
      REDIS_URL: `rediss://default:${password}@${db.endpoint}:${db.port}`,
      UPSTASH_REDIS_REST_URL: `https://${db.endpoint}`,
      UPSTASH_REDIS_REST_TOKEN: restToken,
    };

    return {
      provider: "upstash",
      resourceId: databaseId,
      envVars,
    };
  }
}

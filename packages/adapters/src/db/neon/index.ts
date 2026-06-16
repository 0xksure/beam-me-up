/**
 * NeonProvisioner - implements the DbProvisioner contract for Postgres on Neon
 * by composing the NeonClient (low-level REST wrapper, swappable global fetch).
 *
 * Mirrors VercelAdapter (src/adapters/deploy/vercel/index.ts): the provisioner
 * is thin and delegates the REST plumbing to the client.
 *
 * provision() (verified against the live Neon OpenAPI spec
 * https://neon.com/api_spec/release/v2.json, checked 2026-06-15):
 *   1. POST /projects  body { project: { name, pg_version: 16 } }
 *        -> { project:{id}, connection_uris:[{connection_uri}], roles:[{name}],
 *             databases:[{name}], ... }
 *      (response also carries branch/endpoints/operations, which we ignore.)
 *   2. GET /projects/{project.id}/connection_uri
 *        ?database_name={databases[0].name}&role_name={roles[0].name}&pooled=true
 *        -> { uri }   (host contains "-pooler")
 *      (database_name and role_name are REQUIRED query params per the spec;
 *       pooled is an optional boolean, sent as the string "true".)
 *   envVars:
 *     DATABASE_URL          = pooled uri (step 2)
 *     DATABASE_URL_UNPOOLED = connection_uris[0].connection_uri (step 1)
 *   resourceId = project.id; provider = "neon".
 */
import type {
  DbProvisioner,
  NeonCreds,
  ProvisionResult,
} from "../interface.js";
import { NeonClient } from "./client.js";

/** Minimal subset of the Neon `POST /projects` 201 response we consume. */
type NeonCreateProjectResponse = {
  project: { id: string };
  connection_uris?: Array<{ connection_uri: string }>;
  roles?: Array<{ name: string }>;
  databases?: Array<{ name: string }>;
};

/** Neon `GET /projects` (list) 200 response. */
type NeonProjectsListResponse = {
  projects?: Array<{ id: string; name: string }>;
  pagination?: { cursor?: string };
};

/** Neon `GET /projects/{id}/databases` and `/roles` 200 responses. */
type NeonNamedListResponse = {
  databases?: Array<{ name: string }>;
  roles?: Array<{ name: string }>;
};

/** Neon `GET /projects/{id}/connection_uri` 200 response. */
type NeonConnectionUriResponse = { uri: string };

export class NeonProvisioner implements DbProvisioner {
  readonly provider = "neon" as const;

  readonly #client: NeonClient;

  constructor(creds: NeonCreds) {
    this.#client = new NeonClient(creds);
  }

  async provision(input: {
    name: string;
    region?: string;
  }): Promise<ProvisionResult> {
    // IDEMPOTENT by name: a retry (e.g. after a host-owned image build failed)
    // must NOT orphan a second Neon project. Look one up by name first; only
    // create when there is no match.
    const existingId = await this.#findProjectIdByName(input.name);

    let projectId: string;
    let databaseName: string;
    let roleName: string;
    let directUri: string;

    if (existingId !== undefined) {
      projectId = existingId;
      databaseName = await this.#firstName(projectId, "databases");
      roleName = await this.#firstName(projectId, "roles");
      directUri = await this.#connectionUri(
        projectId,
        databaseName,
        roleName,
        false,
      );
    } else {
      // pg_version 16 is within Neon's supported range (14-18 per the spec);
      // region, when supplied, maps to project.region_id.
      const projectBody: {
        name: string;
        pg_version: number;
        region_id?: string;
      } = { name: input.name, pg_version: 16 };
      if (input.region) projectBody.region_id = input.region;

      const created = await this.#client.request<NeonCreateProjectResponse>(
        "POST",
        "/projects",
        { body: { project: projectBody } },
      );

      const id = created.project?.id;
      if (!id) {
        throw new Error("Neon create-project response missing project.id");
      }
      const db = created.databases?.[0]?.name;
      const role = created.roles?.[0]?.name;
      if (!db || !role) {
        throw new Error(
          "Neon create-project response missing default database/role",
        );
      }
      const direct = created.connection_uris?.[0]?.connection_uri;
      if (!direct) {
        throw new Error(
          "Neon create-project response missing connection_uris[0].connection_uri",
        );
      }
      projectId = id;
      databaseName = db;
      roleName = role;
      directUri = direct;
    }

    // Pooled connection URI (host contains "-pooler"). database_name + role_name
    // are required query params per the Neon spec.
    const pooledUri = await this.#connectionUri(
      projectId,
      databaseName,
      roleName,
      true,
    );

    return {
      provider: "neon",
      resourceId: projectId,
      envVars: {
        DATABASE_URL: pooledUri,
        DATABASE_URL_UNPOOLED: directUri,
      },
    };
  }

  /** Page through GET /projects and return the id of a project whose name
   *  matches, or undefined. Bounded so a pathological account can't loop. */
  async #findProjectIdByName(name: string): Promise<string | undefined> {
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const query: Record<string, string> = { limit: "100" };
      if (cursor) query.cursor = cursor;
      const res = await this.#client.request<NeonProjectsListResponse>(
        "GET",
        "/projects",
        { query },
      );
      const projects = res.projects ?? [];
      const match = projects.find((p) => p.name === name);
      if (match) return match.id;
      cursor = res.pagination?.cursor;
      if (!cursor || projects.length === 0) break;
    }
    return undefined;
  }

  /** First database/role name for an existing project (the owner role + default db). */
  async #firstName(
    projectId: string,
    kind: "databases" | "roles",
  ): Promise<string> {
    const res = await this.#client.request<NeonNamedListResponse>(
      "GET",
      `/projects/${projectId}/${kind}`,
    );
    const name = res[kind]?.[0]?.name;
    if (!name) {
      throw new Error(`Neon project ${projectId} has no ${kind.slice(0, -1)}`);
    }
    return name;
  }

  /** GET the (pooled or direct) connection URI for a project's database/role. */
  async #connectionUri(
    projectId: string,
    databaseName: string,
    roleName: string,
    pooled: boolean,
  ): Promise<string> {
    const res = await this.#client.request<NeonConnectionUriResponse>(
      "GET",
      `/projects/${projectId}/connection_uri`,
      {
        query: {
          database_name: databaseName,
          role_name: roleName,
          pooled: pooled ? "true" : "false",
        },
      },
    );
    if (!res.uri) throw new Error("Neon connection_uri response missing uri");
    return res.uri;
  }
}

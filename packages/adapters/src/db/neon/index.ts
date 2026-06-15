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
    // 1. Create the project. pg_version 16 is within Neon's supported range
    //    (14-18 per the spec). region, when supplied, maps to project.region_id.
    const projectBody: {
      name: string;
      pg_version: number;
      region_id?: string;
    } = {
      name: input.name,
      pg_version: 16,
    };
    if (input.region) {
      projectBody.region_id = input.region;
    }

    const created = await this.#client.request<NeonCreateProjectResponse>(
      "POST",
      "/projects",
      { body: { project: projectBody } },
    );

    const projectId = created.project?.id;
    if (!projectId) {
      throw new Error("Neon create-project response missing project.id");
    }

    const databaseName = created.databases?.[0]?.name;
    const roleName = created.roles?.[0]?.name;
    if (!databaseName || !roleName) {
      throw new Error(
        "Neon create-project response missing default database/role",
      );
    }

    const directUri = created.connection_uris?.[0]?.connection_uri;
    if (!directUri) {
      throw new Error(
        "Neon create-project response missing connection_uris[0].connection_uri",
      );
    }

    // 2. Fetch the pooled connection URI (host contains "-pooler"). The Neon
    //    spec marks database_name and role_name as required query params.
    const pooled = await this.#client.request<NeonConnectionUriResponse>(
      "GET",
      `/projects/${projectId}/connection_uri`,
      {
        query: {
          database_name: databaseName,
          role_name: roleName,
          pooled: "true",
        },
      },
    );

    const pooledUri = pooled.uri;
    if (!pooledUri) {
      throw new Error("Neon connection_uri response missing uri");
    }

    return {
      provider: "neon",
      resourceId: projectId,
      envVars: {
        DATABASE_URL: pooledUri,
        DATABASE_URL_UNPOOLED: directUri,
      },
    };
  }
}

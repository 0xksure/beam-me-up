import { stringify } from "yaml";

import type { DetectedService } from "../schemas.js";

/**
 * generateCompose - emit a docker-compose yaml string with app + detected
 * db/cache services (healthchecks, depends_on with service_healthy condition,
 * named volumes for data, port mappings, env_file: [.env]).
 *
 * The app service builds from the local context (`build: .`), maps a port
 * (default 3000), reads env from `.env`, and `depends_on` every backing
 * datastore with `condition: service_healthy`. Each datastore service gets a
 * sensible default image, a healthcheck, and a named volume so data survives
 * `docker compose down`.
 */
export function generateCompose(services: DetectedService[]): string {
  const list = services ?? [];

  // Backing datastores are everything that is not the app itself.
  const dataKinds = new Set(["postgres", "redis", "mysql", "mongo"]);
  const appServices = list.filter((s) => s.kind === "app");
  const dataServices = list.filter((s) => dataKinds.has(s.kind));
  const otherServices = list.filter(
    (s) => s.kind !== "app" && !dataKinds.has(s.kind),
  );

  // services map + named volumes (declared at the top-level `volumes:` key).
  const composeServices: Record<string, unknown> = {};
  const volumes: Record<string, null> = {};

  // ---- app service(s) -------------------------------------------------
  // If no explicit app service was detected, synthesise a default "app".
  const apps =
    appServices.length > 0
      ? appServices
      : [{ name: "app", kind: "app" as const, port: 3000 }];

  for (const app of apps) {
    const appPort = app.port ?? 3000;
    const def: Record<string, unknown> = {
      build: ".",
      env_file: [".env"],
      ports: [`${appPort}:${appPort}`],
      restart: "unless-stopped",
    };

    // depends_on every datastore, gated on its healthcheck.
    if (dataServices.length > 0) {
      const dependsOn: Record<string, { condition: string }> = {};
      for (const ds of dataServices) {
        dependsOn[ds.name] = { condition: "service_healthy" };
      }
      def.depends_on = dependsOn;
    }

    composeServices[app.name] = def;
  }

  // ---- datastore services --------------------------------------------
  for (const ds of dataServices) {
    const built = buildDataService(ds);
    composeServices[ds.name] = built.service;
    if (built.volumeName) {
      volumes[built.volumeName] = null;
    }
  }

  // ---- passthrough "other" services ----------------------------------
  for (const other of otherServices) {
    const def: Record<string, unknown> = {
      env_file: [".env"],
      restart: "unless-stopped",
    };
    if (other.image) {
      def.image = other.image;
    } else {
      def.build = ".";
    }
    if (other.port !== undefined) {
      def.ports = [`${other.port}:${other.port}`];
    }
    composeServices[other.name] = def;
  }

  const compose: Record<string, unknown> = { services: composeServices };
  if (Object.keys(volumes).length > 0) {
    compose.volumes = volumes;
  }

  // Named volumes with no driver config render as `name: null` by default;
  // rewrite to the idiomatic empty form (`name:`) that docker compose expects.
  return stringify(compose, { lineWidth: 0 }).replace(
    /^( {2}[\w.-]+):\snull$/gm,
    "$1:",
  );
}

/** Per-kind defaults: image, exposed port, healthcheck test, data dir. */
function buildDataService(ds: DetectedService): {
  service: Record<string, unknown>;
  volumeName?: string;
} {
  switch (ds.kind) {
    case "postgres": {
      const port = ds.port ?? 5432;
      const volumeName = `${ds.name}-data`;
      return {
        volumeName,
        service: {
          image: ds.image ?? "postgres:16-alpine",
          env_file: [".env"],
          ports: [`${port}:5432`],
          volumes: [`${volumeName}:/var/lib/postgresql/data`],
          healthcheck: {
            test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER"],
            interval: "10s",
            timeout: "5s",
            retries: 5,
          },
          restart: "unless-stopped",
        },
      };
    }
    case "mysql": {
      const port = ds.port ?? 3306;
      const volumeName = `${ds.name}-data`;
      return {
        volumeName,
        service: {
          image: ds.image ?? "mysql:8",
          env_file: [".env"],
          ports: [`${port}:3306`],
          volumes: [`${volumeName}:/var/lib/mysql`],
          healthcheck: {
            test: ["CMD", "mysqladmin", "ping", "-h", "localhost"],
            interval: "10s",
            timeout: "5s",
            retries: 5,
          },
          restart: "unless-stopped",
        },
      };
    }
    case "mongo": {
      const port = ds.port ?? 27017;
      const volumeName = `${ds.name}-data`;
      return {
        volumeName,
        service: {
          image: ds.image ?? "mongo:7",
          env_file: [".env"],
          ports: [`${port}:27017`],
          volumes: [`${volumeName}:/data/db`],
          healthcheck: {
            test: [
              "CMD",
              "mongosh",
              "--eval",
              "db.adminCommand('ping')",
            ],
            interval: "10s",
            timeout: "5s",
            retries: 5,
          },
          restart: "unless-stopped",
        },
      };
    }
    case "redis":
    default: {
      const port = ds.port ?? 6379;
      const volumeName = `${ds.name}-data`;
      return {
        volumeName,
        service: {
          image: ds.image ?? "redis:7-alpine",
          ports: [`${port}:6379`],
          volumes: [`${volumeName}:/data`],
          healthcheck: {
            test: ["CMD", "redis-cli", "ping"],
            interval: "10s",
            timeout: "5s",
            retries: 5,
          },
          restart: "unless-stopped",
        },
      };
    }
  }
}

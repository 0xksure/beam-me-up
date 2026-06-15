import { parse } from "yaml";

import type {
  ValidateComposeInput,
  ValidateComposeOutput,
} from "@beam-me-up/core";
import { generateCompose } from "@beam-me-up/templates";

/** Image-name fragments that indicate a backing datastore service. */
const DB_IMAGE_HINTS = [
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
  "cockroach",
  "timescale",
  "pgvector",
];

/** Service-name fragments that indicate a backing datastore service. */
const DB_NAME_HINTS = ["postgres", "pg", "mysql", "mariadb", "mongo", "redis", "db", "cache", "database"];

/**
 * validateCompose - parse + structurally validate a docker-compose file, or
 * generate one from detectedServices when composeYaml is absent.
 *
 * Behaviour:
 *  - If `composeYaml` is provided, parse it with the `yaml` package and run
 *    structural checks: there must be a top-level `services` map; each service
 *    must declare `image` or `build`; datastore services should have a
 *    `healthcheck` and dependents should `depends_on` them (warnings). Invalid
 *    YAML or a missing/empty `services` map are hard errors (valid:false).
 *  - If `composeYaml` is absent but `detectedServices` are given, generate a
 *    correct compose via generateCompose and return valid:true.
 *  - If neither is given, that is an error.
 */
export function validateCompose(
  input: ValidateComposeInput,
): ValidateComposeOutput {
  const { composeYaml, detectedServices } = input;

  // ---- Generation path: no YAML supplied -----------------------------
  if (composeYaml === undefined || composeYaml.trim() === "") {
    if (detectedServices && detectedServices.length > 0) {
      const generated = generateCompose(detectedServices);
      return {
        composeYaml: generated,
        valid: true,
        errors: [],
        warnings: [],
      };
    }
    return {
      composeYaml: "",
      valid: false,
      errors: [
        "No composeYaml provided and no detectedServices to generate one from.",
      ],
      warnings: [],
    };
  }

  // ---- Validation path: parse the supplied YAML ----------------------
  const errors: string[] = [];
  const warnings: string[] = [];

  let doc: unknown;
  try {
    doc = parse(composeYaml);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      composeYaml,
      valid: false,
      errors: [`Invalid YAML: ${message}`],
      warnings: [],
    };
  }

  if (doc === null || doc === undefined) {
    return {
      composeYaml,
      valid: false,
      errors: ["Compose file is empty."],
      warnings: [],
    };
  }

  if (!isPlainObject(doc)) {
    return {
      composeYaml,
      valid: false,
      errors: ["Top-level of the compose file must be a mapping (object)."],
      warnings: [],
    };
  }

  const servicesRaw = doc.services;
  if (servicesRaw === undefined) {
    return {
      composeYaml,
      valid: false,
      errors: ["Missing top-level `services` mapping."],
      warnings: [],
    };
  }
  if (!isPlainObject(servicesRaw)) {
    return {
      composeYaml,
      valid: false,
      errors: ["Top-level `services` must be a mapping of service definitions."],
      warnings: [],
    };
  }

  const serviceNames = Object.keys(servicesRaw);
  if (serviceNames.length === 0) {
    errors.push("`services` mapping is empty - define at least one service.");
  }

  // Per-service structural checks.
  const dbServiceNames: string[] = [];
  for (const name of serviceNames) {
    const svc = servicesRaw[name];
    if (!isPlainObject(svc)) {
      errors.push(`Service \`${name}\` must be a mapping.`);
      continue;
    }

    const hasImage = typeof svc.image === "string" && svc.image.trim() !== "";
    const hasBuild = svc.build !== undefined && svc.build !== null;
    if (!hasImage && !hasBuild) {
      errors.push(`Service \`${name}\` must declare \`image\` or \`build\`.`);
    }

    // Identify datastore services by image or service name.
    const imageStr = hasImage ? String(svc.image).toLowerCase() : "";
    const nameLower = name.toLowerCase();
    const looksLikeDb =
      DB_IMAGE_HINTS.some((h) => imageStr.includes(h)) ||
      DB_NAME_HINTS.some((h) => nameLower === h || nameLower.includes(h));

    if (looksLikeDb) {
      dbServiceNames.push(name);
      if (svc.healthcheck === undefined) {
        warnings.push(
          `Datastore service \`${name}\` has no \`healthcheck\`; dependents cannot wait for it to become ready.`,
        );
      }
      if (svc.volumes === undefined) {
        warnings.push(
          `Datastore service \`${name}\` has no \`volumes\`; its data will not survive \`docker compose down\`.`,
        );
      }
    }
  }

  // Warn when a non-db service does not depend on any datastore (likely the
  // app should wait for the DB), and that depends_on uses service_healthy.
  if (dbServiceNames.length > 0) {
    for (const name of serviceNames) {
      if (dbServiceNames.includes(name)) continue;
      const svc = servicesRaw[name];
      if (!isPlainObject(svc)) continue;

      const dependsOn = svc.depends_on;
      const dependedNames = dependsOnNames(dependsOn);
      const dependsOnAnyDb = dependedNames.some((d) =>
        dbServiceNames.includes(d),
      );

      if (!dependsOnAnyDb) {
        warnings.push(
          `Service \`${name}\` does not \`depends_on\` any datastore (${dbServiceNames
            .map((d) => `\`${d}\``)
            .join(", ")}); it may start before the database is ready.`,
        );
      } else if (isPlainObject(dependsOn)) {
        // long-form depends_on: check each db dep declares condition: service_healthy
        for (const dep of dependedNames) {
          if (!dbServiceNames.includes(dep)) continue;
          const depDef = (dependsOn as Record<string, unknown>)[dep];
          const condition =
            isPlainObject(depDef) && typeof depDef.condition === "string"
              ? depDef.condition
              : undefined;
          if (condition !== "service_healthy") {
            warnings.push(
              `Service \`${name}\` depends on \`${dep}\` but not with \`condition: service_healthy\`; it may start before the database is ready.`,
            );
          }
        }
      } else if (Array.isArray(dependsOn)) {
        // short-form list cannot express service_healthy
        warnings.push(
          `Service \`${name}\` uses short-form \`depends_on\`; use the long form with \`condition: service_healthy\` so it waits for the datastore healthcheck.`,
        );
      }
    }
  }

  return {
    composeYaml,
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/** Extract the set of service names a `depends_on` value references. */
function dependsOnNames(dependsOn: unknown): string[] {
  if (Array.isArray(dependsOn)) {
    return dependsOn.filter((d): d is string => typeof d === "string");
  }
  if (isPlainObject(dependsOn)) {
    return Object.keys(dependsOn);
  }
  return [];
}

/** True for a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

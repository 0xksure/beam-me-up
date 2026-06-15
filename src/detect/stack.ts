/**
 * Stack / services / build detection for preflight_scan (M3).
 *
 * Pure, dependency-light (mirrors src/detect/signals.ts): only file paths +
 * (string) contents; no filesystem or network. Three exports:
 *
 *   detectStack(files)    -> PreflightStack
 *   detectServices(files) -> DetectedService[]
 *   detectBuild(files)    -> BuildPlan
 *
 * Reuse, don't duplicate: the framework hint and Dockerfile/compose logic
 * overlap with src/detect/signals.ts (deriveSignals). preflight-scan.ts already
 * calls deriveSignals for RepoSignals; here we produce the HUMAN-facing stack
 * classification + the structured service list + the build plan. You MAY import
 * helpers from ./signals.js if you export them, but do not change deriveSignals'
 * behavior.
 *
 * detectStack -> PreflightStack:
 *   - frontend: a client framework if present — "next"/"nuxt"/"remix"/
 *     "sveltekit"/"astro" (meta-frameworks count as frontend), or "vite-react"/
 *     "vite-vue"/"react"/"vue"/"svelte"/"angular" from package.json deps / config
 *     files (vite.config.*, angular.json). undefined if none.
 *   - backend: a server framework — "express"/"fastify"/"nestjs"/"koa"/"hapi"
 *     (node) or "django"/"fastapi"/"flask"/"starlette" (python) or "rails"/
 *     "sinatra" (ruby) or "gin"/"echo"/"fiber" (go). A meta-framework like Next
 *     can be BOTH; if only Next is present, set frontend="next" and leave backend
 *     undefined unless an explicit server framework is also present. undefined if none.
 *   - databases: union of engines implied by deps + connection strings + compose
 *     images, normalized to ["postgres","mysql","mongo","redis", ...]
 *     (e.g. deps "pg"/"postgres"/"@neondatabase/serverless" -> "postgres";
 *      "mysql"/"mysql2" -> "mysql"; "mongodb"/"mongoose" -> "mongo";
 *      "redis"/"ioredis"/"@upstash/redis" -> "redis"; "prisma" -> inspect schema
 *      provider when available). De-duplicated, stable order.
 *   - languages: from file extensions + manifests — "typescript" (tsconfig.json
 *     or .ts/.tsx), "javascript" (.js/.jsx, package.json), "python"
 *     (requirements.txt/pyproject.toml/.py), "go" (go.mod/.go), "ruby"
 *     (Gemfile/.rb). De-duplicated, stable order.
 *   - hasDockerfile / dockerfiles: paths whose basename is "Dockerfile",
 *     "Dockerfile.*", or "*.dockerfile".
 *   - composeFiles: paths matching docker-compose(.*)?.ya?ml / compose(.*)?.ya?ml.
 *
 * detectServices -> DetectedService[] (kind is "app"|"postgres"|"redis"|"mysql"|
 *   "mongo"|"other"):
 *   - If a docker-compose file is present, derive services from it (service name
 *     -> kind by image/name, port if declared). Otherwise synthesize a single
 *     { name: "app", kind: "app" } service plus one datastore service per
 *     detected database engine (e.g. { name: "postgres", kind: "postgres" }).
 *   - Keep it best-effort; this feeds validate_compose / route_target.
 *
 * detectBuild -> BuildPlan ("detect & instruct" — never executes anything):
 *   - packageManager: infer from lockfile/manifest — "pnpm" (pnpm-lock.yaml),
 *     "yarn" (yarn.lock), "bun" (bun.lockb), "npm" (package-lock.json or just
 *     package.json), "poetry" (pyproject.toml [tool.poetry] / poetry.lock),
 *     "pip" (requirements.txt), "go" (go.mod).
 *   - install/build/test/start/typecheck: the concrete command strings, derived
 *     from package.json "scripts" for node (e.g. build -> "npm run build" only
 *     when a "build" script exists; start -> "npm start" or "npm run start";
 *     test -> "npm test" when a real test script exists, not the npm default
 *     placeholder "echo \"Error: no test specified\""; typecheck -> "npm run
 *     typecheck" when present) using the detected packageManager's run syntax
 *     (pnpm run / yarn / bun run). For python: install "pip install -r
 *     requirements.txt" (or "poetry install"), start from a detected entrypoint.
 *     Leave a field undefined when there is no real command.
 *   - entrypoint: best-guess main file ("main"/"module" in package.json, or
 *     src/index.ts / src/main.ts / app.py / main.py / main.go if present).
 *   - instructions: ordered, e.g. ["Run `npm install` to install dependencies.",
 *     "Run `npm run build` and fix any build errors.", "Run `npm test` and make
 *     sure it passes.", "Run `npm start` locally to confirm it boots before
 *     deploying."] — only include steps whose command exists.
 *
 * STUB (M3 skeleton): the bodies are filled in by the implementer; the
 * signatures are final.
 */
import type {
  BuildPlan,
  DetectedService,
  PreflightFile,
  PreflightStack,
} from "../schemas.js";

/* ================================================================== */
/* detectStack                                                         */
/* ================================================================== */

/**
 * Classify the repo's stack for the HUMAN-facing summary + route_target.
 *
 * Pure: only file paths + (string) contents. We sniff package.json deps,
 * config files (vite.config.*, angular.json, next.config.*), connection
 * strings, compose images and file extensions. Best-effort, never throws.
 */
export function detectStack(files: PreflightFile[]): PreflightStack {
  let frontend: string | undefined;
  let backend: string | undefined;
  const databases = new Set<string>();
  const languages = new Set<string>();
  const dockerfiles: string[] = [];
  const composeFiles: string[] = [];

  for (const file of files) {
    const path = file.path ?? "";
    const content = file.content ?? "";
    const base = baseName(path);
    const lowerBase = base.toLowerCase();

    // ---- container files ----------------------------------------------
    if (isDockerfile(lowerBase)) dockerfiles.push(path);
    if (isComposeFile(lowerBase)) composeFiles.push(path);

    // ---- languages (from manifests + extensions) ----------------------
    addLanguages(languages, lowerBase, path);

    // ---- framework classification (frontend / backend) ----------------
    if (lowerBase === "package.json") {
      classifyPackageJson(content, (fe) => (frontend ??= fe), (be) => (backend ??= be));
      collectDepDatabases(content, databases);
    }
    if (/^vite\.config\.(js|cjs|mjs|ts|mts|cts)$/.test(lowerBase)) {
      frontend ??= viteFlavor(content);
    }
    if (lowerBase === "angular.json") {
      frontend ??= "angular";
    }
    if (/^next\.config\.(js|cjs|mjs|ts)$/.test(lowerBase)) {
      frontend ??= "next";
    }
    if (lowerBase === "nuxt.config.ts" || lowerBase === "nuxt.config.js") {
      frontend ??= "nuxt";
    }
    if (lowerBase === "svelte.config.js" || lowerBase === "svelte.config.ts") {
      frontend ??= "sveltekit";
    }
    if (lowerBase === "astro.config.mjs" || lowerBase === "astro.config.ts" || lowerBase === "astro.config.js") {
      frontend ??= "astro";
    }

    // python / ruby / go backend manifests.
    if (lowerBase === "requirements.txt" || lowerBase === "pyproject.toml" || lowerBase === "pipfile") {
      backend ??= pythonBackend(content);
      collectPythonDatabases(content, databases);
    }
    if (lowerBase === "gemfile") {
      backend ??= rubyBackend(content);
    }
    if (lowerBase === "go.mod") {
      backend ??= goBackend(content);
    }

    // ---- databases from connection strings + compose images ------------
    if (!isNoiseFile(lowerBase)) {
      collectStringDatabases(content, databases);
    }
    if (isComposeFile(lowerBase)) {
      collectComposeDatabases(content, databases);
    }
  }

  return {
    frontend,
    backend,
    databases: orderDatabases(databases),
    languages: orderLanguages(languages),
    hasDockerfile: dockerfiles.length > 0,
    dockerfiles,
    composeFiles,
  };
}

/* ================================================================== */
/* detectServices                                                      */
/* ================================================================== */

/**
 * Produce the structured service list consumed by validate_compose /
 * route_target. If a docker-compose file exists, derive services from it
 * (name -> kind by image/name, port if declared). Otherwise synthesize a
 * single "app" service plus one datastore service per detected db engine.
 */
export function detectServices(files: PreflightFile[]): DetectedService[] {
  for (const file of files) {
    const lowerBase = baseName(file.path ?? "").toLowerCase();
    if (isComposeFile(lowerBase)) {
      const services = servicesFromCompose(file.content ?? "");
      if (services.length > 0) return services;
    }
  }

  // No compose file: synthesize from the detected stack.
  const stack = detectStack(files);
  const services: DetectedService[] = [{ name: "app", kind: "app" }];
  for (const db of stack.databases) {
    const kind = dbEngineToKind(db);
    services.push({ name: db, kind });
  }
  return services;
}

/* ================================================================== */
/* detectBuild                                                         */
/* ================================================================== */

/**
 * "Detect & instruct": infer package manager + the concrete build/test/run
 * commands from manifests/scripts and produce an ordered instructions[] for
 * the host AI. Never executes anything; leaves a field undefined when there
 * is no real command.
 */
export function detectBuild(files: PreflightFile[]): BuildPlan {
  let packageJson: string | undefined;
  let hasRequirements = false;
  let hasPyproject = false;
  let pyprojectContent = "";
  let hasPoetryLock = false;
  let hasGoMod = false;

  let hasPnpmLock = false;
  let hasYarnLock = false;
  let hasBunLock = false;
  let hasNpmLock = false;
  let hasPackageJson = false;

  const present = new Set<string>();

  for (const file of files) {
    const lowerBase = baseName(file.path ?? "").toLowerCase();
    present.add((file.path ?? "").replace(/\\/g, "/"));

    if (lowerBase === "package.json") {
      hasPackageJson = true;
      packageJson = file.content ?? "";
    } else if (lowerBase === "package-lock.json") {
      hasNpmLock = true;
    } else if (lowerBase === "pnpm-lock.yaml") {
      hasPnpmLock = true;
    } else if (lowerBase === "yarn.lock") {
      hasYarnLock = true;
    } else if (lowerBase === "bun.lockb" || lowerBase === "bun.lock") {
      hasBunLock = true;
    } else if (lowerBase === "requirements.txt") {
      hasRequirements = true;
    } else if (lowerBase === "pyproject.toml") {
      hasPyproject = true;
      pyprojectContent = file.content ?? "";
    } else if (lowerBase === "poetry.lock") {
      hasPoetryLock = true;
    } else if (lowerBase === "go.mod") {
      hasGoMod = true;
    }
  }

  // ---- Node project --------------------------------------------------
  if (hasPackageJson) {
    const pm: NodePackageManager = hasPnpmLock
      ? "pnpm"
      : hasYarnLock
        ? "yarn"
        : hasBunLock
          ? "bun"
          : "npm"; // package-lock.json OR a bare package.json both -> npm
    return buildNodePlan(pm, packageJson ?? "", { hasNpmLock });
  }

  // ---- Python project ------------------------------------------------
  if (hasRequirements || hasPyproject || hasPoetryLock) {
    const usesPoetry = hasPoetryLock || isPoetryProject(pyprojectContent);
    return buildPythonPlan(usesPoetry, present);
  }

  // ---- Go project ----------------------------------------------------
  if (hasGoMod) {
    return buildGoPlan(present);
  }

  return { instructions: [] };
}

/* ================================================================== */
/* Node build plan                                                     */
/* ================================================================== */

type NodePackageManager = "npm" | "yarn" | "pnpm" | "bun";

function buildNodePlan(
  pm: NodePackageManager,
  packageJsonContent: string,
  _ctx: { hasNpmLock: boolean },
): BuildPlan {
  const { scripts, main, module } = parsePackageJson(packageJsonContent);

  const install = installCommand(pm);
  const build = scripts["build"] ? runCommand(pm, "build") : undefined;
  const typecheck = scripts["typecheck"]
    ? runCommand(pm, "typecheck")
    : scripts["type-check"]
      ? runCommand(pm, "type-check")
      : undefined;
  const test = isRealTestScript(scripts["test"]) ? testCommand(pm) : undefined;
  const start = scripts["start"]
    ? startCommand(pm)
    : scripts["serve"]
      ? runCommand(pm, "serve")
      : undefined;

  const entrypoint = main ?? module ?? undefined;

  const instructions: string[] = [];
  instructions.push(`Run \`${install}\` to install dependencies.`);
  if (build) {
    instructions.push(`Run \`${build}\` and fix any build errors.`);
  }
  if (typecheck) {
    instructions.push(`Run \`${typecheck}\` and fix any type errors.`);
  }
  if (test) {
    instructions.push(`Run \`${test}\` and make sure it passes.`);
  }
  if (start) {
    instructions.push(`Run \`${start}\` locally to confirm it boots before deploying.`);
  }

  return {
    packageManager: pm,
    install,
    ...(build ? { build } : {}),
    ...(test ? { test } : {}),
    ...(start ? { start } : {}),
    ...(typecheck ? { typecheck } : {}),
    ...(entrypoint ? { entrypoint } : {}),
    instructions,
  };
}

function installCommand(pm: NodePackageManager): string {
  switch (pm) {
    case "pnpm":
      return "pnpm install";
    case "yarn":
      return "yarn install";
    case "bun":
      return "bun install";
    default:
      return "npm install";
  }
}

/** `npm run <script>` / `pnpm run <script>` / `yarn <script>` / `bun run <script>`. */
function runCommand(pm: NodePackageManager, script: string): string {
  switch (pm) {
    case "pnpm":
      return `pnpm run ${script}`;
    case "yarn":
      return `yarn ${script}`;
    case "bun":
      return `bun run ${script}`;
    default:
      return `npm run ${script}`;
  }
}

/** `npm test` and friends (test has a bare alias in every manager). */
function testCommand(pm: NodePackageManager): string {
  switch (pm) {
    case "pnpm":
      return "pnpm test";
    case "yarn":
      return "yarn test";
    case "bun":
      return "bun test";
    default:
      return "npm test";
  }
}

/** `npm start` and friends (start also has a bare alias). */
function startCommand(pm: NodePackageManager): string {
  switch (pm) {
    case "pnpm":
      return "pnpm start";
    case "yarn":
      return "yarn start";
    case "bun":
      return "bun start";
    default:
      return "npm start";
  }
}

/**
 * A "real" test script is one the author actually wrote — not the npm init
 * placeholder that just errors out.
 */
function isRealTestScript(script: string | undefined): boolean {
  if (!script) return false;
  const trimmed = script.trim();
  if (trimmed === "") return false;
  if (/no test specified/i.test(trimmed)) return false;
  return true;
}

function parsePackageJson(content: string): {
  scripts: Record<string, string>;
  main?: string;
  module?: string;
} {
  try {
    const parsed = JSON.parse(content) as {
      scripts?: Record<string, string>;
      main?: string;
      module?: string;
    };
    return {
      scripts: parsed.scripts ?? {},
      ...(typeof parsed.main === "string" ? { main: parsed.main } : {}),
      ...(typeof parsed.module === "string" ? { module: parsed.module } : {}),
    };
  } catch {
    return { scripts: {} };
  }
}

/* ================================================================== */
/* Python / Go build plans                                             */
/* ================================================================== */

function isPoetryProject(pyprojectContent: string): boolean {
  return /\[tool\.poetry\]/.test(pyprojectContent);
}

function buildPythonPlan(usesPoetry: boolean, present: Set<string>): BuildPlan {
  const pm = usesPoetry ? "poetry" : "pip";
  const install = usesPoetry ? "poetry install" : "pip install -r requirements.txt";

  const entrypoint = firstPresent(present, ["app.py", "main.py", "src/main.py", "src/app.py", "wsgi.py", "asgi.py", "manage.py"]);
  const start = startForPythonEntry(entrypoint, usesPoetry);

  const instructions: string[] = [];
  instructions.push(`Run \`${install}\` to install dependencies.`);
  if (start) {
    instructions.push(`Run \`${start}\` locally to confirm it boots before deploying.`);
  }

  return {
    packageManager: pm,
    install,
    ...(start ? { start } : {}),
    ...(entrypoint ? { entrypoint } : {}),
    instructions,
  };
}

function startForPythonEntry(entry: string | undefined, usesPoetry: boolean): string | undefined {
  if (!entry) return undefined;
  const base = baseName(entry).toLowerCase();
  const prefix = usesPoetry ? "poetry run " : "";
  if (base === "manage.py") return `${prefix}python manage.py runserver`;
  return `${prefix}python ${entry}`;
}

function buildGoPlan(present: Set<string>): BuildPlan {
  const install = "go mod download";
  const build = "go build ./...";
  const test = "go test ./...";
  const entrypoint = firstPresent(present, ["main.go", "cmd/main.go", "src/main.go"]);
  const start = entrypoint ? "go run ." : undefined;

  const instructions: string[] = [];
  instructions.push(`Run \`${install}\` to install dependencies.`);
  instructions.push(`Run \`${build}\` and fix any build errors.`);
  instructions.push(`Run \`${test}\` and make sure it passes.`);
  if (start) {
    instructions.push(`Run \`${start}\` locally to confirm it boots before deploying.`);
  }

  return {
    packageManager: "go",
    install,
    build,
    test,
    ...(start ? { start } : {}),
    ...(entrypoint ? { entrypoint } : {}),
    instructions,
  };
}

function firstPresent(present: Set<string>, candidates: string[]): string | undefined {
  for (const c of candidates) {
    if (present.has(c)) return c;
  }
  // also accept candidates that appear as a suffix (e.g. nested dir).
  for (const c of candidates) {
    for (const p of present) {
      if (p === c || p.endsWith(`/${c}`)) return p;
    }
  }
  return undefined;
}

/* ================================================================== */
/* Stack classification helpers                                        */
/* ================================================================== */

/**
 * Classify a package.json into a frontend and/or backend framework. A
 * meta-framework like Next counts as frontend; a bare server framework counts
 * as backend; Next leaves backend undefined unless an explicit server
 * framework is ALSO present.
 */
function classifyPackageJson(
  content: string,
  setFrontend: (fe: string) => void,
  setBackend: (be: string) => void,
): void {
  const deps = parseDeps(content);
  const has = (name: string): boolean => name in deps;

  // ---- frontend (meta-frameworks first) -----------------------------
  let fe: string | undefined;
  if (has("next")) fe = "next";
  else if (has("nuxt") || has("nuxt3")) fe = "nuxt";
  else if (has("@remix-run/react") || has("@remix-run/node") || has("@remix-run/serve")) fe = "remix";
  else if (has("@sveltejs/kit")) fe = "sveltekit";
  else if (has("astro")) fe = "astro";
  else if (has("@angular/core")) fe = "angular";
  else if (has("vite")) {
    if (has("react") || has("react-dom")) fe = "vite-react";
    else if (has("vue")) fe = "vite-vue";
    else fe = "vite";
  } else if (has("react") || has("react-dom")) fe = "react";
  else if (has("vue")) fe = "vue";
  else if (has("svelte")) fe = "svelte";
  if (fe) setFrontend(fe);

  // ---- backend (explicit server frameworks) -------------------------
  let be: string | undefined;
  if (has("@nestjs/core")) be = "nestjs";
  else if (has("fastify")) be = "fastify";
  else if (has("@hapi/hapi") || has("hapi")) be = "hapi";
  else if (has("koa")) be = "koa";
  else if (has("express")) be = "express";
  if (be) setBackend(be);
}

function parseDeps(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    return { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) };
  } catch {
    return {};
  }
}

/** A vite.config.* file: guess the framework flavor from its plugin imports. */
function viteFlavor(content: string): string {
  if (/@vitejs\/plugin-react|plugin-react-swc/.test(content)) return "vite-react";
  if (/@vitejs\/plugin-vue/.test(content)) return "vite-vue";
  if (/@sveltejs\/vite-plugin-svelte|svelte/i.test(content)) return "svelte";
  return "vite";
}

function pythonBackend(content: string): string | undefined {
  const lower = content.toLowerCase();
  if (/\bdjango\b/.test(lower)) return "django";
  if (/\bfastapi\b/.test(lower)) return "fastapi";
  if (/\bflask\b/.test(lower)) return "flask";
  if (/\bstarlette\b/.test(lower)) return "starlette";
  return undefined;
}

function rubyBackend(content: string): string | undefined {
  if (/\brails\b/i.test(content)) return "rails";
  if (/\bsinatra\b/i.test(content)) return "sinatra";
  return undefined;
}

function goBackend(content: string): string | undefined {
  if (/gin-gonic\/gin/.test(content)) return "gin";
  if (/labstack\/echo/.test(content)) return "echo";
  if (/gofiber\/fiber/.test(content)) return "fiber";
  return undefined;
}

/* ------------------------------------------------------------------ */
/* database detection                                                  */
/* ------------------------------------------------------------------ */

/** Map node deps to db engines. */
function collectDepDatabases(content: string, out: Set<string>): void {
  const deps = parseDeps(content);
  const has = (name: string): boolean => name in deps;

  if (has("pg") || has("postgres") || has("@neondatabase/serverless") || has("pg-promise") || has("postgres.js")) {
    out.add("postgres");
  }
  if (has("mysql") || has("mysql2")) out.add("mysql");
  if (has("mongodb") || has("mongoose")) out.add("mongo");
  if (has("redis") || has("ioredis") || has("@upstash/redis")) out.add("redis");

  // Prisma: inspect the schema provider elsewhere; here just flag if the dep
  // alone hints at a relational store via the datasource (best-effort: leave
  // to schema scan via collectStringDatabases).
}

function collectPythonDatabases(content: string, out: Set<string>): void {
  const lower = content.toLowerCase();
  if (/\bpsycopg2?\b|\basyncpg\b/.test(lower)) out.add("postgres");
  if (/\bpymysql\b|\bmysqlclient\b/.test(lower)) out.add("mysql");
  if (/\bpymongo\b|\bmotor\b/.test(lower)) out.add("mongo");
  if (/\bredis\b|\baioredis\b/.test(lower)) out.add("redis");
}

/** Connection-string and prisma-provider sniffing over source text. */
function collectStringDatabases(content: string, out: Set<string>): void {
  if (/postgres(?:ql)?:\/\//.test(content)) out.add("postgres");
  if (/mysql:\/\//.test(content)) out.add("mysql");
  if (/mongodb(?:\+srv)?:\/\//.test(content)) out.add("mongo");
  if (/redis(?:s)?:\/\//.test(content)) out.add("redis");

  // prisma schema datasource provider.
  const provider = /provider\s*=\s*["']([a-z]+)["']/i.exec(content);
  if (provider) {
    const p = (provider[1] ?? "").toLowerCase();
    if (p === "postgresql" || p === "postgres") out.add("postgres");
    else if (p === "mysql") out.add("mysql");
    else if (p === "mongodb") out.add("mongo");
  }
}

/** Datastore engines implied by docker-compose images. */
function collectComposeDatabases(content: string, out: Set<string>): void {
  const imageRe = /(^|\n)\s*image\s*:\s*["']?([^\s"'#]+)/g;
  let m: RegExpExecArray | null;
  while ((m = imageRe.exec(content)) !== null) {
    const image = (m[2] ?? "").toLowerCase();
    const engine = imageToEngine(image);
    if (engine) out.add(engine);
  }
}

function imageToEngine(image: string): string | undefined {
  if (/postgres|postgis|timescale|cockroach/.test(image)) return "postgres";
  if (/mysql|mariadb/.test(image)) return "mysql";
  if (/mongo/.test(image)) return "mongo";
  if (/redis|valkey/.test(image)) return "redis";
  return undefined;
}

/** Stable, conventional output order; unknown engines appended in encounter order. */
function orderDatabases(set: Set<string>): string[] {
  const preferred = ["postgres", "mysql", "mongo", "redis"];
  const out: string[] = [];
  for (const p of preferred) {
    if (set.has(p)) out.push(p);
  }
  for (const e of set) {
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* languages                                                           */
/* ------------------------------------------------------------------ */

function addLanguages(out: Set<string>, lowerBase: string, path: string): void {
  if (lowerBase === "tsconfig.json" || /\.(ts|tsx|mts|cts)$/.test(lowerBase)) {
    out.add("typescript");
  }
  if (lowerBase === "package.json" || /\.(js|jsx|mjs|cjs)$/.test(lowerBase)) {
    out.add("javascript");
  }
  if (
    lowerBase === "requirements.txt" ||
    lowerBase === "pyproject.toml" ||
    lowerBase === "pipfile" ||
    /\.py$/.test(lowerBase)
  ) {
    out.add("python");
  }
  if (lowerBase === "go.mod" || /\.go$/.test(lowerBase)) {
    out.add("go");
  }
  if (lowerBase === "gemfile" || /\.rb$/.test(lowerBase)) {
    out.add("ruby");
  }
  // path is currently unused beyond lowerBase, kept for parity/extension.
  void path;
}

function orderLanguages(set: Set<string>): string[] {
  const preferred = ["typescript", "javascript", "python", "go", "ruby"];
  const out: string[] = [];
  for (const p of preferred) {
    if (set.has(p)) out.push(p);
  }
  for (const l of set) {
    if (!out.includes(l)) out.push(l);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* compose -> services                                                 */
/* ------------------------------------------------------------------ */

/**
 * Derive DetectedService[] from a docker-compose file by walking indentation
 * (no yaml dependency — the validate tool uses the real parser). For each
 * top-level service we classify kind by image/name and extract a port if one
 * is declared.
 */
function servicesFromCompose(content: string): DetectedService[] {
  const lines = content.split(/\r?\n/);

  let servicesIndent = -1;
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (isBlankOrComment(line)) continue;
    const m = /^(\s*)services\s*:\s*$/.exec(line);
    if (m) {
      servicesIndent = (m[1] ?? "").length;
      i++;
      break;
    }
  }
  if (servicesIndent < 0) return [];

  let childIndent = -1;
  type Block = { name: string; lines: string[] };
  const blocks: Block[] = [];
  let current: Block | null = null;

  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (isBlankOrComment(line)) continue;
    const indent = leadingSpaces(line);
    if (indent <= servicesIndent) break;
    if (childIndent < 0) childIndent = indent;

    if (indent === childIndent) {
      const m = /^\s*["']?([A-Za-z0-9._-]+)["']?\s*:\s*(.*)$/.exec(line);
      if (m) {
        current = { name: m[1] ?? "", lines: [] };
        blocks.push(current);
        continue;
      }
    }
    if (current && indent > childIndent) {
      current.lines.push(line);
    }
  }

  const services: DetectedService[] = [];
  for (const block of blocks) {
    const body = block.lines.join("\n");
    const image = parseComposeImage(body);
    const kind = composeKind(block.name, image);
    const port = parseComposePort(body);
    services.push({
      name: block.name,
      kind,
      ...(image ? { image } : {}),
      ...(port !== undefined ? { port } : {}),
    });
  }
  return services;
}

function parseComposeImage(body: string): string | undefined {
  const m = /(^|\n)\s*image\s*:\s*["']?([^\s"'#]+)/.exec(body);
  return m ? m[2] : undefined;
}

/** First published/declared port number, if any (e.g. "3000:3000" -> 3000). */
function parseComposePort(body: string): number | undefined {
  const portsBlock = /(^|\n)\s*ports\s*:/.test(body);
  if (!portsBlock) return undefined;
  // "- 3000:3000" / "- "3000:3000"" / "- 8080" / target/published mapping.
  const m = /["']?(\d{2,5})(?::\d{2,5})?["']?/.exec(body.slice(body.search(/ports\s*:/)));
  if (m && m[1]) {
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function composeKind(name: string, image: string | undefined): DetectedService["kind"] {
  const lowerName = name.toLowerCase();
  const lowerImage = (image ?? "").toLowerCase();

  const engine = lowerImage ? imageToEngine(lowerImage) : undefined;
  if (engine) return dbEngineToKind(engine);

  // Name-based hints when no image (e.g. a build-only db is rare, but allow it).
  if (/postgres|postgresql|^pg$|^db$|database/.test(lowerName)) return "postgres";
  if (/mysql|mariadb/.test(lowerName)) return "mysql";
  if (/mongo/.test(lowerName)) return "mongo";
  if (/redis|valkey|^cache$/.test(lowerName)) return "redis";

  // A service that builds from source / has a generic image is the app.
  return "app";
}

function dbEngineToKind(engine: string): DetectedService["kind"] {
  switch (engine) {
    case "postgres":
      return "postgres";
    case "mysql":
      return "mysql";
    case "mongo":
      return "mongo";
    case "redis":
      return "redis";
    default:
      return "other";
  }
}

/* ------------------------------------------------------------------ */
/* Path + text helpers (mirrors src/detect/signals.ts conventions)     */
/* ------------------------------------------------------------------ */

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

function isDockerfile(lowerBase: string): boolean {
  return (
    lowerBase === "dockerfile" ||
    lowerBase.startsWith("dockerfile.") ||
    lowerBase.endsWith(".dockerfile")
  );
}

function isComposeFile(lowerBase: string): boolean {
  return (
    /^docker-compose(\.[^.]+)*\.ya?ml$/.test(lowerBase) ||
    /^compose(\.[^.]+)*\.ya?ml$/.test(lowerBase)
  );
}

function isNoiseFile(lowerBase: string): boolean {
  return (
    lowerBase === "package-lock.json" ||
    lowerBase === "yarn.lock" ||
    lowerBase === "pnpm-lock.yaml" ||
    lowerBase === "poetry.lock" ||
    lowerBase === "gemfile.lock" ||
    lowerBase.endsWith(".min.js") ||
    lowerBase.endsWith(".map")
  );
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function leadingSpaces(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 2;
    else break;
  }
  return n;
}

import type { RepoSignals } from "../schemas.js";

/**
 * deriveSignals - heuristics over repo files to produce RepoSignals.
 *
 * Pure, dependency-light: we only look at file paths and their (string)
 * contents. No filesystem or network access. The goal is a best-effort
 * structural read of a repo so route_target can decide Vercel vs container.
 *
 * Heuristics:
 *  - hasDockerfile         : presence of a Dockerfile anywhere in the tree.
 *  - composeAppServices    : number of *application* services (non db/cache)
 *                            declared in any docker-compose file.
 *  - wsServer              : SERVER-side websocket usage (ws / socket.io)
 *                            bound to an http server, distinguished from
 *                            browser/client usage.
 *  - workers              : background job runners (bull/bullmq/celery/
 *                            sidekiq/agenda/node-cron loops).
 *  - listensOnPort         : a persistent listener, e.g.
 *                            app.listen(process.env.PORT) / server.listen(...).
 *  - longHandlers          : request handlers that look long-running
 *                            (streaming/SSE, long timeouts, while-true loops).
 *  - persistentFsWrites    : fs.writeFile(...) to a path that is NOT
 *                            /tmp and not an obvious cache dir.
 *  - framework             : a coarse framework hint (next, express, ...).
 */
export function deriveSignals(
  files: { path: string; content: string }[],
): RepoSignals {
  const signals: RepoSignals = {
    hasDockerfile: false,
    composeAppServices: 0,
    wsServer: false,
    workers: false,
    listensOnPort: false,
    longHandlers: false,
    persistentFsWrites: false,
  };

  let composeAppServices = 0;
  let framework: string | undefined;

  for (const file of files) {
    const path = file.path ?? "";
    const content = file.content ?? "";
    const base = baseName(path);
    const lowerBase = base.toLowerCase();

    // ---- Dockerfile presence -------------------------------------------
    // Matches "Dockerfile", "Dockerfile.prod", "api.Dockerfile", etc.
    if (lowerBase === "dockerfile" || lowerBase.startsWith("dockerfile.") || lowerBase.endsWith(".dockerfile")) {
      signals.hasDockerfile = true;
    }

    // ---- docker-compose app-service count ------------------------------
    if (isComposeFile(lowerBase)) {
      composeAppServices = Math.max(composeAppServices, countComposeAppServices(content));
    }

    // ---- framework hint -------------------------------------------------
    framework = framework ?? detectFramework(path, content);

    // The remaining heuristics only make sense over source-ish text files;
    // skip lockfiles and other very large generated artefacts.
    if (isNoiseFile(lowerBase)) continue;

    if (!signals.wsServer && hasServerWebSocket(content)) {
      signals.wsServer = true;
    }
    if (!signals.workers && hasWorkers(content)) {
      signals.workers = true;
    }
    if (!signals.listensOnPort && listensOnPort(content)) {
      signals.listensOnPort = true;
    }
    if (!signals.longHandlers && hasLongHandlers(content)) {
      signals.longHandlers = true;
    }
    if (!signals.persistentFsWrites && hasPersistentFsWrite(content)) {
      signals.persistentFsWrites = true;
    }
  }

  signals.composeAppServices = composeAppServices;
  if (framework) signals.framework = framework;

  return signals;
}

/* ------------------------------------------------------------------ */
/* Path helpers                                                        */
/* ------------------------------------------------------------------ */

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

function isComposeFile(lowerBase: string): boolean {
  // docker-compose.yml, docker-compose.yaml, compose.yml, compose.yaml,
  // docker-compose.prod.yml, compose.override.yaml, etc.
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

/* ------------------------------------------------------------------ */
/* docker-compose parsing (lightweight, no yaml dep)                   */
/* ------------------------------------------------------------------ */

const DB_IMAGE_HINTS = [
  "postgres",
  "postgis",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
  "memcached",
  "rabbitmq",
  "elasticsearch",
  "opensearch",
  "clickhouse",
  "cassandra",
  "cockroach",
  "valkey",
  "minio",
  "etcd",
  "nats",
  "kafka",
  "zookeeper",
  "influxdb",
  "timescale",
];

const DB_NAME_HINTS = [
  "postgres",
  "postgresql",
  "pg",
  "db",
  "database",
  "mysql",
  "mariadb",
  "mongo",
  "mongodb",
  "redis",
  "cache",
  "memcached",
  "rabbitmq",
  "rabbit",
  "broker",
  "queue",
  "elasticsearch",
  "elastic",
  "opensearch",
  "kafka",
  "zookeeper",
  "nats",
  "minio",
  "clickhouse",
  "valkey",
];

/**
 * Count *application* services in a docker-compose file by walking
 * indentation. We intentionally avoid a yaml dependency here (the validate
 * tool uses the real parser); this needs only the service names + their
 * image to decide app vs datastore.
 */
function countComposeAppServices(content: string): number {
  const lines = content.split(/\r?\n/);

  // Find the top-level `services:` key and its indentation.
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
  if (servicesIndent < 0) return 0;

  // Service entries are the keys indented exactly one level deeper than
  // `services:`. Determine that child indent from the first child we see.
  let childIndent = -1;
  type ServiceBlock = { name: string; lines: string[] };
  const services: ServiceBlock[] = [];
  let current: ServiceBlock | null = null;

  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (isBlankOrComment(line)) continue;

    const indent = leadingSpaces(line);

    // Dedented back to (or above) `services:` -> the services block ended.
    if (indent <= servicesIndent) break;

    if (childIndent < 0) childIndent = indent;

    if (indent === childIndent) {
      // A new service key, e.g. "  web:" .
      const m = /^\s*["']?([A-Za-z0-9._-]+)["']?\s*:\s*(.*)$/.exec(line);
      if (m) {
        current = { name: m[1] ?? "", lines: [] };
        services.push(current);
        continue;
      }
    }
    if (current && indent > childIndent) {
      current.lines.push(line);
    }
  }

  let appCount = 0;
  for (const svc of services) {
    if (isAppService(svc.name, svc.lines.join("\n"))) appCount++;
  }
  return appCount;
}

function isAppService(name: string, body: string): boolean {
  const lowerName = name.toLowerCase();
  const lowerBody = body.toLowerCase();

  // A service that is `build:`-ed from local source is almost always the app.
  const hasBuild = /(^|\n)\s*build\s*:/.test(body);

  const imageMatch = /(^|\n)\s*image\s*:\s*["']?([^\s"'#]+)/.exec(body);
  const image = imageMatch ? (imageMatch[2] ?? "").toLowerCase() : "";

  if (hasBuild) return true;

  // Image points at a known datastore -> not an app.
  if (image && DB_IMAGE_HINTS.some((h) => image.includes(h))) return false;

  // Name strongly implies a datastore -> not an app.
  if (DB_NAME_HINTS.includes(lowerName)) return false;
  if (lowerBody.includes("postgres_password") || lowerBody.includes("mysql_root_password") || lowerBody.includes("mongo_initdb")) {
    return false;
  }

  // Otherwise treat as an application service (custom image, no build, etc.).
  return true;
}

/* ------------------------------------------------------------------ */
/* websocket server detection                                          */
/* ------------------------------------------------------------------ */

/**
 * Server-side websocket usage, distinguished from client usage.
 *
 * Positive server signals:
 *   - new WebSocketServer(...) / new WebSocket.Server(...) / ws.Server
 *   - socket.io's `new Server(`  (Socket.IO server) or io.on("connection"
 *   - require/import of "ws" or "socket.io" (the server pkg)
 *   - python websockets.serve / FastAPI @app.websocket / Django channels
 *
 * We explicitly do NOT count:
 *   - new WebSocket("ws://...")               (browser/client connect)
 *   - import { io } from "socket.io-client"   (client lib)
 */
function hasServerWebSocket(content: string): boolean {
  // Client-only patterns we want to avoid mis-firing on.
  const serverPatterns: RegExp[] = [
    /new\s+WebSocketServer\s*\(/,
    /new\s+WebSocket\.Server\s*\(/,
    /new\s+ws\.Server\s*\(/,
    /\bWebSocketServer\b/, // named import from "ws"
    // socket.io server: `new Server(` (from "socket.io"), or io.on("connection")
    /from\s+["']socket\.io["']/,
    /require\(\s*["']socket\.io["']\s*\)/,
    /\bnew\s+(?:SocketIO)?Server\s*\([^)]*\)/, // new Server(httpServer, ...)
    /\bio\s*\.\s*on\s*\(\s*["']connection["']/,
    // raw "ws" server import
    /from\s+["']ws["']/,
    /require\(\s*["']ws["']\s*\)/,
    // python / channels
    /websockets\.serve\s*\(/,
    /@app\.websocket\b/,
    /channels\.routing/,
    /AsyncWebsocketConsumer\b/,
    // ASGI / starlette websocket route
    /WebSocketRoute\s*\(/,
  ];

  // socket.io-client / browser client only -> not a server signal by itself.
  const clientOnly = /socket\.io-client|from\s+["']socket\.io-client["']/.test(content);

  // `new Server(` is ambiguous; only count it when paired with an http server
  // handle or a socket.io import in the same file.
  const looksSocketIoServer =
    /from\s+["']socket\.io["']/.test(content) ||
    /require\(\s*["']socket\.io["']\s*\)/.test(content) ||
    /\bio\s*\.\s*on\s*\(\s*["']connection["']/.test(content);

  for (const re of serverPatterns) {
    if (re.test(content)) {
      // The bare `new Server(` pattern is only trustworthy alongside a
      // socket.io import or an io.on("connection") usage.
      if (re.source.includes("SocketIO")) {
        if (looksSocketIoServer) return true;
        continue;
      }
      // "ws"/"socket.io" import lines are server-side unless the file is
      // purely the client package.
      if ((re.source.includes('socket\\.io') || re.source.includes("['\"]ws['\"]")) && clientOnly && !looksSocketIoServer) {
        continue;
      }
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* background workers                                                   */
/* ------------------------------------------------------------------ */

function hasWorkers(content: string): boolean {
  const patterns: RegExp[] = [
    // BullMQ / Bull
    /new\s+Worker\s*\(/, // bullmq Worker
    /new\s+Queue\s*\(/, // bull/bullmq Queue
    /from\s+["']bullmq["']/,
    /require\(\s*["']bullmq["']\s*\)/,
    /from\s+["']bull["']/,
    /require\(\s*["']bull["']\s*\)/,
    // Agenda
    /from\s+["']agenda["']/,
    /require\(\s*["']agenda["']\s*\)/,
    /new\s+Agenda\s*\(/,
    // node-cron / cron loops
    /from\s+["']node-cron["']/,
    /require\(\s*["']node-cron["']\s*\)/,
    /cron\.schedule\s*\(/,
    /new\s+CronJob\s*\(/,
    /from\s+["']cron["']/,
    // Celery (python)
    /from\s+celery\b/,
    /import\s+celery\b/,
    /Celery\s*\(/,
    /@(?:app|celery)\.task\b/,
    /@shared_task\b/,
    // Sidekiq (ruby)
    /include\s+Sidekiq::(?:Worker|Job)/,
    /Sidekiq\.configure_server/,
    // RQ (python redis queue)
    /from\s+rq\b/,
    /\bWorker\(\s*\[/, // rq Worker([...])
  ];
  return patterns.some((re) => re.test(content));
}

/* ------------------------------------------------------------------ */
/* persistent listener                                                  */
/* ------------------------------------------------------------------ */

function listensOnPort(content: string): boolean {
  const patterns: RegExp[] = [
    // express / koa / fastify / node http: app.listen(PORT) etc.
    /\.\s*listen\s*\(\s*(?:process\.env\.PORT|process\.env\[["']PORT["']\]|PORT\b|\d{2,5}|port\b)/,
    /\.\s*listen\s*\(\s*\{[^}]*port\b/,
    // server.listen() with a port-ish first arg already covered above.
    // python: uvicorn.run(..., port=...) / app.run(host=..., port=...)
    /uvicorn\.run\s*\(/,
    /\.run\s*\([^)]*port\s*=/,
    // gunicorn bind, flask run
    /gunicorn[^\n]*--bind/,
    // go: http.ListenAndServe(":8080", ...)
    /http\.ListenAndServe\s*\(/,
    // rails / puma typically a long-lived server too
    /Puma::Server\b/,
  ];
  return patterns.some((re) => re.test(content));
}

/* ------------------------------------------------------------------ */
/* long-running request handlers                                        */
/* ------------------------------------------------------------------ */

function hasLongHandlers(content: string): boolean {
  const patterns: RegExp[] = [
    // Server-Sent Events
    /text\/event-stream/,
    /res\.writeHead\s*\([^)]*event-stream/,
    // explicit long/disabled timeouts
    /maxDuration\s*[:=]\s*(?:[6-9]\d|[1-9]\d{2,})/, // next.js maxDuration >= 60
    /setTimeout\s*\(\s*\d{0,1}\s*\)\s*;?\s*\/\/?\s*no\s*timeout/i,
    /server\.timeout\s*=\s*0\b/,
    /req\.setTimeout\s*\(\s*0\b/,
    // streaming response bodies kept open
    /res\.write\s*\([^)]*\)\s*;[\s\S]{0,200}setInterval/,
    // explicit long-poll / while loop in a handler
    /while\s*\(\s*true\s*\)/,
    // chunked streaming over a generator/ReadableStream in a route
    /new\s+ReadableStream\s*\(/,
    // long-running python loops (e.g. background polling inside app)
    /while\s+True\s*:/,
  ];
  return patterns.some((re) => re.test(content));
}

/* ------------------------------------------------------------------ */
/* persistent filesystem writes                                        */
/* ------------------------------------------------------------------ */

/**
 * fs.writeFile / fs.writeFileSync / createWriteStream to a path that is NOT
 * under /tmp and not an obvious cache directory. Persistent writes mean the
 * app needs a durable disk -> container, not serverless.
 */
function hasPersistentFsWrite(content: string): boolean {
  const writeCall =
    /(?:fs(?:\/promises)?|fsp|fileSystem)\s*\.\s*(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync)\s*\(/;
  const bareWrite = /\b(?:writeFile|writeFileSync|appendFile|createWriteStream)\s*\(/;

  if (!writeCall.test(content) && !bareWrite.test(content)) return false;

  // Look at the argument(s) of each write call for the destination path.
  const callRe =
    /(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)\s*\(\s*([^,)\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(content)) !== null) {
    const arg = (m[1] ?? "").trim();
    if (isEphemeralPath(arg)) continue;
    // A write whose destination is not clearly ephemeral -> persistent.
    return true;
  }
  return false;
}

function isEphemeralPath(arg: string): boolean {
  const lower = arg.toLowerCase();
  return (
    lower.includes("/tmp") ||
    lower.includes("os.tmpdir") ||
    lower.includes("tmpdir") ||
    lower.includes("temp") ||
    lower.includes(".cache") ||
    lower.includes("/cache") ||
    lower.includes("cachedir") ||
    lower.includes("process.stdout") ||
    lower.includes("process.stderr") ||
    lower.includes("/dev/")
  );
}

/* ------------------------------------------------------------------ */
/* framework hint                                                       */
/* ------------------------------------------------------------------ */

function detectFramework(path: string, content: string): string | undefined {
  const base = baseName(path).toLowerCase();

  // next.config.* is the strongest Next.js signal.
  if (/^next\.config\.(js|cjs|mjs|ts)$/.test(base)) return "next";

  if (base === "package.json") {
    return frameworkFromPackageJson(content);
  }
  if (base === "requirements.txt" || base === "pyproject.toml" || base === "pipfile") {
    return frameworkFromPython(content);
  }
  if (base === "gemfile") {
    if (/\brails\b/i.test(content)) return "rails";
    if (/\bsinatra\b/i.test(content)) return "sinatra";
  }
  if (base === "go.mod") {
    if (/gin-gonic\/gin/.test(content)) return "gin";
    if (/labstack\/echo/.test(content)) return "echo";
    if (/gofiber\/fiber/.test(content)) return "fiber";
  }
  return undefined;
}

function frameworkFromPackageJson(content: string): string | undefined {
  let deps: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(content) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    deps = { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) };
  } catch {
    // Fall back to substring sniffing on malformed/partial package.json.
    if (/"next"\s*:/.test(content)) return "next";
    if (/"nuxt"\s*:/.test(content)) return "nuxt";
    if (/"@remix-run/.test(content)) return "remix";
    if (/"@sveltejs\/kit"/.test(content)) return "sveltekit";
    if (/"@nestjs\/core"/.test(content)) return "nestjs";
    if (/"fastify"\s*:/.test(content)) return "fastify";
    if (/"express"\s*:/.test(content)) return "express";
    if (/"koa"\s*:/.test(content)) return "koa";
    return undefined;
  }

  // Order matters: meta-frameworks first, then bare servers.
  if ("next" in deps) return "next";
  if ("nuxt" in deps || "nuxt3" in deps) return "nuxt";
  if ("@remix-run/react" in deps || "@remix-run/node" in deps) return "remix";
  if ("@sveltejs/kit" in deps) return "sveltekit";
  if ("astro" in deps) return "astro";
  if ("@nestjs/core" in deps) return "nestjs";
  if ("fastify" in deps) return "fastify";
  if ("@hapi/hapi" in deps) return "hapi";
  if ("koa" in deps) return "koa";
  if ("express" in deps) return "express";
  return undefined;
}

function frameworkFromPython(content: string): string | undefined {
  const lower = content.toLowerCase();
  if (/\bdjango\b/.test(lower)) return "django";
  if (/\bfastapi\b/.test(lower)) return "fastapi";
  if (/\bflask\b/.test(lower)) return "flask";
  if (/\bstarlette\b/.test(lower)) return "starlette";
  if (/\btornado\b/.test(lower)) return "tornado";
  return undefined;
}

/* ------------------------------------------------------------------ */
/* small text utilities                                                */
/* ------------------------------------------------------------------ */

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function leadingSpaces(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 2; // treat a tab as two spaces for indent math
    else break;
  }
  return n;
}

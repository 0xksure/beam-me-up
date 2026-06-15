// Real end-to-end dry run: drives the BUILT stdio server (the exact artifact
// Claude Code launches) over the real MCP stdio transport, simulating the
// host-AI flow against a sample repo. Run: npx tsx scripts/dryrun.ts <repoDir>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { deriveSignals } from "../src/detect/signals.ts";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");
const repoDir = process.argv[2] ?? "/tmp/sample-vibe-app";

function walk(dir: string, base = dir): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else { try { out.push({ path: relative(base, full), content: readFileSync(full, "utf8") }); } catch {} }
  }
  return out;
}

function ok(label: string, cond: boolean) {
  console.log(`${cond ? "  ✔" : "  �’ FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
}

const transport = new StdioClientTransport({
  command: "node",
  args: [join(projectRoot, "dist/server/stdio.js")],
});
const client = new Client({ name: "beam-dryrun", version: "0.0.0" });
await client.connect(transport);
console.log("Connected to beam-me-up over stdio.\n");

// 1. discovery
const prompts = await client.listPrompts();
const tools = await client.listTools();
console.log("Prompts:", prompts.prompts.map((p) => p.name).join(", "));
console.log("Tools:", tools.tools.map((t) => t.name).join(", "), "\n");
ok("beam_me_up prompt advertised", prompts.prompts.some((p) => p.name === "beam_me_up"));
for (const t of ["route_target", "validate_compose", "write_todo"])
  ok(`tool ${t} advertised`, tools.tools.some((x) => x.name === t));

// 2. get the plan (what the user sees on "beam me up")
const plan = await client.getPrompt({ name: "beam_me_up", arguments: { goal: "ship Chatify", mode: "product" } });
const planText = plan.messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("\n");
ok("plan mentions route_target", planText.includes("route_target"));
ok("plan marks coming-soon steps", /coming soon/i.test(planText));

// 3. HOST-AI inventory of the sample repo -> signals (what a future preflight will do)
const files = walk(repoDir);
const signals = deriveSignals(files);
console.log("\nDerived signals for", repoDir, "\n ", JSON.stringify(signals));

// 4. route_target over the wire
const route = await client.callTool({
  name: "route_target",
  arguments: { stack: "next+express", signals, services: [
    { name: "web", kind: "app", port: 4000 }, { name: "db", kind: "postgres" },
  ] },
});
const routeOut = (route as any).structuredContent;
console.log("\nroute_target ->", JSON.stringify(routeOut));
ok("websocket app routed to container", routeOut?.target === "container");
ok("recommends digitalocean", routeOut?.recommendedProvider === "digitalocean");
ok("gives reasons", Array.isArray(routeOut?.reasons) && routeOut.reasons.length > 0);

// 4b. control case: a plain Next app should route to vercel
const routeNext = await client.callTool({
  name: "route_target",
  arguments: { stack: "next", signals: { hasDockerfile: false, composeAppServices: 0, wsServer: false, workers: false, listensOnPort: false, longHandlers: false, persistentFsWrites: false, framework: "nextjs" } },
});
ok("plain Next app routed to vercel", (routeNext as any).structuredContent?.target === "vercel");

// 5. validate_compose (generate from detected services)
const compose = await client.callTool({
  name: "validate_compose",
  arguments: { detectedServices: [ { name: "app", kind: "app", port: 4000 }, { name: "db", kind: "postgres" } ] },
});
const composeOut = (compose as any).structuredContent;
ok("compose generated + valid", composeOut?.valid === true && /services:/.test(composeOut?.composeYaml ?? ""));
ok("compose has healthcheck", /healthcheck/.test(composeOut?.composeYaml ?? ""));

// 6. write_todo
const todo = await client.callTool({
  name: "write_todo",
  arguments: { stack: "next+express", target: "digitalocean", authNeeded: true, mode: "product",
    liveUrl: "https://chatify.ondigitalocean.app",
    securityFollowups: ["Rotate the hardcoded STRIPE_SECRET_KEY found in docker-compose.yml"] },
});
const todoOut = (todo as any).structuredContent;
ok("TODO has Manual setup section", /Manual setup/i.test(todoOut?.todoMarkdown ?? ""));
ok("TODO carries the security follow-up", /STRIPE_SECRET_KEY/.test(todoOut?.todoMarkdown ?? ""));
ok("ship checklist non-empty", Array.isArray(todoOut?.shipChecklist) && todoOut.shipChecklist.length > 0);

console.log("\n----- generated docker-compose.yaml -----\n" + composeOut?.composeYaml);
console.log("----- TODO.md -----\n" + todoOut?.todoMarkdown);

await client.close();
console.log(process.exitCode ? "\nDRY RUN: FAIL" : "\nDRY RUN: PASS");

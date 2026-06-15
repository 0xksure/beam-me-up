/**
 * In-memory smoke test for the Beam Me Up MCP server.
 *
 * Wires a real MCP Client to the real server over an in-memory transport pair,
 * then:
 *   - lists prompts + tools and asserts the expected names are present
 *   - gets the beam_me_up prompt and asserts it returns a non-empty message
 *   - calls route_target, validate_compose and write_todo with sample inputs
 *     and asserts the structured outputs match the contract
 *
 * Exits non-zero on any failure.
 *
 * NOTE: In the M0 scaffold the four implementation areas are stubs that throw,
 * so the tool calls return isError results and this test will FAIL until the
 * implementers fill them in. That is expected.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "./mcp/server.js";
import {
  RouteTargetOutputSchema,
  ValidateComposeOutputSchema,
  WriteTodoOutputSchema,
  type RouteTargetInput,
  type RouteTargetOutput,
  type ValidateComposeInput,
  type ValidateComposeOutput,
  type WriteTodoInput,
  type WriteTodoOutput,
} from "@beam-me-up/core";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/** Pull the first text block out of a tool result's `content` array, if any. */
function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first && first.type === "text" && typeof first.text === "string") {
    return first.text;
  }
  return undefined;
}

async function main(): Promise<void> {
  const server = createServer();
  const client = new Client({ name: "beam-me-up-smoke", version: "0.0.0" });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  /* ---- list prompts ---------------------------------------------- */
  const prompts = await client.listPrompts();
  const promptNames = prompts.prompts.map((p) => p.name);
  assert(
    promptNames.includes("beam_me_up"),
    `expected prompt "beam_me_up", got ${JSON.stringify(promptNames)}`,
  );

  /* ---- list tools ------------------------------------------------ */
  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name);
  for (const expected of ["route_target", "validate_compose", "write_todo"]) {
    assert(
      toolNames.includes(expected),
      `expected tool "${expected}", got ${JSON.stringify(toolNames)}`,
    );
  }

  /* ---- get the prompt (product mode) ----------------------------- */
  const prompt = await client.getPrompt({
    name: "beam_me_up",
    arguments: { goal: "ship my app", mode: "product" },
  });
  assert(prompt.messages.length > 0, "prompt returned no messages");
  const first = prompt.messages[0];
  assert(first !== undefined, "prompt first message missing");
  assert(
    first.content.type === "text" && first.content.text.length > 0,
    "prompt message is not non-empty text",
  );
  const productText = first.content.type === "text" ? first.content.text : "";
  // The plan must reference the live tools and the goal, and call out product mode.
  for (const tool of ["route_target", "validate_compose", "write_todo"]) {
    assert(
      productText.includes(tool),
      `product plan should mention live tool ${tool}`,
    );
  }
  assert(
    productText.includes("ship my app"),
    "product plan should interpolate the user's goal",
  );
  assert(
    /product/i.test(productText),
    "product plan should reference product mode",
  );

  /* ---- get the prompt (internal mode) ---------------------------- */
  const internalPrompt = await client.getPrompt({
    name: "beam_me_up",
    arguments: { goal: "internal dashboard", mode: "internal" },
  });
  const internalFirst = internalPrompt.messages[0];
  assert(internalFirst !== undefined, "internal prompt first message missing");
  assert(
    internalFirst.content.type === "text" &&
      internalFirst.content.text.length > 0,
    "internal prompt message is not non-empty text",
  );
  const internalText =
    internalFirst.content.type === "text" ? internalFirst.content.text : "";
  // Internal mode must add the allowlist locking guidance, and must differ from
  // the product-mode rendering.
  assert(
    /internal/i.test(internalText),
    "internal plan should reference internal mode",
  );
  assert(
    internalText.includes("ALLOWED_EMAILS") ||
      internalText.includes("ALLOWED_DOMAIN"),
    "internal plan should require an allowlist (ALLOWED_EMAILS/ALLOWED_DOMAIN)",
  );
  assert(
    internalText !== productText,
    "internal and product plans should differ (mode must change the plan)",
  );

  /* ---- call route_target ----------------------------------------- */
  const routeInput: RouteTargetInput = {
    stack: "next",
    signals: {
      hasDockerfile: false,
      composeAppServices: 0,
      wsServer: true,
      workers: false,
      listensOnPort: false,
      longHandlers: false,
      persistentFsWrites: false,
    },
  };
  const routeRes = await client.callTool({
    name: "route_target",
    arguments: routeInput,
  });
  assert(!routeRes.isError, `route_target errored: ${JSON.stringify(routeRes.content)}`);
  // The structured output must conform to the frozen output schema.
  const routeOut = RouteTargetOutputSchema.parse(
    routeRes.structuredContent,
  ) as RouteTargetOutput;
  assert(
    routeOut.target === "container" && routeOut.recommendedProvider === "digitalocean",
    `wsServer should route to container/digitalocean, got ${JSON.stringify(routeOut)}`,
  );
  assert(
    routeOut.confidence >= 0 && routeOut.confidence <= 1,
    "confidence out of [0,1]",
  );
  assert(Array.isArray(routeOut.reasons) && routeOut.reasons.length > 0, "no reasons");
  // The deciding reason for this input should reference the websocket signal.
  assert(
    routeOut.reasons.some((r) => /websocket/i.test(r)),
    `route reasons should explain the websocket-driven decision, got ${JSON.stringify(routeOut.reasons)}`,
  );
  // The text content should echo the structured decision (server returns JSON text).
  const routeText = firstText(routeRes.content);
  assert(
    routeText !== undefined && routeText.includes("container"),
    "route_target text content should include the decision",
  );

  /* ---- call route_target (vercel path) --------------------------- */
  const vercelInput: RouteTargetInput = {
    stack: "next",
    signals: {
      hasDockerfile: false,
      composeAppServices: 0,
      wsServer: false,
      workers: false,
      listensOnPort: false,
      longHandlers: false,
      persistentFsWrites: false,
      framework: "next",
    },
  };
  const vercelRes = await client.callTool({
    name: "route_target",
    arguments: vercelInput,
  });
  assert(!vercelRes.isError, `route_target (vercel) errored: ${JSON.stringify(vercelRes.content)}`);
  const vercelOut = RouteTargetOutputSchema.parse(
    vercelRes.structuredContent,
  ) as RouteTargetOutput;
  assert(
    vercelOut.target === "vercel" && vercelOut.recommendedProvider === "vercel",
    `stateless next app should route to vercel/vercel, got ${JSON.stringify(vercelOut)}`,
  );

  /* ---- call validate_compose (generate path) --------------------- */
  const composeInput: ValidateComposeInput = {
    detectedServices: [
      { name: "app", kind: "app", port: 3000, envFile: ".env" },
      { name: "db", kind: "postgres" },
    ],
  };
  const composeRes = await client.callTool({
    name: "validate_compose",
    arguments: composeInput,
  });
  assert(
    !composeRes.isError,
    `validate_compose errored: ${JSON.stringify(composeRes.content)}`,
  );
  const composeOut = ValidateComposeOutputSchema.parse(
    composeRes.structuredContent,
  ) as ValidateComposeOutput;
  assert(composeOut.valid === true, "generated compose should be valid");
  assert(
    typeof composeOut.composeYaml === "string" && composeOut.composeYaml.length > 0,
    "compose yaml empty",
  );
  assert(composeOut.errors.length === 0, "generated compose should have no errors");
  // The generated compose must contain both services, a healthcheck and the
  // service_healthy dependency gate.
  for (const needle of [
    "services:",
    "app:",
    "db:",
    "healthcheck",
    "service_healthy",
  ]) {
    assert(
      composeOut.composeYaml.includes(needle),
      `generated compose missing "${needle}"`,
    );
  }

  /* ---- call validate_compose (validate an existing file) ---------- */
  const validateExistingRes = await client.callTool({
    name: "validate_compose",
    arguments: {
      composeYaml: composeOut.composeYaml,
    } satisfies ValidateComposeInput,
  });
  assert(
    !validateExistingRes.isError,
    `validate_compose (existing) errored: ${JSON.stringify(validateExistingRes.content)}`,
  );
  const reparsed = ValidateComposeOutputSchema.parse(
    validateExistingRes.structuredContent,
  ) as ValidateComposeOutput;
  assert(
    reparsed.valid === true && reparsed.errors.length === 0,
    `re-validating generated compose should be valid with no errors, got ${JSON.stringify(reparsed)}`,
  );

  /* ---- call validate_compose (invalid input) --------------------- */
  const badRes = await client.callTool({
    name: "validate_compose",
    arguments: {
      composeYaml: "services:\n  web:\n    ports:\n      - 80:80\n",
    } satisfies ValidateComposeInput,
  });
  const badOut = ValidateComposeOutputSchema.parse(
    badRes.structuredContent,
  ) as ValidateComposeOutput;
  assert(
    badOut.valid === false && badOut.errors.length > 0,
    `a service without image/build should be invalid, got ${JSON.stringify(badOut)}`,
  );

  /* ---- call write_todo ------------------------------------------- */
  const todoInput: WriteTodoInput = {
    stack: "next",
    target: "vercel",
    authNeeded: true,
    mode: "product",
    liveUrl: "https://example.com",
    securityFollowups: ["Rotate the committed Stripe key"],
  };
  const todoRes = await client.callTool({
    name: "write_todo",
    arguments: todoInput,
  });
  assert(!todoRes.isError, `write_todo errored: ${JSON.stringify(todoRes.content)}`);
  const todoOut = WriteTodoOutputSchema.parse(
    todoRes.structuredContent,
  ) as WriteTodoOutput;
  assert(
    typeof todoOut.todoMarkdown === "string" && todoOut.todoMarkdown.length > 0,
    "todoMarkdown empty",
  );
  assert(
    Array.isArray(todoOut.shipChecklist) && todoOut.shipChecklist.length > 0,
    "shipChecklist empty",
  );
  // The markdown must carry all four documented sections.
  for (const section of [
    "## Manual setup",
    "## Security follow-ups",
    "## Ship checklist",
    "## Operate",
  ]) {
    assert(
      todoOut.todoMarkdown.includes(section),
      `TODO.md missing section "${section}"`,
    );
  }
  // authNeeded:true + liveUrl should produce a concrete OAuth callback URI.
  assert(
    todoOut.todoMarkdown.includes("https://example.com/api/auth/callback/"),
    "TODO.md should include a concrete OAuth callback URI built from liveUrl",
  );
  // The supplied security follow-up must surface in the rendered markdown.
  assert(
    todoOut.todoMarkdown.includes("Rotate the committed Stripe key"),
    "TODO.md should include the provided security follow-up",
  );
  // vercel target -> vercel operate guidance.
  assert(
    /vercel/i.test(todoOut.todoMarkdown),
    "TODO.md operate section should give vercel-specific guidance",
  );
  // Every checklist item must conform to the contract shape.
  for (const item of todoOut.shipChecklist) {
    assert(
      typeof item.id === "string" &&
        typeof item.label === "string" &&
        typeof item.done === "boolean" &&
        typeof item.blocking === "boolean",
      `checklist item malformed: ${JSON.stringify(item)}`,
    );
  }

  /* ---- call write_todo (internal mode, container target) --------- */
  const internalTodoRes = await client.callTool({
    name: "write_todo",
    arguments: {
      stack: "express",
      target: "digitalocean",
      authNeeded: true,
      mode: "internal",
    } satisfies WriteTodoInput,
  });
  assert(
    !internalTodoRes.isError,
    `write_todo (internal) errored: ${JSON.stringify(internalTodoRes.content)}`,
  );
  const internalTodoOut = WriteTodoOutputSchema.parse(
    internalTodoRes.structuredContent,
  ) as WriteTodoOutput;
  assert(
    internalTodoOut.todoMarkdown.includes("ALLOWED_EMAILS") ||
      internalTodoOut.todoMarkdown.includes("ALLOWED_DOMAIN"),
    "internal-mode TODO.md should mention the allowlist env vars",
  );
  // digitalocean target -> doctl operate guidance.
  assert(
    /doctl|digitalocean/i.test(internalTodoOut.todoMarkdown),
    "container-target TODO.md should give DigitalOcean-specific guidance",
  );

  await Promise.all([client.close(), server.close()]);

  process.stdout.write("smoke-test: PASS\n");
}

main().catch((err) => {
  process.stderr.write(`smoke-test: FAIL - ${String(err)}\n`);
  process.exit(1);
});

/**
 * buildImagePlan - emit the exact, ordered commands the host AI should run to
 * build + push a container image for a DigitalOcean (or other registry) deploy,
 * plus prerequisites and footgun warnings. PURE: it returns a recipe, it does
 * not run anything (the server has no shell). This guards the single most
 * environment-fragile step in the flow (Docker daemon? buildx? registry auth?
 * arm64 -> must target linux/amd64) that otherwise sits unguarded between
 * provision_database and deploy.
 */
import type { BuildImagePlanInput, BuildImagePlanOutput } from "@beam-me-up/core";

export function buildImagePlan(
  input: BuildImagePlanInput,
): BuildImagePlanOutput {
  const registryType = input.registryType ?? "docr";
  const tag = input.tag ?? "v1";
  const context = input.contextPath ?? ".";
  const repository = input.repository;

  const commands: string[] = [];
  const prerequisites: string[] = [
    "Docker daemon running (`docker info`)",
    "Buildx available (`docker buildx version`) — needed for cross-arch builds",
  ];
  const warnings: string[] = [
    "App Platform runs linux/amd64. On Apple Silicon / ARM you MUST pass " +
      "`--platform linux/amd64` or the container will crash-loop on deploy.",
  ];

  let imageRef: string;

  if (registryType === "docr") {
    if (input.registry) {
      const name = input.registry.replace(/^registry\.digitalocean\.com\//, "");
      imageRef = `registry.digitalocean.com/${name}/${repository}:${tag}`;
    } else {
      imageRef = `registry.digitalocean.com/<name>/${repository}:${tag}`;
      commands.push(
        "doctl registry get --format Endpoint --no-header   # -> registry.digitalocean.com/<name>",
      );
      warnings.push(
        "Registry name unknown — run the `doctl registry get` step and substitute <name> in the image ref.",
      );
    }
    commands.push("doctl registry login");
    prerequisites.push(
      "doctl authenticated (`doctl account get`) with registry write access",
    );
  } else if (registryType === "ghcr") {
    const owner = input.registry ?? "<owner>";
    imageRef = `ghcr.io/${owner}/${repository}:${tag}`;
    commands.push(
      "echo $GITHUB_TOKEN | docker login ghcr.io -u <username> --password-stdin",
    );
    prerequisites.push("A GHCR token (GITHUB_TOKEN) with `write:packages`");
  } else {
    const owner = input.registry ?? "<owner>";
    imageRef = `docker.io/${owner}/${repository}:${tag}`;
    commands.push("docker login   # Docker Hub");
    prerequisites.push("Logged in to Docker Hub (`docker login`)");
  }

  commands.push(
    `docker buildx build --platform linux/amd64 -t ${imageRef} --push ${context}`,
  );

  if (!input.tag) {
    warnings.push(
      `No tag given — used "${tag}". Pin a real version or git SHA (not ":latest") so redeploys are reproducible.`,
    );
  }

  // The host then calls: deploy { provider: "digitalocean", targetId, projectName, image: <imageRef> }.
  return { imageRef, commands, prerequisites, warnings };
}

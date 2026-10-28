import { describe, expect, it } from "vitest";
import fs from "fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Supply-chain review 2026-10-20: what reaches users' machines must come
// from a reviewed release, built from exactly what the lockfiles pin, by a
// job whose write token no build dependency can read.

const readRepoFile = (relativePath) =>
  fs.readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

// The text of one top-level job of a workflow (from "  <name>:" to the next
// two-space-indented key or the end of the file).
function jobText(workflow, name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  const text = next === -1 ? rest : rest.slice(0, next + 1);
  // Without comment lines: only what runs counts.
  return text.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
}

describe("demo site deploy", () => {
  const workflow = readRepoFile(".github/workflows/demo-pages.yml");

  it("is read-only by default", () => {
    const header = workflow.slice(0, workflow.indexOf("\njobs:"));
    expect(header).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(header).not.toContain("contents: write");
  });

  it("builds without a write token and without a persisted checkout token", () => {
    const build = jobText(workflow, "build");
    expect(build).toMatch(/permissions:\n {6}contents: read\n/);
    expect(build).not.toMatch(/:\s*write\b/);
    expect(build).toContain("persist-credentials: false");
    expect(build).toContain("npm ci");
    expect(build).not.toMatch(/npm install/);
    expect(build).not.toContain("actions-gh-pages");
  });

  it("publishes from a job that checks out nothing and runs no npm", () => {
    const deploy = jobText(workflow, "deploy");
    expect(deploy).toContain("needs: build");
    expect(deploy).toContain("contents: write");
    expect(deploy).toContain("actions/download-artifact@");
    expect(deploy).toContain("peaceiris/actions-gh-pages@");
    expect(deploy).not.toContain("actions/checkout");
    expect(deploy).not.toMatch(/\bnpm\b|\bnode\b|\bnpx\b/);
  });
});

describe("Dependabot", () => {
  const config = readRepoFile(".github/dependabot.yml");
  const automerge = readRepoFile(".github/workflows/dependabot-automerge.yml");

  it("waits 7 days after a release for every ecosystem", () => {
    const ecosystems = config.match(/- package-ecosystem: /g) || [];
    expect(ecosystems.length).toBeGreaterThanOrEqual(4);
    const cooldowns = config.match(/\n {4}cooldown:\n {6}default-days: 7\n/g) || [];
    expect(cooldowns).toHaveLength(ecosystems.length);
  });

  it("keeps the build tooling in groups of its own, ahead of the catch-all groups", () => {
    for (const [tools, general] of [["root-build-tools", "root-non-breaking"], ["client-build-tools", "client-non-breaking"]]) {
      expect(config.indexOf(`${tools}:`), tools).toBeGreaterThan(-1);
      expect(config.indexOf(`${tools}:`), tools).toBeLessThan(config.indexOf(`${general}:`));
    }
    const rootTools = config.slice(config.indexOf("root-build-tools:"), config.indexOf("root-non-breaking:"));
    expect(rootTools).toContain('"@yao-pkg/pkg"');
    expect(rootTools).toContain('"esbuild"');
    const clientTools = config.slice(config.indexOf("client-build-tools:"), config.indexOf("client-non-breaking:"));
    expect(clientTools).toContain('"vite"');
  });

  it("watches every Dockerfile", () => {
    const docker = config.slice(config.indexOf("package-ecosystem: docker"));
    for (const dir of ["- /\n", "- /docker/all-in-one\n", "- /docker/all-in-one/updater\n"]) {
      expect(docker).toContain(dir);
    }
  });

  it("auto-merges only npm patch and minor updates from the general groups", () => {
    expect(automerge).toMatch(/dependabot\/fetch-metadata@[0-9a-f]{40} # v\d/);
    const mergeStep = automerge.slice(automerge.indexOf("- name: Enable squash auto-merge"));
    const condition = mergeStep.slice(mergeStep.indexOf("if:"), mergeStep.indexOf("env:"));
    expect(condition).toContain("package-ecosystem == 'npm_and_yarn'");
    expect(condition).toContain("'version-update:semver-patch'");
    expect(condition).toContain("'version-update:semver-minor'");
    expect(condition).not.toContain("semver-major");
    expect(condition).toContain("dependency-group == 'root-non-breaking'");
    expect(condition).toContain("dependency-group == 'client-non-breaking'");
    expect(condition).not.toMatch(/build-tools|github_actions|docker/);
    // Every condition is ANDed: an || at the top level would let any one
    // of them through on its own.
    expect(condition.replace(/\([^()]*\)/g, "()")).not.toContain("||");
    // The merge command runs only behind that condition.
    expect(automerge.match(/gh pr merge/g) || []).toHaveLength(1);
  });
});

describe("Docker image tags", () => {
  const workflow = readRepoFile(".github/workflows/docker-publish.yml");

  it("moves latest only on the newest release tag, and main/edge on main pushes", () => {
    expect(workflow).toContain("flavor: latest=false");
    expect(workflow).toContain("type=raw,value=latest,enable=${{ steps.newest.outputs.latest == 'true' }}");
    expect(workflow).toContain("type=semver,pattern={{major}}.{{minor}},enable=${{ steps.newest.outputs.minor == 'true' }}");
    expect(workflow.match(/value=latest/g) || []).toHaveLength(1);
    expect(workflow.match(/pattern=\{\{major\}\}/g) || []).toHaveLength(1);
    const step = workflow.slice(workflow.indexOf("- name: Check whether this is the newest release tag"));
    expect(step.slice(0, step.indexOf("\n\n"))).toMatch(/id: newest\n\s+if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
    expect(step.slice(0, step.indexOf("\n\n"))).toContain(`git tag --list 'v*' | node scripts/newest-release-tag.mjs "$GITHUB_REF_NAME" >> "$GITHUB_OUTPUT"`);
    expect(workflow.indexOf("id: newest")).toBeLessThan(workflow.indexOf("id: meta"));
    expect(workflow).toContain("type=raw,value=main,enable=${{ github.ref == 'refs/heads/main' }}");
    expect(workflow).toContain("type=raw,value=edge,enable=${{ github.ref == 'refs/heads/main' }}");
  });

  it("builds pull requests without logging in or pushing", () => {
    expect(workflow).toMatch(/\n {2}pull_request:\n/);
    const login = workflow.slice(workflow.indexOf("- name: Log in to GHCR"));
    expect(login.slice(0, login.indexOf("uses:"))).toContain("if: github.event_name != 'pull_request'");
    expect(workflow).toContain("push: ${{ github.event_name != 'pull_request' }}");
    expect(workflow).not.toMatch(/push: true/);
  });

  // The step's script, fed the repository's tags the way the step does.
  const newest = (tag, tags) => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/newest-release-tag.mjs", import.meta.url)), tag], {
      input: tags.join("\n"),
      encoding: "utf8",
    });
    return { status: result.status, out: result.stdout.trim().split(/\r?\n/), err: result.stderr };
  };
  const released = ["v0.1.0-alpha", "v0.8.5.2", "v1.4.9", "v1.4.10", "v1.6.0", "v2026.9.3", "v2026.10.1", "v2026.10.2"];

  it("lets the highest release tag move latest and its minor alias", () => {
    expect(newest("v2026.10.2", released)).toEqual({ status: 0, out: ["latest=true", "minor=true"], err: "" });
  });

  it("keeps latest when an older tag's run is re-run or dispatched", () => {
    expect(newest("v2026.10.1", released).out).toEqual(["latest=false", "minor=false"]);
    expect(newest("v1.6.0", released).out).toEqual(["latest=false", "minor=true"]);
    // A patch to an older minor after a newer release: only its own alias.
    expect(newest("v2026.9.4", [...released, "v2026.9.4"]).out).toEqual(["latest=false", "minor=true"]);
  });

  it("compares versions as numbers, and ignores tags that aren't vX.Y.Z", () => {
    // 10 > 9, and 2026.10 > 2026.9 (a string sort gets both wrong).
    expect(newest("v1.4.10", ["v1.4.9", "v1.4.10"]).out).toEqual(["latest=true", "minor=true"]);
    expect(newest("v2026.9.3", released).out[0]).toBe("latest=false");
    expect(newest("v2026.10.2", [...released, "v9999.0.0-rc1", "v9999.0.0.1", "nightly"]).out[0]).toBe("latest=true");
    expect(newest("v2026.10.2", released.map((tag) => `${tag}\r`)).out[0]).toBe("latest=true");
  });

  it("refuses when the tags weren't fetched or the ref isn't a release tag", () => {
    // Without the repository's tags every tag would look like the newest.
    expect(newest("v2026.10.1", []).status).toBe(1);
    expect(newest("v2026.10.1", ["v1.6.0"]).status).toBe(1);
    expect(newest("v2026.10.1-rc1", [...released, "v2026.10.1-rc1"]).status).toBe(1);
    expect(newest("main", [...released, "main"]).status).toBe(1);
    expect(newest("", released).status).toBe(1);
  });

  it("tells users that latest is the newest release", () => {
    const docs = readRepoFile("docs/install/docker.md");
    expect(docs).toContain("`:latest` is the\n  newest release");
    expect(docs).toContain("`:edge`");
  });
});

describe("Docker base images", () => {
  const dockerfiles = ["Dockerfile", "docker/all-in-one/Dockerfile", "docker/all-in-one/updater/Dockerfile"];

  it.each(dockerfiles)("%s pins every base image by digest", (file) => {
    const lines = readRepoFile(file).split("\n").filter((line) => /^FROM\s/i.test(line));
    expect(lines.length).toBeGreaterThan(0);
    const stages = new Set();
    for (const line of lines) {
      const words = line.split(/\s+/).filter((word) => !word.startsWith("--"));
      const image = words[1];
      if (!stages.has(image)) expect(image, line).toMatch(/^[a-z0-9./_-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
      const alias = /\bAS\s+(\S+)/i.exec(line)?.[1];
      if (alias) stages.add(alias);
    }
  });

  it.each(dockerfiles)("%s pipes nothing from the network into a shell", (file) => {
    const text = readRepoFile(file);
    expect(text).not.toMatch(/\|\s*(ba|da)?sh\b/);
    expect(text).not.toContain("deb.nodesource.com");
  });

  it("the all-in-one image takes Node.js from the official image", () => {
    const text = readRepoFile("docker/all-in-one/Dockerfile");
    expect(text).toMatch(/^FROM node:22-bookworm-slim@sha256:[0-9a-f]{64} AS node-image$/m);
    expect(text).toContain("COPY --from=node-image /usr/local/bin/node /usr/local/bin/node");
    expect(text).toMatch(/node --version/);
  });
});

describe("Docker helper images", () => {
  const script = fileURLToPath(new URL("../../scripts/helper-images.mjs", import.meta.url));
  const run = (file) => spawnSync(process.execPath, file ? [script, file] : [script], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    encoding: "utf8",
  });
  const workflows = [".github/workflows/docker-publish.yml", ".github/workflows/docker-aio-build.yml"];
  // Each step that uses `action`, up to the next step.
  const stepsUsing = (workflow, action) => workflow.split(/\n(?= {6}- )/).filter((step) => step.includes(`uses: ${action}@`));

  it("are pinned by digest, and printed digest-only for the workflows", () => {
    const result = run();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/)).toEqual([
      expect.stringMatching(/^binfmt=docker\.io\/tonistiigi\/binfmt@sha256:[0-9a-f]{64}$/),
      expect.stringMatching(/^buildkit=docker\.io\/moby\/buildkit@sha256:[0-9a-f]{64}$/),
    ]);
  });

  it.each(workflows)("%s runs QEMU and BuildKit only from those pins", (file) => {
    const workflow = readRepoFile(file);
    const helpers = workflow.indexOf("id: helpers");
    expect(helpers).toBeGreaterThan(-1);
    expect(workflow).toContain('run: node scripts/helper-images.mjs >> "$GITHUB_OUTPUT"');
    const buildx = stepsUsing(workflow, "docker/setup-buildx-action");
    expect(buildx).toHaveLength(1);
    for (const step of buildx) {
      expect(step).toMatch(/\n {8}with:\n {10}driver-opts: image=\$\{\{ steps\.helpers\.outputs\.buildkit \}\}\n/);
      expect(workflow.indexOf(step)).toBeGreaterThan(helpers);
    }
    for (const step of stepsUsing(workflow, "docker/setup-qemu-action")) {
      expect(step).toContain("\n          image: ${{ steps.helpers.outputs.binfmt }}\n");
      expect(step).toContain("\n          cache-image: false\n");
      expect(workflow.indexOf(step)).toBeGreaterThan(helpers);
    }
    // Pull requests that bump a pin build with it before it merges.
    const pullRequest = workflow.slice(workflow.indexOf("\n  pull_request:\n"), workflow.indexOf("\n  workflow_dispatch:"));
    expect(pullRequest).toContain("- '.github/helper-images/Dockerfile'");
  });

  it("the multi-arch build installs the arm64 emulator from the pinned image", () => {
    const qemu = stepsUsing(readRepoFile(".github/workflows/docker-publish.yml"), "docker/setup-qemu-action");
    expect(qemu).toHaveLength(1);
    expect(qemu[0]).toContain("\n          platforms: arm64\n");
  });

  it("are kept current by Dependabot", () => {
    const docker = readRepoFile(".github/dependabot.yml").slice(readRepoFile(".github/dependabot.yml").indexOf("package-ecosystem: docker"));
    expect(docker).toContain("- /.github/helper-images\n");
  });

  it.each([
    ["a moving tag", "FROM docker.io/tonistiigi/binfmt:latest AS binfmt\nFROM docker.io/moby/buildkit:v0.33.1@sha256:" + "a".repeat(64) + " AS buildkit\n"],
    ["a digest without a tag", "FROM docker.io/tonistiigi/binfmt@sha256:" + "a".repeat(64) + " AS binfmt\nFROM docker.io/moby/buildkit:v0.33.1@sha256:" + "a".repeat(64) + " AS buildkit\n"],
    ["a short digest", "FROM docker.io/tonistiigi/binfmt:qemu-v10.2.3@sha256:" + "a".repeat(63) + " AS binfmt\nFROM docker.io/moby/buildkit:v0.33.1@sha256:" + "a".repeat(64) + " AS buildkit\n"],
    ["a missing image", "FROM docker.io/tonistiigi/binfmt:qemu-v10.2.3@sha256:" + "a".repeat(64) + " AS binfmt\n"],
    ["an unnamed stage", "FROM docker.io/tonistiigi/binfmt:qemu-v10.2.3@sha256:" + "a".repeat(64) + "\nFROM docker.io/moby/buildkit:v0.33.1@sha256:" + "a".repeat(64) + " AS buildkit\n"],
    ["a second, moving buildkit", "FROM docker.io/tonistiigi/binfmt:qemu-v10.2.3@sha256:" + "a".repeat(64) + " AS binfmt\nFROM docker.io/moby/buildkit:v0.33.1@sha256:" + "a".repeat(64) + " AS buildkit\nFROM moby/buildkit:buildx-stable-1 AS buildkit\n"],
    ["an image option smuggled after the digest", "FROM docker.io/tonistiigi/binfmt:qemu-v10.2.3@sha256:" + "a".repeat(64) + " AS binfmt\nFROM docker.io/moby/buildkit:v0.33.1@sha256:" + "a".repeat(64) + ",network=host AS buildkit\n"],
  ])("refuse %s", (_label, content) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-helper-images-"));
    try {
      const file = path.join(dir, "Dockerfile");
      fs.writeFileSync(file, content);
      const result = run(file);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("release builds install exactly what the lockfiles pin", () => {
  it.each([
    "Dockerfile",
    "docker/all-in-one/Dockerfile",
    ".github/workflows/release-artifacts.yml",
    ".github/workflows/demo-pages.yml",
  ])("%s uses npm ci, never npm install", (file) => {
    const text = readRepoFile(file);
    const commands = text.split("\n").filter((line) => !line.trim().startsWith("#"));
    expect(commands.join("\n")).toMatch(/npm ci\b/);
    expect(commands.join("\n")).not.toMatch(/npm install\b/);
  });
});

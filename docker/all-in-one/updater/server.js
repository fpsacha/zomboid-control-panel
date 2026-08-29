const crypto = require("crypto");
const fs = require("fs/promises");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { recreatePanelContainer } = require("./containerLifecycle.cjs");

const PORT = Number(process.env.PORT || 3100);
const UPDATE_TOKEN = process.env.UPDATE_TOKEN || "";
const BUILD_ROOT = process.env.BUILD_ROOT || "/build";
const SOURCE_DIR = process.env.SOURCE_DIR || path.join(BUILD_ROOT, "source");
const COMPOSE_FILE = process.env.COMPOSE_FILE || path.join(BUILD_ROOT, "ctx", "docker-compose.yml");
const PANEL_SERVICE = process.env.PANEL_SERVICE || "panel";
const PANEL_CONTAINER = process.env.PANEL_CONTAINER || "zomboid-panel";
const PANEL_IMAGE = process.env.PANEL_IMAGE || "zomboid-panel-allinone:latest";
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || "fpsacha/zomboid-control-panel";
const HEALTH_TIMEOUT_MS = 120000;

let updateState = { status: "idle", version: null, message: null, startedAt: null, completedAt: null };

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let output = "";
    const append = (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-16000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(output);
      reject(new Error(`${command} exited with ${code}: ${output.trim()}`));
    });
  });
}

function rollbackTag(image) {
  const separator = image.lastIndexOf(":");
  return separator > image.lastIndexOf("/")
    ? `${image.slice(0, separator)}:rollback`
    : `${image}:rollback`;
}

function isAuthorized(request) {
  const value = request.headers.authorization || "";
  const supplied = value.startsWith("Bearer ") ? value.slice(7) : "";
  if (!UPDATE_TOKEN || !supplied) return false;
  const expectedBuffer = Buffer.from(UPDATE_TOKEN);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) request.destroy(new Error("Request body too large"));
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON request body"));
      }
    });
    request.on("error", reject);
  });
}

function reply(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function waitForHealthy() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = (await run("docker", ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}no-health:{{.State.Status}}{{end}}", PANEL_CONTAINER])).trim();
    if (state === "healthy" || state === "no-health:running") return;
    if (state === "unhealthy" || state === "exited" || state === "dead") {
      throw new Error(`Panel container entered ${state} state`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Timed out waiting for the updated panel container to become healthy");
}

async function update(version) {
  const workDir = await fs.mkdtemp(path.join(BUILD_ROOT, "update-"));
  const archivePath = path.join(workDir, "release.tar.gz");
  const extractedDir = path.join(workDir, "extract");
  const backupSource = `${SOURCE_DIR}.rollback`;
  const rollbackImage = rollbackTag(PANEL_IMAGE);
  let sourceSwapped = false;

  updateState = { status: "running", version, message: "Downloading release source", startedAt: new Date().toISOString(), completedAt: null };
  try {
    await fs.mkdir(extractedDir, { recursive: true });
    await run("curl", ["--fail", "--location", "--silent", "--show-error", "--output", archivePath, `https://github.com/${GITHUB_REPOSITORY}/archive/refs/tags/v${version}.tar.gz`]);
    await run("tar", ["-xzf", archivePath, "-C", extractedDir]);
    const entries = await fs.readdir(extractedDir, { withFileTypes: true });
    const sourceEntry = entries.find((entry) => entry.isDirectory());
    if (!sourceEntry) throw new Error("Release archive did not contain source files");
    const incomingSource = path.join(extractedDir, sourceEntry.name);
    await fs.access(path.join(incomingSource, "docker", "all-in-one", "Dockerfile"));

    await fs.rm(backupSource, { recursive: true, force: true });
    await fs.rename(SOURCE_DIR, backupSource);
    await fs.rename(incomingSource, SOURCE_DIR);
    sourceSwapped = true;

    updateState.message = "Building and recreating panel container";
    await run("docker", ["tag", PANEL_IMAGE, rollbackImage]);
    await recreatePanelContainer(PANEL_CONTAINER, ["--env-file", path.join(BUILD_ROOT, "ctx", ".env"), "-f", COMPOSE_FILE, "up", "-d", "--build", "--no-deps", PANEL_SERVICE], run);
    updateState.message = "Waiting for panel health check";
    await waitForHealthy();

    await fs.rm(backupSource, { recursive: true, force: true });
    updateState = { status: "success", version, message: `Updated to v${version}`, startedAt: updateState.startedAt, completedAt: new Date().toISOString() };
  } catch (error) {
    if (sourceSwapped) {
      try {
        await fs.rm(SOURCE_DIR, { recursive: true, force: true });
        await fs.rename(backupSource, SOURCE_DIR);
        await run("docker", ["tag", rollbackImage, PANEL_IMAGE]);
        await recreatePanelContainer(PANEL_CONTAINER, ["--env-file", path.join(BUILD_ROOT, "ctx", ".env"), "-f", COMPOSE_FILE, "up", "-d", "--no-build", "--no-deps", "--force-recreate", PANEL_SERVICE], run);
      } catch (rollbackError) {
        error.message = `${error.message}; rollback failed: ${rollbackError.message}`;
      }
    }
    updateState = { status: "failed", version, message: error.message, startedAt: updateState.startedAt, completedAt: new Date().toISOString() };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") return reply(response, 200, { status: "ok" });
  if (request.method === "GET" && request.url === "/status") {
    if (!isAuthorized(request)) return reply(response, 401, { error: "Unauthorized" });
    return reply(response, 200, updateState);
  }
  if (request.method !== "POST" || request.url !== "/update") return reply(response, 404, { error: "Not found" });
  if (!isAuthorized(request)) return reply(response, 401, { error: "Unauthorized" });
  if (updateState.status === "running") return reply(response, 409, { error: "An update is already in progress" });

  try {
    const { version } = await readJson(request);
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
      return reply(response, 400, { error: "A semantic release version is required" });
    }
    void update(version);
    return reply(response, 202, { message: `Docker update to v${version} started` });
  } catch (error) {
    return reply(response, 400, { error: error.message });
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Docker update controller listening on ${PORT}`);
});

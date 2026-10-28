import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// Security audit 2026-10-28: GET /crash-logs/:filename checked only that a
// crash-log-shaped name existed (fs.promises.access) and then opened it by
// path, following any link. The install folder can belong to another OS
// account (an externally managed or network-mounted server, both in
// docker-compose.yml), and a link it plants there as hs_err_pid1.log made a
// diagnostics.manage holder read wherever it pointed (jwt.secret, db.json).
// The route now serves only what GET /crash-logs lists: a regular file (not
// a link) spelled exactly as readdir() spells it, opened as checked, as GET
// /logs/download/:filename already does.
const getRoleByName = vi.fn(async (name) =>
  name === "diagnostics_manage_only" ? { capabilities: ["diagnostics.manage"] } : mockGetRoleByName(name),
);

vi.mock("../database/init.js", async () => {
  const actual = await vi.importActual("../database/init.js");
  return { ...actual, getRoleByName };
});

const { default: debugRouter } = await import("../routes/debug.js");

function createResponse() {
  const response = {};
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

async function run(routePath, params, installRoot) {
  const layer = debugRouter.stack.find((entry) => entry.route?.path === routePath && entry.route.methods.get);
  const handlers = layer.route.stack.map((s) => s.handle);
  const res = createResponse();
  const req = {
    user: { role: "diagnostics_manage_only" },
    params,
    query: {},
    body: {},
    app: { get: (key) => (key === "serverManager" ? { serverPath: installRoot } : undefined) },
  };
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

const getCrashLog = (filename, installRoot) => run("/crash-logs/:filename", { filename }, installRoot);
const listCrashLogs = async (installRoot) =>
  (await run("/crash-logs", {}, installRoot)).getBody().crashLogs.map((entry) => entry.name);

function trySymlink(target, link, type, ctx) {
  try {
    fs.symlinkSync(target, link, type);
  } catch (error) {
    // Windows without Developer Mode can't create file symlinks.
    if (error.code === "EPERM") return ctx.skip();
    throw error;
  }
}

describe("GET /crash-logs/:filename serves only listed crash logs", () => {
  let installRoot;
  let outside;
  let secretPath;

  beforeEach(() => {
    installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pz-crash-install-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "pz-crash-outside-"));
    secretPath = path.join(outside, "jwt.secret");
    fs.writeFileSync(secretPath, "TOP-SECRET-SIGNING-KEY");
    fs.writeFileSync(path.join(installRoot, "hs_err_pid1.log"), "# A fatal error has been detected");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(installRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("still serves a genuine crash log, from the install folder or its logs folder", async () => {
    fs.mkdirSync(path.join(installRoot, "logs"));
    fs.writeFileSync(path.join(installRoot, "logs", "zomboid-crash.log"), "crash details here");

    const first = await getCrashLog("hs_err_pid1.log", installRoot);
    expect(first.getStatusCode()).toBe(200);
    expect(first.getBody()).toMatchObject({ content: "# A fatal error has been detected", truncated: false });

    const second = await getCrashLog("zomboid-crash.log", installRoot);
    expect(second.getStatusCode()).toBe(200);
    expect(second.getBody().content).toBe("crash details here");
    expect(await listCrashLogs(installRoot)).toEqual(expect.arrayContaining(["hs_err_pid1.log", "zomboid-crash.log"]));
  });

  it("refuses a file swapped in at the name between the check and the open", async () => {
    const realOpen = fs.promises.open.bind(fs.promises);
    let swapped = false;
    vi.spyOn(fs.promises, "open").mockImplementation(async (filePath, ...rest) => {
      if (!swapped && path.basename(String(filePath)) === "hs_err_pid1.log") {
        swapped = true;
        fs.renameSync(secretPath, String(filePath));
      }
      return realOpen(filePath, ...rest);
    });

    const res = await getCrashLog("hs_err_pid1.log", installRoot);

    expect(swapped).toBe(true);
    expect(res.getStatusCode()).toBe(404);
    expect(JSON.stringify(res.getBody())).not.toContain("TOP-SECRET");
  });

  it("refuses a symbolic link named like a crash log, and does not list it", async (ctx) => {
    trySymlink(secretPath, path.join(installRoot, "hs_err_pid2.log"), "file", ctx);

    const res = await getCrashLog("hs_err_pid2.log", installRoot);

    expect(res.getStatusCode()).toBe(404);
    expect(JSON.stringify(res.getBody())).not.toContain("TOP-SECRET");
    expect(await listCrashLogs(installRoot)).not.toContain("hs_err_pid2.log");
  });

  it("does not list a junction named like a crash log, since the content route won't serve it", async () => {
    fs.symlinkSync(outside, path.join(installRoot, "hs_err_pid3.log"), "junction");

    const listed = await listCrashLogs(installRoot);
    expect(listed).toContain("hs_err_pid1.log");
    expect(listed).not.toContain("hs_err_pid3.log");
    expect((await getCrashLog("hs_err_pid3.log", installRoot)).getStatusCode()).toBe(404);
  });

  // Adversary pass: names Windows resolves to the listed file under another
  // spelling are not that file's listed name.
  it.each([
    ["a case alias", "hs_err_pid1.LOG"],
    ["a trailing dot", "hs_err_pid1.log."],
    ["a default data stream suffix", "hs_err_pid1.log::$DATA"],
  ])("refuses %s of a listed crash log", async (_label, filename) => {
    const res = await getCrashLog(filename, installRoot);
    expect(res.getStatusCode()).toBe(404);
    expect(res.getBody()).not.toHaveProperty("content");
  });

  it.skipIf(process.platform === "win32")("does not wait on a FIFO swapped in after the check", async () => {
    const { execFileSync } = await import("child_process");
    const fifo = path.join(outside, "fifo");
    execFileSync("mkfifo", [fifo]);
    const realOpen = fs.promises.open.bind(fs.promises);
    let swapped = false;
    vi.spyOn(fs.promises, "open").mockImplementation(async (filePath, ...rest) => {
      if (!swapped && path.basename(String(filePath)) === "hs_err_pid1.log") {
        swapped = true;
        fs.renameSync(fifo, String(filePath));
      }
      return realOpen(filePath, ...rest);
    });

    const outcome = await Promise.race([
      getCrashLog("hs_err_pid1.log", installRoot).then((res) => res.getStatusCode()),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 3000)),
    ]);
    if (outcome === "blocked") {
      // Release the blocked open so the worker can exit.
      fs.closeSync(fs.openSync(path.join(installRoot, "hs_err_pid1.log"), "r+"));
    }
    expect(outcome).toBe(404);
  });

  // Adversary pass: the support bundle (same diagnostics.manage holder) lists
  // regular files and streams them later; a link swapped in at a listed name
  // in between must not be followed.
  it.skipIf(process.platform === "win32")("the support bundle does not follow a link swapped in after its scan", async () => {
    const { getDataPaths } = await import("../utils/paths.js");
    const logsDir = getDataPaths().logsDir;
    fs.mkdirSync(logsDir, { recursive: true });
    const name = "zz-swapped.log";
    fs.writeFileSync(path.join(logsDir, name), "a real log line\n");
    const reads = [];
    const realCreateReadStream = fs.createReadStream.bind(fs);
    vi.spyOn(fs, "createReadStream").mockImplementation((filePath, options) => {
      if (path.basename(String(filePath)) !== name) return realCreateReadStream(filePath, options);
      fs.rmSync(filePath);
      fs.symlinkSync(secretPath, filePath);
      const stream = realCreateReadStream(filePath, options);
      reads.push(
        new Promise((resolve) => {
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          stream.on("error", (error) => resolve(error.code));
        }),
      );
      return stream;
    });
    const res = {
      headersSent: false,
      setHeader() {},
      status() {
        return { json() {}, end() {} };
      },
      destroy() {},
      on() {
        return this;
      },
      once() {
        return this;
      },
      write() {
        return true;
      },
      end() {},
      emit() {
        return false;
      },
    };

    const layer = debugRouter.stack.find((entry) => entry.route?.path === "/logs/download-zip");
    const stack = layer.route.stack;
    await stack[stack.length - 1].handle({}, res);

    expect(reads).toHaveLength(1);
    expect(await reads[0]).toBe("ELOOP");
  });
});

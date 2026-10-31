import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import unzipper from "unzipper";
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
// Review round 1: a hard link is a regular file whose real path is its own,
// so one to jwt.secret passed every check; and a <server>/logs (or
// <install>/logs for the support bundle) that is itself a link to another
// folder was read through. Both are refused now, also when the link is
// swapped in and out around the checks.
const getRoleByName = vi.fn(async (name) =>
  name === "diagnostics_manage_only" ? { capabilities: ["diagnostics.manage"] } : mockGetRoleByName(name),
);

let activeServer = null;
vi.mock("../database/init.js", async () => {
  const actual = await vi.importActual("../database/init.js");
  return { ...actual, getRoleByName, getActiveServer: vi.fn(async () => activeServer) };
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

// Runs GET /logs/download-zip and returns the zip's files by name.
// beforeStream runs once, after the scan and before any file is read.
async function downloadBundle({ beforeStream } = {}) {
  const out = new PassThrough();
  const chunks = [];
  out.on("data", (chunk) => chunks.push(chunk));
  const ended = new Promise((resolve, reject) => {
    out.on("end", resolve);
    out.on("error", reject);
  });
  let hooked = false;
  out.headersSent = false;
  out.setHeader = () => {
    if (!hooked) {
      hooked = true;
      beforeStream?.();
    }
  };
  out.status = (code) => ({ json: (body) => out.destroy(new Error(`${code} ${JSON.stringify(body)}`)) });
  const layer = debugRouter.stack.find((entry) => entry.route?.path === "/logs/download-zip");
  const stack = layer.route.stack;
  await stack[stack.length - 1].handle({}, out);
  await ended;
  const zip = await unzipper.Open.buffer(Buffer.concat(chunks));
  const files = {};
  for (const file of zip.files) {
    if (file.type === "File") files[file.path] = (await file.buffer()).toString("utf8");
  }
  return files;
}

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
    activeServer = null;
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

  it("refuses a hard link named like a crash log, and does not list it", async () => {
    fs.linkSync(secretPath, path.join(installRoot, "hs_err_pid9.log"));

    const res = await getCrashLog("hs_err_pid9.log", installRoot);

    expect(res.getStatusCode()).toBe(404);
    expect(JSON.stringify(res.getBody())).not.toContain("TOP-SECRET");
    const listed = await listCrashLogs(installRoot);
    expect(listed).toContain("hs_err_pid1.log");
    expect(listed).not.toContain("hs_err_pid9.log");
  });

  it("does not read crash logs through a <server>/logs link to another folder", async () => {
    fs.writeFileSync(path.join(outside, "zomboid-crash.log"), "TOP-SECRET-VIA-FOLDER-LINK");
    fs.symlinkSync(outside, path.join(installRoot, "logs"), "junction");

    const res = await getCrashLog("zomboid-crash.log", installRoot);

    expect(res.getStatusCode()).toBe(404);
    expect(JSON.stringify(res.getBody())).not.toContain("TOP-SECRET");
    expect(await listCrashLogs(installRoot)).not.toContain("zomboid-crash.log");
  });

  // Adversary pass: <server>/logs is the link while the folder is listed and
  // the file opened, and a real folder while its real path is checked.
  it("does not read through a <server>/logs link swapped out only while it is checked", async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "pz-crash-other-"));
    try {
      fs.writeFileSync(path.join(other, "zomboid-crash.log"), "TOP-SECRET-FLIPPED");
      const logs = path.join(installRoot, "logs");
      const parkedLink = path.join(installRoot, "logs-link");
      const parkedDir = path.join(installRoot, "logs-dir");
      fs.mkdirSync(parkedDir);
      fs.writeFileSync(path.join(parkedDir, "zomboid-crash.log"), "a real crash log");
      fs.symlinkSync(other, logs, "junction");
      let state = "link";
      const realRealpath = fs.promises.realpath.bind(fs.promises);
      vi.spyOn(fs.promises, "realpath").mockImplementation(async (target, ...rest) => {
        if (state === "link" && path.resolve(String(target)) === logs) {
          fs.renameSync(logs, parkedLink);
          fs.renameSync(parkedDir, logs);
          state = "dir";
        }
        return realRealpath(target, ...rest);
      });
      const realOpen = fs.promises.open.bind(fs.promises);
      vi.spyOn(fs.promises, "open").mockImplementation(async (target, ...rest) => {
        if (state === "dir" && path.basename(String(target)) === "zomboid-crash.log") {
          fs.renameSync(logs, parkedDir);
          fs.renameSync(parkedLink, logs);
          state = "link again";
        }
        return realOpen(target, ...rest);
      });

      const res = await getCrashLog("zomboid-crash.log", installRoot);

      expect(state).toBe("link again");
      expect(res.getStatusCode()).toBe(404);
      expect(JSON.stringify(res.getBody())).not.toContain("TOP-SECRET");
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

// The support bundle (same diagnostics.manage holder) scans the install
// folder's logs and streams the files it found later.
describe("the support bundle reads only the server's own log files", () => {
  let installRoot;
  let outside;
  let secretPath;

  beforeEach(() => {
    installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pz-bundle-install-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "pz-bundle-outside-"));
    secretPath = path.join(outside, "jwt.secret");
    fs.writeFileSync(secretPath, "TOP-SECRET-SIGNING-KEY");
    activeServer = { id: "s1", name: "s1", installPath: installRoot };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    activeServer = null;
    fs.rmSync(installRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const leaked = (files) => Object.values(files).some((content) => content.includes("TOP-SECRET"));

  it("still includes the install folder's logs and crash dumps", async () => {
    fs.mkdirSync(path.join(installRoot, "logs"));
    fs.writeFileSync(path.join(installRoot, "logs", "console.txt"), "a real log line");
    fs.writeFileSync(path.join(installRoot, "hs_err_pid1.log"), "# A fatal error");

    const files = await downloadBundle();

    expect(files["zomboid-install/logs/console.txt"]).toBe("a real log line");
    expect(files["crash-logs/install-root/hs_err_pid1.log"]).toBe("# A fatal error");
  });

  it("leaves out a hard link in the install folder", async () => {
    fs.writeFileSync(path.join(installRoot, "hs_err_pid1.log"), "# A fatal error");
    fs.linkSync(secretPath, path.join(installRoot, "hs_err_pid9.log"));

    const files = await downloadBundle();

    expect(files["crash-logs/install-root/hs_err_pid1.log"]).toBe("# A fatal error");
    expect(Object.keys(files).some((name) => name.includes("hs_err_pid9"))).toBe(false);
    expect(leaked(files)).toBe(false);
  });

  it("does not scan an <install>/logs that links to another folder", async () => {
    fs.writeFileSync(path.join(installRoot, "hs_err_pid1.log"), "# A fatal error");
    fs.writeFileSync(path.join(outside, "reset-token.txt"), "TOP-SECRET-RESET-TOKEN");
    fs.writeFileSync(path.join(outside, "server-crash.log"), "TOP-SECRET-CRASH");
    fs.symlinkSync(outside, path.join(installRoot, "logs"), "junction");

    const files = await downloadBundle();

    expect(files["crash-logs/install-root/hs_err_pid1.log"]).toBe("# A fatal error");
    expect(Object.keys(files).some((name) => /reset-token|server-crash/.test(name))).toBe(false);
    expect(leaked(files)).toBe(false);
  });

  it("leaves out a hard link swapped in at a scanned name before it is read", async () => {
    fs.mkdirSync(path.join(installRoot, "logs"));
    const scanned = path.join(installRoot, "logs", "console.txt");
    fs.writeFileSync(scanned, "a real log line");
    fs.writeFileSync(path.join(installRoot, "logs", "other.txt"), "another log line");

    const files = await downloadBundle({
      beforeStream: () => {
        fs.rmSync(scanned);
        fs.linkSync(secretPath, scanned);
      },
    });

    expect(files["zomboid-install/logs/other.txt"]).toBe("another log line");
    expect(files).not.toHaveProperty(["zomboid-install/logs/console.txt"]);
    expect(leaked(files)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("leaves out a symbolic link swapped in at a scanned name", async () => {
    fs.mkdirSync(path.join(installRoot, "logs"));
    const scanned = path.join(installRoot, "logs", "console.txt");
    fs.writeFileSync(scanned, "a real log line");
    fs.writeFileSync(path.join(installRoot, "logs", "other.txt"), "another log line");

    const files = await downloadBundle({
      beforeStream: () => {
        fs.rmSync(scanned);
        fs.symlinkSync(secretPath, scanned);
      },
    });

    expect(files["zomboid-install/logs/other.txt"]).toBe("another log line");
    expect(files).not.toHaveProperty(["zomboid-install/logs/console.txt"]);
    expect(leaked(files)).toBe(false);
  });

  // Adversary pass: <install>/logs is a real folder while its real path is
  // checked, and the link while it is listed and the files are opened.
  it("does not read through an <install>/logs link swapped out only while it is checked", async () => {
    fs.writeFileSync(path.join(outside, "console.txt"), "TOP-SECRET-FLIPPED");
    const logs = path.join(installRoot, "logs");
    const parkedLink = path.join(installRoot, "logs-link");
    const parkedDir = path.join(installRoot, "logs-dir");
    fs.mkdirSync(parkedDir);
    fs.writeFileSync(path.join(parkedDir, "console.txt"), "a real log line");
    fs.symlinkSync(outside, logs, "junction");
    let state = "link";
    const realRealpath = fs.promises.realpath.bind(fs.promises);
    vi.spyOn(fs.promises, "realpath").mockImplementation(async (target, ...rest) => {
      if (state === "link" && path.resolve(String(target)) === logs) {
        fs.renameSync(logs, parkedLink);
        fs.renameSync(parkedDir, logs);
        state = "dir";
      }
      return realRealpath(target, ...rest);
    });
    const realReaddir = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, "readdir").mockImplementation(async (target, ...rest) => {
      if (state === "dir" && path.basename(String(target)) === "logs") {
        fs.renameSync(logs, parkedDir);
        fs.renameSync(parkedLink, logs);
        state = "link again";
      }
      return realReaddir(target, ...rest);
    });

    const files = await downloadBundle();

    expect(state).toBe("link again");
    expect(leaked(files)).toBe(false);
  });
});

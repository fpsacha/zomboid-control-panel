import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

// RCE-STARTCMD (security sweep 2026-10-04): setting a server's launch
// target -- its custom start command, or an installPath/serverPath naming a
// .bat/.sh/.exe launcher -- now requires files.manage (admin-only by
// default), and the stored value is confined to the server's own install
// folder (findLaunchTargetRefusal()). Before the fix, servers.manage alone
// (which technician holds) could save `powershell.exe -enc <payload>` and
// POST /api/server/start ran it as the panel account.
//
// Full stack through the real servers router and the real, unmocked
// database/init.js (the suite's per-file temp dataDir keeps this isolated),
// with the signed-in role injected as req.user -- the same shape the
// verifier repro used. requirePermission() resolves the seeded roles from
// the real DB, so the technician-vs-admin split is the genuine one.
const { initDatabase, deleteServer, getServer } = await import(
  "../database/init.js"
);
const { default: serversRouter } = await import("../routes/servers.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

let baseUrl;
let httpServer;
let currentRole = "technician";
let installDir;
let outsideLauncher;
const createdIds = [];

async function call(method, url, body) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-launch-admin-"));
  installDir = path.join(root, "pz-install");
  fs.mkdirSync(installDir, { recursive: true });
  outsideLauncher = path.join(root, "elsewhere", process.platform === "win32" ? "evil.bat" : "evil.sh");
  fs.mkdirSync(path.dirname(outsideLauncher), { recursive: true });
  fs.writeFileSync(outsideLauncher, "");

  await initDatabase();

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  // Stand-in for the JWT middleware: a signed-in user whose role this test
  // flips. A stub serverManager so an active-server reload after a saved
  // edit doesn't reach for a real one.
  app.use((req, _res, next) => {
    req.user = { id: `u-${currentRole}`, username: currentRole, role: currentRole };
    next();
  });
  app.set("serverManager", { reloadConfig: async () => {} });
  app.use("/api/servers", serversRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  for (const id of createdIds) await deleteServer(id).catch(() => {});
  await new Promise((r) => httpServer?.close(r));
});

async function makeServer() {
  currentRole = "admin";
  const r = await call("POST", "/api/servers", {
    name: `LaunchTarget ${createdIds.length}`,
    serverName: `LaunchTarget${createdIds.length}`,
    installPath: installDir,
    rconHost: "127.0.0.1",
    rconPort: 27000 + createdIds.length,
    rconPassword: "x",
  });
  expect(r.status).toBe(201);
  const id = r.json.server.id;
  createdIds.push(id);
  return id;
}

describe("PUT /api/servers/:id -- startCommand is admin-only and confined (RCE-STARTCMD)", () => {
  it("refuses a technician: setting startCommand needs files.manage (403)", async () => {
    const id = await makeServer();
    currentRole = "technician";
    const r = await call("PUT", `/api/servers/${id}`, {
      startCommand: `${process.platform === "win32" ? "powershell.exe" : "/bin/sh"} -enc AAAA`,
    });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe(ErrorCode.SERVER_LAUNCH_TARGET_ADMIN_ONLY);
    // Nothing was stored.
    expect((await getServer(id)).startCommand).toBe("");
  });

  it("refuses a technician: pointing installPath at a launcher script (403)", async () => {
    const id = await makeServer();
    currentRole = "technician";
    const r = await call("PUT", `/api/servers/${id}`, { installPath: outsideLauncher });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe(ErrorCode.SERVER_LAUNCH_TARGET_ADMIN_ONLY);
  });

  it("lets a technician change a non-launch field (serverPort) -- gate is scoped", async () => {
    const id = await makeServer();
    currentRole = "technician";
    const r = await call("PUT", `/api/servers/${id}`, { serverPort: 16271 });
    expect(r.status).toBe(200);
  });

  it("admin may set a start command, but not one that escapes the install folder (400)", async () => {
    const id = await makeServer();
    currentRole = "admin";
    const r = await call("PUT", `/api/servers/${id}`, {
      startCommand: `${process.platform === "win32" ? "powershell.exe" : "/bin/sh"} -enc AAAA`,
    });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(ErrorCode.SERVER_LAUNCH_TARGET_REFUSED);
    expect((await getServer(id)).startCommand).toBe("");
  });

  it("admin may set a start command that stays inside the install folder", async () => {
    const id = await makeServer();
    const launcher = path.join(installDir, process.platform === "win32" ? "run.bat" : "run.sh");
    fs.writeFileSync(launcher, "");
    currentRole = "admin";
    const r = await call("PUT", `/api/servers/${id}`, {
      startCommand: process.platform === "win32" ? "run.bat -servername X" : "./run.sh -servername X",
    });
    expect(r.status).toBe(200);
    expect((await getServer(id)).startCommand).toContain("run.");
  });
});

// Adversary pass on the fix (2026-10-04): moving a managed server's
// serverPath to a plain folder stays a servers.manage edit, but the folder
// is where a relative start command runs. The save-time check judged it
// against installPath instead, so an admin's later in-folder-looking
// command could be made to run a program from wherever a technician had
// pointed serverPath.
describe("PUT /api/servers/:id -- a start command is judged in the folder it runs from", () => {
  it("refuses an admin's relative start command that would run a system program from a pre-positioned serverPath (400)", async () => {
    const id = await makeServer();
    currentRole = "technician";
    const systemDir = process.platform === "win32"
      ? path.join(process.env.SystemRoot || "C:\\Windows", "System32")
      : "/usr/bin";
    const moved = await call("PUT", `/api/servers/${id}`, { serverPath: systemDir });
    expect(moved.status).toBe(200);

    currentRole = "admin";
    const r = await call("PUT", `/api/servers/${id}`, {
      startCommand: process.platform === "win32" ? "whoami.exe" : "whoami",
    });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(ErrorCode.SERVER_LAUNCH_TARGET_REFUSED);
    expect((await getServer(id)).startCommand).toBe("");
  });
});

describe("POST /api/servers -- creating with a launcher install path is admin-only", () => {
  it("refuses a technician creating a server whose installPath is a launcher (403)", async () => {
    currentRole = "technician";
    const r = await call("POST", "/api/servers", {
      name: "NewLauncher",
      serverName: "NewLauncher",
      installPath: outsideLauncher,
      rconHost: "127.0.0.1",
      rconPort: 27900,
      rconPassword: "x",
    });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe(ErrorCode.SERVER_LAUNCH_TARGET_ADMIN_ONLY);
  });
});

// SECURITY (2026-10-28): a managed launch runs the launch folder's own
// jre64/java and java/ classes, so a technician pointing a server at a
// downloaded Workshop item (or a network share) chose what Start runs.
// Refused when saved, for every role (launchFolderUntrusted.test.js covers
// the start-time check).
describe("POST/PUT /api/servers -- a Workshop download folder is not a launch folder", () => {
  const workshopItem = () =>
    path.join(installDir, "steamapps", "workshop", "content", "108600", "3000000001");

  it("refuses a technician moving installPath or serverPath into a Workshop item (400)", async () => {
    const id = await makeServer();
    fs.mkdirSync(workshopItem(), { recursive: true });
    currentRole = "technician";
    for (const key of ["installPath", "serverPath"]) {
      const r = await call("PUT", `/api/servers/${id}`, { [key]: workshopItem() });
      expect(r.status).toBe(400);
      expect(r.json.code).toBe(ErrorCode.SERVER_LAUNCH_FOLDER_REFUSED);
    }
    expect((await getServer(id)).installPath).toBe(installDir);
  });

  it("refuses an admin too, and a new server created there (400)", async () => {
    const id = await makeServer();
    currentRole = "admin";
    const moved = await call("PUT", `/api/servers/${id}`, { installPath: workshopItem() });
    expect(moved.status).toBe(400);
    expect(moved.json.code).toBe(ErrorCode.SERVER_LAUNCH_FOLDER_REFUSED);

    currentRole = "technician";
    const created = await call("POST", "/api/servers", {
      name: "FromWorkshop",
      serverName: "FromWorkshop",
      installPath: workshopItem(),
      rconHost: "127.0.0.1",
      rconPort: 27901,
      rconPassword: "x",
    });
    expect(created.status).toBe(400);
    expect(created.json.code).toBe(ErrorCode.SERVER_LAUNCH_FOLDER_REFUSED);
  });
});

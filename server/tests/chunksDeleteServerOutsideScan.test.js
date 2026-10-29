import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// R2-23 (2026-10-28): delete-chunks/delete-region decided "stopped" from the
// panel's own process scan alone. With the game in another container, or on
// the host while the panel runs in Docker, that scan finds nothing while the
// world is open, so Map Cleanup deleted under a live server (which writes the
// chunks back, and has vehicles.db replaced under it). The routes now also
// refuse on the container's own state (Docker providers) and on a live RCON
// connection, as restore and wipe do.

const { dockerSignal } = vi.hoisted(() => ({ dockerSignal: vi.fn() }));

vi.mock("../services/managedContainer.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveDockerHostSignal: (...args) => dockerSignal(...args),
}));

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getRoleByName: mockGetRoleByName,
  getServers: vi.fn(),
  getSetting: vi.fn(),
}));

const { getActiveServer, getServers, getSetting } = await import("../database/init.js");
const { default: router } = await import("../routes/chunks.js");

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

async function runRoute(routePath, method, req) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  const handlers = layer.route.stack.map((s) => s.handle);
  const res = createResponse();
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

const SAVE_NAME = "TestSave";
const STOPPED_SCAN = { getServerProcessDetails: async () => ({ running: false, scanFailed: false, matched: [] }) };
let dataRoot;
let chunkFile;

function post(routePath, { rconConnected = false, force = false } = {}) {
  const services = {
    serverManager: STOPPED_SCAN,
    rconService: { connected: rconConnected },
  };
  const body =
    routePath === "/delete-chunks"
      ? { chunks: [{ file: "0/0.bin", x: 0, y: 0 }] }
      : { minX: 0, maxX: 1, minY: 0, maxY: 1 };
  return runRoute(routePath, "post", {
    user: { role: "technician" },
    app: { get: (key) => services[key] ?? null },
    body: {
      saveName: SAVE_NAME,
      force,
      createBackup: false,
      deleteVehicles: false,
      expectedServerId: "server-1",
      ...body,
    },
  });
}

function activeServer(extra = {}) {
  getActiveServer.mockResolvedValue({
    id: "server-1",
    zomboidDataPath: dataRoot,
    isRemote: false,
    ...extra,
  });
}

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chunks-outside-scan-"));
  chunkFile = path.join(dataRoot, "Saves", "Multiplayer", SAVE_NAME, "map", "0", "0.bin");
  fs.mkdirSync(path.dirname(chunkFile), { recursive: true });
  fs.writeFileSync(chunkFile, "chunk");
  getActiveServer.mockReset();
  activeServer();
  getServers.mockReset().mockResolvedValue([]);
  getSetting.mockReset().mockResolvedValue(null);
  dockerSignal.mockReset().mockResolvedValue({ running: false, scanFailed: false });
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe.each(["/delete-chunks", "/delete-region"])("%s with a server the process scan cannot see", (route) => {
  it("refuses while RCON is connected, though the scan found no server process", async () => {
    const res = await post(route, { rconConnected: true });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toMatchObject({ code: "server_running", matched: [] });
    expect(fs.existsSync(chunkFile)).toBe(true);
  });

  it("refuses while the server's Docker container is running", async () => {
    activeServer({ dockerContainerName: "pz-server" });
    dockerSignal.mockResolvedValue({ running: true, scanFailed: false });
    const res = await post(route);
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toMatchObject({ code: "server_running" });
    expect(fs.existsSync(chunkFile)).toBe(true);
  });

  it("refuses as 'can't verify' when the container's state can't be read", async () => {
    activeServer({ dockerContainerName: "pz-server" });
    dockerSignal.mockResolvedValue({ running: false, scanFailed: true });
    const res = await post(route);
    expect(res.getStatusCode()).toBe(503);
    expect(res.getBody()).toMatchObject({ code: "SERVER_STATE_UNKNOWN" });
    expect(fs.existsSync(chunkFile)).toBe(true);
  });

  // Adversary pass: the container's state is the authoritative answer for
  // the dashboard, but a stopped verdict from it must not outvote a live
  // RCON connection here.
  it("refuses when the container reads stopped but RCON still answers", async () => {
    activeServer({ dockerContainerName: "pz-server" });
    dockerSignal.mockResolvedValue({ running: false, scanFailed: false });
    const res = await post(route, { rconConnected: true });
    expect(res.getStatusCode()).toBe(400);
    expect(fs.existsSync(chunkFile)).toBe(true);
  });

  it("still deletes when the scan, the container and RCON all say stopped", async () => {
    let res = await post(route);
    expect(res.getStatusCode()).toBe(200);
    expect(fs.existsSync(chunkFile)).toBe(false);

    fs.mkdirSync(path.dirname(chunkFile), { recursive: true });
    fs.writeFileSync(chunkFile, "chunk");
    activeServer({ dockerContainerName: "pz-server" });
    res = await post(route);
    expect(res.getStatusCode()).toBe(200);
    expect(fs.existsSync(chunkFile)).toBe(false);
  });

  it("force still overrides, as it does for the process scan", async () => {
    const res = await post(route, { rconConnected: true, force: true });
    expect(res.getStatusCode()).toBe(200);
    expect(fs.existsSync(chunkFile)).toBe(false);
  });
});

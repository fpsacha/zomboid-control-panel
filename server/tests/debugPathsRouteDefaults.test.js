import { describe, expect, it, vi, beforeEach } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// 2026-08-27: POST /debug/paths used to pass `moveFiles !== false` to
// setDataPaths() -- a request with no moveFiles key at all got the
// destructive file-move option by default, not by choice. This file covers
// the ROUTE's own responsibility only (computing the right arguments and
// forwarding them) -- setDataPaths()'s own validation/move/anti-lockout
// logic is covered for real, without mocks, in server/tests/setDataPaths.test.js.

const setDataPaths = vi.fn();
const getServers = vi.fn();
const getAllSettings = vi.fn();

vi.mock("../utils/paths.js", async () => {
  const actual = await vi.importActual("../utils/paths.js");
  return { ...actual, setDataPaths };
});

vi.mock("../database/init.js", async () => {
  const actual = await vi.importActual("../database/init.js");
  return { ...actual, getRoleByName: mockGetRoleByName, getServers, getAllSettings };
});

const { default: router } = await import("../routes/debug.js");

function createResponse() {
  const response = { status: () => response, json: () => response };
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

function getRouteHandlers(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack.map((s) => s.handle);
}

async function postPaths(body) {
  const handlers = getRouteHandlers("/paths", "post");
  const res = createResponse();
  const req = { user: { role: "admin" }, body, app: { get: () => null } };
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

beforeEach(() => {
  setDataPaths.mockReset().mockResolvedValue({
    success: true,
    paths: { dataDir: "/x/data", logsDir: "/x/logs" },
    filesMoved: { data: false, logs: false },
  });
  getServers.mockReset().mockResolvedValue([]);
  getAllSettings.mockReset().mockResolvedValue({});
});

describe("POST /debug/paths: moveFiles default", () => {
  it("passes moveFiles=false to setDataPaths when the body omits the key entirely", async () => {
    await postPaths({ dataDir: "/new/data" });
    expect(setDataPaths).toHaveBeenCalledWith(
      { dataDir: "/new/data", logsDir: undefined },
      false,
      expect.any(Object),
    );
  });

  it("passes moveFiles=true only when the body explicitly sets it to the boolean true", async () => {
    await postPaths({ dataDir: "/new/data", moveFiles: true });
    expect(setDataPaths).toHaveBeenCalledWith(
      { dataDir: "/new/data", logsDir: undefined },
      true,
      expect.any(Object),
    );
  });

  it("treats a truthy non-boolean value the same as absent -- strict === true, not a loose truthy check", async () => {
    await postPaths({ dataDir: "/new/data", moveFiles: "true" });
    expect(setDataPaths).toHaveBeenCalledWith(
      { dataDir: "/new/data", logsDir: undefined },
      false,
      expect.any(Object),
    );
  });

  it("passes moveFiles=false when the body explicitly sets it to false (unchanged from before)", async () => {
    await postPaths({ dataDir: "/new/data", moveFiles: false });
    expect(setDataPaths).toHaveBeenCalledWith(
      { dataDir: "/new/data", logsDir: undefined },
      false,
      expect.any(Object),
    );
  });
});

describe("POST /debug/paths: extraBlockedPaths wiring", () => {
  it("collects installPath and zomboidDataPath from every configured server", async () => {
    getServers.mockResolvedValue([
      { id: 1, installPath: "/srv/pz1", zomboidDataPath: "/data/zomboid1" },
      { id: 2, installPath: "/srv/pz2", zomboidDataPath: null },
    ]);

    await postPaths({ dataDir: "/new/data" });

    expect(setDataPaths).toHaveBeenCalledWith(
      expect.any(Object),
      false,
      { extraBlockedPaths: ["/srv/pz1", "/data/zomboid1", "/srv/pz2"], secretPaths: [] },
    );
  });

  it("passes an empty extraBlockedPaths array when no servers are configured", async () => {
    getServers.mockResolvedValue([]);
    await postPaths({ dataDir: "/new/data" });
    expect(setDataPaths).toHaveBeenCalledWith(expect.any(Object), false, { extraBlockedPaths: [], secretPaths: [] });
  });

  // Security audit 2026-10-20: the logs folder is served file by file, so it
  // must not hold the HTTPS key or certificate (setDataPaths() refuses it).
  it("passes the HTTPS key and certificate paths as secret paths", async () => {
    getAllSettings.mockResolvedValue({ httpsKeyPath: "/certs/key.pem", httpsCertPath: "/certs/cert.pem", httpsEnabled: true });
    await postPaths({ logsDir: "/new/logs" });
    expect(setDataPaths).toHaveBeenCalledWith(expect.any(Object), false, {
      extraBlockedPaths: [],
      secretPaths: ["/certs/key.pem", "/certs/cert.pem"],
    });
  });
});

// SECURITY (2026-10-28): setDataPaths()'s coded refusals (a network share,
// the program or served folder) reach the client with their code, so the
// Debug page shows the translated reason.
describe("POST /debug/paths: refusal codes", () => {
  it("forwards a refusal's code with its error", async () => {
    setDataPaths.mockResolvedValue({ success: false, error: "refused", code: "PANEL_DATA_FOLDER_REFUSED" });
    const res = await postPaths({ dataDir: "/app/client/dist/x" });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toEqual({ error: "refused", code: "PANEL_DATA_FOLDER_REFUSED" });
  });

  it("sends no code for an uncoded refusal", async () => {
    setDataPaths.mockResolvedValue({ success: false, error: "Path must be absolute" });
    const res = await postPaths({ dataDir: "relative" });
    expect(res.getBody()).toEqual({ error: "Path must be absolute" });
  });
});

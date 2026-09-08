import { beforeEach, describe, expect, it, vi } from "vitest";

const getActiveServer = vi.fn();
const getServer = vi.fn();
const saveTemplate = vi.fn();
const applyTemplate = vi.fn();
const listHiddenBuiltinTemplates = vi.fn();
const unhideTemplate = vi.fn();

import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getServer,
  getRoleByName: mockGetRoleByName,
}));

// checkSpecificServerStopped() (routes/server.js, now imported by
// routes/templates.js's non-active-server branch) does a real host-wide
// process scan via ServerManager.scanHostForServerProcesses() -- mocked the
// same way serversStatusListProcessAttribution.test.js mocks it.
const scanHostForServerProcesses = vi.fn().mockResolvedValue({ matched: [] });
vi.mock("../services/serverManager.js", async () => {
  const actual = await vi.importActual("../services/serverManager.js");
  return {
    ...actual,
    ServerManager: vi.fn().mockImplementation(function () {
      this.scanHostForServerProcesses = scanHostForServerProcesses;
    }),
  };
});

vi.mock("../services/templateService.js", () => ({
  listTemplates: vi.fn(),
  listHiddenBuiltinTemplates,
  getTemplate: vi.fn(),
  saveTemplate,
  deleteTemplate: vi.fn(),
  unhideTemplate,
  exportTemplate: vi.fn(),
  importTemplate: vi.fn(),
  previewTemplate: vi.fn(),
  applyTemplate,
}));

const { default: router } = await import("../routes/templates.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function runRoute(routePath, method, request, response) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  const handlers = layer.route.stack.map((entry) => entry.handle);
  let index = -1;
  const next = async (error) => {
    index += 1;
    if (error) throw error;
    if (index < handlers.length) {
      await handlers[index](request, response, next);
    }
  };
  await next();
}

describe("template mutation routes", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    getServer.mockReset();
    saveTemplate.mockReset();
    applyTemplate.mockReset();
    listHiddenBuiltinTemplates.mockReset();
    unhideTemplate.mockReset();
    scanHostForServerProcesses.mockReset().mockResolvedValue({ matched: [] });
  });

  it("rejects template creation by a non-admin user", async () => {
    const response = createResponse();

    await runRoute(
      "/",
      "post",
      { body: {}, user: { role: "viewer" } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it("rejects applying a template while the active server is running", async () => {
    getActiveServer.mockResolvedValue({ id: "server-1" });
    const response = createResponse();

    await runRoute(
      "/:id/apply",
      "post",
      {
        params: { id: "template-1" },
        body: { serverId: "server-1" },
        user: { role: "admin" },
        app: {
          get: () => ({
            // split-derivation sweep, 2026-09-07: the route now forces a
            // real reloadConfig() before trusting getServerProcessDetails().
            reloadConfig: vi.fn(async () => {}),
            getServerProcessDetails: vi.fn(async () => ({ running: true, scanFailed: false })),
          }),
        },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(applyTemplate).not.toHaveBeenCalled();
  });

  it("fails closed when active-server state cannot be checked (the scan itself throws)", async () => {
    getActiveServer.mockResolvedValue({ id: "server-1" });
    const response = createResponse();

    await runRoute(
      "/:id/apply",
      "post",
      {
        params: { id: "template-1" },
        body: { serverId: "server-1" },
        user: { role: "admin" },
        app: {
          get: () => ({
            reloadConfig: vi.fn(async () => {}),
            getServerProcessDetails: vi.fn(async () => {
              throw new Error("scan failed");
            }),
          }),
        },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(503);
    expect(applyTemplate).not.toHaveBeenCalled();
  });

  // Previously this route asked serverManager.checkServerRunning(), which
  // discards the scan's own scanFailed flag and returns a plain boolean --
  // so a scan that completed but couldn't determine the server's state
  // (timeout, PowerShell/exec error) came back as `false`, indistinguishable
  // from a confirmed-stopped server, and the apply proceeded. Same fail-open
  // class already fixed at /wipe, /delete-files, chunks.js's
  // delete-chunks/delete-region, and backup.js's restore.
  it("fails closed when the scan completed but could not determine the server's state (scanFailed:true)", async () => {
    getActiveServer.mockResolvedValue({ id: "server-1" });
    const response = createResponse();

    await runRoute(
      "/:id/apply",
      "post",
      {
        params: { id: "template-1" },
        body: { serverId: "server-1" },
        user: { role: "admin" },
        app: {
          get: () => ({
            // Old method the route used to call directly -- collapses the
            // failed scan into a plain `false`, which is exactly the bug:
            // present alongside getServerProcessDetails so unfixed code
            // (which calls checkServerRunning) proceeds instead of refusing.
            checkServerRunning: vi.fn(async () => false),
            reloadConfig: vi.fn(async () => {}),
            getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: true })),
          }),
        },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(503);
    expect(applyTemplate).not.toHaveBeenCalled();
  });

  // is-running-enumeration sweep, 2026-09-08: the running-state guard above
  // used to only ever run inside the "target IS the active server" branch
  // (2026-08-24 conv-template-privesc) -- applying to any OTHER configured
  // server skipped it entirely, refusing unconditionally because no
  // cross-server detection existed yet. checkSpecificServerStopped()
  // (routes/server.js) now provides exactly that -- a host-wide scan
  // attributed to a SPECIFIC target via scoreServerProcessOwnership(), the
  // same convention already used for /delete-files' identical gap -- so
  // this now runs a real check instead of refusing outright.
  it("refuses to apply a template to a non-active server the check confirms is running", async () => {
    getActiveServer.mockResolvedValue({ id: "server-1" });
    getServer.mockResolvedValue({
      id: "server-2",
      serverName: "Server2",
      zomboidDataPath: "C:\\Zomboid\\Server2",
      serverPath: "C:\\Servers\\Server2",
    });
    scanHostForServerProcesses.mockResolvedValue({
      matched: [{ pid: "1", cmd: '"C:\\Servers\\Server2\\java.exe" -servername "Server2"' }],
    });
    const response = createResponse();

    await runRoute(
      "/:id/apply",
      "post",
      {
        params: { id: "template-1" },
        body: { serverId: "server-2" },
        user: { role: "admin" },
        app: { get: () => ({}) },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(applyTemplate).not.toHaveBeenCalled();
  });

  it("applies to a non-active server the check confirms is stopped -- no longer refused just for being non-active", async () => {
    getActiveServer.mockResolvedValue({ id: "server-1" });
    getServer.mockResolvedValue({
      id: "server-2",
      serverName: "Server2",
      zomboidDataPath: "C:\\Zomboid\\Server2",
      serverPath: "C:\\Servers\\Server2",
    });
    scanHostForServerProcesses.mockResolvedValue({ matched: [] });
    applyTemplate.mockResolvedValue({ success: true });
    const response = createResponse();

    await runRoute(
      "/:id/apply",
      "post",
      {
        params: { id: "template-1" },
        body: { serverId: "server-2" },
        user: { role: "admin" },
        app: { get: () => ({}) },
      },
      response,
    );

    expect(applyTemplate).toHaveBeenCalledWith("template-1", "server-2", {});
    expect(response.status).not.toHaveBeenCalledWith(409);
  });

  it("refuses (fails closed) when no server is active, the request targets a specific server, and that target isn't found", async () => {
    getActiveServer.mockResolvedValue(null);
    getServer.mockResolvedValue(null);
    const response = createResponse();

    await runRoute(
      "/:id/apply",
      "post",
      {
        params: { id: "template-1" },
        body: { serverId: "server-1" },
        user: { role: "admin" },
        app: { get: () => ({}) },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(404);
    expect(applyTemplate).not.toHaveBeenCalled();
  });

  it("proceeds when the scan confirms the server is stopped (running:false, scanFailed:false)", async () => {
    getActiveServer.mockResolvedValue({ id: "server-1" });
    applyTemplate.mockResolvedValue({ success: true });
    const response = createResponse();

    await runRoute(
      "/:id/apply",
      "post",
      {
        params: { id: "template-1" },
        body: { serverId: "server-1" },
        user: { role: "admin" },
        app: {
          get: () => ({
            reloadConfig: vi.fn(async () => {}),
            getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: false })),
          }),
        },
      },
      response,
    );

    expect(applyTemplate).toHaveBeenCalledWith("template-1", "server-1", {});
    expect(response.status).not.toHaveBeenCalledWith(409);
    expect(response.status).not.toHaveBeenCalledWith(503);
  });

  // 2026-08-31 bug hunt (templates-builtin-hidden-with-no-restore-path):
  // GET /hidden + POST /:id/unhide are the routes that make a hidden
  // built-in template reachable again. Both gated on templates.manage --
  // same permission as deleting/hiding one.
  it("rejects listing hidden templates by a non-admin user", async () => {
    const response = createResponse();

    await runRoute("/hidden", "get", { user: { role: "viewer" } }, response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(listHiddenBuiltinTemplates).not.toHaveBeenCalled();
  });

  it("lists hidden templates for an admin", async () => {
    listHiddenBuiltinTemplates.mockResolvedValue([{ meta: { id: "vanilla-apocalypse" } }]);
    const response = createResponse();

    await runRoute("/hidden", "get", { user: { role: "admin" } }, response);

    expect(listHiddenBuiltinTemplates).toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith({
      templates: [{ meta: { id: "vanilla-apocalypse" } }],
    });
  });

  it("rejects unhiding a template by a non-admin user", async () => {
    const response = createResponse();

    await runRoute(
      "/:id/unhide",
      "post",
      { params: { id: "vanilla-apocalypse" }, user: { role: "viewer" } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(unhideTemplate).not.toHaveBeenCalled();
  });

  it("unhides a template for an admin", async () => {
    unhideTemplate.mockResolvedValue({ success: true });
    const response = createResponse();

    await runRoute(
      "/:id/unhide",
      "post",
      { params: { id: "vanilla-apocalypse" }, user: { role: "admin" } },
      response,
    );

    expect(unhideTemplate).toHaveBeenCalledWith("vanilla-apocalypse");
    expect(response.json).toHaveBeenCalledWith({ success: true });
  });

  it("reports a 400 when unhiding an id that isn't actually hidden", async () => {
    unhideTemplate.mockResolvedValue({ success: false, error: "Template not found" });
    const response = createResponse();

    await runRoute(
      "/:id/unhide",
      "post",
      { params: { id: "not-hidden" }, user: { role: "admin" } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
  });
});
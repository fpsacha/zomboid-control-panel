import { beforeEach, describe, expect, it, vi } from "vitest";

// SECURITY: POST /docker/containers/:id/:action starts, stops or restarts
// the container mapped to a server profile -- that game server -- and
// docker.manage's own description says the server's power state is
// server.control's. docker.manage alone was enough; both are needed now.

const ROLES = {
  docker_only: { name: "docker_only", capabilities: ["docker.manage"] },
  control_only: { name: "control_only", capabilities: ["server.control"] },
  docker_and_control: { name: "docker_and_control", capabilities: ["docker.manage", "server.control"] },
};

const getServer = vi.fn(async () => null);

vi.mock("../database/init.js", () => ({
  getServer,
  getRoleByName: vi.fn(async (name) => ROLES[name] || null),
}));

const { default: router } = await import("../routes/docker.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function act(role, action) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/containers/:id/:action" && entry.route.methods.post,
  );
  const handlers = layer.route.stack.map((entry) => entry.handle);
  const runManagedAction = vi.fn(async () => ({ success: true }));
  const res = createResponse();
  const req = {
    user: { role },
    params: { id: "pz-1", action },
    body: { serverId: 1 },
    app: { get: () => ({ enabled: true, available: true, runManagedAction }) },
  };
  let index = -1;
  const next = async (error) => {
    index += 1;
    if (error) throw error;
    if (index < handlers.length) await handlers[index](req, res, next);
  };
  await next();
  return { res, runManagedAction };
}

describe("POST /docker/containers/:id/:action", () => {
  beforeEach(() => getServer.mockClear());

  it("refuses start, stop and restart to docker.manage without server.control", async () => {
    for (const action of ["start", "stop", "restart"]) {
      const { res, runManagedAction } = await act("docker_only", action);
      expect(res.status, action).toHaveBeenCalledWith(403);
      expect(runManagedAction).not.toHaveBeenCalled();
    }
    expect(getServer).not.toHaveBeenCalled();
  });

  // Adversary pass: server.control alone is not a way round docker.manage.
  it("refuses server.control without docker.manage", async () => {
    const { res } = await act("control_only", "restart");
    expect(res.status).toHaveBeenCalledWith(403);
    expect(getServer).not.toHaveBeenCalled();
  });

  it("goes on to the server profile check with both", async () => {
    const { res } = await act("docker_and_control", "restart");
    expect(getServer).toHaveBeenCalledWith(1);
    // No profile in this test: the route's own 404, past both gates.
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

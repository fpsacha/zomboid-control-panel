import { beforeEach, describe, expect, it, vi } from "vitest";

// 2026-09-05, scheduler-time-audit: scheduleTask() now returns
// { scheduled: true, dstWarning } instead of a bare `true` on success (still
// `false` on failure, unchanged) so a sub-hourly schedule in a DST-observing
// timezone can be surfaced to the operator -- "nothing silent" per the
// card. These tests prove the two routes that call scheduleTask() (create
// and update) forward that field into their JSON response, and that a null
// warning still comes through as null (not dropped, not "undefined").

const ROLES = {
  automation_only: {
    name: "automation_only",
    capabilities: ["automation.manage", "server.control"],
  },
};

vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn(),
  createScheduledTask: vi.fn(),
  updateScheduledTask: vi.fn(),
  deleteScheduledTask: vi.fn(),
  getServer: vi.fn(),
  getActiveServer: vi.fn().mockResolvedValue(null),
  getRoleByName: vi.fn((name) => Promise.resolve(ROLES[name] || null)),
}));

const { createScheduledTask, updateScheduledTask, getScheduledTasks } =
  await import("../database/init.js");
const { default: router } = await import("../routes/scheduler.js");

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack[0].handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function baseReq(scheduleTask, overrides = {}) {
  return {
    user: { role: "automation_only" },
    app: { get: () => ({ scheduleTask, cancelTask: vi.fn() }) },
    ...overrides,
  };
}

beforeEach(() => {
  createScheduledTask.mockReset();
  updateScheduledTask.mockReset();
  getScheduledTasks.mockReset();
});

describe("POST /api/scheduler/tasks -- forwards scheduleTask()'s dstWarning", () => {
  it("includes the warning text when scheduleTask() returns one", async () => {
    createScheduledTask.mockResolvedValue({ id: 42 });
    const scheduleTask = vi.fn().mockReturnValue({
      scheduled: true,
      dstWarning: "fires every 15 minutes, DST fall-back will skip one",
    });
    const response = createResponse();

    await getHandler("/tasks", "post")(
      baseReq(scheduleTask, {
        body: { name: "Every 15", cronExpression: "*/15 * * * *", command: "restart" },
      }),
      response,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        dstWarning: "fires every 15 minutes, DST fall-back will skip one",
      }),
    );
  });

  it("reports dstWarning: null (not undefined, not omitted) when scheduleTask() has nothing to warn about", async () => {
    createScheduledTask.mockResolvedValue({ id: 43 });
    const scheduleTask = vi.fn().mockReturnValue({ scheduled: true, dstWarning: null });
    const response = createResponse();

    await getHandler("/tasks", "post")(
      baseReq(scheduleTask, {
        body: { name: "Hourly", cronExpression: "30 * * * *", command: "restart" },
      }),
      response,
    );

    const [payload] = response.json.mock.calls[0];
    expect(payload.success).toBe(true);
    expect(payload.dstWarning).toBeNull();
  });
});

describe("PUT /api/scheduler/tasks/:id -- forwards scheduleTask()'s dstWarning", () => {
  it("includes the warning text when scheduleTask() returns one", async () => {
    const existingTask = {
      id: 7,
      name: "Every 20",
      cron_expression: "*/20 * * * *",
      command: "restart",
      server_id: "server-a",
      enabled: 1,
    };
    getScheduledTasks.mockResolvedValue([existingTask]);
    updateScheduledTask.mockResolvedValue(existingTask);
    const scheduleTask = vi.fn().mockReturnValue({
      scheduled: true,
      dstWarning: "fires every 20 minutes, DST fall-back will skip one",
    });
    const response = createResponse();

    await getHandler("/tasks/:id", "put")(
      baseReq(scheduleTask, {
        params: { id: "7" },
        body: { name: "Every 20", cronExpression: "*/20 * * * *", command: "restart" },
      }),
      response,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        dstWarning: "fires every 20 minutes, DST fall-back will skip one",
      }),
    );
  });

  it("reports dstWarning: null when the task is disabled by this update (scheduleTask() is never called)", async () => {
    const existingTask = {
      id: 8,
      name: "Any",
      cron_expression: "0 3 * * *",
      command: "restart",
      server_id: "server-a",
      enabled: 1,
    };
    getScheduledTasks.mockResolvedValue([existingTask]);
    updateScheduledTask.mockResolvedValue({ ...existingTask, enabled: 0 });
    const scheduleTask = vi.fn();
    const response = createResponse();

    await getHandler("/tasks/:id", "put")(
      baseReq(scheduleTask, {
        params: { id: "8" },
        body: { enabled: false },
      }),
      response,
    );

    expect(scheduleTask).not.toHaveBeenCalled();
    const [payload] = response.json.mock.calls[0];
    expect(payload.success).toBe(true);
    expect(payload.dstWarning).toBeNull();
  });
});

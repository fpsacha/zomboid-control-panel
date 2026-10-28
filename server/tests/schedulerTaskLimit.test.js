import { beforeAll, describe, expect, it, vi } from "vitest";

// SECURITY: POST /scheduler/tasks never counted the stored tasks; each one
// is a cron job kept in db.json and re-armed at every start, so a role
// holding automation.manage could add them by the thousand (RCON commands
// or broadcasts every 5 minutes, a database rewritten whole on every save).
// createScheduledTask() now refuses past MAX_SCHEDULED_TASKS, and the route
// answers that with a coded 400.
//
// Real, unmocked database/init.js (a per-file data folder, see
// vitest.perFileDataDir.setup.mjs).

const db = await import("../database/init.js");
const { ErrorCode } = await import("../utils/errorCodes.js");
const { default: router } = await import("../routes/scheduler.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function postTask(name) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/tasks" && entry.route.methods.post,
  );
  const res = createResponse();
  const scheduler = { scheduleTask: vi.fn(() => ({ dstWarning: null })) };
  await layer.route.stack[0].handle(
    {
      user: { id: "u-admin", username: "admin", role: "admin" },
      body: { name, cronExpression: "0 4 * * *", command: "players" },
      app: { get: (key) => (key === "scheduler" ? scheduler : null) },
    },
    res,
  );
  return res;
}

const statusOf = (res) => res.status.mock.calls.at(-1)?.[0] ?? 200;

async function taskCount() {
  return (await db.getScheduledTasks()).length;
}

beforeAll(async () => {
  await db.initDatabase();
});

describe("scheduled task limit", () => {
  it("POST /tasks refuses a task past the limit with a coded 400", async () => {
    expect(db.MAX_SCHEDULED_TASKS).toBe(500);
    const missing = db.MAX_SCHEDULED_TASKS - (await taskCount());
    for (let i = 0; i < missing; i++) {
      await db.createScheduledTask(`Task ${i}`, "0 4 * * *", "players", null);
    }

    const res = await postTask("One too many");
    expect(statusOf(res)).toBe(400);
    expect(res.json.mock.calls[0][0]).toMatchObject({
      code: ErrorCode.SCHEDULER_TOO_MANY_TASKS,
      params: { max: 500 },
    });
    expect(await taskCount()).toBe(db.MAX_SCHEDULED_TASKS);
  });

  it("takes one again once a task is deleted", async () => {
    const [first] = await db.getScheduledTasks();
    await db.deleteScheduledTask(first.id);
    const res = await postTask("Fits again");
    expect(statusOf(res)).toBe(200);
    expect(await taskCount()).toBe(db.MAX_SCHEDULED_TASKS);
  });

  // Adversary pass: requests that arrive together, each seeing room for
  // one more before any of them is stored.
  it("lets only one of several simultaneous creations take the last place", async () => {
    const [first] = await db.getScheduledTasks();
    await db.deleteScheduledTask(first.id);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => db.createScheduledTask(`Race ${i}`, "0 4 * * *", "players", null)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect(r.reason.code).toBe("SCHEDULER_TOO_MANY_TASKS");
    }
    expect(await taskCount()).toBe(db.MAX_SCHEDULED_TASKS);
  });
});

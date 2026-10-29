import { beforeEach, describe, expect, it, vi } from "vitest";

// SECURITY: the restart countdown text is broadcast to every player, as the
// server, on every restart with a countdown, whoever starts it. PUT
// /scheduler/restart-warning took any text with automation.manage alone,
// while every other server broadcast (POST /server/message, servermsg
// tasks) takes server.world_events. Text of one's own now does too; keeping
// the stored text or picking a language's preset does not.

const ROLES = {
  automation_only: { name: "automation_only", capabilities: ["automation.manage"] },
  automation_and_world_events: {
    name: "automation_and_world_events",
    capabilities: ["automation.manage", "server.world_events"],
  },
};

vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn(),
  createScheduledTask: vi.fn(),
  updateScheduledTask: vi.fn(),
  getServer: vi.fn(),
  getActiveServer: vi.fn().mockResolvedValue(null),
  getRoleByName: vi.fn((name) => Promise.resolve(ROLES[name] || null)),
}));

const { default: router } = await import("../routes/scheduler.js");
const { RESTART_WARNING_PRESETS } = await import("../utils/restartWarning.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

const CUSTOM = "Server moving -- rejoin at the new address in {count} {unit}";
let setRestartWarning;
let stored;

async function save(role, body) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/restart-warning" && entry.route.methods.put,
  );
  const res = createResponse();
  await layer.route.stack[0].handle(
    {
      user: { role },
      body,
      app: { get: () => ({ restartWarning: stored, setRestartWarning }) },
    },
    res,
  );
  return res;
}

const statusOf = (res) => res.status.mock.calls.at(-1)?.[0] ?? 200;

beforeEach(() => {
  setRestartWarning = vi.fn(async (value) => value);
  stored = { locale: "en", template: RESTART_WARNING_PRESETS.en.template };
});

describe("PUT /scheduler/restart-warning", () => {
  it("refuses text of one's own without server.world_events", async () => {
    const res = await save("automation_only", { locale: "en", template: CUSTOM });
    expect(statusOf(res)).toBe(403);
    expect(setRestartWarning).not.toHaveBeenCalled();
  });

  it("saves it with server.world_events", async () => {
    const res = await save("automation_and_world_events", { locale: "en", template: CUSTOM });
    expect(statusOf(res)).toBe(200);
    expect(setRestartWarning).toHaveBeenCalledWith({ locale: "en", template: CUSTOM });
  });

  it("lets automation.manage alone pick a language's preset", async () => {
    const res = await save("automation_only", { locale: "fr", template: RESTART_WARNING_PRESETS.fr.template });
    expect(statusOf(res)).toBe(200);
    expect(setRestartWarning).toHaveBeenCalled();
  });

  it("lets automation.manage alone change the language and keep the stored text", async () => {
    stored = { locale: "en", template: CUSTOM };
    const res = await save("automation_only", { locale: "de", template: `  ${CUSTOM} ` });
    expect(statusOf(res)).toBe(200);
    expect(setRestartWarning).toHaveBeenCalled();
  });

  // Adversary pass: text that only looks like the preset or the stored text.
  it("refuses a preset or the stored text with anything added, invisible characters included", async () => {
    stored = { locale: "en", template: CUSTOM };
    for (const template of [
      `${RESTART_WARNING_PRESETS.en.template} visit evil.example`,
      RESTART_WARNING_PRESETS.en.template + String.fromCharCode(0x200b),
      `${CUSTOM} now`,
      [RESTART_WARNING_PRESETS.en.template],
    ]) {
      const res = await save("automation_only", { locale: "en", template });
      expect(statusOf(res), JSON.stringify(template)).toBe(403);
    }
    expect(setRestartWarning).not.toHaveBeenCalled();
  });
});

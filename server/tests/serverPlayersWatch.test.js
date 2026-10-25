import { describe, expect, it, vi } from "vitest";
import {
  MISSES_BEFORE_GONE,
  ServerPlayersWatch,
  readServerPlayers,
} from "../services/serverPlayersWatch.js";

// Play time and sessions on the servers other than the active one, which
// PanelBridge doesn't reach: who is on, a minute apart, over each server's
// own RCON, turned into connects and disconnects under that server.

function setup({ rows } = {}) {
  const state = {
    servers: [{ id: "active", name: "Main" }, { id: "s2", name: "Second" }, { id: "far", isRemote: true }],
    activeId: "active",
    answers: [],
    rows,
  };
  const deps = {
    getServers: vi.fn(async () => state.servers),
    getActiveServer: vi.fn(async () => state.servers.find((s) => s.id === state.activeId)),
    recordSession: vi.fn(async () => {}),
    readPlayers: vi.fn(async (server) => state.answers.shift() ?? { success: false, server }),
    ...(rows ? { readStatuses: vi.fn(async () => state.rows) } : {}),
  };
  const watch = new ServerPlayersWatch(deps);
  const look = async (answer) => {
    state.answers.push(answer);
    await watch.tick();
  };
  return { watch, deps, state, look };
}

describe("ServerPlayersWatch", () => {
  it("continues the sessions it finds at a first look, then records joins and leaves", async () => {
    const { deps, look } = setup();
    await look({ success: true, names: ["Ana"] });
    expect(deps.recordSession).toHaveBeenCalledWith("Ana", "connect", "s2", { keepOpenSession: true });

    deps.recordSession.mockClear();
    await look({ success: true, names: ["Ana", "Bob"] });
    expect(deps.recordSession).toHaveBeenCalledWith("Bob", "connect", "s2");
    expect(deps.recordSession).toHaveBeenCalledTimes(1);

    deps.recordSession.mockClear();
    await look({ success: true, names: ["Bob"] });
    expect(deps.recordSession).toHaveBeenCalledWith("Ana", "disconnect", "s2");
    expect(deps.recordSession).toHaveBeenCalledTimes(1);
  });

  it("asks only the local servers other than the active one", async () => {
    const { deps, look } = setup();
    await look({ success: true, names: [] });
    expect(deps.readPlayers).toHaveBeenCalledTimes(1);
    expect(deps.readPlayers.mock.calls[0][0].id).toBe("s2");
  });

  it(`ends everyone's session only after ${MISSES_BEFORE_GONE} unanswered looks in a row`, async () => {
    const { deps, look } = setup();
    await look({ success: true, names: ["Ana"] });
    deps.recordSession.mockClear();
    for (let i = 0; i < MISSES_BEFORE_GONE - 1; i += 1) await look({ success: false });
    expect(deps.recordSession).not.toHaveBeenCalled();

    await look({ success: false });
    expect(deps.recordSession).toHaveBeenCalledWith("Ana", "disconnect", "s2");
  });

  // Two servers on one RCON port, only one of them running: the stopped
  // one's RCON port answers with the running one's players.
  it("counts nobody on a server the scan confirms stopped, whatever its RCON port answers", async () => {
    const { deps, state, look } = setup({ rows: [{ id: "s2", running: true, stateUnknown: false }] });
    await look({ success: true, names: ["Ana"] });
    expect(deps.recordSession).toHaveBeenCalledWith("Ana", "connect", "s2", { keepOpenSession: true });

    deps.recordSession.mockClear();
    state.rows = [{ id: "s2", running: false, stateUnknown: false }];
    await look({ success: true, names: ["Ana", "Bob"] });
    expect(deps.recordSession).toHaveBeenCalledWith("Ana", "disconnect", "s2");
    expect(deps.recordSession).not.toHaveBeenCalledWith("Bob", "connect", "s2");
  });

  it("leaves a server that became the active one to PanelBridge, and starts over when it isn't any more", async () => {
    const { deps, state, look } = setup();
    await look({ success: true, names: ["Ana"] });
    state.activeId = "s2";
    deps.recordSession.mockClear();
    await look({ success: true, names: [] });
    expect(deps.recordSession).not.toHaveBeenCalled();

    state.activeId = "active";
    await look({ success: true, names: ["Ana"] });
    expect(deps.recordSession).toHaveBeenCalledWith("Ana", "connect", "s2", { keepOpenSession: true });
  });
});

describe("readServerPlayers()", () => {
  it("asks the server's own RCON for the names, and answers nothing without RCON settings", async () => {
    const probe = vi.fn(async () => ({ success: true, players: 1, playerNames: ["Ana"] }));
    const answer = await readServerPlayers(
      { rconHost: " 127.0.0.1 ", rconPort: 27016, rconPassword: "pw" },
      { probe },
    );
    expect(answer).toEqual({ success: true, names: ["Ana"] });
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ host: "127.0.0.1", port: 27016, countPlayers: true }));

    expect(await readServerPlayers({ rconHost: "", rconPort: 27016 }, { probe })).toEqual({ success: false });
  });
});

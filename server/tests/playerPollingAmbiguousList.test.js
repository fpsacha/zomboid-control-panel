import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePlayersReply, testRconConnection } from "../services/rcon.js";

// SECURITY (audit R1-24): PlayersCommand writes "-" + name + "\n" for every
// name, raw. An account name may hold a line break and a co-op name is not
// checked at all, so "x\n-Alice" made the reply read as two players, x and
// Alice: Alice showed as online and the player polling sent Discord "Alice
// joined" / "Alice left" notices. The header's own count tells such a list
// apart; its names are shown, never announced.

const { app, io, startPlayerPolling, stopPlayerPolling } = await import("../index.js");
const { default: panelBridge } = await import("../services/panelBridge.js");

const reply = (count, names) =>
  `Players connected (${count}): \n${names.map((name) => `-${name}\n`).join("")}`;

describe("parsePlayersReply", () => {
  it("is not ambiguous when the lines add up to the header's count", () => {
    expect(parsePlayersReply(reply(2, ["Alice", "Bob"]))).toEqual({
      players: [
        { name: "Alice", online: true },
        { name: "Bob", online: true },
      ],
      ambiguous: false,
      count: 2,
    });
    expect(parsePlayersReply("Players connected (0):\n")).toMatchObject({ ambiguous: false, count: 0 });
  });

  it("is ambiguous when a name with a line break adds lines", () => {
    // One connection named "x\n-Alice": the game counts one name.
    const parsed = parsePlayersReply(reply(2, ["Bob", "x\n-Alice"]));
    expect(parsed.players.map((p) => p.name)).toEqual(["Bob", "x", "Alice"]);
    expect(parsed).toMatchObject({ ambiguous: true, count: 2 });
  });

  // Adversary pass: a reply with no header at all, or one that claims more.
  it("is ambiguous without a header, or with a header that does not match", () => {
    expect(parsePlayersReply("-Alice\n-Bob\n").ambiguous).toBe(true);
    expect(parsePlayersReply(reply(3, ["Alice", "Bob"])).ambiguous).toBe(true);
  });
});

describe("testRconConnection countPlayers (the other servers' play-time watch)", () => {
  it("gives the game's count and no names for an ambiguous list", async () => {
    const net = await import("node:net");
    const { SourceRconClient } = await import("../utils/sourceRcon.js");
    const server = net.createServer(() => {});
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    vi.spyOn(SourceRconClient.prototype, "authenticate").mockResolvedValue(true);
    vi.spyOn(SourceRconClient.prototype, "execute").mockResolvedValue(reply(1, ["x\n-Alice"]));
    try {
      const result = await testRconConnection({ host: "127.0.0.1", port, password: "pw", countPlayers: true });
      expect(result).toMatchObject({ success: true, players: 1 });
      expect(result.playerNames).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("player polling (index.js)", () => {
  const rcon = app.get("rconService");
  const bot = app.get("discordBot");
  let replies;
  let emitted;
  let notices;

  beforeEach(() => {
    vi.useFakeTimers();
    replies = [];
    emitted = [];
    notices = [];
    rcon.connected = true;
    vi.spyOn(rcon, "execute").mockImplementation(async () => ({ success: true, response: replies.shift() }));
    vi.spyOn(bot, "sendEventNotification").mockImplementation(async (type, data) => {
      notices.push(`${type}:${data.player}`);
      return true;
    });
    vi.spyOn(io, "to").mockReturnValue({ emit: (event, payload) => emitted.push([event, payload]) });
    panelBridge.modStatus = { ...(panelBridge.modStatus || {}), alive: false };
    startPlayerPolling();
  });

  afterEach(() => {
    stopPlayerPolling();
    rcon.connected = false;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function poll(text) {
    replies.push(text);
    await vi.advanceTimersByTimeAsync(5000);
  }

  it("never announces the pieces of a name as joins or leaves", async () => {
    await poll(reply(1, ["Bob"])); // baseline
    await poll(reply(2, ["Bob", "x\n-Alice"]));
    await poll(reply(2, ["Bob", "x\n-Alice"]));
    await poll(reply(1, ["Bob"]));
    expect(notices).toEqual([]);

    // Shown as it is once, then the real list again.
    const updates = emitted.filter(([event]) => event === "players:update").map(([, list]) => list.map((p) => p.name));
    expect(updates).toEqual([["Bob"], ["Bob", "x", "Alice"], ["Bob"]]);
  });

  it("still announces a real join and leave, compared with the last unambiguous list", async () => {
    await poll(reply(1, ["Bob"]));
    await poll(reply(3, ["Bob", "Carol", "x\n-Alice"]));
    expect(notices).toEqual([]);
    await poll(reply(1, ["Carol"]));
    expect(notices.sort()).toEqual(["playerJoin:Carol", "playerLeave:Bob"]);
  });
});

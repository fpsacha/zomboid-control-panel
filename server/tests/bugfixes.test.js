import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createLocalResetResponse,
  isLocalPanelRequest,
} from "../routes/auth.js";
import {
  compareDefinitionSets,
  filterOwnedClientModIds,
  getModDetailsFromWorkshop,
  groupIntoPairs,
  scoreWorkshopDependencyMatch,
} from "../routes/mods.js";
import {
  ModChecker,
  minutesToCheckIntervalMs,
  normalizeStoredCheckInterval,
  parseLegacyBoolean,
  parseLegacyMinutes,
} from "../services/modChecker.js";
import { BackupService } from "../services/backupService.js";

// Test the restart timeout pattern fix
// Verifies that the Promise.race + clearTimeout pattern doesn't leak unhandled rejections

describe("Restart timeout pattern", () => {
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it("should not leave dangling rejections when operation wins the race", async () => {
    // This is the FIXED pattern: setTimeout + clearTimeout
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Timeout")), 5000);
    });

    const operationPromise = Promise.resolve("done");

    const result = await Promise.race([operationPromise, timeoutPromise]);
    clearTimeout(timeoutId); // Prevents the timeout from firing

    expect(result).toBe("done");
    // Wait a tick to ensure no unhandled rejection
    await sleep(10);
  });

  it("should reject when operation takes too long", async () => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Timeout")), 10);
    });

    const slowOperation = new Promise((resolve) => setTimeout(resolve, 5000));

    try {
      await Promise.race([slowOperation, timeoutPromise]);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e.message).toBe("Timeout");
    }
    clearTimeout(timeoutId);
  });

  it("sendWarning helper should catch both success and timeout", async () => {
    const sendWarning = async (msg, shouldSucceed = true) => {
      try {
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("RCON timeout")), 50);
        });
        const operation = shouldSucceed
          ? Promise.resolve("sent")
          : new Promise((resolve) => setTimeout(resolve, 5000));
        await Promise.race([operation, timeoutPromise]);
        clearTimeout(timeoutId);
        return "ok";
      } catch (e) {
        return e.message;
      }
    };

    // Success case
    expect(await sendWarning("test", true)).toBe("ok");

    // Timeout case
    expect(await sendWarning("test", false)).toBe("RCON timeout");
  });
});

// Test modChecker interval error handling
describe("modChecker interval error handling", () => {
  it("should catch errors in async interval callback", async () => {
    let errorCaught = false;
    let intervalCleared = false;
    let callCount = 0;

    const intervalCallback = async () => {
      try {
        callCount++;
        throw new Error("RCON connection failed");
      } catch (error) {
        errorCaught = true;
        intervalCleared = true;
      }
    };

    await intervalCallback();

    expect(errorCaught).toBe(true);
    expect(intervalCleared).toBe(true);
    expect(callCount).toBe(1);
  });
});

describe("mod checker interval normalization", () => {
  it("stores Settings values as whole minutes instead of treating them as milliseconds", () => {
    expect(minutesToCheckIntervalMs("30")).toBe(1_800_000);
    expect(normalizeStoredCheckInterval("30")).toEqual({
      intervalMs: 1_800_000,
      minutes: 30,
      legacy: false,
    });
  });

  it("migrates legacy whole-minute millisecond values", () => {
    expect(normalizeStoredCheckInterval(300_000)).toEqual({
      intervalMs: 300_000,
      minutes: 5,
      legacy: true,
    });
  });

  it("rejects fractional, out-of-range, and malformed values", () => {
    expect(minutesToCheckIntervalMs("1.5")).toBeNull();
    expect(minutesToCheckIntervalMs(0)).toBeNull();
    expect(minutesToCheckIntervalMs(121)).toBeNull();
    expect(normalizeStoredCheckInterval("not-a-number")).toBeNull();
  });
});

describe("local password reset hardening", () => {
  it("does not include reset token values in local reset responses", () => {
    const response = createLocalResetResponse(
      "Recovery token created at data/reset-token.txt. Paste it below to continue.",
    );

    expect(response).toEqual({
      success: true,
      resetAvailable: true,
      message:
        "Recovery token created at data/reset-token.txt. Paste it below to continue.",
    });
    expect(response).not.toHaveProperty("token");
  });

  it("does not trust proxy-derived IP fields for local-only reset detection", () => {
    const spoofedRequest = {
      ip: "127.0.0.1",
      ips: ["127.0.0.1"],
      socket: { remoteAddress: "8.8.8.8" },
      connection: { remoteAddress: "8.8.8.8" },
    };

    expect(isLocalPanelRequest(spoofedRequest)).toBe(false);
  });

  it("accepts real loopback socket addresses for local reset detection", () => {
    const localRequest = {
      socket: { remoteAddress: "::ffff:127.0.0.1" },
      connection: { remoteAddress: "::ffff:127.0.0.1" },
    };

    expect(isLocalPanelRequest(localRequest)).toBe(true);
  });
});

describe("mod update auto-restart dedupe", () => {
  it("marks offline mod updates as handled instead of retrying every poll", async () => {
    const checker = new ModChecker();
    checker.scheduler = { rconService: { connected: false } };
    checker.serverManager = {
      checkServerRunning: vi.fn().mockResolvedValue(false),
    };

    const result = await checker.triggerModRestart([
      { workshopId: "2503622437", name: "Skill Recovery Journal" },
    ]);

    expect(result).toMatchObject({
      success: true,
      skipped: true,
      markProcessed: true,
      reason: "server_offline",
    });
    expect(checker.pendingRestart).toBe(false);
  });

  it("keeps retrying when the server is running but RCON is disconnected", async () => {
    const checker = new ModChecker();
    checker.scheduler = { rconService: { connected: false } };
    checker.serverManager = {
      checkServerRunning: vi.fn().mockResolvedValue(true),
    };

    const result = await checker.triggerModRestart([
      { workshopId: "3437629766", name: "CleanUI [B42.12]" },
    ]);

    expect(result).toMatchObject({
      success: false,
      retry: true,
      reason: "rcon_disconnected",
    });
    expect(checker.pendingRestart).toBe(false);
  });
});

describe("mod removal ownership filtering", () => {
  it("only accepts client-provided mod IDs verified against the workshop item", () => {
    const filtered = filterOwnedClientModIds(
      [
        "OwnedMod",
        "UnrelatedMod",
        "1234567890",
        "OwnedMod",
        "Bad;Entry",
        "OtherOwned",
      ],
      ["OwnedMod", "OtherOwned"],
    );

    expect(filtered).toEqual(["OwnedMod", "OtherOwned"]);
  });

  it("rejects all client-provided IDs when the server cannot verify ownership", () => {
    expect(filterOwnedClientModIds(["LooksLegit"], [])).toEqual([]);
  });
});

describe("mod name resolution from disk", () => {
  it("prefers the newest versioned mod.info over legacy manifests", async () => {
    const tempRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "zcp-mod-name-"),
    );
    try {
      const workshopId = "3490188370";
      const workshopRoot = path.join(tempRoot, "steamapps", "workshop");
      const modRoot = path.join(
        workshopRoot,
        "content",
        "108600",
        workshopId,
        "mods",
        "Project_Cook",
      );

      await fs.promises.mkdir(path.join(modRoot, "42"), { recursive: true });
      await fs.promises.mkdir(path.join(modRoot, "42.15"), { recursive: true });
      await fs.promises.writeFile(
        path.join(modRoot, "42", "mod.info"),
        "name=Project Cook [Legacy]\nid=Project_Cook\n",
      );
      await fs.promises.writeFile(
        path.join(modRoot, "42.15", "mod.info"),
        "name=Project Cook\nid=Project_Cook\n",
      );

      const checker = new ModChecker();
      checker.workshopAcfPath = path.join(
        workshopRoot,
        "appworkshop_108600.acf",
      );

      expect(checker.resolveModNameFromDisk(workshopId, true)).toBe(
        "Project Cook",
      );
    } finally {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses newest versioned mod.info metadata for current-config details", async () => {
    const tempRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "zcp-mod-details-"),
    );
    try {
      const workshopId = "3490188370";
      const modRoot = path.join(
        tempRoot,
        "steamapps",
        "workshop",
        "content",
        "108600",
        workshopId,
        "mods",
        "Project_Cook",
      );

      await fs.promises.mkdir(path.join(modRoot, "42"), { recursive: true });
      await fs.promises.mkdir(path.join(modRoot, "42.15"), { recursive: true });
      await fs.promises.writeFile(
        path.join(modRoot, "42", "mod.info"),
        "name=Project Cook [Legacy]\nid=Project_Cook\n",
      );
      await fs.promises.writeFile(
        path.join(modRoot, "42.15", "mod.info"),
        "name=Project Cook\nid=Project_Cook\n",
      );

      expect(getModDetailsFromWorkshop(workshopId, tempRoot)).toEqual([
        expect.objectContaining({ id: "Project_Cook", name: "Project Cook" }),
      ]);
    } finally {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("workshop dependency search ranking", () => {
  it("ranks exact internal mod ID matches above variants that only contain the query", () => {
    const exact = scoreWorkshopDependencyMatch(
      "TombBody",
      "TombBody",
      "Tomb's Player Body",
    );
    const texture = scoreWorkshopDependencyMatch(
      "TombBody",
      "TombBodyTex",
      "Tomb's Player Body - Textures",
    );
    const custom = scoreWorkshopDependencyMatch(
      "TombBody",
      "TombBodyCustom",
      "Tomb's Player Body - Customisation",
    );

    expect(exact.matchType).toBe("exact-id");
    expect(exact.score).toBeGreaterThan(texture.score);
    expect(exact.score).toBeGreaterThan(custom.score);
  });
});

describe("conflict pair grouping", () => {
  function conflict(mods, severity = "high") {
    return {
      file: "media/lua/shared/Foo.lua",
      category: "lua-shared",
      categoryLabel: "Lua",
      severity,
      mods: mods.map((modId) => ({ modId, modName: modId, workshopId: "1" })),
    };
  }

  it("never pairs a mod with itself when it ships the same path twice", () => {
    // A mod shipping both media/ and 42/media/ used to appear twice in
    // conflict.mods, producing an "A vs A" pair.
    const pairs = groupIntoPairs([conflict(["ModA", "ModA", "ModB"])]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].modA.modId).toBe("ModA");
    expect(pairs[0].modB.modId).toBe("ModB");
    expect(pairs[0].files).toHaveLength(1);
    expect(pairs[0].highCount).toBe(1);
  });

  it("counts each real pair once per conflicting file", () => {
    const pairs = groupIntoPairs([
      conflict(["ModA", "ModB"]),
      conflict(["ModA", "ModB"], "medium"),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].highCount).toBe(1);
    expect(pairs[0].mediumCount).toBe(1);
  });
});

describe("shared definition comparison", () => {
  const entries = [
    { modId: "ModA", absPath: "/a" },
    { modId: "ModB", absPath: "/b" },
  ];

  it("treats a file that parsed to zero definitions as additive, not conflicting", () => {
    const result = compareDefinitionSets(entries, (p) =>
      p === "/a" ? new Set() : new Set(["Base.item.Axe"]),
    );

    expect(result.disjoint).toBe(true);
    expect(result.inconclusive).toBe(false);
  });

  it("fails closed when a file could not be parsed at all", () => {
    const result = compareDefinitionSets(entries, (p) =>
      p === "/a" ? null : new Set(["Base.item.Axe"]),
    );

    expect(result.disjoint).toBe(false);
    expect(result.inconclusive).toBe(true);
  });

  it("reports the names that actually collide", () => {
    const result = compareDefinitionSets(entries, () =>
      new Set(["Base.item.Axe", "Base.item.Bat"]),
    );

    expect(result.disjoint).toBe(false);
    expect(result.overlapping.sort()).toEqual([
      "Base.item.Axe",
      "Base.item.Bat",
    ]);
  });

  it("ignores collisions between two copies belonging to the same mod", () => {
    const sameMod = [
      { modId: "ModA", absPath: "/a" },
      { modId: "ModA", absPath: "/a42" },
    ];
    const result = compareDefinitionSets(sameMod, () =>
      new Set(["Base.item.Axe"]),
    );

    expect(result.overlapping).toEqual([]);
    expect(result.inconclusive).toBe(true);
  });
});

describe("legacy mod auto-restart settings migration", () => {
  it("migrates a real boolean, as written by Settings", () => {
    expect(parseLegacyBoolean(true)).toBe(true);
    expect(parseLegacyBoolean(false)).toBe(false);
  });

  it("migrates string booleans", () => {
    expect(parseLegacyBoolean("true")).toBe(true);
    expect(parseLegacyBoolean(" On ")).toBe(true);
    expect(parseLegacyBoolean("0")).toBe(false);
  });

  it("reports an unset or unrecognised value instead of guessing", () => {
    expect(parseLegacyBoolean(null)).toBeNull();
    expect(parseLegacyBoolean("maybe")).toBeNull();
  });

  it("migrates the warning delay stored as a string", () => {
    expect(parseLegacyMinutes("5")).toBe(5);
    expect(parseLegacyMinutes(0)).toBe(0);
  });

  it("does not turn an unset delay into a zero-minute countdown", () => {
    expect(parseLegacyMinutes(null)).toBeNull();
    expect(parseLegacyMinutes("")).toBeNull();
    expect(parseLegacyMinutes("abc")).toBeNull();
  });
});

describe("online player count when RCON is unavailable", () => {
  const withRcon = (rconService) => {
    const checker = new ModChecker();
    checker.scheduler = rconService ? { rconService } : null;
    return checker;
  };

  it("counts players when RCON answers", async () => {
    const checker = withRcon({
      getPlayers: async () => ({ success: true, players: ["a", "b"] }),
    });
    await expect(checker.getOnlinePlayerCount()).resolves.toBe(2);
  });

  it("reports unknown rather than empty when RCON throws", async () => {
    const checker = withRcon({
      getPlayers: async () => {
        throw new Error("connection reset");
      },
    });
    await expect(checker.getOnlinePlayerCount()).resolves.toBeNull();
  });

  it("reports unknown rather than empty when RCON fails softly", async () => {
    const checker = withRcon({
      getPlayers: async () => ({ success: false }),
    });
    await expect(checker.getOnlinePlayerCount()).resolves.toBeNull();
  });

  it("reports unknown when there is no RCON service at all", async () => {
    await expect(withRcon(null).getOnlinePlayerCount()).resolves.toBeNull();
  });
});

describe("backup restore guards against a running server", () => {
  it("refuses to restore while the server is running", async () => {
    const service = new BackupService();
    service.setServerManager({ checkServerRunning: async () => true });

    const result = await service.restoreBackup("world.zip", {
      createPreRestoreBackup: false,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/still running/i);
    expect(service.restoreInProgress).toBe(false);
  });

  it("refuses to restore when the running state cannot be confirmed", async () => {
    const service = new BackupService();
    service.setServerManager({
      checkServerRunning: async () => {
        throw new Error("ps failed");
      },
    });

    const result = await service.restoreBackup("world.zip");

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/could not confirm/i);
  });
});

describe("Discord chat relay scope", () => {
  const relay = async (data, scope = "public") => {
    const { DiscordBot } = await import("../services/discordBot.js");
    const bot = Object.create(DiscordBot.prototype);
    bot.chatRelayEnabled = true;
    bot.isRunning = true;
    bot.client = {};
    bot.chatRelayScope = scope;
    bot.chatRelayChannelId = "123456789012345678";
    const sent = [];
    bot._sendToChannel = async (_channel, content) => sent.push(content);
    await bot.handleGameChat(data);
    return sent;
  };

  it("forwards ordinary Say chat, which B42 uses for normal talking", async () => {
    const sent = await relay({
      author: "Bob",
      message: "hello",
      type: "general",
      sourceChatType: "Say",
    });
    expect(sent).toEqual(["**<Bob>** hello"]);
  });

  it("forwards General and Shout chat", async () => {
    expect(
      await relay({ author: "A", message: "hi", sourceChatType: "General" }),
    ).toHaveLength(1);
    expect(
      await relay({ author: "A", message: "hi", sourceChatType: "Shout" }),
    ).toHaveLength(1);
  });

  it("keeps private channels out of Discord", async () => {
    for (const sourceChatType of ["Admin chat", "Faction", "Safehouse", "Radio"]) {
      expect(
        await relay({ author: "A", message: "secret", sourceChatType }),
      ).toEqual([]);
    }
  });

  it("restricts to the General tab when the scope says so", async () => {
    expect(
      await relay({ author: "A", message: "hi", sourceChatType: "Say" }, "general"),
    ).toEqual([]);
    expect(
      await relay(
        { author: "A", message: "hi", sourceChatType: "General" },
        "general",
      ),
    ).toHaveLength(1);
  });

  it("does not echo messages that came from Discord", async () => {
    expect(
      await relay({
        author: "Bob",
        message: "[Discord] user: hi",
        sourceChatType: "General",
      }),
    ).toEqual([]);
  });
});

describe("Discord circuit breaker is per channel", () => {
  const makeBot = async (failingChannelId) => {
    const { DiscordBot } = await import("../services/discordBot.js");
    const bot = Object.create(DiscordBot.prototype);
    bot._channelBreakers = new Map();
    const sent = [];
    bot.client = {
      channels: {
        fetch: async (id) => {
          if (id === failingChannelId) throw new Error("Missing Access");
          return {
            isTextBased: () => true,
            send: async (msg) => sent.push(`${id}:${msg}`),
          };
        },
      },
    };
    return { bot, sent };
  };

  it("does not let a broken relay channel silence notifications", async () => {
    const { bot, sent } = await makeBot("111");

    // Three failures on the relay channel trip its breaker.
    for (let i = 0; i < 3; i++) {
      expect(await bot._sendToChannel("111", "chat")).toBe(false);
    }
    expect(bot._channelBreakers.get("111").openUntil).toBeGreaterThan(
      Date.now(),
    );

    // The healthy notification channel must still go through.
    expect(await bot._sendToChannel("222", "server started")).toBe(true);
    expect(sent).toEqual(["222:server started"]);
  });

  it("counts suppressed sends against the offending channel only", async () => {
    const { bot } = await makeBot("111");
    for (let i = 0; i < 4; i++) await bot._sendToChannel("111", "chat");
    await bot._sendToChannel("222", "ok");
    expect(bot._channelBreakers.get("111").suppressed).toBe(1);
    expect(bot._channelBreakers.get("222").failures).toBe(0);
  });
});

describe("LogTailer chunk boundaries", () => {
  const makeTailer = async () => {
    const { LogTailer } = await import("../services/logTailer.js");
    const tailer = new LogTailer();
    const seen = [];
    tailer.on("chatMessage", (m) => seen.push(m));
    return { tailer, seen };
  };

  const chatLine = (author, text) =>
    `[05-08-26 11:00:00.000][info] Got message:ChatMessage{chat=Say, author='${author}', text='${text}'}.`;

  it("keeps a message that is split across two reads", async () => {
    const { tailer, seen } = await makeTailer();
    const line = chatLine("Bob", "hello there") + "\n";
    const cut = 60;

    tailer.processChatLogData(line.slice(0, cut));
    expect(seen).toEqual([]); // incomplete, must be held back

    tailer.processChatLogData(line.slice(cut));
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toBe("hello there");
  });

  it("drops the held-back buffer when the log rotates", async () => {
    const { tailer, seen } = await makeTailer();
    tailer.processChatLogData(chatLine("Bob", "half"));
    expect(tailer.chatRemainder).not.toBe("");

    tailer.chatRemainder = "";
    tailer.processChatLogData(chatLine("Ann", "fresh") + "\n");
    expect(seen).toHaveLength(1);
    expect(seen[0].author).toBe("Ann");
  });

  it("does not buffer forever on a log with no newlines", async () => {
    const { tailer } = await makeTailer();
    for (let i = 0; i < 4; i++) tailer.processChatLogData("x".repeat(30 * 1024));
    expect(tailer.chatRemainder.length).toBeLessThanOrEqual(64 * 1024);
  });

  it("reads each byte exactly once", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const { LogTailer } = await import("../services/logTailer.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-tail-"));
    const file = path.join(dir, "chunk.txt");
    fs.writeFileSync(file, "abcdefghij");

    const tailer = new LogTailer();
    expect(await tailer.readChunk(file, 0, 5)).toBe("abcde");
    expect(await tailer.readChunk(file, 5, 10)).toBe("fghij");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads a log created after we started watching from the beginning", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const { LogTailer } = await import("../services/logTailer.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-tail-"));

    // Pre-existing file: skip its history so a panel restart doesn't replay.
    const old = path.join(dir, "old.txt");
    fs.writeFileSync(old, "history\n");
    const tailer = new LogTailer();
    tailer.watchStartedAt = Date.now() + 1000; // pretend we start later
    expect(tailer.startOffsetFor(old, true)).toBe(8);

    // A file born after we started watching is all new.
    tailer.watchStartedAt = 0;
    const fresh = path.join(dir, "fresh.txt");
    fs.writeFileSync(fresh, "new session\n");
    expect(tailer.startOffsetFor(fresh, true)).toBe(0);

    // A rotation always starts at zero.
    expect(tailer.startOffsetFor(old, false)).toBe(0);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("Discord chat relay queue", () => {
  const makeBot = async () => {
    const { DiscordBot } = await import("../services/discordBot.js");
    const bot = Object.create(DiscordBot.prototype);
    bot._chatRelayChain = Promise.resolve();
    bot._chatRelayPending = 0;
    bot._chatRelayDropped = 0;
    return bot;
  };

  it("relays messages in the order the game logged them", async () => {
    const bot = await makeBot();
    const seen = [];
    bot.handleGameChat = async (data) => {
      // Earlier messages resolve slower, which is what reorders parallel sends.
      await new Promise((r) => setTimeout(r, 10 - data.n));
      seen.push(data.n);
    };

    for (let n = 0; n < 5; n++) bot._queueGameChat({ n });
    await bot._chatRelayChain;

    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  it("drops messages instead of growing the queue without limit", async () => {
    const bot = await makeBot();
    let handled = 0;
    let release;
    const gate = new Promise((r) => (release = r));
    bot.handleGameChat = async () => {
      await gate;
      handled++;
    };

    for (let n = 0; n < 100; n++) bot._queueGameChat({ n });
    expect(bot._chatRelayPending).toBe(40);
    expect(bot._chatRelayDropped).toBe(60);

    release();
    await bot._chatRelayChain;
    expect(handled).toBe(40);
  });
});

describe("Discord event notifications", () => {
  const makeBot = async (webhookEvents) => {
    const { DiscordBot } = await import("../services/discordBot.js");
    const bot = Object.create(DiscordBot.prototype);
    bot.isRunning = true;
    bot.channelId = "123456789012345678";
    bot.webhookEvents = webhookEvents;
    bot._lastLifecycleState = null;
    const sent = [];
    bot.sendNotification = async (msg) => {
      sent.push(msg);
      return true;
    };
    return { bot, sent };
  };

  it("does not send an empty message when the template renders to nothing", async () => {
    const { bot, sent } = await makeBot({
      playerJoin: { enabled: true, template: "{player}" },
    });
    await bot.sendEventNotification("playerJoin", { player: "" });
    expect(sent).toEqual([]);
  });

  it("keeps a rendered notification inside Discord's message limit", async () => {
    const { bot, sent } = await makeBot({
      playerJoin: { enabled: true, template: "{player} joined" },
    });
    await bot.sendEventNotification("playerJoin", { player: "x".repeat(5000) });
    expect(sent).toHaveLength(1);
    expect(sent[0].length).toBeLessThanOrEqual(1900);
  });

  it("still commits lifecycle dedupe when a template renders empty", async () => {
    const { bot } = await makeBot({
      serverStart: { enabled: true, template: "{missing}" },
    });
    await bot.sendEventNotification("serverStart", { missing: "" });
    expect(bot._lastLifecycleState).toBe("running");
  });
});

describe("Discord slash command visibility", () => {
  const makeBot = async (roles) => {
    const { DiscordBot } = await import("../services/discordBot.js");
    const bot = Object.create(DiscordBot.prototype);
    bot.adminRoleId = roles.adminRoleId ?? null;
    bot.modRoleId = roles.modRoleId ?? null;
    bot.commandPermissions = { start: "admin", players: "moderator" };
    return bot;
  };

  const defaultPermsFor = (commands, name) =>
    commands.map((c) => c.toJSON()).find((c) => c.name === name)
      ?.default_member_permissions;

  it("locks admin commands to Discord admins when no admin role is set", async () => {
    const bot = await makeBot({});
    expect(defaultPermsFor(bot.getCommands(), "start")).toBeTruthy();
  });

  it("leaves admin commands visible once an admin role is configured", async () => {
    const bot = await makeBot({ adminRoleId: "111111111111111111" });
    expect(defaultPermsFor(bot.getCommands(), "start")).toBeFalsy();
  });

  it("leaves moderator commands visible once a mod role is configured", async () => {
    const bot = await makeBot({ modRoleId: "222222222222222222" });
    expect(defaultPermsFor(bot.getCommands(), "players")).toBeFalsy();
  });
});

describe("Discord /stop", () => {
  const makeBot = async (saveResult) => {
    const { DiscordBot } = await import("../services/discordBot.js");
    const bot = Object.create(DiscordBot.prototype);
    const calls = [];
    bot.serverManager = { checkServerRunning: async () => true };
    bot.rconService = {
      connected: true,
      save: async () => {
        calls.push("save");
        return saveResult;
      },
      quit: async () => {
        calls.push("quit");
        return { success: true };
      },
    };
    bot.sendNotification = async () => true;
    return { bot, calls };
  };

  const makeInteraction = () => {
    const replies = [];
    return {
      replies,
      deferReply: async () => {},
      editReply: async (m) => replies.push(m),
      user: { tag: "someone#0001" },
    };
  };

  it("does not quit when the save failed", async () => {
    const { bot, calls } = await makeBot({ success: false, error: "timeout" });
    const interaction = makeInteraction();
    await bot.handleStop(interaction);
    expect(calls).toEqual(["save"]);
    expect(interaction.replies[0]).toMatch(/Save failed/);
  });

  it("quits after a successful save", async () => {
    const { bot, calls } = await makeBot({ success: true });
    const interaction = makeInteraction();
    await bot.handleStop(interaction);
    expect(calls).toEqual(["save", "quit"]);
  });
});

describe("Discord chat relay escaping", () => {
  const makeBot = async () => {
    const { DiscordBot } = await import("../services/discordBot.js");
    const bot = Object.create(DiscordBot.prototype);
    bot.chatRelayEnabled = true;
    bot.isRunning = true;
    bot.client = {};
    bot.chatRelayScope = "public";
    bot.chatRelayChannelId = "123456789012345678";
    bot.channelId = null;
    const sent = [];
    bot._sendToChannel = async (_id, message) => {
      sent.push(message);
      return true;
    };
    return { bot, sent };
  };

  it("neutralises markdown from player chat", async () => {
    const { bot, sent } = await makeBot();
    await bot.handleGameChat({
      sourceChatType: "Say",
      author: "Bob",
      message: "[click me](https://evil.example) **bold**",
    });
    expect(sent[0]).toContain("\\[click me]");
    expect(sent[0]).toContain("\\*\\*bold\\*\\*");
  });

  it("neutralises markdown in a player name", async () => {
    const { bot, sent } = await makeBot();
    await bot.handleGameChat({
      sourceChatType: "Say",
      author: "**Admin**",
      message: "hi",
    });
    expect(sent[0]).toContain("\\*\\*Admin\\*\\*");
  });

  it("stays silent when the relay is switched off", async () => {
    const { bot, sent } = await makeBot();
    bot.chatRelayEnabled = false;
    await bot.handleGameChat({
      sourceChatType: "Say",
      author: "Bob",
      message: "hi",
    });
    expect(sent).toEqual([]);
  });

  it("keeps the restart countdown out of the relay channel", async () => {
    const { bot, sent } = await makeBot();
    await bot.handleGameChat({
      type: "server",
      author: "Server",
      message: "[SERVER] *** RESTART IN 3 MINUTES ***",
    });
    expect(sent).toEqual([]);
  });

  it("still relays ordinary server alerts", async () => {
    const { bot, sent } = await makeBot();
    await bot.handleGameChat({
      type: "server",
      author: "Server",
      message: "Anyone seen my axe?",
    });
    expect(sent).toHaveLength(1);
  });
});

describe("LogTailer chat parsing", () => {
  const parse = async (line) => {
    const { LogTailer } = await import("../services/logTailer.js");
    const tailer = Object.create(LogTailer.prototype);
    tailer.chatRemainder = "";
    const seen = [];
    tailer.emit = (event, payload) => {
      if (event === "chatMessage") seen.push(payload);
      return true;
    };
    tailer.processChatLogData(`${line}\n`);
    return seen;
  };

  it("relays a player whose name contains an apostrophe", async () => {
    const seen = await parse(
      "[05-08-26 12:00:00.000][info] Got message:ChatMessage{chat=Say, author='O'Brien', text='hello'}.",
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].author).toBe("O'Brien");
    expect(seen[0].message).toBe("hello");
  });

  it("keeps quotes inside the message body", async () => {
    const seen = await parse(
      "[05-08-26 12:00:00.000][info] Got message:ChatMessage{chat=Say, author='Bob', text='it's mine'}.",
    );
    expect(seen[0].author).toBe("Bob");
    expect(seen[0].message).toBe("it's mine");
  });
});

describe("Discord /restart", () => {
  const makeBot = async (restartResult) => {
    const { DiscordBot } = await import("../services/discordBot.js");
    const bot = Object.create(DiscordBot.prototype);
    const serverMessages = [];
    bot.serverManager = { checkServerRunning: async () => true };
    bot.rconService = {
      connected: true,
      serverMessage: async (m) => {
        serverMessages.push(m);
        return { success: true };
      },
    };
    bot.sendNotification = async () => true;
    bot.scheduler = {
      performRestart: async () => {
        if (restartResult instanceof Error) throw restartResult;
        return restartResult;
      },
    };
    return { bot, serverMessages };
  };

  const makeInteraction = () => {
    const replies = [];
    return {
      replies,
      deferReply: async () => {},
      editReply: async (m) => replies.push(m),
      options: { getInteger: () => 5 },
      user: { tag: "someone#0001" },
    };
  };

  it("reports a refused restart instead of claiming success", async () => {
    const { bot } = await makeBot({
      success: false,
      message: "Restart already in progress",
    });
    const interaction = makeInteraction();
    await bot.handleRestart(interaction);
    expect(interaction.replies.at(-1)).toMatch(/did not complete/);
    expect(interaction.replies.at(-1)).toMatch(/already in progress/);
  });

  it("stays quiet when the restart succeeds", async () => {
    const { bot } = await makeBot({ success: true });
    const interaction = makeInteraction();
    await bot.handleRestart(interaction);
    expect(interaction.replies.at(-1)).toMatch(/restart initiated/i);
  });

  it("leaves the countdown warnings to the scheduler", async () => {
    const { bot, serverMessages } = await makeBot({ success: true });
    await bot.handleRestart(makeInteraction());
    expect(serverMessages).toEqual([]);
  });

  it("falls back to the channel when the interaction token expired", async () => {
    const { bot } = await makeBot({ success: false, message: "boom" });
    const notified = [];
    bot.sendNotification = async (m) => {
      notified.push(m);
      return true;
    };
    const interaction = makeInteraction();
    let first = true;
    interaction.editReply = async (m) => {
      if (first) {
        first = false;
        interaction.replies.push(m);
        return;
      }
      throw new Error("Unknown interaction");
    };
    await bot.handleRestart(interaction);
    expect(notified.some((m) => /did not complete/.test(m))).toBe(true);
  });
});

describe("Discord /start", () => {
  it("reports a failed start instead of claiming the server is starting", async () => {
    const { DiscordBot } = await import("../services/discordBot.js");
    const bot = Object.create(DiscordBot.prototype);
    bot.serverManager = {
      checkServerRunning: async () => false,
      startServer: async () => ({ success: false, error: "port in use" }),
    };
    const replies = [];
    bot.sendNotification = async () => true;
    await bot.handleStart({
      deferReply: async () => {},
      editReply: async (m) => replies.push(m),
      user: { tag: "someone#0001" },
    });
    expect(replies.at(-1)).toMatch(/Failed to start/);
    expect(replies.at(-1)).toMatch(/port in use/);
  });
});

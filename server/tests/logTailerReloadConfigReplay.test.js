import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const getActiveServer = vi.fn();
const getSetting = vi.fn(async () => undefined);

vi.mock("../database/init.js", () => ({ getActiveServer, getSetting }));

const { LogTailer } = await import("../services/logTailer.js");

// reloadConfig() (a server switch, or saving the ACTIVE server's own
// minMemory/maxMemory/serverName/path) rediscovers the log files through
// startOffsetFor(), which treats a file born after `watchStartedAt` as a new
// session and reads it from byte zero. watchStartedAt was only ever set in the
// constructor, so once the panel had run for a while the CURRENT session's
// chat/user logs (created after panel boot) looked brand new on every repoint
// and were replayed whole: old chat reposted to Discord, duplicated on the
// Chat page, and old deaths logged again.
describe("LogTailer.reloadConfig: a repoint must not replay the log files that already exist", () => {
  let dir;
  let tailer;
  let chatLog;
  let userLog;
  let consoleLog;

  const CHAT_LINE =
    "[12-10-26 09:00:00.000][info] Message ChatMessage{chat=General, author='Alice', text='old message'} sent to chat (id = 0) members.\n";
  const DEATH_LINE = "[12-10-26 09:00:01.000] user Bob died at (1,2,0) (non pvp).\n";

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-logtail-reload-"));
    getActiveServer.mockResolvedValue({ id: "1", zomboidDataPath: dir });
    tailer = new LogTailer();

    // The session's logs are created AFTER the tailer was constructed (the
    // panel booted first, the game server started later) -- the exact shape
    // a long-running panel has.
    fs.mkdirSync(path.join(dir, "Logs"));
    chatLog = path.join(dir, "Logs", "12-10-26_chat.txt");
    userLog = path.join(dir, "Logs", "12-10-26_user.txt");
    consoleLog = path.join(dir, "server-console.txt");
    fs.writeFileSync(chatLog, CHAT_LINE.repeat(20));
    fs.writeFileSync(userLog, DEATH_LINE.repeat(3));
    fs.writeFileSync(consoleLog, "[12-10-26 09:00:00.000] <Alice> [chat] old console chat\n".repeat(20));

    // Real elapsed time between the files being born and the repoint, larger
    // than the 100ms clock-skew grace startOffsetFor allows (production gaps
    // are seconds or more).
    await new Promise((resolve) => setTimeout(resolve, 250));
  });

  afterEach(() => {
    tailer.stopWatching();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("starts the chat, user and console logs at their current end", async () => {
    await tailer.reloadConfig();

    expect(tailer.chatLogPath).toBe(chatLog);
    expect(tailer.userLogPath).toBe(userLog);
    expect(tailer.logPath).toBe(consoleLog);
    expect(tailer.chatLogSize).toBe(fs.statSync(chatLog).size);
    expect(tailer.userLogSize).toBe(fs.statSync(userLog).size);
    expect(tailer.currentSize).toBe(fs.statSync(consoleLog).size);
  });

  it("emits nothing for the existing content, then only what is appended after the repoint", async () => {
    const chat = [];
    const deaths = [];
    tailer.on("chatMessage", (m) => chat.push(m));
    tailer.on("playerDeath", (d) => deaths.push(d));

    await tailer.reloadConfig();
    await tailer.checkConsoleLog();
    await tailer.checkChatLog();
    await tailer.checkUserLog();
    expect(chat).toEqual([]);
    expect(deaths).toEqual([]);

    fs.appendFileSync(
      chatLog,
      "[12-10-26 09:05:00.000][info] Message ChatMessage{chat=General, author='Carol', text='fresh'} sent to chat (id = 0) members.\n",
    );
    fs.appendFileSync(userLog, "[12-10-26 09:05:01.000] user Dave died at (5,6,0) (non pvp).\n");
    await tailer.checkChatLog();
    await tailer.checkUserLog();

    expect(chat.map((m) => m.message)).toEqual(["fresh"]);
    expect(deaths.map((d) => d.player)).toEqual(["Dave"]);
  });

  it("still reads a log file created after the repoint from its first byte (a new session)", async () => {
    await tailer.reloadConfig();
    await new Promise((resolve) => setTimeout(resolve, 150));

    const newer = path.join(dir, "Logs", "12-10-26-b_chat.txt");
    fs.writeFileSync(
      newer,
      "[12-10-26 10:00:00.000][info] Message ChatMessage{chat=General, author='Eve', text='first of new session'} sent to chat (id = 0) members.\n",
    );
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(newer, future, future);

    const chat = [];
    tailer.on("chatMessage", (m) => chat.push(m));
    await tailer.checkChatLog();

    expect(tailer.chatLogPath).toBe(newer);
    expect(chat.map((m) => m.message)).toEqual(["first of new session"]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { LogTailer } from "../services/logTailer.js";

// log-tailer-tie-break-is-not-airtight-on-coarse-filesystems, 2026-09-09.
//
// linuxLogTailerRotation.test.js's own double-tie test ("EXACT SAME mtimeMs")
// only distinguishes the outgoing and incoming session's log by forcing a
// real 50ms wait so their birthtimeMs values differ -- a real-time race
// against whatever timestamp resolution the underlying filesystem/CI host
// actually honours, and Linux-only (`isLinux ? describe : describe.skip`) so
// it never runs at all on this dev box. This file forces the residual gap
// that test's own comment admits (mtime AND birthtime BOTH tied) directly,
// with no elapsed time and no platform dependency at all, by mocking
// fs.statSync rather than hoping two real writes land close enough together.
describe("LogTailer: mtime AND birthtime both tied (the gap the 50ms wait was covering for)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("findLatestChatLog does not get stuck on the currently-tracked file when a new file ties it on both mtime and birthtime", () => {
    const logsDir = path.join("Z:", "fake-logs");
    const oldChat = path.join(logsDir, "01-01-26_chat.txt");
    const newChat = path.join(logsDir, "02-01-26_chat.txt");
    const tiedTimeMs = 1_800_000_000_000;

    vi.spyOn(fs, "readdirSync").mockReturnValue([
      "01-01-26_chat.txt",
      "02-01-26_chat.txt",
    ]);
    vi.spyOn(fs, "statSync").mockImplementation((p) => {
      if (String(p) === oldChat || String(p) === newChat) {
        return { mtimeMs: tiedTimeMs, birthtimeMs: tiedTimeMs };
      }
      throw new Error(`unexpected statSync(${p})`);
    });

    const tailer = new LogTailer();
    tailer.logsDir = logsDir;
    // Simulate: this file is already the one being tailed from an earlier
    // poll -- exactly the "outgoing session" state the bug leaves stuck.
    tailer.chatLogPath = oldChat;

    tailer.findLatestChatLog();

    expect(tailer.chatLogPath).toBe(newChat);
  });

  it("findLatestUserLog does not get stuck on the currently-tracked file when a new file ties it on both mtime and birthtime", () => {
    const logsDir = path.join("Z:", "fake-logs");
    const oldUser = path.join(logsDir, "01-01-26_user.txt");
    const newUser = path.join(logsDir, "02-01-26_user.txt");
    const tiedTimeMs = 1_800_000_000_000;

    vi.spyOn(fs, "readdirSync").mockReturnValue([
      "01-01-26_user.txt",
      "02-01-26_user.txt",
    ]);
    vi.spyOn(fs, "statSync").mockImplementation((p) => {
      if (String(p) === oldUser || String(p) === newUser) {
        return { mtimeMs: tiedTimeMs, birthtimeMs: tiedTimeMs };
      }
      throw new Error(`unexpected statSync(${p})`);
    });

    const tailer = new LogTailer();
    tailer.logsDir = logsDir;
    tailer.userLogPath = oldUser;

    tailer.findLatestUserLog();

    expect(tailer.userLogPath).toBe(newUser);
  });
});

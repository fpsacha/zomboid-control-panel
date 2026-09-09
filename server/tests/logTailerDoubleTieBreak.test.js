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
//
// A first version of this file called findLatestChatLog/findLatestUserLog
// exactly ONCE per test. god caught (by running the method five times
// against this same mock) that a first-attempt fix keyed on "is this path
// currently tracked" OSCILLATES on every subsequent poll while the tie
// holds, flipping [B, A, B, A, B...] forever and resetting chatLogSize to 0
// on every single flip -- i.e. the fix looked correct on one call and was
// actually worse than the bug it replaced. These tests poll three times
// each and assert the full sequence stays put after the first switch, not
// just that a single call produces the right answer.
describe("LogTailer: mtime AND birthtime both tied, across repeated polls (the gap the 50ms wait was covering for)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("findLatestChatLog: settles on the new file once and does not oscillate back across three subsequent polls", () => {
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
    // Simulate: oldChat was already the tracked file from an earlier poll
    // (before the new file existed at all) -- exactly the "outgoing
    // session" state the shipped bug left stuck forever.
    tailer.chatLogPath = oldChat;
    // Defensive init (not `??=` on the class field itself) so this test can
    // also run, and meaningfully exercise the OLD comparator, against a
    // pre-fix LogTailer whose constructor never created this Set at all --
    // a bare `.add()` would otherwise fail with an unrelated TypeError
    // instead of actually demonstrating the oscillation.
    tailer.everTrackedChatPaths = tailer.everTrackedChatPaths || new Set();
    tailer.everTrackedChatPaths.add(oldChat);

    const pathSequence = [];
    const sizeSequence = [];
    for (let i = 0; i < 3; i++) {
      tailer.findLatestChatLog();
      pathSequence.push(tailer.chatLogPath);
      sizeSequence.push(tailer.chatLogSize);
    }

    expect(pathSequence).toEqual([newChat, newChat, newChat]);
    // Only the first poll's switch may touch chatLogSize -- a poll that
    // correctly declines to switch must not re-run startOffsetFor either.
    expect(sizeSequence[1]).toBe(sizeSequence[0]);
    expect(sizeSequence[2]).toBe(sizeSequence[0]);
  });

  it("findLatestUserLog: settles on the new file once and does not oscillate back across three subsequent polls", () => {
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
    tailer.everTrackedUserPaths = tailer.everTrackedUserPaths || new Set();
    tailer.everTrackedUserPaths.add(oldUser);

    const pathSequence = [];
    const sizeSequence = [];
    for (let i = 0; i < 3; i++) {
      tailer.findLatestUserLog();
      pathSequence.push(tailer.userLogPath);
      sizeSequence.push(tailer.userLogSize);
    }

    expect(pathSequence).toEqual([newUser, newUser, newUser]);
    expect(sizeSequence[1]).toBe(sizeSequence[0]);
    expect(sizeSequence[2]).toBe(sizeSequence[0]);
  });

  it("a third, genuinely new file can still win a fresh tie against the now-settled file (rotation is not permanently frozen)", () => {
    const logsDir = path.join("Z:", "fake-logs");
    const fileB = path.join(logsDir, "02-01-26_chat.txt");
    const fileC = path.join(logsDir, "03-01-26_chat.txt");
    const tiedTimeMs = 1_800_000_000_000;

    vi.spyOn(fs, "readdirSync").mockReturnValue([
      "02-01-26_chat.txt",
      "03-01-26_chat.txt",
    ]);
    vi.spyOn(fs, "statSync").mockImplementation((p) => {
      if (String(p) === fileB || String(p) === fileC) {
        return { mtimeMs: tiedTimeMs, birthtimeMs: tiedTimeMs };
      }
      throw new Error(`unexpected statSync(${p})`);
    });

    const tailer = new LogTailer();
    tailer.logsDir = logsDir;
    // B was already settled on (e.g. the previous test's outcome) -- C is
    // a brand new session's file that just appeared, tied with B.
    tailer.chatLogPath = fileB;
    tailer.everTrackedChatPaths = tailer.everTrackedChatPaths || new Set();
    tailer.everTrackedChatPaths.add(fileB);

    tailer.findLatestChatLog();

    expect(tailer.chatLogPath).toBe(fileC);
  });
});

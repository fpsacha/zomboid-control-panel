import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { LogTailer } from "../services/logTailer.js";

// start-offset-replays-the-whole-file-on-every-non-first-rotation, 2026-09-09.
//
// startOffsetFor used to take a `firstDiscovery` flag and return 0
// unconditionally whenever it was false -- i.e. any time
// findLatestChatLog/findLatestUserLog switched chatLogPath/userLogPath to a
// DIFFERENT file while the tailer was already tracking something (every
// ordinary mid-session rotation). god asked for the reachable case where the
// newly-selected file is NOT near-empty at that moment -- a real rotation's
// new file normally is, so nobody noticed.
//
// Reachable case, verified here: this application never writes into Logs/
// itself (no backup/restore/remote-config-mirror feature in this codebase
// touches it -- confirmed by reading each one), so the ONLY way a stale,
// already-populated file re-enters the "latest" comparison mid-poll is an
// external write to that directory while the panel keeps running without a
// reloadConfig()-triggering event (no panel restart, no active-server
// switch) -- e.g. an operator/admin script touching an old log, or a
// backup/volume-restore/remote-mount tool (Docker volume restore, rsync,
// NFS/SMB remount) resurfacing the Zomboid data directory live. None of
// that needs a TIE at all: a plain mtime bump on an old, large file already
// wins the ordinary `b.mtime - a.mtime` sort by itself, with no help from
// tonight's tie-break work -- this bug predates all of it. Simulated here
// with fs.utimesSync (a real, no-mock touch), which is exactly what an
// external `touch` or a restore tool's timestamp write actually does.
describe("LogTailer: a re-touched, already-populated OLD file is NOT replayed from byte zero on a live (non-first-discovery) switch", () => {
  let dir;
  let tailer;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("findLatestChatLog switches to a stale, content-heavy file once its mtime is bumped, but startOffsetFor skips its existing content instead of replaying it", () => {
    dir = fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "pz-logtail-replay-"));
    const logsDir = path.join(dir, "Logs");
    fs.mkdirSync(logsDir);

    tailer = new LogTailer();
    tailer.logsDir = logsDir;

    // The OLD file: a large, fully-read backlog from a past session --
    // already superseded once, its content already delivered to chat.
    const staleChat = path.join(logsDir, "01-01-26_chat.txt");
    const staleContent =
      "[01-01-26 09:00:00.000][info] Got message:ChatMessage{chat=Say, author='Alice', text='old backlog line 1'}.\n".repeat(
        200,
      );
    fs.writeFileSync(staleChat, staleContent);
    // The tailer's own watchStartedAt is captured at construction, which in
    // this test runs BEFORE staleChat is written -- backwards from every
    // real case this represents (a stale file that already existed well
    // before the panel started watching). Same fix linuxLogTailerRotation
    // .test.js already applies for the same reason: set it explicitly,
    // after the file's real birthtime, rather than relying on construction
    // order to happen to land on the right side of "now".
    tailer.watchStartedAt = fs.statSync(staleChat).birthtimeMs + 1000;

    // The CURRENT file: what the tailer is actively tailing right now, with
    // nothing unread (chatLogSize already caught up to its real size).
    const currentChat = path.join(logsDir, "02-01-26_chat.txt");
    fs.writeFileSync(currentChat, "[01-01-26 10:00:00.000][info] current session\n");
    tailer.chatLogPath = currentChat;
    tailer.everTrackedChatPaths.add(currentChat);
    tailer.chatLogSize = fs.statSync(currentChat).size;

    // The external event: something OTHER than this panel (an admin's
    // `touch`, a backup/restore tool, a remount) bumps the stale file's
    // mtime into the future, past the current file's -- no tie required.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(staleChat, future, future);
    expect(fs.statSync(staleChat).mtimeMs).toBeGreaterThan(
      fs.statSync(currentChat).mtimeMs,
    );

    tailer.findLatestChatLog();

    // The switch happens: this is not in question, and is correct on its
    // own (the file really does have the newest mtime now).
    expect(tailer.chatLogPath).toBe(staleChat);

    // The fix: staleChat's birthtime predates watchStartedAt (it was
    // created well before this test's tailer was constructed), so
    // startOffsetFor now skips straight to its real size instead of
    // blindly returning 0 -- checkChatLog()'s next poll sees
    // `stats.size > this.chatLogSize` as false and replays nothing.
    const realSize = fs.statSync(staleChat).size;
    expect(realSize).toBeGreaterThan(1000); // sanity: genuinely not near-empty
    expect(tailer.chatLogSize).toBe(realSize);
  });

  it("a genuinely new file (born after watchStartedAt) is still read from byte zero on a live switch -- ordinary rotation is unaffected", async () => {
    dir = fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "pz-logtail-rotation-"));
    const logsDir = path.join(dir, "Logs");
    fs.mkdirSync(logsDir);

    tailer = new LogTailer();
    tailer.logsDir = logsDir;

    const oldChat = path.join(logsDir, "01-01-26_chat.txt");
    fs.writeFileSync(oldChat, "[01-01-26 10:00:00.000][info] old session\n");
    tailer.chatLogPath = oldChat;
    tailer.everTrackedChatPaths.add(oldChat);
    tailer.chatLogSize = fs.statSync(oldChat).size;

    // Own near-miss caught by the gate, not by review: this test originally
    // constructed the tailer (capturing watchStartedAt) and then created
    // newChat with NO real elapsed time between them -- exactly the "tight
    // timescale" scenario startOffsetFor's own comment warns against, and
    // the identical ordering trap linuxLogTailerRotation.test.js already
    // documents and works around elsewhere in this same investigation. A
    // real wait, comfortably larger than BIRTHTIME_CLOCK_SKEW_GRACE_MS,
    // is the honest way to guarantee newChat's birth reads as genuinely
    // after watchStartedAt rather than trusting synchronous statements to
    // take long enough on their own.
    await new Promise((resolve) => setTimeout(resolve, 150));

    // A real new-session rotation: freshly created, born after watchStartedAt.
    const newChat = path.join(logsDir, "02-01-26_chat.txt");
    fs.writeFileSync(
      newChat,
      "[01-01-26 11:00:00.000][info] Got message:ChatMessage{chat=Say, author='Carol', text='new session'}.\n",
    );
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(newChat, future, future);

    tailer.findLatestChatLog();

    expect(tailer.chatLogPath).toBe(newChat);
    // Must still read the new file from its own start (0), not skip past
    // its one real line the way a stale re-touched file now correctly does.
    expect(tailer.chatLogSize).toBe(0);
  });
});

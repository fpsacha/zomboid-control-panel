import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { LogTailer } from "../services/logTailer.js";

// LINUX BUG HUNT (2026-08-29, card 560930): "does it handle LOG ROTATION --
// when PZ rotates a file, does the tail follow the new inode or keep reading
// a deleted one forever? On Windows a rotating process usually cannot even
// delete an open file; on Linux it can, and the tail keeps a live handle to
// nothing."
//
// Reading logTailer.js end to end first: it never uses fs.watch/inotify (the
// other named suspect) at all -- it's a plain 2s setTimeout poll loop, so the
// inotify-watch-limit concern doesn't apply here. It also never holds a
// persistent file handle across polls: checkChatLog()/checkConsoleLog() each
// do a fresh fs.promises.stat() by PATH and a fresh fs.createReadStream() per
// poll, and findLatestChatLog()/findLatestUserLog() re-scan the Logs/
// directory by mtime on every single poll. On paper this should already be
// immune to "keeps reading a deleted inode forever" -- there's no handle to
// go stale. This file PROVES that against real ext4 rather than trusting the
// reasoning: real file creation/deletion/truncation, real inode churn,
// real directory rescans.
//
// Must run from a REAL Linux filesystem (ext4) -- NOT /mnt/d, which is
// case-insensitive 9p with no real POSIX semantics and would give a false
// pass on anything inode-related.
const isLinux = process.platform !== "win32";

(isLinux ? describe : describe.skip)(
  "LogTailer: real-filesystem rotation handling (server-console.txt truncation, *_chat.txt rotation)",
  () => {
    let dir;
    let tailer;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-logtail-rotation-"));
      tailer = new LogTailer();
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("server-console.txt: a real truncate-and-rewrite (PZ restart) is detected and the tail resets to read the new content from the start", async () => {
      const consolePath = path.join(dir, "server-console.txt");
      fs.writeFileSync(consolePath, "old session line 1\nold session line 2\n");
      tailer.logPath = consolePath;
      tailer.currentSize = fs.statSync(consolePath).size;

      const seen = [];
      tailer.on("chatMessage", (m) => seen.push(m));

      // A real PZ restart truncates and rewrites the same file (this is the
      // "process can delete/replace an open file" case the card names --
      // proven here with truncateSync, which on real Linux drops the file to
      // a genuinely smaller size the SAME way a reopened-and-truncated file
      // would from a tailer's point of view). Matches the real 2s poll
      // cadence: the shrink is observed on its OWN poll, before more content
      // has a chance to regrow past the old size -- a poll landing exactly
      // between the truncate and the regrow, same as checkLoop()'s real
      // setTimeout(2000) gives it in production.
      fs.truncateSync(consolePath, 0);
      fs.writeFileSync(consolePath, "new session line 1\n");
      await tailer.checkConsoleLog();
      // The shrink branch resets the offset to 0 for the NEXT poll to catch
      // up from -- it deliberately does not also read the new content in
      // the same tick it detects the shrink.
      expect(tailer.currentSize).toBe(0);
      expect(seen).toHaveLength(0); // no [chat] marker in "new session line 1" yet

      // Next poll: normal continued tailing from the reset offset. Real B41
      // console lines carry a leading timestamp bracket before the [chat]
      // marker (processConsoleData strips exactly one leading bracket group
      // before looking for [chat], so a bare "[chat] ..." line with no
      // separate timestamp prefix would strip the marker itself).
      fs.appendFileSync(consolePath, "[18-08-26 10:00:05.000] [chat] <Bob> hello after restart\n");
      await tailer.checkConsoleLog();

      expect(seen).toHaveLength(1);
      expect(seen[0].author).toBe("Bob");
      expect(seen[0].message).toBe("hello after restart");
    });

    it("*_chat.txt rotation: PZ starting a new session creates a NEW timestamped chat log; the tailer switches to it and reads its content from the start, not from wherever the old file left off", async () => {
      const logsDir = path.join(dir, "Logs");
      fs.mkdirSync(logsDir);
      tailer.logsDir = logsDir;
      tailer.basePath = dir;

      const oldChat = path.join(logsDir, "01-01-26_chat.txt");
      fs.writeFileSync(
        oldChat,
        "[01-01-26 10:00:00.000][info] Got message:ChatMessage{chat=Say, author='Alice', text='old session'}.\n",
      );

      // beforeEach() constructs `tailer` (capturing watchStartedAt = Date.now())
      // BEFORE this file exists, which is backwards from what "old session,
      // already on disk when the panel starts watching" is supposed to mean
      // in production. Set it explicitly, right after oldChat is written,
      // rather than relying on construction order to happen to land on the
      // right side of "now".
      //
      // start-offset-replays-the-whole-file-on-every-non-first-rotation,
      // 2026-09-10 (gate finding): an EARLIER version of this line used
      // `fs.statSync(oldChat).birthtimeMs + 1000` -- a full synthetic
      // second of padding, chosen when startOffsetFor's non-first-discovery
      // path unconditionally returned 0 and so never actually consulted
      // watchStartedAt for the SECOND file below at all. Once that path
      // started consulting it too, this same padding also swallowed
      // newChat, created only a few real ms later -- misclassifying a
      // genuinely brand-new file as pre-existing (`expect(seen).toHaveLength(1)`
      // failed with an empty array: the rotation's one real line was never
      // read). A plain `Date.now()` captured right after oldChat exists
      // needs no arithmetic guess at all, and the real wait below (already
      // present for a different reason -- see its own comment) gives
      // comfortable, unambiguous separation from watchStartedAt on the
      // newChat side, well past BIRTHTIME_CLOCK_SKEW_GRACE_MS.
      tailer.watchStartedAt = Date.now();

      const seen = [];
      tailer.on("chatMessage", (m) => seen.push(m));

      // First poll: discovers and tails the old file (first discovery skips
      // to end -- matches panel-restart-mid-session semantics).
      await tailer.checkChatLog();
      expect(tailer.chatLogPath).toBe(oldChat);
      expect(seen).toHaveLength(0); // skipped straight to end on first discovery

      // Real rotation: PZ creates a NEW, later-mtime chat log for a new
      // session. Real filesystem timestamp resolution can be coarse, so
      // force a distinguishable mtime rather than relying on wall-clock
      // drift between two fast writes. A real wait also keeps newChat's
      // birthtime unambiguously later than watchStartedAt above, past any
      // cross-clock skew (see startOffsetFor's own comment).
      await new Promise((resolve) => setTimeout(resolve, 150));

      const newChat = path.join(logsDir, "02-01-26_chat.txt");
      fs.writeFileSync(
        newChat,
        "[01-01-26 11:00:00.000][info] Got message:ChatMessage{chat=Say, author='Carol', text='new session'}.\n",
      );
      const future = new Date(Date.now() + 10_000);
      fs.utimesSync(newChat, future, future);

      await tailer.checkChatLog();

      expect(tailer.chatLogPath).toBe(newChat);
      // The new file must be read from its OWN start, not treated as a
      // continuation of the old file's byte offset.
      expect(seen).toHaveLength(1);
      expect(seen[0].author).toBe("Carol");
      expect(seen[0].message).toBe("new session");

      // The old file's remainder buffer and size tracking must not leak
      // into the new file's state.
      expect(tailer.chatLogSize).toBe(fs.statSync(newChat).size);
    });

    it("*_chat.txt rotation where the outgoing and incoming session's logs land on the EXACT SAME mtimeMs does not get stuck on the old file", async () => {
      // 2026-08-29, Linux gate flake investigation: `b.mtime - a.mtime` is 0
      // on a tie, and the sort's stability then falls back to whatever order
      // fs.readdirSync happens to return -- confirmed on real ext4 to pick
      // the OLDER file, silently, with nothing in the UI to show it. Forced
      // here with fs.utimesSync rather than hoped for, the same way the test
      // above forces an unambiguous mtime difference -- a tie is just as
      // real a filesystem state as a difference, and PZ touching an
      // outgoing session's log and a new session's log within the same
      // timestamp tick at a restart boundary is the realistic path to it.
      const logsDir = path.join(dir, "Logs");
      fs.mkdirSync(logsDir);
      tailer.logsDir = logsDir;
      tailer.basePath = dir;

      const oldChat = path.join(logsDir, "01-01-26_chat.txt");
      fs.writeFileSync(
        oldChat,
        "[01-01-26 10:00:00.000][info] Got message:ChatMessage{chat=Say, author='Alice', text='old session'}.\n",
      );
      // Same fix as the rotation test above and for the same reason: a
      // plain Date.now() captured right after oldChat exists, not a
      // birthtimeMs-derived synthetic offset that overshoots newChat below.
      tailer.watchStartedAt = Date.now();

      const seen = [];
      tailer.on("chatMessage", (m) => seen.push(m));
      await tailer.checkChatLog();
      expect(tailer.chatLogPath).toBe(oldChat);

      // The tiebreak is birthtimeMs (see logTailer.js), so the two files
      // need a REAL gap between their births to be distinguishable by it --
      // confirmed by reproduction that two files written back-to-back with
      // no real elapsed time between them can tie on birthtimeMs too, on
      // this same platform's timestamp resolution. A real PZ restart has a
      // gap here as a matter of course (the old session actually ran for
      // some real time before the new one started); a short real wait is
      // the honest way to represent that in a test rather than trusting
      // synchronous statements to take long enough on their own.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const newChat = path.join(logsDir, "02-01-26_chat.txt");
      fs.writeFileSync(
        newChat,
        "[01-01-26 11:00:00.000][info] Got message:ChatMessage{chat=Say, author='Carol', text='new session'}.\n",
      );

      // The tie: both files stamped to the exact same instant.
      const tieTime = new Date();
      fs.utimesSync(oldChat, tieTime, tieTime);
      fs.utimesSync(newChat, tieTime, tieTime);
      expect(fs.statSync(oldChat).mtimeMs).toBe(fs.statSync(newChat).mtimeMs);

      await tailer.checkChatLog();

      expect(tailer.chatLogPath).toBe(newChat);
      expect(seen).toHaveLength(1);
      expect(seen[0].author).toBe("Carol");
    });

    it("*_chat.txt DELETION mid-tail (real unlink, the exact case the card warns about) does not wedge the tailer on a dead handle -- the next poll simply finds nothing, then picks up a fresh file normally", async () => {
      const logsDir = path.join(dir, "Logs");
      fs.mkdirSync(logsDir);
      tailer.logsDir = logsDir;
      tailer.basePath = dir;

      const chatFile = path.join(logsDir, "01-01-26_chat.txt");
      fs.writeFileSync(chatFile, "");
      await tailer.checkChatLog();
      expect(tailer.chatLogPath).toBe(chatFile);

      // Real unlink while "tailed" -- on Linux this succeeds even though our
      // code has no open handle to it in the first place (each poll opens
      // fresh), unlike a naive tailer that kept an fd open across polls.
      fs.unlinkSync(chatFile);

      // Must not throw, hang, or crash the poll loop.
      await expect(tailer.checkChatLog()).resolves.toBeUndefined();

      // A brand new session file appearing afterward must still be picked
      // up normally -- proves the deletion didn't leave the tailer wedged
      // on stale state.
      const seen = [];
      tailer.on("chatMessage", (m) => seen.push(m));
      const revived = path.join(logsDir, "02-01-26_chat.txt");
      fs.writeFileSync(
        revived,
        "[01-01-26 12:00:00.000][info] Got message:ChatMessage{chat=Say, author='Dave', text='back up'}.\n",
      );
      await tailer.checkChatLog();
      expect(tailer.chatLogPath).toBe(revived);
      expect(seen).toHaveLength(1);
      expect(seen[0].author).toBe("Dave");
    });

    it("pure-LF log lines (native Linux line endings, no \\r at all) parse identically to CRLF -- _splitLines' /\\r?\\n/ already accepts both", () => {
      const t = new LogTailer();
      t.chatRemainder = "";
      const seen = [];
      t.on("chatMessage", (m) => seen.push(m));
      const lfOnly =
        "[01-01-26 10:00:00.000][info] Got message:ChatMessage{chat=Say, author='Eve', text='linux native'}.\n";
      t.processChatLogData(lfOnly);
      expect(seen).toHaveLength(1);
      expect(seen[0].author).toBe("Eve");
      expect(seen[0].message).toBe("linux native");
    });
  },
);

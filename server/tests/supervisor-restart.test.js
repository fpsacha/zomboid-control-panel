import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

// Behavioral test for build.js's generated Start.bat crash-loop supervisor
// (build.js's generateStartBat()). This does NOT grep the template text --
// it generates the real file, points it at a controllable stub binary named
// like the real panel exe, and asserts on what the supervisor actually does:
// how many times it launches the stub, what its own exit code is, and what
// it wrote to logs\supervisor.log. A text-grep test would prove the string
// "MAX_RAPID_CRASHES" is present, not that the loop behaves -- this proves
// the behavior.
//
// Windows-only: this is a Windows batch supervisor, and this repo's CI runs
// on ubuntu-latest (no cmd.exe). It also needs a C# compiler to build the
// stub as a real .exe (a renamed .bat can't stand in for ZomboidControlPanel.exe --
// Windows dispatches by PE header, not extension). Both are skipped with an
// explicit, visible reason rather than silently vanishing from the run.
const isWindows = process.platform === "win32";
const CSC_PATH =
  "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const hasCsc = isWindows && fs.existsSync(CSC_PATH);
const skipReason = !isWindows
  ? `Windows-only supervisor test, running on ${process.platform}`
  : !hasCsc
    ? "legacy .NET Framework csc.exe not found -- cannot build the stub exe"
    : null;

const STUB_SOURCE = `
using System;
using System.IO;

// Controllable stand-in for ZomboidControlPanel.exe. Reads exit-codes.txt and
// sleep-ms.txt (one value per line, one per invocation; the last line
// repeats if invoked more times than there are lines) from its own
// directory, tracks its invocation count via a counter file, sleeps, then
// exits with the chosen code -- so a test can script a whole run history
// ("crash, crash, stay up, crash, clean exit") without touching the real
// panel binary.
class Stub {
  static int Main() {
    string dir = AppDomain.CurrentDomain.BaseDirectory;
    string counterPath = Path.Combine(dir, "invoke-count.txt");
    int invocation = 0;
    if (File.Exists(counterPath)) {
      int.TryParse(File.ReadAllText(counterPath).Trim(), out invocation);
    }
    File.WriteAllText(counterPath, (invocation + 1).ToString());

    int code = ReadIndexed(Path.Combine(dir, "exit-codes.txt"), invocation, 0);
    int sleepMs = ReadIndexed(Path.Combine(dir, "sleep-ms.txt"), invocation, 0);

    if (sleepMs > 0) System.Threading.Thread.Sleep(sleepMs);
    Console.WriteLine("stub invocation " + invocation + " exiting with code " + code);
    return code;
  }

  static int ReadIndexed(string path, int index, int fallback) {
    if (!File.Exists(path)) return fallback;
    var lines = File.ReadAllLines(path);
    if (lines.Length == 0) return fallback;
    int i = index < lines.Length ? index : lines.Length - 1;
    int val;
    return int.TryParse(lines[i].Trim(), out val) ? val : fallback;
  }
}
`;

let sharedDir;
let stubExePath;
let generateStartBat;

async function writeStartBatInto(dir) {
  fs.writeFileSync(path.join(dir, "Start.bat"), generateStartBat());
}

function setupStub(dir, exitCodes, sleepMsList) {
  fs.copyFileSync(stubExePath, path.join(dir, "ZomboidControlPanel.exe"));
  fs.writeFileSync(path.join(dir, "exit-codes.txt"), exitCodes.join("\n"));
  fs.writeFileSync(
    path.join(dir, "sleep-ms.txt"),
    (sleepMsList || [0]).join("\n"),
  );
}

// Mirrors sha256Directory() in updateBundle.js exactly -- ordinal sort, same
// "<relPath>\0<sha256hex>\n" canonical form -- so a fixture built here
// produces the identical hash Start.bat's embedded PowerShell recomputes.
// Duplicated rather than imported to keep this file's fixtures independent
// of updateBundle.js internals, matching how binarySha256 below already
// replicates sha256File()'s algorithm inline instead of importing it.
function sha256DirectoryForFixture(dirPath) {
  const parts = [];
  const walk = (dir, rel) => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      const relativePath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
      } else {
        const fileHash = crypto
          .createHash("sha256")
          .update(fs.readFileSync(absolutePath))
          .digest("hex");
        parts.push(`${relativePath}\0${fileHash}\n`);
      }
    }
  };
  walk(dirPath, "");
  return crypto.createHash("sha256").update(parts.join(""), "utf8").digest("hex");
}

function setupPendingUpdate(dir) {
  const stagedBinaryPath = path.join(dir, "ZomboidControlPanel.exe.new");
  fs.copyFileSync(stubExePath, stagedBinaryPath);

  const liveClientPath = path.join(dir, "client", "dist");
  const stagedClientPath = path.join(dir, "client", "dist.new-test");
  fs.mkdirSync(liveClientPath, { recursive: true });
  fs.mkdirSync(stagedClientPath, { recursive: true });
  fs.writeFileSync(path.join(liveClientPath, "index.html"), "old-client");
  fs.writeFileSync(path.join(stagedClientPath, "index.html"), "new-client");
  // Matches the real journal shape stageUpdateBundle() writes
  // (updateBundle.js): hashes.binarySha256 of the staged binary AS
  // STAGED, computed the same way (Node crypto, sha256, hex) -- Start.bat
  // now verifies against this before every apply, so a fixture missing it
  // would make every pending-update scenario in this file trip the new
  // [av_quarantine] refusal instead of exercising what each test actually
  // means to test. hashes.clientSha256 is the same idea, one level up, for
  // the staged frontend directory as a whole.
  const binarySha256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(stagedBinaryPath))
    .digest("hex");
  const clientSha256 = sha256DirectoryForFixture(stagedClientPath);
  fs.writeFileSync(
    path.join(dir, "update-bundle.json"),
    JSON.stringify({
      hashes: { binarySha256, clientSha256 },
      paths: { stagedClient: stagedClientPath },
    }),
  );
  fs.writeFileSync(path.join(dir, ".update-pending"), "pending");
}

function denyDelete(targetPath) {
  execFileSync("icacls.exe", [targetPath, "/deny", "*S-1-1-0:(D)"], {
    stdio: "ignore",
  });
}

function allowDelete(targetPath) {
  if (!fs.existsSync(targetPath)) return;
  execFileSync("icacls.exe", [targetPath, "/remove:d", "*S-1-1-0"], {
    stdio: "ignore",
  });
}

// Reproduces Dwight's actual finding (a read handle held on a file inside
// client\\dist, opened without FILE_SHARE_DELETE) so that renaming the
// directory itself fails with a clean sharing violation -- the way an AV
// scan or an editor with the file open would. An icacls deny-delete ACE on
// the DIRECTORY itself was tried first and rejected: it made cmd.exe's own
// `move` behave unreliably (observed hanging, and once mis-ordering which
// of the two backup moves actually failed) rather than the clean
// errorlevel 1 a real sharing violation produces, confirmed with a
// standalone repro outside this file. FileShare.Read excludes Delete,
// matching what actually blocks a rename on NTFS.
function holdFileOpenWithoutDelete(filePath, durationSeconds) {
  const psScript = `$fs = [System.IO.File]::Open('${filePath.replace(/'/g, "''")}', 'Open', 'Read', 'Read'); Start-Sleep -Seconds ${durationSeconds}; $fs.Close()`;
  return spawn("powershell.exe", ["-NoProfile", "-Command", psScript], {
    windowsHide: true,
    stdio: "ignore",
  });
}

// main-is-red, 2026-09-05: four tests in this file were timing out here on
// a clean GitHub windows-2022 runner with nothing but "Timed out waiting
// for X" to go on -- no visibility into what the supervisor actually did
// (or didn't do) before giving up. getDiagnostic is optional so existing
// call sites are unaffected; passing it in lets a future timeout name the
// actual state (typically readSupervisorLog(dir)) instead of leaving that
// to be re-diagnosed by hand from a bare timeout every time.
async function waitForCondition(check, timeoutMs, description, getDiagnostic) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const diagnostic = getDiagnostic ? `\n--- supervisor.log at timeout ---\n${getDiagnostic()}` : "";
  throw new Error(`Timed out waiting for ${description}${diagnostic}`);
}

// Async, not spawnSync -- spawnSync's own timeout only SIGTERMs the direct
// cmd.exe child. On Windows that child's own children (powershell.exe doing
// a timestamp lookup or Start-Sleep, or the panel .exe itself mid-launch)
// are NOT tied into a job object automatically, so killing cmd.exe orphans
// them: they keep running and keep the panel .exe file locked. Confirmed
// empirically while diagnosing this file's flake -- a spawnSync-timed-out
// run's own scenario directory couldn't even be deleted afterward
// (fs.rmSync raised EPERM on the panel .exe, still held open by a process
// spawnSync had already reported as killed). An orphan surviving one test
// also eats CPU/IO for every test that runs after it, compounding exactly
// the kind of load-dependent slowness this file is trying not to be
// sensitive to. taskkill /T kills the whole process tree, not just the one
// PID Node knows about.
function runSupervisor(dir, env, timeoutMs) {
  const childEnv = { ...process.env, ...env };
  // Strip any sandbox-imposed executable-search hardening from the child so
  // this test reflects a normal operator machine, not this CI/dev
  // environment's own shell settings. Windows env var names are
  // case-insensitive, but a plain object built from a `{...process.env}`
  // spread is case-SENSITIVE -- vitest's worker exposes this one in a
  // different case than a plain shell does, so match by name, not by exact
  // key, or the delete silently no-ops.
  for (const key of Object.keys(childEnv)) {
    if (key.toLowerCase() === "nodefaultcurrentdirectoryinexepath") {
      delete childEnv[key];
    }
  }
  return new Promise((resolve) => {
    const child = spawn("cmd.exe", ["/c", path.join(dir, "Start.bat")], {
      cwd: dir,
      env: childEnv,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    // Matches spawnSync's old `input: ""` -- no input, stdin closed
    // immediately so a stray "Press any key to continue" doesn't hang.
    child.stdin.end();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        status: timedOut ? null : code,
        signal: timedOut ? "SIGTERM" : null,
        stdout,
        stderr,
      });
    });
  });
}

function countLaunches(stdout) {
  return ((stdout || "").match(/^Launching /gm) || []).length;
}

function readSupervisorLog(dir) {
  const p = path.join(dir, "logs", "supervisor.log");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

// Real elapsed seconds between the FIRST log line matching `pattern` and
// the next line after it -- used to prove a backoff wait actually happened
// (not just that the log line claiming it did exists). :stamp's timestamps
// are whole-second (`Get-Date -Format 'yyyy-MM-dd HH:mm:ss'`), not
// millisecond, so this is a coarse measurement -- good enough to tell "it
// waited approximately N seconds" from "it didn't wait at all", which is
// all this needs to prove.
function secondsBetweenLogLine(log, pattern) {
  const lines = log.split("\n").filter(Boolean);
  const idx = lines.findIndex((l) => pattern.test(l));
  if (idx === -1 || idx + 1 >= lines.length) return null;
  const stampOf = (line) => {
    const m = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
    return m ? new Date(m[1].replace(" ", "T")) : null;
  };
  const from = stampOf(lines[idx]);
  const to = stampOf(lines[idx + 1]);
  if (!from || !to) return null;
  return (to.getTime() - from.getTime()) / 1000;
}

function freshScenarioDir(name) {
  const dir = path.join(sharedDir, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe.skipIf(!!skipReason)(
  "Start.bat supervisor crash-loop behavior",
  () => {
    // hookTimeout: csc.exe compiling this ~30-line stub measured 180-419ms
    // across 8 samples taken under sustained 100% CPU load (12 busy-loop
    // processes on this box's 16 cores) -- nowhere near the old 30000ms
    // ceiling. That means the one real "Hook timed out in 30000ms" seen on
    // this floor was not CPU contention (this sample would have shown it);
    // it is more likely disk I/O or antivirus real-time-scanning a
    // freshly-written .cs/.exe pair, which busy-loop CPU stress does not
    // reproduce and this pass did not chase further. Because the actual
    // failure driver is uncaptured, 3x-ing a clean sample that never hit it
    // would be false precision -- instead this widens 3x the LAST KNOWN-
    // INSUFFICIENT value (the 30000ms that already failed once), the same
    // margin logic applied everywhere else in this file, anchored to the
    // number that's actually known to have been too small.
    beforeAll(async () => {
      ({ generateStartBat } = await import("../../build.js"));

      sharedDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "pz-supervisor-test-"),
      );
      const srcPath = path.join(sharedDir, "stub.cs");
      fs.writeFileSync(srcPath, STUB_SOURCE);
      stubExePath = path.join(sharedDir, "ZomboidControlPanel.exe");
      execFileSync(
        CSC_PATH,
        ["-nologo", "-optimize", "-out:" + stubExePath, srcPath],
        { stdio: "pipe" },
      );

    }, 90000);

    afterAll(() => {
      if (sharedDir) fs.rmSync(sharedDir, { recursive: true, force: true });
    });

    // Every number in this file was re-derived together (2026-08-23), not
    // just the scenario currently failing. The bug was an inversion: each
    // runSupervisor(..., N) call's own N is an INTERNAL watchdog -- it
    // taskkills the child at N ms and resolves with launches=0/status=null,
    // which reads as a wrong-count ASSERTION FAILURE rather than a timeout.
    // The surrounding it(..., M) is vitest's own ceiling. N was always
    // SMALLER than M at every call site (e.g. 30000 vs 45000), so the
    // internal watchdog fired first on every single failure -- the M values
    // widened in an earlier pass were never once the binding constraint,
    // which is why widening them alone did not fix anything.
    //
    // Fresh worst-observed-completed-run data (2026-08-23), two conditions:
    // (a) 7 runs of this file ALONE through vitest --reporter=verbose under
    //     sustained 100% CPU load (12 busy-loop processes, 16-core box) --
    //     the same load-generation approach as vitest.config.js's own
    //     testTimeout justification -- and
    // (b) 3 runs of the FULL server/tests suite (135 files) under the same
    //     CPU load, which is the condition that actually matters: real
    //     cross-file contention (many files' own real subprocess spawns
    //     competing at once), not synthetic CPU spin in isolation. (a) alone
    //     under-measured two scenarios by an order of magnitude -- caught
    //     only by also running (b), which is why both are recorded here
    //     rather than shipping off (a) alone:
    //   clean-exit             180357ms (b)  refused-second-instance 45897ms (c)
    //   no-hardcoded-url        25181ms (a)  recover-after-crash    108766ms (b)
    //   real-backoff-wait       23688ms (a)  hits-cap                53900ms (a)
    //   update-loop             31135ms (a)  resets-after-stable-run 30628ms (a)
    // Each scenario's watchdog (runSupervisor's own N) below is 3x its own
    // worst observed figure above, rounded up -- the same "3x worst
    // observed, not picked by trial and error" rule this file already
    // documented for its slowest scenario, just correctly computed with
    // current data (both conditions) and correctly wired as the binding
    // number. Each it(..., M) stays exactly 15000ms above its own watchdog
    // (the same margin the original numbers already used: 30000->45000,
    // 35000->50000, 45000->60000) -- enough for taskkill + cleanup + promise
    // resolution to finish and vitest to observe the result before ITS OWN
    // ceiling could also fire, so a genuine hang always surfaces as the
    // internal watchdog's clear "killed after Nms" shape, never a same-tick
    // race with vitest's own timeout.
    //
    // (c) refused-second-instance re-measured 2026-08-27: its 11777ms figure
    // was condition (a) only -- never run through (b) in the original pass,
    // which is exactly why it flaked later (observed 42630ms/45897ms on this
    // floor, past its old 40000ms watchdog). Re-measured the same way: 5
    // unloaded full-235-file-suite runs (7000-18544ms) plus 1 run under the
    // original (b) methodology, 12 busy-loop processes pegging all 16 cores
    // AND the full suite (31688ms) -- then stopped there rather than
    // completing 3 loaded runs like the original pass: this floor is live
    // with other agents' real work, not the isolated conditions (a)/(b)
    // presumably ran under, and that same load visibly stalled other
    // commands on this machine for several minutes (even a second loaded run
    // failed outright -- vitest's own worker pool couldn't start under the
    // combined load, "Timeout waiting for worker to respond" across a dozen
    // files -- discarded, not a real measurement, the harness itself broke).
    // Used the two already-real, already-reported 42630ms/45897ms floor
    // observations as the worst-observed instead of chasing a third
    // synthetic-load sample: they are live data, not synthetic, and already
    // higher than anything safely reproduced here. 45897ms is the worst
    // across all of it -- 3x that, rounded up to the nearest 5000, is the
    // 140000ms watchdog on this scenario now.
    //
    // clean-exit and recover-after-crash carry watchdogs in the minutes
    // (545000ms, 330000ms) because of the (b) outliers above -- both are
    // otherwise-simple scenarios (single or double launch, no backoff loop)
    // that spiked once each under compounded stress (12 busy-loop processes
    // AND the full 135-file suite's own real contention at the same time),
    // not on every run. That combination is deliberately harsher than the
    // real gate: the actual release gate runs on a quiesced floor, which
    // this pass's own busy-loop load was specifically generating stress
    // beyond. Flagged rather than trimmed back down to a smaller, unproven
    // number -- these two are the ones worth a second look if a tighter
    // ceiling is wanted later; the other six never approached their old
    // values even under the (b) condition and did not need to move as far.
    //
    // Every timeout in this file was widened together, not just the one
    // scenario originally reported flaky. While diagnosing that one, three
    // DIFFERENT tests in this same file failed in the same way (an
    // undercounted launch total from a run that got killed by ITS OWN
    // still-too-tight timeout) across a validation batch of ~20 runs under
    // this floor's real concurrent load -- the tight-timeout vulnerability
    // was never specific to the stable-run scenario, just most exposed by
    // it (extra loop iterations, a mandatory real sleep). Every scenario
    // here spawns several real powershell.exe processes per loop iteration
    // (a binary-pick, a timestamp lookup, sometimes a backoff Start-Sleep),
    // and this floor runs many agents' processes concurrently, so
    // individual spawn latency is genuinely variable, not a fixed cost.
    it(
      "does not relaunch a clean exit (code 0)",
      async () => {
        const dir = freshScenarioDir("clean-exit");
        await writeStartBatInto(dir);
        setupStub(dir, [0], [0]);

        // watchdog 545000 = 3x the 180357ms worst observed for this
        // scenario (a single-run outlier under compounded stress -- see the
        // comment block above beforeAll). it() ceiling stays 15000ms above
        // the watchdog.
        const result = await runSupervisor(dir, {}, 545000);

        expect(countLaunches(result.stdout)).toBe(1);
        expect(result.status).toBe(0);
        expect(readSupervisorLog(dir)).not.toMatch(/relaunch attempt/i);
      },
      560000,
    );

    it(
      "does not relaunch or crash-loop a deliberate refusal (code 78) -- retrying is pointless when another instance already holds the lock",
      async () => {
        // 78 is the dedicated exit code server/index.js uses when pidLock
        // refuses a second instance. Before this, that refusal used the
        // generic exit code 1, indistinguishable here from a real crash --
        // Start.bat would retry it 5 times with backoff and finish with
        // "Gave up after N rapid crashes", even though the panel behaved
        // correctly and identically every single time. Confirmed with the
        // real exe: the refusal message itself is printed correctly and
        // immediately; this is purely about not then treating it as a crash.
        const dir = freshScenarioDir("refused-second-instance");
        await writeStartBatInto(dir);
        setupStub(dir, [78], [0]);

        // Re-measured 2026-08-27 (see beforeAll's own comment block): the
        // original 11777ms was condition (a) only -- this file alone, never
        // run through condition (b) (full 235-file suite, real cross-file
        // contention) the way clean-exit and recover-after-crash already
        // were. That gap is exactly why it was flaky: fresh worst observed
        // is 45897ms, over 3x the old baseline. watchdog 140000 = 3x that,
        // rounded up to the nearest 5000, same formula as every other
        // scenario in this file.
        const result = await runSupervisor(dir, {}, 140000);

        expect(countLaunches(result.stdout)).toBe(1);
        expect(result.status).toBe(78);
        const log = readSupervisorLog(dir);
        expect(log).not.toMatch(/relaunch attempt/i);
        expect(log).not.toMatch(/Gave up/i);
      },
      155000,
    );

    it(
      "does not assert a URL it cannot actually know -- the panel prints its own real one",
      async () => {
        // Start.bat used to print "Open your browser to: http://localhost:3001"
        // before the panel had even bound a port. The panel falls back to a
        // free port when 3001 is taken, and that fallback is PERSISTED, so a
        // hardcoded guess here goes stale forever the first time it ever
        // fires -- a second source of truth is exactly how this class of bug
        // (the product asserting something false about itself) comes back.
        // server/index.js already logs the real bound URL once it's ready;
        // Start.bat must defer to that, not compute its own answer.
        const dir = freshScenarioDir("no-hardcoded-url");
        await writeStartBatInto(dir);
        setupStub(dir, [0], [0]);

        // watchdog 80000 = 3x the 25181ms worst observed for this scenario.
        const result = await runSupervisor(dir, {}, 80000);

        expect(result.status).toBe(0);
        expect(result.stdout).not.toMatch(/localhost:3001/);
      },
      95000,
    );

    it(
      "relaunches once after a crash, then stops cleanly once the panel recovers",
      async () => {
        const dir = freshScenarioDir("recover-after-crash");
        await writeStartBatInto(dir);
        setupStub(dir, [7, 0], [0, 0]);

        // watchdog 330000 = 3x the 108766ms worst observed for this
        // scenario (a single-run outlier under compounded stress -- see the
        // comment block above beforeAll).
        const result = await runSupervisor(
          dir,
          { PANEL_SUPERVISOR_BACKOFF_SECONDS: "0" },
          330000,
        );

        expect(countLaunches(result.stdout)).toBe(2);
        expect(result.status).toBe(0);
        const log = readSupervisorLog(dir);
        expect(log).toMatch(/relaunch attempt 1 of 5/);
        expect(log).not.toMatch(/Gave up/);
      },
      345000,
    );

    it(
      "a non-zero backoff actually waits, not just claims to in the log -- the branch every other test in this file sets to 0 and skips",
      async () => {
        // Every other scenario here uses PANEL_SUPERVISOR_BACKOFF_SECONDS=0
        // to stay fast, which means none of them could ever catch a
        // regression that broke the real Start-Sleep wait -- including the
        // build.js change that made BACKOFF=0 skip the powershell spawn
        // entirely: a bug in that change's `if !BACKOFF! GTR 0` condition
        // could just as easily skip a REAL backoff, and every existing
        // test would still go green. A real operator relies on this
        // branch, not the zero-second one.
        const dir = freshScenarioDir("real-backoff-wait");
        await writeStartBatInto(dir);
        setupStub(dir, [7, 0], [0, 0]);

        // watchdog 75000 = 3x the 23688ms worst observed for this scenario.
        const result = await runSupervisor(dir, { PANEL_SUPERVISOR_BACKOFF_SECONDS: "3" }, 75000);

        expect(countLaunches(result.stdout)).toBe(2);
        expect(result.status).toBe(0);
        const log = readSupervisorLog(dir);
        expect(log).toMatch(/relaunch attempt 1 of 5, waiting 3s/);
        // The measured gap includes the 3s sleep plus the next iteration's
        // own binary-pick/timestamp overhead (a couple more real
        // powershell spawns), so it will usually run a bit over 3 -- the
        // floor at 2 (not 3) is only to absorb :stamp's whole-second
        // timestamp rounding at a worst-case boundary, the same margin
        // reasoning already used by the crash-counter-reset test above. If
        // the wait were skipped entirely, this would measure 0-1, not 2+.
        const gapSeconds = secondsBetweenLogLine(log, /relaunch attempt 1 of 5, waiting 3s/);
        expect(gapSeconds, "measured gap between the wait message and the next launch").not.toBeNull();
        expect(gapSeconds).toBeGreaterThanOrEqual(2);
      },
      90000,
    );

    it(
      "stops and surfaces the exit code once repeated crashes exceed the cap",
      async () => {
        const dir = freshScenarioDir("hits-cap");
        await writeStartBatInto(dir);
        setupStub(dir, [7], [0]);

        // watchdog 165000 = 3x the 53900ms worst observed for this scenario
        // -- the slowest in the file (4 real launches, each with its own
        // binary-pick/timestamp powershell overhead).
        const result = await runSupervisor(
          dir,
          {
            PANEL_SUPERVISOR_BACKOFF_SECONDS: "0",
            PANEL_SUPERVISOR_MAX_CRASHES: "3",
          },
          165000,
        );

        // cap=3 allows 3 relaunches (4 total launches) before giving up on
        // the 4th crash.
        expect(countLaunches(result.stdout)).toBe(4);
        expect(result.status).toBe(7);
        const log = readSupervisorLog(dir);
        expect(log).toMatch(/relaunch attempt 1 of 3/);
        expect(log).toMatch(/relaunch attempt 2 of 3/);
        expect(log).toMatch(/relaunch attempt 3 of 3/);
        expect(log).toMatch(/Gave up after 4 rapid crashes/);
      },
      180000,
    );

    it(
      "still loops immediately on exit code 75 (update path), unaffected by the crash cap",
      async () => {
        const dir = freshScenarioDir("update-loop");
        await writeStartBatInto(dir);
        setupStub(dir, [75, 75, 0], [0, 0, 0]);

        // watchdog 95000 = 3x the 31135ms worst observed for this scenario.
        const result = await runSupervisor(
          dir,
          { PANEL_SUPERVISOR_MAX_CRASHES: "1" },
          95000,
        );

        expect(countLaunches(result.stdout)).toBe(3);
        expect(result.status).toBe(0);
        const log = readSupervisorLog(dir);
        // Exit 75 is a requested update, never a "crash" -- it must never
        // produce a relaunch-attempt/backoff message or count against the cap.
        expect(log).not.toMatch(/relaunch attempt/);
        expect(log).not.toMatch(/Gave up/);
      },
      110000,
    );

    it(
      "refuses to apply a staged binary whose hash no longer matches the journal, instead of installing it over a working install",
      async () => {
        // 2026-09-04, Dwight's finding (code-grounded, not live-tested at
        // the time): the Windows apply path only ever checked that a file
        // named right existed -- never that its CONTENT still matched what
        // was staged. A file partially overwritten or corrupted in the
        // window between staging and apply would pass that presence check
        // and get renamed into place anyway. Linux's applyUpdateBundle()
        // already hashes and refuses (updateBundle.js:376-385); this is
        // the same check, same [av_quarantine] failure code, now in
        // Start.bat's :apply_update.
        const dir = freshScenarioDir("staged-hash-mismatch");
        await writeStartBatInto(dir);
        setupStub(dir, [0], [0]);
        setupPendingUpdate(dir);

        // Corrupt the staged binary AFTER setupPendingUpdate() already
        // hashed and journaled the good copy -- exactly Dwight's window: a
        // file that still exists under the right name (passes the
        // presence check) but no longer matches what was staged.
        const stagedBinaryPath = path.join(dir, "ZomboidControlPanel.exe.new");
        const corrupted = fs.readFileSync(stagedBinaryPath);
        corrupted[corrupted.length - 1] ^= 0xff;
        fs.writeFileSync(stagedBinaryPath, corrupted);

        const result = await runSupervisor(
          dir,
          { PANEL_SUPERVISOR_BACKOFF_SECONDS: "0" },
          60000,
        );

        // The pre-existing exe (set up by setupStub, untouched) is what
        // actually launches -- the corrupted staged binary is never
        // installed, and this must not read as a crash or trigger a retry.
        expect(countLaunches(result.stdout)).toBe(1);
        expect(result.status).toBe(0);
        const log = readSupervisorLog(dir);
        expect(log).toMatch(/staged binary hash check \[MISMATCH\].*av_quarantine/i);
        expect(log).not.toMatch(/bundle activated/i);
        // Nothing was renamed: old client stays live, no binary backup was
        // ever created (the hash check runs before any backup/rename step).
        expect(
          fs.readFileSync(path.join(dir, "client", "dist", "index.html"), "utf8"),
        ).toBe("old-client");
        expect(
          fs.existsSync(
            path.join(dir, "ZomboidControlPanel.exe.bundle-previous"),
          ),
        ).toBe(false);
        // The refused marker is consumed (not left to retry forever against
        // an unrepairable corrupted file) -- matches the existing
        // "staged binary missing or quarantined" branch's own posture.
        expect(fs.existsSync(path.join(dir, ".update-pending"))).toBe(false);
      },
      75000,
    );

    it(
      "refuses to apply a staged client bundle whose hash no longer matches the journal, instead of installing it over a working install",
      async () => {
        // 2026-09-05, client-bundle-integrity: the staged binary has always
        // been hash-verified (see the test above); the staged CLIENT bundle
        // never was, on either platform -- same corruption window Dwight
        // measured for the binary applies here too, and a corrupt client
        // bundle is arguably worse (a panel that starts and serves a broken
        // UI, instead of failing loudly).
        const dir = freshScenarioDir("staged-client-hash-mismatch");
        await writeStartBatInto(dir);
        setupStub(dir, [0], [0]);
        setupPendingUpdate(dir);

        // Corrupt the staged client file AFTER setupPendingUpdate() already
        // hashed and journaled the good copy -- exactly the same window as
        // the binary test: a file that still exists under the right name
        // (passes the frontend_swap_failed presence check) but no longer
        // matches what was staged.
        const stagedClientIndexPath = path.join(
          dir,
          "client",
          "dist.new-test",
          "index.html",
        );
        fs.writeFileSync(stagedClientIndexPath, "tampered-client");

        const result = await runSupervisor(
          dir,
          { PANEL_SUPERVISOR_BACKOFF_SECONDS: "0" },
          60000,
        );

        // The pre-existing exe and client (set up by setupStub /
        // setupPendingUpdate, untouched) are what actually launch -- the
        // tampered staged client is never installed.
        expect(countLaunches(result.stdout)).toBe(1);
        expect(result.status).toBe(0);
        const log = readSupervisorLog(dir);
        expect(log).toMatch(/staged frontend hash check \[MISMATCH\].*av_quarantine/i);
        expect(log).not.toMatch(/bundle activated/i);
        expect(
          fs.readFileSync(path.join(dir, "client", "dist", "index.html"), "utf8"),
        ).toBe("old-client");
        expect(
          fs.existsSync(
            path.join(dir, "ZomboidControlPanel.exe.bundle-previous"),
          ),
        ).toBe(false);
        expect(fs.existsSync(path.join(dir, ".update-pending"))).toBe(false);
      },
      75000,
    );

    it(
      "rolls back instead of launching when the pending marker cannot become the applying marker",
      async () => {
        const dir = freshScenarioDir("marker-move-failure");
        await writeStartBatInto(dir);
        setupStub(dir, [0], [0]);
        setupPendingUpdate(dir);

        const markerPath = path.join(dir, ".update-pending");
        denyDelete(markerPath);
        const supervisor = runSupervisor(
          dir,
          {
            PANEL_SUPERVISOR_BACKOFF_SECONDS: "0",
            PANEL_SUPERVISOR_MAX_CRASHES: "1",
          },
          120000,
        );
        let result;
        try {
          await waitForCondition(
            () =>
              /could not move pending marker/i.test(readSupervisorLog(dir)),
            30000,
            "the supervisor to report the marker transition failure",
            () => readSupervisorLog(dir),
          );
        } finally {
          allowDelete(markerPath);
          result = await supervisor;
        }

        expect(result.status).toBe(0);
        expect(countLaunches(result.stdout)).toBeGreaterThanOrEqual(1);
        const log = readSupervisorLog(dir);
        expect(log).toMatch(/could not move pending marker/i);
        expect(log).not.toMatch(/bundle activated; waiting/i);
        expect(fs.existsSync(path.join(dir, "ZomboidControlPanel.exe"))).toBe(true);
        expect(
          fs.readFileSync(path.join(dir, "client", "dist", "index.html"), "utf8"),
        ).toBe("old-client");
      },
      135000,
    );

    it(
      "retains the journal and reports an incomplete rollback when a backup cannot be restored",
      async () => {
        const dir = freshScenarioDir("denied-backup-restore");
        await writeStartBatInto(dir);
        setupStub(dir, [7, 0], [5000, 0]);
        setupPendingUpdate(dir);

        const backupPath = path.join(
          dir,
          "ZomboidControlPanel.exe.bundle-previous",
        );
        const supervisor = runSupervisor(
          dir,
          { PANEL_SUPERVISOR_BACKOFF_SECONDS: "0" },
          120000,
        );
        let permissionApplied = false;
        let setupError;
        let result;
        try {
          await waitForCondition(
            () => fs.existsSync(backupPath),
            30000,
            "the binary backup to be created",
            () => readSupervisorLog(dir),
          );
          denyDelete(backupPath);
          permissionApplied = true;
        } catch (error) {
          setupError = error;
        } finally {
          result = await supervisor;
          allowDelete(backupPath);
        }

        if (setupError) throw setupError;
        expect(permissionApplied).toBe(true);
        expect(result.status).toBe(1);
        expect(fs.existsSync(path.join(dir, "update-bundle.json"))).toBe(true);
        expect(fs.existsSync(path.join(dir, ".update-applying"))).toBe(true);
        expect(fs.existsSync(backupPath)).toBe(true);
        const log = readSupervisorLog(dir);
        expect(log).toMatch(/binary restore failed/i);
        expect(log).toMatch(/rollback incomplete; journal retained/i);
        expect(log).not.toMatch(/rollback complete/i);
      },
      135000,
    );

    it(
      "does not report a rollback failure when the frontend backup step itself never ran",
      async () => {
        // 2026-09-04, Dwight's finding, god-dispatched: the inverse of the
        // two tests above -- the log said broken, the state was fine. He
        // forced the client\\dist backup MOVE itself to fail (a locked file
        // inside it); a failed move leaves its source exactly where it was,
        // so the live frontend was never disturbed and nothing needed
        // restoring. The old code inferred "was a backup made?" purely from
        // whether client\\dist.previous exists on disk, so it read this as
        // a lost backup and reported "[rollback_failed] ... journal
        // retained for recovery" -- an operator would reasonably believe
        // their panel was damaged when it was not. This holds a file inside
        // the LIVE client\\dist directory open without FILE_SHARE_DELETE,
        // forcing that first move to fail before any backup is ever
        // created, while the exe backup (made moments earlier) genuinely
        // does need restoring -- exercising both the new "skip" path and
        // the pre-existing "real restore" path in the same run.
        const dir = freshScenarioDir("client-backup-never-ran");
        await writeStartBatInto(dir);
        setupStub(dir, [0], [0]);
        setupPendingUpdate(dir);

        const liveClientPath = path.join(dir, "client", "dist");
        const lockedFilePath = path.join(liveClientPath, "index.html");
        const holder = holdFileOpenWithoutDelete(lockedFilePath, 25);
        const supervisor = runSupervisor(
          dir,
          { PANEL_SUPERVISOR_BACKOFF_SECONDS: "0" },
          120000,
        );
        let result;
        try {
          await waitForCondition(
            () =>
              /could not back up live frontend/i.test(readSupervisorLog(dir)),
            30000,
            "the supervisor to report the client backup failure",
            () => readSupervisorLog(dir),
          );
        } finally {
          holder.kill();
          result = await supervisor;
        }

        expect(result.status).toBe(0);
        expect(countLaunches(result.stdout)).toBeGreaterThanOrEqual(1);
        const log = readSupervisorLog(dir);
        expect(log).toMatch(/could not back up live frontend/i);
        expect(log).toMatch(
          /frontend restore skipped; backup step never ran/i,
        );
        expect(log).not.toMatch(/frontend restore failed/i);
        expect(log).not.toMatch(/rollback incomplete/i);
        expect(log).toMatch(/rollback complete/i);
        // The genuine failure path must still work in the SAME run: the exe
        // backup (made before the client move was even attempted) really
        // was disturbed, and really does get restored -- not weakened by
        // the client-side fix.
        expect(
          fs.readFileSync(
            path.join(dir, "client", "dist", "index.html"),
            "utf8",
          ),
        ).toBe("old-client");
        expect(fs.existsSync(path.join(dir, ".update-pending"))).toBe(false);
        expect(fs.existsSync(path.join(dir, "update-bundle.json"))).toBe(
          false,
        );
      },
      135000,
    );

    it(
      "bounds the rollback-retry loop and halts visibly, naming the three recovery files, instead of looping forever",
      async () => {
        // 2026-09-04, god's design review of Angela's :rollback_update
        // proposal: a stuck .update-applying re-triggers ROLLBACK on every
        // RELAUNCH (not every restart, unlike .update-pending), against an
        // identical already-failed state each time. Unlike the
        // "denied-backup-restore" test above, this scenario must NOT let
        // the live exe get deleted as a side effect of the restore attempt
        // (that would trip the pre-existing, unrelated "no exe found" halt
        // on the next iteration and never actually exercise the new bound)
        // -- so this forces "backup is missing" specifically (delete the
        // backup outright, don't just deny its own delete permission),
        // since that branch never touches BASE_EXE at all, letting the
        // handshake-fail/rollback cycle genuinely repeat.
        const dir = freshScenarioDir("rollback-retry-cap");
        await writeStartBatInto(dir);
        setupStub(dir, [1], [0]);
        setupPendingUpdate(dir);

        const backupPath = path.join(
          dir,
          "ZomboidControlPanel.exe.bundle-previous",
        );
        // watchdog 60000: two fast (0ms-sleep) launches plus two rollback
        // attempts, no crash-loop backoff involved (APPLYING never clears,
        // so the crash-loop branch below the handshake check is never
        // reached) -- generous relative to this file's own fastest
        // multi-launch scenarios given no prior measurement of this exact
        // one exists yet.
        const supervisor = runSupervisor(
          dir,
          {
            PANEL_SUPERVISOR_BACKOFF_SECONDS: "0",
            PANEL_SUPERVISOR_MAX_ROLLBACK_RETRIES: "1",
          },
          60000,
        );
        let result;
        try {
          await waitForCondition(
            () => fs.existsSync(backupPath),
            30000,
            "the binary backup to be created",
            () => readSupervisorLog(dir),
          );
          fs.rmSync(backupPath, { force: true });
        } finally {
          result = await supervisor;
        }

        expect(result.status).toBe(1);
        // cap=1 allows exactly one rollback retry: launch, fail, retry 1 of
        // 1, launch again, fail again, halt on the second occurrence --
        // never a third launch.
        expect(countLaunches(result.stdout)).toBe(2);
        expect(fs.existsSync(path.join(dir, "ZomboidControlPanel.exe"))).toBe(
          true,
        );
        const log = readSupervisorLog(dir);
        expect(log).toMatch(/binary restore failed; backup is missing/i);
        expect(log).toMatch(/retry 1 of 1/);
        expect(log).not.toMatch(/retry 2 of 1/);
        expect(log).toMatch(/rollback_retry_exhausted/);
        // The console halt message is the second delivery path for the
        // same recovery guidance the client's rollback_failed hint already
        // gives -- this is precisely the case that hint cannot reach, since
        // the panel isn't running to render it. Checked on stdout (the
        // plain `echo` lines), not the timestamped log, since that's what
        // an operator actually sees in the console window.
        expect(result.stdout).toMatch(/\.update-pending/);
        expect(result.stdout).toMatch(/\.update-applying/);
        expect(result.stdout).toMatch(/update-bundle\.json/);
      },
      75000,
    );

    it(
      "resets the crash counter after a run that stays up long enough, so the cap never trips",
      async () => {
        const dir = freshScenarioDir("resets-after-stable-run");
        await writeStartBatInto(dir);
        // Crash, stay up ~2.5s, crash again, then exit cleanly. With
        // MAX_CRASHES=1 this would give up on the very first relaunch if the
        // counter did NOT reset after the stable run. The uptime check
        // compares whole-second epoch timestamps (floor'd, not rounded), so
        // the sleep needs enough margin over the 1s override below that a
        // worst-case truncation at both ends still lands >= 1s -- 2.5s of
        // real sleep guarantees that; something closer to 1.0-1.5s would be
        // a flaky test, not a bug in the supervisor.
        setupStub(dir, [7, 7, 0], [0, 2500, 0]);

        // Timeout, not the assertion, is what was flaky: diagnosed by
        // instrumenting Start.bat itself (not this test) to log at every
        // decision point, then running the real scenario several dozen
        // times back to back outside vitest. The crash-counter-reset logic
        // fired correctly, with an accurate uptime value, on every single
        // run that finished -- never once a wrong reset or a missed one.
        // What varied wildly was how long it took to get there: this
        // scenario needs ~8-10 real powershell.exe subprocess spawns (a
        // timestamp lookup and a binary pick each loop iteration, a
        // Start-Sleep for backoff after each crash), and under this floor's
        // actual concurrent load this file's own watchdog was the ACTUAL
        // killer (not vitest's it() ceiling, which was always looser) --
        // see the comment block above beforeAll for the full re-measurement.
        // watchdog 95000 = 3x the 30628ms worst observed for this scenario.
        const result = await runSupervisor(
          dir,
          {
            PANEL_SUPERVISOR_BACKOFF_SECONDS: "0",
            PANEL_SUPERVISOR_MAX_CRASHES: "1",
            PANEL_SUPERVISOR_MIN_STABLE_SECONDS: "1",
          },
          95000,
        );

        expect(countLaunches(result.stdout)).toBe(3);
        expect(result.status).toBe(0);
        const log = readSupervisorLog(dir);
        expect(log).toMatch(/resetting crash counter/);
        expect(log).not.toMatch(/Gave up/);
      },
      110000,
    );
  },
);

if (skipReason) {
  it.skip(`Start.bat supervisor crash-loop behavior (skipped: ${skipReason})`, () => {});
}

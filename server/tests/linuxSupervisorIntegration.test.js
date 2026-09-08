import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, spawn } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import { generateStartSh } from "../../build.js";

const roots = [];
const gameGroups = [];

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8").trim()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

// A relaunched panel runs via `setsid ./ZomboidControlPanel &`, its own
// detached session -- it inherits the wrapper's stdout/stderr PIPE (setsid
// does not redirect stdio, only detaches the process group) but is immune
// to a plain kill() on the wrapper's PID alone. With stdio:"pipe", Node's
// 'close' event waits for EOF on that pipe, which cannot happen while this
// still-live grandchild holds its write end open -- killing only the
// wrapper leaves 'close' waiting forever for a session it can't reach.
// Reads the real panel PID from .supervisor.pid (written fresh every
// relaunch) and kills its whole process group first, THEN the wrapper.
function killPanelAndSupervisor(root, supervisor) {
  try {
    const pidFile = path.join(root, ".supervisor.pid");
    if (fs.existsSync(pidFile)) {
      const panelPid = Number(fs.readFileSync(pidFile, "utf8").trim());
      if (panelPid) {
        try { process.kill(-panelPid, "SIGKILL"); } catch { /* already gone, or not a group leader */ }
        try { process.kill(panelPid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  } catch { /* best effort */ }
  supervisor.kill("SIGKILL");
}

afterEach(() => {
  for (const pid of gameGroups.splice(0)) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already stopped */ }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const describeLinux = process.platform === "linux" ? describe : describe.skip;

describeLinux("Linux panel supervisor", () => {
  it("stops the panel while leaving a detached game-server group alive", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-supervisor-"));
    roots.push(root);
    const launcher = path.join(root, "start.sh");
    const panel = path.join(root, "ZomboidControlPanel");
    fs.writeFileSync(launcher, generateStartSh(), { mode: 0o755 });
    fs.writeFileSync(panel, `#!/bin/sh
setsid sh -c 'trap "" TERM INT; echo $$ > game.pid; while :; do sleep 1; done' &
echo $$ > panel.pid
trap 'exit 0' TERM INT
while :; do sleep 1; done
`, { mode: 0o755 });

    const supervisor = spawn("bash", [launcher], { cwd: root, stdio: "ignore" });
    await waitForFile(path.join(root, "game.pid"));
    const gamePid = Number(fs.readFileSync(path.join(root, "game.pid"), "utf8").trim());
    gameGroups.push(gamePid);

    supervisor.kill("SIGTERM");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("supervisor did not stop")), 5000);
      supervisor.once("close", () => { clearTimeout(timer); resolve(); });
    });

    expect(() => process.kill(gamePid, 0)).not.toThrow();
  }, 10_000);

  function writeCrashingPanel(root) {
    fs.writeFileSync(
      path.join(root, "ZomboidControlPanel"),
      "#!/bin/sh\nexit 1\n",
      { mode: 0o755 },
    );
  }

  function runToExhaustion(root, env = {}) {
    fs.writeFileSync(path.join(root, "start.sh"), generateStartSh(), { mode: 0o755 });
    writeCrashingPanel(root);
    try {
      return execFileSync("bash", ["start.sh"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PANEL_SUPERVISOR_MAX_CRASHES: "2", PANEL_SUPERVISOR_BACKOFF_SECONDS: "0", ...env },
        timeout: 10_000,
      });
    } catch (error) {
      // A nonzero exit is the expected outcome (giving up propagates the
      // panel's own last exit code) -- the captured output is what matters.
      return `${error.stdout || ""}${error.stderr || ""}`;
    }
  }

  it("says nothing about a backup on give-up when there is no pending update", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-supervisor-giveup-clean-"));
    roots.push(root);

    const output = runToExhaustion(root);

    expect(output).toContain("giving up");
    expect(output).not.toContain("pending update journal");
    expect(output).not.toContain("bundle-previous");
    expect(output).not.toContain("startup handshake");
  }, 15_000);

  // Q3, taken for real this time (god's dispatch, 2026-09-08, "harden-updater"):
  // the give-up NOTE above used to just print manual recovery steps when a
  // crash-loop exhausted with an unacknowledged update still on disk --
  // this replaces that with an ACTUAL rollback, mirroring Start.bat's own
  // `.update-applying`-presence check, bounded by MAX_ROLLBACK_RETRIES
  // (separate, tighter than MAX_RAPID_CRASHES) instead of the ordinary
  // crash-loop budget. File-existence only, no JSON parser, same house
  // style as restore_interrupted_update() above.
  function writeGoodOldBinary(root) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, "ZomboidControlPanel.bundle-previous"),
      "#!/bin/sh\necho old-build-running > old-build.marker\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n",
      { mode: 0o755 },
    );
  }

  function writeJournal(root, extra = {}) {
    fs.writeFileSync(
      path.join(root, "update-bundle.json"),
      JSON.stringify({ version: "9.9.9", phase: "awaiting_startup_ack", ...extra }),
    );
  }

  // exit==75 is the one genuinely load-bearing ordering fact: on Linux the
  // swap runs IN-PROCESS inside the OLD binary's own restart handler
  // (applyUpdateBundle() completes, THEN it exits 75), so at the moment 75
  // is captured, update-bundle.json + bundle-previous already exist -- but
  // the NEW binary has not launched yet. Checking presence before this
  // branch (the way Start.bat orders it) would roll back every successful
  // apply before the new binary got a chance to run.
  it("does NOT roll back on exit code 75 even though the journal and backup already exist (the apply-then-exit race)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-supervisor-rollback-75-"));
    roots.push(root);
    writeGoodOldBinary(root);
    writeJournal(root);
    fs.writeFileSync(path.join(root, "start.sh"), generateStartSh(), { mode: 0o755 });
    // Exits 75 exactly ONCE (a real update apply is a one-time decision,
    // not something a binary keeps re-announcing) then behaves like an
    // ordinary long-running process -- a binary that exited 75 forever
    // would busy-loop the supervisor's zero-backoff handoff path for as
    // long as the test kept it alive, which is unrealistic AND, in a
    // resource-constrained CI runner, can starve whatever test runs next.
    fs.writeFileSync(
      path.join(root, "ZomboidControlPanel"),
      "#!/bin/sh\nif [ ! -f already-ran ]; then\n  touch already-ran\n  exit 75\nfi\necho second-run > second-run.marker\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n",
      { mode: 0o755 },
    );

    const supervisor = spawn("bash", ["start.sh"], {
      cwd: root,
      stdio: "pipe",
      env: { ...process.env, PANEL_SUPERVISOR_BACKOFF_SECONDS: "0" },
    });
    let output = "";
    supervisor.stdout.on("data", (d) => { output += d; });
    supervisor.stderr.on("data", (d) => { output += d; });
    await waitForFile(path.join(root, "second-run.marker"), 8000);
    killPanelAndSupervisor(root, supervisor);
    await new Promise((resolve) => supervisor.once("close", resolve));

    expect(output).toContain("supervised restart");
    expect(output).not.toContain("startup handshake");
    expect(fs.existsSync(path.join(root, "update-bundle.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "ZomboidControlPanel.bundle-previous"))).toBe(true);
  }, 12_000);

  // exit==78 exclusion: a lock refusal says nothing about whether the new
  // binary is broken -- rolling back a good build over an unrelated
  // stale-lock collision would be the exact wrong-auto-rollback risk this
  // feature exists to avoid.
  it("does NOT roll back on exit code 78 even though the journal and backup exist, and still propagates 78 immediately", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-supervisor-rollback-78-"));
    roots.push(root);
    writeGoodOldBinary(root);
    writeJournal(root);
    fs.writeFileSync(path.join(root, "start.sh"), generateStartSh(), { mode: 0o755 });
    fs.writeFileSync(path.join(root, "ZomboidControlPanel"), "#!/bin/sh\nexit 78\n", { mode: 0o755 });

    let output;
    let exitCode = 0;
    try {
      output = execFileSync("bash", ["start.sh"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PANEL_SUPERVISOR_BACKOFF_SECONDS: "0" },
        timeout: 10_000,
      });
    } catch (error) {
      output = `${error.stdout || ""}${error.stderr || ""}`;
      exitCode = error.status;
    }

    expect(exitCode).toBe(78);
    expect(output).not.toContain("startup handshake");
    expect(fs.existsSync(path.join(root, "update-bundle.json"))).toBe(true);
  }, 10_000);

  // The real gap this whole feature exists to close: a crash from any
  // cause OTHER than version_mismatch/invalid_bundle (which
  // inspectPendingPanelUpdate() already auto-rolls-back at Node startup)
  // used to burn the entire MAX_RAPID_CRASHES budget against the same
  // broken binary while a good backup sat unused. Now it rolls back within
  // MAX_ROLLBACK_RETRIES, resumes the previous build, and leaves a durable
  // notice (god's addition to Q3) for the Diagnostics page to surface.
  it("rolls back an update that never completes its startup handshake, resumes the previous build, and leaves a durable notice", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-supervisor-rollback-fix-"));
    roots.push(root);
    writeGoodOldBinary(root);
    writeJournal(root, { appliedAt: "2026-09-08T09:00:00.000Z" });
    fs.writeFileSync(path.join(root, "start.sh"), generateStartSh(), { mode: 0o755 });
    fs.writeFileSync(path.join(root, "ZomboidControlPanel"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const supervisor = spawn("bash", ["start.sh"], {
      cwd: root,
      stdio: "pipe",
      env: { ...process.env, PANEL_SUPERVISOR_MAX_CRASHES: "10", PANEL_SUPERVISOR_BACKOFF_SECONDS: "0" },
    });
    let output = "";
    supervisor.stdout.on("data", (d) => { output += d; });
    supervisor.stderr.on("data", (d) => { output += d; });
    try {
      await waitForFile(path.join(root, "old-build.marker"), 8000);
    } catch (error) {
      killPanelAndSupervisor(root, supervisor);
      throw new Error(`${error.message}\n--- captured output ---\n${output}`);
    }
    killPanelAndSupervisor(root, supervisor);
    await new Promise((resolve) => supervisor.once("close", resolve));

    expect(output).toContain("never completed its startup handshake");
    expect(output).toContain("Rollback complete");
    expect(fs.existsSync(path.join(root, "update-bundle.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".update-rollback-notice.json"))).toBe(true);
    const notice = JSON.parse(fs.readFileSync(path.join(root, ".update-rollback-notice.json"), "utf8"));
    expect(notice.version).toBe("9.9.9");
    expect(notice.appliedAt).toBe("2026-09-08T09:00:00.000Z");
  }, 12_000);

  // The failure mode people skip and the one that actually strands an
  // operator: if the rollback itself cannot succeed, this must halt with a
  // manual recovery recipe rather than repeat the same failing operation
  // forever. PANEL_SUPERVISOR_MAX_ROLLBACK_RETRIES=0 exercises the bound
  // deterministically (real mv/rm failures are exercised directly against
  // rollback_failed_update() in isolation -- see
  // linuxSupervisorRollbackNotice.test.js).
  it("halts with a manual recovery recipe instead of looping when rollback retries are exhausted", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-supervisor-rollback-exhausted-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "ZomboidControlPanel.bundle-previous"), "old-binary-bytes");
    writeJournal(root);
    fs.writeFileSync(path.join(root, "start.sh"), generateStartSh(), { mode: 0o755 });
    writeCrashingPanel(root);

    let output;
    let exitCode = 0;
    try {
      output = execFileSync("bash", ["start.sh"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PANEL_SUPERVISOR_MAX_ROLLBACK_RETRIES: "0", PANEL_SUPERVISOR_BACKOFF_SECONDS: "0" },
        timeout: 10_000,
      });
    } catch (error) {
      output = `${error.stdout || ""}${error.stderr || ""}`;
      exitCode = error.status;
    }

    expect(exitCode).toBe(1);
    expect(output).toContain("capped at 0 attempt");
    expect(output).not.toContain("never completed its startup handshake");
    expect(output).toContain("update-bundle.json");
    expect(output).toContain("ZomboidControlPanel.bundle-previous");
    expect(output).toContain("client/dist.previous");
    expect(fs.existsSync(path.join(root, "update-bundle.json"))).toBe(true);
  }, 10_000);

  // Self-directed sibling check of the Q6 fix (2026-09-08): Start.bat
  // already special-cases exit code 78 (utils/pidLock.js's cross-platform
  // application-level single-instance lock refusing to start because
  // another live instance already holds it) -- it stops immediately
  // instead of entering its crash-loop backoff, because retrying a
  // guaranteed-identical refusal would misrepresent a working refusal as a
  // string of crashes. generateStartSh() had no equivalent. This exercises
  // the fix: a single exit-78 run must stop immediately (propagate 78, zero
  // relaunch attempts logged), not be treated like an ordinary crash.
  it("stops immediately on exit code 78 (single-instance lock refusal) instead of crash-looping", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-supervisor-lockrefusal-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "start.sh"), generateStartSh(), { mode: 0o755 });
    fs.writeFileSync(path.join(root, "ZomboidControlPanel"), "#!/bin/sh\nexit 78\n", { mode: 0o755 });

    let output;
    let exitCode = 0;
    try {
      output = execFileSync("bash", ["start.sh"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PANEL_SUPERVISOR_MAX_CRASHES: "2", PANEL_SUPERVISOR_BACKOFF_SECONDS: "0" },
        timeout: 10_000,
      });
    } catch (error) {
      output = `${error.stdout || ""}${error.stderr || ""}`;
      exitCode = error.status;
    }

    expect(exitCode).toBe(78);
    expect(output).toContain("Another panel instance already holds the lock");
    expect(output).not.toContain("relaunch attempt");
    expect(output).not.toContain("giving up");
  }, 15_000);

  // Q6/Q4 gap found in the same read (2026-09-08): KillMode=process is
  // deliberate and correct (it's what the FIRST test above proves), but a
  // shutdown slow enough to hit systemd's TimeoutStopSec escalates to
  // SIGKILL, which no process can trap -- the wrapper dies instantly, its
  // already-detached panel child survives as an orphan, and
  // Restart=on-failure then launches a competing second instance against
  // the same data directory. These exercise the fix: a startup guard that
  // checks a pidfile for a still-live PREVIOUS instance, verified by
  // /proc/<pid>/cmdline (not just the bare PID number, which the kernel can
  // recycle) before ever signaling it.
  const orphanPids = [];
  afterEach(() => {
    for (const pid of orphanPids.splice(0)) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* already stopped */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
    }
  });

  function writeLauncherAndPanel(root, panelScript) {
    fs.writeFileSync(path.join(root, "start.sh"), generateStartSh(), { mode: 0o755 });
    fs.writeFileSync(path.join(root, "ZomboidControlPanel"), panelScript, { mode: 0o755 });
  }

  async function spawnOrphan(root, panelScript, pidFile) {
    fs.writeFileSync(path.join(root, "ZomboidControlPanel"), panelScript, { mode: 0o755 });
    const child = spawn("setsid", ["./ZomboidControlPanel"], { cwd: root, stdio: "ignore" });
    await waitForFile(path.join(root, pidFile));
    const pid = Number(fs.readFileSync(path.join(root, pidFile), "utf8").trim());
    orphanPids.push(pid);
    return pid;
  }

  it("reclaims a live orphaned instance (responds to TERM) and starts cleanly", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-supervisor-reclaim-"));
    roots.push(root);
    const orphanPid = await spawnOrphan(
      root,
      "#!/bin/sh\necho $$ > mark.pid\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n",
      "mark.pid",
    );
    fs.writeFileSync(path.join(root, ".supervisor.pid"), String(orphanPid));
    writeLauncherAndPanel(root, "#!/bin/sh\necho started > started.marker\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n");

    const supervisor = spawn("bash", ["start.sh"], { cwd: root, stdio: "pipe" });
    let output = "";
    supervisor.stdout.on("data", (d) => { output += d; });
    supervisor.stderr.on("data", (d) => { output += d; });
    await waitForFile(path.join(root, "started.marker"));

    expect(output).toContain(`WARNING: a panel instance (PID ${orphanPid})`);
    expect(output).toContain(`Previous instance (PID ${orphanPid}) stopped`);
    expect(() => process.kill(orphanPid, 0)).toThrow();

    supervisor.kill("SIGTERM");
    await new Promise((resolve) => supervisor.once("close", resolve));
  }, 10_000);

  it("refuses to start (once, no loop) when the orphaned instance ignores TERM, and never touches it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-supervisor-refuse-"));
    roots.push(root);
    const orphanPid = await spawnOrphan(
      root,
      "#!/bin/sh\necho $$ > mark.pid\ntrap '' TERM\nwhile :; do sleep 1; done\n",
      "mark.pid",
    );
    fs.writeFileSync(path.join(root, ".supervisor.pid"), String(orphanPid));
    writeLauncherAndPanel(root, "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n");

    let output;
    let exitCode = 0;
    try {
      output = execFileSync("bash", ["start.sh"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PANEL_SUPERVISOR_RECLAIM_TIMEOUT_SECONDS: "2" },
        timeout: 10_000,
      });
    } catch (error) {
      // Refusing to start is the expected outcome -- a nonzero exit.
      output = `${error.stdout || ""}${error.stderr || ""}`;
      exitCode = error.status;
    }

    expect(exitCode).toBe(1);
    expect(output).toContain(`ERROR: an existing panel instance (PID ${orphanPid}) is still running`);
    expect(output).toContain("Refusing to start a second instance");
    // Still alive: the refusal path must never escalate to a signal the
    // orphan didn't already ignore -- it backs off entirely instead.
    expect(() => process.kill(orphanPid, 0)).not.toThrow();
  }, 10_000);

  it("says nothing about reclaiming when the pidfile's PID is live but not the panel (PID reuse), and never signals it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-supervisor-notus-"));
    roots.push(root);
    const unrelated = spawn("sleep", ["300"], { cwd: root, stdio: "ignore" });
    orphanPids.push(unrelated.pid);
    fs.writeFileSync(path.join(root, ".supervisor.pid"), String(unrelated.pid));
    writeLauncherAndPanel(root, "#!/bin/sh\necho started > started.marker\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n");

    const supervisor = spawn("bash", ["start.sh"], { cwd: root, stdio: "pipe" });
    let output = "";
    supervisor.stdout.on("data", (d) => { output += d; });
    supervisor.stderr.on("data", (d) => { output += d; });
    await waitForFile(path.join(root, "started.marker"));

    expect(output).not.toContain("WARNING: a panel instance");
    expect(() => process.kill(unrelated.pid, 0)).not.toThrow();

    supervisor.kill("SIGTERM");
    await new Promise((resolve) => supervisor.once("close", resolve));
  }, 10_000);

  it("the pidfile survives a SIGKILL to the wrapper (the evidence the next launch's guard needs)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-supervisor-sigkill-"));
    roots.push(root);
    writeLauncherAndPanel(root, "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n");

    const supervisor = spawn("bash", ["start.sh"], { cwd: root, stdio: "ignore" });
    await waitForFile(path.join(root, ".supervisor.pid"));
    const panelPid = Number(fs.readFileSync(path.join(root, ".supervisor.pid"), "utf8").trim());
    orphanPids.push(panelPid);

    process.kill(supervisor.pid, "SIGKILL");
    await new Promise((resolve) => supervisor.once("close", resolve));

    expect(fs.existsSync(path.join(root, ".supervisor.pid"))).toBe(true);
    expect(() => process.kill(panelPid, 0)).not.toThrow();
  }, 10_000);
});

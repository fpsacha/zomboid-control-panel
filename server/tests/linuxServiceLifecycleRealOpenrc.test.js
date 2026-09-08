// linuxServiceLifecycleRealSystemd.test.js's sibling for the OpenRC provider.
// Every other test in this suite stubs execFile and never hands the
// generated content to a real init system -- exactly how the original
// directory=/command_args= word-splitting bug (a literal space in
// installPath breaking the supervised command outright) and the OpenRC
// command-injection bug ($(...) executing through openrc-run.sh's second,
// effectively unquoted re-evaluation of those two declarative variables)
// both shipped undetected. This file is the one place that is not allowed
// to stub it: it installs the generated init script into /etc/init.d/ and
// drives it through the real `rc-service`/`supervise-daemon` toolchain.
//
// Unlike `systemd-analyze verify`, OpenRC has no side-effect-free static
// verifier -- running this test for real ACTUALLY STARTS AND STOPS A
// SUPERVISED PROCESS AS ROOT under a real system service name. That is not
// something to run against a developer's real machine or a shared CI
// runner's real root. It is gated on both real OpenRC tooling AND root, and
// is written to be safe to run inside a disposable container (Alpine +
// `apk add openrc` is what this was built and verified against) -- it is
// NOT written to be safe anywhere else, and the skip banner below says so
// loudly rather than letting a quiet skipped-count bury that distinction.
//
// A second, container-specific trap: OpenRC's supervise-daemon forks a
// long-lived supervisor process that gets reparented to PID 1 on exit. A
// container whose PID 1 does not reap zombies (a bare `CMD ["sleep",
// "infinity"]`, with no `docker run --init`) leaves that supervisor as an
// unreaped zombie forever -- `rc-service stop` then hangs indefinitely
// polling for a PID that technically still exists. This was chased down
// live and confirmed to be a test-container artifact, not a product bug:
// the exact same generated script starts, respawns, and stops cleanly in
// well under a second once the container's PID 1 reaps properly. Every
// `execFileSync` below carries an explicit `timeout` so a host missing that
// reaping fails this test loudly and fast instead of hanging CI.
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildLifecycleTemplate, getLifecycleServiceName } from "../services/linuxServiceLifecycle.js";

const INIT_D = "/etc/init.d";
const EXEC_TIMEOUT_MS = 15_000;

function hasRealOpenrc() {
  try {
    execFileSync("rc-service", ["--version"], { stdio: "ignore" });
    execFileSync("openrc-run", ["--version"], { stdio: "ignore" });
    execFileSync("supervise-daemon", [], {
      stdio: "ignore",
      env: { ...process.env, RC_SVCNAME: "probe" },
    });
    return true;
  } catch (error) {
    // supervise-daemon with no other args exits non-zero (it needs a real
    // command); that failure still proves the binary exists and ran.
    return error.code !== "ENOENT";
  }
}

const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const HAS_OPENRC = hasRealOpenrc();
const CAN_RUN = HAS_OPENRC && IS_ROOT;

if (!CAN_RUN) {
  console.warn(
    "\n" +
      "!".repeat(78) +
      "\nSKIPPING linuxServiceLifecycleRealOpenrc.test.js: " +
      (!HAS_OPENRC
        ? "real OpenRC tooling (rc-service/openrc-run/supervise-daemon) is not on this host."
        : "not running as root -- installing into /etc/init.d/ and driving rc-service requires it.") +
      "\nThe generated OpenRC script was NEVER started under a real init system on this run.\n" +
      "This is a degraded run, not a clean pass -- do not treat a green suite here as proof\n" +
      "the service actually starts, respawns, or stops. This test is invasive by design (no\n" +
      "OpenRC equivalent of `systemd-analyze verify` exists) -- run it only inside a disposable\n" +
      "container such as `alpine:latest` + `apk add openrc bash coreutils`.\n" +
      "!".repeat(78) +
      "\n",
  );
}

function writeFakeLauncher(dir) {
  const launcherPath = path.join(dir, "start-server.sh");
  // Deliberately does NOT interpolate `dir` (which for the injection CASE
  // below literally contains "$(...)") into this script's own bash source --
  // doing that with a JS template literal was tried first and produced a
  // self-inflicted false positive: bash correctly evaluates $(...) inside
  // its OWN double-quoted strings, so a fixture that bakes an attacker-
  // shaped path into its source is exploitable regardless of anything
  // buildLifecycleTemplate does. `pwd` is exactly what --chdir already
  // guarantees, and marker.log lives next to the script via $0, both
  // resolved by bash at RUN time, never by string-substituting untrusted
  // content into source text.
  fs.writeFileSync(
    launcherPath,
    "#!/bin/bash\n" +
      'echo "started cwd=$(pwd) marker_env=$ZOMBOID_PANEL_SERVER_ID" >> "$(dirname "$0")/marker.log"\n' +
      "trap 'exit 0' TERM\n" +
      "while true; do sleep 1; done\n",
    { mode: 0o755 },
  );
  return launcherPath;
}

// Each case gets its own server id, and therefore its own service name and
// pidfile -- deliberately, so no two cases ever share a pidfile. An earlier
// version of this file reused one hardcoded service name for every case and
// produced a spurious, non-reproducing "injection executed" result under
// vitest that a from-scratch manual reproduction (same generated content,
// isolated container, distinct service name) could not reproduce even once.
// Sharing one pidfile across rapid successive start/stop cycles is a known
// footgun independent of anything this file is trying to verify -- giving
// every case a fully isolated identity removes that variable entirely
// instead of leaving an ambiguous result on record.
let caseCounter = 0;
function makeServer(overrides = {}) {
  caseCounter += 1;
  return { id: `openrctest${caseCounter}`, serverName: "servertest", ...overrides };
}

function install(serviceName, content) {
  const target = path.join(INIT_D, serviceName);
  fs.writeFileSync(target, content, { mode: 0o755 });
  return target;
}

// Avoids pgrep -f entirely: some of the CASES below embed shell
// metacharacters ("$(...)") in the path we search for, which pgrep would
// interpret as ERE syntax, not a literal substring. Reading /proc directly
// and doing a plain string match sidesteps that.
function pidsWithCmdlineContaining(substring) {
  const matches = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").replace(/\0/g, " ");
      if (cmdline.includes(substring)) matches.push(entry);
    } catch {
      // process exited between readdir and read -- ignore
    }
  }
  return matches;
}

// pidsWithCmdlineContaining() alone cannot tell the supervised launcher
// apart from supervise-daemon's own monitor process: supervise-daemon's
// argv is "supervise-daemon <name> --start ... -- /bin/bash <launcherPath>",
// which itself contains launcherPath as a substring. A caller that expects
// exactly one match (identify a specific pid, not just "is anything still
// running") must filter to the process whose /proc/<pid>/comm is actually
// "bash" -- otherwise it silently matches the monitor's pid instead of the
// child it monitors.
function bashPidsWithCmdlineContaining(substring) {
  return pidsWithCmdlineContaining(substring).filter((pid) => {
    try {
      return fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "bash";
    } catch {
      return false;
    }
  });
}

function rcService(serviceName, action) {
  try {
    return {
      code: 0,
      timedOut: false,
      output: execFileSync("rc-service", [serviceName, action], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: EXEC_TIMEOUT_MS,
      }),
    };
  } catch (error) {
    return {
      code: error.status ?? 1,
      output: `${error.stdout || ""}${error.stderr || ""}`,
      timedOut: Boolean(error.signal),
    };
  }
}

// Every service name this file has installed in this run, so afterEach can
// unconditionally tear all of them down regardless of which test is
// current -- a test that fails before recording its own name must not leak
// a running service into the next one.
const installedServiceNames = new Set();

function cleanupAll() {
  for (const serviceName of installedServiceNames) {
    try {
      execFileSync("rc-service", [serviceName, "stop"], {
        stdio: "ignore",
        timeout: EXEC_TIMEOUT_MS,
      });
    } catch {
      // best-effort -- the service may already be stopped or never started
    }
    fs.rmSync(path.join(INIT_D, serviceName), { force: true });
  }
  installedServiceNames.clear();
}

const describeRealOpenrc = CAN_RUN ? describe : describe.skip;

describeRealOpenrc(
  "linuxServiceLifecycle OpenRC provider -- verified against REAL rc-service/supervise-daemon (SKIPPED: see banner above if this line is not running)",
  () => {
    let tmpDir;

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-openrc-verify-"));
    });

    afterEach(() => {
      cleanupAll();
    });

    // The three shapes that actually mattered: the plain case proves the
    // redesign didn't regress the common path, the space is the exact
    // reported bug ("supervise-daemon: server does not exist"), and the
    // $(...) payload is the exact injection payload that executed through
    // the old directory=/command_args= second-pass re-evaluation despite
    // being correctly POSIX-single-quoted for the first pass. Each case uses
    // a distinct marker file name too, so a case run out of order (or a
    // leftover from a prior failed run) can't produce a false positive by
    // finding a stale file this case didn't itself create.
    const CASES = [
      { label: "plain path, no special characters", dirName: "plain", pwnedMarker: null },
      { label: "path containing a space", dirName: "pz server", pwnedMarker: null },
      {
        label: "path containing a $(...) injection payload",
        dirName: "pz$(touch /tmp/openrc-pwned-case3)server",
        pwnedMarker: "/tmp/openrc-pwned-case3",
      },
    ];

    for (const { label, dirName, pwnedMarker } of CASES) {
      it(`starts, is supervised, and stops cleanly through real rc-service -- ${label}`, () => {
        if (pwnedMarker) fs.rmSync(pwnedMarker, { force: true });
        const workDir = path.join("/tmp", dirName);
        fs.mkdirSync(workDir, { recursive: true });
        const launcherPath = writeFakeLauncher(workDir);

        const server = makeServer({ installPath: workDir });
        const serviceName = getLifecycleServiceName(server);
        const template = buildLifecycleTemplate(
          server,
          "openrc",
          { fileExists: (candidate) => candidate === path.join(workDir, "start-server.sh") },
        );
        expect(template.filename).toBe(serviceName);
        installedServiceNames.add(serviceName);
        install(serviceName, template.content);

        const start = rcService(serviceName, "start");
        expect(start.timedOut, `rc-service start hung: ${start.output}`).toBe(false);
        expect(start.code, `rc-service start failed: ${start.output}`).toBe(0);

        // The injection payload must never have executed.
        if (pwnedMarker) expect(fs.existsSync(pwnedMarker)).toBe(false);

        const markerLog = path.join(workDir, "marker.log");
        expect(fs.existsSync(markerLog)).toBe(true);
        const marker = fs.readFileSync(markerLog, "utf8");
        // The launcher's own $(pwd) must equal the literal working
        // directory, byte for byte -- proves --chdir received the value
        // unmangled, not word-split.
        expect(marker).toContain(`cwd=${workDir}`);
        expect(marker).toContain(`marker_env=${server.id}`);

        const stop = rcService(serviceName, "stop");
        expect(stop.timedOut, `rc-service stop hung: ${stop.output}`).toBe(false);
        expect(stop.code, `rc-service stop failed: ${stop.output}`).toBe(0);

        expect(pidsWithCmdlineContaining(launcherPath)).toEqual([]);
      });
    }

    it("respawns the supervised process after it is killed (respawn_delay=5, respawn_max=0)", () => {
      const workDir = path.join(tmpDir, "respawn");
      fs.mkdirSync(workDir, { recursive: true });
      const launcherPath = writeFakeLauncher(workDir);

      const server = makeServer({ installPath: workDir });
      const serviceName = getLifecycleServiceName(server);
      const template = buildLifecycleTemplate(
        server,
        "openrc",
        { fileExists: (candidate) => candidate === path.join(workDir, "start-server.sh") },
      );
      installedServiceNames.add(serviceName);
      install(serviceName, template.content);

      const start = rcService(serviceName, "start");
      expect(start.code, `rc-service start failed: ${start.output}`).toBe(0);

      // Must use the bash-filtered lookup, not the raw one: supervise-daemon's
      // own argv contains launcherPath too (it's the last thing on its command
      // line), so the raw helper can return the MONITOR's pid ahead of the
      // actual child's, depending on /proc readdir order. Killing that instead
      // of the launcher would silently invalidate this entire test -- nothing
      // would actually be killed-and-respawned, supervise-daemon would just be
      // decapitated, leaving its already-running child to be misread as a
      // "respawn" a moment later, and orphaned (reparented to PID 1) once
      // `stop` fails to find a live monitor to ask.
      const [firstPid] = bashPidsWithCmdlineContaining(launcherPath);
      expect(firstPid).toMatch(/^\d+$/);

      execFileSync("kill", ["-9", firstPid], { timeout: EXEC_TIMEOUT_MS });

      // respawn_delay=5 means the respawned process cannot appear before
      // ~5s; poll instead of a single fixed sleep so this isn't flaky on a
      // slower host, but fail well before the outer test timeout if it
      // never comes back.
      let secondPid;
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        const [candidate] = bashPidsWithCmdlineContaining(launcherPath);
        if (candidate && candidate !== firstPid) {
          secondPid = candidate;
          break;
        }
        execFileSync("sleep", ["0.2"], { timeout: EXEC_TIMEOUT_MS });
      }

      expect(secondPid, "supervise-daemon never respawned the killed process").toMatch(/^\d+$/);
      expect(secondPid).not.toBe(firstPid);

      const stop = rcService(serviceName, "stop");
      expect(stop.code, `rc-service stop failed: ${stop.output}`).toBe(0);

      // The respawned child must actually be gone too, not just the
      // supervisor -- this is the assertion the pre-fix version never made,
      // which is exactly how the pid-identification bug above went unnoticed:
      // the test could kill the wrong process, "stop" could leave the real
      // child running, and nothing here would fail.
      expect(bashPidsWithCmdlineContaining(launcherPath)).toEqual([]);
    }, 20_000);

    it("does not corrupt a description containing a literal $ with a spurious backslash", () => {
      // name=/description= were never part of openrc-run.sh's declarative
      // command line and so were never subject to its second-pass
      // re-evaluation -- but the old quoteShell() escaped "$" anyway (it was
      // needed only for directory=/command_args=), producing a real,
      // reproduced bug: `rc-service start` echoed the literal text
      // "\$CoolServer" instead of "$CoolServer".
      const workDir = path.join(tmpDir, "dollar-name");
      fs.mkdirSync(workDir, { recursive: true });
      writeFakeLauncher(workDir);

      const server = makeServer({ name: "Alpha $CoolServer", installPath: workDir });
      const serviceName = getLifecycleServiceName(server);
      const template = buildLifecycleTemplate(
        server,
        "openrc",
        { fileExists: (candidate) => candidate === path.join(workDir, "start-server.sh") },
      );
      installedServiceNames.add(serviceName);
      install(serviceName, template.content);

      const start = rcService(serviceName, "start");
      expect(start.code, `rc-service start failed: ${start.output}`).toBe(0);
      expect(start.output).toContain("$CoolServer");
      expect(start.output).not.toContain("\\$CoolServer");

      const stop = rcService(serviceName, "stop");
      expect(stop.code, `rc-service stop failed: ${stop.output}`).toBe(0);
    });
  },
);

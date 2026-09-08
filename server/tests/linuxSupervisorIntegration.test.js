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

  // Q3/Q5 gap found reading generateStartSh() end to end (2026-09-08): the
  // journal-driven auto-rollback only catches ONE failure shape (a staged
  // bundle/version mismatch) -- a crash from any other cause exhausts the
  // crash-loop with a generic give-up message that has zero awareness a
  // pending update backup even exists. This exercises the fix: when the
  // loop gives up, a note naming update-bundle.json and
  // ZomboidControlPanel.bundle-previous appears IF AND ONLY IF both are
  // still on disk -- deliberately just existence, no JSON parsing, matching
  // restore_interrupted_update()'s own house style above.
  function writeCrashingPanel(root) {
    fs.writeFileSync(
      path.join(root, "ZomboidControlPanel"),
      "#!/bin/sh\nexit 1\n",
      { mode: 0o755 },
    );
  }

  function runToExhaustion(root) {
    fs.writeFileSync(path.join(root, "start.sh"), generateStartSh(), { mode: 0o755 });
    writeCrashingPanel(root);
    try {
      return execFileSync("bash", ["start.sh"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PANEL_SUPERVISOR_MAX_CRASHES: "2", PANEL_SUPERVISOR_BACKOFF_SECONDS: "0" },
        timeout: 10_000,
      });
    } catch (error) {
      // A nonzero exit is the expected outcome (giving up propagates the
      // panel's own last exit code) -- the captured output is what matters.
      return `${error.stdout || ""}${error.stderr || ""}`;
    }
  }

  it("names the pending update backup on give-up when one is still on disk", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-supervisor-giveup-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "ZomboidControlPanel.bundle-previous"), "old-binary-bytes");
    fs.writeFileSync(path.join(root, "update-bundle.json"), JSON.stringify({ phase: "awaiting_startup_ack" }));

    const output = runToExhaustion(root);

    expect(output).toContain("giving up");
    expect(output).toContain("A pending update journal");
    expect(output).toContain("mv ZomboidControlPanel.bundle-previous ZomboidControlPanel");
    expect(output).toContain("rm -f update-bundle.json");
  }, 15_000);

  it("says nothing about a backup on give-up when there is no pending update", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-supervisor-giveup-clean-"));
    roots.push(root);

    const output = runToExhaustion(root);

    expect(output).toContain("giving up");
    expect(output).not.toContain("pending update journal");
    expect(output).not.toContain("bundle-previous");
  }, 15_000);
});

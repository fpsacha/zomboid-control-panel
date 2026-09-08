import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";

// Real database module, not mocked -- the globalSetup already redirects
// dataDir into a throwaway temp root for the whole suite (same pattern
// db-tmp-cleanup.test.js uses), so persisting through the real
// getSetting/setSetting round-trip here is safe and stronger evidence than
// a mocked one.
const { getSetting, setSetting } = await import("../database/init.js");
const {
  getActiveSteamOperations,
  clearActiveSteamOperation,
  hasActiveSteamOperation,
  recordActiveSteamOperationPid,
  rehydrateActiveSteamOperationsFromDisk,
} = await import("../services/activeSteamOperations.js");

const SETTING_KEY = "activeSteamOperations";

/** A pid guaranteed dead: spawn a trivial child and wait for it to exit. */
function getDeadPid() {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  return result.pid;
}

function resetMap() {
  for (const key of [...getActiveSteamOperations().keys()]) {
    getActiveSteamOperations().delete(key);
  }
}

describe("activeSteamOperations survives a panel crash: persisted mirror + startup rehydration", () => {
  afterEach(async () => {
    resetMap();
    await setSetting(SETTING_KEY, {});
  });

  // 2026-09-08, god's ruling on the game-server-autoupdate-sweep: don't
  // build a new persistence layer, prove the existing settings store (the
  // same one lastAutoUpdateResult already goes through) can carry one more
  // field. This is that proof, end to end: claim, persist, crash (simulated
  // by wiping the in-memory Map without going through a real release),
  // rehydrate, and confirm the guard is exactly as effective as it was
  // before the "crash".
  it("persists pid/type/startTime on claim, keyed by normalized path", async () => {
    getActiveSteamOperations().set("c:\\pzserver", {
      type: "install",
      startTime: 1234,
    });

    await recordActiveSteamOperationPid("c:\\pzserver", 999);

    const snapshot = await getSetting(SETTING_KEY);
    expect(snapshot).toMatchObject({
      "c:\\pzserver": { pid: 999, type: "install", startTime: 1234 },
    });
  });

  it("clears the persisted entry when the operation is released", async () => {
    getActiveSteamOperations().set("c:\\pzserver", { type: "install", startTime: 1 });
    await recordActiveSteamOperationPid("c:\\pzserver", 999);
    expect(await getSetting(SETTING_KEY)).toHaveProperty("c:\\pzserver");

    clearActiveSteamOperation("c:\\pzserver");
    // clearActiveSteamOperation() is deliberately fire-and-forget for its
    // persistence half (a synchronous function predating the mirror) --
    // give its internal promise a tick to actually land before reading.
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    expect(await getSetting(SETTING_KEY)).not.toHaveProperty("c:\\pzserver");
  });

  it("rehydrates a still-alive operation from disk and the existing guard blocks on it", async () => {
    // process.pid (this test's own process) is unambiguously alive.
    await setSetting(SETTING_KEY, {
      "c:\\pzserver": { pid: process.pid, type: "auto-update", startTime: 1 },
    });
    // Simulates the panel process having crashed and restarted: the
    // in-memory Map is empty, exactly like a fresh module load.
    resetMap();
    expect(hasActiveSteamOperation("c:\\pzserver")).toBe(false);

    await rehydrateActiveSteamOperationsFromDisk();

    expect(hasActiveSteamOperation("c:\\pzserver")).toBe(true);
  });

  it("self-heals a dead pid found on disk instead of blocking forever", async () => {
    const deadPid = getDeadPid();
    await setSetting(SETTING_KEY, {
      "c:\\pzserver": { pid: deadPid, type: "install", startTime: 1 },
    });
    resetMap();

    await rehydrateActiveSteamOperationsFromDisk();

    // hasActiveSteamOperation()'s own pre-existing self-heal logic (not
    // duplicated here) is what actually clears the stale in-memory entry
    // on this call -- this asserts the REHYDRATED entry doesn't survive
    // contact with it, the same as any other stale entry wouldn't.
    expect(hasActiveSteamOperation("c:\\pzserver")).toBe(false);
  });

  it("ignores a malformed or missing persisted snapshot without throwing", async () => {
    await setSetting(SETTING_KEY, null);
    await expect(rehydrateActiveSteamOperationsFromDisk()).resolves.toBeUndefined();

    await setSetting(SETTING_KEY, { "c:\\pzserver": { type: "install" } }); // no pid
    await expect(rehydrateActiveSteamOperationsFromDisk()).resolves.toBeUndefined();
    expect(hasActiveSteamOperation("c:\\pzserver")).toBe(false);
  });
});

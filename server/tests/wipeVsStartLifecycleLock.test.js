import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 2026-09-05, host-suspend-resume sweep (god's dispatch): world wipe checked
// "stopped" BEFORE its multi-minute pre-wipe backup, held no lock a
// concurrent /start could also see, then rmSync'd the save tree -- a Start
// fired during the backup passed the wipe's own stopped-check clean and this
// wipe went on to delete a save tree that was, by the time rmSync ran, live
// under a running server. Fixed by having /wipe take the SAME process-wide
// lifecycle lock /start, /stop, /restart already take (Kevin's restoreBackup()
// fix, backupService.js:1439, is the twin for the restore path -- same lock,
// same shape). This test proves the lock is actually held across exactly the
// window god described (stopped-check -> backup -> destructive delete), by
// suspending the backup step mid-flight and confirming a concurrent lock
// acquisition (what /start's own handler does first, before anything else)
// is refused for the whole suspension, then succeeds once the wipe finishes.

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(),
  setSetting: vi.fn(),
  getSetting: vi.fn(),
  getActiveServer: vi.fn(async () => ({ name: "servertest" })),
}));

const { default: router } = await import("../routes/server.js");
const { acquireLifecycleLock } = await import(
  "../services/lifecycleCoordinator.js"
);

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getWipeHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/wipe" && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

const SERVER_NAME = "servertest";
let root;
let savePath;
let saveDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-wipe-lock-"));
  savePath = root;
  saveDir = path.join(savePath, "Saves", "Multiplayer", SERVER_NAME);
  fs.mkdirSync(path.join(saveDir, "map"), { recursive: true });
  fs.writeFileSync(path.join(saveDir, "map", "0_0.bin"), "chunk");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("POST /api/server/wipe holds the shared lifecycle lock across its backup+delete window", () => {
  it("refuses a concurrent /start-shaped lock acquisition until the wipe finishes, then allows one", async () => {
    let releaseBackup;
    let backupEntered;
    const backupReached = new Promise((r) => {
      backupEntered = r;
    });
    const backupService = {
      createBackup: () =>
        new Promise((resolve) => {
          releaseBackup = () => resolve({ success: true, skippedFiles: [] });
          backupEntered();
        }),
      getBackupsPath: async () => "/tmp/backups",
    };

    const serverManager = {
      loadConfig: async () => {},
      getServerProcessDetails: async () => ({
        running: false,
        scanFailed: false,
      }),
      savePath,
      serverName: SERVER_NAME,
    };

    const handler = getWipeHandler();
    const response = createResponse();
    const request = {
      app: {
        get: (key) =>
          key === "serverManager"
            ? serverManager
            : key === "backupService"
              ? backupService
              : undefined,
      },
      body: { targets: ["map"], confirm: true, createBackup: true },
    };

    const wipeCall = handler(request, response);
    // Let the wipe pass getActiveServer(), loadConfig(),
    // getServerProcessDetails() and reach the (suspended) backup call --
    // each is its own microtask tick. Awaiting an explicit "entered
    // createBackup" signal instead of polling `releaseBackup` keeps this
    // deterministic and, if a future edit stops the handler from ever
    // reaching createBackup() (a new guard, a changed precondition), fails
    // on an unresolved await at the suite's timeout with `backupReached`
    // named in the trace -- instead of a `while` loop that would just spin
    // until the same timeout with no indication of where it got stuck.
    await backupReached;

    // This is exactly what /start's own handler does as its very first
    // action, before touching anything else -- see routes/server.js's
    // POST /start.
    const startAttempt = acquireLifecycleLock("start", "servertest");
    expect(startAttempt).toBeNull();

    releaseBackup();
    await wipeCall;

    // Wipe's own finally released the lock -- a real /start now succeeds.
    const startAfterWipe = acquireLifecycleLock("start", "servertest");
    expect(startAfterWipe).not.toBeNull();
    startAfterWipe.release();
  });
});

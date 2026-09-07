import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// bug hunt 2026-09-07 (round 6, "files nobody has opened" sweep): two
// Date.now()-as-elapsed-time gates in modChecker.js, same bug class as
// services/panelBridge.js's tryResyncOutboxCursor and routes/mods.js's
// acquireScanLock -- an in-memory start marker captured with Date.now(),
// later compared against a fresh Date.now() to decide "has enough time
// passed". A wall-clock step BACKWARD (NTP correction, DST, manual clock
// change) between the two reads makes the elapsed value stay small/
// negative forever, wedging the gate open until real wall-clock time
// closes whatever gap the jump introduced. Both fixed with performance.now()
// (monotonic, cannot step backward).

vi.mock("../database/init.js", () => ({
  getTrackedMods: vi.fn(async () => []),
  updateModTimestamp: vi.fn(),
  logServerEvent: vi.fn(),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(),
  addTrackedMod: vi.fn(),
  getActiveServer: vi.fn(async () => null),
  isModIgnored: vi.fn(async () => false),
  markModsChecked: vi.fn(),
}));

const { ModChecker } = await import("../services/modChecker.js");

function writeAcfFixture(acfPath, { workshopId, timeupdated, latestTimeupdated }) {
  fs.mkdirSync(path.dirname(acfPath), { recursive: true });
  fs.writeFileSync(
    acfPath,
    `"AppWorkshop"
{
	"appid"		"108600"
	"WorkshopItemsInstalled"
	{
		"${workshopId}"
		{
			"size"		"1234"
			"timeupdated"		"${timeupdated}"
		}
	}
	"WorkshopItemDetails"
	{
		"${workshopId}"
		{
			"timeupdated"		"${timeupdated}"
			"latest_timeupdated"		"${latestTimeupdated}"
		}
	}
}
`,
  );
}

describe("modChecker.js elapsed-time gates: immune to a wall-clock backward jump", () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "modchecker-clockjump-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("startup grace period releases once real (monotonic) time exceeds startupGraceMs, even if Date.now() has stepped backward", async () => {
    let mockPerfNow = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => mockPerfNow);
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    const acfPath = path.join(tempRoot, "appworkshop_108600.acf");
    writeAcfFixture(acfPath, {
      workshopId: "3333333333",
      timeupdated: 1000,
      latestTimeupdated: 2000,
    });

    const checker = new ModChecker();
    checker.workshopAcfPath = acfPath;
    checker.fetchSteamTimestamps = vi.fn(async () => new Map());
    checker.onUpdateCallback = vi.fn(async () => ({ markProcessed: true }));
    // Simulate start() having just run.
    checker.startedAt = performance.now();

    // Still inside the 2-minute grace window: callback must NOT fire.
    await checker.checkForUpdates();
    expect(checker.onUpdateCallback).not.toHaveBeenCalled();

    // Wall clock steps backward by a huge amount while real, monotonic
    // time advances past startupGraceMs (120000ms).
    Date.now.mockReturnValue(-1_000_000_000);
    mockPerfNow += 120_001;

    await checker.checkForUpdates();
    expect(checker.onUpdateCallback).toHaveBeenCalled();
  });

  it("player-monitoring max-delay watchdog fires once real (monotonic) time exceeds maxDelayMinutes, even if Date.now() has stepped backward", async () => {
    let mockPerfNow = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => mockPerfNow);
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    const checker = new ModChecker();
    checker.maxDelayMinutes = 30; // default; explicit for clarity
    checker.getOnlinePlayerCount = vi.fn(async () => 3); // players never leave
    checker.triggerModRestart = vi.fn(async () => ({ success: true }));

    let capturedTick;
    vi.spyOn(global, "setInterval").mockImplementation((cb) => {
      capturedTick = cb;
      return 1;
    });

    checker.startPlayerMonitoring([{ workshopId: "3333333333" }]);
    expect(typeof capturedTick).toBe("function");

    // A tick well before max-wait: watchdog must NOT force a restart.
    mockPerfNow += 5 * 60 * 1000; // 5 minutes
    await capturedTick();
    expect(checker.triggerModRestart).not.toHaveBeenCalled();

    // Wall clock steps backward hugely while real, monotonic time advances
    // past maxDelayMinutes (30 min = 1,800,000ms).
    Date.now.mockReturnValue(-1_000_000_000);
    mockPerfNow += 30 * 60 * 1000 + 1;

    await capturedTick();
    expect(checker.triggerModRestart).toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { autoExportPlayer } from "../index.js";
import { getDataPaths } from "../utils/paths.js";
import { setSetting } from "../database/init.js";
import panelBridge from "../services/panelBridge.js";

// 2026-09-06 (kevin, ms-filename-sweep, autoexportplayer-collision-rotation-
// has-no-test card): autoExportPlayer()'s export-file name is built from
// `new Date().toISOString()`, millisecond-resolution -- two auto-exports for
// the same player landing in the same millisecond (a rapid disconnect/
// reconnect scheduling two 10-second-delayed timers close together) used to
// silently overwrite one export with the other. The fix (server/index.js,
// ~line 2196) adds a check-and-increment `-<n>` collision suffix, same
// pattern as database/init.js's db.json backup ring and templateFiles.js's
// server.ini/SandboxVars backup.
//
// PRE-FIX BREAK-VERIFY, done by hand while writing this test (not
// automated): reverting the write to the earlier abandoned first draft
// (suffix appended AFTER ".json" instead of before) makes "places the
// collision suffix before the .json extension" fail -- the written filename
// stops matching the test's `-2.json` assertion. Separately, reverting only
// the rotation's sort back to a raw `.sort().reverse()` on filename strings
// (leaving the write fix in place) makes "keeps the genuinely newest file
// across a collision" fail -- a raw string sort orders "name-2.json" BEFORE
// "name.json" ('-' < '.'), so `.reverse()` treats the ORIGINAL of a
// collision pair as newer than the duplicate that actually collided with
// and superseded it, and rotation deletes the wrong one.
describe("autoExportPlayer: same-millisecond collision", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    panelBridge.isRunning = false;
  });

  function mockConnectedBridge(...exportedPayloads) {
    panelBridge.isRunning = true;
    vi.spyOn(panelBridge, "isModConnected").mockReturnValue(true);
    const sendCommand = vi.spyOn(panelBridge, "sendCommand");
    for (const data of exportedPayloads) {
      sendCommand.mockResolvedValueOnce({ success: true, data });
    }
    return sendCommand;
  }

  function freezeClock(isoString) {
    const fixedNow = new Date(isoString);
    const realToISOString = Date.prototype.toISOString;
    return vi.spyOn(Date.prototype, "toISOString").mockImplementation(
      function () {
        return realToISOString.call(fixedNow);
      },
    );
  }

  function exportDirFor(username) {
    const { dataDir } = getDataPaths();
    return path.join(dataDir, "exports", username);
  }

  it("places the collision suffix before the .json extension, not after", async () => {
    freezeClock("2026-09-06T12:00:00.000Z");
    mockConnectedBridge({ marker: "first" }, { marker: "second" });

    await autoExportPlayer("CollisionUser");
    await autoExportPlayer("CollisionUser");

    // NOT `.sort()`-ordered: '-' < '.' means the collision-suffixed name
    // sorts BEFORE the plain one alphabetically -- the exact quirk this
    // fix's rotation sort has to account for. Identify by pattern instead.
    const files = fs.readdirSync(exportDirFor("CollisionUser"));
    expect(files).toHaveLength(2);

    // Timestamps always end in literal "Z" (toISOString()'s own format);
    // only a collision suffix can put a digit immediately before ".json".
    const plainFile = files.find((f) => /Z\.json$/.test(f));
    const collidedFile = files.find((f) => /-2\.json$/.test(f));
    expect(plainFile).toBeTruthy();
    expect(collidedFile).toBeTruthy();
    // The bug this pins: an earlier draft appended "-2" AFTER ".json"
    // (producing "..._<timestamp>.json-2"), which does not end in ".json"
    // at all and was silently invisible to the rotation filter below.
    expect(collidedFile.endsWith(".json")).toBe(true);
  });

  it("keeps the genuinely newest file across a collision, not the original", async () => {
    await setSetting("autoExportMaxPerPlayer", 1);
    freezeClock("2026-09-06T13:00:00.000Z");
    mockConnectedBridge({ marker: "older" }, { marker: "newer" });

    await autoExportPlayer("RotationUser");
    await autoExportPlayer("RotationUser");

    const dir = exportDirFor("RotationUser");
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);

    const survivor = JSON.parse(
      fs.readFileSync(path.join(dir, files[0]), "utf-8"),
    );
    // The bug this pins: a raw filename-string sort orders "name-2.json"
    // before "name.json" ('-' < '.'), so `.sort().reverse()` ranks the
    // FIRST (older) write of a collision pair as newer than the SECOND
    // (actually newer) one, and rotation deletes the wrong file.
    expect(survivor.marker).toBe("newer");
    expect(files[0]).toMatch(/-2\.json$/);
  });
});

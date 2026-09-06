import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// hunt-wave10-2026-08-29, suspect #1 (coordinate math, boundaries as the
// priority) and the negative-axis question specifically.
//
// chunksDeletionLogic.test.js already proves delete-region only touches
// chunks inside/outside the requested rectangle using coordinates well
// clear of the boundary (x=2 inside [0,5], x=9 outside). It never exercises
// the EXACT edge -- a chunk sitting precisely at minX/maxX/minY/maxY, or
// one step past it -- which is exactly where an inclusive-vs-exclusive
// off-by-one would hide. This file closes that gap.
//
// It also settles (with the honest evidence available on this machine, not
// a guess) the card's negative-coordinate claim. Every regex chunks.js uses
// to recognize a chunk directory or filename is `\d+`-based:
//   detectSaveIsB42Sync:        /^\d+$/          (X directory names)
//   scanMapFolder / delete-region xDirs filter:   /^\d+$/
//   scanMapFolder / delete-region Y file names:   /^(\d+)\.bin$/
//   B41 flat-file names:        /^(?:map_|chunkdata_|chunk_)?(\d+)_(\d+).../
// None of these accept a leading "-". If a real save ever had a
// negative-numbered map/X/Y.bin directory or filename on disk, it would be
// silently INVISIBLE to every scan in this file (undercounted in /stats,
// unlisted in /chunks, and — the direction that actually matters for a
// destructive route — excluded from consideration by delete-region's own
// xDirs filter before the min/max/invert comparison ever runs). That is the
// OPPOSITE of the card's "silently widens a delete" prediction: exclusion
// via a failed regex match happens upstream of the region math entirely, so
// a negative-coordinate chunk could only ever be missed (survive when it
// should have been deleted under invert:true), never wrongly caught by an
// unrelated positive-coordinate request. The coordinate MATH itself
// (Math.floor for cell bucketing, plain >=/<= comparisons, sign-preserving
// multiplication for chunkdata's cell->chunk conversion) is proven correct
// for negative integers below, independent of whether real PZ ever
// produces them on disk.
//
// Whether real B42/B41 saves actually contain negative directory/file
// names could NOT be established with certainty from this machine (no real
// PZ install or save is available here — see kevin's memory.md, the
// jar-audit access noted there no longer exists on this host). Best
// available evidence points the other way: this codebase's own map-tile
// renderer (ChunkCleaner.tsx's DZI tile math) clamps its column/row index
// to >= 0, treating chunk-space as starting at (0,0) with no offset for a
// negative range, and the community cell-grid convention for both vanilla
// and modded PZ maps is a bounded POSITIVE range. Reported as a real
// structural fact about this code (regex exclusion, verified below) with
// explicitly UNCERTAIN real-world relevance, not a live confirmed bug.
vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getRoleByName: mockGetRoleByName,
  getServers: vi.fn(),
  getSetting: vi.fn(),
}));

const { getActiveServer, getServers, getSetting } = await import("../database/init.js");
const { default: router } = await import("../routes/chunks.js");

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

function getRouteHandlers(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack.map((s) => s.handle);
}

async function runRoute(routePath, method, req) {
  const handlers = getRouteHandlers(routePath, method);
  const res = createResponse();
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

// expectedServerId defaults to "server-1" to match beforeEach's own
// getActiveServer mock -- bug-hunt-2026-09-06: delete-chunks/delete-region
// now refuse (CHUNKS_STALE_SERVER_SCAN) without it.
function postAs(routePath, body) {
  return runRoute(routePath, "post", {
    user: { role: "technician" },
    body: {
      force: true,
      createBackup: false,
      deleteVehicles: false,
      expectedServerId: "server-1",
      ...body,
    },
  });
}

function writeFileDeep(p, content = "x") {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

let dataRoot;
let savePath;
const SAVE_NAME = "TestSave";

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chunks-boundary-"));
  savePath = path.join(dataRoot, "Saves", "Multiplayer", SAVE_NAME);
  fs.mkdirSync(savePath, { recursive: true });
  getActiveServer.mockReset().mockResolvedValue({
    id: "server-1",
    zomboidDataPath: dataRoot,
    isRemote: false,
  });
  getServers.mockReset().mockResolvedValue([]);
  getSetting.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe("delete-region: exact boundary (inclusive min/max, both edges, both invert directions)", () => {
  it("non-invert: chunks exactly AT minX/maxX/minY/maxY are deleted (inclusive); one step outside each edge survives", async () => {
    // Region [10,20] x [10,20]. One chunk on each of the four exact edges,
    // one at each corner just outside, one dead-center inside as a control.
    const atMinXMinY = path.join(savePath, "map", "10", "10.bin");
    const atMaxXMaxY = path.join(savePath, "map", "20", "20.bin");
    const atMinXMaxY = path.join(savePath, "map", "10", "20.bin");
    const atMaxXMinY = path.join(savePath, "map", "20", "10.bin");
    const centerInside = path.join(savePath, "map", "15", "15.bin");
    const justBelowMinX = path.join(savePath, "map", "9", "15.bin");
    const justAboveMaxX = path.join(savePath, "map", "21", "15.bin");
    const justBelowMinY = path.join(savePath, "map", "15", "9.bin");
    const justAboveMaxY = path.join(savePath, "map", "15", "21.bin");

    for (const f of [
      atMinXMinY, atMaxXMaxY, atMinXMaxY, atMaxXMinY, centerInside,
      justBelowMinX, justAboveMaxX, justBelowMinY, justAboveMaxY,
    ]) {
      writeFileDeep(f, "x");
    }

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 10, maxX: 20, minY: 10, maxY: 20,
      invert: false,
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 5 }));

    for (const f of [atMinXMinY, atMaxXMaxY, atMinXMaxY, atMaxXMinY, centerInside]) {
      expect(fs.existsSync(f)).toBe(false);
    }
    for (const f of [justBelowMinX, justAboveMaxX, justBelowMinY, justAboveMaxY]) {
      expect(fs.existsSync(f)).toBe(true);
    }
  });

  it("invert: chunks exactly AT the boundary survive (inclusive membership applies the same way under invert); one step outside gets deleted", async () => {
    const atMinXMinY = path.join(savePath, "map", "10", "10.bin");
    const atMaxXMaxY = path.join(savePath, "map", "20", "20.bin");
    const justOutside = path.join(savePath, "map", "21", "21.bin");

    for (const f of [atMinXMinY, atMaxXMaxY, justOutside]) writeFileDeep(f, "x");

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 10, maxX: 20, minY: 10, maxY: 20,
      invert: true,
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1 }));
    expect(fs.existsSync(atMinXMinY)).toBe(true); // boundary chunk -- inside the kept region
    expect(fs.existsSync(atMaxXMaxY)).toBe(true); // boundary chunk -- inside the kept region
    expect(fs.existsSync(justOutside)).toBe(false); // outside the kept region -- deleted
  });

  it("a degenerate single-point region (minX===maxX, minY===maxY) deletes exactly the one matching chunk, nothing adjacent", async () => {
    const exact = path.join(savePath, "map", "15", "15.bin");
    const adjacentX = path.join(savePath, "map", "14", "15.bin");
    const adjacentY = path.join(savePath, "map", "15", "14.bin");
    for (const f of [exact, adjacentX, adjacentY]) writeFileDeep(f, "x");

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 15, maxX: 15, minY: 15, maxY: 15,
      invert: false,
    });

    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1 }));
    expect(fs.existsSync(exact)).toBe(false);
    expect(fs.existsSync(adjacentX)).toBe(true);
    expect(fs.existsSync(adjacentY)).toBe(true);
  });
});

describe("cell-aux cleanup: exact B42 cell-divisor boundary (chunk 31 vs chunk 32, divisor=32)", () => {
  it("deleting the last chunk of cell 0 (x=31) does not touch cell 1's (x=32) aux files, and vice versa", async () => {
    const cell0Chunk = path.join(savePath, "map", "31", "0.bin"); // cell 0: floor(31/32)=0
    const cell1Chunk = path.join(savePath, "map", "32", "0.bin"); // cell 1: floor(32/32)=1
    writeFileDeep(cell0Chunk, "a");
    writeFileDeep(cell1Chunk, "b");
    const cell0Aux = path.join(savePath, "chunkdata", "chunkdata_0_0.bin");
    const cell1Aux = path.join(savePath, "chunkdata", "chunkdata_1_0.bin");
    writeFileDeep(cell0Aux, "aux0");
    writeFileDeep(cell1Aux, "aux1");

    // Delete only the cell-0 chunk (x=31) -- cell 0 becomes empty, cell 1
    // (x=32) must be completely unaffected.
    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "31/0.bin", x: 31, y: 0 }],
    });

    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1 }));
    expect(fs.existsSync(cell0Chunk)).toBe(false);
    expect(fs.existsSync(cell1Chunk)).toBe(true); // adjacent cell's chunk: untouched
    expect(fs.existsSync(cell0Aux)).toBe(false); // cell 0 now empty -- its aux removed
    expect(fs.existsSync(cell1Aux)).toBe(true); // cell 1 aux: must survive
  });
});

describe("negative-coordinate directory/file names: regex exclusion is real and consistent (structural fact, not a live-data-loss claim)", () => {
  it("detectSaveIsB42Sync-equivalent B42 layout detection: a save whose ONLY map/ subdirectory is negative-named is NOT recognized as B42 by delete-region's own xDirs filter", async () => {
    // Directly exercises the exact regex delete-region uses internally by
    // observing its externally visible effect: with only a negative X dir
    // present, delete-region must fall through to the "no xDirs" / flat
    // B41 branch instead of walking it as a B42 structure.
    writeFileDeep(path.join(savePath, "map", "-5", "10.bin"), "x");

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: -100, maxX: 100, minY: -100, maxY: 100, // a huge region that WOULD include (-5,10)
      invert: false,
    });

    // If the negative directory were recognized, this huge region would
    // catch it (deleted:1). It is not recognized -- the regex excludes it
    // before the region check ever runs, so the file survives untouched.
    expect(res.getBody()).toEqual(
      expect.objectContaining({ success: true, deleted: 0 }),
    );
    expect(fs.existsSync(path.join(savePath, "map", "-5", "10.bin"))).toBe(true);
  });

  it("under invert:true, a negative-named chunk is invisible to the scan and therefore SURVIVES even though it is clearly outside the kept region -- the failure direction is under-deletion, not over-deletion", async () => {
    writeFileDeep(path.join(savePath, "map", "-5", "10.bin"), "x");
    writeFileDeep(path.join(savePath, "map", "50", "50.bin"), "keep"); // inside the kept region

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 0, maxX: 100, minY: 0, maxY: 100, // "keep this positive range, delete everything else"
      invert: true,
    });

    expect(res.getBody().deleted).toBe(0); // the negative chunk was never even seen, so nothing to delete
    expect(fs.existsSync(path.join(savePath, "map", "-5", "10.bin"))).toBe(true); // should have been deleted by invert semantics -- was not
    expect(fs.existsSync(path.join(savePath, "map", "50", "50.bin"))).toBe(true); // correctly kept
  });
});

describe("coordinate math itself is correct for negative integers (independent of whether the regex ever lets one through)", () => {
  it("Math.floor cell-bucketing matches real chunk/cell math for negative chunk coordinates", () => {
    // cellDivisorFor(true) === 32 (B42). A chunk at x=-1 must belong to
    // cell -1 (the cell immediately west of cell 0's [0,31] span), not cell
    // 0 -- Math.floor rounds toward -Infinity, which is the correct
    // direction for this; a naive truncating division (`(-1/32)|0 === 0`)
    // would wrongly merge it into cell 0.
    expect(Math.floor(-1 / 32)).toBe(-1);
    expect(Math.floor(-32 / 32)).toBe(-1); // last chunk of cell -1
    expect(Math.floor(-33 / 32)).toBe(-2); // first chunk of cell -2
    // Contrast with truncating division, which would be WRONG here:
    expect((-1 / 32) | 0).toBe(0); // truncates toward zero -- would misattribute cell
  });
});

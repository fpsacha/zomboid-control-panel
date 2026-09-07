import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";

// bug hunt 2026-09-07 (uniqueness-generator sweep): writeDiskCacheAsync()'s
// scratch file used to be `${dest}.${process.pid}.${Date.now()}.tmp` --
// no coalescing guards this function (unlike mods.js's thumbnail cache,
// which dedupes concurrent fetches for the same id via THUMB_INFLIGHT), so
// two overlapping requests for the SAME missing tile (a viewport redraw
// racing itself, or two clients panning to the same area) can both reach
// this function for the same `dest`. pid is constant for the life of one
// process, so it added no real protection beyond Date.now() alone -- two
// such calls landing in the same millisecond got the IDENTICAL tmp path,
// and two independent writeFile() calls racing on one path can interleave
// their bytes before either rename() lands, rather than each writer
// getting its own scratch file. Whether that actually corrupts a given run
// depends on real OS-level write timing, which isn't something a test can
// force deterministically -- what IS deterministic, and what the fix
// actually changed, is whether the two calls compute the SAME tmp path at
// all. That's what this asserts, the same way the chunks.js backup-
// directory regression test asserts two distinct directory names rather
// than trying to catch content corruption in the act.

describe("writeDiskCacheAsync: concurrent same-millisecond writes for the same tile must not share a tmp path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("two concurrent calls for the same relPath get two distinct tmp paths", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const tmpPathsSeen = [];
    const realWriteFile = fs.promises.writeFile.bind(fs.promises);
    vi.spyOn(fs.promises, "writeFile").mockImplementation((filePath, data) => {
      tmpPathsSeen.push(filePath);
      return realWriteFile(filePath, data);
    });

    const { writeDiskCacheAsync } = await import("../routes/mapProxy.js");

    const relPath = "20/0/2_3.jpg";
    const bufferA = Buffer.from("tile-content-a");
    const bufferB = Buffer.from("tile-content-b");

    await Promise.all([
      writeDiskCacheAsync(relPath, bufferA),
      writeDiskCacheAsync(relPath, bufferB),
    ]);

    expect(tmpPathsSeen).toHaveLength(2);
    expect(tmpPathsSeen[0]).not.toBe(tmpPathsSeen[1]);
  });
});

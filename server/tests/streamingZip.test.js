import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { Open } from "unzipper";
import { StreamingZipWriter } from "../utils/streamingZip.js";

describe("StreamingZipWriter", () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("writes a high entry count without retaining an entry array", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-streaming-zip-"));
    const zipPath = path.join(tempDir, "many-files.zip");
    const writer = new StreamingZipWriter(zipPath, { level: 0 });
    const entryCount = 12_000;

    for (let index = 0; index < entryCount; index += 1) {
      await writer.addBuffer(Buffer.from(`file-${index}`), `save/${index}.txt`);
    }

    const result = await writer.finalize();
    const archive = await Open.file(zipPath);

    expect(result.entries).toBe(entryCount);
    expect(result.size).toBeGreaterThan(0);
    expect(Object.keys(writer)).not.toContain("entries");
    expect(archive.files).toHaveLength(entryCount);
    expect(archive.files[0].path).toBe("save/0.txt");
    expect(archive.files.at(-1).path).toBe(`save/${entryCount - 1}.txt`);
  });
});
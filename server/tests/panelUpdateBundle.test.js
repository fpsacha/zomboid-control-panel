import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  acknowledgeUpdateBundle,
  applyUpdateBundle,
  recoverInterruptedUpdateBundle,
  stageUpdateBundle,
  validateBuildCompatibility,
} from "../services/updateBundle.js";

let installDir;

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function metadata(version = "2.0.0", buildSha = "new-build") {
  return { panelVersion: version, buildSha, apiContractVersion: 1 };
}

function prepareBundle() {
  const binaryPath = path.join(installDir, "ZomboidControlPanel");
  const stagedBinaryPath = `${binaryPath}.new`;
  const liveClientPath = path.join(installDir, "client", "dist");
  const incomingClientPath = path.join(installDir, "incoming-client");
  writeFile(binaryPath, "old-binary");
  writeFile(stagedBinaryPath, "new-binary");
  writeFile(path.join(liveClientPath, "index.html"), "old-client");
  writeFile(path.join(incomingClientPath, "index.html"), "new-client");
  writeFile(
    path.join(incomingClientPath, "build-info.json"),
    JSON.stringify(metadata()),
  );
  const sentinelPath = path.join(installDir, "data", "db.json");
  writeFile(sentinelPath, "operator-state");
  const journalPath = stageUpdateBundle({
    installDir,
    version: "2.0.0",
    binaryPath,
    stagedBinaryPath,
    liveClientPath,
    incomingClientPath,
    metadata: metadata(),
  });
  return { binaryPath, stagedBinaryPath, liveClientPath, journalPath, sentinelPath };
}

describe("versioned panel update bundles", () => {
  beforeEach(() => {
    installDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-update-bundle-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(installDir, { recursive: true, force: true });
  });

  it("stages matching frontend and backend artifacts without touching the live client", () => {
    const { liveClientPath, journalPath } = prepareBundle();

    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "old-client",
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    expect(journal.phase).toBe("staged");
    expect(journal.metadata).toEqual(metadata());
    expect(fs.existsSync(path.join(journal.paths.stagedClient, "index.html"))).toBe(true);
  });

  it("retains both backups until the new backend acknowledges startup", () => {
    const { binaryPath, liveClientPath, journalPath, sentinelPath } = prepareBundle();

    applyUpdateBundle(journalPath);

    expect(fs.readFileSync(binaryPath, "utf8")).toBe("new-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "new-client",
    );
    expect(JSON.parse(fs.readFileSync(journalPath, "utf8")).phase).toBe(
      "awaiting_startup_ack",
    );

    acknowledgeUpdateBundle(journalPath, metadata());

    expect(fs.existsSync(journalPath)).toBe(false);
    expect(fs.readFileSync(sentinelPath, "utf8")).toBe("operator-state");
  });

  it("rejects a missing staged binary before changing either live artifact", () => {
    const { stagedBinaryPath, binaryPath, liveClientPath, journalPath } = prepareBundle();
    fs.unlinkSync(stagedBinaryPath);

    expect(() => applyUpdateBundle(journalPath)).toThrowError(
      expect.objectContaining({ code: "av_quarantine" }),
    );
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "old-client",
    );
  });

  it("rolls back the frontend when binary activation fails", () => {
    const { binaryPath, liveClientPath, journalPath } = prepareBundle();
    const originalRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (String(source).endsWith(".new") && destination === binaryPath) {
        throw Object.assign(new Error("simulated binary swap failure"), { code: "EIO" });
      }
      return originalRename(source, destination);
    });

    expect(() => applyUpdateBundle(journalPath)).toThrowError(
      expect.objectContaining({ code: "binary_swap_failed" }),
    );
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "old-client",
    );
  });

  it("restores the binary when frontend activation fails", () => {
    const { binaryPath, liveClientPath, journalPath } = prepareBundle();
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    const originalRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (source === journal.paths.stagedClient && destination === liveClientPath) {
        throw Object.assign(new Error("simulated frontend swap failure"), { code: "EIO" });
      }
      return originalRename(source, destination);
    });

    expect(() => applyUpdateBundle(journalPath)).toThrowError(
      expect.objectContaining({ code: "frontend_swap_failed" }),
    );
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "old-client",
    );
  });

  it("recovers both artifacts from an interrupted awaiting-ack transaction", () => {
    const { binaryPath, liveClientPath, journalPath } = prepareBundle();
    applyUpdateBundle(journalPath);

    recoverInterruptedUpdateBundle(journalPath, "startup_handshake_failed");

    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "old-client",
    );
  });

  it("detects frontend-older and backend-older mismatches", () => {
    expect(
      validateBuildCompatibility(metadata("1.9.0"), metadata("2.0.0")),
    ).toEqual(
      expect.objectContaining({
        compatible: false,
        diagnosticCode: "version_mismatch",
      }),
    );
    expect(
      validateBuildCompatibility(metadata("2.1.0"), metadata("2.0.0")),
    ).toEqual(
      expect.objectContaining({
        compatible: false,
        diagnosticCode: "version_mismatch",
      }),
    );
  });

  it("rolls back both artifacts when the new backend acknowledges with mismatched metadata", () => {
    const { binaryPath, liveClientPath, journalPath } = prepareBundle();
    applyUpdateBundle(journalPath);

    expect(() =>
      acknowledgeUpdateBundle(journalPath, metadata("2.0.1", "other-build")),
    ).toThrowError(expect.objectContaining({ code: "version_mismatch" }));

    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "old-client",
    );
  });
});

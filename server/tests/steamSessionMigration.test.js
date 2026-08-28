import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const settings = new Map();
let tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-steammigrate-init-"));

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
}));

vi.mock("../utils/paths.js", () => ({
  getDataPaths: () => ({ dataDir: tmpDir, logsDir: tmpDir }),
}));

const { getSteamSessionCredentials, setSteamSessionCredentials } =
  await import("../services/workshopCollectionSync.js");
const { readUiSecretFile, writeUiSecretFile } = await import("../utils/uiSecretFile.js");

describe("Steam session cookie pair — migration out of db.json", () => {
  beforeEach(() => {
    settings.clear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-steammigrate-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("nothing configured -> both null", async () => {
    const result = await getSteamSessionCredentials();
    expect(result).toEqual({ sessionId: null, loginSecure: null });
  });

  it("legacy db.json values migrate verbatim into their own files and are cleared from db.json", async () => {
    settings.set("steamSessionId", "legacy-session-id");
    settings.set("steamLoginSecure", "legacy-login-secure-jwt");

    const result = await getSteamSessionCredentials();

    expect(result).toEqual({
      sessionId: "legacy-session-id",
      loginSecure: "legacy-login-secure-jwt",
    });
    expect(settings.get("steamSessionId")).toBeNull();
    expect(settings.get("steamLoginSecure")).toBeNull();
    expect(readUiSecretFile("steamSessionId")).toBe("legacy-session-id");
    expect(readUiSecretFile("steamLoginSecure")).toBe(
      "legacy-login-secure-jwt",
    );
  });

  it("cookies pushed via setSteamSessionCredentials are written to files, not db.json, and read back correctly", async () => {
    await setSteamSessionCredentials("fresh-session-id", "fresh-login-secure");

    expect(settings.get("steamSessionId")).toBeNull();
    expect(settings.get("steamLoginSecure")).toBeNull();

    const result = await getSteamSessionCredentials();
    expect(result).toEqual({
      sessionId: "fresh-session-id",
      loginSecure: "fresh-login-secure",
    });
  });

  it("atomically replaces an existing canonical pair and clears stale database values", async () => {
    writeUiSecretFile("steamSessionId", "old-file-session");
    writeUiSecretFile("steamLoginSecure", "old-file-login");
    settings.set("steamSessionId", "stale-db-session");
    settings.set("steamLoginSecure", "stale-db-login");

    await setSteamSessionCredentials("new-file-session", "new-file-login");

    expect(await getSteamSessionCredentials()).toEqual({
      sessionId: "new-file-session",
      loginSecure: "new-file-login",
    });
    expect(settings.get("steamSessionId")).toBeNull();
    expect(settings.get("steamLoginSecure")).toBeNull();
  });

  it("preserves the canonical counterpart when only one cookie is updated", async () => {
    await setSteamSessionCredentials("initial-session", "initial-login");

    await setSteamSessionCredentials("replacement-session", undefined);

    expect(await getSteamSessionCredentials()).toEqual({
      sessionId: "replacement-session",
      loginSecure: "initial-login",
    });
  });

  it("restores the complete previous pair when the second activation fails", async () => {
    await setSteamSessionCredentials("stable-session", "stable-login");
    const originalRename = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (
        String(source).includes(".tmp-") &&
        String(destination).endsWith("steamLoginSecure.secret")
      ) {
        throw Object.assign(new Error("simulated second-file failure"), { code: "EIO" });
      }
      return originalRename(source, destination);
    });

    const failedWrite = setSteamSessionCredentials(
      "uncommitted-session",
      "uncommitted-login",
    );
    await expect(failedWrite).rejects.toThrow(
      "Could not persist Steam session credentials",
    );
    await expect(failedWrite).rejects.not.toThrow("uncommitted-session");
    await expect(failedWrite).rejects.not.toThrow("uncommitted-login");
    renameSpy.mockRestore();

    expect(await getSteamSessionCredentials()).toEqual({
      sessionId: "stable-session",
      loginSecure: "stable-login",
    });
  });

  it("only one of the pair migrated (asymmetric legacy state) still resolves correctly", async () => {
    settings.set("steamSessionId", "legacy-session-id-only");
    // steamLoginSecure never set — realistic partial-config state.

    const result = await getSteamSessionCredentials();

    expect(result.sessionId).toBe("legacy-session-id-only");
    expect(result.loginSecure).toBeNull();
  });
});

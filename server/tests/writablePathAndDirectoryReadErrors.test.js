import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  formatWritablePathError,
  formatDirectoryReadError,
} from "../routes/server.js";
import { ErrorCode } from "../utils/errorCodes.js";

// 2026-08-22 correction: WRITABLE_PATH_ERROR and DIRECTORY_READ_FAILED were
// each ONE ErrorCode covering 4 and 2 distinct English sentences
// respectively (a word/sentence choice -- label, isContainer, isWindows --
// not a value), with an unreachable {{label}}/{{guidance}} placeholder that
// never actually received params. Split into WRITABLE_PATH_{INSTALL,DATA}_
// {BAREMETAL,CONTAINER} and DIRECTORY_READ_FAILED_{WINDOWS,POSIX}.
//
// These test the FORMATTERS directly, not the routes, because the failure
// shape this was built to catch already happened twice tonight elsewhere
// (Kevin's SANDBOX_REPAIR_BACKUP_FAILED and makeRoleError catch blocks):
// params computed correctly but never actually reaching res.json(). Testing
// the formatter's return value is what proves {message, code, params} is
// the exact object every call site spreads into res.json() -- not a
// reimplementation of the same claim.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");
const EN_ERRORS = JSON.parse(
  fs.readFileSync(
    path.join(REPO_ROOT, "client/src/locales/en/errors.json"),
    "utf8",
  ),
);
const FR_ERRORS = JSON.parse(
  fs.readFileSync(
    path.join(REPO_ROOT, "client/src/locales/fr/errors.json"),
    "utf8",
  ),
);

// Mimics paramTranslation.ts's resolveRegisteredTranslation() interpolation
// step closely enough to prove every {{param}} the template needs is
// actually present in what the formatter returned -- this is a server-side
// test and can't import the client's TS module directly.
function interpolate(template, params) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => {
    expect(params, `template needs {{${name}}} but params is missing`).toBeTruthy();
    expect(
      Object.prototype.hasOwnProperty.call(params, name),
      `template needs {{${name}}} but params does not have it`,
    ).toBe(true);
    return String(params[name]);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatWritablePathError: variant split (2026-08-22 correction)", () => {
  it("install + bare-metal", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const result = formatWritablePathError("install", "/srv/pz", false);
    expect(result.code).toBe(ErrorCode.WRITABLE_PATH_INSTALL_BAREMETAL);
    expect(result.params).toEqual({ path: "/srv/pz" });
    // 2026-08-29 wording fix ("raw EACCES with no pointer to the fix"): the
    // refusal was already correct, but "choose a writable folder" never
    // said WHY this one isn't or how to fix it in place -- now names the
    // actual mechanism (chown/chmod) instead of only suggesting a different
    // folder.
    expect(result.message).toContain("chown");
    expect(result.message).toContain("chmod");
  });

  it("install + container (Docker PUID/PGID guidance)", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (p) => p === "/.dockerenv",
    );
    const result = formatWritablePathError("install", "/srv/pz", false);
    expect(result.code).toBe(ErrorCode.WRITABLE_PATH_INSTALL_CONTAINER);
    expect(result.params).toEqual({ path: "/srv/pz" });
    // 2026-08-29 wording fix: names the SPECIFIC docker-compose.yml env vars
    // (PUID/PGID) instead of the vague "owned by the panel container
    // UID/GID" -- the exact gap the dispatch named (docker-compose.yml's
    // own Quick Start comments document PUID/PGID right above the
    // bind-mount lines, and the old error never mentioned it).
    expect(result.message).toContain("PUID");
    expect(result.message).toContain("PGID");
    expect(result.message).toContain(".env");
  });

  it("data + bare-metal", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const result = formatWritablePathError("data", "/srv/pz_Data", false);
    expect(result.code).toBe(ErrorCode.WRITABLE_PATH_DATA_BAREMETAL);
    expect(result.params).toEqual({ path: "/srv/pz_Data" });
    expect(result.message).toContain("chown");
    expect(result.message).toContain("chmod");
  });

  it("data + container", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (p) => p === "/run/.containerenv",
    );
    const result = formatWritablePathError("data", "/srv/pz_Data", false);
    expect(result.code).toBe(ErrorCode.WRITABLE_PATH_DATA_CONTAINER);
    expect(result.params).toEqual({ path: "/srv/pz_Data" });
    expect(result.message).toContain("PUID");
    expect(result.message).toContain("PGID");
    expect(result.message).toContain(".env");
  });

  it("container detection is skipped entirely on Windows, by design", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true); // even if the marker files exist
    const result = formatWritablePathError("install", "/srv/pz", true);
    expect(result.code).toBe(ErrorCode.WRITABLE_PATH_INSTALL_BAREMETAL);
  });

  it.each([
    ["install", false, ErrorCode.WRITABLE_PATH_INSTALL_BAREMETAL],
    ["install", true, ErrorCode.WRITABLE_PATH_INSTALL_CONTAINER],
    ["data", false, ErrorCode.WRITABLE_PATH_DATA_BAREMETAL],
    ["data", true, ErrorCode.WRITABLE_PATH_DATA_CONTAINER],
  ])(
    "%s/container=%s: en and fr both interpolate cleanly with the formatter's own params",
    (kind, container, expectedCode) => {
      vi.spyOn(fs, "existsSync").mockReturnValue(container);
      const result = formatWritablePathError(kind, "/some/path", false);
      expect(result.code).toBe(expectedCode);
      expect(() => interpolate(EN_ERRORS[result.code], result.params)).not.toThrow();
      expect(() => interpolate(FR_ERRORS[result.code], result.params)).not.toThrow();
    },
  );
});

describe("formatDirectoryReadError: variant split (2026-08-22 correction)", () => {
  it("windows guidance", () => {
    const result = formatDirectoryReadError("C:\\pz", "EPERM", true);
    expect(result.code).toBe(ErrorCode.DIRECTORY_READ_FAILED_WINDOWS);
    expect(result.params).toEqual({ path: "C:\\pz", code: "EPERM" });
    expect(result.message).toBe(
      "Cannot read C:\\pz (EPERM). Run the panel as an account that can read this folder.",
    );
  });

  it("posix guidance", () => {
    const result = formatDirectoryReadError("/srv/pz", "EACCES", false);
    expect(result.code).toBe(ErrorCode.DIRECTORY_READ_FAILED_POSIX);
    expect(result.params).toEqual({ path: "/srv/pz", code: "EACCES" });
    expect(result.message).toBe(
      "Cannot read /srv/pz (EACCES). The panel service account needs read and execute permission on this folder and every parent folder.",
    );
  });

  it.each([
    [true, ErrorCode.DIRECTORY_READ_FAILED_WINDOWS],
    [false, ErrorCode.DIRECTORY_READ_FAILED_POSIX],
  ])(
    "isWindows=%s: en and fr both interpolate cleanly with the formatter's own params",
    (isWin, expectedCode) => {
      const result = formatDirectoryReadError("/some/path", "EACCES", isWin);
      expect(result.code).toBe(expectedCode);
      expect(() => interpolate(EN_ERRORS[result.code], result.params)).not.toThrow();
      expect(() => interpolate(FR_ERRORS[result.code], result.params)).not.toThrow();
    },
  );
});

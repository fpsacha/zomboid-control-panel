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

// 2026-09-02, single-signal-sweep: formatWritablePathError now detects
// containers via the shared utils/dockerDetect.js isContainerized(), which
// falls back to a /proc/1/cgroup scan when neither marker file is present
// (some CI sandboxes, older Docker). Every "bare-metal" case below mocks
// existsSync to false, which -- unmocked -- would fall straight through to
// a REAL fs.readFileSync("/proc/1/cgroup") read of whatever host actually
// runs this test. Force the ENOENT branch explicitly so these stay
// hermetic instead of silently depending on the test runner not itself
// being a container.
function mockNotContainerized() {
  vi.spyOn(fs, "existsSync").mockReturnValue(false);
  vi.spyOn(fs, "readFileSync").mockImplementation(() => {
    const err = new Error(
      "ENOENT: no such file or directory, open '/proc/1/cgroup'",
    );
    err.code = "ENOENT";
    throw err;
  });
}

describe("formatWritablePathError: variant split (2026-08-22 correction)", () => {
  it("install + bare-metal", () => {
    mockNotContainerized();
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
    mockNotContainerized();
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
    // sweep-round2, Windows non-admin install shapes (2026-09-06): this used
    // to fall all the way through to WRITABLE_PATH_INSTALL_BAREMETAL --
    // "container is skipped" was correct, but the OLD assertion pinned the
    // actual bug alongside it: Windows landed on the SAME chown/chmod
    // guidance as bare-metal Linux, commands that don't exist on Windows.
    // Now has its own branch -- see the two tests directly below.
    expect(result.code).toBe("WRITABLE_PATH_INSTALL_WINDOWS");
    expect(result.message).not.toContain("chown");
    expect(result.message).not.toContain("chmod");
  });

  // sweep-round2, Windows non-admin install shapes (2026-09-06): a real
  // operator report shape -- docs/install/windows.md's own documented,
  // intended install path is a NON-ADMIN account extracting to a
  // user-owned folder (its own example: C:\ZomboidPanel), so an operator
  // pointing the install wizard's Install Path / Zomboid Data Path fields
  // at a folder their account can't write to (Program Files, another
  // account's profile, a UAC-protected system folder) is a live, documented
  // shape, not a hypothetical. Before this fix, formatWritablePathError()
  // only branched on isContainer (a Linux-only concept for this app --
  // isContainer is unconditionally false when platformIsWindows is true,
  // see the function's own comment), so EVERY non-container caller,
  // Windows included, got told to fix it "with chown/chmod" -- exactly the
  // wrong-OS-guidance defect class this function's own 2026-08-29 fix
  // comment says it was hunting ("run as Administrator" on Linux) and
  // ironically reintroduced in the mirror-image direction.
  it("install + Windows: names Windows-appropriate remediation, not chown/chmod", () => {
    const result = formatWritablePathError("install", "C:\\Program Files\\pz", true);
    expect(result.code).toBe("WRITABLE_PATH_INSTALL_WINDOWS");
    expect(result.params).toEqual({ path: "C:\\Program Files\\pz" });
    expect(result.message).toContain("C:\\Program Files\\pz");
    expect(result.message).not.toContain("chown");
    expect(result.message).not.toContain("chmod");
    expect(result.message).toMatch(/Security tab|Administrator|write to/i);
  });

  it("data + Windows: same Windows-appropriate remediation as install", () => {
    const result = formatWritablePathError("data", "C:\\Program Files\\pz_Data", true);
    expect(result.code).toBe("WRITABLE_PATH_DATA_WINDOWS");
    expect(result.params).toEqual({ path: "C:\\Program Files\\pz_Data" });
    expect(result.message).not.toContain("chown");
    expect(result.message).not.toContain("chmod");
  });

  // WRITABLE_PATH_INSTALL_WINDOWS/WRITABLE_PATH_DATA_WINDOWS deliberately NOT
  // included here yet: those two codes are not registered in errorCodes.js
  // or any locale's errors.json as of this commit (TODO, see
  // formatWritablePathError's own comment for why) -- EN_ERRORS[code] would
  // be undefined and interpolate() would throw on a template that doesn't
  // exist yet, not prove anything about the real (still front-end-untranslated,
  // by design, for now) behavior. Add them here once registered.
  it.each([
    ["install", false, ErrorCode.WRITABLE_PATH_INSTALL_BAREMETAL],
    ["install", true, ErrorCode.WRITABLE_PATH_INSTALL_CONTAINER],
    ["data", false, ErrorCode.WRITABLE_PATH_DATA_BAREMETAL],
    ["data", true, ErrorCode.WRITABLE_PATH_DATA_CONTAINER],
  ])(
    "%s/container=%s: en and fr both interpolate cleanly with the formatter's own params",
    (kind, container, expectedCode) => {
      if (container) {
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
      } else {
        mockNotContainerized();
      }
      const result = formatWritablePathError(kind, "/some/path", false);
      expect(result.code).toBe(expectedCode);
      expect(() => interpolate(EN_ERRORS[result.code], result.params)).not.toThrow();
      expect(() => interpolate(FR_ERRORS[result.code], result.params)).not.toThrow();
    },
  );

  // 2026-09-02, single-signal-sweep, REAL DEFECT fix: this formatter used to
  // hand-roll only the two dockerenv/containerenv marker-file checks (no
  // cgroup fallback), the exact gap utils/dockerDetect.js's isContainerized()
  // already closed for a "some CI sandboxes, older Docker" runtime that
  // skips the marker file. On such a runtime the OLD code confidently
  // returned the bare-metal "chown/chmod" guidance instead of the correct
  // Docker PUID/PGID guidance -- a wrong answer delivered with confidence,
  // not a hedge. Neither marker file exists here; only the cgroup scan
  // reveals the container.
  it("detects a container via the cgroup fallback even when neither marker file exists", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "readFileSync").mockReturnValue("0::/docker/abc123\n");
    const result = formatWritablePathError("data", "/srv/pz_Data", false);
    expect(result.code).toBe(ErrorCode.WRITABLE_PATH_DATA_CONTAINER);
    expect(result.message).toContain("PUID");
  });
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

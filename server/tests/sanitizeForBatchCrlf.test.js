import { describe, expect, it } from "vitest";
import { generateStartupScripts } from "../routes/server.js";

// 2026-09-05 overnight bug hunt (injection lens): sanitizeForBatch() stripped
// shell metacharacters and ".." but never CR/LF. Of the three fields it
// guards (serverName, adminPassword, zomboidDataPath), adminPassword and
// zomboidDataPath have no separate validator upstream -- sanitizeForBatch is
// the only thing standing between them and the generated launch script. A
// literal newline in one of them closed out the current script line early
// and started a new one, which the supervisor then executes as its own
// command -- confirmed by reproducing an injected .bat AND .sh via
// generateStartupScripts() directly before this fix (both platforms are
// built from the same sanitized values, so both were exploitable the same
// way).
describe("sanitizeForBatch CR/LF injection (generateStartupScripts)", () => {
  const baseOptions = {
    installPath: "C:\\PZServer",
    serverName: "MyServer",
    minMemory: 4,
    maxMemory: 8,
    zomboidDataPath: "C:\\PZServer_Data",
    serverPort: 16261,
  };

  it("a newline in adminPassword cannot inject a new line into the .bat", () => {
    const scripts = generateStartupScripts({
      ...baseOptions,
      adminPassword: "hunter2\r\necho INJECTED\r\nrem ",
    });
    expect(scripts.bat).not.toMatch(/\n\s*echo INJECTED\s*\n/);
    // The line carrying -adminpassword must be a single line: no bare CR or
    // LF may survive inside the quoted argument itself.
    const argLine = scripts.bat
      .split("\n")
      .find((l) => l.includes("-adminpassword"));
    expect(argLine).toBeDefined();
    expect(argLine).not.toMatch(/[\r\n]/);
  });

  it("a newline in adminPassword cannot inject a new line into the .sh", () => {
    const scripts = generateStartupScripts({
      ...baseOptions,
      adminPassword: "hunter2\r\necho INJECTED\r\nrem ",
    });
    expect(scripts.sh).not.toMatch(/\n\s*echo INJECTED\s*\n/);
    const argLine = scripts.sh
      .split("\n")
      .find((l) => l.includes("-adminpassword"));
    expect(argLine).toBeDefined();
    expect(argLine).not.toMatch(/[\r\n]/);
  });

  it("a newline in zomboidDataPath cannot inject a new line into either script", () => {
    const scripts = generateStartupScripts({
      ...baseOptions,
      zomboidDataPath: "C:\\PZServer_Data\r\necho INJECTED",
    });
    // The injected payload must not land as its own script line -- it may
    // only ever appear as inert trailing text on the -cachedir line.
    const isInjectedLine = (l) => l.trim().startsWith("echo INJECTED");
    expect(scripts.bat.split("\n").some(isInjectedLine)).toBe(false);
    expect(scripts.sh.split("\n").some(isInjectedLine)).toBe(false);
    const batArgLine = scripts.bat
      .split("\n")
      .find((l) => l.includes("-cachedir"));
    expect(batArgLine).not.toMatch(/[\r\n]/);
  });

  it("still strips the pre-existing shell-metacharacter set (no regression)", () => {
    const scripts = generateStartupScripts({
      ...baseOptions,
      adminPassword: 'a&b|c<d>e^f%g"h`i;j$k(l)m{n}o[p]q!r',
    });
    const match = scripts.bat.match(/-adminpassword "([^"]*)"/);
    expect(match).not.toBeNull();
    // Only the sanitized VALUE is asserted here -- the surrounding line also
    // legitimately contains quotes/%/; from the script's own template syntax.
    expect(match[1]).toBe("abcdefghijklmnopqr");
  });
});

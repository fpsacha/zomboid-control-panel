import { describe, expect, it } from "vitest";
import { generateStartBat, generateStartSh } from "../../build.js";

describe("standalone launchers", () => {
  it("does not promise a fixed URL from the Linux launcher", () => {
    const launcher = generateStartSh();

    expect(launcher).not.toContain("localhost:3001");
    expect(launcher).toContain("./ZomboidControlPanel");
  });

  it("does not promise a fixed URL from the Windows supervisor", () => {
    expect(generateStartBat()).not.toContain("localhost:3001");
  });

  it("checks that the pending marker becomes the applying marker before launch", () => {
    const launcher = generateStartBat();
    const moveStart = launcher.indexOf('move /y "%MARKER%" "%APPLYING%"');
    const moveFailureCheck = launcher.indexOf("if errorlevel 1", moveStart);
    const activationLog = launcher.indexOf(
      "Apply: bundle activated; waiting for backend startup acknowledgement",
      moveStart,
    );

    expect(moveStart).toBeGreaterThan(-1);
    expect(moveFailureCheck).toBeGreaterThan(moveStart);
    expect(moveFailureCheck).toBeLessThan(activationLog);
  });

  it("retains the update journal unless every rollback restore succeeds", () => {
    const launcher = generateStartBat();
    const rollbackStart = launcher.indexOf(":rollback_update");
    const restoreFailureCheck = launcher.indexOf(
      'if "!ROLLBACK_FAILED!"=="1"',
      rollbackStart,
    );
    const journalDelete = launcher.indexOf('del /f /q "%JOURNAL%"', rollbackStart);

    expect(rollbackStart).toBeGreaterThan(-1);
    expect(restoreFailureCheck).toBeGreaterThan(rollbackStart);
    expect(journalDelete).toBeGreaterThan(restoreFailureCheck);
  });
});

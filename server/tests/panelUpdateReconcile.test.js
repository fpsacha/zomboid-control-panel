import { beforeEach, describe, expect, it, vi } from "vitest";

const getSetting = vi.fn();
const setSetting = vi.fn();

vi.mock("../database/init.js", () => ({
  getSetting,
  setSetting,
}));

const { PanelUpdateChecker } = await import(
  "../services/panelUpdateChecker.js"
);

describe("PanelUpdateChecker pending-update reconciliation", () => {
  beforeEach(() => {
    getSetting.mockReset();
    setSetting.mockReset();
  });

  it("clears an older marker after a newer manual installation", async () => {
    getSetting.mockResolvedValue("1.2.4");
    const checker = new PanelUpdateChecker();
    checker.currentVersion = "1.2.6";

    await checker.reconcilePendingUpdate();

    expect(setSetting).toHaveBeenCalledWith("pendingPanelUpdate", null);
    expect(setSetting).toHaveBeenCalledWith(
      "stagedPanelUpdateVersion",
      null,
    );
    expect(checker.lastApplyResult).toBeNull();
  });

  it("still records an exact-version apply as successful", async () => {
    getSetting.mockResolvedValue("1.2.6");
    const checker = new PanelUpdateChecker();
    checker.currentVersion = "1.2.6";

    await checker.reconcilePendingUpdate();

    expect(checker.lastApplyResult).toMatchObject({
      status: "success",
      appliedVersion: "1.2.6",
    });
  });

  it("keeps reporting a real failed apply when the panel is still older", async () => {
    getSetting.mockResolvedValue("1.2.6");
    const checker = new PanelUpdateChecker();
    checker.currentVersion = "1.2.5";

    await checker.reconcilePendingUpdate();

    expect(checker.lastApplyResult).toMatchObject({
      status: "failed",
      pendingVersion: "1.2.6",
    });
    expect(setSetting).not.toHaveBeenCalled();
  });
});
import { afterEach, describe, expect, it, vi } from "vitest";

const isContainerized = vi.fn(() => false);

vi.mock("../utils/dockerDetect.js", () => ({
  isContainerized: (...args) => isContainerized(...args),
}));

const { PanelUpdateChecker, getDevModeUpgradeInstruction } = await import(
  "../services/panelUpdateChecker.js"
);

describe("dev-mode upgrade guidance branches on containerization", () => {
  afterEach(() => {
    isContainerized.mockReset();
    isContainerized.mockReturnValue(false);
  });

  it("tells a real git checkout to pull with git", () => {
    expect(getDevModeUpgradeInstruction(false)).toBe(
      "In dev mode, pull the latest code with git.",
    );
  });

  it("tells a plain container to pull and recreate the image instead of pulling git", () => {
    const instruction = getDevModeUpgradeInstruction(true);
    expect(instruction).toContain("docker compose pull");
    expect(instruction).toContain("docker compose up -d");
    expect(instruction).not.toContain("git");
  });

  it("preflight() surfaces the git instruction outside a container", async () => {
    isContainerized.mockReturnValue(false);
    const checker = new PanelUpdateChecker();
    const result = await checker.preflight();
    expect(result.ok).toBe(false);
    expect(result.blockers[0]).toContain("pull the latest code with git");
    expect(result.blockers[0]).not.toContain("docker compose");
  });

  it("preflight() surfaces the docker compose instruction inside a plain container (no update sidecar)", async () => {
    isContainerized.mockReturnValue(true);
    const checker = new PanelUpdateChecker();
    const result = await checker.preflight();
    expect(result.ok).toBe(false);
    expect(result.blockers[0]).toContain("docker compose pull");
    expect(result.blockers[0]).not.toContain("pull the latest code with git");
  });

  it("does not change the refusal itself: still fail-closed (ok:false) either way", async () => {
    for (const containerized of [true, false]) {
      isContainerized.mockReturnValue(containerized);
      const checker = new PanelUpdateChecker();
      const result = await checker.preflight();
      expect(result.ok).toBe(false);
      expect(result.blockers).toHaveLength(1);
    }
  });
});

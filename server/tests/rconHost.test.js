import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeRconHost, resolveEnvRconHost } from "../services/rcon.js";

describe("normalizeRconHost", () => {
  it("strips whitespace pasted around a host", () => {
    // A leading space made DNS fail with ENOTFOUND, which looked identical to
    // an offline server: no players, Discord reported offline, RCON silent.
    expect(normalizeRconHost(" 66.51.96.52")).toBe("66.51.96.52");
    expect(normalizeRconHost("66.51.96.52 ")).toBe("66.51.96.52");
    expect(normalizeRconHost("  pz.example.com\t")).toBe("pz.example.com");
  });

  it("keeps a clean host unchanged", () => {
    expect(normalizeRconHost("127.0.0.1")).toBe("127.0.0.1");
  });

  it("falls back to loopback for empty or non-string input", () => {
    expect(normalizeRconHost("")).toBe("127.0.0.1");
    expect(normalizeRconHost("   ")).toBe("127.0.0.1");
    expect(normalizeRconHost(undefined)).toBe("127.0.0.1");
    expect(normalizeRconHost(null)).toBe("127.0.0.1");
  });
});

describe("resolveEnvRconHost", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // docker-unraid-onboarding, 2026-09-09: shared by every route that writes
  // a freshly-configured server's rconHost (install, quick-setup,
  // configure-rcon, create-from-discovery) so the two-container Unraid
  // topology (panel and PZ in separate containers, RCON_HOST set on the
  // panel's own container) is handled once instead of per call site --
  // server.js's three writes hardcoded 127.0.0.1 unconditionally even
  // after discovery.js got this right, which is the bug this function
  // exists to make impossible to repeat.
  it("uses process.env.RCON_HOST when the operator configured it", () => {
    vi.stubEnv("RCON_HOST", "projectzomboid");
    expect(resolveEnvRconHost()).toBe("projectzomboid");
  });

  it("falls back to 127.0.0.1 when RCON_HOST is unset (the co-located, single-container topology)", () => {
    vi.stubEnv("RCON_HOST", "");
    expect(resolveEnvRconHost()).toBe("127.0.0.1");
  });

  it("falls back to 127.0.0.1 rather than literally using 'CHANGE_ME' as a hostname -- the Unraid template's own unedited default for this required field", () => {
    vi.stubEnv("RCON_HOST", "CHANGE_ME");
    expect(resolveEnvRconHost()).toBe("127.0.0.1");
  });
});

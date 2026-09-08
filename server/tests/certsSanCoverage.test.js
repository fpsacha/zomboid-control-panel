import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";

// 2026-09-08, god-dispatched follow-up to the SAN fix (f43fa1c6): checking
// mere PRESENCE of a SubjectAltName let the self-heal miss the actual
// failure mode. A SAN is a snapshot of the interfaces present at
// GENERATION time -- a cert generated before Tailscale (or any VPN mesh)
// came up would have a real, present SAN that still lacks the address the
// operator is now browsing to, and the old presence-only self-heal would
// never fire because "has a SAN" was already true. That is precisely the
// Tailscale-shaped failure the whole investigation was chasing, freshly
// manufactured by an incomplete self-heal.
//
// The fix is deliberately ASYMMETRIC: regenerate only when a currently-
// present address is MISSING from the SAN; never regenerate merely because
// the SAN contains a STALE address that is no longer present. Regenerating
// on any difference at all would mean a VPN adapter that comes and goes
// regenerates the cert on every toggle, invalidating the operator's
// already-clicked-through browser exception each time -- worse than the
// gap it would close. Both directions of that asymmetry are proven below,
// against the real generation logic, by mocking os.networkInterfaces()
// between calls rather than asserting the intent.

const { networkInterfacesMock } = vi.hoisted(() => ({
  networkInterfacesMock: vi.fn(),
}));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...actual.default, networkInterfaces: networkInterfacesMock },
    networkInterfaces: networkInterfacesMock,
  };
});

const { loadOrCreateCerts } = await import("../utils/certs.js");

function ifaceSet(addresses) {
  const result = {};
  addresses.forEach((address, i) => {
    result[`iface${i}`] = [{ address, family: "IPv4", internal: false }];
  });
  return result;
}

describe("loadOrCreateCerts() self-heal checks SAN coverage of CURRENT addresses, not mere SAN presence", () => {
  afterEach(() => {
    networkInterfacesMock.mockReset();
  });

  it("a NEW address appearing (e.g. Tailscale connecting after the cert was generated) triggers regeneration", () => {
    networkInterfacesMock.mockReturnValue(ifaceSet(["192.168.1.50"]));
    const first = loadOrCreateCerts(null, null);
    const firstSan = new crypto.X509Certificate(first.cert).subjectAltName;
    expect(firstSan).toContain("IP Address:192.168.1.50");
    expect(firstSan).not.toContain("IP Address:100.64.1.2");

    // Tailscale adapter appears after the fact -- same machine, new address.
    networkInterfacesMock.mockReturnValue(ifaceSet(["192.168.1.50", "100.64.1.2"]));
    const second = loadOrCreateCerts(null, null);
    const secondSan = new crypto.X509Certificate(second.cert).subjectAltName;
    expect(secondSan).toContain("IP Address:192.168.1.50");
    expect(secondSan).toContain("IP Address:100.64.1.2");
    // A genuinely new cert+key pair, not the stale one reused.
    expect(second.cert.toString()).not.toBe(first.cert.toString());
  });

  it("an OLD address disappearing (e.g. a VPN adapter going down) does NOT trigger regeneration -- a stale SAN entry is harmless, and regenerating would invalidate the operator's already-accepted browser exception", () => {
    networkInterfacesMock.mockReturnValue(ifaceSet(["192.168.1.50", "100.64.1.2"]));
    const first = loadOrCreateCerts(null, null);

    // Tailscale adapter goes away -- the SAN still names it, but nothing is
    // currently missing from what's needed.
    networkInterfacesMock.mockReturnValue(ifaceSet(["192.168.1.50"]));
    const second = loadOrCreateCerts(null, null);

    expect(second.cert.toString()).toBe(first.cert.toString());
    expect(second.key.toString()).toBe(first.key.toString());
    // The stale entry is still there, still harmless.
    expect(new crypto.X509Certificate(second.cert).subjectAltName).toContain(
      "IP Address:100.64.1.2",
    );
  });

  it("no interface changes at all -- still reused, the existing behaviour this fix must not disturb", () => {
    networkInterfacesMock.mockReturnValue(ifaceSet(["192.168.1.50"]));
    const first = loadOrCreateCerts(null, null);
    const second = loadOrCreateCerts(null, null);
    expect(second.cert.toString()).toBe(first.cert.toString());
  });
});

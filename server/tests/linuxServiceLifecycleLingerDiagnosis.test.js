import { describe, expect, it, vi } from "vitest";

import {
  LinuxServiceLifecycle,
  buildLifecycleTemplate,
} from "../services/linuxServiceLifecycle.js";

// 2026-09-05 overnight bug hunt (install shapes under the privilege lens):
// a service account created exactly per docs/install/linux.md
// (`useradd -r -m -s /bin/false pzuser`) has NEVER had a systemd user-manager
// instance started for it, so /run/user/<uid> does not exist yet. Reproduced
// live under real systemd/WSL: `systemctl --user status` as such an account
// fails outright with "Failed to connect to bus: Permission denied", even
// with XDG_RUNTIME_DIR forced (this file's own defaultExecFile() fallback --
// that fallback fixes a DIFFERENT gap and does not help here). The only fix
// is `sudo loginctl enable-linger pzuser`, run once. Two bugs followed from
// that fact:
//   1. buildLifecycleTemplate()'s suggested `commands` ran two
//      `systemctl --user` steps BEFORE the loginctl step that makes
//      `systemctl --user` work at all on a fresh account.
//   2. inspect() correctly captures the real stderr in status.error, but
//      status()/preflightActivation() discarded it behind a fixed generic
//      "is not installed" message whenever registered came back false --
//      telling the operator to reinstall a unit that was never the problem.
const server = {
  id: "alpha-1",
  name: "Alpha Server",
  serverName: "servertest",
  installPath: "/opt/pz-server",
};

describe("linuxServiceLifecycle systemd account bootstrap (linger)", () => {
  it("commands enable linger before any systemctl --user step depends on it", () => {
    const template = buildLifecycleTemplate(server, "systemd", {
      serviceUser: "pzuser",
      homeDirectory: "/home/pzuser",
      fileExists: () => false,
    });

    const lingerIndex = template.commands.findIndex((c) =>
      c.includes("loginctl enable-linger"),
    );
    const firstSystemctlUserIndex = template.commands.findIndex((c) =>
      c.includes("systemctl --user"),
    );
    expect(lingerIndex).toBeGreaterThanOrEqual(0);
    expect(firstSystemctlUserIndex).toBeGreaterThanOrEqual(0);
    expect(lingerIndex).toBeLessThan(firstSystemctlUserIndex);
  });

  const BUS_ERROR = "Failed to connect to bus: Permission denied\n";

  function noSessionLifecycle() {
    return new LinuxServiceLifecycle(server, "systemd", {
      platform: "linux",
      containerized: false,
      // A real "no linger, no session" systemctl --user call: it ran (exit
      // code 1, a real integer -- execFailed stays false) and printed
      // nothing to stdout, so LoadState never parses and registered comes
      // back false, same as a genuinely-never-installed unit.
      execFile: vi.fn(async () => ({ code: 1, stdout: "", stderr: BUS_ERROR })),
    });
  }

  it("status() surfaces the real bus-connection failure instead of a bare not-installed claim", async () => {
    const status = await noSessionLifecycle().status();

    expect(status.scanFailed).toBe(true);
    expect(status.error).toMatch(/Failed to connect to bus/);
  });

  it("preflightActivation() surfaces the real bus-connection failure the same way", async () => {
    const result = await noSessionLifecycle().preflightActivation();

    expect(result.ready).toBe(false);
    expect(result.error).toMatch(/Failed to connect to bus/);
  });

  it("keeps the plain not-installed message when inspect() genuinely has no underlying error", async () => {
    const lifecycle = new LinuxServiceLifecycle(server, "systemd", {
      platform: "linux",
      containerized: false,
      execFile: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    });

    const status = await lifecycle.status();
    expect(status.scanFailed).toBe(true);
    expect(status.error).toBe(
      `Managed service ${lifecycle.serviceName} is not installed`,
    );

    const preflight = await lifecycle.preflightActivation();
    expect(preflight.ready).toBe(false);
    expect(preflight.error).toBe(
      `Install ${lifecycle.serviceName} before activating this provider`,
    );
  });
});

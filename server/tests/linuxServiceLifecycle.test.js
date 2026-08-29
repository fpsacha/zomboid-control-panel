import { describe, expect, it, vi } from "vitest";

import {
  LinuxServiceLifecycle,
  buildLifecycleTemplate,
  getLinuxLifecycleCapabilities,
  getLifecycleServiceName,
  isManagedLifecycleProvider,
} from "../services/linuxServiceLifecycle.js";

const server = {
  id: "alpha-1",
  name: "Alpha Server",
  serverName: "servertest",
  installPath: "/opt/pz server",
};

describe("Linux managed-service lifecycle", () => {
  it("derives a stable service name from the immutable server id", () => {
    expect(getLifecycleServiceName(server)).toBe(
      "zomboid-panel-server-alpha-1",
    );
    expect(() => getLifecycleServiceName({ id: "../unsafe" })).toThrow(
      /invalid server id/i,
    );
  });

  it("recognizes only systemd and OpenRC as managed providers", () => {
    expect(isManagedLifecycleProvider("direct")).toBe(false);
    expect(isManagedLifecycleProvider("systemd")).toBe(true);
    expect(isManagedLifecycleProvider("openrc")).toBe(true);
    expect(isManagedLifecycleProvider("docker")).toBe(false);
  });

  it("advertises managed providers only for non-container Linux hosts", () => {
    expect(
      getLinuxLifecycleCapabilities({ platform: "linux", containerized: false }),
    ).toEqual({
      supported: true,
      platform: "linux",
      containerized: false,
      providers: ["direct", "systemd", "openrc"],
    });
    expect(
      getLinuxLifecycleCapabilities({ platform: "win32", containerized: false }),
    ).toMatchObject({ supported: false, providers: ["direct"] });
    expect(
      getLinuxLifecycleCapabilities({ platform: "linux", containerized: true }),
    ).toMatchObject({ supported: false, providers: ["direct"] });
  });

  it("renders a systemd unit with an ownership marker and safely quoted paths", () => {
    const template = buildLifecycleTemplate(server, "systemd", {
      serviceUser: "pzuser",
      homeDirectory: "/home/pzuser",
      fileExists: (candidate) => candidate.endsWith("start-server_servertest.sh"),
    });

    expect(template.filename).toBe("zomboid-panel-server-alpha-1.service");
    expect(template.content).toContain(
      "X-Zomboid-Panel-Server-ID: alpha-1",
    );
    expect(template.content).not.toContain('User=pzuser');
    expect(template.content).toContain('WorkingDirectory="/opt/pz server"');
    expect(template.content).toContain(
      'ExecStart=/bin/bash "/opt/pz server/start-server_servertest.sh"',
    );
    expect(template.content).toContain("KillMode=control-group");
    expect(template.content).toContain("WantedBy=default.target");
    expect(template.installPath).toBe(
      "/home/pzuser/.config/systemd/user/zomboid-panel-server-alpha-1.service",
    );
  });

  it("renders an OpenRC service that is supervised outside the panel", () => {
    const template = buildLifecycleTemplate(server, "openrc", {
      serviceUser: "pzuser",
      homeDirectory: "/home/pzuser",
      fileExists: () => false,
    });

    expect(template.filename).toBe("zomboid-panel-server-alpha-1");
    expect(template.content).toContain("#!/sbin/openrc-run");
    expect(template.content).toContain("supervisor=supervise-daemon");
    expect(template.content).toContain(
      'pidfile="${XDG_RUNTIME_DIR}/${RC_SVCNAME}.pid"',
    );
    expect(template.content).toContain(
      "X-Zomboid-Panel-Server-ID: alpha-1",
    );
    expect(template.content).toContain("/opt/pz server/start-server.sh");
    expect(template.installPath).toBe(
      "/home/pzuser/.config/rc/init.d/zomboid-panel-server-alpha-1",
    );
  });

  it("routes systemd actions through execFile without a shell", async () => {
    const execFile = vi.fn(async (command, args) => {
      if (args.includes("show")) {
        return {
          code: 0,
          stdout:
            "LoadState=loaded\nActiveState=inactive\nEnvironment=ZOMBOID_PANEL_SERVER_ID=alpha-1\n",
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const lifecycle = new LinuxServiceLifecycle(server, "systemd", {
      execFile,
      platform: "linux",
      containerized: false,
      waitForState: false,
    });

    const result = await lifecycle.run("start");

    expect(result.success).toBe(true);
    expect(execFile).toHaveBeenCalledWith("systemctl", [
      "--user",
      "start",
      "zomboid-panel-server-alpha-1.service",
    ]);
  });

  it("refuses to control a registered service owned by another profile", async () => {
    const lifecycle = new LinuxServiceLifecycle(server, "systemd", {
      platform: "linux",
      containerized: false,
      execFile: vi.fn(async () => ({
        code: 0,
        stdout:
          "LoadState=loaded\nActiveState=inactive\nEnvironment=ZOMBOID_PANEL_SERVER_ID=other\n",
        stderr: "",
      })),
    });

    const result = await lifecycle.preflightActivation();

    expect(result.ready).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.error).toMatch(/another server profile/i);
  });

  it("never enables managed host services inside a container", async () => {
    const lifecycle = new LinuxServiceLifecycle(server, "systemd", {
      platform: "linux",
      containerized: true,
      execFile: vi.fn(),
    });

    await expect(lifecycle.preflightActivation()).rejects.toThrow(
      /container installations/i,
    );
  });

  it("requires the installed service to be stopped before activation", async () => {
    const lifecycle = new LinuxServiceLifecycle(server, "systemd", {
      platform: "linux",
      containerized: false,
      execFile: vi.fn(async () => ({
        code: 0,
        stdout:
          "LoadState=loaded\nActiveState=active\nEnvironment=ZOMBOID_PANEL_SERVER_ID=alpha-1\n",
        stderr: "",
      })),
    });

    const result = await lifecycle.preflightActivation();

    expect(result.ready).toBe(false);
    expect(result.running).toBe(true);
    expect(result.error).toMatch(/already running/i);
  });
});

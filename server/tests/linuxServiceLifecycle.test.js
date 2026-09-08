import { describe, expect, it, vi } from "vitest";
import path from "path";

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

  // linuxServiceLifecycle.js used to build these with the host's `path`
  // module (path.join), not path.posix -- on win32 that mangled the
  // Linux-only paths these two tests assert against (systemd/OpenRC units
  // always run on Linux, regardless of which OS generated them), so these
  // two used to fail there while the rest of the file passed everywhere.
  // Fixed by switching every path.join/path.dirname call in
  // linuxServiceLifecycle.js to path.posix.join/path.posix.dirname, which
  // never consults process.platform or the host's own separator -- these
  // no longer need (or have) a platform guard. See the dedicated
  // byte-identical-across-platforms test below for a proof that doesn't
  // depend on this file happening to run on both OSes.
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
    // WorkingDirectory= is a plain Key=Value assignment directive, not one
    // of the Exec*= family -- systemd takes the rest of the line literally,
    // with no word-splitting and no quote handling at all (verified against
    // real systemd-analyze/systemctl show; see
    // linuxServiceLifecycleRealSystemd.test.js). Wrapping it in quotes, as
    // the value used to be, makes those quote characters part of the path
    // and every generated unit fails to load. Unquoted is correct.
    expect(template.content).toContain('WorkingDirectory=/opt/pz server');
    expect(template.content).not.toMatch(/^WorkingDirectory="/m);
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
    // directory=/command_args= (openrc's own declarative supervisor=
    // integration) re-evaluate their values a second time after sourcing --
    // real OpenRC word-splits an unescaped space in that second pass no
    // matter how the value was quoted for the first, which is why a space in
    // installPath used to break the supervised command entirely. This
    // template instead defines start()/stop() itself and invokes
    // supervise-daemon directly with the launcher path and working directory
    // as ordinary, single-pass-quoted argv entries -- see
    // linuxServiceLifecycleRealOpenrc.test.js for the real rc-service proof.
    expect(template.content).not.toContain("supervisor=supervise-daemon");
    expect(template.content).not.toMatch(/^command_args=/m);
    expect(template.content).not.toMatch(/^directory=/m);
    expect(template.content).toContain(
      'pidfile="${XDG_RUNTIME_DIR}/${RC_SVCNAME}.pid"',
    );
    expect(template.content).toContain(
      "X-Zomboid-Panel-Server-ID: alpha-1",
    );
    expect(template.content).toContain(
      "--chdir '/opt/pz server' \\",
    );
    expect(template.content).toContain(
      "-- /bin/bash '/opt/pz server/start-server.sh'",
    );
    expect(template.installPath).toBe(
      "/home/pzuser/.config/rc/init.d/zomboid-panel-server-alpha-1",
    );
  });

  // god's addendum to hunt-wave5-2026-08-29: assert against path.posix
  // computed here, not a hand-typed expected string, and prove the check
  // actually discriminates (path.win32 genuinely produces something
  // different for these same segments) rather than being vacuously true --
  // that's what makes this a proof that the generator is platform-
  // independent BY CONSTRUCTION, not just "these two literal strings
  // happen to match on whichever OS ran the test today". A literal-string
  // assertion could pass by coincidence on a run that never has a genuine
  // separator or space-word-splitting case; deriving the expectation from
  // path.posix directly cannot.
  it("systemd/OpenRC installPath and every embedded working-directory/launcher path are exactly what path.posix would produce, and provably NOT what path.win32 would produce for the same inputs", () => {
    const homeDirectory = "/home/pzuser";
    const installDir = server.installPath; // "/opt/pz server" -- the space is the point
    const launcherName = `start-server_${server.serverName}.sh`;

    // Sanity check: prove this scenario is a real discriminator BEFORE
    // trusting any assertion built on it. If these two ever produced the
    // SAME string for these inputs, the test below would pass regardless
    // of whether the fix actually did anything.
    const posixJoin = path.posix.join(installDir, launcherName);
    const win32Join = path.win32.join(installDir, launcherName);
    expect(win32Join).not.toBe(posixJoin);
    expect(win32Join).toContain("\\");
    expect(posixJoin).not.toContain("\\");

    const systemdTemplate = buildLifecycleTemplate(server, "systemd", {
      serviceUser: "pzuser",
      homeDirectory,
      fileExists: (candidate) => candidate.endsWith(launcherName),
    });
    const expectedLauncherPath = path.posix.join(installDir, launcherName);
    const expectedSystemdInstallPath = path.posix.join(
      homeDirectory,
      ".config",
      "systemd",
      "user",
      `${getLifecycleServiceName(server)}.service`,
    );
    expect(systemdTemplate.installPath).toBe(expectedSystemdInstallPath);
    expect(systemdTemplate.content).toContain(
      `WorkingDirectory=${installDir}`,
    );
    expect(systemdTemplate.content).toContain(
      `ExecStart=/bin/bash "${expectedLauncherPath}"`,
    );
    // Never the win32-joined shape, anywhere in the generated unit.
    expect(systemdTemplate.installPath).not.toContain("\\");
    expect(systemdTemplate.content).not.toMatch(/WorkingDirectory=.*\\/);
    expect(systemdTemplate.content).not.toMatch(/ExecStart=.*\\opt/);

    const openrcTemplate = buildLifecycleTemplate(server, "openrc", {
      serviceUser: "pzuser",
      homeDirectory,
      fileExists: () => false,
    });
    const expectedFallbackLauncherPath = path.posix.join(
      installDir,
      "start-server.sh",
    );
    const expectedOpenrcInstallPath = path.posix.join(
      homeDirectory,
      ".config",
      "rc",
      "init.d",
      getLifecycleServiceName(server),
    );
    expect(openrcTemplate.installPath).toBe(expectedOpenrcInstallPath);
    expect(openrcTemplate.content).toContain(
      `--chdir '${installDir}' \\`,
    );
    expect(openrcTemplate.content).toContain(
      `-- /bin/bash '${expectedFallbackLauncherPath}'`,
    );
    expect(openrcTemplate.installPath).not.toContain("\\");
    // No blanket "content has no backslash" check here, unlike the systemd
    // block above -- OpenRC's start()/stop() legitimately end several
    // lines with a real backslash (shell line-continuation, e.g.
    // "--chdir '...' \\"). The toContain() assertions above already pin
    // the exact correct --chdir/-- /bin/bash lines; a regex broad enough to
    // also catch a stray win32-joined path would match those legitimate
    // continuations too.
  });

  it("does not corrupt an OpenRC description containing a literal '$'", () => {
    // name=/description= were never part of openrc-run.sh's declarative
    // command line, so they were never subject to its second-pass
    // re-evaluation -- but the old quoteShell() escaped "$" anyway (needed
    // only for directory=/command_args=), which introduced a spurious
    // literal backslash into the displayed service name. Verified live on
    // real OpenRC: "rc-service ... start" echoed "Starting ... \$CoolServer"
    // instead of "$CoolServer".
    const dollarServer = { ...server, name: "Alpha $CoolServer" };
    const template = buildLifecycleTemplate(dollarServer, "openrc", {
      fileExists: () => false,
    });
    expect(template.content).toContain(
      "name='Project Zomboid server Alpha $CoolServer'",
    );
    expect(template.content).not.toContain("\\$CoolServer");
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

  describe("OpenRC status() scanFailed (2026-08-31 services sweep regression)", () => {
    function openrcLifecycle(execFile) {
      return new LinuxServiceLifecycle(server, "openrc", {
        platform: "linux",
        containerized: false,
        fileExists: () => true,
        readFile: () => `X-Zomboid-Panel-Server-ID: ${server.id}`,
        execFile,
      });
    }

    it("reports a confirmed-stopped service without scanFailed when rc-service genuinely answers non-zero", async () => {
      const status = await openrcLifecycle(
        vi.fn(async () => ({ code: 3, stdout: "stopped", stderr: "" })),
      ).status();

      expect(status.scanFailed).toBe(false);
      expect(status.running).toBe(false);
    });

    // Regression: activeState used to be derived purely from rc-service's
    // exit code, so an exec-level failure (missing binary, EACCES, timeout)
    // collapsed into the exact same "inactive" as a genuine "not running"
    // answer -- scanFailed could never fire for OpenRC no matter what
    // actually went wrong, so configMutationGuard fail-opened on a config
    // overwrite it had no way to verify was safe.
    it("reports scanFailed, not a confident stopped state, when the rc-service exec itself fails", async () => {
      const status = await openrcLifecycle(
        vi.fn(async () => ({ code: 1, stdout: "", stderr: "", execFailed: true })),
      ).status();

      expect(status.scanFailed).toBe(true);
      expect(status.running).toBe(false);
    });

    // No execFile override -- exercises the real defaultExecFile against a
    // command ("rc-service") that genuinely does not exist on this test
    // host, the same ENOENT shape a deployment host missing OpenRC would
    // hit. Proves the execFailed signal actually reaches inspect() end to
    // end, not just through a hand-shaped mock.
    it("reports scanFailed via the real execFile when rc-service cannot be found on this host", async () => {
      const status = await openrcLifecycle(undefined).status();

      expect(status.scanFailed).toBe(true);
      expect(status.running).toBe(false);
    });
  });

  // 2026-09-08 harden-updater dispatch: status()'s scanFailed fix above only
  // protects callers who ask status() the question -- run()'s own
  // "already stopped"/"already running" shortcuts read inspect()'s raw
  // `current.running` directly and never went through that fix, so the same
  // exec-level failure that status() correctly reports as scanFailed instead
  // came out of run() as a full {confirmed:true} claim, with no stop/start
  // command ever actually attempted.
  describe("run() stop/start shortcuts under an OpenRC exec-level failure (2026-09-08 reporting-site fix)", () => {
    function openrcLifecycle(execFile) {
      return new LinuxServiceLifecycle(server, "openrc", {
        platform: "linux",
        containerized: false,
        fileExists: () => true,
        readFile: () => `X-Zomboid-Panel-Server-ID: ${server.id}`,
        execFile,
      });
    }

    it("does not confirm a stop when the pre-check rc-service exec itself fails -- falls through to a real stop attempt instead", async () => {
      const execFile = vi.fn(async () => ({
        code: 1,
        stdout: "",
        stderr: "",
        execFailed: true,
      }));

      const result = await openrcLifecycle(execFile).run("stop");

      expect(result.confirmed).toBe(false);
      expect(result.success).toBe(false);
      // The shortcut must not have short-circuited before the real command --
      // inspect()'s own probe plus a genuine "rc-service ... stop" attempt is
      // two calls, not one.
      expect(execFile).toHaveBeenCalledTimes(2);
      expect(execFile).toHaveBeenCalledWith("rc-service", [
        "--user",
        "zomboid-panel-server-alpha-1",
        "stop",
      ]);
    });

    it("does not confirm already-running when the pre-check rc-service exec itself fails -- falls through to a real start attempt instead", async () => {
      const execFile = vi.fn(async () => ({
        code: 1,
        stdout: "",
        stderr: "",
        execFailed: true,
      }));

      const result = await openrcLifecycle(execFile).run("start");

      expect(result.confirmed).toBe(false);
      expect(result.success).toBe(false);
      expect(execFile).toHaveBeenCalledTimes(2);
    });

    it("still takes the fast confirmed-stopped shortcut when rc-service genuinely answers non-zero (no regression on the legitimate fast path)", async () => {
      const execFile = vi.fn(async () => ({
        code: 3,
        stdout: "stopped",
        stderr: "",
      }));

      const result = await openrcLifecycle(execFile).run("stop");

      expect(result).toEqual({
        success: true,
        confirmed: true,
        message: "Server is already stopped",
      });
      // Shortcut taken -- only the one inspect() probe, no stop command issued.
      expect(execFile).toHaveBeenCalledTimes(1);
    });
  });
});

import { execFile as nodeExecFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { isContainerized } from "../utils/dockerDetect.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("LinuxServiceLifecycle");

export const LIFECYCLE_PROVIDERS = Object.freeze([
  "direct",
  "systemd",
  "openrc",
]);

export function isManagedLifecycleProvider(provider) {
  return provider === "systemd" || provider === "openrc";
}

export function getLinuxLifecycleCapabilities(options = {}) {
  const platform = options.platform || process.platform;
  const containerized = options.containerized ?? isContainerized();
  return {
    supported: platform === "linux" && !containerized,
    platform,
    containerized,
    providers: platform === "linux" && !containerized
      ? [...LIFECYCLE_PROVIDERS]
      : ["direct"],
  };
}

export function getLifecycleServiceName(server) {
  const id = String(server?.id ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error("Invalid server id for a managed lifecycle service");
  }
  return `zomboid-panel-server-${id.toLowerCase()}`;
}

function assertPlainValue(value, label) {
  const text = String(value ?? "").trim();
  if (!text || /[\0\r\n]/.test(text)) {
    throw new Error(`${label} must be a non-empty single-line value`);
  }
  return text;
}

// For Exec*= and Environment= only -- these are the directives systemd
// parses with its own C-style/shell-like argv tokenizer (systemd.syntax(7)
// "QUOTING"), so wrapping in double quotes and C-escaping backslash/quote is
// correct there. Verified against real systemd (systemd-analyze verify +
// systemctl show) that "$" needs NO escaping for either directive: Environment=
// documents "the '$' character has no special meaning", and an unescaped "$"
// in a quoted ExecStart= argument round-trips completely literally (no $VAR
// or $(...) expansion happens there at all). "\$" is not a recognized escape
// per systemd.syntax(7)'s escape table -- feeding it in produced a real,
// reproduced-on-real-systemd bug: systemd logs "Ignoring unknown escape
// sequences" and the literal backslash survives into the argument, so a
// server name/path containing "$" silently got a spurious "\" inserted next
// to it. Do not add a "$" escape back here.
function quoteSystemdArg(value) {
  return `"${String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%")}"`;
}

// For plain Key=Value assignment directives (WorkingDirectory=, Description=,
// and similar) -- these are NOT parsed with the Exec*=/Environment= tokenizer
// at all. Verified against real systemd: the entire rest of the line becomes
// the literal value with no word-splitting and no quote handling whatsoever
// -- a space, a literal '$', and a literal '"' all round-tripped byte-for-byte
// with zero escaping. Wrapping the value in quotes here (the original bug)
// makes those two literal quote characters PART OF the value instead of
// delimiting it, which is why every generated unit failed to load ("path is
// not absolute") for every server, not just ones with unusual names. The one
// thing that IS special on every unit-file line, quoted directive or not, is
// specifier expansion (e.g. "%h" -> the unit's home directory) -- confirmed
// live: a server named "... %h ..." got "%h" silently expanded into the
// literal home-directory path inside Description=. Escape a literal "%" to
// "%%" and return the value UNQUOTED; do not wrap it.
function plainSystemdValue(value) {
  return String(value).replace(/%/g, "%%");
}

// OpenRC's own openrc-run.sh re-evaluates the declarative directory=/
// command_args= variables a SECOND time after sourcing the init script, to
// build the auto-generated supervise-daemon invocation (confirmed live, on
// real OpenRC via Alpine: a value containing "$(touch /tmp/x)", already
// correctly single-quoted for the FIRST, ordinary shell-sourcing pass, still
// executed the command substitution on the second pass -- real code
// execution). That second pass also word-splits on unescaped whitespace,
// which no amount of value-level escaping can defend against -- a literal
// space in installPath broke the supervised command entirely
// ("supervise-daemon: server does not exist"), confirmed unrelated to this
// file's escaping (byte-identical generated content before/after a prior,
// escaping-only fix attempt).
//
// Fix: stop feeding any value through directory=/command_args= at all. This
// file no longer sets supervisor=/command=/command_args=/directory=; instead
// it defines its own start()/stop() and calls supervise-daemon directly from
// inside them with --chdir/--env/-- as real argv entries. That is ordinary,
// single-pass bash -- openrc-run.sh sources the script once and then calls
// the function; there is no second re-evaluation of a function body the way
// there is for the declarative variables (verified live: a path containing
// a space now starts, is supervised, and stops cleanly; the same "$(touch
// /tmp/x)"/backtick payloads that broke the old design executed as
// argv, not shell, so the injection is closed here too -- reverified against
// this exact code path, not assumed carried over from the old fix).
//
// quoteShellLiteral() is therefore plain, ordinary POSIX single-quoting: only
// the single-quote character itself needs escaping, because inside a real
// single-quoted bash string "\", "$", and "`" are already fully literal.
// Do NOT reuse the old double-escaping helper here -- it was verified correct
// only for the ONE thing it was defending against (the second-pass
// re-evaluation this design no longer triggers). Feeding it a value with a
// literal "$" in a genuinely single-pass context (also true of name=/
// description=, which were never part of the auto-generated command line and
// so were never subject to the second pass either) produced a real,
// reproduced bug: a spurious literal backslash surfaced in the displayed
// service name, the exact same class of bug the systemd Description=/"\$"
// fix above closes.
function quoteShellLiteral(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// configuredPath/serverName describe the TARGET Linux machine's filesystem
// (where the generated unit/init script will run), never the machine
// generating the template -- buildLifecycleTemplate() has no platform gate
// of its own (its one production caller, GET /:id/lifecycle-template, does
// gate on getLinuxLifecycleCapabilities().supported, but the function itself
// is exported and callable directly, in tests and otherwise). path.posix
// is used throughout this file instead of the bare `path` import for
// exactly that reason: the host's `path` module joins with the HOST's
// separator regardless of the (already forward-slash) segments fed into
// it, so a Windows host previously produced backslash-mangled unit content
// -- the same "correct on the machine that generated it, refused by the
// machine that has to run it" defect already fixed once in this file for
// WorkingDirectory= (see plainSystemdValue's comment).
function resolveLaunchTarget(server, fileExists = fs.existsSync) {
  if (server?.startCommand) {
    throw new Error(
      "Managed lifecycle services do not accept a custom start command. Configure a .sh launcher path instead.",
    );
  }

  const configuredPath = assertPlainValue(
    server?.serverPath || server?.installPath,
    "Server install path",
  );
  if (/\.sh$/i.test(configuredPath)) {
    return {
      workingDirectory: path.posix.dirname(configuredPath),
      launcherPath: configuredPath,
    };
  }
  if (/\.(bat|cmd|exe)$/i.test(configuredPath)) {
    throw new Error("Managed Linux services require a .sh launcher");
  }

  const serverName = assertPlainValue(server?.serverName, "Server name");
  const generated = path.posix.join(
    configuredPath,
    `start-server_${serverName}.sh`,
  );
  return {
    workingDirectory: configuredPath,
    launcherPath: fileExists(generated)
      ? generated
      : path.posix.join(configuredPath, "start-server.sh"),
  };
}

export function buildLifecycleTemplate(server, provider, options = {}) {
  if (!isManagedLifecycleProvider(provider)) {
    throw new Error(`Unsupported managed lifecycle provider: ${provider}`);
  }
  const serviceName = getLifecycleServiceName(server);
  const serverId = String(server.id);
  const serviceUser = assertPlainValue(
    options.serviceUser || os.userInfo().username,
    "Service user",
  );
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(serviceUser)) {
    throw new Error("Service user contains unsupported characters");
  }
  const launch = resolveLaunchTarget(server, options.fileExists);
  const description = `Project Zomboid server ${String(
    server.name || server.serverName,
  ).replace(/[\r\n]/g, " ")}`;

  if (provider === "systemd") {
    const content = [
      `# X-Zomboid-Panel-Server-ID: ${serverId}`,
      "[Unit]",
      `Description=${plainSystemdValue(description)}`,
      "After=network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      `WorkingDirectory=${plainSystemdValue(launch.workingDirectory)}`,
      `Environment=${quoteSystemdArg(`ZOMBOID_PANEL_SERVER_ID=${serverId}`)}`,
      `ExecStart=/bin/bash ${quoteSystemdArg(launch.launcherPath)}`,
      "Restart=on-failure",
      "RestartSec=5",
      "TimeoutStopSec=180",
      "KillMode=control-group",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
    return {
      provider,
      serviceName,
      filename: `${serviceName}.service`,
      // os.homedir() is the deliberate, unchanged fallback here: it is the
      // TARGET machine's home directory whenever this actually runs on the
      // target (the only currently-supported case -- see
      // getLinuxLifecycleCapabilities()'s comment above), and no caller
      // supplies an explicit options.homeDirectory today. Switching the
      // JOIN to path.posix fixes the separator bug (byte-identical output
      // once homeDirectory is supplied explicitly, as every test here
      // does); it does not and should not paper over os.homedir() itself
      // returning a Windows-shaped value when host and target genuinely
      // differ -- that is a caller-supplied-value problem, not a
      // path-formatting one, and out of scope for this fix.
      installPath: path.posix.join(
        options.homeDirectory || os.homedir(),
        ".config",
        "systemd",
        "user",
        `${serviceName}.service`,
      ),
      content,
      // loginctl enable-linger MUST run first. A freshly `useradd`'d service
      // account -- exactly what the install docs have the operator create --
      // has never had a systemd user-manager instance started for it, so
      // /run/user/<uid> does not exist yet. Every `systemctl --user` command
      // below, including the two that used to precede this one, fails
      // outright with "Failed to connect to bus: Permission denied" until
      // linger creates that runtime dir -- reproduced live: a `useradd -r -m`
      // account, exactly as documented, cannot run `systemctl --user status`
      // even with XDG_RUNTIME_DIR forced (this file's own defaultExecFile()
      // fallback) until enable-linger has run at least once.
      commands: [
        `sudo loginctl enable-linger ${serviceUser}`,
        "install -d -m 0755 ~/.config/systemd/user",
        `install -m 0644 <downloaded-file> ~/.config/systemd/user/${serviceName}.service`,
        "systemctl --user daemon-reload",
        `systemctl --user enable ${serviceName}.service`,
      ],
    };
  }

  const content = [
    "#!/sbin/openrc-run",
    `# X-Zomboid-Panel-Server-ID: ${serverId}`,
    `name=${quoteShellLiteral(description)}`,
    `description=${quoteShellLiteral(description)}`,
    'pidfile="$' + '{XDG_RUNTIME_DIR}/$' + '{RC_SVCNAME}.pid"',
    "",
    "depend() {",
    "  need net",
    "  after firewall",
    "}",
    "",
    // No supervisor=/command=/command_args=/directory= here on purpose --
    // see quoteShellLiteral()'s comment. start()/stop() call supervise-daemon
    // directly so the launcher path and working directory are ordinary argv
    // entries in a single-pass bash context, not values openrc-run.sh
    // re-evaluates a second time.
    "start() {",
    '  ebegin "Starting $' + '{name}"',
    '  supervise-daemon "$' + '{RC_SVCNAME}" \\',
    "    --start \\",
    '    --pidfile "$' + '{pidfile}" \\',
    "    --respawn-delay 5 \\",
    "    --respawn-max 0 \\",
    `    --chdir ${quoteShellLiteral(launch.workingDirectory)} \\`,
    `    --env ${quoteShellLiteral(`ZOMBOID_PANEL_SERVER_ID=${serverId}`)} \\`,
    `    -- /bin/bash ${quoteShellLiteral(launch.launcherPath)}`,
    "  eend $?",
    "}",
    "",
    "stop() {",
    '  ebegin "Stopping $' + '{name}"',
    '  supervise-daemon "$' + '{RC_SVCNAME}" --stop --pidfile "$' + '{pidfile}"',
    "  eend $?",
    "}",
    "",
  ].join("\n");
  return {
    provider,
    serviceName,
    filename: serviceName,
    // See the systemd branch's identical comment above -- same reasoning.
    installPath: path.posix.join(
      options.homeDirectory || os.homedir(),
      ".config",
      "rc",
      "init.d",
      serviceName,
    ),
    content,
    commands: [
      "install -d -m 0755 ~/.config/rc/init.d",
      `install -m 0755 <downloaded-file> ~/.config/rc/init.d/${serviceName}`,
      `rc-update --user add ${serviceName} default`,
    ],
  };
}

function defaultExecFile(command, args) {
  return new Promise((resolve) => {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const env = { ...process.env };
    if (!env.XDG_RUNTIME_DIR && Number.isInteger(uid)) {
      env.XDG_RUNTIME_DIR = `/run/user/${uid}`;
    }
    nodeExecFile(command, args, { timeout: 15000, env }, (error, stdout, stderr) => {
      // error.code is the child's own exit code (an integer) when the
      // command actually ran and exited non-zero. When the exec itself
      // never produced a real exit code -- ENOENT, EACCES, a timeout kill --
      // Node instead gives a string errno/signal or nothing, and this used
      // to collapse indistinguishably into a synthetic `code: 1`, identical
      // to a command that ran fine and legitimately exited 1. execFailed
      // lets callers tell "the command answered" apart from "we don't know
      // what the command would have said".
      const execFailed = Boolean(error) && !Number.isInteger(error?.code);
      resolve({
        code: Number.isInteger(error?.code) ? error.code : error ? 1 : 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || error?.message || ""),
        execFailed,
      });
    });
  });
}

function parseSystemdShow(stdout) {
  const values = {};
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

export class LinuxServiceLifecycle {
  constructor(server, provider, options = {}) {
    if (!isManagedLifecycleProvider(provider)) {
      throw new Error(`Unsupported managed lifecycle provider: ${provider}`);
    }
    this.server = server;
    this.provider = provider;
    this.serviceName = getLifecycleServiceName(server);
    this.execFile = options.execFile || defaultExecFile;
    this.fileExists = options.fileExists || fs.existsSync;
    this.readFile = options.readFile || ((file) => fs.readFileSync(file, "utf8"));
    this.platform = options.platform || process.platform;
    this.containerized = options.containerized ?? isContainerized();
    this.waitForState = options.waitForState !== false;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  assertSupported() {
    if (this.platform !== "linux") {
      throw new Error(`${this.provider} lifecycle is supported only on Linux`);
    }
    if (this.containerized) {
      throw new Error(
        "Container installations must keep the direct lifecycle provider and their existing image-based process model",
      );
    }
  }

  async inspect() {
    this.assertSupported();
    const marker = `ZOMBOID_PANEL_SERVER_ID=${this.server.id}`;
    if (this.provider === "systemd") {
      const unit = `${this.serviceName}.service`;
      const result = await this.execFile("systemctl", [
        "--user",
        "show",
        unit,
        "--property=LoadState",
        "--property=ActiveState",
        "--property=Environment",
      ]);
      const values = parseSystemdShow(result.stdout);
      const registered = values.LoadState && values.LoadState !== "not-found";
      const running = ["active", "activating", "reloading"].includes(
        values.ActiveState,
      );
      return {
        registered: Boolean(registered),
        running,
        activeState: values.ActiveState || "unknown",
        markerMatches: Boolean(
          registered && String(values.Environment || "").includes(marker),
        ),
        error:
          !registered && result.stderr
            ? result.stderr.trim().slice(0, 300)
            : null,
      };
    }

    // Unlike buildLifecycleTemplate() above, this method is genuinely safe
    // as a host-path operation even before this fix: assertSupported() (top
    // of inspect(), called just above via this.inspect() -> assertSupported())
    // already throws unless this.platform === "linux", so this line can only
    // ever execute on the SAME machine the init script would be installed
    // on -- host and target are always the same machine here. Converted to
    // path.posix anyway for consistency with the rest of this file (a
    // Linux-real path.join and path.posix.join are always identical, so
    // this changes nothing observable), not because it was independently
    // reachable from a non-Linux host.
    const initPath = path.posix.join(
      process.env.XDG_CONFIG_HOME || path.posix.join(os.homedir(), ".config"),
      "rc",
      "init.d",
      this.serviceName,
    );
    const registered = this.fileExists(initPath);
    let markerMatches = false;
    if (registered) {
      try {
        markerMatches = this.readFile(initPath).includes(
          `X-Zomboid-Panel-Server-ID: ${this.server.id}`,
        );
      } catch (error) {
        return {
          registered: true,
          running: false,
          activeState: "unknown",
          markerMatches: false,
          error: `Could not read ${initPath}: ${error.message}`,
        };
      }
    }
    const status = registered
      ? await this.execFile("rc-service", ["--user", this.serviceName, "status"])
      : { code: 3, stdout: "", stderr: "" };
    // Unlike the systemd branch above (where an exec failure yields empty
    // stdout, so LoadState never parses and `registered` itself comes back
    // false -- routing straight to status()'s "not registered" scanFailed
    // path), `registered` here is a filesystem check that already succeeded
    // by this point. Without checking execFailed, a genuine rc-service exec
    // failure (missing binary, EACCES, timeout) was indistinguishable from
    // rc-service running fine and reporting "not running" -- both produced
    // activeState: "inactive", so status()'s `scanFailed: activeState ===
    // "unknown"` could never fire for OpenRC no matter what actually failed.
    const execFailed = Boolean(status.execFailed);
    return {
      registered,
      running: registered && !execFailed && status.code === 0,
      activeState: !registered
        ? "not-found"
        : execFailed
          ? "unknown"
          : status.code === 0
            ? "active"
            : "inactive",
      markerMatches,
      error: execFailed || (status.code !== 0 && status.code !== 3)
        ? status.stderr.trim().slice(0, 300)
        : null,
    };
  }

  async preflightActivation() {
    const status = await this.inspect();
    if (!status.registered) {
      // status.error carries the REAL cause when inspect() got far enough to
      // capture one (e.g. "Failed to connect to bus: Permission denied" --
      // the systemd provider's service account has no linger-enabled user
      // session, which reads as "not installed" no matter how correctly the
      // unit was actually installed). Losing that behind a generic
      // not-installed message sends the operator to reinstall a unit that
      // was never the problem.
      return {
        ready: false,
        ...status,
        error: status.error
          ? `${this.serviceName} is not registered or its status could not be checked: ${status.error}`
          : `Install ${this.serviceName} before activating this provider`,
      };
    }
    if (!status.markerMatches) {
      return {
        ready: false,
        conflict: true,
        ...status,
        error:
          "The registered service belongs to another server profile or lacks the panel ownership marker",
      };
    }
    if (status.running) {
      return {
        ready: false,
        ...status,
        error:
          "The managed service is already running. Stop it before activation; the panel will not silently adopt it.",
      };
    }
    return { ready: true, conflict: false, ...status };
  }

  async status() {
    const status = await this.inspect();
    if (!status.registered) {
      // See preflightActivation()'s identical comment -- an unregistered
      // result here can mean the unit genuinely isn't installed, OR that
      // inspect()'s systemctl/rc-service call never got far enough to say
      // either way (most commonly: a systemd service account with no
      // linger-enabled user session). Surface status.error when there is
      // one instead of asserting "not installed" as if the scan succeeded.
      return {
        running: false,
        scanFailed: true,
        error: status.error
          ? `Managed service ${this.serviceName} is not installed or its status could not be checked: ${status.error}`
          : `Managed service ${this.serviceName} is not installed`,
      };
    }
    if (!status.markerMatches) {
      return {
        running: false,
        scanFailed: true,
        error: `Managed service ${this.serviceName} failed ownership validation`,
      };
    }
    return {
      running: status.running,
      scanFailed: status.activeState === "unknown",
      activeState: status.activeState,
      error: status.error,
    };
  }

  async run(action) {
    if (!["start", "stop", "restart"].includes(action)) {
      throw new Error(`Unsupported lifecycle action: ${action}`);
    }
    const current = await this.inspect();
    if (!current.registered || !current.markerMatches) {
      return {
        success: false,
        confirmed: false,
        error: !current.registered
          ? `Managed service ${this.serviceName} is not installed`
          : `Managed service ${this.serviceName} failed ownership validation`,
      };
    }
    if (action === "start" && current.running) {
      return { success: true, confirmed: true, message: "Server is already running" };
    }
    if (action === "stop" && !current.running) {
      return { success: true, confirmed: true, message: "Server is already stopped" };
    }

    const args = this.provider === "systemd"
      ? ["--user", action, `${this.serviceName}.service`]
      : ["--user", this.serviceName, action];
    const command = this.provider === "systemd" ? "systemctl" : "rc-service";
    const result = await this.execFile(command, args);
    if (result.code !== 0) {
      return {
        success: false,
        confirmed: false,
        error: (result.stderr || result.stdout || `${command} exited ${result.code}`)
          .trim()
          .slice(0, 500),
      };
    }

    if (this.waitForState) {
      const expectedRunning = action !== "stop";
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const status = await this.status();
        if (!status.scanFailed && status.running === expectedRunning) {
          return {
            success: true,
            confirmed: true,
            message: `Server ${action} completed through ${this.provider}`,
          };
        }
        await this.sleep(250);
      }
      return {
        success: false,
        confirmed: false,
        error: `${this.provider} accepted ${action}, but the resulting service state could not be confirmed`,
      };
    }

    log.info(`${this.provider} ${action} accepted for ${this.serviceName}`);
    return {
      success: true,
      confirmed: true,
      message: `Server ${action} accepted by ${this.provider}`,
    };
  }
}

export function createLinuxServiceLifecycle(server, provider, options) {
  return new LinuxServiceLifecycle(server, provider, options);
}

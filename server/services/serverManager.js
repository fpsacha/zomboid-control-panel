import { spawn, exec, execFile } from "child_process";
import path from "path";
import fs from "fs";
import net from "net";
import { createLogger } from "../utils/logger.js";
const log = createLogger("Server");
import {
  logServerEvent,
  getSetting,
  setSetting,
  getActiveServer,
  getServer,
  getServers,
} from "../database/init.js";
import { withFileLock, writeFileAtomic } from "../utils/fileWriteQueue.js";
import { escapeRegExp } from "../utils/regex.js";
import { getDataPaths } from "../utils/paths.js";
import { parseBoundedInteger } from "../utils/queryNumbers.js";
import {
  createLinuxServiceLifecycle,
  isManagedLifecycleProvider,
} from "./linuxServiceLifecycle.js";
import { hasActiveSteamOperation } from "./activeSteamOperations.js";
import { notifyServerLaunched, prepareForLaunch } from "./lifecycleCoordinator.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { listNonInternalIPv4Interfaces } from "../utils/networkInterfaces.js";
import { buildLinuxLdLibraryCandidates } from "../utils/nativeLibraryPaths.js";
import {
  collectUsedPorts,
  DEFAULT_GAME_PORT,
  findPortConflicts,
} from "./serverPortPlan.js";
import {
  isPlausibleStartMs,
  parseEpochMilliseconds,
  readProcessStartTime,
  WIN32_PROCESS_START_MS,
} from "../utils/processStartTime.js";
import { resolveProvider } from "../utils/serverStatusModel.js";
import {
  readProcessStateWithRetry,
  waitForProcessExit,
} from "../utils/processScanRetry.js";

const isWindows = process.platform === "win32";
// getProcessStartTime()'s memory of FAILED lookups: how soon one for the
// same PID may be retried, and how many PIDs it remembers at once.
const FAILED_START_TIME_RETRY_MS = 60_000;
const MAX_CACHED_START_TIMES = 32;
// How long a live-looked-up public IP is trusted before re-checking.
// Residential ISPs rotate dynamic WAN IPs periodically; without a TTL the
// dashboard would show a stale, no-longer-yours address indefinitely.
const PUBLIC_IP_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Matches the timeout already used by the process-scan exec calls in
// _scanDedicatedServerProcesses below. taskkill/kill/pkill must never be
// allowed to hang indefinitely (AV interference, a wedged syscall): if they
// do, the awaiting stopServer() never returns, so its `finally` never runs,
// so this._stopping never clears, and the server becomes permanently
// un-start/stop/restartable until the whole panel is restarted. See
// stopServer()'s handling of the { timedOut } result below.
const KILL_EXEC_TIMEOUT_MS = 8000;

export function resolveConfiguredRconPort(value, fallback = 27015) {
  if (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return fallback;
  }
  return parseBoundedInteger(value, null, 1, 65535);
}

function getConfiguredIpv4Address(variableName) {
  const address = process.env[variableName]?.trim();
  return address && net.isIP(address) === 4 ? address : null;
}

export function classifyProcessKillError(error) {
  if (!error) return "success";
  if (error?.killed) return "timedOut";

  const message = `${error?.message || ""} ${error?.stderr || ""}`.toLowerCase();
  if (
    error?.code === "ESRCH" ||
    /no such process|not found|no matching process|no instances|not running/.test(
      message,
    ) ||
    (error?.code === 1 && !String(error?.stderr || "").trim())
  ) {
    return "alreadyGone";
  }

  return "failed";
}

// GH #147, second symptom: a real user's SteamCMD install failed with
// "Missing file permissions" because SteamCMD writes its OWN client state
// ($HOME/Steam) separately from the game files at `+force_install_dir`, and
// the bundled systemd unit's `ProtectHome=read-only` blocks that write
// unconditionally (see server/routes/server.js's buildLinuxSteamCmdEnv,
// the fix for the panel's own install/update SteamCMD calls, for the full
// mechanism -- verified for real on a systemd host, not just reasoned
// about). A separate Discord report is the same root from the other end:
// a workshop folder SteamCMD "never produced," with the base server
// already working -- Project Zomboid's dedicated server itself shells out
// to its OWN SteamCMD internally at startup to sync `WorkshopItems=`, and
// that child process inherits whatever env THIS spawn gives the JVM. If
// the JVM inherits the same unmodified (and sandboxed) $HOME, its internal
// SteamCMD call fails the identical way. Redirect it here too, into a
// folder inside the server's own directory -- already required to be
// writable, so it inherits whatever ReadWritePaths grant the operator's
// install already needs, with no new configuration surface.
export function buildLinuxServerHome(serverDir) {
  const steamHome = path.join(serverDir, ".steamhome");
  try {
    fs.mkdirSync(steamHome, { recursive: true });
  } catch (err) {
    log.debug(
      `Could not create SteamCMD HOME override at ${steamHome}: ${err.message}`,
    );
  }
  return steamHome;
}

// Build LD_LIBRARY_PATH from server directory, filtering to only existing
// paths. The native library folders come from the same resolver as the
// generated start-server_<name>.sh (utils/nativeLibraryPaths.js): the game's
// own ProjectZomboid64.json, else linux64/, with a leftover natives/ folder
// only as a fallback -- this used to list natives/ whenever it existed, so a
// custom .sh or start command inherited the stale libraries behind linux64/.
export function buildLdLibraryPath(serverDir) {
  log.debug(
    `buildLdLibraryPath: scanning candidates for serverDir=${serverDir}`,
  );
  const candidates = buildLinuxLdLibraryCandidates(serverDir);
  const existing = candidates.filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  const extra = process.env.LD_LIBRARY_PATH || "";
  const result = [...existing, extra].filter(Boolean).join(":");
  log.debug(
    `buildLdLibraryPath: ${existing.length}/${candidates.length} dirs exist → LD_LIBRARY_PATH=${result}`,
  );
  return result;
}

// 2026-09-04, P0 regression (41d0c6e5/1130108a broke real users): builds the
// string handed to `cmd.exe /c` ourselves instead of letting Node quote each
// argv element independently. With an install path containing a space --
// "C:\Program Files (x86)\..." or just "...\Zomboid Server\..." -- Node
// quotes BOTH the bat path and launchLogPath (4 quote chars total on the /c
// line). cmd.exe's documented quote-preservation rule (`cmd /?`) only kicks
// in with EXACTLY two quote characters; with 4 it falls back to stripping
// only the first character of the whole line and the last quote character
// anywhere in it, which mangles the boundary between the two paths and the
// redirection -- cmd exits 1 before ever launching java.exe, with the launch
// log never written. Reproduced directly: a bare space in either path was
// enough on its own, parens weren't even required.
//
// Fix: quote each piece ourselves (only where it actually needs it), join
// into one line, then wrap that ENTIRE line in one more pair of quotes. That
// gives cmd's fallback-strip exactly one outer pair to remove (first
// character of the line, and the last quote character in it -- which is
// now our own closing wrapper quote, since we control where it sits) and
// leaves every inner per-path quote untouched. This must be paired with
// `windowsVerbatimArguments: true` on the spawn() call, or Node re-quotes
// this already-quoted string on top and reintroduces the same bug one layer
// out.
// 2026-09-04, P0 follow-up (adversarial review caught the other half of the
// same regression): this originally only triggered on whitespace/quotes.
// With windowsVerbatimArguments:true (above), Node's own argv joiner is no
// longer a backstop -- this regex is now the ENTIRE defence against cmd.exe
// treating a character as special. cmd's special set is `&<>()@^|`, and
// batch parameter substitution (%1, %2, ...) additionally treats `,`, `;`,
// and `=` as delimiters equivalent to whitespace (documented behavior, not
// a cmd.exe quirk) -- so an unquoted path/arg containing any of those splits
// or breaks identically to the whitespace case this P0 was opened for.
// Confirmed on a real host: "...\Rock&Roll\..." and "...\PZ(x86)\..." and
// "...\PZ^1\..." all failed with the same exit-1/empty-log signature before
// this widening, and passed after. Deliberately NOT adding `%` (quoting
// does not stop %VAR% expansion, so it buys nothing) or `!` (delayed
// expansion is off under `cmd /c`, so there's nothing to protect against).
export function windowsQuoteArgIfNeeded(value) {
  return /[\s"&<>()^|,;=]/.test(value) ? `"${value}"` : value;
}

export function buildWindowsCmdLine(exePath, args, launchLogPath) {
  const parts = [
    windowsQuoteArgIfNeeded(exePath),
    // codeql[js/shell-command-constructed-from-input] The only args reaching here come from startServer()'s custom start command. validateStartCommand() rejects & | ; < > ` $ { } ( ) ! % [ ] CR LF, parseCustomStartCommand() strips every double quote, and windowsQuoteArgIfNeeded() quotes any arg with whitespace or & < > ( ) ^ | , ; =, so no arg can close a quote or chain a command. The "library input" is startServerForAutoStart()'s test-injection parameter in server/index.js.
    ...args.map(windowsQuoteArgIfNeeded),
  ];
  if (launchLogPath) {
    parts.push(">", windowsQuoteArgIfNeeded(launchLogPath), "2>&1");
  }
  // codeql[js/shell-command-constructed-from-input] Every element of parts went through windowsQuoteArgIfNeeded() or is a literal redirection token. The tracked source, the admin-set custom startCommand, passes validateStartCommand() (rejects & | ; < > ` $ { } ( ) ! % [ ] CR LF) and parseCustomStartCommand() (strips every double quote) in startServer() first, so no element can break out of its quoting. The outer pair is the one cmd /c strips (see comment above).
  return `"${parts.join(" ")}"`;
}

// Splits a custom start command string into a command path and its
// arguments. The regex glues an unquoted run and an adjacent quoted run
// together with nothing between them into ONE token (so `-servername="My
// World"` stays a single argument, not two) -- which means a quote can land
// anywhere inside a token, not just at its edges.
//
// 2026-09-04, carded during the P0 review, pre-existing (not a regression):
// the previous de-quoting step stripped only a LEADING and a TRAILING quote
// (`/^"|"$/g`), which assumes every quote sits at a token boundary. For
// `-servername="My World"` the first character is `-` (leading strip is a
// no-op) but the last character IS the closing quote (stripped) -- leaving
// the unbalanced `-servername="My World`, one stray unpaired quote. Handed
// to buildWindowsCmdLine, that stray quote makes the /c line's total quote
// count odd, corrupting cmd's parse WORSE than the spaced-path P0: cmd
// exits 0 and server-launch.log is never created -- no error signal
// anywhere, silently misfiled as a recurrence of that bug. Reproduced
// directly against real cmd.exe before this fix, confirmed exit 0/no log.
//
// Fix: strip EVERY quote character from a token, not just the outermost
// pair. Every quote this regex matched is grouping syntax it introduced
// itself (`"[^"]*"` already captured the space-containing content between a
// pair as the group's payload), never literal data, so removing all of
// them recovers the intended bare value regardless of where in the token
// they land.
export function parseCustomStartCommand(startCommand) {
  const parts = startCommand.match(/(?:[^\s"]+|"[^"]*")+/g) || [
    startCommand,
  ];
  const cmd = parts[0].replace(/"/g, "");
  const args = parts.slice(1).map((a) => a.replace(/"/g, ""));
  return { cmd, args };
}

// Locates the actual JVM executable inside a PZ install directory (jre64 for
// 64-bit installs, jre for older/32-bit ones -- same directories buildLdLibraryPath
// already knows about). Returns null if neither exists so callers can treat
// "can't find it" as "nothing to check" rather than failing outright -- this
// check is best-effort, not a hard requirement of every install layout.
function findJvmExecutable(serverDir) {
  const candidates = [
    path.join(serverDir, "jre64", "bin", "java"),
    path.join(serverDir, "jre", "bin", "java"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore and try the next candidate
    }
  }
  return null;
}

// Allowed extensions for custom start commands
const ALLOWED_CMD_EXTENSIONS = isWindows
  ? [".bat", ".cmd", ".exe"]
  : [".sh", ""];

// Validate a custom start command string for safety
function validateStartCommand(cmd) {
  if (!cmd || typeof cmd !== "string")
    return { valid: false, reason: "Command is empty" };
  if (cmd.length > 1024)
    return { valid: false, reason: "Command exceeds 1024 characters" };
  // Block obvious shell metacharacters that enable chaining/injection
  // Allow quotes, spaces, hyphens, equals, slashes, dots, colons (drive letters)
  // `$` (POSIX variable expansion) was already blocked here; `%` is its
  // cmd.exe equivalent and was missing -- on the one spawn target this
  // guard actually protects (Windows .bat/.cmd via cmd.exe /c), an
  // unblocked `%VAR%` still expands into the resolved command line, which
  // is then visible in a process listing. Not chaining on its own (that
  // still needs & | ; or a newline, all blocked below), but the same
  // author-intent that blocked `$` clearly meant to block this too.
  if (/[&|;<>`${}()!%\[\]\n\r]/.test(cmd)) {
    return {
      valid: false,
      reason:
        "Command contains disallowed shell characters: & | ; < > ` $ { } ( ) ! % [ ]",
    };
  }
  return { valid: true };
}

// SECURITY (2026-10-04, RCE-STARTCMD): a server's launch target -- its
// custom start command, or a launcher script named by installPath/serverPath
// (resolveLaunchMode()'s CUSTOM LAUNCHER) -- is a program the panel runs on
// this computer, as its own account, every time the server starts. The
// blocklist above stops chaining, not the choice of program:
// `powershell.exe -enc <base64>` passed it, and a technician could save that
// (servers.manage) and press Start (server.control). Saving a launch target
// now takes files.manage (routes/servers.js), and every launch asks again
// here, so a value stored before that check existed, or written some other
// way, still can't run. No launch target may be an OS program or a command
// interpreter (resolved through realpath so a symlink or junction can't
// disguise one); a start command additionally has to resolve inside the
// server's own install folder (the EXEC-1 vector). A custom launcher is the
// operator's own script and a supported mode that can live anywhere, so it
// is not folder-confined -- see findLaunchTargetRefusal() for the split.
// The script the panel writes for a MANAGED server is its own and isn't
// asked about.
const COMMAND_INTERPRETER_RE =
  /^(cmd|command|powershell(_ise)?|pwsh|wscript|cscript|mshta|rundll32|regsvr32|msiexec|wsl|bash|sh|dash|zsh|ksh|csh|tcsh|fish|busybox|env|python[\d.]*w?|pyw?|perl[\d.]*|ruby[\d.]*|node(js)?|php[\d.]*|lua[\d.]*)$/;

function systemProgramDirs() {
  return isWindows
    ? [process.env.SystemRoot || process.env.windir || "C:\\Windows"]
    : ["/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/local/bin", "/usr/local/sbin",
        "/usr/lib", "/usr/lib64", "/usr/libexec", "/lib", "/lib64", "/etc", "/boot",
        "/dev", "/proc", "/sys"];
}

// realpath of the longest part of `target` that exists, with the rest
// appended as written: a start command may name a script that isn't there
// yet when it's saved, but a symlinked folder on the way to it still
// resolves to where it really leads.
function realpathOrNearest(target) {
  const rest = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

// path.relative() folds case on Windows, and answers with an absolute path
// for a target on another drive.
function isInsideFolder(target, folder, { orSame = false } = {}) {
  const rel = path.relative(folder, target);
  if (rel === "") return orSame;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// The server's own install DIRECTORY -- the anchor the launch target is
// confined to. It is the folder the launch actually runs in, picked exactly
// as ServerManager.loadConfig() picks this.serverPath (the cwd a relative
// start command is resolved against in startServer()): a custom launcher's
// own parent, else `serverPath || installPath`, else PZ_SERVER_PATH. It
// used to prefer installPath, so a record whose serverPath named a different
// folder had its relative start command checked against one folder and run
// from the other (security sweep 2026-10-04 adversary pass). For a launcher
// confinement is vacuous; the system-program/interpreter checks and the
// files.manage route gate are what protect it.
function installDirOf(server) {
  const launcher = resolveLaunchMode(server).launcherPath;
  if (launcher) return path.dirname(launcher);
  return server?.serverPath || server?.installPath || process.env.PZ_SERVER_PATH || "";
}

// What a server record launches, for findLaunchTargetRefusal(): its own
// install directory, its start command, and its custom launcher script if
// it has one.
export function launchTargetOf(server) {
  return {
    installDir: installDirOf(server),
    startCommand: server?.startCommand,
    launcherPath: resolveLaunchMode(server).launcherPath,
  };
}

// A resolved launch target is refused when it is an OS command interpreter
// (by file name) or sits in a system program directory -- true of every
// launch, start command or custom launcher alike.
function isSystemOrInterpreter(real) {
  if (
    systemProgramDirs().some((dir) =>
      isInsideFolder(real, realpathOrNearest(dir), { orSame: true }),
    )
  ) {
    return true;
  }
  const name = path.basename(real, path.extname(real)).toLowerCase();
  return COMMAND_INTERPRETER_RE.test(name);
}

// null when the launch may go ahead, or `{ program }` (the file name only,
// never its folder) when it is refused. A start command wins over a custom
// launcher, as in startServer().
//
// A START COMMAND is the EXEC-1 vector (`powershell.exe -enc <base64>`): its
// program is resolved against the install folder and must sit inside it --
// a command naming a program elsewhere on the host, legitimate or not, is
// refused (the plan's "legitimate but outside the folder" case, with an
// admin-fix message). A CUSTOM LAUNCHER (installPath/serverPath ending in a
// launcher extension) is the operator's own script and a real supported
// mode that can legitimately live anywhere, so it is NOT folder-confined --
// setting it is already admin-only (routes/servers.js), and here it only
// has to not be an interpreter or a system program. Both reject interpreters
// and system-dir programs. A start command with no install folder to
// confine it to is refused outright rather than left unconfined.
export function findLaunchTargetRefusal({ installDir, startCommand, launcherPath } = {}) {
  const command = typeof startCommand === "string" ? startCommand.trim() : "";
  if (command) {
    const cmd = parseCustomStartCommand(command).cmd;
    if (!cmd) return null;
    const program = path.basename(cmd) || cmd;
    if (!installDir) return { program };
    const folder = realpathOrNearest(installDir);
    const real = realpathOrNearest(path.resolve(installDir, cmd));
    if (!isInsideFolder(real, folder, { orSame: true })) return { program };
    if (isSystemOrInterpreter(real)) return { program };
    return null;
  }
  if (!launcherPath) return null;
  const program = path.basename(launcherPath) || launcherPath;
  if (isSystemOrInterpreter(realpathOrNearest(path.resolve(launcherPath)))) {
    return { program };
  }
  return null;
}

// The refusal, thrown by startServer() and forwarded by POST
// /api/server/start like SERVER_START_SCRIPT_MISSING below. Only the file
// name goes in `params`.
export function launchTargetRefusedError({ program }) {
  const error = new Error(
    `The panel won't launch ${program} for this server: it only launches a script or program inside the server's own install folder, never one elsewhere on this computer or a system command interpreter. An admin can fix this in My Servers › Edit Server: point Custom Start Command (or an Install Path that names a launcher script) at a script inside the server's install folder, or clear Custom Start Command so the panel writes and runs its own launch script.`,
  );
  error.code = ErrorCode.SERVER_LAUNCH_TARGET_REFUSED;
  error.params = { program };
  return error;
}

// The same refusal, asked before a Restart stops anything (see
// ServerManager.assertNamedStartupScriptLaunchable()).
export function launchTargetRestartRefusedError({ program }) {
  const error = new Error(
    `Restart called off before stopping the server, which is still running: the panel wouldn't launch ${program} to start it again, because it only launches a script or program inside the server's own install folder, never one elsewhere on this computer or a system command interpreter. An admin can fix this in My Servers › Edit Server, then restart again.`,
  );
  error.code = ErrorCode.SERVER_RESTART_LAUNCH_TARGET_REFUSED;
  error.params = { program };
  return error;
}

// Get the default startup script name for the current platform
function getDefaultStartupScript(windows = isWindows) {
  return windows ? "StartServer64.bat" : "start-server.sh";
}

// The stock launcher a no-Steam Windows server would have fallen back to,
// for SERVER_START_SCRIPT_MISSING's {{fallback}} -- the one this server
// used to run before GH #167, not always StartServer64.bat.
function stockStartupScript(useNoSteam) {
  return isWindows && useNoSteam
    ? "StartServer64_nosteam.bat"
    : getDefaultStartupScript();
}

// The launch script the panel generates for a MANAGED server (see
// resolveLaunchMode() below): routes/server.js's
// refreshLaunchTargetBeforeStart() writes both files into the install
// folder before every start, with -servername/-cachedir/-adminpassword
// baked in. `windows` is a parameter only so tests can ask for the other
// platform's name.
export function managedStartupScriptName(serverName, windows = isWindows) {
  return windows
    ? `StartServer_${serverName}.bat`
    : `start-server_${serverName}.sh`;
}

// The script loadConfig() launches for a MANAGED server: an explicit
// PZ_SERVER_BAT other than the stock name wins, then the server's own
// generated script when it has a name (GH #167, never the stock one), and
// the stock script only for a server with no name. One answer for the
// launch and for Debug › Diagnostics' start-script check, which used to
// keep its own list and still called the stock script "found" for a named
// server after #167. `windows` and `env` are parameters only for tests.
export function resolveManagedStartupScript(
  serverName,
  { windows = isWindows, env = process.env } = {},
) {
  const stock = getDefaultStartupScript(windows);
  const envBat = env.PZ_SERVER_BAT;
  if (envBat && envBat !== stock) return envBat;
  if (serverName) return managedStartupScriptName(serverName, windows);
  return envBat || stock;
}

// Whether a start of `server` runs the script the panel writes for it
// (managedStartupScriptName()): a MANAGED server with a name, no custom
// start command, not a Docker-mapped container (its image owns the launch
// command) and no PZ_SERVER_BAT naming another script. Anything else starts
// with a launcher the panel doesn't write -- a custom launcher path or start
// command, a container image's command, the stock script -- so the panel
// can't vouch for what it loads. Asked by Debug › Diagnostics' start-script
// and native-library checks, and by the pre-launch native-library warning
// (routes/server.js). `windows` and `env` are parameters only for tests.
export function launchesPanelStartScript(
  server,
  { windows = isWindows, env = process.env } = {},
) {
  const serverName = server?.serverName || "";
  if (!serverName || server?.startCommand) return false;
  if (["docker-local", "docker-managed"].includes(resolveProvider(server))) {
    return false;
  }
  if (resolveLaunchMode(server).mode !== "managed") return false;
  return (
    resolveManagedStartupScript(serverName, { windows, env }) ===
    managedStartupScriptName(serverName, windows)
  );
}

// GH #167: a managed server with a name launches its own generated script or
// nothing. The stock StartServer64.bat / start-server.sh passes no
// -servername or -cachedir, so Project Zomboid opens the default "servertest"
// world in ~/Zomboid -- not this server's world, ini or accounts -- and, with
// no admin account there, stops at a console prompt for a new admin password
// that a panel-launched process can never answer (it dies with
// java.util.NoSuchElementException). The panel used to fall back to that
// script whenever the named one was absent at the moment it first loaded its
// config -- on a fresh install, before the first start had written it -- and
// then kept launching it until the panel restarted. Asked at launch time
// instead, and a missing script is a refusal that says why.
//
// The folder stays out of `params`: a response redacts every path to
// "[path]" (sanitizeErrorParams), and the operator already knows which
// install folder the server uses. It stays in the message, which is what the
// panel log and the boot auto-start print.
export function namedStartupScriptMissingError({ script, folder, fallback }) {
  const error = new Error(
    `Startup script ${script} is missing from ${folder}. The panel writes it from this server's settings before every start but couldn't this time -- check that this folder exists and that the panel can write to it (the panel log has the exact error), then start again. The panel won't fall back to ${fallback}: that starts Project Zomboid's default "servertest" world instead of this server, and can stop at a prompt for a new admin password.`,
  );
  error.code = ErrorCode.SERVER_START_SCRIPT_MISSING;
  error.params = { script, fallback };
  return error;
}

// The same refusal, asked before a Restart stops anything (see
// ServerManager.assertNamedStartupScriptLaunchable()), so it says the
// server is still running and to restart, not start, again.
export function namedStartupScriptRestartRefusedError({ script, folder, fallback }) {
  const error = new Error(
    `Restart called off before stopping the server, which is still running: startup script ${script} is missing from ${folder} and the panel can't write it there, so it couldn't start the server again. Check that this folder exists and that the panel can write to it (the panel log has the exact error), then restart again. The panel won't fall back to ${fallback}: that starts Project Zomboid's default "servertest" world instead of this server, and can stop at a prompt for a new admin password.`,
  );
  error.code = ErrorCode.SERVER_RESTART_SCRIPT_MISSING;
  error.params = { script, fallback };
  return error;
}

// startServer()'s refusal when another local server that is running right
// now is configured for one of this server's two UDP game ports (see
// ServerManager._findRunningGamePortClash()). Coded like the refusals above,
// so the Dashboard and a failed Restart show it in the operator's language.
// `port` is the shared port, the game port or the one after it.
export function gamePortInUseError({ port, serverName }) {
  const error = new Error(
    `UDP port ${port} is already used by ${serverName}, which is running. Stop that server, or give this one a different game port, then start again.`,
  );
  error.code = ErrorCode.SERVER_START_GAME_PORT_IN_USE;
  error.params = { port, name: serverName };
  return error;
}

// Whether a new file can be created in `dir`: what writeFileAtomic() needs
// to write a launch script there (a temp file beside it, then a rename).
// Tried for real rather than asked with fs.accessSync(W_OK), which on
// Windows only looks at a folder's read-only attribute, never its ACL.
// Named like writeFileAtomic()'s own temp files, so its orphan sweep removes
// one a crash left behind. Returns the error, or null when it could.
function probeFolderWritable(dir, fileName) {
  const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  const probe = path.join(dir, `.${fileName}.${process.pid}.${suffix}.tmp`);
  try {
    fs.writeFileSync(probe, "", { flag: "wx" });
  } catch (error) {
    return error;
  }
  try {
    fs.unlinkSync(probe);
  } catch {
    /* best effort -- writeFileAtomic()'s orphan sweep clears it */
  }
  return null;
}

// Carries prepareForLaunch()'s "your hand-edited script was backed up"
// notices on a successful start's result, the field POST /api/server/start
// has always answered with. A copy, so a lifecycle provider's own result
// object is never mutated.
function withScriptWarnings(result, scriptWarnings) {
  return scriptWarnings?.length > 0 ? { ...result, scriptWarnings } : result;
}

function windowsPowerShellPath() {
  return path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

// What both Windows process lookups (the full scan and the pidfile fast
// path) select from Win32_Process, as ConvertTo-Csv rows parsed by
// parseWin32ProcessCsvRow() below. StartMs rides along so a process's start
// time comes from the same query that identified it -- see
// server/utils/processStartTime.js for why Windows is never asked for it
// separately.
const WIN32_PROCESS_COLUMNS = `ProcessId,CommandLine,${WIN32_PROCESS_START_MS}`;

// The full scan's query: every process that could be a dedicated server.
const WIN32_SERVER_SCAN_SCRIPT = `Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(java\\.exe|ProjectZomboid64\\.exe|ProjectZomboid32\\.exe)$' } | Select-Object ${WIN32_PROCESS_COLUMNS} | ConvertTo-Csv -NoTypeInformation`;

// How long the scan waits before looking again at processes that came back
// with no command line (see _scanWindowsServerProcesses()). A 4 GB JVM took
// ~400 ms to leave the process list once it began exiting (Windows 11,
// 2026-10-02); PowerShell's own start-up adds about as much again.
const WIN32_UNREADABLE_RECHECK_DELAY_MS = 750;

// Processes a scan already looked at twice and still found running with no
// readable command line, as "<pid>@<startMs>". Looking a third time can only
// end in "unknown" again, so a scan that finds nothing else skips straight
// to it instead of paying for another PowerShell start-up on every status
// poll. Rebuilt from each scan's own rows, so it never outlives a process.
const knownUnreadableWin32Processes = new Set();

// Repeats of the same scan warning within this window go to debug: a host
// that keeps answering the same way (a stopped server next to a java.exe the
// panel can't read) otherwise logs one identical warning per status poll --
// GH #190's log had ~1,400 of them in three weeks.
const SCAN_WARNING_REPEAT_MS = 10 * 60 * 1000;
const scanWarningLastLogged = new Map();

function warnScanThrottled(key, message) {
  const now = Date.now();
  const last = scanWarningLastLogged.get(key);
  if (last !== undefined && now - last < SCAN_WARNING_REPEAT_MS) {
    log.debug(message);
    return;
  }
  scanWarningLastLogged.delete(key);
  scanWarningLastLogged.set(key, now);
  // Oldest first: a Map iterates in insertion order.
  if (scanWarningLastLogged.size > 64) {
    scanWarningLastLogged.delete(scanWarningLastLogged.keys().next().value);
  }
  log.warn(message);
}

// Test seam: forget which scan warnings were already logged and which
// processes were already found unreadable, so one test's scan can't change
// what the next one logs or skips.
export function resetWin32ScanMemoryForTests() {
  knownUnreadableWin32Processes.clear();
  scanWarningLastLogged.clear();
}

// The fields of one ConvertTo-Csv record: each quoted value with its doubled
// quotes undone, or null for an empty UNQUOTED field -- how Windows
// PowerShell writes $null (captured live: `"4",,"1789503827395"`). A quoted
// value may contain commas and line breaks. Returns null for text that isn't
// such a record: Windows PowerShell quotes every value it writes, so any
// other unquoted text is not ConvertTo-Csv output.
function parseConvertToCsvRecord(text) {
  const fields = [];
  let i = 0;
  for (;;) {
    if (text[i] === '"') {
      let value = "";
      i += 1;
      for (;;) {
        const quote = text.indexOf('"', i);
        if (quote === -1) return null;
        value += text.slice(i, quote);
        if (text[quote + 1] === '"') {
          value += '"';
          i = quote + 2;
          continue;
        }
        i = quote + 1;
        break;
      }
      fields.push(value);
    } else {
      const end = text.indexOf(",", i);
      if ((end === -1 ? text.length : end) !== i) return null;
      fields.push(null);
    }
    if (i >= text.length) return fields;
    if (text[i] !== ",") return null;
    i += 1;
  }
}

// One data row of that CSV: "<pid>","<cmd>","<startMs>". Returns
// { pid, cmd, startedMs }, or null when the row isn't one.
//
// cmd is null, not a broken row, when PowerShell wrote CommandLine as null:
// Win32_Process reads the command line out of the process's own memory, so
// it has none for a process the panel may not read (started as
// administrator or by another user) and -- GH #190 -- for one that is
// exiting. A JVM tearing down a multi-gigabyte heap stays listed as
// `"<pid>",,"<startMs>"` until that finishes (captured 2026-10-02, Windows
// 11, 4 GB heap: ~400 ms with ThreadCount 1). That row used to be
// "malformed" and turned the whole scan into "unknown", which is what
// stopped a scheduled restart halfway. The scan now decides what a null
// command line means (see _scanWindowsServerProcesses()). An empty or
// missing StartMs only leaves startedMs null.
export function parseWin32ProcessCsvRow(raw) {
  const fields = parseConvertToCsvRecord(String(raw ?? "").trim());
  if (!fields || fields.length < 2 || fields.length > 3) return null;
  const [pid, cmd, startMs] = fields;
  if (pid === null || !/^\d+$/.test(pid)) return null;
  return { pid, cmd, startedMs: parseEpochMilliseconds(startMs) };
}

// ConvertTo-Csv output as one string per record. CreateProcess accepts any
// character in a command line, line breaks included, and ConvertTo-Csv
// keeps them inside the quoted value -- so a line that starts a row
// (`"<pid>",`) and leaves a quote open is joined with the lines after it
// until the quote closes, rather than read as two broken rows.
export function splitWin32ProcessCsvRecords(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/);
  const hasOpenQuote = (text) => (text.match(/"/g)?.length ?? 0) % 2 === 1;
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    let record = lines[i];
    if (/^\s*"\d+",/.test(record)) {
      while (hasOpenQuote(record) && i + 1 < lines.length) {
        i += 1;
        record += `\n${lines[i]}`;
      }
    }
    record = record.trim();
    if (record) records.push(record);
  }
  return records;
}

// What a row that didn't parse looked like, for the log: quoted values and
// other text are reduced to their lengths, so the line shows the row's shape
// without copying a command line (which can carry -adminpassword) into it.
export function describeWin32CsvRowShape(raw) {
  const text = String(raw ?? "");
  const shape = text.slice(0, 2000).replace(/"(?:[^"]|"")*"?|[^,"]+/g, (part) => {
    if (!part.startsWith('"')) return `<${part.length}>`;
    const closed = part.length > 1 && part.endsWith('"');
    return `"<${part.length - (closed ? 2 : 1)}>${closed ? '"' : ""}`;
  });
  return text.length > 2000 ? `${shape}...(${text.length} chars)` : shape;
}

// Sorts the rows of one Win32_Process scan: `matched` (a recognized
// dedicated-server launch, the shape _scanDedicatedServerProcesses()
// returns), `ambiguous` (JVM-shaped and zomboid-adjacent but not a launch
// shape it recognizes -- see looksLikeUndeterminedJvmCandidate), `unreadable`
// (listed with no command line -- see parseWin32ProcessCsvRow) and
// `malformed` (not a ConvertTo-Csv row at all). Anything else is noise.
export function classifyWin32ProcessRows(stdout) {
  const result = { matched: [], ambiguous: [], unreadable: [], malformed: [] };
  for (const record of splitWin32ProcessCsvRecords(stdout)) {
    if (record.startsWith('"ProcessId"')) continue;
    const row = parseWin32ProcessCsvRow(record);
    if (!row) {
      result.malformed.push(record);
      continue;
    }
    const { pid, cmd, startedMs } = row;
    if (cmd === null) {
      result.unreadable.push({ pid, startedMs });
    } else if (!cmd) {
      continue;
    } else if (isWindowsDedicatedServerCommandLine(cmd)) {
      log.debug(
        `getServerProcessDetails: matched PZ server process pid=${pid}: ${cmd.substring(0, 200)}`,
      );
      result.matched.push({
        pid,
        cmd,
        ...(startedMs != null ? { startedMs } : {}),
      });
    } else if (looksLikeUndeterminedJvmCandidate(cmd)) {
      log.debug(
        `getServerProcessDetails: Windows candidate ignored (not a recognized dedicated-server shape, but JVM-shaped and zomboid-adjacent -- treating as ambiguous): ${cmd.substring(0, 200)}`,
      );
      result.ambiguous.push(cmd.slice(0, 240));
    }
  }
  return result;
}

function runWindowsPowerShell(script, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      windowsPowerShellPath(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      { timeout: timeoutMs },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
  });
}

export function isWindowsDedicatedServerCommandLine(commandLine) {
  const normalized =
    typeof commandLine === "string" ? commandLine.toLowerCase() : "";
  if (!normalized) return false;

  // 1. Direct Java execution
  if (normalized.includes("zombie.network.gameserver")) {
    return true;
  }

  // 2. Native Launcher (Wrappers like WinGSM often call these with specific flags)
  if (
    normalized.includes("projectzomboid64.exe") ||
    normalized.includes("projectzomboid32.exe")
  ) {
    if (
      normalized.includes("-server") ||
      normalized.includes("startserver") ||
      normalized.includes("-servername")
    ) {
      return true;
    }
  }

  // 3. Fallback for custom generic setups (must explicitly name Zomboid)
  if (
    normalized.includes("zomboid") &&
    (normalized.includes("-server") || normalized.includes("startserver"))
  ) {
    return true;
  }

  return false;
}

// Linux/macOS equivalent of isWindowsDedicatedServerCommandLine above. Kept
// as a standalone module-level function (not just inline in the scan) so
// the pidfile fast path can classify a single live command line with the
// exact same rule the full OS scan uses, instead of a second copy that
// could drift out of sync.
function isLinuxDedicatedServerCommandLine(commandLine) {
  const lower = String(commandLine || "").toLowerCase();
  if (!lower) return false;
  if (lower.includes("zombie.network.gameserver")) return true;
  if (
    lower.includes("projectzomboid64") ||
    lower.includes("projectzomboid32")
  ) {
    if (
      lower.includes("-server") ||
      lower.includes("startserver") ||
      lower.includes("-servername")
    ) {
      return true;
    }
    return false;
  }
  if (
    lower.includes("zomboid") &&
    (lower.includes("-server") || lower.includes("startserver"))
  ) {
    return true;
  }
  return false;
}

// Deliberately BROADER than isLinuxDedicatedServerCommandLine above, and used
// for a different purpose: not to decide ownership, but to decide whether a
// zero-match scan is entitled to claim "definitely not running" at all.
//
// isLinuxDedicatedServerCommandLine requires a specific launch shape
// (zombie.network.GameServer, or ProjectZomboid64/32 combined with a
// -server-ish flag). A REAL dedicated server invoked a different way -- a
// -jar launcher (plausible for Build 42's shaded jar, see
// buildClasspathEntries()'s own comment), a wrapper script, a renamed
// binary -- produces a command line this function would confidently (and
// wrongly) call "not a dedicated server", and the scan around it returns
// `{running:false, scanFailed:false}`: a CONFIDENT wrong answer that skips
// every downstream fallback written to trigger on doubt (2026-08-29 Linux
// bug hunt, live Discord report -- verified false negative:
// isLinuxDedicatedServerCommandLine("... -jar projectzomboid.jar") is false
// even though the process is genuinely a running PZ server).
//
// This can never be made "complete" by adding more shapes to the narrow
// matcher -- there will always be one more shape nobody thought of, failing
// exactly as silently. Instead, the scan casts THIS wider, looser net
// (just "zomboid" or "zombie.network" appearing anywhere) purely to detect
// its own uncertainty: a candidate this catches that the narrow matcher
// rejects is EVIDENCE WORTH DOUBTING, not automatic proof -- see
// looksLikeUndeterminedJvmCandidate below for the second filter that turns
// "mentions zomboid somewhere" into "plausibly IS the thing we're unsure
// about".
function looksZomboidAdjacent(commandLine) {
  const lower = String(commandLine || "").toLowerCase();
  return lower.includes("zomboid") || lower.includes("zombie.network");
}

// CI regression (2026-08-29, same day as the fix above): a v1 version of
// this classified ANY looksZomboidAdjacent() match that failed the narrow
// test as ambiguous -- which is wrong, and the wrongness is exactly what
// god's dispatch warned about: "the exclusion has to be about what a
// candidate IS, not which pid it is". On a GitHub Actions runner the repo
// is checked out to /home/runner/work/zomboid-control-panel/zomboid-
// control-panel -- so EVERY sibling process on that host (other vitest
// workers, the runner's own supervisor, an unrelated shell) has "zomboid"
// somewhere in its own cwd-derived argv or script path, none of them a PZ
// server. The original fix only excluded THIS process's own pid
// (process.pid), which does nothing for a DIFFERENT process on the same
// host with a different pid -- so a genuinely idle CI runner reported
// "unknown" on every single check, permanently. Confirmed by reproducing
// the runner's exact checkout shape locally (a checkout literally named
// .../zomboid-control-panel/zomboid-control-panel with other node
// processes alive) -- byte-identical failure, not a hypothesis.
//
// The real fix has to ask a different question than "does this path
// mention zomboid" -- a path can ALWAYS mention zomboid for reasons that
// have nothing to do with a game server (this very repo's own directory
// name, a terminal cd'd into it, a backup job, an unrelated tool). What
// actually distinguishes a plausible-but-unrecognized PZ server from that
// noise is that a PZ dedicated server, however it's invoked -- the panel's
// own script, a -jar launcher, a native ProjectZomboid64/32 stub that execs
// into one -- is ALWAYS, by the time it's running, a JVM. A vitest worker,
// a shell, a backup script, an editor sitting in a zomboid-named directory
// are never going to have "java" as a substring of their own command line.
// Requiring BOTH signals (mentions zomboid/zombie.network AND looks like a
// JVM) is what makes "worth doubting" actually mean something, instead of
// "shares a directory name with the panel".
function looksLikeUndeterminedJvmCandidate(commandLine) {
  const lower = String(commandLine || "").toLowerCase();
  if (!looksZomboidAdjacent(lower)) return false;
  return /\bjava\b|\bjavaw\b|\/java$/.test(lower);
}

// Pull the value of a PZ launch argument (`-servername X`, `-cachedir="Y"`)
// out of a raw command line.
function extractLaunchArgValue(commandLine, flag) {
  const pattern = new RegExp(
    `(?:^|\\s)-${flag}(?:\\s*=\\s*|\\s+)("[^"]*"|'[^']*'|\\S+)`,
    "i",
  );
  const match = String(commandLine || "").match(pattern);
  if (!match) return null;
  const value = match[1].replace(/^["']|["']$/g, "").trim();
  return value || null;
}

// A process listing (pgrep -af, ps) joins the arguments with spaces and drops
// their quotes, so `-servername "AU-NZ Auckland PvE"` reads back as
// `-servername AU-NZ Auckland PvE` and extractLaunchArgValue() sees only
// "AU-NZ": a running server whose name has spaces then looked like another
// server's, was not detected, and the panel offered a second start (#223).
// True when the text after the flag begins with the whole expected value.
function launchArgStartsWith(commandLine, flag, expected, normalize = (v) => v.toLowerCase()) {
  const want = normalize(String(expected || "")).trim();
  if (!want) return false;
  const match = String(commandLine || "").match(new RegExp(`(?:^|\\s)-${flag}(?:\\s*=\\s*|\\s+)(.*)$`, "i"));
  if (!match) return false;
  const rest = normalize(match[1].replace(/^["']/, "")).trim();
  return rest === want || rest.startsWith(want + " ") || rest.startsWith(want + '"');
}

function normalizePathForCompare(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "");
  return isWindows ? normalized.toLowerCase() : normalized;
}

// A bare String.includes() lets "C:/Servers/MyServer" match inside
// "C:/Servers/MyServer2/..." -- a real sibling install, not this one. Require
// whatever comes right after the match (if anything) to actually end the
// path segment, the same boundary confineToRoots() already checks for the
// identical reason. cmd has already been through normalizePathForCompare, so
// every separator is "/" and there's nothing left to also match on "\\".
function pathAppearsInCommandLine(cmd, needle) {
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const idx = cmd.indexOf(needle, from);
    if (idx === -1) return false;
    const after = cmd[idx + needle.length];
    if (after === undefined || after === "/" || after === '"' || after === "'" || after === " ") {
      return true;
    }
    from = idx + 1;
  }
}

// Two supported ways to point the panel at a server -- an operator ruling,
// not an accident (2026-08-27, user-report-servertest-ini-and-sandbox-
// reverted-to-default-after-restart): MANAGED (a directory -- the panel
// generates, owns, and regenerates StartServer_<name>.bat/.sh, baking
// -cachedir/-servername into it) or CUSTOM LAUNCHER (a path ending in
// .bat/.sh/.exe -- the operator's own script; the panel launches it as-is
// and never regenerates or manages it). ONE predicate, asked by every
// caller that needs to know which: loadConfig() below (to resolve
// serverBat), server.js's refreshLaunchTargetBeforeStart() (to decide
// whether to regenerate the launch script before a start/restart), and
// servers.js's PUT/POST validation (to decide which shape rule a saved
// installPath/serverPath must satisfy). An existing file-shaped value must
// keep resolving as CUSTOM LAUNCHER -- this codifies behavior loadConfig()
// already had, it does not change it.
export function resolveLaunchMode(server) {
  const raw = server?.serverPath || server?.installPath;
  if (!raw || typeof raw !== "string") {
    return { mode: "managed", launcherPath: null };
  }
  const lower = raw.toLowerCase();
  if (lower.endsWith(".bat") || lower.endsWith(".sh") || lower.endsWith(".exe")) {
    return { mode: "custom", launcherPath: raw };
  }
  return { mode: "managed", launcherPath: null };
}

/**
 * How strongly a running process looks like it belongs to a given server.
 * Returns -1 when a launch argument proves it belongs to a DIFFERENT server,
 * 0 when the command line carries no identifying argument at all (so it
 * can't be attributed either way), and a positive score when it matches.
 *
 * This is what lets one host run several dedicated servers: the panel writes
 * `-servername` (and usually `-cachedir`) into every startup script it
 * generates, so each process names the server it belongs to.
 */
export function scoreServerProcessOwnership(commandLine, descriptor = {}) {
  const cmd = String(commandLine || "");
  if (!cmd) return 0;

  let score = 0;

  const nameArg = extractLaunchArgValue(cmd, "servername");
  if (nameArg && descriptor.serverName) {
    if (
      nameArg.toLowerCase() !== String(descriptor.serverName).toLowerCase() &&
      !launchArgStartsWith(cmd, "servername", descriptor.serverName)
    ) {
      return -1;
    }
    score += 3;
  }

  const cacheArg = extractLaunchArgValue(cmd, "cachedir");
  if (cacheArg && descriptor.savePath) {
    if (
      normalizePathForCompare(cacheArg) !== normalizePathForCompare(descriptor.savePath) &&
      !launchArgStartsWith(cmd, "cachedir", descriptor.savePath, normalizePathForCompare)
    ) {
      return -1;
    }
    score += 2;
  }

  const installPath = normalizePathForCompare(descriptor.serverPath);
  if (installPath && pathAppearsInCommandLine(normalizePathForCompare(cmd), installPath)) {
    score += 1;
  }

  return score;
}

function ownershipDescriptorFor(server) {
  return {
    serverName: server?.serverName,
    savePath: server?.zomboidDataPath,
    serverPath: server?.serverPath || server?.installPath,
  };
}

/**
 * Splits one host-wide scan (scanHostForServerProcesses()'s `matched`) into
 * the processes of local profiles OTHER than `excludeServer`, with the same
 * ownership rules /api/servers/status uses. A process that names no server
 * at all is the excluded server's when it has no positively matched process
 * of its own (getServerProcessDetails() claims those the same way), and
 * `unattributed` otherwise. Profiles run by systemd/OpenRC aren't in a
 * scan's attribution and are skipped.
 */
export function attributeOtherRunningServers(matched, servers, excludeServer) {
  const excludeDescriptor = ownershipDescriptorFor(excludeServer);
  const others = (Array.isArray(servers) ? servers : []).filter(
    (server) =>
      server &&
      !server.isRemote &&
      server.id !== excludeServer?.id &&
      !isManagedLifecycleProvider(server.lifecycleProvider),
  );
  const processes = Array.isArray(matched) ? matched : [];
  const excludeOwnsOne = Boolean(excludeServer) && processes.some(
    (candidate) => scoreServerProcessOwnership(candidate.cmd, excludeDescriptor) > 0,
  );

  const running = new Map();
  const unattributed = [];
  for (const candidate of processes) {
    const excludeScore = excludeServer
      ? scoreServerProcessOwnership(candidate.cmd, excludeDescriptor)
      : -1;
    if (excludeScore > 0) continue;
    const owner = others.find(
      (server) => scoreServerProcessOwnership(candidate.cmd, ownershipDescriptorFor(server)) > 0,
    );
    if (owner) {
      running.set(owner.id, owner);
      continue;
    }
    if (excludeScore === 0 && !excludeOwnsOne) continue;
    unattributed.push(candidate);
  }
  return { servers: [...running.values()], unattributed };
}

/**
 * Whether a host-wide scan that didn't fail still leaves one server's state
 * unknown: Windows listed java.exe/PZ processes whose command line the panel
 * may not read (the scan's `unreadable` -- see
 * ServerManager._scanWindowsServerProcesses()) and none of the processes it
 * could read is this server's (`ownsOne` false), so one of the unreadable
 * ones may be. A server with a process of its own in `matched` is running
 * whatever else is listed.
 */
export function scanLeavesServerUnknown(scan, ownsOne) {
  return !ownsOne && Array.isArray(scan?.unreadable) && scan.unreadable.length > 0;
}

/**
 * Local servers other than `excludeServer` that are running right now. Uses
 * a throwaway instance because a host-wide scan writes `isRunning` on the
 * instance that runs it.
 */
export async function findOtherRunningServers(excludeServer, { servers, scanner } = {}) {
  const list = servers ?? (await getServers());
  const scan = await (scanner ?? new ServerManager()).scanHostForServerProcesses();
  if (!scan || scan.scanFailed) {
    return { scanFailed: true, servers: [], unattributed: [] };
  }
  return {
    scanFailed: false,
    ...attributeOtherRunningServers(scan.matched, list, excludeServer),
  };
}

export class ServerManager {
  constructor({ lifecycleFactory = createLinuxServiceLifecycle } = {}) {
    this.serverProcess = null;
    // continuous-bug-hunt round 28 (ux-proposals-need-backend-data): a
    // native crash and a deliberate stop look IDENTICAL on the client today
    // -- both just show "stopped". stopIntent is set by whichever manager
    // method the panel itself calls to end the process on purpose
    // (stopServer/restartServer) BEFORE it actually happens; lastExitInfo
    // is a best-effort capture of the eventual exit code/signal from the
    // real spawned child (see _attachExitTracking). server/index.js's
    // checkServerStatusNow reads both the moment it observes running:true
    // -> false, classifies the transition (stop/restart/crash/unknown), and
    // consumes (clears) stopIntent so the NEXT stop is judged fresh rather
    // than inheriting a stale intent from a transition the watchdog never
    // got to observe.
    this.stopIntent = null;
    this.lastExitInfo = null;
    this.serverPath = process.env.PZ_SERVER_PATH || "";
    this.serverBat = process.env.PZ_SERVER_BAT || getDefaultStartupScript();
    this.savePath = process.env.PZ_SAVE_PATH || "";
    this.serverName = null;
    this.startCommand = "";
    this.rconHost = null;
    this.rconPort = null;
    this.isRunning = false;
    // timeout-handling-consistency-sweep, 2026-09-10: bumped by every
    // _scanDedicatedServerProcesses() call and again by that call's own
    // outer timeout if it fires first -- lets a scan whose result arrives
    // late (after its own timeout already gave up, or after a newer scan
    // superseded it) recognize it is no longer current and refuse to write
    // this.isRunning, rather than merely being unlikely to arrive late.
    this._scanGeneration = 0;
    // Best-known start time of the running server process: the OS's own
    // answer for the tracked PID whenever it can give one (see
    // resolveStartTime()), otherwise the moment this panel itself launched
    // it. _startTimePid records which PID that start time belongs to -- the
    // one the OS answered for, or, for a launch-time record, the first PID
    // seen after the launch (null until then) -- so a start time for one
    // process is never reported for another. _startTimeGeneration is bumped
    // whenever that record is dropped (_forgetStartTime()), so a lookup
    // still in flight across a stop, a launch or a server switch can't
    // write its old answer back.
    this.startTime = null;
    this._startTimePid = null;
    this._startTimeGeneration = 0;
    // pid -> { pending } or a failed { value: null, checkedAt }; see
    // getProcessStartTime().
    this._processStartTimes = new Map();
    this.configLoaded = false;
    // "managed" (the panel owns and regenerates the launch script) or
    // "custom" (the operator's own .bat/.sh/.exe -- see resolveLaunchMode()).
    this.launchMode = "managed";
    this.lifecycleProvider = "direct";
    this._serverRecord = null;
    this._lifecycleFactory = lifecycleFactory;
    // Which server this instance's currently-loaded config belongs to (null
    // = "the active server", the shared-singleton default). Recorded so
    // internal reload points (e.g. startServer()'s "settings may have
    // changed" refresh) reload the SAME target instead of silently
    // snapping a throwaway instance back to whatever is active.
    this._serverId = null;
    this.publicIp = null;
    this.gamePort = null;
    this.fetchingIp = false;
    // Instance field (not just the module constant) so tests can exercise
    // the real timeout wiring in _killPids/_genericForceStop without
    // waiting out the full production value.
    this._killTimeoutMs = KILL_EXEC_TIMEOUT_MS;
  }

  // Reload config (called when active server changes)
  async reloadConfig(serverId = null) {
    const previousServerId = this._serverRecord?.id ?? null;
    // Reset all config to defaults before reloading
    this.serverPath = process.env.PZ_SERVER_PATH || "";
    this.serverBat = process.env.PZ_SERVER_BAT || getDefaultStartupScript();
    this.savePath = process.env.PZ_SAVE_PATH || "";
    this.serverName = null;
    this.startCommand = "";
    this.rconHost = null;
    this.rconPort = null;
    this.launchMode = "managed";
    this.lifecycleProvider = "direct";
    this._serverRecord = null;
    this.configLoaded = false;
    await this.loadConfig(serverId);
    // Switching the active server used to carry the previous server's start
    // time straight over: getServerStatus() only re-derived it when it was
    // null, so a newly selected server that was also running showed the
    // OLD server's uptime. Only a change of server clears it -- reloadConfig()
    // also runs after ordinary settings saves, where the running process
    // (and a launch-time record the OS hasn't been able to replace) is
    // unchanged.
    if ((this._serverRecord?.id ?? null) !== previousServerId) {
      this._forgetStartTime();
    }
  }

  // Load settings from a specific server (serverId), the active server, or
  // legacy database settings. `serverId` lets the Scheduler point a
  // throwaway ServerManager instance at a server that isn't the
  // currently-active one — the shared singleton (called with no args, as
  // everywhere else in the app) keeps following the active server exactly
  // as before.
  async loadConfig(serverId = null) {
    if (this.configLoaded) return;
    this._serverId = serverId;
    try {
      // First, try to load from a specific server or the active server
      // (multi-server support)
      const activeServer = serverId
        ? await getServer(serverId)
        : await getActiveServer();
      if (activeServer) {
        this._serverRecord = activeServer;
        this.lifecycleProvider = activeServer.lifecycleProvider || "direct";
        // Use serverPath if available, otherwise extract from installPath
        let serverDir = activeServer.serverPath || activeServer.installPath;

        // CUSTOM LAUNCHER mode: the stored path points at the operator's own
        // .bat/.sh/.exe, not a directory the panel manages. Extract the
        // directory to run in and the launcher file to run.
        const launchMode = resolveLaunchMode(activeServer);
        this.launchMode = launchMode.mode;
        if (launchMode.mode === "custom") {
          const batchFileName = path.basename(launchMode.launcherPath);
          serverDir = path.dirname(launchMode.launcherPath);
          this.serverBat = batchFileName;
          log.debug(`Using custom launcher: ${batchFileName}`);
        }

        if (serverDir) {
          this.serverPath = serverDir;
          log.debug(`Loaded serverPath: ${serverDir}`);
        }

        if (activeServer.serverName) {
          this.serverName = activeServer.serverName;
        }
        // GH #167: a MANAGED server with a name always launches its own
        // generated script, whether or not it exists yet -- the start that
        // follows writes it (prepareForLaunch()) and checks for it right
        // before spawning (startServer()), so a script that appears after
        // this config load is still the one launched. This used to be
        // decided here with fs.existsSync(), fell back to the stock
        // StartServer64.bat / start-server.sh when the file wasn't there
        // yet, and stuck: loadConfig() returns early once loaded, and
        // nothing re-asked after the first start wrote the named script.
        // Assigned outright (not only when serverBat still held the default)
        // so a manager reloaded for another server never keeps the previous
        // server's script. A custom launcher keeps its own file, and an
        // explicit PZ_SERVER_BAT still wins, as before
        // (resolveManagedStartupScript()).
        if (launchMode.mode !== "custom") {
          this.serverBat = resolveManagedStartupScript(activeServer.serverName);
        }
        if (activeServer.zomboidDataPath) {
          this.savePath = activeServer.zomboidDataPath;
        }
        if (activeServer.startCommand) {
          this.startCommand = activeServer.startCommand;
          log.debug(`Using custom start command: ${this.startCommand}`);
        }
        // Kept per-server so the "is the port already taken?" preflight can
        // check THIS server's port instead of the global default.
        this.rconHost = activeServer.rconHost || this.rconHost;
        this.rconPort = activeServer.rconPort || this.rconPort;
        this.configLoaded = true;
        log.debug(`Loaded config from active server: ${activeServer.name}`);
        return;
      }

      // Fallback: load from legacy (global) settings — only meaningful when
      // no specific serverId was requested. Falling back to the global
      // settings for a targeted serverId lookup would silently point at
      // the wrong server instead of failing loudly on a bad/deleted id.
      if (!serverId) {
        const dbServerPath = await getSetting("serverPath");
        const dbServerName = await getSetting("serverName");
        const dbZomboidPath = await getSetting("zomboidDataPath");

        if (dbServerPath) {
          this.serverPath = dbServerPath;
          log.debug(`Loaded serverPath from database: ${dbServerPath}`);
        }
        // Defense in depth: config.js's PUT /app-settings now rejects an
        // unsafe serverName before it can be stored (the real fix), but an
        // install that already has one saved from before that validation
        // existed would otherwise carry it straight into this.serverName /
        // this.serverBat, which getServerConfig()/saveServerConfig() below
        // and the .bat/.sh launch path both interpolate into a filesystem
        // path unguarded. path.basename() unchanged is the same "safe or
        // reject" test serverFiles.js's getServerName() uses -- here a
        // reject just means "treat as if no legacy name were configured"
        // (this.serverName/this.serverBat stay at their prior/default
        // values, exactly like the `if (dbServerName)` false case already
        // did) rather than throwing, since this is a broad state-loading
        // method with many non-request callers, not a single-purpose
        // accessor a route handler can turn straight into a 400.
        if (dbServerName) {
          const safeServerName = path.basename(dbServerName);
          if (safeServerName === dbServerName && safeServerName) {
            this.serverName = dbServerName;
            // Use custom startup script if server was set up through the app
            if (isWindows) {
              this.serverBat = `StartServer_${dbServerName}.bat`;
            } else {
              this.serverBat = `start-server_${dbServerName}.sh`;
            }
          } else {
            log.warn(
              `Ignoring legacy settings.serverName "${dbServerName}" -- contains path-unsafe characters. Re-save the server name in Settings to clear this.`,
            );
          }
        }
        if (dbZomboidPath) {
          this.savePath = dbZomboidPath;
        }
        this.rconHost = (await getSetting("rconHost")) || this.rconHost;
        this.rconPort = (await getSetting("rconPort")) || this.rconPort;
      } else {
        log.warn(`No server config found for server ${serverId}`);
      }
      this.configLoaded = true;
    } catch (error) {
      log.debug(`Could not load server config from database: ${error.message}`);
    }
  }

  async checkServerRunning() {
    const details = await this.getServerProcessDetails();
    return details.running;
  }

  /**
   * Whether the previous server's JVM binary is still held open by a running
   * process -- checked directly at the kernel/filesystem level (ETXTBSY on
   * open-for-write) rather than inferred from the OS process table.
   *
   * getServerProcessDetails()'s pgrep/ps scan only sees processes in the
   * panel's OWN PID namespace. Our own docker-compose.yml explicitly
   * recommends and supports topologies where that isn't true -- PZ running
   * natively on the host, or in a separate container, with only the install
   * directory bind-mounted into the panel's container (docker-compose.yml's
   * "Topology 1"/"Topology 2"). In that shape the process scan can never see
   * the real PZ process and reports a confident `running: false` even while
   * it's still alive and shutting down -- there's nothing wrong with the
   * scan reading empty, the emptiness just isn't evidence of anything in
   * this topology. restartServer()'s "wait until the old process is
   * confirmed dead" loop then has nothing left to wait on, and starts a new
   * JVM while the old one still holds its own binary open -- the old one (or
   * whatever validates/patches the install before relaunching) then hits
   * "Text file busy" (Discord report, Rhazun, 2026-08-30) trying to rewrite
   * a file a process is still executing.
   *
   * This asks the kernel the actual question ETXTBSY is about -- is this
   * exact file currently busy -- which works regardless of which PID
   * namespace holds the process, because it's a property of the inode, not
   * the process table. Non-destructive: opens for read+write and closes
   * immediately without writing a single byte, so a clean result never
   * touches the binary's contents.
   *
   * Best-effort by design: if the JVM binary can't be located (unusual
   * install layout, custom launcher), or the open fails for any reason OTHER
   * than ETXTBSY (permissions, the file genuinely not existing), this
   * returns false rather than treating an unrelated error as "still busy" --
   * a permissions problem would fail identically forever and turn every
   * restart into an infinite wait, which is a worse failure than the one
   * this exists to catch. Windows doesn't have this failure mode at all
   * (file locking works differently there), so this is a no-op on Windows.
   *
   * This answers "is this file busy", never "is this MY server's old
   * process" -- multiple PZ servers legitimately sharing one install
   * directory (differing only by -servername/-cachedir, a normal
   * deployment shape this codebase already accommodates elsewhere) both
   * execute this same binary, so a "busy" result alone is NOT evidence of
   * anything wrong. That makes it safe to use as a REFUSAL only where the
   * cause is already known and unambiguous -- restartServer()'s wait loop,
   * right after THIS manager told the process at THIS path to quit. Anywhere
   * else (2026-08-30, caught before landing -- see startServer()'s own
   * comment at its call site), it must never be more than a bounded WAIT
   * that proceeds regardless once the bound expires: launching a new process
   * against a binary another process is already executing is ordinary,
   * unrestricted POSIX behavior (ETXTBSY is about opening for WRITE, never
   * about a second execute), so "still busy" after waiting a little is not
   * a reason to refuse -- it likely just means a sibling server is
   * legitimately running from the same install.
   */
  isJvmExecutableBusy() {
    if (isWindows) return false;

    const javaPath = findJvmExecutable(path.resolve(this.serverPath || ""));
    if (!javaPath) return false;

    try {
      const fd = fs.openSync(javaPath, "r+");
      fs.closeSync(fd);
      return false;
    } catch (error) {
      if (error?.code === "ETXTBSY") return true;
      log.debug(
        `isJvmExecutableBusy: could not probe ${javaPath} (${error?.code || error?.message}), not treating as busy`,
      );
      return false;
    }
  }

  // The identifying traits of the server this instance represents.
  _getOwnershipDescriptor() {
    return {
      serverName: this.serverName,
      savePath: this.savePath,
      serverPath: this.serverPath,
    };
  }

  /**
   * Like `checkServerRunning` but returns *which* processes the OS scan
   * matched, narrowed to the processes belonging to THIS server. Used by
   * chunk-cleanup endpoints (issue #5) so the UI can show the user exactly
   * which process the panel thinks is the dedicated server, and offer a
   * "force delete anyway" override when the detection is a false positive
   * (e.g. an unrelated java process matched, or a custom launcher script the
   * panel doesn't recognise).
   *
   * Resolves to `{ running, matched, owned, scanFailed }`. `matched` is
   * truncated to the first 3 entries with each cmd capped at 240 chars to
   * keep the JSON payload sane; `owned` is the untruncated list force-stop
   * uses to pick which PIDs it may kill.
   */
  async getServerProcessDetails() {
    await this.loadConfig(this._serverId);

    if (this.usesManagedServiceLifecycle()) {
      try {
        const lifecycle = this._getManagedLifecycle();
        const status = await lifecycle.status();
        if (!status.scanFailed) this.isRunning = status.running;
        return {
          running: status.running,
          matched: [],
          owned: [],
          scanFailed: Boolean(status.scanFailed),
          provider: this.lifecycleProvider,
          serviceName: lifecycle.serviceName,
          // The service manager's own record of the server's process
          // (systemd's MainPID, OpenRC's supervised child -- see
          // LinuxServiceLifecycle.status()), for resolveStartTime() --
          // deliberately NOT folded into matched/owned, which the kill paths
          // read: the unit's lifecycle, not a PID list, stays the way a
          // managed server is stopped.
          ...(status.mainPid ? { mainPid: status.mainPid } : {}),
          ...(status.error ? { error: status.error } : {}),
        };
      } catch (error) {
        log.warn(
          `Managed lifecycle status failed for "${this.serverName}": ${error.message}`,
        );
        return {
          running: false,
          matched: [],
          owned: [],
          scanFailed: true,
          provider: this.lifecycleProvider,
          error: error.message,
        };
      }
    }

    // Fast path: if we recorded the PID we spawned and it's still alive
    // with a command line that still looks like (and is attributable to)
    // this server, skip the full host-wide OS scan. On ANY doubt at all —
    // no pidfile, dead PID, or a live PID whose command line no longer
    // matches (including PID reuse by an unrelated process) — this
    // resolves to null and falls through to the exact same scan as before,
    // which remains the ground truth for every uncertain case.
    const fastPath = await this._tryPidFileFastPath();
    if (fastPath) return fastPath;

    const scan = await this._scanDedicatedServerProcesses();
    const descriptor = this._getOwnershipDescriptor();

    const owned = [];
    const unattributable = [];
    for (const candidate of scan.matched) {
      const score = scoreServerProcessOwnership(candidate.cmd, descriptor);
      if (score > 0) owned.push(candidate);
      else if (score === 0) unattributable.push(candidate);
    }

    // A command line carrying no -servername/-cachedir can't be attributed to
    // any particular server, so only claim those when nothing positively
    // matched this one — that keeps detection working for single-server
    // installs launched from a stock StartServer64.bat.
    const resolved = owned.length > 0 ? owned : unattributable;
    if (scan.matched.length !== resolved.length) {
      log.debug(
        `getServerProcessDetails: ${scan.matched.length} PZ server process(es) on this host, ${resolved.length} belong to "${this.serverName}"`,
      );
    }

    // A failed scan always resolves to an empty `matched` list, so
    // `resolved.length > 0` is unconditionally false here whenever
    // scanFailed is true -- writing it into the cached this.isRunning would
    // silently overwrite the last known-good state with a confident "not
    // running" the moment detection starts failing, which is exactly the
    // false confidence scanFailed exists to prevent elsewhere. Every reader
    // of this cached field (server/routes/serverStatus.js, the dashboard's
    // host signal) gets the SAME wrong "stopped" a failed detection scan
    // gives it, instead of "we don't know." Leave it at its previous value
    // when the scan couldn't tell.
    //
    // Nor could it tell when another server matched but processes it can't
    // read are listed too (Windows): one of those may be this server, so
    // "none of the readable ones is mine" is not "stopped" -- reporting it
    // stopped could let the panel start a second copy.
    const unreadable = Array.isArray(scan.unreadable) ? scan.unreadable : [];
    const unreadableLeftUnknown = scanLeavesServerUnknown(scan, resolved.length > 0);
    if (unreadableLeftUnknown && !scan.scanFailed) {
      const keys = unreadable.map((row) => `${row.pid}@${row.startedMs ?? "?"}`);
      warnScanThrottled(
        `unreadable-beside:${this.serverName}:${keys.join(",")}`,
        `getServerProcessDetails: another server is running, and Windows also lists process(es) ${unreadable.map((row) => row.pid).join(", ")} without a command line the panel may read -- can't tell whether one of them is "${this.serverName}", so its state is unknown`,
      );
    }
    const scanFailed = Boolean(scan.scanFailed) || unreadableLeftUnknown;
    if (!scanFailed) {
      this.isRunning = resolved.length > 0;
    }
    return {
      running: resolved.length > 0,
      matched: resolved.slice(0, 3).map((entry) => ({
        ...(entry.pid ? { pid: String(entry.pid) } : {}),
        cmd: String(entry.cmd || "").slice(0, 240),
        // Windows only -- see startTimeOf().
        ...(entry.startedMs != null ? { startedMs: entry.startedMs } : {}),
      })),
      owned: resolved,
      scanFailed,
      // What the scan couldn't read, when that is why it couldn't tell --
      // see waitForProcessExit()'s ownProcesses.
      ...(scanFailed && unreadable.length > 0 ? { unreadable } : {}),
    };
  }

  // Public wrapper around the raw, unfiltered, host-wide scan for callers
  // that need to judge MULTIPLE configured servers against one scan (e.g.
  // servers.js's /status list) rather than getServerProcessDetails()'s own
  // `matched`, which is already filtered down to (and capped/truncated for)
  // whichever ONE server this instance's loadConfig() points at -- reusing
  // that for every OTHER configured server silently made every non-active
  // server's real running process invisible to the list page. Callers
  // should attribute each returned candidate themselves via
  // scoreServerProcessOwnership(candidate.cmd, descriptor) per server.
  async scanHostForServerProcesses() {
    return this._scanDedicatedServerProcesses();
  }

  // Raw OS scan: every Project Zomboid dedicated server process on this host,
  // regardless of which configured server it belongs to.
  async _scanDedicatedServerProcesses() {
    // timeout-handling-consistency-sweep, 2026-09-10: widening the outer
    // guard below (to comfortably exceed the Linux/macOS fallback chain's
    // ~16000ms worst case) only makes the race rarer, not gone -- whenever
    // the outer guard DOES still win (it is a widened ceiling, not a
    // rewritten mechanism), the real scan's callback can still land later
    // and unconditionally write this.isRunning, superseding a caller who
    // already moved on with a stale answer. This generation stamp makes
    // that write structurally impossible instead of merely unlikely: bumped
    // here at the start of every scan attempt, and again by this attempt's
    // own timeout if it fires first (see below) -- a late callback checks
    // it's still the current generation before writing this.isRunning, and
    // simply skips the write (still resolves the promise; the caller
    // already has its own answer) if a newer attempt or its own timeout has
    // superseded it.
    const scanGeneration = ++this._scanGeneration;
    return new Promise((resolve) => {
      log.debug(
        `getServerProcessDetails: starting detection (platform=${process.platform})`,
      );
      const matched = [];
      const pushMatch = (cmd, pid, startedMs = null) => {
        // Keep the command line intact: ownership matching needs the
        // -servername / -cachedir arguments, which sit well past 240 chars.
        const full = String(cmd || "");
        matched.push({
          ...(pid ? { pid: String(pid) } : {}),
          cmd: full,
          ...(startedMs != null ? { startedMs } : {}),
        });
      };

      // This outer guard races BOTH platform branches below, and the
      // Linux/macOS branch is a SEQUENTIAL fallback chain -- pgrep (own
      // 8000ms timeout), and only if that fails/empties, ps aux (another
      // 8000ms) -- whose worst case is ~16000ms, well past the old 10000ms
      // ceiling here. Widened past that worst case with real margin so this
      // fires less often; the generation bump below is what makes it safe
      // on the (still possible) occasions it fires anyway. The Windows
      // branch settles on its own well inside it: an 8000ms scan, plus --
      // only when processes came back with no command line -- a
      // WIN32_UNREADABLE_RECHECK_DELAY_MS pause and a second 8000ms scan
      // (see _scanWindowsServerProcesses()).
      const timeout = setTimeout(() => {
        // Invalidate THIS attempt (only if nothing already has -- a newer
        // scan call bumping the counter first is just as valid a
        // supersession) so its own real callback, whenever it eventually
        // lands, sees a stale generation and skips the this.isRunning write.
        if (this._scanGeneration === scanGeneration) this._scanGeneration++;
        log.warn(
          "getServerProcessDetails: process detection timed out, cannot determine server state",
        );
        resolve({ running: false, matched: [], scanFailed: true });
      }, 18000);

      if (isWindows) {
        // _scanWindowsServerProcesses() never rejects.
        void this._scanWindowsServerProcesses().then((result) => {
          clearTimeout(timeout);
          if (!result.scanFailed && this._scanGeneration === scanGeneration) {
            this.isRunning = result.running;
          }
          resolve(result);
        });
      } else {
        // Linux/macOS: pgrep first (faster, more reliable), fall back to ps aux -ww.
        // Use the same dedicated-server heuristics as Windows (module-level
        // isLinuxDedicatedServerCommandLine above) so a player running the
        // *game* (ProjectZomboid64) on the same box doesn't false-positive
        // as a running dedicated server. Direct `zombie.network.GameServer`
        // java invocations always qualify.
        //
        // The search itself is deliberately BROADER than
        // isLinuxDedicatedServerCommandLine -- see looksZomboidAdjacent's
        // own comment. Every candidate this turns up is classified into one
        // of three buckets: CONFIRMED (matches the narrow launch-shape
        // pattern -- pushed into `matched`, unchanged behavior), AMBIGUOUS
        // (fails the narrow pattern but ALSO looks like an unidentified JVM
        // -- see looksLikeUndeterminedJvmCandidate's own comment for why
        // this second filter, not just "mentions zomboid", is required), or
        // discarded as noise (mentions zomboid/zombie.network for a reason
        // that has nothing to do with a game server -- a checkout path, a
        // sibling test-runner process, a shell sitting in this repo). Zero
        // confirmed AND zero ambiguous is a genuinely idle host: confidently
        // not running, exactly as before. Zero confirmed but at least one
        // ambiguous candidate is the case this fix exists for: real
        // JVM-shaped evidence we can't rule out, so the scan reports
        // scanFailed:true (renders as "unknown" downstream) instead of a
        // confident, possibly wrong, "not running".
        log.debug("getServerProcessDetails: trying pgrep -af first...");
        const ambiguous = [];
        const pushAmbiguous = (cmd) => {
          ambiguous.push(String(cmd || "").slice(0, 240));
        };
        // Bracket-obfuscated (matches the narrow pattern's own existing
        // convention below, NOT a plain -i flag): exec() runs this through
        // `sh -c "<command>"`, and that wrapper's OWN argv, read back by
        // this very scan, literally contains the pattern text -- a plain
        // "zomboid|zombie.network" search string self-matches its own
        // invocation. "[Zz]omboid" in the wrapper's own argv does not
        // contain the bare substring "zomboid", so it doesn't self-trigger.
        exec(
          'pgrep -af "[Zz]omboid|[Zz]ombie\\.network"',
          { timeout: 8000 },
          (pgrepErr, pgrepOut) => {
            if (!pgrepErr && pgrepOut && pgrepOut.trim()) {
              for (const line of pgrepOut.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                // pgrep -af format: "<pid> <cmdline>"
                const m = trimmed.match(/^(\d+)\s+(.*)$/);
                const pid = m ? m[1] : undefined;
                const cmd = m ? m[2] : trimmed;
                // Belt-and-braces: exclude the panel's own process. Not the
                // load-bearing fix (a `node` process never matches
                // looksLikeUndeterminedJvmCandidate's java requirement
                // anyway), but cheap and makes the intent explicit even in
                // some future edge case where a panel process's own args
                // happen to contain "java" as a substring.
                if (pid && Number(pid) === process.pid) continue;
                if (isLinuxDedicatedServerCommandLine(cmd)) {
                  pushMatch(cmd, pid);
                } else if (looksLikeUndeterminedJvmCandidate(cmd)) {
                  log.debug(
                    `getServerProcessDetails: pgrep candidate ignored (not a recognized dedicated-server shape, but JVM-shaped and zomboid-adjacent -- treating as ambiguous): ${cmd.substring(0, 200)}`,
                  );
                  pushAmbiguous(cmd);
                } else {
                  log.debug(
                    `getServerProcessDetails: pgrep candidate discarded (zomboid-adjacent but not JVM-shaped -- not evidence): ${cmd.substring(0, 200)}`,
                  );
                }
              }
              log.debug(
                `getServerProcessDetails: pgrep matched ${matched.length} confirmed / ${ambiguous.length} ambiguous process(es)`,
              );
              clearTimeout(timeout);
              if (matched.length === 0 && ambiguous.length > 0) {
                // Leave this.isRunning at its previous value -- exactly the
                // same "a scan that couldn't tell must not overwrite the
                // last known-good state" rule getServerProcessDetails()
                // already applies via scanFailed for every OTHER uncertain
                // case (see its own comment). Only a scan that ran clean
                // and found nothing at all is entitled to claim false.
                log.warn(
                  `getServerProcessDetails: found ${ambiguous.length} JVM-shaped process(es) mentioning zomboid/zombie.network that don't match a known dedicated-server launch shape -- cannot confirm the server is stopped (first: ${ambiguous[0]})`,
                );
                resolve({ running: false, matched: [], scanFailed: true });
                return;
              }
              if (this._scanGeneration === scanGeneration) this.isRunning = matched.length > 0;
              resolve({ running: matched.length > 0, matched });
              return;
            }
            // Fallback: ps aux
            log.debug(
              "getServerProcessDetails: pgrep failed or empty, falling back to ps aux -ww",
            );
            exec("ps aux -ww", { timeout: 8000 }, (err, stdout) => {
              clearTimeout(timeout);
              if (err || !stdout) {
                log.warn(
                  `getServerProcessDetails: ps aux scan failed (${err ? err.message : "empty output"}), cannot determine server state`,
                );
                resolve({ running: false, matched: [], scanFailed: true });
                return;
              }
              for (const line of stdout.split(/\r?\n/)) {
                const lower = line.toLowerCase();
                if (!looksZomboidAdjacent(lower)) continue;
                // Skip our own grep / pgrep / ps invocations
                if (
                  /\b(ps|pgrep|grep)\b.*\b(zombie|zomboid|projectzomboid)/.test(
                    lower,
                  ) &&
                  !lower.includes("java") &&
                  !lower.includes("-server")
                ) {
                  continue;
                }
                // ps aux columns: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
                const m = line
                  .trim()
                  .match(
                    /^\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/,
                  );
                const pid = m ? m[1] : undefined;
                const cmd = m ? m[2] : line.trim();
                if (pid && Number(pid) === process.pid) continue;
                if (isLinuxDedicatedServerCommandLine(cmd)) {
                  pushMatch(cmd, pid);
                } else if (looksLikeUndeterminedJvmCandidate(cmd)) {
                  pushAmbiguous(cmd);
                }
              }
              if (matched.length === 0 && ambiguous.length > 0) {
                log.warn(
                  `getServerProcessDetails: found ${ambiguous.length} JVM-shaped process(es) mentioning zomboid/zombie.network that don't match a known dedicated-server launch shape -- cannot confirm the server is stopped (first: ${ambiguous[0]})`,
                );
                resolve({ running: false, matched: [], scanFailed: true });
                return;
              }
              if (this._scanGeneration === scanGeneration) this.isRunning = matched.length > 0;
              resolve({ running: matched.length > 0, matched });
            });
          },
        );
      }
    });
  }

  // The Windows half of _scanDedicatedServerProcesses(): resolves to the same
  // { running, matched, scanFailed? } and never rejects. Rows are sorted by
  // classifyWin32ProcessRows() -- the Linux branch's CONFIRMED / AMBIGUOUS /
  // noise buckets, plus processes listed with no command line.
  //
  // The WMI filter only lets java.exe and ProjectZomboid64/32.exe through,
  // so a row with no command line is a JVM or PZ binary the scan can't
  // identify. When nothing else settles the question, the scan looks again
  // once, shortly after:
  //   - gone by then, or readable now: it was a process on its way out --
  //     GH #190, the old server exiting after a restart's `quit` -- and the
  //     second look's answer is the answer;
  //   - still listed with no command line: a live process the panel may not
  //     read (started as administrator or by another Windows user). It could
  //     be this very server, so the scan stays "unknown", as it always has --
  //     calling it stopped could let the panel start a second copy.
  //
  // Those processes come back as `unreadable` ({ pid, startedMs }), on an
  // unknown answer and next to a recognized server alike. A recognized
  // server makes the host "running" without a second look, but a server
  // none of `matched` belongs to may still be one of them: see
  // getServerProcessDetails() and scanLeavesServerUnknown(). And a wait
  // that knows its server's PIDs can tell those apart from the unreadable
  // ones -- see waitForProcessExit().
  async _scanWindowsServerProcesses({ lookAgain = true } = {}) {
    const unknown = { running: false, matched: [], scanFailed: true };
    try {
      const { error, stdout, stderr } = await runWindowsPowerShell(
        WIN32_SERVER_SCAN_SCRIPT,
        8000,
      );
      const diagnostics = String(stderr || "").trim();
      if (error || diagnostics) {
        const detail = [error?.message, diagnostics].filter(Boolean).join(": ");
        log.warn(
          `getServerProcessDetails: Windows process scan failed (${detail}), cannot determine server state`,
        );
        return unknown;
      }

      // Empty stdout with NO error is a legitimate, successful result, not a
      // failure: ConvertTo-Csv derives its header from the first object it
      // receives, so an empty filtered Win32_Process pipeline (the normal,
      // expected shape when no PZ server process exists) produces NO output
      // at all -- not even a header row. Confirmed empirically on a real
      // Windows host (2026-08-23): error is null, exit code 0, stdout is "".
      // Treating that identically to a real exec failure meant a genuinely
      // STOPPED Windows server could never be confirmed stopped --
      // deterministically, on every check -- which is exactly the state
      // every fail-closed guard (/wipe included) exists to detect. This is
      // what a real user hit.
      if (!stdout) {
        knownUnreadableWin32Processes.clear();
        return { running: false, matched: [] };
      }

      const rows = classifyWin32ProcessRows(stdout);
      if (rows.matched.length > 0) {
        return {
          running: true,
          matched: rows.matched,
          ...(rows.unreadable.length > 0 ? { unreadable: rows.unreadable } : {}),
        };
      }

      // A real dedicated server can be launched in a shape
      // isWindowsDedicatedServerCommandLine doesn't recognize (a generic
      // `java -jar` with no "zomboid" in the jar path and no -server flag),
      // so JVM-shaped, zomboid-adjacent evidence it can't rule out leaves
      // the state unknown rather than a confident "not running". A plain
      // client launch of ProjectZomboid64.exe is noise, not ambiguous (no
      // "java" in its own command line): an operator playing the game on
      // the same host must not flip every scan to "can't confirm stopped".
      if (rows.ambiguous.length > 0) {
        warnScanThrottled(
          `ambiguous:${rows.ambiguous[0]}`,
          `getServerProcessDetails: found ${rows.ambiguous.length} JVM-shaped process(es) mentioning zomboid/zombie.network that don't match a known dedicated-server launch shape -- cannot confirm the server is stopped (first: ${rows.ambiguous[0]})`,
        );
        return unknown;
      }

      if (rows.malformed.length > 0) {
        const shape = describeWin32CsvRowShape(rows.malformed[0]);
        warnScanThrottled(
          `malformed:${shape}`,
          `getServerProcessDetails: Windows process scan returned unparseable output (${rows.malformed.length} row(s), first shaped ${shape}), cannot determine server state`,
        );
        return unknown;
      }

      const keys = rows.unreadable.map(
        (row) => `${row.pid}@${row.startedMs ?? "?"}`,
      );
      if (keys.length === 0) {
        knownUnreadableWin32Processes.clear();
        return { running: false, matched: [] };
      }
      const pids = rows.unreadable.map((row) => row.pid).join(", ");
      if (
        lookAgain &&
        !keys.every((key) => knownUnreadableWin32Processes.has(key))
      ) {
        log.debug(
          `getServerProcessDetails: PID(s) ${pids} came back with no command line; looking again in ${WIN32_UNREADABLE_RECHECK_DELAY_MS}ms`,
        );
        await this.sleep(WIN32_UNREADABLE_RECHECK_DELAY_MS);
        const second = await this._scanWindowsServerProcesses({
          lookAgain: false,
        });
        if (!second.scanFailed) {
          log.debug(
            `getServerProcessDetails: PID(s) ${pids} had no command line and were gone or readable on a second look -- a process exiting, not counted`,
          );
        }
        return second;
      }

      knownUnreadableWin32Processes.clear();
      for (const key of keys) knownUnreadableWin32Processes.add(key);
      warnScanThrottled(
        `unreadable:${keys.join(",")}`,
        `getServerProcessDetails: Windows lists java.exe/ProjectZomboid process(es) ${pids} but won't give the panel their command line -- usually a process started as administrator or by another Windows user while the panel isn't, or one still exiting after a large heap. Can't tell whether one of them is this server, so its state is unknown`,
      );
      return { ...unknown, unreadable: rows.unreadable };
    } catch (error) {
      log.warn(
        `getServerProcessDetails: Windows process scan failed (${error.message}), cannot determine server state`,
      );
      return unknown;
    }
  }

  // Pidfile path is scoped by server name, not a single shared file — this
  // host can run several dedicated servers (see the two-server tests above),
  // and a shared pidfile would let one server's start/stop clobber another's
  // fast-path record. Sanitized because serverName can come from user-edited
  // settings.
  _pidFilePath() {
    const safeName = String(this.serverName || "default").replace(
      /[^a-zA-Z0-9_-]/g,
      "_",
    );
    return path.join(getDataPaths().dataDir, `server-process-${safeName}.json`);
  }

  // Best-effort — a failure to persist the pidfile never blocks a start; it
  // only means the next reacquisition falls through to the full OS scan,
  // which is the existing, already-safe behavior.
  _writePidFile(pid) {
    try {
      const data = {
        pid: String(pid),
        serverName: this.serverName,
        writtenAt: Date.now(),
      };
      fs.writeFileSync(this._pidFilePath(), JSON.stringify(data), "utf-8");
    } catch (e) {
      log.debug(`Could not write server pidfile: ${e.message}`);
    }
  }

  _readPidFile() {
    try {
      const raw = fs.readFileSync(this._pidFilePath(), "utf-8");
      const data = JSON.parse(raw);
      if (!data || !/^\d+$/.test(String(data.pid))) return null;
      return data;
    } catch {
      return null; // Missing, corrupt, or unreadable — treated the same as "no pidfile".
    }
  }

  _deletePidFile() {
    try {
      fs.unlinkSync(this._pidFilePath());
    } catch {
      /* already absent — fine, this is best-effort cleanup */
    }
  }

  // Single-PID lookup used only by the pidfile fast path — far cheaper than
  // the full host-wide scan. Resolves to { cmd } ({ cmd, startedMs } on
  // Windows, the same columns the full scan reads -- see startTimeOf()), or
  // to null (never throws) when the PID isn't alive or the lookup
  // fails/times out, which the fast path treats identically to "no usable
  // pidfile".
  _getLiveProcess(pid) {
    if (!/^\d+$/.test(String(pid || ""))) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timeout = setTimeout(() => finish(null), 3000);

      if (isWindows) {
        // execFile with the scan's own PowerShell path and flags (no
        // cmd.exe quoting layer); pid is pre-validated as digits-only above
        // so this interpolation is safe.
        const powershellScript = `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object ${WIN32_PROCESS_COLUMNS} | ConvertTo-Csv -NoTypeInformation`;
        execFile(
          windowsPowerShellPath(),
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            powershellScript,
          ],
          { timeout: 2500 },
          (err, stdout) => {
            clearTimeout(timeout);
            if (err) return finish(null);
            // A row with no command line (cmd: null -- an exiting process,
            // or one the panel may not read) answers null here, and the
            // full scan decides what it means.
            const row = splitWin32ProcessCsvRecords(stdout)
              .filter((record) => !record.startsWith('"ProcessId"'))
              .map(parseWin32ProcessCsvRow)
              .find(Boolean);
            finish(
              row?.cmd
                ? {
                    cmd: row.cmd,
                    ...(row.startedMs != null ? { startedMs: row.startedMs } : {}),
                  }
                : null,
            );
          },
        );
      } else {
        execFile(
          "ps",
          ["-ww", "-o", "cmd=", "-p", String(pid)],
          { timeout: 2500 },
          (err, stdout) => {
            clearTimeout(timeout);
            const cmd = err ? "" : String(stdout || "").trim();
            finish(cmd ? { cmd } : null);
          },
        );
      }
    });
  }

  // Resolves to a getServerProcessDetails()-shaped result if the recorded
  // pidfile checks out, or null on any doubt (caller then runs the full
  // scan). Deliberately reuses the SAME classification
  // (isWindowsDedicatedServerCommandLine / isLinuxDedicatedServerCommandLine)
  // and the SAME ownership scoring (scoreServerProcessOwnership) as the full
  // scan, rather than a second set of rules — a live PID whose command line
  // no longer matches (e.g. reused by an unrelated process, or now belongs
  // to a different configured server) is exactly the case this must not
  // trust, which is why it falls through instead of reporting "not running".
  async _tryPidFileFastPath() {
    const recorded = this._readPidFile();
    if (!recorded) return null;

    const live = await this._getLiveProcess(recorded.pid);
    const cmd = live?.cmd;
    if (!cmd) return null;

    const looksLikeDedicatedServer = isWindows
      ? isWindowsDedicatedServerCommandLine(cmd)
      : isLinuxDedicatedServerCommandLine(cmd);
    if (!looksLikeDedicatedServer) return null;

    const score = scoreServerProcessOwnership(
      cmd,
      this._getOwnershipDescriptor(),
    );
    // Deliberately stricter than the full scan's `owned` bucket threshold
    // (score > 0), not merely "not proven wrong" (score !== -1). The full
    // scan can fall back to an unattributable (score === 0) candidate
    // because it has visibility into every PZ-looking process on the host
    // and only does so when NOTHING else positively matched -- exactly the
    // comparison this single-PID lookup cannot make. Accepting score === 0
    // here would mean: a live PID whose command line merely "looks like a
    // dedicated server" but carries no -servername/-cachedir (or carries
    // one that matches neither this server's name nor its install path) is
    // trusted as confirmed to BE this server -- which is precisely the PID-
    // reuse doubt this fast path exists to fall through on, per its own
    // doc comment above. Falling through here costs one full scan; wrongly
    // accepting it can misreport another server's process as this one's,
    // including to stopServer()'s kill path.
    if (score <= 0) return null;

    log.debug(
      `getServerProcessDetails: pidfile fast path hit for pid=${recorded.pid}, skipping full scan`,
    );
    this.isRunning = true;
    const startedMs = live.startedMs != null ? { startedMs: live.startedMs } : {};
    const entry = { pid: String(recorded.pid), cmd: String(cmd), ...startedMs };
    return {
      running: true,
      matched: [{ pid: entry.pid, cmd: entry.cmd.slice(0, 240), ...startedMs }],
      owned: [entry],
      scanFailed: false,
    };
  }

  // When process <pid> started (epoch ms), from the OS -- see
  // server/utils/processStartTime.js -- or null. History: this began as
  // getProcessUptimeSeconds(), a one-off recovery that ran only while
  // this.startTime was null (continuous-bug-hunt round 20 added its Windows
  // Win32_Process branch -- before that a panel restart reset a Windows
  // server's uptime to 0 every time). Windows start times now come with
  // the process scan itself (see startTimeOf()); this asks Linux (two small
  // /proc reads, no spawn) and the ps fallback elsewhere.
  //
  // A successful answer is deliberately NOT cached. A PID names the same
  // process only until that process exits: an answer kept "until the panel
  // sees the process stop" outlived every restart the panel never saw (a
  // crash-restart wrapper, systemd's Restart=, another server's row on the
  // list page) and was then served for whichever later process reused the
  // PID. What is kept: one in-flight lookup shared by concurrent callers
  // (the dashboard's two status routes land together), and a FAILED lookup,
  // retried at most once a minute rather than on every poll -- a remembered
  // failure can only ever report "unknown", never a wrong time.
  async getProcessStartTime(pid) {
    const key = String(pid ?? "");
    if (!/^[1-9]\d*$/.test(key)) return null;

    const cached = this._processStartTimes.get(key);
    if (cached?.pending) return cached.pending;
    if (cached && Date.now() - cached.checkedAt < FAILED_START_TIME_RETRY_MS) {
      return null;
    }

    const pending = readProcessStartTime(key).then((value) => {
      if (this._processStartTimes.get(key)?.pending === pending) {
        if (value === null) {
          this._processStartTimes.set(key, { value: null, checkedAt: Date.now() });
        } else {
          this._processStartTimes.delete(key);
        }
      }
      return value;
    });
    this._processStartTimes.delete(key);
    this._processStartTimes.set(key, { pending });
    // Bounded: the per-server list route asks about every running server's
    // PID, and each restart is a new PID. Map iteration order is insertion
    // order, so the first key is the least recently (re)looked-up one.
    if (this._processStartTimes.size > MAX_CACHED_START_TIMES) {
      this._processStartTimes.delete(this._processStartTimes.keys().next().value);
    }
    return pending;
  }

  // When the process a status check found started (epoch ms), or null.
  // `entry` is a process-detection entry ({ pid, cmd }, from
  // getServerProcessDetails()'s `matched` or the host-wide scan) or
  // { pid } for a systemd unit's MainPID. On Windows the entry already
  // carries startedMs, read from the very Win32_Process row that identified
  // the process: no second PowerShell cold start (which routinely outran
  // its timeout while a loading PZ server saturated the CPU), and no way
  // for it to describe a later process that reused the PID. Everywhere else
  // the OS is asked by PID.
  async startTimeOf(entry) {
    if (!entry?.pid) return null;
    if (Number.isFinite(entry.startedMs)) {
      return isPlausibleStartMs(entry.startedMs) ? entry.startedMs : null;
    }
    return this.getProcessStartTime(entry.pid);
  }

  // The start time to report for THIS server's running process, or null
  // when it honestly can't be known. Prefers the OS's answer for the process
  // the status check just found -- a managed lifecycle's own record of it
  // (systemd's MainPID, OpenRC's supervised child; such a server has no
  // process-scan PID at all), otherwise the scanned or pidfile process -- so
  // it is right no matter who started it: this panel, a previous panel
  // process (a panel restart or self-update, which KillMode=process
  // deliberately survives), the service manager at boot or after a
  // Restart=on-failure or supervise-daemon respawn, or the operator by hand.
  //
  // When the OS can't answer, this.startTime is still reported only if it
  // belongs to this same PID: an earlier answer for it, or this panel's own
  // launch-time record, which the first PID seen after the launch claims
  // (the process the panel just started). Anything else is the previous
  // process's start time and is dropped, leaving the uptime unknown until
  // the OS can speak for the new process: a record for a DIFFERENT PID, and
  // any record at all while the check found no PID to hold it against --
  // systemd's "activating (auto-restart)" window after a crash (MainPID 0),
  // or an OpenRC service whose child supervise-daemon didn't record, where
  // an unverified launch record would outlive every respawn. Remote SFTP
  // and Docker servers have no local PID here and stay unknown on this
  // path; the composed status route supplies a Docker container's own start
  // time instead.
  async resolveStartTime(processDetails) {
    if (!processDetails?.running) return null;
    const entry = processDetails.mainPid
      ? { pid: processDetails.mainPid }
      : processDetails.matched?.[0];
    const pid = entry?.pid ? String(entry.pid) : null;
    const generation = this._startTimeGeneration;
    const startedMs = await this.startTimeOf(entry);
    // A stop, a launch or a server switch landed while the OS was being
    // asked (_forgetStartTime()): the answer is about a process this manager
    // no longer tracks, and writing it back would restore the old start
    // time over a fresh launch record.
    if (generation !== this._startTimeGeneration) return null;
    if (startedMs !== null) {
      this.startTime = new Date(startedMs);
      this._startTimePid = pid;
    } else if (pid === null || (this._startTimePid !== null && this._startTimePid !== pid)) {
      this._forgetStartTime();
    } else if (this.startTime && this._startTimePid === null) {
      this._startTimePid = pid;
    }
    return this.startTime;
  }

  async startServer({ skipRunningCheck = false, serverId = this._serverId } = {}) {
    // Prevent concurrent start attempts
    if (this._starting) {
      throw new Error("Server start already in progress");
    }
    // Prevent start while a stop is still in flight. Without this guard, a
    // start() during a 1-second stop window can have its freshly-set state
    // wiped by the pending stop-timeout callback, leaving a live process
    // orphaned while the manager reports running:false.
    if (this._stopping) {
      throw new Error("Server stop in progress, try again in a moment");
    }
    this._starting = true;
    // A fresh start must never inherit stop/crash bookkeeping from a
    // PREVIOUS lifecycle -- e.g. a stopIntent the watchdog never got a
    // chance to observe and consume, which would otherwise misattribute
    // this NEXT run's eventual (unrelated) stop.
    this.stopIntent = null;
    this.lastExitInfo = null;

    try {
      // Force reload config from database before starting (settings may have
      // changed). Reload the SAME server this instance was scoped to
      // (this._serverId — null means "the active server", unchanged from
      // before) instead of always snapping back to whichever server is
      // active, which would break a throwaway instance mid-restart.
      if (serverId !== this._serverId) this.configLoaded = false;
      await this.loadConfig(serverId);

      // SteamCMD (POST /install, POST /steam-update -- see
      // ../services/activeSteamOperations.js) writes game files directly
      // into this same directory. Spawning the PZ JVM while that write is
      // still in flight means launching against a partially-patched
      // install: a truncated/corrupted jar, a ClassNotFoundError, or a
      // version mismatch between files that finished writing and ones
      // that haven't -- not merely untidy, a real crash-or-worse shape
      // (hunt-wave5-2026-08-29 concurrency hunt). Every path that can
      // reach startServer() -- POST /start, performRestart()'s two start
      // steps, the Discord bot's /start command, index.js's own
      // auto-start-on-panel-boot, and updateChecker.js's restart-after-
      // update -- funnels through this ONE function, so the guard lives
      // here rather than duplicated at each caller; a guard only at the
      // HTTP route protects the human clicking Start and nothing else.
      // Deliberately unconditional, not nested inside the
      // skipRunningCheck branch below: "is SteamCMD active" is orthogonal
      // to "is the OLD PZ process confirmed stopped" -- restartServer()'s
      // skipRunningCheck:true is specifically about skipping the latter.
      // Placed ABOVE the managed-lifecycle branch below (2026-08-31 fix --
      // it used to sit after that branch's own early return, so a
      // systemd/openrc-managed install could get systemctl-started while
      // SteamCMD was still writing into the exact same directory, silently
      // bypassing the one guard this comment claims is unconditional).
      // Thrown as a plain Error with no ErrorCode, matching every OTHER
      // refusal already in this function (Server path not configured /
      // already running / RCON port in use, none of which carry one
      // either) rather than introducing the one site in this function
      // that departs from its own neighbors' convention -- the message
      // itself is the "named, visible, not a quiet no-op" signal here.
      const installPathForSteamCheck =
        this._serverRecord?.installPath || this.serverPath;
      if (installPathForSteamCheck) {
        const normalizedInstallPath = path
          .normalize(installPathForSteamCheck)
          .toLowerCase();
        if (hasActiveSteamOperation(normalizedInstallPath)) {
          throw new Error(
            "A Steam install or update is currently in progress for this server's install directory. Wait for it to finish before starting the server.",
          );
        }
      }

      // The before-launch step (lifecycleCoordinator.prepareForLaunch()):
      // RCON credentials in the ini and the generated launch script are
      // rewritten from this server's current settings, then PanelBridge
      // delivery runs. After the SteamCMD guard, so neither writes into a
      // folder SteamCMD is still patching, and before both launch branches
      // below. A systemd/OpenRC unit runs whatever launcher was baked into
      // it when its template was downloaded -- for a template generated
      // since GH #167, start-server_<name>.sh (linuxServiceLifecycle.js's
      // resolveLaunchTarget()), the script written here. Every start
      // path funnels through here (see the guard's comment above), which is
      // why this lives here and not at each caller: GH #167's boot
      // auto-start skipped the refresh the dashboard's Start did, launched
      // the stock script on a fresh install, and kept old RCON/admin
      // passwords after an edit until a manual restart.
      // RCE-STARTCMD: what this start would run is asked again on every
      // launch, not only when it was saved (findLaunchTargetRefusal()).
      // Before prepareForLaunch(), so a refused launch writes nothing. The
      // DB record is the authority on install dir vs launcher (loadConfig()
      // collapses serverPath to the launcher's parent in custom mode);
      // falls back to this manager's own fields for a legacy settings-only
      // config with no record. A systemd/OpenRC unit runs the launcher
      // baked into the reviewed unit file, not this.
      if (!this.usesManagedServiceLifecycle()) {
        const target = this._serverRecord
          ? launchTargetOf(this._serverRecord)
          : {
              installDir: this.serverPath || process.env.PZ_SERVER_PATH || "",
              startCommand: this.startCommand,
              launcherPath:
                this.launchMode === "custom" && this.serverPath
                  ? path.join(this.serverPath, this.serverBat)
                  : null,
            };
        const refusal = findLaunchTargetRefusal(target);
        if (refusal) {
          log.warn(
            `Start refused: launch target ${refusal.program} is outside the install folder or is a system program`,
          );
          throw launchTargetRefusedError(refusal);
        }
      }

      const { scriptWarnings, launchSeq } = await prepareForLaunch(
        this._serverRecord,
      );

      if (this.usesManagedServiceLifecycle()) {
        // Before systemctl/rc-service, not after: a unit whose script is
        // missing fails with exit 127 and Restart=on-failure keeps retrying
        // it, which reads as "activating" -- a start the panel would report
        // as successful.
        this._assertNamedStartupScriptPresent();
        const result = await this._getManagedLifecycle().run("start");
        if (!result.success) throw new Error(result.error || result.message);
        this.serverProcess = null;
        this.isRunning = true;
        // Not `this.startTime || new Date()`: a record left from before an
        // out-of-panel stop would carry the old run's start time over to
        // this one wherever the OS can't be asked about the new process.
        // A unit that was already active launched nothing (GH #189): "now"
        // would be a start time for the process already running, which the
        // first status check claims wherever the OS can't answer for it.
        if (!result.alreadyRunning) this._recordLaunchTime();
        this._deletePidFile();
        await logServerEvent(
          "server_start",
          `Server started through ${this.lifecycleProvider}`,
        ).catch((error) => log.warn(`Failed to log event: ${error.message}`));
        if (!result.alreadyRunning) {
          notifyServerLaunched(this._serverRecord, launchSeq);
        }
        return withScriptWarnings(result, scriptWarnings);
      }

      if (!this.startCommand && !this.serverPath) {
        throw new Error("Server path not configured");
      }

      if (!skipRunningCheck) {
        const processDetails = await this.getServerProcessDetails();
        if (!processDetails || processDetails.scanFailed) {
          throw new Error(
            "Could not confirm the server is stopped because process detection failed",
          );
        }
        if (processDetails.running) {
          throw new Error("Server is already running");
        }

        // Defense in depth: even if process detection failed (WMI timeout),
        // check if the RCON port is already occupied. If something is listening
        // on it, a PZ server is almost certainly running and starting another
        // would crash on port conflict (RakNet Code 5).
        // Uses THIS server's RCON port — checking the global default would
        // abort a second server's start just because the first one is up.
        const configuredRconPort =
          this.rconPort ?? (await getSetting("rconPort"));
        const rconPort = resolveConfiguredRconPort(configuredRconPort);
        if (rconPort === null) {
          throw new Error("Invalid RCON port configuration");
        }
        const rconHost =
          this.rconHost || (await getSetting("rconHost")) || "127.0.0.1";
        const portInUse = await new Promise((resolve) => {
          const socket = new net.Socket();
          socket.setTimeout(2000);
          socket.once("connect", () => {
            socket.destroy();
            resolve(true);
          });
          socket.once("timeout", () => {
            socket.destroy();
            resolve(false);
          });
          socket.once("error", () => {
            socket.destroy();
            resolve(false);
          });
          try {
            socket.connect(rconPort, rconHost);
          } catch {
            resolve(false);
          }
        });
        if (portInUse) {
          throw new Error(
            `RCON port ${rconHost}:${rconPort} is already in use — a server may be running that process detection missed. Aborting start to prevent port conflict.`,
          );
        }

        // The game ports are UDP, so the connect probe above can't see them
        // taken. Another server on this host configured with the same game
        // or UDP port, and running, makes this one fail to bind partway
        // through its start; say which one instead.
        const gamePortClash = await this._findRunningGamePortClash();
        if (gamePortClash) {
          throw gamePortInUseError(gamePortClash);
        }
      }

      // isJvmExecutableBusy() answers a DIFFERENT question than
      // restartServer()'s (dead-code, no real caller) wait loop: not "has
      // the process I just told to quit released the binary" but "is ANY
      // process anywhere executing it" -- and that has a legitimate "yes"
      // that isn't a bug. Multiple PZ servers (differing only by
      // -servername/-cachedir) sharing ONE install directory to avoid a
      // second multi-gigabyte copy is a normal deployment shape this
      // codebase already accommodates elsewhere (db.data.servers has no
      // installPath uniqueness constraint; server/routes/server.js's and
      // updateChecker.js's activeSteamOperations guards are keyed by PATH,
      // not by server, for exactly this reason).
      //
      // So this WAITS, then PROCEEDS regardless -- never refuses. The
      // actual danger ETXTBSY describes is something REWRITING the binary
      // while a process executes it; simply launching a new process
      // against a binary another process is already executing is
      // ordinary, unrestricted POSIX behavior (many processes can
      // execve() the same file at once with zero conflict -- ETXTBSY is
      // specifically about OPENING FOR WRITE, never about a second
      // execute). So a bounded wait protects the case this exists for
      // (Rhazun's own prior instance still finishing its exit right after
      // a manual Stop, in the Stop-then-Start workaround) without ever
      // punishing the shared-install case: if it's still busy once the
      // bound expires -- most likely a legitimately running sibling
      // server -- starting anyway is correct, not a compromise.
      //
      // Moved OUT of the !skipRunningCheck block above (2026-08-31,
      // ordering-dependent-guards pass): the ONLY reachable production
      // restart flow, scheduler.js's performRestart(), stops the old
      // process itself and then calls startServer({skipRunningCheck:
      // true}) specifically to skip re-verifying "is the old process
      // confirmed stopped" -- a concern this comment's own SteamCMD-guard
      // sibling above was already pulled out for being orthogonal to that.
      // The ETXTBSY wait is exactly as orthogonal (it answers "did the
      // kernel finish releasing the binary", not "does the process table
      // still show it"), but had been left nested here, so every real
      // restart launched a new JVM with zero wait for the kernel to
      // release the binary -- reproducing the exact "Text file busy" crash
      // this check exists to prevent, through the one code path that
      // actually restarts a server in production.
      if (this.isJvmExecutableBusy()) {
        for (let attempt = 0; attempt < 10 && this.isJvmExecutableBusy(); attempt++) {
          await this.sleep(300);
        }
      }

      // Start the server process
      log.info(
        `Starting server process (platform=${process.platform}, serverPath=${this.serverPath}, startCommand=${this.startCommand || "none"}, serverBat=${this.serverBat})`,
      );

      if (this.startCommand) {
        // Validate the custom command before executing
        const validation = validateStartCommand(this.startCommand);
        if (!validation.valid) {
          throw new Error(`Invalid start command: ${validation.reason}`);
        }

        // Custom start command — split into command and arguments (see
        // parseCustomStartCommand's comment for the carded quote-stripping
        // fix this went through on 2026-09-04).
        const { cmd, args } = parseCustomStartCommand(this.startCommand);
        const cwd = this.serverPath || path.dirname(path.resolve(cmd));

        // Validate the command file extension is allowed
        const ext = path.extname(cmd).toLowerCase();
        if (!ALLOWED_CMD_EXTENSIONS.includes(ext)) {
          throw new Error(
            `Start command has disallowed extension '${ext}'. Allowed: ${ALLOWED_CMD_EXTENSIONS.join(", ")}`,
          );
        }

        // Resolve to absolute path and verify it exists
        const resolvedCmd = path.isAbsolute(cmd) ? cmd : path.resolve(cwd, cmd);
        if (!fs.existsSync(resolvedCmd)) {
          throw new Error(`Start command not found: ${resolvedCmd}`);
        }

        log.info(
          `Using custom start command: ${resolvedCmd} ${args.join(" ")} (ext=${ext}, cwd=${cwd})`,
        );

        // Redirect stdout/stderr to a log file (instead of discarding them)
        // so an immediate startup failure can be captured and reported right
        // away, rather than only surfacing as an opaque 30s "polling timed
        // out" (see GitHub issue #14). A file descriptor keeps the child
        // fully detached from this process's own stdio.
        const launchLogPath = this._openLaunchLog();
        const launchStdio = ["ignore", this._launchLogFd, this._launchLogFd];

        if (isWindows && (ext === ".bat" || ext === ".cmd")) {
          // 2026-09-03, Windows spawn bugs (Dwight's pz-verify repro): do
          // NOT pass launchStdio's raw fd here -- see the isWindows branch
          // in the default-bat path below for why cmd.exe now does its own
          // `>`/`2>&1` redirection instead. We don't need our own copy of
          // the fd for this branch at all, so close it now rather than
          // leaving it open across the spawn call for no reason.
          //
          // 2026-09-04, P0: build the /c command line ourselves (see
          // buildWindowsCmdLine's comment) instead of handing cmd.exe loose
          // argv tokens that Node quotes independently -- that broke every
          // install path with a space in it.
          this._closeLaunchLogFd();
          const commandLine = buildWindowsCmdLine(
            resolvedCmd,
            args,
            launchLogPath,
          );
          this.serverProcess = spawn("cmd.exe", ["/c", commandLine], {
            cwd,
            detached: true,
            stdio: "ignore",
            windowsVerbatimArguments: true,
          });
        } else if (!isWindows && ext === ".sh") {
          try {
            fs.chmodSync(resolvedCmd, 0o750);
          } catch (e) {
            log.debug(`chmod on custom .sh failed: ${e.message}`);
          }
          const serverAbsPath = path.resolve(cwd);
          const ldPath = buildLdLibraryPath(serverAbsPath);
          log.debug(
            `Spawning custom .sh: bash ${resolvedCmd} ${args.join(" ")} (cwd=${cwd}, LD_LIBRARY_PATH=${ldPath})`,
          );
          this.serverProcess = spawn("bash", [resolvedCmd, ...args], {
            cwd,
            detached: true,
            stdio: launchStdio,
            env: {
              ...process.env,
              LD_LIBRARY_PATH: ldPath,
              HOME: buildLinuxServerHome(serverAbsPath),
            },
          });
        } else {
          // Reached on Linux only for a no-extension custom command (the
          // other allowed non-Windows extension besides .sh -- a compiled
          // launcher binary or extensionless wrapper script, both common on
          // Linux). Unlike the ".sh" branch above, this spawns resolvedCmd
          // DIRECTLY rather than via `bash`, so the OS itself enforces the
          // execute bit -- a freshly downloaded/copied/SteamCMD-installed
          // file commonly lacks it, and without this chmod the spawn fails
          // with EACCES every time, exactly the class of "worked on my
          // Windows box, dead on Linux" bug this hunt exists to catch.
          if (!isWindows) {
            try {
              fs.chmodSync(resolvedCmd, 0o750);
            } catch (e) {
              log.debug(`chmod on custom command failed: ${e.message}`);
            }
          }
          const spawnEnv = isWindows
            ? process.env
            : (() => {
                const serverAbsPath = path.resolve(cwd);
                return {
                  ...process.env,
                  LD_LIBRARY_PATH: buildLdLibraryPath(serverAbsPath),
                  HOME: buildLinuxServerHome(serverAbsPath),
                };
              })();
          this.serverProcess = spawn(resolvedCmd, args, {
            cwd,
            detached: true,
            stdio: launchStdio,
            env: spawnEnv,
          });
        }
        this._closeLaunchLogFd();

        // Handle spawn errors (e.g., invalid path, permissions)
        this.serverProcess.on("error", (error) => {
          log.error(`Server process error: ${error.message}`);
          this.isRunning = false;
          this.serverProcess = null;
        });

        this.serverProcess.unref();
        this.isRunning = true;
        this._recordLaunchTime();

        const crash = await this._waitForImmediateCrash(launchLogPath);
        if (crash) {
          this.isRunning = false;
          this.serverProcess = null;
          throw new Error(
            `Server process exited immediately after starting (code=${crash.exitCode}, signal=${crash.signal || "none"}) — startup failed.${crash.tail ? `\n${crash.tail}` : ""}`,
          );
        }

        this._attachExitTracking();
        await logServerEvent("server_start", "Server started via manager");
        log.info("Server start command executed");
        this._writePidFile(this.serverProcess.pid);
        notifyServerLaunched(this._serverRecord, launchSeq);

        return withScriptWarnings(
          { success: true, message: "Server start command executed" },
          scriptWarnings,
        );
      }

      // Checked here, right before the spawn -- after prepareForLaunch()
      // above has had its chance to write the script -- never at config
      // load (GH #167, see namedStartupScriptMissingError()).
      this._assertNamedStartupScriptPresent();
      const batPath = path.join(this.serverPath, this.serverBat);
      if (!fs.existsSync(batPath)) {
        throw new Error(`Server startup script not found: ${batPath}`);
      }

      const launchLogPath = this._openLaunchLog();
      const launchStdio = ["ignore", this._launchLogFd, this._launchLogFd];

      if (isWindows) {
        // Two fixes, 2026-09-03 Windows spawn bugs (Dwight's pz-verify
        // repro, both real, neither an artifact of his setup):
        //
        // (a) this.serverBat is a bare filename (e.g.
        // "StartServer_pz-verify.bat"). cmd.exe's own implicit
        // search-cwd-for-a-bare-name behavior is the only reason that ever
        // worked, and NoDefaultCurrentDirectoryInExePath=1 -- a real,
        // non-exotic Windows hardening option -- turns that off, breaking
        // every server start on such a host with "... is not recognized as
        // an internal or external command", independent of PanelBridge.
        // Dwight confirmed by running the identical `cmd /c
        // "StartServer_pz-verify.bat"` from the same cwd outside Node
        // entirely. Fixed by spawning the already-resolved batPath (used
        // for the existsSync check above) instead of the bare name.
        //
        // (b) Passing launchStdio's raw fd through Node's stdio array
        // silently failed to carry the JVM's output into
        // server-launch.log through the cmd.exe hop when combined with
        // detached:true -- proved by Dwight: PZ's own DebugLog was
        // populated for the same boot, but server-launch.log stayed at 0
        // bytes throughout. Rather than depend on exactly how Node's
        // stdio-fd-to-child-then-grandchild inheritance behaves under
        // DETACHED_PROCESS on Windows (an interaction this floor can't
        // fully instrument), cmd.exe now does its own file redirection via
        // `>`/`2>&1` on the reconstructed command line -- one hop
        // (cmd.exe's own CreateFile, inherited directly by the java.exe it
        // launches) instead of a handle passed two processes deep. We
        // don't need our own copy of the fd for this branch, so close it
        // now rather than across the spawn call.
        //
        // 2026-09-04, P0: build the /c command line ourselves (see
        // buildWindowsCmdLine's comment) instead of handing cmd.exe loose
        // argv tokens that Node quotes independently -- that broke every
        // install path with a space in it (e.g. "...\Zomboid Server\...",
        // "C:\Program Files (x86)\..."), which is the common case, not an
        // edge case.
        this._closeLaunchLogFd();
        const commandLine = buildWindowsCmdLine(batPath, [], launchLogPath);
        this.serverProcess = spawn("cmd.exe", ["/c", commandLine], {
          cwd: this.serverPath,
          detached: true,
          stdio: "ignore",
          windowsVerbatimArguments: true,
        });
      } else {
        // Ensure the script is executable
        try {
          fs.chmodSync(batPath, 0o750);
        } catch (e) {
          log.warn(`Could not chmod startup script: ${e.message}`);
        }
        // On Linux, ensure LD_LIBRARY_PATH includes the server's native library dirs
        // so the JVM can find libsteam_api.so and its transitive dependencies.
        // Without this, services/non-login shells won't have the paths set.
        const serverAbsPath = path.resolve(this.serverPath);
        const ldPath = buildLdLibraryPath(serverAbsPath);
        log.debug(
          `Spawning default .sh: bash ${this.serverBat} (cwd=${this.serverPath}, LD_LIBRARY_PATH=${ldPath})`,
        );

        this.serverProcess = spawn("bash", [this.serverBat], {
          cwd: this.serverPath,
          detached: true,
          stdio: launchStdio,
          env: {
            ...process.env,
            LD_LIBRARY_PATH: ldPath,
            HOME: buildLinuxServerHome(serverAbsPath),
          },
        });
      }
      this._closeLaunchLogFd();

      // Handle spawn errors (e.g., invalid path, permissions)
      this.serverProcess.on("error", (error) => {
        log.error(`Server process error: ${error.message}`);
        this.isRunning = false;
        this.serverProcess = null;
      });

      this.serverProcess.unref();
      this.isRunning = true;
      this._recordLaunchTime();

      // Give the process a brief grace period to catch immediate startup
      // failures (bad classpath, missing native libs, etc.) so we can report
      // the real error instead of a generic 30s "polling timed out" (see
      // GitHub issue #14). This also keeps `_starting` true for the duration,
      // which naturally rejects duplicate start requests (e.g. auto-start
      // racing a manual click) that would otherwise slip through before OS
      // process-detection catches up.
      const crash = await this._waitForImmediateCrash(launchLogPath);
      if (crash) {
        this.isRunning = false;
        this.serverProcess = null;
        throw new Error(
          `Server process exited immediately after starting (code=${crash.exitCode}, signal=${crash.signal || "none"}) — startup failed.${crash.tail ? `\n${crash.tail}` : ""}`,
        );
      }

      this._attachExitTracking();
      await logServerEvent("server_start", "Server started via manager");
      log.info("Server start command executed");
      this._writePidFile(this.serverProcess.pid);
      notifyServerLaunched(this._serverRecord, launchSeq);

      return withScriptWarnings(
        { success: true, message: "Server start command executed" },
        scriptWarnings,
      );
    } finally {
      this._starting = false;
    }
  }

  // Open a fresh launch log file and stash its fd on `this._launchLogFd` for
  // use as spawn() stdio. Returns the log file path (or null if it couldn't
  // be opened, in which case stdio falls back to "ignore" via the fd value).
  _openLaunchLog() {
    const launchLogPath = path.join(
      getDataPaths().logsDir,
      "server-launch.log",
    );
    try {
      this._launchLogFd = fs.openSync(launchLogPath, "w");
      return launchLogPath;
    } catch (e) {
      log.debug(`Could not open launch log file: ${e.message}`);
      this._launchLogFd = "ignore";
      return null;
    }
  }

  // Close our copy of the launch-log fd. The child keeps its own duplicated
  // handle to the file (passed via stdio), so this doesn't affect it.
  _closeLaunchLogFd() {
    if (typeof this._launchLogFd === "number") {
      try {
        fs.closeSync(this._launchLogFd);
      } catch {
        /* already closed */
      }
    }
    this._launchLogFd = null;
  }

  // Wait briefly to see if the just-spawned process exits immediately
  // (crash on startup). Resolves to `{ exitCode, signal, tail }` if it did,
  // or `null` if it's still alive after the grace period.
  _waitForImmediateCrash(launchLogPath) {
    const proc = this.serverProcess;
    if (!proc) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      let graceTimer;
      const readTail = () => {
        try {
          if (launchLogPath && fs.existsSync(launchLogPath)) {
            return fs.readFileSync(launchLogPath, "utf-8").slice(-2000).trim();
          }
        } catch {
          /* best effort */
        }
        return "";
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(graceTimer);
        proc.removeListener("exit", onExit);
        proc.removeListener("error", onError);
        resolve(result);
      };
      const onExit = (exitCode, signal) => {
        finish({ exitCode, signal, tail: readTail() });
      };
      const onError = (error) => {
        finish({
          exitCode: null,
          signal: null,
          tail: `spawn error: ${error.message}`,
        });
      };
      proc.once("exit", onExit);
      proc.once("error", onError);
      graceTimer = setTimeout(() => finish(null), 4000);
    });
  }

  // continuous-bug-hunt round 28: called once a freshly-spawned process has
  // survived _waitForImmediateCrash's own short-lived exit listener above
  // (which removes itself once the grace window ends) -- this one stays
  // attached for the process's whole remaining life, so whenever it
  // eventually exits (deliberately stopped, restarted, or crashed hours or
  // days later) the real exit code/signal lands in this.lastExitInfo for
  // checkServerStatusNow (server/index.js) to read the next time it
  // observes the running -> stopped transition. Best-effort: on Windows,
  // when the JVM is launched via a cmd.exe wrapper (buildWindowsCmdLine),
  // the exit code this sees is cmd.exe's own, which mirrors the last
  // command's exit code in the common case but is not a hard guarantee for
  // every possible launcher script -- still strictly more signal than
  // reporting no exit info at all, and the classification in
  // checkServerStatusNow only needs "zero/graceful vs non-zero/signalled",
  // not perfect fidelity to the JVM's own code.
  _attachExitTracking() {
    const proc = this.serverProcess;
    if (!proc) return;
    proc.once("exit", (exitCode, signal) => {
      this.lastExitInfo = { exitCode, signal, at: new Date().toISOString() };
    });
  }

  // Force-stops the process/container this instance tracks. Graceful
  // shutdown is a SEPARATE path (RCON 'quit', issued by the caller) --
  // this used to also accept a `graceful` flag that, when true (the
  // DEFAULT), skipped every check below and returned `{success:true}`
  // without confirming anything or issuing any command at all. Every real
  // call site already passed `false` explicitly (grepped server/ and
  // client/src, zero exceptions), so the flag was reachable only via the
  // most natural-looking call of all -- a bare `stopServer()` -- exactly
  // the "confident answer with nothing confirmed" shape 63a32640 (OpenRC
  // stop reporting `success:true, confirmed:true` with no stop issued) was
  // fixed for. Removed by construction rather than documented as a trap:
  // deleting is behaviour-preserving at every existing site since they all
  // already pass `false`, and a real graceful-RCON-quit-from-here would be
  // a new feature duplicating the RCON path that already exists (see
  // managedContainer.js's header comment on the two mechanisms).
  async stopServer({ serverId = this._serverId } = {}) {
    // startServer() already refuses outright when this._stopping is true
    // (see "Prevent start while a stop is still in flight" above) -- this
    // function only ever SET the flag, it never checked it on its OWN
    // entry, so two overlapping force-stop calls (two Force Stops, or a
    // Force Stop racing the service-managed branch of a plain Stop) both
    // ran past every guard: both scanned, both found the same PID, both
    // issued a kill for it (server/tests/stopServerConcurrentForceStop.test.js
    // proves this deterministically). Harmless on a stock Linux/Windows
    // config (a second kill on an already-reaped PID is a no-op), but
    // still redundant work with no user-visible signal that a stop was
    // already underway -- refusing here instead mirrors startServer()'s
    // own guard, one direction earlier.
    if (this._stopping) {
      return {
        success: false,
        confirmed: false,
        error: "Stop already in progress",
        message:
          "A stop or force-stop is already in progress for this server. Wait for it to finish, then try again.",
      };
    }

    // Block overlapping starts while kill/state-clear is pending.
    this._stopping = true;
    try {
      if (serverId !== this._serverId) this.configLoaded = false;
      await this.loadConfig(serverId);
      if (this.usesManagedServiceLifecycle()) {
        const result = await this._getManagedLifecycle().run("stop");
        if (result.success && result.confirmed !== false) this._clearRunState();
        if (result.success) {
          await logServerEvent(
            "server_stop",
            `Server stopped through ${this.lifecycleProvider}`,
          ).catch((error) => log.warn(`Failed to log event: ${error.message}`));
        }
        return result;
      }
      // Only PIDs this server owns: a host can run several dedicated servers
      // and killing every PZ process would take the others down with it.
      const details = await this.getServerProcessDetails();
      const pids = (details.owned || [])
        .map((entry) => entry.pid)
        .filter((pid) => /^\d+$/.test(String(pid ?? "")))
        .map(String);

      if (pids.length > 0) {
        log.info(
          `stopServer: force killing PID(s) for "${this.serverName}": ${pids.join(", ")}`,
        );
        const launcher = this.serverProcess;
        if (
          !isWindows &&
          launcher?.pid &&
          launcher.killed !== true &&
          launcher.exitCode === null
        ) {
          const groupResult = this._killProcessGroup(launcher.pid);
          if (groupResult.failed) {
            log.debug(
              `stopServer: launcher process-group kill failed: ${groupResult.errors.join("; ")}`,
            );
          }
        }
        const killResult = await this._killPids(pids);
        const { timedOut, failed, errors = [] } = killResult;
        if (timedOut) {
          log.warn(
            `stopServer: kill command for "${this.serverName}" (PIDs: ${pids.join(", ")}) did not finish within ${this._killTimeoutMs}ms — could not confirm the process actually exited`,
          );
          await logServerEvent(
            "server_stop",
            `Server stop timed out waiting for kill confirmation (PIDs: ${pids.join(", ")})`,
          ).catch((e) => log.warn(`Failed to log event: ${e.message}`));
          return {
            success: true,
            confirmed: false,
            timedOut: true,
            message:
              "Stop signal sent, but confirmation timed out — check whether the server actually exited before starting it again",
          };
        }
        if (failed) {
          const errorMessage = errors.join("; ") || "kill command failed";
          log.error(
            `stopServer: could not stop "${this.serverName}": ${errorMessage}`,
          );
          return {
            success: false,
            confirmed: false,
            error: errorMessage,
            message: "The server could not be stopped.",
          };
        }
        if (!(await this._confirmProcessStopped())) {
          return {
            success: true,
            confirmed: false,
            timedOut: true,
            message:
              "Stop signal sent, but the server is still running or its exit could not be confirmed",
          };
        }
        this._clearRunState();
        await logServerEvent(
          "server_stop",
          `Server force stopped (killed PIDs: ${pids.join(", ")})`,
        ).catch((e) => log.warn(`Failed to log event: ${e.message}`));
        return { success: true, message: "Server stopped" };
      }

      if (!details.scanFailed) {
        log.debug(
          `stopServer: no running process belongs to "${this.serverName}"`,
        );
        this._clearRunState();
        return { success: true, message: "Server was not running" };
      }

      // Detection itself failed, so this server's process can't be told apart
      // from any other. Only fall back to the blunt kill-everything path when
      // there is no other local server that could be caught in the blast.
      if (!(await this._isOnlyLocalServer())) {
        throw new Error(
          "Process detection failed and more than one server is configured on this host — force stop aborted rather than risk killing the wrong server. Stop it from its own console window.",
        );
      }

      log.warn(
        "stopServer: process detection failed. Falling back to generic force stop.",
      );
      const forceResult = await this._genericForceStop();
      const { timedOut, failed, errors = [] } = forceResult;
      if (timedOut) {
        log.warn(
          `stopServer: generic force stop did not finish within ${this._killTimeoutMs}ms — could not confirm the process actually exited`,
        );
        await logServerEvent(
          "server_stop",
          "Server stop timed out waiting for kill confirmation (generic fallback)",
        ).catch((e) => log.warn(`Failed to log event: ${e.message}`));
        return {
          success: true,
          confirmed: false,
          timedOut: true,
          message:
            "Stop signal sent, but confirmation timed out — check whether the server actually exited before starting it again",
        };
      }
      if (failed) {
        const errorMessage = errors.join("; ") || "force-stop command failed";
        log.error(`stopServer: generic force stop failed: ${errorMessage}`);
        return {
          success: false,
          confirmed: false,
          error: errorMessage,
          message: "The server could not be force-stopped.",
        };
      }
      if (!(await this._confirmProcessStopped())) {
        return {
          success: true,
          confirmed: false,
          timedOut: true,
          message:
            "Stop signal sent, but the server is still running or its exit could not be confirmed",
        };
      }
      this._clearRunState();
      await logServerEvent("server_stop", "Server force stopped").catch((e) =>
        log.warn(`Failed to log event: ${e.message}`),
      );
      return { success: true, message: "Forced fallback kill executed" };
    } finally {
      this._stopping = false;
    }
  }

  // Clear state fields so getServerStatus doesn't report a stale startTime /
  // old serverProcess handle after a kill.
  markServerStopped() {
    this._clearRunState();
  }

  _clearRunState() {
    this.isRunning = false;
    this.serverProcess = null;
    this._forgetStartTime();
    this._deletePidFile();
  }

  // The tracked process is gone, being replaced, or no longer this server's:
  // its start time must not be reported for whatever runs next. Bumping the
  // generation also voids any resolveStartTime() lookup still in flight for
  // it -- see that method.
  _forgetStartTime() {
    this._startTimeGeneration++;
    this._startTimePid = null;
    this.startTime = null;
  }

  // This panel just launched the server: until the OS can be asked about
  // the new process (resolveStartTime(), on the next status check), the
  // launch moment is the best-known start time -- for the first PID that
  // check finds, and no other (see resolveStartTime()).
  _recordLaunchTime() {
    this._forgetStartTime();
    this.startTime = new Date();
  }

  // The first running local server whose game or UDP port is one this
  // server is configured for, or null. Costs a process scan only when some
  // other profile shares a port at all, which a single-server host never
  // does. A failed scan is no answer: the start goes on, as it did before.
  async _findRunningGamePortClash() {
    const self = this._serverRecord;
    if (!self || self.isRemote) return null;
    let servers;
    try {
      servers = await getServers();
    } catch (error) {
      log.debug(`Could not list servers for the game port check: ${error.message}`);
      return null;
    }
    const others = (servers || []).filter((server) => server?.id !== self.id);
    const conflicts = findPortConflicts(
      {
        serverPort: self.serverPort ?? DEFAULT_GAME_PORT,
        rconPort: null,
        serverName: self.serverName,
        installPath: self.installPath || self.serverPath,
      },
      collectUsedPorts(others),
    );
    if (conflicts.length === 0) return null;

    const sharing = others.filter((server) =>
      conflicts.some((conflict) => conflict.serverId === server.id),
    );
    let result;
    try {
      result = await findOtherRunningServers(self, { servers: sharing });
    } catch (error) {
      log.debug(`Game port check scan failed: ${error.message}`);
      return null;
    }
    if (result.scanFailed) return null;
    const runningIds = new Set(result.servers.map((server) => server.id));
    const clash = conflicts.find((conflict) => runningIds.has(conflict.serverId));
    return clash ? { port: clash.port, serverName: clash.serverName } : null;
  }

  async _isOnlyLocalServer() {
    try {
      const servers = await getServers();
      return (servers || []).filter((entry) => !entry.isRemote).length <= 1;
    } catch (error) {
      log.debug(`Could not count configured servers: ${error.message}`);
      return false;
    }
  }

  // Resolves to { timedOut }. `timedOut` is true when at least one
  // taskkill/kill call didn't finish on its own and had to be aborted by
  // the exec timeout below -- meaning we could NOT confirm the process
  // actually exited, only that we stopped waiting. Distinguished from an
  // ordinary fast kill error (e.g. "process already exited", already
  // treated as harmless) via killErr.killed, which Node sets specifically
  // when its own timeout is what ended the child -- not on a normal
  // nonzero-exit failure.
  _killPids(pids) {
    return new Promise((resolve) => {
      if (isWindows) {
        let remaining = pids.length;
        let timedOut = false;
        const errors = [];
        for (const pid of pids) {
          execFile(
            "taskkill",
            ["/PID", pid, "/T", "/F"],
            { timeout: this._killTimeoutMs },
            (killErr) => {
              if (killErr) {
                const outcome = classifyProcessKillError(killErr);
                if (outcome === "timedOut") timedOut = true;
                if (outcome === "failed") errors.push(`PID ${pid}: ${killErr.message}`);
                log.debug(`taskkill ${pid}: ${killErr.message}`);
              }
                if (--remaining === 0) {
                  resolve({ timedOut, failed: errors.length > 0, errors });
                }
            },
          );
        }
        return;
      }

      execFile(
        "kill",
        ["-9", ...pids],
        { timeout: this._killTimeoutMs },
        (killErr) => {
          const outcome = classifyProcessKillError(killErr);
          if (killErr && outcome !== "alreadyGone") {
            log.warn(
              `Kill returned error (may be normal if process already exited): ${killErr.message}`,
            );
          }
          resolve({
            timedOut: outcome === "timedOut",
            failed: outcome === "failed",
            errors: outcome === "failed" ? [killErr.message] : [],
          });
        },
      );
    });
  }

  _killProcessGroup(pid) {
    if (isWindows || !/^\d+$/.test(String(pid ?? "")) || Number(pid) <= 1) {
      return { failed: false, errors: [] };
    }

    try {
      process.kill(-Number(pid), "SIGKILL");
      return { failed: false, errors: [] };
    } catch (error) {
      const outcome = classifyProcessKillError(error);
      return {
        failed: outcome === "failed",
        errors: outcome === "failed" ? [error.message] : [],
      };
    }
  }

  // Right after a kill, the process is at its most likely to be caught half
  // gone by a Windows scan (GH #190), so one sample that can't tell asks
  // again a few times instead of reporting the stop unconfirmed -- a
  // restart that force-stopped the old server gives up on an unconfirmed
  // stop. Force stop's request waits on this, so no new look starts past
  // 30 s; one look can itself take up to 19 s (see
  // _readProcessDetailsBounded()), so about 50 s at the very worst.
  async _confirmProcessStopped() {
    const details = await readProcessStateWithRetry(
      () => this._readProcessDetailsBounded(),
      {
        sleep: (ms) => this.sleep(ms),
        maxElapsedMs: 30000,
        context: `Stop "${this.serverName}"`,
      },
    );
    return !details.scanFailed && details.running === false;
  }

  // One getServerProcessDetails() sample that never rejects and never takes
  // longer than the scan's own ceiling: null when it threw or ran out of
  // time.
  async _readProcessDetailsBounded() {
    let timeoutId;
    const processDetails = Promise.resolve()
      .then(() => this.getServerProcessDetails())
      .catch(() => null);
    // timeout-handling-consistency-sweep, 2026-09-10: this raced
    // getServerProcessDetails() (whose own worst case is
    // _scanDedicatedServerProcesses's outer guard, now 18000ms -- see that
    // function's comment) at a mere 3000ms -- the second, stacked layer of
    // the same "outer shorter than inner" shape. On the rare slow-host path
    // this returned false (no confirmation) before the real scan finished,
    // and that now-orphaned scan's callback could still land afterward and
    // mutate this.isRunning behind this function's own already-returned
    // answer. Matched to the scan's own ceiling with margin; the common
    // case (a healthy host, scan resolves in well under a second) is
    // unaffected -- this only changes how long a genuinely pathological
    // scan is allowed to actually finish before being given up on.
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve(null), 19000);
    });

    try {
      return await Promise.race([processDetails, timeout]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Resolves to { timedOut }, same meaning as _killPids above.
  _genericForceStop() {
    return new Promise((resolve) => {
      if (isWindows) {
        let timedOut = false;
        const errors = [];
        exec(
          "taskkill /IM ProjectZomboid64.exe /T /F",
          { timeout: this._killTimeoutMs },
          (err1) => {
            const outcome1 = classifyProcessKillError(err1);
            if (outcome1 === "timedOut") timedOut = true;
            if (outcome1 === "failed") errors.push(`ProjectZomboid64.exe: ${err1.message}`);
            exec(
              "powershell -Command \"Get-CimInstance Win32_Process -Filter \\\"Name='java.exe'\\\" | Where-Object { $_.CommandLine -like '*zombie.network.gameserver*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }\"",
              { timeout: this._killTimeoutMs },
              (err2) => {
                const outcome2 = classifyProcessKillError(err2);
                if (outcome2 === "timedOut") timedOut = true;
                if (outcome2 === "failed") errors.push(`java.exe: ${err2.message}`);
                resolve({ timedOut, failed: errors.length > 0, errors });
              },
            );
          },
        );
        return;
      }

      exec(
        "pkill -9 -f 'zombie.network.[Gg]ame[Ss]erver|[Pp]roject[Zz]omboid64|[Pp]roject[Zz]omboid32'",
        { timeout: this._killTimeoutMs },
        (err) => {
          const outcome = classifyProcessKillError(err);
          resolve({
            timedOut: outcome === "timedOut",
            failed: outcome === "failed",
            errors: outcome === "failed" ? [err.message] : [],
          });
        },
      );
    });
  }

  async restartServer(rconService, warningMinutes = 5) {
    try {
      // Helper to send message with timeout (don't let RCON failures block restart)
      const sendWarning = async (msg) => {
        let timeoutId;
        try {
          const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error("RCON timeout")),
              5000,
            );
          });
          await Promise.race([rconService.serverMessage(msg), timeoutPromise]);
        } catch (e) {
          log.warn(`Failed to send restart warning: ${e.message}`);
        } finally {
          // timeout-handling-consistency-sweep, 2026-09-10: was only cleared
          // on the success path -- a reject (RCON failure OR this same
          // timer firing) skipped straight to the catch above and left the
          // timer live, firing later into an already-settled race. Harmless
          // (nothing listens to it by then) but real handle litter.
          clearTimeout(timeoutId);
        }
      };

      // Send warning messages
      const warnings = [5, 4, 3, 2, 1];
      for (const minutes of warnings) {
        if (minutes <= warningMinutes) {
          await sendWarning(`Server restarting in ${minutes} minute(s)!`);
          await this.sleep(60000); // Wait 1 minute between each warning
        }
      }

      // Final warning
      await sendWarning("Server restarting NOW!");
      await this.sleep(5000);

      // Save the world (with timeout)
      let saveTimeoutId;
      try {
        const saveTimeout = new Promise((_, reject) => {
          saveTimeoutId = setTimeout(
            () => reject(new Error("Save timeout")),
            10000,
          );
        });
        const saveResult = await Promise.race([rconService.save(), saveTimeout]);
        if (!saveResult?.success) {
          throw new Error(
            `Save before restart failed: ${saveResult?.error || "unknown error"}`,
          );
        }
      } catch (e) {
        throw new Error(`Save before restart failed: ${e.message}`);
      } finally {
        clearTimeout(saveTimeoutId);
      }
      await this.sleep(3000);

      await this.loadConfig(this._serverId);
      if (this.usesManagedServiceLifecycle()) {
        // `systemctl restart` / `rc-service restart` launch the game again
        // without passing through startServer(), so they get the same
        // before-launch step and script check here (GH #167).
        const { launchSeq } = await prepareForLaunch(this._serverRecord);
        this._assertNamedStartupScriptPresent();
        const restarted = await this._getManagedLifecycle().run("restart");
        if (!restarted.success || restarted.confirmed === false) {
          throw new Error(
            restarted.error ||
              `${this.lifecycleProvider} did not confirm the restart`,
          );
        }
        this.serverProcess = null;
        this.isRunning = true;
        this._recordLaunchTime();
        this._deletePidFile();
        notifyServerLaunched(this._serverRecord, launchSeq);
        await logServerEvent(
          "server_restart",
          `Server restarted through ${this.lifecycleProvider}`,
        );
        return {
          success: true,
          message: `Server restarted successfully through ${this.lifecycleProvider}`,
        };
      }

      // Quit the server (with timeout)
      let quitTimeoutId;
      try {
        const quitTimeout = new Promise((_, reject) => {
          quitTimeoutId = setTimeout(
            () => reject(new Error("Quit timeout")),
            10000,
          );
        });
        await Promise.race([rconService.quit(), quitTimeout]);
      } catch (e) {
        log.warn(`RCON quit failed, will force stop: ${e.message}`);
      } finally {
        clearTimeout(quitTimeoutId);
      }
      await this.sleep(10000);

      // Wait for server to fully stop: 30 looks a second apart, never past a
      // minute. A scan that can't tell spends one look and the wait goes on
      // (GH #190) -- see waitForProcessExit(); only still-unknown at the end
      // gives up. The process-table check is blind whenever PZ runs outside
      // the panel's own PID namespace (see isJvmExecutableBusy()'s doc
      // comment) -- the binary check runs alongside it, not instead of it,
      // so it only ever ADDS a wait condition on setups where it can find
      // the binary at all.
      const processDetails = await waitForProcessExit(
        () => this.getServerProcessDetails(),
        {
          polls: 30,
          intervalMs: 1000,
          maxElapsedMs: 60 * 1000,
          sleep: (ms) => this.sleep(ms),
          context: "Restart",
          alsoWaitWhile: () => this.isJvmExecutableBusy(),
        },
      );
      if (processDetails.scanFailed) {
        throw new Error(
          "Could not confirm the old server stopped because process detection failed",
        );
      }
      let jvmBusy = this.isJvmExecutableBusy();

      // Force stop if still running
      if (processDetails.running) {
        const forced = await this.stopServer();
        if (!forced?.success || forced.confirmed === false) {
          throw new Error(
            `The old server process could not be stopped (${forced?.error || "unknown error"}), so it was not restarted`,
          );
        }
        await this.sleep(5000);
        // Re-check: a successful force-stop through the process table says
        // nothing about whether the kernel has finished releasing the
        // binary yet (this is the exact gap isJvmExecutableBusy exists to
        // catch -- ETXTBSY is about the file, not the PID).
        jvmBusy = this.isJvmExecutableBusy();
      }

      // The process table (even force-stop) has no way to act on this --
      // ETXTBSY clears on its own once the kernel finishes tearing the old
      // process down. If it's still busy after everything above, refuse
      // rather than start a new JVM against a binary that may still be
      // rewritten out from under it.
      if (jvmBusy) {
        throw new Error(
          "The previous server process appears to have exited, but its Java executable is still locked by the kernel (\"Text file busy\") -- refusing to start a new one until it clears, to avoid a corrupted install",
        );
      }

      // Extra delay to let OS reap the process
      await this.sleep(3000);

      // Start the server — skip running check, we just confirmed it stopped
      const started = await this.startServer({ skipRunningCheck: true });
      if (!started?.success) {
        return {
          success: false,
          message: `Server stopped but did not start again: ${started?.error || started?.message || "unknown error"}`,
        };
      }

      await logServerEvent("server_restart", "Server restarted");
      return { success: true, message: "Server restarted successfully" };
    } catch (error) {
      log.error(`Restart failed: ${error.message}`);
      throw error;
    }
  }

  async getServerStatus() {
    // Ensure config is loaded before returning status
    await this.loadConfig();

    // Lazy load port and IP
    if (!this.gamePort) {
      this.loadGamePort().catch((err) =>
        log.debug(`Failed to load game port: ${err.message}`),
      );
    }
    const configuredWanIp = getConfiguredIpv4Address("PANEL_WAN_IP");
    if (configuredWanIp) {
      this.publicIp = configuredWanIp;
    } else if (!this.fetchingIp) {
      // Opt-in only: this used to unconditionally call out to a third party
      // (api.ipify.org) on every status check for a LAN-only panel, which is
      // an unnecessary external dependency and a small privacy leak
      // (announces the panel to ipify) for installs that never display or
      // need their public IP. Requires `enablePublicIpLookup` to be set to
      // true (e.g. via a future Settings toggle, or directly in the DB).
      //
      // The cache has a TTL (PUBLIC_IP_CACHE_TTL_MS) so a residential ISP
      // rotating the WAN IP gets picked up automatically instead of the
      // dashboard silently showing a stale, no-longer-yours address forever.
      try {
        const enabled = await getSetting("enablePublicIpLookup");
        if (enabled === true || enabled === "true") {
          const cached = await getSetting("cachedPublicIp");
          const cachedAt = Number(await getSetting("cachedPublicIpAt")) || 0;
          const isStale = Date.now() - cachedAt > PUBLIC_IP_CACHE_TTL_MS;
          if (cached && !isStale) {
            this.publicIp = cached;
          } else {
            this.fetchPublicIp().catch((err) =>
              log.debug(`Failed to fetch public IP: ${err.message}`),
            );
          }
        }
      } catch (err) {
        log.debug(`Public IP lookup setting check failed: ${err.message}`);
      }
    }

    const processDetails = await this.getServerProcessDetails();
    const isRunning = processDetails.running;
    if (!isRunning && !processDetails.scanFailed) {
      this._clearRunState();
    }
    // Asked on every call, not only while this.startTime is still null: a
    // value that was merely present used to be trusted until a poll here
    // happened to catch the server stopped, so a server restarted between
    // polls (systemd's Restart=on-failure, a crash-restart wrapper, a
    // manual restart on the host while no dashboard was open) kept counting
    // from the previous process. Its own answer, not this.startTime read
    // afterwards: a lookup overtaken by a stop or launch answers null.
    //
    // null whenever the scan doesn't confirm a running server -- including
    // a failed scan (an OpenRC service mid-stop, an unreadable
    // `rc-service status`), where _clearRunState() is skipped above so
    // this.startTime survives for the next confirmed scan: reporting it
    // here put the previous run's uptime next to "unknown" in Discord.
    const startTime = isRunning
      ? await this.resolveStartTime(processDetails)
      : null;

    // Whole seconds. null -- never 0 -- when the start time isn't known
    // (stopped, unconfirmed, or a process this host can't see such as a
    // remote SFTP or Docker server): 0 read as "just started" to anything
    // that shows it.
    const uptimeSeconds = startTime
      ? Math.max(0, Math.floor((Date.now() - startTime.getTime()) / 1000))
      : null;

    return {
      running: isRunning,
      // Distinguishes a confirmed-stopped server from "the process scan
      // itself failed" -- both used to collapse to running: false here,
      // so a hung/erroring OS scan (AV interference, WMI timeout,
      // ps/pgrep unavailable) looked identical to a real stop. Callers
      // that only checked .running had no way to tell.
      scanFailed: Boolean(processDetails.scanFailed),
      startTime,
      uptime: uptimeSeconds,
      serverPath: this.serverPath,
      // Renamed from `configured` (2026-08-31, quality-pass follow-up):
      // this has only ever meant "does the LOCAL process-launch path have
      // a directory to run in" -- the exact thing startServer() itself
      // checks (`!this.startCommand && !this.serverPath`, above) before
      // it will spawn anything. That's a real, narrower question than "is
      // this server configured": a remote server's launch happens on a
      // different host entirely and correctly never sets serverPath, so
      // under the old name every remote server read as permanently
      // unconfigured to any consumer that didn't already know to special-
      // case isRemote. Four independent readers (client/src/pages/
      // Dashboard.tsx's verdict, banner, and Live Activity empty state)
      // hit exactly that misreading in the same night before this was
      // traced to its root and renamed rather than "fixed" -- the VALUE
      // was already right for what it actually gates, only the name over-
      // promised. Callers that want "is this server profile complete"
      // should look at isRemote-aware validation, not this field.
      serverPathConfigured: !!this.serverPath,
      publicIp: this.publicIp,
      localIp: await this.getLocalIp(),
      port: this.gamePort,
    };
  }

  usesManagedServiceLifecycle() {
    return (
      isManagedLifecycleProvider(this.lifecycleProvider) &&
      Boolean(this._serverRecord)
    );
  }

  // GH #167: a managed server with a name launches its own generated
  // script or nothing -- throws SERVER_START_SCRIPT_MISSING when that script
  // is still absent after prepareForLaunch() had its chance to write it,
  // for a direct launch and for a systemd/OpenRC one alike (both launch it
  // from this.serverPath, see resolveLaunchTarget()). Only for a server
  // record: the legacy settings-only config has no record for
  // prepareForLaunch() to write a script from, so "the panel writes it
  // before every start" would not be true of it. A custom launcher, an
  // explicit PZ_SERVER_BAT and a nameless server launch something else and
  // are left to the spawn's own "not found" check.
  _assertNamedStartupScriptPresent() {
    const launchesNamedScript =
      Boolean(this._serverRecord) &&
      this.launchMode !== "custom" &&
      Boolean(this.serverName) &&
      Boolean(this.serverPath) &&
      this.serverBat === managedStartupScriptName(this.serverName);
    if (!launchesNamedScript) return;
    if (fs.existsSync(path.join(this.serverPath, this.serverBat))) return;
    throw namedStartupScriptMissingError({
      script: this.serverBat,
      folder: this.serverPath,
      fallback: stockStartupScript(this._serverRecord.useNoSteam),
    });
  }

  // The check above, asked ahead of time: scheduler.js's performRestart()
  // calls this before its countdown, world save and quit, because the check
  // above only runs in the startServer() that follows the stop -- a server
  // whose script is missing and can't be written (a launch folder the panel
  // can't write to, which 1.3.8 papered over with the stock script) was
  // stopped by a Restart and then left down. Throws
  // SERVER_RESTART_SCRIPT_MISSING when the script is missing and the
  // before-launch step couldn't write it either: routes/server.js's
  // refreshLaunchTargetBeforeStart() writes it into `serverPath ||
  // installPath`, and only for a server without a custom start command.
  // Reads the record itself rather than loading it into this manager, so
  // asking never changes which server this manager is pointed at;
  // otherwise the same conditions as the check above. A server mapped to a
  // Docker container is restarted through Docker, whose image owns the
  // launch, so it is not asked about.
  async assertNamedStartupScriptLaunchable({ serverId = null } = {}) {
    let record;
    try {
      record =
        serverId != null ? await getServer(serverId) : await getActiveServer();
    } catch (error) {
      log.debug(`Launch-script check skipped: ${error.message}`);
      return;
    }
    if (!record || record.isRemote) return;
    if (record.dockerContainerName || record.dockerContainerId) return;
    // RCE-STARTCMD: startServer() refuses a launch target outside the
    // install folder (findLaunchTargetRefusal()); asked here too so a
    // Restart doesn't stop a server it would then refuse to start.
    if (!isManagedLifecycleProvider(record.lifecycleProvider || "direct")) {
      const refusal = findLaunchTargetRefusal(launchTargetOf(record));
      if (refusal) {
        log.warn(
          `Restart refused before stopping the server: launch target ${refusal.program} is outside the install folder or is a system program`,
        );
        throw launchTargetRestartRefusedError(refusal);
      }
    }
    if (resolveLaunchMode(record).mode === "custom" || !record.serverName) return;
    const script = resolveManagedStartupScript(record.serverName);
    if (script !== managedStartupScriptName(record.serverName)) return;
    const launchDir = record.serverPath || record.installPath;
    const folder = launchDir || process.env.PZ_SERVER_PATH || "";
    if (!folder) return;
    // A direct launch with a custom start command runs that command; only
    // a systemd/OpenRC unit still runs the script then (startServer()).
    const serviceLaunch = isManagedLifecycleProvider(
      record.lifecycleProvider || "direct",
    );
    if (record.startCommand && !serviceLaunch) return;
    if (fs.existsSync(path.join(folder, script))) return;
    if (launchDir && !record.startCommand) {
      const writeError = probeFolderWritable(launchDir, script);
      if (!writeError) return;
      log.warn(
        `Restart refused before stopping the server: ${script} is missing and the panel can't write to ${launchDir}: ${writeError.message}`,
      );
    } else {
      log.warn(
        `Restart refused before stopping the server: ${script} is missing from ${folder}, and the panel doesn't write it for a server ${record.startCommand ? "with a custom start command" : "with no install folder set"}`,
      );
    }
    throw namedStartupScriptRestartRefusedError({
      script,
      folder,
      fallback: stockStartupScript(record.useNoSteam),
    });
  }

  _getManagedLifecycle() {
    if (!this.usesManagedServiceLifecycle()) {
      throw new Error("No managed service lifecycle is configured");
    }
    return this._lifecycleFactory(
      this._serverRecord,
      this.lifecycleProvider,
    );
  }

  // All non-internal IPv4 addresses currently present on the host, e.g. one
  // per VPN mesh (Tailscale, ZeroTier) plus the real LAN adapter — so the
  // Settings UI can offer a choice instead of the panel guessing. Delegates
  // to the shared utils/networkInterfaces.js implementation (2026-09-08)
  // so server/utils/certs.js's SubjectAltName generation reuses this exact
  // enumeration instead of a second one.
  listNetworkInterfaces() {
    return listNonInternalIPv4Interfaces();
  }

  async getLocalIp() {
    const interfaces = this.listNetworkInterfaces();

    // A user-picked interface (Settings > Network) wins over the env var:
    // it's the more recent, explicit choice. But only while that address is
    // still actually present, so an unplugged VPN doesn't leave the
    // dashboard stuck showing a dead IP forever.
    try {
      const selected = await getSetting("lanIpAddress");
      if (selected && interfaces.some((iface) => iface.address === selected)) {
        return selected;
      }
    } catch (err) {
      log.debug(`lanIpAddress setting lookup failed: ${err.message}`);
    }

    const configuredLanIp = getConfiguredIpv4Address("PANEL_LAN_IP");
    if (configuredLanIp) return configuredLanIp;

    return interfaces[0]?.address || "127.0.0.1";
  }

  async loadGamePort() {
    try {
      const config = await this.getServerConfig();
      if (config && config.DefaultPort) {
        this.gamePort = parseInt(config.DefaultPort, 10);
      }
    } catch (e) {
      // ignore
    }
  }

  async fetchPublicIp() {
    if (this.fetchingIp) return;
    this.fetchingIp = true;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const response = await fetch("https://api.ipify.org?format=json", {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        this.publicIp = data.ip;
        // Cache to DB so we don't need to call out to ipify again on every
        // restart — only when the cached value is missing or stale (see
        // getServerStatus's PUBLIC_IP_CACHE_TTL_MS check).
        try {
          await setSetting("cachedPublicIp", data.ip);
          await setSetting("cachedPublicIpAt", String(Date.now()));
        } catch (_) {
          /* best effort */
        }
      }
    } catch (e) {
      // silent fail
    } finally {
      this.fetchingIp = false;
    }
  }

  async getServerConfig() {
    await this.loadConfig(); // Ensure config is loaded

    if (!this.savePath) {
      return null;
    }

    // Try the actual server name first (proper path: savePath/Server/{serverName}.ini)
    const serverConfigDir = path.join(this.savePath, "Server");
    const serverNameIniPath = path.join(
      serverConfigDir,
      `${this.serverName}.ini`,
    );

    if (fs.existsSync(serverNameIniPath)) {
      log.debug(`Reading config from ${serverNameIniPath}`);
      return this.parseIniFile(serverNameIniPath);
    }

    // Fallback: try old path directly in savePath (for backwards compatibility)
    const configPath = path.join(this.savePath, `${this.serverName}.ini`);
    if (fs.existsSync(configPath)) {
      log.debug(`Reading config from fallback ${configPath}`);
      return this.parseIniFile(configPath);
    }

    // Legacy fallback: servertest.ini
    const legacyPath = path.join(this.savePath, "servertest.ini");
    if (fs.existsSync(legacyPath)) {
      log.debug(`Reading config from legacy ${legacyPath}`);
      return this.parseIniFile(legacyPath);
    }

    // Try alternative path
    const altPath = path.join(this.savePath, "serveroptions.ini");
    if (fs.existsSync(altPath)) {
      return this.parseIniFile(altPath);
    }

    log.warn(
      `No config file found. Tried: ${serverNameIniPath}, ${configPath}, ${legacyPath}`,
    );
    return null;
  }

  parseIniFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const config = {};
      const lines = content.split("\n");

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith(";")) {
          const [key, ...valueParts] = trimmed.split("=");
          if (key && valueParts.length > 0) {
            config[key.trim()] = valueParts.join("=").trim();
          }
        }
      }

      return config;
    } catch (error) {
      log.error(`Failed to parse config file: ${error.message}`);
      return null;
    }
  }

  async saveServerConfig(config) {
    if (!this.savePath) {
      throw new Error("Save path not configured");
    }

    // Match getServerConfig logic: check Server/ subdirectory first, then fallback paths
    const serverIni = this.serverName
      ? `${this.serverName}.ini`
      : "servertest.ini";
    const serverSubdirPath = path.join(this.savePath, "Server", serverIni);
    let configPath;
    if (fs.existsSync(serverSubdirPath)) {
      configPath = serverSubdirPath;
    } else {
      configPath = path.join(this.savePath, serverIni);
      if (!fs.existsSync(configPath)) {
        configPath = path.join(this.savePath, "servertest.ini");
      }
    }

    try {
      // Read existing file to preserve comments and structure. Locked per-path
      // so an overlapping save can't interleave its read-modify-write with
      // this one and clobber part of the change.
      await withFileLock(configPath, async () => {
        let content = "";
        if (fs.existsSync(configPath)) {
          content = fs.readFileSync(configPath, "utf-8");
        }

        // Update values
        for (const [key, value] of Object.entries(config)) {
          // Validate key is a valid identifier (alphanumeric and underscore only)
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
            log.warn(`Invalid config key skipped: ${key}`);
            continue;
          }
          const escapedKey = escapeRegExp(key);
          // [ \t]* tolerance around "=" matches the convention routes/mods.js
          // settled on 2026-08-27 and server/utils/templateFiles.js's
          // readIniValues/mergeIniValues were just brought in line with
          // (bughunt-2026-08-31-b): a bare `^key=` regex doesn't match a
          // hand-edited "Key = value" line, so this would have replaced
          // nothing and appended a duplicate key instead. saveServerConfig()
          // is not called from anywhere today (verified via a full grep of
          // every call site) -- this is aligned to the settled convention on
          // principle, not because it was observed to fire live, so a future
          // reader doesn't mistake this for a confirmed live bug.
          const regex = new RegExp(`^[ \\t]*${escapedKey}[ \\t]*=.*$`, "m");
          // Strip newlines from values to prevent INI injection
          const safeValue = String(value).replace(/[\r\n]/g, "");
          if (content.match(regex)) {
            content = content.replace(regex, `${key}=${safeValue}`);
          } else {
            content += `\n${key}=${safeValue}`;
          }
        }

        writeFileAtomic(configPath, content, "utf-8");

        // 2026-09-03, serverManager.js sweep: read the write back rather
        // than trusting writeFileAtomic() not throwing as proof the file on
        // disk now says what we intended -- same "verify the effect, not
        // just that the call didn't throw" shape as every other fix this
        // sweep found. Cheap (content is already in memory) and catches a
        // wrong-encoding or truncated-on-disk write that writeFileAtomic()
        // itself has no way to detect from inside its own call. This
        // function has no production caller today (see the comment above),
        // but it is listed in eslint-rules/require-result-handling.js as a
        // result callers must check -- closing this gap now means whoever
        // wires it up later doesn't inherit a config write that reports
        // success without ever having verified it landed.
        const writtenBack = fs.readFileSync(configPath, "utf-8");
        if (writtenBack !== content) {
          throw new Error(
            `Config write verification failed: ${configPath} does not match the intended content after write`,
          );
        }
      });
      log.info("Server config saved");
      return { success: true };
    } catch (error) {
      log.error(`Failed to save config: ${error.message}`);
      throw error;
    }
  }

  async getModList() {
    if (!this.savePath) {
      return [];
    }

    try {
      const config = await this.getServerConfig();
      if (!config || !config.Mods) {
        return [];
      }

      const mods = config.Mods.split(";").filter((m) => m.trim());
      const workshopIds = config.WorkshopItems
        ? config.WorkshopItems.split(";").filter((m) => m.trim())
        : [];

      return mods.map((mod, index) => ({
        name: mod,
        workshopId: workshopIds[index] || null,
      }));
    } catch (error) {
      log.error(`Failed to get mod list: ${error.message}`);
      return [];
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  updatePaths(serverPath, savePath) {
    this.serverPath = serverPath || this.serverPath;
    this.savePath = savePath || this.savePath;
  }
}

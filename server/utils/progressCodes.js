/**
 * Single source of truth for every machine-readable `progressCode` a
 * Socket.IO install/SteamCMD progress event carries. Sibling registry to
 * ErrorCode (server/utils/errorCodes.js) but deliberately NOT the same
 * file or field name -- these travel over steamcmd:status, install:log,
 * install:complete, steam:start, steam:log and steamcmd:complete, not
 * res.json() error bodies, and `code` is already a reserved field name
 * there (errors.json/errorCodeRegistry.test.js). Field name on the wire is
 * `progressCode`, never `code`, so this registry's literals can never be
 * mistaken for -- or accidentally scanned by -- the ErrorCode machinery.
 *
 * Every emit site references a code as `ProgressCode.SOME_CODE` (member
 * access), never a bare string literal -- the same discipline errorCodes.js
 * documents for `code:`, enforced here by never writing the wire value as a
 * quoted string anywhere except inside this file. See
 * server/tests/progressCodeRegistry.test.js, which enforces this both ways:
 * every ProgressCode.* reference in server.js is registered here, every
 * entry here is both referenced in source AND has an en (and, transitively
 * via localeParity.test.ts, fr) entry in
 * client/src/locales/{en,fr}/installProgress.json.
 *
 * CONSTANT NAME === WIRE VALUE === LOCALE KEY, always, no exceptions --
 * unlike ErrorCode this registry has no pre-existing legacy wire values to
 * carry forward, so there was no reason to invent the split.
 *
 * THE 12 RAW SteamCMD STDOUT/STDERR PASSTHROUGH SITES DELIBERATELY HAVE NO
 * ENTRY HERE. They are not ours to translate -- they are SteamCMD's own
 * output, forwarded verbatim. They are routed through
 * emitRawSteamCmdLine() in server/routes/server.js, which emits
 * `{type, text}` with no `progressCode` field and no way to attach one --
 * structural, not a comment someone has to remember. A raw line can never
 * carry a progressCode; a line with a progressCode is never raw. See that
 * function's own comment for why this needs to be physically impossible
 * rather than documented (server.js:3026's history, 2026-08-22).
 */

export const ProgressCode = Object.freeze({
  /** ensureSteamCmdLinux() self-heal (2 call sites: /install, /steam-update
   * when steamcmdPath is empty) -- download starting. */
  STEAMCMD_LINUX_AUTO_DOWNLOAD_START: "STEAMCMD_LINUX_AUTO_DOWNLOAD_START",
  /** Shared across 3 call sites with identical wording: ensureSteamCmdLinux
   * (Linux self-heal) and both branches (Windows/Linux) of POST
   * /steamcmd/download -- the extraction step starting. */
  STEAMCMD_EXTRACTING: "STEAMCMD_EXTRACTING",
  /** Shared across 2 call sites with identical wording: ensureSteamCmdLinux
   * and POST /steamcmd/download's runFirstTimeSetup() -- first-run `+quit`
   * about to start. */
  STEAMCMD_INITIALIZING: "STEAMCMD_INITIALIZING",
  /** Shared across 2 call sites with identical wording: ensureSteamCmdLinux
   * and POST /steamcmd/download's runFirstTimeSetup() -- first-run
   * completed successfully. The installed path travels in a separate
   * structured `path` field, not interpolated into this message -- no
   * params. */
  STEAMCMD_INSTALL_COMPLETE: "STEAMCMD_INSTALL_COMPLETE",
  /** POST /api/server/install -- zomboidDataPath was not explicitly
   * configured, so the panel used the operator-provided (already-existing)
   * one. Own code from ..._ISOLATED below: "configured" vs "isolated" is a
   * word choice, not a value, so it's a variant per the params-vs-variant
   * rule, not a shared template with a swapped param. Params: {path}. */
  DATA_FOLDER_USING_CONFIGURED: "DATA_FOLDER_USING_CONFIGURED",
  /** POST /api/server/install -- no zomboidDataPath configured or provided;
   * the panel computed an isolated `<installPath>_Data` folder instead. See
   * ..._CONFIGURED above for why this is a separate code. Params: {path}. */
  DATA_FOLDER_USING_ISOLATED: "DATA_FOLDER_USING_ISOLATED",
  /** Shared across 2 call sites in POST /api/server/install's success path:
   * persisting the general install settings (serverPath/serverName/
   * memory/port/UPnP/data paths) and persisting the RCON settings. Both
   * used to be bare `await setSetting(...)` calls with nothing catching a
   * failure -- and this app's process.on("unhandledRejection") handler
   * calls fatalExit(), which kills the ENTIRE PANEL PROCESS (server/
   * index.js). So a single transient settings-write failure (a lock
   * contention, a full disk) after SteamCMD had ALREADY finished
   * successfully didn't just leave a setting unsaved, it took the whole
   * panel down mid-install with no message to the operator at all -- not
   * even the generic exit-code failure text, since nothing ever reaches
   * steamcmd.on("close")'s own res/io calls once the process itself has
   * exited. 2026-08-26, partial-failure-state hunt. Same non-fatal
   * `warnings`-array delivery as INSTALL_RCON_INI_PRECREATE_FAILED below
   * (the game files are fine; only the panel's own bookkeeping failed, and
   * every failed field can be re-entered from Settings once the panel is
   * back up). Params: {fields, reason}. */
  INSTALL_SETTINGS_SAVE_FAILED: "INSTALL_SETTINGS_SAVE_FAILED",
  /** POST /api/server/install -- RCON password/port were saved to settings.
   * Params: {port}. */
  RCON_SETTINGS_SAVED: "RCON_SETTINGS_SAVED",
  /** POST /api/server/install -- a minimal server .ini was pre-created so PZ
   * reads the RCON settings on first boot. No params. */
  INI_PRECREATED_WITH_RCON: "INI_PRECREATED_WITH_RCON",
  /** Shared across 2 call sites: /install and /quick-setup, both success
   * paths -- the INI_PRECREATED_WITH_RCON write above threw. The game files
   * (or, for quick-setup, the already-existing server files) are fine; this
   * only means RCON's password/port may not be in place for the very first
   * boot. Deliberately NOT reported as success:false (2026-08-26
   * install-failure hunt finding #6) -- ensureRconConfigured() re-runs this
   * exact write on every POST /server/start, so this is expected to
   * self-heal the moment the operator starts the server, and the message
   * says so rather than implying manual repair. Travels in a `warnings`
   * array alongside the normal success payload, not as the top-level
   * progressCode. Params: {reason}. */
  INSTALL_RCON_INI_PRECREATE_FAILED: "INSTALL_RCON_INI_PRECREATE_FAILED",
  /** POST /api/server/install -- the pre-created INI carried only the UPnP
   * setting (no rconPassword was given, so INI_PRECREATED_WITH_RCON's
   * wording -- which specifically names RCON credentials -- would be wrong
   * here). Own code rather than a shared template: "with RCON credentials"
   * vs "with UPnP setting" is a structural sentence difference (what the
   * file actually contains), not a value to interpolate. No params. */
  INI_PRECREATED_WITH_UPNP: "INI_PRECREATED_WITH_UPNP",
  /** POST /api/server/install -- custom .bat/.sh startup scripts generated.
   * Params: {scriptName} (a generated filename, not translatable prose). */
  STARTUP_SCRIPT_CREATED: "STARTUP_SCRIPT_CREATED",
  /** POST /api/server/install only -- the STARTUP_SCRIPT_CREATED write above
   * threw. (Quick Setup's equivalent write is NOT wrapped -- it fails the
   * whole request instead, which is correct there: quick-setup is
   * synchronous with the operator watching, so a hard failure costs them a
   * retry, not a discovered-later surprise.) The game files are fine; the
   * server can still be started, it will just use the plain default script
   * SteamCMD ships (not this server's configured memory/ports) until this
   * regenerates -- which POST /server/start does unconditionally on every
   * launch, so this too is expected to self-heal on first start. Same
   * `warnings`-array delivery as INSTALL_RCON_INI_PRECREATE_FAILED above.
   * Params: {reason}. */
  INSTALL_STARTUP_SCRIPT_FAILED: "INSTALL_STARTUP_SCRIPT_FAILED",
  /** POST /api/server/install -- 2026-08-26 bug hunt: steamcmd.on("close")
   * exiting 0 was treated as sufficient proof the game files were actually
   * installed, with nothing checking they were really there -- SteamCMD can
   * exit 0 while a download was rate-limited, interrupted, or otherwise
   * incomplete. Same PZ_INSTALL_MARKERS list DELETE /delete-files already
   * uses to confirm a folder is a real PZ install, checked here for parity
   * with that sibling check, not a new verification layer -- a marker
   * present is enough to call the install usable; this doesn't inspect file
   * contents or sizes. Same `warnings`-array delivery as
   * INSTALL_RCON_INI_PRECREATE_FAILED above. No params. */
  INSTALL_MISSING_GAME_FILES: "INSTALL_MISSING_GAME_FILES",
  /** POST /api/server/install -- PanelBridge.lua was copied into the fresh
   * install automatically. No params. */
  PANELBRIDGE_AUTO_INSTALLED: "PANELBRIDGE_AUTO_INSTALLED",
  /** POST /api/server/install -- steamcmd.on("close") with exit code 0, the
   * whole install flow finished. No params. */
  INSTALL_COMPLETE_SUCCESS: "INSTALL_COMPLETE_SUCCESS",
  /** POST /api/server/install -- steamcmd.on("close") with a non-zero exit
   * code. Params: {code}. */
  INSTALL_FAILED_EXIT_CODE: "INSTALL_FAILED_EXIT_CODE",
  /** POST /api/server/install -- steamcmd.on("close") after the 10-minute
   * idle watchdog called steamcmd.kill(). Own code from
   * INSTALL_FAILED_EXIT_CODE above, not a shared template with `code`
   * filled in as null/undefined: a killed-by-signal process reports
   * code=null to Node's close handler (2026-08-26 install-failure hunt
   * finding #1), so reusing that code's "exit code {{code}}" wording would
   * literally render the word "null" -- a different, true statement (SteamCMD
   * stalled and was stopped) rather than a cosmetically-broken instance of
   * the generic one. Params: {minutes}. */
  INSTALL_WATCHDOG_KILLED: "INSTALL_WATCHDOG_KILLED",
  /** Shared across 3 call sites with identical wording: /install's
   * steamcmd.on("error"), /steam-update's steamcmd.on("error"), and POST
   * /steamcmd/download's runFirstTimeSetup() steamcmd.on("error") -- the
   * spawned SteamCMD process itself could not be started (ENOENT etc, not a
   * non-zero exit). Params: {reason} (raw OS/Node error text -- English
   * only by nature, same known gap as errorCodes.js's DIRECTORY_READ_FAILED
   * {{guidance}}). */
  STEAMCMD_RUN_FAILED: "STEAMCMD_RUN_FAILED",
  /** POST /api/server/steam-update, validateFiles=true -- steam:start emit,
   * the "verify" branch. Own code from ..._UPDATE below -- word choice
   * (verb), not a value, so a variant per the params-vs-variant rule. No
   * params. */
  STEAM_START_VERIFY: "STEAM_START_VERIFY",
  /** POST /api/server/steam-update, validateFiles=false -- steam:start emit,
   * the "update" branch. See ..._VERIFY above. No params. */
  STEAM_START_UPDATE: "STEAM_START_UPDATE",
  /** POST /api/server/steam-update -- steamcmd.on("close"), output matched
   * the depot-access-denied / manifest-blocked signature. Independent of
   * the verify/update distinction (the message never names the operation),
   * so one code covers both. No params. */
  STEAM_DEPOT_ACCESS_DENIED: "STEAM_DEPOT_ACCESS_DENIED",
  /** POST /api/server/steam-update, validateFiles=false, exit code 0.
   * "update" vs "verification" is a word choice, not a value -- own code
   * from ..._VERIFY_COMPLETE_SUCCESS below, same reasoning as
   * STEAM_START_UPDATE/VERIFY. No params. */
  STEAM_UPDATE_COMPLETE_SUCCESS: "STEAM_UPDATE_COMPLETE_SUCCESS",
  /** POST /api/server/steam-update, validateFiles=true, exit code 0. See
   * ..._UPDATE_COMPLETE_SUCCESS above. No params. */
  STEAM_VERIFY_COMPLETE_SUCCESS: "STEAM_VERIFY_COMPLETE_SUCCESS",
  /** POST /api/server/steam-update, validateFiles=false, non-zero exit code,
   * not the depot-denied case. Params: {code}. */
  STEAM_UPDATE_FAILED: "STEAM_UPDATE_FAILED",
  /** POST /api/server/steam-update, validateFiles=true, non-zero exit code,
   * not the depot-denied case. Params: {code}. */
  STEAM_VERIFY_FAILED: "STEAM_VERIFY_FAILED",
  /** POST /api/server/steamcmd/download, Windows branch -- zip download
   * starting. Own wording/code from ..._LINUX below (different platform
   * branch, different English sentence). No params. */
  STEAMCMD_DOWNLOADING: "STEAMCMD_DOWNLOADING",
  /** POST /api/server/steamcmd/download, Windows branch -- the HTTPS
   * download itself failed. Params: {reason}. */
  STEAMCMD_DOWNLOAD_FAILED: "STEAMCMD_DOWNLOAD_FAILED",
  /** POST /api/server/steamcmd/download, Linux branch -- tar.gz download
   * starting. See STEAMCMD_DOWNLOADING above for why this is separate. No
   * params. */
  STEAMCMD_DOWNLOADING_LINUX: "STEAMCMD_DOWNLOADING_LINUX",
  /** POST /api/server/steamcmd/download, Linux branch -- both curl and wget
   * failed. Own wording from STEAMCMD_DOWNLOAD_FAILED above (adds the
   * curl/wget remediation sentence). Params: {reason}. */
  STEAMCMD_DOWNLOAD_FAILED_LINUX: "STEAMCMD_DOWNLOAD_FAILED_LINUX",
  /** Shared across 2 call sites with identical "Extraction failed: X"
   * wording: POST /steamcmd/download's Windows zip-extract catch, and its
   * Linux tar-extract callback error branch. Params: {reason}. */
  STEAMCMD_EXTRACTION_FAILED: "STEAMCMD_EXTRACTION_FAILED",
  /** POST /api/server/steamcmd/download, Linux branch -- `ldconfig -p | grep
   * -c libc.so.6` came back non-zero after extraction, so the 32-bit-library
   * check couldn't confirm they're present. THIS IS OUR OWN AUTHORED TEXT,
   * emitted through steamcmd:log (the event otherwise reserved for raw
   * SteamCMD passthrough) -- the exact call site that motivated
   * emitRawSteamCmdLine() existing at all (2026-08-22). No params. */
  STEAMCMD_32BIT_LIB_WARNING: "STEAMCMD_32BIT_LIB_WARNING",
  /** POST /api/server/steamcmd/download -- runFirstTimeSetup()'s
   * steamcmd.on("close") with a non-zero, non-7 exit code. Params: {code}. */
  STEAMCMD_SETUP_FAILED: "STEAMCMD_SETUP_FAILED",
  /** POST /api/server/steamcmd/download, Windows branch -- extractAndSetup()
   * already has its own full internal try/catch and reports its own
   * failures via STEAMCMD_EXTRACTION_FAILED, so this cannot fire today.
   * It exists because the call site -- file.on("close", async () => {
   * await extractAndSetup(zipPath) }) -- was an unguarded await in an
   * EventEmitter listener with nothing to catch a future rejection: same
   * unhandledRejection -> fatalExit() panel-kill shape as the
   * INSTALL_SETTINGS_SAVE_FAILED fix, just currently inert because the
   * callee happens to guard itself. This is the caller's OWN backstop, not
   * coupled to that staying true. Params: {reason}. */
  STEAMCMD_SELF_SETUP_UNEXPECTED_ERROR: "STEAMCMD_SELF_SETUP_UNEXPECTED_ERROR",
});

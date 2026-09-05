/**
 * Single source of truth for every machine-readable `code` the server
 * attaches to a response. A `code: "..."` value used anywhere in
 * server/routes or server/services MUST be a member of this object --
 * never a bare string literal at the call site, and never a locale key
 * built by concatenation/template at the point of use. That second pattern
 * is banned by name, not by guess: a sibling codebase (Zomboid_dev_panel
 * V2, apps/web/src/errorCodeMessageResolver.ts) shipped it as one of two
 * competing code->locale-key conventions, and the template-built one
 * "defeated three separate analyses" and rendered a raw i18next key on a
 * real screen because nothing had a static string to grep for. A key built
 * at runtime is invisible to every tool -- including the enforcement test
 * below -- that looks for a literal.
 *
 * See server/tests/errorCodeRegistry.test.js -- it AST-scans server/routes,
 * server/services, server/index.js and server/middleware for every
 * `code: "<literal>"` object-literal property and asserts each one is a
 * value here, and (once the file exists) that every key here has a
 * matching entry in client/src/locales/en/errors.json.
 *
 * CONSTANT NAME vs WIRE VALUE -- these are deliberately NOT always the
 * same string:
 *   - The 10 codes added most recently (auth.js, serverFiles.js,
 *     configMutationGuard.js) use the constant name as the wire value
 *     unchanged: ErrorCode.AUTH_REQUIRED === "AUTH_REQUIRED".
 *   - The 8 older codes (chunks.js, index.js, dockerUpdateProxy.js,
 *     panelUpdateChecker.js) ship a lower_snake_case wire value that
 *     client code already compares against with `===` today
 *     (client/src/pages/ChunkCleaner.tsx checks `err.code ===
 *     "server_running"`; client/src/pages/Settings.tsx checks
 *     `"apply_in_progress"`). Renaming those wire values would be a
 *     coordinated client+server change for zero user-visible benefit, and
 *     was explicitly ruled out (2026-08-22 i18n survey/ruling) rather than
 *     done silently. Their constant names are UPPER_SNAKE_CASE with a
 *     `_LEGACY` suffix, invented purely so every code -- old or new -- has
 *     an UPPER_SNAKE_CASE locale key to hang a translation on, even though
 *     the wire value itself stays frozen and lower_snake_case forever. Do
 *     not "clean up" a legacy wire value without going back to whoever
 *     owns the client comparison it would break.
 *
 * The constant name IS the locale key: client/src/locales/en/errors.json
 * and fr/errors.json key their entries by constant name
 * (`"AUTH_REQUIRED": "..."`, `"SERVER_RUNNING_LEGACY": "..."`), never by
 * wire value -- so a locale key is always derivable from the constant name
 * alone, independent of what the wire value happens to be.
 */

export const ErrorCode = Object.freeze({
  // --- current convention: constant name === wire value ---

  /** server/routes/auth.js -- POST /api/auth/setup, missing/invalid setup token. */
  SETUP_TOKEN_REQUIRED: "SETUP_TOKEN_REQUIRED",
  /** server/routes/auth.js -- POST /api/auth/refresh, no refresh token cookie/body. */
  NO_REFRESH_TOKEN: "NO_REFRESH_TOKEN",
  /** server/routes/auth.js -- POST /api/auth/refresh, refresh token present but invalid/expired. */
  INVALID_REFRESH_TOKEN: "INVALID_REFRESH_TOKEN",
  /** server/routes/auth.js -- loginLimiter, POST /api/auth/login rate-limited (5/min per IP). */
  RATE_LIMIT_LOGIN: "RATE_LIMIT_LOGIN",
  /** server/routes/auth.js -- GET /api/auth/status, needsSetup()/isAuthEnabled() threw. */
  AUTH_STATUS_CHECK_FAILED: "AUTH_STATUS_CHECK_FAILED",
  /** server/routes/auth.js -- setupLimiter, POST /api/auth/setup rate-limited (5/15min per IP). */
  RATE_LIMIT_SETUP: "RATE_LIMIT_SETUP",
  /** server/routes/auth.js -- POST /api/auth/setup, setup already completed (needsSetup() false). */
  SETUP_ALREADY_COMPLETED: "SETUP_ALREADY_COMPLETED",
  /** server/routes/auth.js (3 sites: /setup, /login, POST /users) -- username
   * and/or password missing. Identical wording, identical meaning across all
   * three -- shared code rather than three copies, same reasoning as
   * WIPE_TARGETS_REQUIRED elsewhere in this file. */
  AUTH_USERNAME_PASSWORD_REQUIRED: "AUTH_USERNAME_PASSWORD_REQUIRED",
  /** server/routes/auth.js -- POST /api/auth/setup, panelPort not an integer
   * in [1024, 65535]. */
  SETUP_PANEL_PORT_INVALID: "SETUP_PANEL_PORT_INVALID",
  /** server/routes/auth.js -- POST /api/auth/refresh, refreshAccessToken()
   * threw (not the "no token"/"invalid token" cases above, which return
   * early with their own codes -- this is the catch-all for an unexpected
   * failure, e.g. a DB error). */
  TOKEN_REFRESH_FAILED: "TOKEN_REFRESH_FAILED",
  /** server/routes/auth.js (4 sites: GET /me, POST /change-password, GET+POST
   * /recovery-codes) -- getAuthenticatedUser() returned null. Own code from
   * AUTH_REQUIRED (requireAuth middleware's "Authentication required") --
   * different wording ("Not authenticated"), different call sites (route
   * body checks, not middleware), kept separate rather than merged. */
  NOT_AUTHENTICATED: "NOT_AUTHENTICATED",
  /** server/routes/auth.js -- GET /api/auth/me, getAuthenticatedUser() threw. */
  AUTHENTICATION_ERROR: "AUTHENTICATION_ERROR",
  /** server/routes/auth.js -- POST /api/auth/change-password, currentPassword
   * and/or newPassword missing. */
  CHANGE_PASSWORD_FIELDS_REQUIRED: "CHANGE_PASSWORD_FIELDS_REQUIRED",
  /** server/routes/auth.js (2 sites: POST /users, PATCH /users/:id/role) --
   * `role` not one of USER_ROLES. Identical wording/meaning both sites,
   * shared code -- same reasoning as AUTH_USERNAME_PASSWORD_REQUIRED above. */
  AUTH_INVALID_ROLE: "AUTH_INVALID_ROLE",
  /** server/routes/auth.js -- resetLimiter, POST /api/auth/recover-with-code
   * and /reset-password rate-limited (3/15min per IP). */
  RATE_LIMIT_RESET: "RATE_LIMIT_RESET",
  /** server/routes/auth.js -- localResetTokenLimiter, POST
   * /api/auth/reset-token/local rate-limited (5/15min per IP). */
  RATE_LIMIT_LOCAL_RECOVERY: "RATE_LIMIT_LOCAL_RECOVERY",
  /** server/routes/auth.js -- POST /api/auth/recover-with-code, recovery
   * code and/or newPassword missing. */
  RECOVERY_CODE_FIELDS_REQUIRED: "RECOVERY_CODE_FIELDS_REQUIRED",
  /** server/routes/auth.js -- POST /api/auth/reset-token/local, request did
   * not originate from the panel host itself. */
  LOCAL_RESET_NOT_LOCAL: "LOCAL_RESET_NOT_LOCAL",
  /** server/routes/auth.js -- POST /api/auth/reset-token/local, refused
   * because the panel is behind a reverse proxy (trust proxy configured) and
   * so cannot verify the request's real origin. Fails closed rather than
   * trusting a forwarded header -- see isPanelBehindTrustProxy. */
  LOCAL_RESET_BEHIND_PROXY: "LOCAL_RESET_BEHIND_PROXY",
  /** server/routes/auth.js -- POST /api/auth/reset-token/local, writing the
   * token file itself failed. */
  LOCAL_RESET_TOKEN_CREATE_FAILED: "LOCAL_RESET_TOKEN_CREATE_FAILED",
  /** server/routes/auth.js -- POST /api/auth/reset-password, token and/or
   * newPassword missing. */
  RESET_PASSWORD_FIELDS_REQUIRED: "RESET_PASSWORD_FIELDS_REQUIRED",
  /** server/routes/auth.js -- POST /api/auth/reset-password, newPassword
   * exceeds 128 characters. */
  RESET_PASSWORD_TOO_LONG: "RESET_PASSWORD_TOO_LONG",
  /** server/routes/auth.js -- POST /api/auth/reset-password, no
   * reset-token.txt exists on disk. */
  RESET_TOKEN_NOT_FOUND: "RESET_TOKEN_NOT_FOUND",
  /** server/routes/auth.js -- POST /api/auth/reset-password,
   * reset-token.txt exceeds the 1KB size cap. */
  RESET_TOKEN_TOO_LARGE: "RESET_TOKEN_TOO_LARGE",
  /** server/routes/auth.js -- POST /api/auth/reset-password,
   * reset-token.txt is older than 24h. */
  RESET_TOKEN_EXPIRED: "RESET_TOKEN_EXPIRED",
  /** server/routes/auth.js -- POST /api/auth/reset-password,
   * reset-token.txt content is under 8 characters. */
  RESET_TOKEN_TOO_SHORT: "RESET_TOKEN_TOO_SHORT",
  /** server/routes/auth.js -- POST /api/auth/reset-password, submitted token
   * does not match the stored token (timing-safe compare failed). */
  RESET_TOKEN_INVALID: "RESET_TOKEN_INVALID",
  /** server/routes/serverFiles.js -- ServerNotConfiguredError, thrown by the
   * router-level gate when no server is configured at all. */
  SERVER_NOT_CONFIGURED: "SERVER_NOT_CONFIGURED",
  /** server/routes/serverFiles.js -- a route that needs the remote-config
   * (SFTP) transport, but it isn't configured. */
  REMOTE_CONFIG_NOT_CONFIGURED: "REMOTE_CONFIG_NOT_CONFIGURED",
  /** server/routes/serverFiles.js -- remote-mirror middleware, a
   * LOCAL_ONLY_PATHS route (/browse-files, /image-preview) hit on a remote
   * server -- these read the panel host's own filesystem, which an SFTP
   * mirror can't stand in for. */
  REMOTE_BROWSE_NOT_AVAILABLE: "REMOTE_BROWSE_NOT_AVAILABLE",
  /** server/routes/serverFiles.js -- GET /ini, no <serverName>.ini at the
   * resolved config path. */
  INI_FILE_NOT_FOUND: "INI_FILE_NOT_FOUND",
  /** server/routes/serverFiles.js -- PUT /ini, `settings` missing or not an
   * object. */
  INI_SETTINGS_REQUIRED: "INI_SETTINGS_REQUIRED",
  /** server/routes/serverFiles.js -- PUT /ini, `settings` carries a
   * __proto__/constructor/prototype key (prototype-pollution guard). */
  INI_SETTINGS_INVALID: "INI_SETTINGS_INVALID",
  /** server/routes/serverFiles.js -- PUT /ini, the live file has a key
   * duplicated across two config blocks (utils/iniDuplicateKeys.js). The
   * structured save reconstructs the file from a flat settings object, so
   * every key present gets ALL of its lines rewritten to one value --
   * permanently discarding the other copy on every save, even one that
   * never touched that key. Refused rather than allowed; the raw tab
   * round-trips the file byte-for-byte and stays available to fix it.
   * bug-hunt-2026-08-27, Angela's structured-save destructive-write trace. */
  INI_DUPLICATE_KEY_BLOCKS_STRUCTURED_SAVE: "INI_DUPLICATE_KEY_BLOCKS_STRUCTURED_SAVE",
  /** server/routes/serverFiles.js (3 sites: GET /sandbox, GET
   * /sandbox/validate, POST /sandbox/repair) -- no <serverName>_SandboxVars.
   * lua at the resolved config path. Identical wording/meaning all three,
   * shared code. Distinct from SANDBOX_OPTION_FILE_NOT_FOUND below (PUT
   * /sandbox-option's own wording, with extra guidance, kept separate). */
  SANDBOXVARS_FILE_NOT_FOUND: "SANDBOXVARS_FILE_NOT_FOUND",
  /** server/routes/serverFiles.js -- PUT /sandbox, `sandbox` missing or not
   * an object. */
  SANDBOX_OBJECT_REQUIRED: "SANDBOX_OBJECT_REQUIRED",
  /** server/routes/serverFiles.js (2 sites: top-level and per-section) --
   * PUT /sandbox, `sandbox` (or a nested section) carries a __proto__/
   * constructor/prototype key. Identical wording/meaning both sites, shared
   * code. */
  SANDBOX_DATA_INVALID: "SANDBOX_DATA_INVALID",
  /** server/routes/serverFiles.js -- PUT /sandbox, JSON payload exceeds 1MB. */
  SANDBOX_DATA_TOO_LARGE: "SANDBOX_DATA_TOO_LARGE",
  /** server/routes/serverFiles.js -- PUT /sandbox-option, `name` missing or
   * not a string. */
  SANDBOX_OPTION_NAME_REQUIRED: "SANDBOX_OPTION_NAME_REQUIRED",
  /** server/routes/serverFiles.js -- PUT /sandbox-option, `value` isn't a
   * string/number/boolean. */
  SANDBOX_OPTION_VALUE_INVALID: "SANDBOX_OPTION_VALUE_INVALID",
  /** server/routes/serverFiles.js -- PUT /sandbox-option, `name` fails the
   * "Block.Key" / "Key" identifier format check. */
  SANDBOX_OPTION_NAME_INVALID: "SANDBOX_OPTION_NAME_INVALID",
  /** server/routes/serverFiles.js -- PUT /sandbox-option, no SandboxVars.lua
   * at the resolved path. Own wording (includes "Start the server once to
   * generate it") from SANDBOXVARS_FILE_NOT_FOUND above -- kept separate
   * rather than merged. */
  SANDBOX_OPTION_FILE_NOT_FOUND: "SANDBOX_OPTION_FILE_NOT_FOUND",
  /** server/routes/serverFiles.js -- POST /sandbox/repair, the file's brace
   * corruption doesn't match any pattern repairSandboxSyntax() knows how to
   * fix. Distinct from SANDBOX_REPAIR_BACKUP_FAILED below -- two different,
   * specific reasons the repair didn't happen, kept as separate codes rather
   * than one shared "repair failed" so the response says which. Threaded
   * through as `code: result.code` (not a literal at the res.json() call
   * site) -- the literal lives on the object returned from the withFileLock
   * callback above it. */
  SANDBOX_REPAIR_PATTERN_UNKNOWN: "SANDBOX_REPAIR_PATTERN_UNKNOWN",
  /** server/routes/serverFiles.js -- POST /sandbox/repair, a fix was found
   * but the pre-repair backup itself failed, so nothing was written. See
   * SANDBOX_REPAIR_PATTERN_UNKNOWN above for why this is a separate code.
   * Sends `{ reason: backup.error }` (the underlying fs error) -- threaded
   * through the withFileLock result object's own `params` field, same
   * pattern as its `code` field documented above. */
  SANDBOX_REPAIR_BACKUP_FAILED: "SANDBOX_REPAIR_BACKUP_FAILED",
  /** server/routes/serverFiles.js -- GET /spawnpoints, no
   * <serverName>_spawnpoints.lua at the resolved path. */
  SPAWNPOINTS_FILE_NOT_FOUND: "SPAWNPOINTS_FILE_NOT_FOUND",
  /** server/routes/serverFiles.js -- PUT /spawnpoints, `spawnpoints` missing
   * or not an object. */
  SPAWNPOINTS_OBJECT_REQUIRED: "SPAWNPOINTS_OBJECT_REQUIRED",
  /** server/routes/serverFiles.js -- GET /spawnregions, no
   * <serverName>_spawnregions.lua at the resolved path. */
  SPAWNREGIONS_FILE_NOT_FOUND: "SPAWNREGIONS_FILE_NOT_FOUND",
  /** server/routes/serverFiles.js -- PUT /spawnregions, `spawnregions` isn't
   * an array. */
  SPAWNREGIONS_ARRAY_REQUIRED: "SPAWNREGIONS_ARRAY_REQUIRED",
  /** server/routes/serverFiles.js (2 sites: GET /raw/:type, PUT /raw/:type)
   * -- `type` isn't one of ini/sandbox/spawnpoints/spawnregions. Identical
   * wording/meaning both sites, shared code. */
  RAW_FILE_INVALID_TYPE: "RAW_FILE_INVALID_TYPE",
  /** server/routes/serverFiles.js (2 sites: GET /raw/:type, GET
   * /image-preview) -- the resolved file doesn't exist on disk. Both sites
   * emit the bare, already-generic "File not found" with no route-specific
   * detail to lose, so they share one code -- same reasoning as INVALID_PATH
   * in server.js. */
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  /** server/routes/serverFiles.js -- PUT /raw/:type, `content` isn't a
   * string. */
  RAW_CONTENT_STRING_REQUIRED: "RAW_CONTENT_STRING_REQUIRED",
  /** server/routes/serverFiles.js -- PUT /raw/:type, `content` exceeds
   * 512KB. */
  RAW_CONTENT_TOO_LARGE: "RAW_CONTENT_TOO_LARGE",
  /** server/routes/serverFiles.js -- PUT /raw/ini, a secret-shaped line
   * (e.g. RCONPassword) came back masked but reconcileMaskedIniLines()
   * couldn't match it to exactly one live line to restore (key missing, or
   * the key appears more than once in either the live file or the
   * submission). Refused rather than guessed; nothing was written. */
  RAW_INI_SECRET_UNRESOLVABLE: "RAW_INI_SECRET_UNRESOLVABLE",
  /** server/routes/serverFiles.js -- PUT /raw/ini, a secret-shaped line that
   * held a real value live was entirely removed from the submitted content
   * (not just masked-and-unchanged). Refused rather than silently dropping
   * or silently restoring a credential the operator may not have realized
   * was real. */
  RAW_INI_SECRET_LINE_REMOVED: "RAW_INI_SECRET_LINE_REMOVED",
  /** server/routes/serverFiles.js -- POST /restore/:filename, sanitized
   * filename doesn't end in .bak. */
  RESTORE_INVALID_EXTENSION: "RESTORE_INVALID_EXTENSION",
  /** server/routes/serverFiles.js -- POST /restore/:filename, no file at the
   * resolved backup path. */
  RESTORE_BACKUP_NOT_FOUND: "RESTORE_BACKUP_NOT_FOUND",
  /** server/routes/serverFiles.js -- POST /restore/:filename, backup
   * filename doesn't have the expected <name>.<timestamp>.bak shape (fewer
   * than 3 dot-separated parts). */
  RESTORE_INVALID_FILENAME: "RESTORE_INVALID_FILENAME",
  /** server/routes/serverFiles.js -- POST /restore/:filename, the original
   * filename recovered by stripping the .bak+timestamp suffix is empty, is
   * exactly "." or "..", or contains a path separator -- e.g. a crafted
   * "....bak" makes the stripped result exactly "..". Load-bearing for
   * traversal safety: this is the one value in this handler that is never
   * re-checked by the .bak-extension guard above it. */
  RESTORE_INVALID_ORIGINAL_NAME: "RESTORE_INVALID_ORIGINAL_NAME",
  /** server/routes/serverFiles.js -- POST /save-and-reload, no rconService
   * or it isn't connected, so `reloadoptions` can't be sent. */
  SAVE_AND_RELOAD_RCON_NOT_CONNECTED: "SAVE_AND_RELOAD_RCON_NOT_CONNECTED",
  /** server/routes/serverFiles.js (4 sites: GET/PUT/DELETE /templates/:id,
   * POST /templates/:id/apply) -- :id fails the path-traversal-safe
   * basename/charset check. Identical wording/meaning all four, shared
   * code. */
  TEMPLATE_ID_INVALID: "TEMPLATE_ID_INVALID",
  /** server/routes/serverFiles.js (4 sites: GET/PUT/DELETE /templates/:id,
   * POST /templates/:id/apply) -- no <id>.json in the templates directory.
   * Identical wording/meaning all four, shared code. */
  TEMPLATE_NOT_FOUND: "TEMPLATE_NOT_FOUND",
  /** server/routes/serverFiles.js -- POST /templates, `name` missing. */
  TEMPLATE_NAME_REQUIRED: "TEMPLATE_NAME_REQUIRED",
  /** server/routes/serverFiles.js -- POST /templates, 100 generated
   * filename candidates for this name all already exist. */
  TEMPLATE_NAME_CONFLICT_LIMIT: "TEMPLATE_NAME_CONFLICT_LIMIT",
  /** server/routes/serverFiles.js -- POST /templates/:id/apply, neither
   * applyIni nor applySandbox matched anything in the stored template. */
  TEMPLATE_APPLY_NOTHING_TO_APPLY: "TEMPLATE_APPLY_NOTHING_TO_APPLY",
  /** server/routes/serverFiles.js (2 sites: GET /browse-files, GET
   * /image-preview) -- confineToRoots() rejected the requested path.
   * Identical wording/meaning both sites, shared code. */
  BROWSE_ACCESS_DENIED: "BROWSE_ACCESS_DENIED",
  /** server/routes/serverFiles.js -- GET /browse-files, no path in the
   * query string and no server config path to default to. */
  BROWSE_NO_PATH: "BROWSE_NO_PATH",
  /** server/routes/serverFiles.js -- GET /browse-files, resolved path
   * doesn't exist. */
  BROWSE_PATH_NOT_FOUND: "BROWSE_PATH_NOT_FOUND",
  /** server/routes/serverFiles.js -- GET /browse-files, resolved path
   * exists but isn't a directory. */
  BROWSE_PATH_NOT_DIRECTORY: "BROWSE_PATH_NOT_DIRECTORY",
  /** server/routes/serverFiles.js -- GET /image-preview, no `path` query
   * parameter. */
  IMAGE_PREVIEW_PATH_REQUIRED: "IMAGE_PREVIEW_PATH_REQUIRED",
  /** server/routes/serverFiles.js -- GET /image-preview, resolved file's
   * extension isn't a known image type. */
  IMAGE_PREVIEW_NOT_IMAGE: "IMAGE_PREVIEW_NOT_IMAGE",
  /** server/routes/serverFiles.js -- GET /image-preview, resolved file
   * exceeds 5MB. */
  IMAGE_PREVIEW_TOO_LARGE: "IMAGE_PREVIEW_TOO_LARGE",
  /** server/services/auth.js -- requireAuth middleware, first-run setup not done yet. */
  SETUP_REQUIRED: "SETUP_REQUIRED",
  /** server/services/auth.js -- requireAuth middleware, no/malformed Authorization header. */
  AUTH_REQUIRED: "AUTH_REQUIRED",
  /** server/services/auth.js -- requireAuth middleware, token present but invalid/expired. */
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  /** server/services/configMutationGuard.js -- couldn't determine whether the
   * server process is running (no serverManager, or the check itself threw). */
  SERVER_STATE_UNKNOWN: "SERVER_STATE_UNKNOWN",
  /** server/services/configMutationGuard.js -- server is confirmed running;
   * local config mutation refused until it's stopped. */
  SERVER_RUNNING: "SERVER_RUNNING",
  /** server/services/permissions.js -- requirePermission() refused: the
   * caller's role doesn't grant the capability, the role couldn't be
   * resolved at all, or the capability string itself isn't a registered
   * one. Deliberately one code for all three -- the middleware fails closed
   * the same way regardless of which one occurred, and the response never
   * says which (an unrecognized-capability detail belongs in the server
   * log, not in a message an unauthorized caller can read). */
  PERMISSION_DENIED: "PERMISSION_DENIED",
  /** server/routes/permissions.js -- GET/PUT/DELETE .../roles/:id, no role
   * with that id exists. */
  ROLE_NOT_FOUND: "ROLE_NOT_FOUND",
  /** server/routes/permissions.js -- POST/PUT .../roles, the requested name
   * already belongs to another role. */
  ROLE_NAME_TAKEN: "ROLE_NAME_TAKEN",
  /** server/routes/permissions.js -- POST/PUT .../roles, the capabilities
   * array contains a key that isn't in the catalogue. */
  INVALID_CAPABILITY: "INVALID_CAPABILITY",
  /** server/services/permissions.js (role-EDIT lockout) and
   * server/services/auth.js (per-user role-reassignment/deletion lockout,
   * assertNoRecoveryLockout) -- this change would leave zero users able to
   * manage roles or manage users. Hard refusal, no override. Both sites
   * pass the same `{ action: capability }` param -- `action` carries the
   * stable capability key, not English prose, resolved client-side via
   * capabilities.<key>.label (client/src/locales/{en,fr}/roles.json)
   * through errorMessage.ts's CAPABILITY_KEY_PARAM_NAMES. */
  ROLE_LOCKOUT_LAST_MANAGER: "ROLE_LOCKOUT_LAST_MANAGER",
  /** server/services/permissions.js -- lockout rule 2: the acting user is
   * about to remove their own ability to manage roles/users (other users
   * still hold it, so not a full lockout under ROLE_LOCKOUT_LAST_MANAGER --
   * but the acting user would lose their own way to undo this). Refused
   * unless the request explicitly sets confirmSelfCapabilityLoss: true. */
  ROLE_SELF_CAPABILITY_LOSS_CONFIRM: "ROLE_SELF_CAPABILITY_LOSS_CONFIRM",
  /** server/services/permissions.js -- lockout rule 3: DELETE on a role
   * that users still hold, with no reassignTo given -- refused rather than
   * orphaning them. */
  ROLE_HAS_MEMBERS: "ROLE_HAS_MEMBERS",
  /** server/services/permissions.js -- deleteRole() rule 0: DELETE on a
   * seeded role (admin/technician/moderator), independent of member count.
   * Hard refusal, no override: a seeded role with zero current members
   * used to be deletable via a direct API call even though the UI's
   * delete button is disabled for it -- this closes that gap in the
   * service itself, not just the one screen that happened to check first. */
  ROLE_IS_SEEDED: "ROLE_IS_SEEDED",
  /** server/services/auth.js -- DELETE /api/auth/users/:id, the caller
   * targeted their own account. Hard refusal, no override: unlike editing
   * your own role's capabilities (ROLE_SELF_CAPABILITY_LOSS_CONFIRM, which
   * still leaves you signed in with reduced access), deleting your own
   * account invalidates your session on the very next request -- you'd be
   * logged out mid-action with no account left to log back into. Another
   * admin can delete the account instead, which is a deliberate two-party
   * action rather than a one-click accident. */
  USER_SELF_DELETE_REFUSED: "USER_SELF_DELETE_REFUSED",
  /** server/index.js -- Docker-update apply path ONLY: server is running
   * and RCON isn't connected, so the panel can't stop it automatically
   * before applying the update. Split out from SERVER_RUNNING_LEGACY
   * (2026-08-22 ruling) rather than reusing it or interpolating a shared
   * message: chunks.js's refusal means "a running server holds save files
   * open and will overwrite your changes on shutdown" and this one means
   * "RCON is unavailable so the panel can't stop it for you" -- two
   * different, specific, useful reasons that a single shared string (or a
   * template-substituted one) would flatten into one generic "server is
   * running" message, throwing away whichever half didn't get picked.
   * A NEW call site, not yet wired -- server/index.js was dirty (Kevin's
   * CSP work, Dwight's route sweep) when this was added, so the actual
   * `code: "server_running"` -> `code: ErrorCode.SERVER_RUNNING_RCON_
   * UNAVAILABLE` swap at that one site is pending sequencing. */
  SERVER_RUNNING_RCON_UNAVAILABLE: "SERVER_RUNNING_RCON_UNAVAILABLE",

  /** server/routes/docker.js -- POST /api/docker/containers/:id/:action,
   * dockerClient exists but isn't enabled/available. */
  DOCKER_UNAVAILABLE: "DOCKER_UNAVAILABLE",
  /** server/routes/docker.js -- POST /api/docker/containers/:id/:action,
   * req.body.serverId doesn't match a known server profile. */
  SERVER_PROFILE_NOT_FOUND: "SERVER_PROFILE_NOT_FOUND",
  /** server/routes/docker.js -- the container id in the URL isn't the one
   * mapped to the resolved server profile. */
  CONTAINER_NOT_MAPPED: "CONTAINER_NOT_MAPPED",
  /** server/routes/docker.js -- the container exists but isn't one this
   * panel manages (inspectManagedContainer returned nothing). */
  CONTAINER_NOT_MANAGED: "CONTAINER_NOT_MANAGED",
  /** server/routes/docker.js -- stop/restart action on a running container:
   * couldn't establish an RCON connection to save the world first. */
  DOCKER_ACTION_RCON_CONNECT_FAILED: "DOCKER_ACTION_RCON_CONNECT_FAILED",
  /** server/routes/docker.js -- stop/restart action on a running container:
   * RCON connected but the pre-stop world save itself failed. */
  DOCKER_ACTION_SAVE_FAILED: "DOCKER_ACTION_SAVE_FAILED",

  /** server/routes/rcon.js -- POST /api/rcon/execute, no command in the body. */
  RCON_COMMAND_REQUIRED: "RCON_COMMAND_REQUIRED",
  /** server/routes/rcon.js -- POST /api/rcon/execute, command isn't a
   * string or exceeds the 2000-character cap. */
  RCON_COMMAND_INVALID: "RCON_COMMAND_INVALID",
  /** server/routes/rcon.js -- POST /api/rcon/connect, host fails the
   * alphanumeric/dot/hyphen format check. */
  RCON_INVALID_HOST: "RCON_INVALID_HOST",
  /** server/routes/rcon.js -- POST /api/rcon/connect, port isn't 1-65535. */
  RCON_INVALID_PORT: "RCON_INVALID_PORT",
  /** server/routes/rcon.js -- POST /api/rcon/connect, password isn't a
   * string or exceeds 256 characters. */
  RCON_INVALID_PASSWORD: "RCON_INVALID_PASSWORD",
  /** No longer emitted by server/routes/rcon.js as of the 2026-08-26 /connect
   * granularity fix -- a failed connect() is now always classified as one of
   * the two codes below instead. Kept defined (not deleted) since it's a
   * frozen wire value other integrations may still match on; see
   * RCON_CONNECT_UNREACHABLE / RCON_CONNECT_AUTH_FAILED for the real codes. */
  RCON_CONNECT_FAILED: "RCON_CONNECT_FAILED",
  /** server/routes/rcon.js -- POST /api/rcon/connect, rconService.connect()
   * failed and a follow-up TCP probe confirms host:port is unreachable --
   * same classification /api/rcon/test uses (RCON_UNREACHABLE_DETAIL in
   * services/rcon.js). Also emitted by server/routes/config.js -- POST
   * /api/config/test-rcon (added 2026-08-26), same probe and same detail
   * string, reused rather than a third independently-drifting mapping. */
  RCON_CONNECT_UNREACHABLE: "RCON_CONNECT_UNREACHABLE",
  /** server/routes/rcon.js -- POST /api/rcon/connect, rconService.connect()
   * failed but host:port IS reachable -- treated as a failed authentication,
   * same classification /api/rcon/test uses (RCON_AUTH_FAILED_DETAIL in
   * services/rcon.js). Also emitted by server/routes/config.js -- POST
   * /api/config/test-rcon (added 2026-08-26), same reasoning. */
  RCON_CONNECT_AUTH_FAILED: "RCON_CONNECT_AUTH_FAILED",
  /** server/services/rcon.js -- RconService.execute(), attached alongside
   * getUserFriendlyError()'s prose (POST /api/rcon/execute's response body)
   * whenever the failure represents the RCON session having dropped
   * (connection refused/reset/timed out, exhausted reconnect attempts, not
   * connected, or the game server itself not running). Exists so the
   * client's disconnect detection (client/src/pages/Console.tsx's
   * isRconDisconnectError) can check THIS instead of substring-matching
   * the prose, which silently broke once already: 2026-08-30,
   * rcon-disconnect-detection-matches-prose-not-codes -- "Server is not
   * running" was reworded to "Game server is not running." and the
   * client's case-sensitive phrase list missed it, because it was an
   * independently-maintained copy of the same classification with no way
   * to notice the two had drifted. One shared code for every disconnect
   * reason, not one per reason -- the client only ever needs a yes/no
   * answer, and unlike N maintained phrases a single stable code can't
   * itself drift out of sync. Deliberately NOT attached to an
   * authentication failure: a wrong RCON password is not a disconnect. */
  RCON_EXECUTE_DISCONNECTED: "RCON_EXECUTE_DISCONNECTED",

  /** server/routes/backup.js -- POST /api/backup/create, active server is
   * remote (SFTP-managed), so there's no local filesystem to back up. */
  BACKUP_REMOTE_NOT_AVAILABLE: "BACKUP_REMOTE_NOT_AVAILABLE",
  /** server/routes/backup.js -- GET /api/backup/download/:name,
   * getBackupsPath() returned nothing (no server configured yet). */
  BACKUPS_FOLDER_NOT_FOUND: "BACKUPS_FOLDER_NOT_FOUND",
  /** server/routes/backup.js (2 sites: download, restore) -- the :name
   * param doesn't end in .zip after path.basename() sanitization. */
  BACKUP_INVALID_FILE: "BACKUP_INVALID_FILE",
  /** server/routes/backup.js -- GET /api/backup/download/:name, no file at
   * the resolved path. */
  BACKUP_NOT_FOUND: "BACKUP_NOT_FOUND",
  /** server/routes/backup.js -- POST /api/backup/restore/:name, active
   * server is remote. Distinct wording/code from BACKUP_REMOTE_NOT_AVAILABLE
   * (create path) -- kept separate rather than merged, same reasoning as
   * SERVER_RUNNING_RCON_UNAVAILABLE above. */
  BACKUP_RESTORE_REMOTE_NOT_AVAILABLE: "BACKUP_RESTORE_REMOTE_NOT_AVAILABLE",
  /** server/routes/backup.js -- POST /api/backup/restore/:name, the target
   * server process is currently running. */
  BACKUP_RESTORE_SERVER_RUNNING: "BACKUP_RESTORE_SERVER_RUNNING",
  /** server/routes/backup.js -- POST /api/backup/delete-older-than, `days`
   * isn't a whole number >= 1. */
  BACKUP_INVALID_DAYS_PARAMETER: "BACKUP_INVALID_DAYS_PARAMETER",
  /** server/routes/backup.js -- POST /api/backup/upload, active server is
   * remote. Distinct from the create/restore remote-refusal codes above --
   * own wording, own call site. */
  BACKUP_UPLOAD_REMOTE_NOT_AVAILABLE: "BACKUP_UPLOAD_REMOTE_NOT_AVAILABLE",
  /** server/routes/backup.js -- POST /api/backup/upload, empty or missing
   * request body. */
  BACKUP_UPLOAD_NO_FILE: "BACKUP_UPLOAD_NO_FILE",
  /** server/routes/backup.js -- POST /api/backup/upload, body doesn't start
   * with the zip local-file-header signature. */
  BACKUP_UPLOAD_INVALID_ZIP_SIGNATURE: "BACKUP_UPLOAD_INVALID_ZIP_SIGNATURE",
  /** server/routes/backup.js -- POST /api/backup/upload, sanitized filename
   * doesn't end in .zip. Distinct check/site from BACKUP_UPLOAD_INVALID_ZIP_
   * SIGNATURE (that one reads file bytes; this one reads the filename). */
  BACKUP_UPLOAD_INVALID_EXTENSION: "BACKUP_UPLOAD_INVALID_EXTENSION",
  /** server/routes/backup.js -- POST /api/backup/upload, a backup with the
   * resolved target filename already exists on disk. */
  BACKUP_UPLOAD_NAME_CONFLICT: "BACKUP_UPLOAD_NAME_CONFLICT",
  /** server/routes/backup.js -- POST /api/backup/upload, streamed body
   * exceeded MAX_UPLOAD_BYTES. Added 2026-09-05 alongside the switch from
   * express.raw() (fully buffered) to streamUploadToFile() (streamed) --
   * the limit itself is unchanged, just enforced while streaming instead
   * of after the whole body was already buffered in memory. */
  BACKUP_UPLOAD_TOO_LARGE: "BACKUP_UPLOAD_TOO_LARGE",
  /** server/routes/backup.js -- POST /api/backup/upload, getBackupsPath()
   * returned nothing. Distinct code/status(500) from BACKUPS_FOLDER_NOT_
   * FOUND (download path, status 404) -- different route, different wording. */
  BACKUPS_FOLDER_UNAVAILABLE: "BACKUPS_FOLDER_UNAVAILABLE",

  /** server/routes/server.js -- POST /api/server/start, active server is remote. */
  SERVER_START_REMOTE_REFUSED: "SERVER_START_REMOTE_REFUSED",
  /** server/routes/server.js -- POST /api/server/force-stop, active server is
   * remote. Own wording/code, not reused across start/force-stop/restart --
   * same reasoning as SERVER_RUNNING_RCON_UNAVAILABLE above: which action was
   * refused is itself useful information to keep. */
  SERVER_FORCE_STOP_REMOTE_REFUSED: "SERVER_FORCE_STOP_REMOTE_REFUSED",
  /** server/routes/server.js -- POST /api/server/restart, active server is remote. */
  SERVER_RESTART_REMOTE_REFUSED: "SERVER_RESTART_REMOTE_REFUSED",
  /** server/routes/server.js -- POST /api/server/stop, RCON isn't connected
   * so the graceful (save-then-quit) shutdown can't happen. */
  SERVER_STOP_RCON_NOT_CONNECTED: "SERVER_STOP_RCON_NOT_CONNECTED",
  /** server/routes/server.js -- POST /api/server/stop, the pre-quit world
   * save itself failed; server was left running. */
  SERVER_STOP_SAVE_FAILED: "SERVER_STOP_SAVE_FAILED",
  /** server/routes/server.js -- POST /api/server/stop, world saved but the
   * managed container failed to stop. */
  SERVER_STOP_CONTAINER_STOP_FAILED: "SERVER_STOP_CONTAINER_STOP_FAILED",
  /** server/routes/server.js -- POST /api/server/message, no message body. */
  SERVER_MESSAGE_REQUIRED: "SERVER_MESSAGE_REQUIRED",
  /** server/routes/server.js -- POST /api/server/message, message isn't a
   * string or exceeds 1000 characters. */
  SERVER_MESSAGE_TOO_LONG: "SERVER_MESSAGE_TOO_LONG",
  /** server/routes/server.js (3 sites: lightning, thunder, horde) -- optional
   * `username` isn't a string or exceeds 64 characters. */
  EVENTS_INVALID_USERNAME: "EVENTS_INVALID_USERNAME",
  /** server/routes/server.js (3 sites: /branches, /install, /steam-update) --
   * steamcmdPath fails isValidPath(). */
  STEAMCMD_PATH_INVALID: "STEAMCMD_PATH_INVALID",
  /** server/routes/server.js (3 sites: /install, /quick-setup, /steam-update) --
   * installPath fails isValidPath(). */
  INSTALL_PATH_INVALID: "INSTALL_PATH_INVALID",
  /** server/routes/server.js -- POST /api/server/install, missing
   * steamcmdPath/installPath/serverName. Own code from the /quick-setup and
   * /steam-update variants below, which require different field sets. */
  INSTALL_MISSING_FIELDS: "INSTALL_MISSING_FIELDS",
  /** server/routes/server.js (2 sites: /install, /quick-setup) -- serverName
   * fails isValidServerName() (letters/numbers/underscore/hyphen/space, max
   * 64 chars). Distinct from WIPE_INVALID_SERVER_NAME below, which is a
   * bare no-path-separators check on the already-configured server name. */
  SERVER_NAME_FORMAT_INVALID: "SERVER_NAME_FORMAT_INVALID",
  /** server/routes/server.js (2 sites: /install, /quick-setup) -- optional
   * zomboidDataPath fails isValidPath(). */
  ZOMBOID_DATA_PATH_INVALID: "ZOMBOID_DATA_PATH_INVALID",
  /** server/routes/server.js (3 sites: /install, /quick-setup,
   * /configure-network) -- serverPort isn't an integer in [1024, 65535].
   * Refused rather than coerced: requireIntInRange(), not validateInt()'s
   * coerceIntInRange() sibling -- a wrong port here silently listens
   * somewhere the operator's firewall rule and port forward don't point at,
   * with no error telling them why. See 2026-08-23 validateInt-coerces
   * audit. */
  INVALID_SERVER_PORT: "INVALID_SERVER_PORT",
  /** server/routes/server.js (3 sites: /install, /quick-setup,
   * /configure-rcon) -- rconPort isn't an integer in [1024, 65535]. Same
   * refuse-don't-coerce reasoning as INVALID_SERVER_PORT above. */
  INVALID_RCON_PORT: "INVALID_RCON_PORT",
  /** server/routes/server.js (2 sites: /install, /quick-setup) -- minMemory
   * isn't an integer in [1, 64] (GB). Refused rather than coerced: unlike a
   * port, a silently-substituted memory value doesn't break connectivity,
   * but it's still the operator's explicit input being discarded without a
   * word -- see 2026-08-23 validateInt-coerces audit. */
  INVALID_MIN_MEMORY: "INVALID_MIN_MEMORY",
  /** server/routes/server.js (2 sites: /install, /quick-setup) -- maxMemory
   * isn't an integer in [1, 128] (GB). Same reasoning as INVALID_MIN_MEMORY
   * above. */
  INVALID_MAX_MEMORY: "INVALID_MAX_MEMORY",
  /** server/routes/server.js -- formatWritablePathError(), 4 call sites
   * across /install and /quick-setup (installPath, then the Zomboid data
   * folder). The underlying message has two English-only variants (bare-metal
   * vs Docker-detected) composed by formatWritablePathError() itself; the
   * locale text below covers the common non-container wording only -- the
   * Docker-specific addendum stays English-only in the `error` fallback
   * text, a known partial-translation gap, not a bug. */
  WRITABLE_PATH_ERROR: "WRITABLE_PATH_ERROR",
  /** server/routes/server.js (2 sites: /install, /steam-update) -- steamcmd
   * executable missing on Windows (no auto-download there). */
  STEAMCMD_NOT_FOUND_AT_PATH: "STEAMCMD_NOT_FOUND_AT_PATH",
  /** server/routes/server.js (2 sites: /install, /steam-update) -- Linux
   * auto-download of steamcmd (ensureSteamCmdLinux) itself failed. */
  STEAMCMD_AUTO_DOWNLOAD_FAILED: "STEAMCMD_AUTO_DOWNLOAD_FAILED",
  /** server/routes/server.js -- POST /api/server/install, another Steam
   * operation already running for this install path. Own code from the
   * /steam-update variant below -- "for this path" vs "for this server" are
   * different wordings kept separate, not merged. */
  STEAM_OPERATION_IN_PROGRESS_PATH: "STEAM_OPERATION_IN_PROGRESS_PATH",
  /** server/routes/server.js -- POST /api/server/quick-setup, missing
   * installPath/serverName. */
  QUICK_SETUP_MISSING_FIELDS: "QUICK_SETUP_MISSING_FIELDS",
  /** server/routes/server.js -- POST /api/server/quick-setup, none of the
   * expected PZ server marker files/folders found at installPath. */
  QUICK_SETUP_SERVER_FILES_NOT_FOUND: "QUICK_SETUP_SERVER_FILES_NOT_FOUND",
  /** server/routes/server.js -- POST /api/server/configure-rcon, no
   * rconPassword in the body. Own code from rcon.js's RCON_* codes -- this
   * is the server-config route, not the live rcon.js connection routes. */
  CONFIGURE_RCON_PASSWORD_REQUIRED: "CONFIGURE_RCON_PASSWORD_REQUIRED",
  /** server/routes/server.js (2 sites: /configure-rcon, /configure-network) --
   * no serverConfigPath resolved (install never run). */
  SERVER_CONFIG_PATH_NOT_SET: "SERVER_CONFIG_PATH_NOT_SET",
  /** server/routes/server.js (2 sites: /configure-rcon, /configure-network) --
   * serverConfigPath resolved but the .ini file doesn't exist yet. */
  SERVER_CONFIG_FILE_NOT_FOUND: "SERVER_CONFIG_FILE_NOT_FOUND",
  /** server/routes/server.js -- POST /api/server/reloadlua, no filename. */
  RELOAD_LUA_FILENAME_REQUIRED: "RELOAD_LUA_FILENAME_REQUIRED",
  /** server/routes/server.js -- POST /api/server/reloadlua, filename fails
   * the .lua path-traversal-safe format check. */
  RELOAD_LUA_INVALID_FILENAME: "RELOAD_LUA_INVALID_FILENAME",
  /** server/routes/server.js -- POST /api/server/log, missing type or level. */
  LOG_TYPE_LEVEL_REQUIRED: "LOG_TYPE_LEVEL_REQUIRED",
  /** server/routes/server.js -- POST /api/server/log, `type` not in the
   * known PZ log-type list. */
  LOG_INVALID_TYPE: "LOG_INVALID_TYPE",
  /** server/routes/server.js -- POST /api/server/log, `level` not in the
   * known PZ log-level list. */
  LOG_INVALID_LEVEL: "LOG_INVALID_LEVEL",
  /** server/routes/server.js -- POST /api/server/stats, no mode. */
  STATS_MODE_REQUIRED: "STATS_MODE_REQUIRED",
  /** server/routes/server.js -- POST /api/server/stats, `mode` not one of
   * none/file/console/all. */
  STATS_INVALID_MODE: "STATS_INVALID_MODE",
  /** server/routes/server.js -- POST /api/server/steam-update, missing
   * steamcmdPath/installPath. */
  STEAM_UPDATE_MISSING_FIELDS: "STEAM_UPDATE_MISSING_FIELDS",
  /** server/routes/server.js -- POST /api/server/steam-update, the target
   * server process is currently running. */
  STEAM_UPDATE_SERVER_RUNNING: "STEAM_UPDATE_SERVER_RUNNING",
  /** server/routes/server.js -- POST /api/server/steam-update, another Steam
   * operation already running for this server. See STEAM_OPERATION_IN_
   * PROGRESS_PATH above for why this stays a separate code. */
  STEAM_OPERATION_IN_PROGRESS_SERVER: "STEAM_OPERATION_IN_PROGRESS_SERVER",
  /** server/routes/server.js -- POST /api/server/steamcmd/download,
   * installPath fails isValidPath(). Own wording ("installation path") from
   * INSTALL_PATH_INVALID/STEAMCMD_PATH_INVALID above -- different route,
   * different phrasing. */
  STEAMCMD_DOWNLOAD_INVALID_PATH: "STEAMCMD_DOWNLOAD_INVALID_PATH",
  /** server/routes/server.js (4 sites: /delete-files x2, /list-directory,
   * /wipe) -- a path argument fails isValidPath() or a post-normalize `..`
   * check. All four sites emit the bare, already-generic "Invalid path"
   * with no route-specific detail to lose, so they share one code. */
  INVALID_PATH: "INVALID_PATH",
  /** server/routes/server.js (2 sites: /delete-files, /list-directory) --
   * fs.existsSync() false for the given path. */
  PATH_NOT_FOUND: "PATH_NOT_FOUND",
  /** server/routes/server.js -- POST /api/server/delete-files, path exists
   * but none of the known PZ server marker files are present -- refusing to
   * delete a folder that might not be a PZ install. */
  DELETE_FILES_NOT_PZ_INSTALL: "DELETE_FILES_NOT_PZ_INSTALL",
  /** server/routes/server.js -- POST /api/server/delete-files, the active
   * server's zomboidDataPath is inside (or equal to) the install folder
   * being deleted -- deleting it would also destroy the world save, not
   * just the reinstallable game binaries. Refused outright rather than
   * backing the data up first: the backups folder lives inside the same
   * doomed tree. */
  DELETE_FILES_DATA_PATH_NESTED: "DELETE_FILES_DATA_PATH_NESTED",
  /** server/routes/server.js -- POST /api/server/delete-files. The prior
   * safety check here (hasPzInstallMarker) only confirmed a handful of
   * marker FILENAMES exist in the target directory -- trivially satisfied
   * by creating an empty file with one of those names anywhere on the host,
   * not an authorization check (bug-hunt-2026-08-27, filed alongside the
   * server.wipe capability-description undersell it made real). Both real
   * callers (Servers.tsx's "Delete Everything" and "Clear Install Folder")
   * only ever pass a path already sitting in a configured server record's
   * own installPath -- so deletePath is now required to exactly match one,
   * turning "any directory with a spoofable marker file" into "must be a
   * server the panel already has on record" (which itself requires
   * servers.manage to create, a capability distinct from server.wipe). The
   * marker check stays as a second, narrower layer on top, not a
   * replacement. */
  DELETE_FILES_NOT_CONFIGURED_SERVER: "DELETE_FILES_NOT_CONFIGURED_SERVER",
  /** server/routes/server.js -- POST /api/server/delete-files, caller didn't
   * pass `confirm: true`. Split from WIPE_CONFIRM_REQUIRED below (2026-08-26
   * bug hunt round 2, Angela's find) rather than continuing to share it: that
   * code's own name and message ("Wipe requires confirm: true") are correct
   * for /wipe, and /delete-files was the borrower, not a co-owner -- unlike
   * WIPE_SERVER_RUNNING two entries below, which genuinely IS shared by
   * design (see that entry's own comment for why the two cases differ). The
   * risk with the shared version wasn't hypothetical: api.ts hardcodes
   * confirm:true for both of today's callers so the branch can't fire from
   * the UI right now, but that's a precondition of the CURRENT client, not a
   * property of the code -- the first caller that doesn't hardcode it would
   * get an error about wiping when they were deleting files, or the reverse.
   * Same anti-pattern already fixed for WRITABLE_PATH_ERROR and
   * RCON_CONNECT_FAILED (see KNOWN_INTENTIONALLY_UNREFERENCED in
   * server/tests/errorCodeRegistry.test.js for that pattern's write-up) --
   * unlike those two, WIPE_CONFIRM_REQUIRED is NOT retired here: it keeps
   * being correctly emitted by /wipe, so it stays in active use rather than
   * moving to that allowlist. */
  DELETE_FILES_CONFIRM_REQUIRED: "DELETE_FILES_CONFIRM_REQUIRED",
  /** server/routes/server.js -- POST /api/server/list-directory, path exists
   * but isn't a directory. */
  PATH_NOT_A_DIRECTORY: "PATH_NOT_A_DIRECTORY",
  /** server/routes/server.js -- POST /api/server/list-directory,
   * fs.readdirSync() threw (permissions). Message embeds an OS error code
   * and a platform-specific English guidance sentence composed at the call
   * site -- the locale text below covers the fixed frame around them;
   * {{guidance}} itself stays English, same known gap as WRITABLE_PATH_ERROR
   * above. */
  DIRECTORY_READ_FAILED: "DIRECTORY_READ_FAILED",
  /** server/routes/server.js -- POST /api/server/browse-folder, `description`
   * fails its alphanumeric/punctuation format check. */
  BROWSE_FOLDER_INVALID_DESCRIPTION: "BROWSE_FOLDER_INVALID_DESCRIPTION",
  /** server/routes/server.js -- POST /api/server/browse-folder (Linux), no
   * GUI file-picker (zenity/kdialog) available. */
  BROWSE_FOLDER_NO_DIALOG_AVAILABLE: "BROWSE_FOLDER_NO_DIALOG_AVAILABLE",
  /** server/routes/server.js -- POST /api/server/browse-folder (Windows),
   * the PowerShell folder-browser process itself errored. */
  BROWSE_FOLDER_OPEN_FAILED: "BROWSE_FOLDER_OPEN_FAILED",
  /** server/routes/server.js (3 sites: /console-log, /console-log/stream,
   * /console-log/clear) -- no zomboidDataPath resolved anywhere (active
   * server, settings, or serverPath fallback). */
  SERVER_DATA_PATH_NOT_CONFIGURED: "SERVER_DATA_PATH_NOT_CONFIGURED",
  /** server/routes/server.js (3 sites: /update-check, /update-check/status,
   * /update-check/interval) -- app.get("updateChecker") not registered. */
  UPDATE_CHECKER_NOT_AVAILABLE: "UPDATE_CHECKER_NOT_AVAILABLE",
  /** server/routes/server.js -- GET /api/server/update-check?force=true,
   * checkForUpdates() resolved falsy. */
  UPDATE_CHECK_NO_RESULT: "UPDATE_CHECK_NO_RESULT",
  /** server/routes/server.js -- POST /api/server/update-check/interval,
   * `minutes` missing or not a number. */
  UPDATE_CHECK_INTERVAL_INVALID: "UPDATE_CHECK_INTERVAL_INVALID",
  /** server/routes/server.js (2 sites: /wipe/preview, /wipe) -- `targets`
   * missing/empty/not an array. Identical wording both sites, shared code. */
  WIPE_TARGETS_REQUIRED: "WIPE_TARGETS_REQUIRED",
  /** server/routes/server.js -- POST /api/server/wipe/preview, `targets`
   * contains an unrecognized value. Own code from WIPE_INVALID_TARGETS below
   * -- the preview route's message additionally lists the allowed values,
   * the execute route's does not; different wording, kept separate rather
   * than flattened to one. */
  WIPE_PREVIEW_INVALID_TARGETS: "WIPE_PREVIEW_INVALID_TARGETS",
  /** server/routes/server.js -- POST /api/server/wipe, `targets` contains an
   * unrecognized value. See WIPE_PREVIEW_INVALID_TARGETS above for why this
   * is a separate code rather than reused. */
  WIPE_INVALID_TARGETS: "WIPE_INVALID_TARGETS",
  /** server/routes/server.js (2 sites: /wipe/preview, /wipe) -- serverManager
   * has no savePath configured. */
  WIPE_ZOMBOID_DATA_PATH_NOT_CONFIGURED: "WIPE_ZOMBOID_DATA_PATH_NOT_CONFIGURED",
  /** server/routes/server.js (2 sites: /wipe/preview, /wipe) -- the
   * configured server name contains a path separator. Distinct from
   * SERVER_NAME_FORMAT_INVALID above (that one validates a *submitted* name
   * against the full format rule at install time; this one is a bare
   * traversal guard on the *already-configured* name). */
  WIPE_INVALID_SERVER_NAME: "WIPE_INVALID_SERVER_NAME",
  /** server/routes/server.js (2 sites: /wipe/preview, /wipe) -- the resolved
   * Saves/Multiplayer/<serverName> directory doesn't exist. */
  WIPE_SAVE_DIRECTORY_NOT_FOUND: "WIPE_SAVE_DIRECTORY_NOT_FOUND",
  /** server/routes/server.js -- POST /api/server/wipe, another wipe is
   * already running (module-level guard). */
  WIPE_IN_PROGRESS: "WIPE_IN_PROGRESS",
  /** server/routes/server.js (2 sites: /wipe, /delete-files) -- the server
   * process is currently running (both routes require it stopped first).
   * Shared rather than a DELETE_FILES_-prefixed twin: two endpoints doing
   * the same dangerous thing to files the game may hold open refuse in the
   * same code, even though delete-files writes its own delete-flavored
   * `error` text at the call site rather than reusing wipe's wording. */
  WIPE_SERVER_RUNNING: "WIPE_SERVER_RUNNING",
  /** server/routes/server.js -- POST /api/server/wipe, caller didn't pass
   * `confirm: true`. /delete-files used to share this code too (own English
   * text, same code) -- split out as DELETE_FILES_CONFIRM_REQUIRED above
   * (2026-08-26 bug hunt round 2): unlike WIPE_SERVER_RUNNING above, which
   * really is one condition meaning the same thing at both call sites,
   * "confirm required" here was never a shared concept, just a borrowed
   * code -- this one stays exactly what its name always said, /wipe's own. */
  WIPE_CONFIRM_REQUIRED: "WIPE_CONFIRM_REQUIRED",
  /** server/routes/server.js -- POST /api/server/wipe, `createBackup` was
   * true (the default) but the pre-wipe backup itself failed (backup
   * service unavailable, or backupService.createBackup()/the accounts-db
   * copy rejected). The wipe is aborted before any deletion runs -- fail
   * closed, same reasoning as restoreBackup()'s mandatory pre-restore
   * backup: proceeding after a failed backup is worse than not offering
   * one, since the operator now believes an undo exists. */
  WIPE_BACKUP_FAILED: "WIPE_BACKUP_FAILED",
  /** server/routes/server.js -- POST /wipe, the backup succeeded and
   * deletion began, but one of the per-target delete steps (map dirs,
   * leftovers-sweep, accounts db) threw partway through -- e.g. an EPERM
   * on one file in a multi-directory delete. The players/world steps
   * already catch their own errors and record "not found" instead of
   * crashing; map/leftovers/accounts did not, so a mid-loop throw used to
   * reach the outer catch and return a bare `{error}` with no indication
   * of which targets partially completed or that a pre-wipe backup exists
   * to recover from. 2026-08-26, partial-failure-state hunt. Carries the
   * partial `results` object (same shape as a successful wipe's) plus
   * `backupCreated`/`backupName` so the operator isn't left guessing
   * whether an undo exists. Params: {reason}. */
  WIPE_PARTIAL_FAILURE: "WIPE_PARTIAL_FAILURE",

  /** server/routes/chunks.js -- POST /save-path, no `path` string in the body. */
  CHUNKS_SAVE_PATH_MISSING: "CHUNKS_SAVE_PATH_MISSING",
  /** server/routes/chunks.js -- POST /save-path, the validated path resolved
   * to an empty string after normalization. */
  CHUNKS_SAVE_PATH_EMPTY: "CHUNKS_SAVE_PATH_EMPTY",
  /** server/routes/chunks.js -- POST /save-path, the submitted path would
   * actually CHANGE the active server's zomboidDataPath and the caller
   * holds chunks.manage but not server.configure. Repointing a server's
   * entire data path (RCON credentials and every server-scoped file
   * included) is server.configure's territory, not just chunk cleanup. */
  CHUNKS_SAVE_PATH_CAPABILITY_REQUIRED: "CHUNKS_SAVE_PATH_CAPABILITY_REQUIRED",
  /** server/routes/chunks.js (4 sites: GET /chunks/:saveName, POST
   * /delete-chunks, POST /delete-region, GET /stats/:saveName) -- :saveName
   * fails the path.basename() round-trip check. Identical wording/meaning
   * all four, shared code. */
  CHUNKS_INVALID_SAVE_NAME: "CHUNKS_INVALID_SAVE_NAME",
  /** server/routes/chunks.js (4 sites: GET /chunks/:saveName, POST
   * /delete-chunks, POST /delete-region, GET /stats/:saveName) -- no
   * zomboidDataPath resolved (active server, custom path, or legacy
   * setting). Identical wording/meaning all four, shared code. Distinct
   * from BROWSE_CHUNKS_DATA_PATH_NOT_SET below (GET /browse's own wording,
   * kept separate). */
  CHUNKS_DATA_PATH_NOT_SET: "CHUNKS_DATA_PATH_NOT_SET",
  /** server/routes/chunks.js -- POST /delete-chunks, `saveName` missing or
   * `chunks` missing/not an array/empty. */
  DELETE_CHUNKS_FIELDS_REQUIRED: "DELETE_CHUNKS_FIELDS_REQUIRED",
  /** server/routes/chunks.js -- POST /delete-chunks, `chunks.length` exceeds
   * the 100,000 request cap. Sends `{ count: chunks.length }`. */
  DELETE_CHUNKS_TOO_MANY: "DELETE_CHUNKS_TOO_MANY",
  /** server/routes/chunks.js -- POST /delete-chunks, a chunk entry has no
   * `file`. */
  DELETE_CHUNKS_INVALID_FILE_NAME: "DELETE_CHUNKS_INVALID_FILE_NAME",
  /** server/routes/chunks.js -- POST /delete-chunks, a chunk's `file`
   * normalizes to an absolute path or contains "..". */
  DELETE_CHUNKS_INVALID_FILE_PATH: "DELETE_CHUNKS_INVALID_FILE_PATH",
  /** server/routes/chunks.js -- POST /delete-chunks, a chunk's `x` isn't a
   * finite integer. */
  DELETE_CHUNKS_INVALID_X: "DELETE_CHUNKS_INVALID_X",
  /** server/routes/chunks.js -- POST /delete-chunks, a chunk's `y` isn't a
   * finite integer. */
  DELETE_CHUNKS_INVALID_Y: "DELETE_CHUNKS_INVALID_Y",
  /** server/routes/chunks.js (3 sites: POST /delete-chunks, POST
   * /delete-region, GET /stats/:saveName) -- the resolved save directory
   * doesn't exist. Identical wording/meaning all three, shared code. */
  CHUNKS_SAVE_NOT_FOUND: "CHUNKS_SAVE_NOT_FOUND",
  /** server/routes/chunks.js -- POST /delete-region, `saveName` missing or
   * one of minX/maxX/minY/maxY missing. */
  DELETE_REGION_FIELDS_REQUIRED: "DELETE_REGION_FIELDS_REQUIRED",
  /** server/routes/chunks.js -- POST /delete-region, a bound isn't a finite
   * number. */
  DELETE_REGION_BOUNDS_NOT_FINITE: "DELETE_REGION_BOUNDS_NOT_FINITE",
  /** server/routes/chunks.js -- POST /delete-region, minX > maxX or
   * minY > maxY. */
  DELETE_REGION_BOUNDS_INVERTED: "DELETE_REGION_BOUNDS_INVERTED",
  /** server/routes/chunks.js -- POST /delete-region, the matched chunk count
   * exceeds the 100,000 cap. Sends `{ count: chunksToDelete.length }`, same
   * shape as DELETE_CHUNKS_TOO_MANY above. */
  DELETE_REGION_TOO_LARGE: "DELETE_REGION_TOO_LARGE",
  /** server/routes/chunks.js -- GET /browse, no zomboidDataPath configured.
   * Own wording ("configured to browse") from CHUNKS_DATA_PATH_NOT_SET
   * above -- kept separate rather than merged. */
  BROWSE_CHUNKS_DATA_PATH_NOT_SET: "BROWSE_CHUNKS_DATA_PATH_NOT_SET",
  /** server/routes/chunks.js -- GET /browse, confineToRoots() rejected the
   * requested path. Own wording ("the server's save directory") from
   * serverFiles.js's BROWSE_ACCESS_DENIED -- different file, different
   * phrasing, own code. */
  BROWSE_CHUNKS_ACCESS_DENIED: "BROWSE_CHUNKS_ACCESS_DENIED",
  /** server/routes/chunks.js -- GET /browse, resolved path doesn't exist. */
  BROWSE_CHUNKS_PATH_NOT_FOUND: "BROWSE_CHUNKS_PATH_NOT_FOUND",
  /** server/routes/chunks.js -- GET /browse, resolved path exists but isn't
   * a directory. */
  BROWSE_CHUNKS_PATH_NOT_DIRECTORY: "BROWSE_CHUNKS_PATH_NOT_DIRECTORY",

  /** server/routes/mods.js -- POST /add-mod-advanced, neither selectedModIds nor includeAllModIds given. */
  MODS_ADD_ADVANCED_SELECTION_REQUIRED: "MODS_ADD_ADVANCED_SELECTION_REQUIRED",
  /** server/routes/mods.js -- POST /add-all-resolved-deps, `deps` missing/empty/not an array. */
  MODS_ADD_ALL_DEPS_REQUIRED: "MODS_ADD_ALL_DEPS_REQUIRED",
  /** server/routes/mods.js -- POST /add-all-resolved-deps, deps.length exceeds 200. */
  MODS_ADD_ALL_DEPS_TOO_MANY: "MODS_ADD_ALL_DEPS_TOO_MANY",
  /** server/routes/mods.js -- POST /add-missing-dep, workshopId missing or fails /^\d{1,15}$/. */
  MODS_ADD_MISSING_DEP_WORKSHOP_ID_REQUIRED: "MODS_ADD_MISSING_DEP_WORKSHOP_ID_REQUIRED",
  /** server/routes/mods.js -- POST /add-to-ini, serverConfigPath unresolved. Own wording ("...in
   * Settings.") from MODS_CONFIG_PATH_NOT_SET_GUIDANCE above -- kept separate. */
  MODS_ADD_TO_INI_CONFIG_PATH_NOT_SET: "MODS_ADD_TO_INI_CONFIG_PATH_NOT_SET",
  /** server/routes/mods.js -- POST /auto-restart, `enabled` not a boolean. */
  MODS_AUTO_RESTART_ENABLED_REQUIRED: "MODS_AUTO_RESTART_ENABLED_REQUIRED",
  /** server/routes/mods.js -- POST /batch-remove, iniEditApplied came back false from the batch removal
   * helper -- own wording ("...no mods were removed."), a 200-status response
   * with success:iniEditApplied and this error attached. Distinct from
   * MODS_INI_NOT_ACCESSIBLE and MODS_PURGE_INI_NOT_ACCESSIBLE below -- three
   * different call sites' own phrasing for the same underlying condition, kept
   * separate per the createBackup()-style rule (don't collapse distinguishable
   * outcomes into one shared code just because the cause is the same). */
  MODS_BATCH_REMOVE_INI_NOT_ACCESSIBLE: "MODS_BATCH_REMOVE_INI_NOT_ACCESSIBLE",
  /** server/routes/mods.js -- POST /batch-remove, workshopIds.length exceeds 500. */
  MODS_BATCH_REMOVE_TOO_MANY: "MODS_BATCH_REMOVE_TOO_MANY",
  /** server/routes/mods.js -- POST /batch-remove, `workshopIds` missing/empty/not an array. */
  MODS_BATCH_REMOVE_WORKSHOP_IDS_ARRAY_REQUIRED: "MODS_BATCH_REMOVE_WORKSHOP_IDS_ARRAY_REQUIRED",
  /** server/routes/mods.js -- POST /batch-toggle-mod-ids, `changes` missing/empty/not an array. */
  MODS_BATCH_TOGGLE_CHANGES_REQUIRED: "MODS_BATCH_TOGGLE_CHANGES_REQUIRED",
  /** server/routes/mods.js -- POST /batch-toggle-mod-ids, a change entry's enabled isn't a boolean. */
  MODS_BATCH_TOGGLE_ENABLED_BOOLEAN_REQUIRED: "MODS_BATCH_TOGGLE_ENABLED_BOOLEAN_REQUIRED",
  /** server/routes/mods.js -- POST /batch-toggle-mod-ids, a change entry's modId isn't a string. */
  MODS_BATCH_TOGGLE_MODID_STRING_REQUIRED: "MODS_BATCH_TOGGLE_MODID_STRING_REQUIRED",
  /** server/routes/mods.js -- POST /batch-toggle-mod-ids, changes.length exceeds 500. */
  MODS_BATCH_TOGGLE_TOO_MANY: "MODS_BATCH_TOGGLE_TOO_MANY",
  /** server/routes/mods.js -- POST /batch-toggle-mod-ids, one or more ENABLEs target workshop-ID-shaped
   * modIds. Sends `{ count: badEnables.length }` -- the locale text
   * approximates the plural the way ROLE_HAS_MEMBERS does elsewhere in this
   * file (a fixed "(s)"-style suffix, not real i18next pluralization). The
   * English fallback `error` string keeps its own manual singular/plural
   * suffix independently -- unaffected, still English-only, not this
   * code's locale-resolution path. */
  MODS_BATCH_TOGGLE_WORKSHOP_ID_IN_MODS: "MODS_BATCH_TOGGLE_WORKSHOP_ID_IN_MODS",
  /** server/routes/mods.js -- POST /check-interval, intervalMs not a whole number of minutes in [60000,
   * 7200000]. Own wording ("Interval") from
   * MODS_RESTART_CHECK_INTERVAL_INVALID below (that route's field is named
   * checkInterval) -- kept separate. */
  MODS_CHECK_INTERVAL_INVALID: "MODS_CHECK_INTERVAL_INVALID",
  /** server/routes/mods.js -- (4 sites: POST/DELETE /collection/items(+/:id), /collection/sync,
   * /collection/test) -- workshopCollectionId setting not set. Identical
   * wording, shared code. */
  MODS_COLLECTION_ID_NOT_CONFIGURED: "MODS_COLLECTION_ID_NOT_CONFIGURED",
  /** server/routes/mods.js -- (9 sites incl. the GET /current-config 200-status `configured:false`
   * shape) -- resolved .ini path doesn't exist, bare wording (no guidance).
   * Identical wording everywhere, shared code. */
  MODS_CONFIG_FILE_NOT_FOUND: "MODS_CONFIG_FILE_NOT_FOUND",
  /** server/routes/mods.js -- (2 sites: POST /write-to-ini, POST /add-to-ini) -- resolved .ini path
   * doesn't exist, with "start the server once" guidance. Identical wording
   * both sites, shared code. Distinct from the bare MODS_CONFIG_FILE_NOT_FOUND
   * below (no guidance sentence). */
  MODS_CONFIG_FILE_NOT_FOUND_GUIDANCE: "MODS_CONFIG_FILE_NOT_FOUND_GUIDANCE",
  /** server/routes/mods.js -- (2 sites) -- "Server config file not found." with a trailing period,
   * distinct literal from the bare MODS_CONFIG_FILE_NOT_FOUND above (no
   * period). Identical wording both sites, shared code. */
  MODS_CONFIG_FILE_NOT_FOUND_PERIOD: "MODS_CONFIG_FILE_NOT_FOUND_PERIOD",
  /** server/routes/mods.js -- (10 sites incl. the GET /current-config 200-status `configured:false`
   * shape) -- serverConfigPath unresolved, bare wording. Identical wording
   * everywhere, shared code. */
  MODS_CONFIG_PATH_NOT_SET: "MODS_CONFIG_PATH_NOT_SET",
  /** server/routes/mods.js -- (2 sites: POST /write-to-ini, and the sync-from-server success:false path
   * shares this exact wording) -- serverConfigPath unresolved. Own wording
   * ("Please configure the server first.", no "in Settings") from
   * MODS_ADD_TO_INI_CONFIG_PATH_NOT_SET and MODS_CONFIG_PATH_NOT_SET below --
   * kept separate per call site's own phrasing. */
  MODS_CONFIG_PATH_NOT_SET_GUIDANCE: "MODS_CONFIG_PATH_NOT_SET_GUIDANCE",
  /** server/routes/mods.js -- GET /conflicts/diff, one or both mods' copies of the file weren't found on
   * disk. */
  MODS_CONFLICTS_DIFF_FILES_NOT_FOUND: "MODS_CONFLICTS_DIFF_FILES_NOT_FOUND",
  /** server/routes/mods.js -- GET /conflicts/diff, modA/modB fail the safe-character regex. */
  MODS_CONFLICTS_DIFF_MOD_ID_INVALID: "MODS_CONFLICTS_DIFF_MOD_ID_INVALID",
  /** server/routes/mods.js -- GET /conflicts/diff, file/modA/modB query params missing. */
  MODS_CONFLICTS_DIFF_PARAMS_REQUIRED: "MODS_CONFLICTS_DIFF_PARAMS_REQUIRED",
  /** server/routes/mods.js -- GET /conflicts/diff, `file` looks like a path-traversal attempt or exceeds
   * 500 chars. */
  MODS_CONFLICTS_DIFF_PATH_INVALID: "MODS_CONFLICTS_DIFF_PATH_INVALID",
  /** server/routes/mods.js -- (2 sites: GET /conflicts, GET /conflicts/stream) -- acquireScanLock()
   * failed, another scan is running. Identical wording, shared code. */
  MODS_CONFLICT_SCAN_ALREADY_RUNNING: "MODS_CONFLICT_SCAN_ALREADY_RUNNING",
  /** server/routes/mods.js -- POST /discover-mod-ids, neither workshopId nor a parseable workshopUrl
   * given. */
  MODS_DISCOVER_WORKSHOP_ID_OR_URL_REQUIRED: "MODS_DISCOVER_WORKSHOP_ID_OR_URL_REQUIRED",
  /** server/routes/mods.js -- POST /collection/extension-push, cookie value contains
   * CR/LF/NUL/semicolon. */
  MODS_EXTENSION_COOKIES_CONTROL_CHARS: "MODS_EXTENSION_COOKIES_CONTROL_CHARS",
  /** server/routes/mods.js -- POST /collection/extension-push, sessionid/steamLoginSecure missing. */
  MODS_EXTENSION_COOKIES_REQUIRED: "MODS_EXTENSION_COOKIES_REQUIRED",
  /** server/routes/mods.js -- POST /collection/extension-push, cookie value exceeds 4096 chars. */
  MODS_EXTENSION_COOKIES_TOO_LONG: "MODS_EXTENSION_COOKIES_TOO_LONG",
  /** server/routes/mods.js -- GET /collection/extension-bundle, neither a prebuilt zip nor the
   * browser-extension/ source folder exists on this install. */
  MODS_EXTENSION_FILES_MISSING: "MODS_EXTENSION_FILES_MISSING",
  /** server/routes/mods.js -- POST /get-mod-info, Steam's GetPublishedFileDetails returned result !== 1. */
  MODS_GET_MOD_INFO_NOT_FOUND: "MODS_GET_MOD_INFO_NOT_FOUND",
  /** server/routes/mods.js -- DELETE /ignored-pairs, modIdA/modIdB missing or fail MOD_ID_RE. Own
   * wording from MODS_IGNORED_PAIR_INVALID_IDS above (POST route's fuller
   * message) -- kept separate. */
  MODS_IGNORED_PAIR_IDS_REQUIRED: "MODS_IGNORED_PAIR_IDS_REQUIRED",
  /** server/routes/mods.js -- POST /ignored-pairs, addIgnoredModPair() returned falsy. */
  MODS_IGNORED_PAIR_INVALID: "MODS_IGNORED_PAIR_INVALID",
  /** server/routes/mods.js -- POST /ignored-pairs, modIdA/modIdB missing or fail MOD_ID_RE. */
  MODS_IGNORED_PAIR_INVALID_IDS: "MODS_IGNORED_PAIR_INVALID_IDS",
  /** server/routes/mods.js -- DELETE /ignored-pairs, no matching row to remove. */
  MODS_IGNORED_PAIR_NOT_FOUND: "MODS_IGNORED_PAIR_NOT_FOUND",
  /** server/routes/mods.js -- POST /ignored-pairs, modIdA === modIdB. */
  MODS_IGNORED_PAIR_SAME_ID: "MODS_IGNORED_PAIR_SAME_ID",
  /** server/routes/mods.js -- DELETE /ignored/:workshopId, no ignore-list row for that id. */
  MODS_IGNORE_ENTRY_NOT_FOUND: "MODS_IGNORE_ENTRY_NOT_FOUND",
  /** server/routes/mods.js -- POST /import-collection, extracted collection id fails /^\d{1,15}$/. */
  MODS_IMPORT_COLLECTION_ID_INVALID: "MODS_IMPORT_COLLECTION_ID_INVALID",
  /** server/routes/mods.js -- POST /import-collection, Steam returned no collectiondetails entry. */
  MODS_IMPORT_COLLECTION_NOT_FOUND: "MODS_IMPORT_COLLECTION_NOT_FOUND",
  /** server/routes/mods.js -- POST /import-collection, collection.result !== 1 (private or deleted). */
  MODS_IMPORT_COLLECTION_PRIVATE: "MODS_IMPORT_COLLECTION_PRIVATE",
  /** server/routes/mods.js -- POST /import-collection, the Steam GetCollectionDetails fetch aborted
   * after 10s. */
  MODS_IMPORT_COLLECTION_TIMEOUT: "MODS_IMPORT_COLLECTION_TIMEOUT",
  /** server/routes/mods.js -- POST /import-collection, no collectionUrl. */
  MODS_IMPORT_COLLECTION_URL_REQUIRED: "MODS_IMPORT_COLLECTION_URL_REQUIRED",
  /** server/routes/mods.js -- (2 sites: POST /delete-disk-mod, POST /batch-delete-disk-mods) --
   * deleteModFromDiskAndIni()'s iniEditApplied came back false. Identical bare
   * wording both sites, shared code. Distinct from
   * MODS_BATCH_REMOVE_INI_NOT_ACCESSIBLE and MODS_PURGE_INI_NOT_ACCESSIBLE --
   * see the note on that code for why these three stay separate. NOT shared
   * with the internal `error` field deleteModFromDiskAndIni() itself returns
   * on its object (server/routes/mods.js ~line 7519 as of this commit) -- that
   * field is dead: no caller ever reads result.error, so it carries no code
   * and isn't part of this conversion. */
  MODS_INI_NOT_ACCESSIBLE: "MODS_INI_NOT_ACCESSIBLE",
  /** server/routes/mods.js -- POST /collection/extract-cookies, `browser` not one of the allowed list.
   * Sends `{ browsers: allowed.join(", ") }`. */
  MODS_INVALID_BROWSER: "MODS_INVALID_BROWSER",
  /** server/routes/mods.js -- (2 sites: POST /toggle-mod-id, POST /add-missing-deps) -- modId contains a
   * CR/LF/;/= or exceeds 200 chars. Identical wording, shared code. */
  MODS_INVALID_MOD_ID_FORMAT: "MODS_INVALID_MOD_ID_FORMAT",
  /** server/routes/mods.js -- (2 sites: POST /batch-toggle-mod-ids per-entry validation, POST
   * /apply-preset per-entry validation) -- a submitted modId fails the
   * CR/LF/;/=/length check. Identical template (same prefix + 50-char
   * truncation) both sites, shared code. Sends `{ modId }` (the same
   * 50-char-truncated value embedded in the English message). */
  MODS_INVALID_MOD_ID_FORMAT_TEMPLATE: "MODS_INVALID_MOD_ID_FORMAT_TEMPLATE",
  /** server/routes/mods.js -- (2 sites: PUT /presets/:id, DELETE-ish) -- no :id param. */
  MODS_INVALID_PRESET_ID: "MODS_INVALID_PRESET_ID",
  /** server/routes/mods.js -- (19 sites across nearly every route that resolves an INI path) --
   * configured serverName fails the path.basename() round-trip / ".." check.
   * Identical wording/meaning everywhere, shared code. */
  MODS_INVALID_SERVER_NAME: "MODS_INVALID_SERVER_NAME",
  /** server/routes/mods.js -- (5 sites: POST /add-to-ini, /purge-mod dependents, /discover-mod-ids,
   * /add-mod-advanced, GET /mod-details) -- workshopId fails /^\d{1,15}$/,
   * capitalized wire text "Invalid Workshop ID" (distinct literal from the
   * lower-case MODS_INVALID_WORKSHOP_ID_LOWER above -- both exist verbatim in
   * this file, kept separate rather than normalized). Identical wording across
   * these 5 sites, shared code. */
  MODS_INVALID_WORKSHOP_ID_CAP: "MODS_INVALID_WORKSHOP_ID_CAP",
  /** server/routes/mods.js -- (2 sites: POST /track, /get-mod-info) -- workshopId present but fails
   * /^\d{1,15}$/. Identical wording, shared code. */
  MODS_INVALID_WORKSHOP_ID_FORMAT: "MODS_INVALID_WORKSHOP_ID_FORMAT",
  /** server/routes/mods.js -- (8 sites: DELETE /track/:id, /ignored/:id, /collection/items(+/:id),
   * /collection/tracking/:id, /delete-disk-mod, /purge-mod, GET /mod-details)
   * -- :workshopId param fails /^\d{1,15}$/. Wire value is lower-case
   * "workshop"; kept separate from the capitalized
   * MODS_INVALID_WORKSHOP_ID_CAP variant below since that is genuinely
   * different literal text elsewhere in this file, not a typo to normalize
   * away. */
  MODS_INVALID_WORKSHOP_ID_LOWER: "MODS_INVALID_WORKSHOP_ID_LOWER",
  /** server/routes/mods.js -- (2 sites: POST /write-to-ini per-mod validation, POST /add-missing-deps
   * per-dependency validation) -- a submitted workshopId fails /^\d{1,15}$/.
   * Identical template (same "Invalid Workshop ID: " prefix and 20-char
   * truncation) both sites, shared code. Sends `{ workshopId }` (the same
   * 20-char-truncated value embedded in the English message). */
  MODS_INVALID_WORKSHOP_ID_TEMPLATE: "MODS_INVALID_WORKSHOP_ID_TEMPLATE",
  /** server/routes/mods.js -- (2 sites: PUT /presets/:id modIds field, POST /save-order) -- `modIds`
   * present but not an array. Identical wording, shared code. */
  MODS_MOD_IDS_ARRAY_REQUIRED: "MODS_MOD_IDS_ARRAY_REQUIRED",
  /** server/routes/mods.js -- (3 sites: POST /batch-remove, /batch-delete-disk-mods, /batch-purge) --
   * after filtering to /^\d{1,15}$/, zero ids survived. Identical wording,
   * shared code. */
  MODS_NO_VALID_WORKSHOP_IDS: "MODS_NO_VALID_WORKSHOP_IDS",
  /** server/routes/mods.js -- POST /presets, trimmed name is empty or exceeds 100 chars. */
  MODS_PRESET_NAME_LENGTH_INVALID: "MODS_PRESET_NAME_LENGTH_INVALID",
  /** server/routes/mods.js -- POST /presets, `name` missing or not a string. */
  MODS_PRESET_NAME_REQUIRED: "MODS_PRESET_NAME_REQUIRED",
  /** server/routes/mods.js -- (3 sites: PUT/DELETE /presets/:id, POST /apply-preset) -- no stored preset
   * with that id. Identical wording, shared code. */
  MODS_PRESET_NOT_FOUND: "MODS_PRESET_NOT_FOUND",
  /** server/routes/mods.js -- PUT /presets/:id, trimmed name empty or exceeds 100 chars. Own wording
   * ("name must be...", no "Preset" prefix) from
   * MODS_PRESET_NAME_LENGTH_INVALID above -- kept separate. */
  MODS_PRESET_UPDATE_NAME_LENGTH_INVALID: "MODS_PRESET_UPDATE_NAME_LENGTH_INVALID",
  /** server/routes/mods.js -- PUT /presets/:id, body.name present but not a string. */
  MODS_PRESET_UPDATE_NAME_STRING_REQUIRED: "MODS_PRESET_UPDATE_NAME_STRING_REQUIRED",
  /** server/routes/mods.js -- PUT /presets/:id, body.workshopIds present but not an array. */
  MODS_PRESET_UPDATE_WORKSHOP_IDS_ARRAY: "MODS_PRESET_UPDATE_WORKSHOP_IDS_ARRAY",
  /** server/routes/mods.js -- POST /purge-mod, iniEditApplied came back false -- own wording ("...the
   * mod was not removed from the server."). See
   * MODS_BATCH_REMOVE_INI_NOT_ACCESSIBLE above for why this isn't merged with
   * the other two INI-not-accessible codes. */
  MODS_PURGE_INI_NOT_ACCESSIBLE: "MODS_PURGE_INI_NOT_ACCESSIBLE",
  /** server/routes/mods.js -- POST /resolve-missing-deps, `deps` missing or not an array. Own wording
   * ("Dependencies array") from MODS_ADD_ALL_DEPS_REQUIRED above ("No
   * dependencies provided") -- different route, different phrasing, kept
   * separate. */
  MODS_RESOLVE_DEPS_ARRAY_REQUIRED: "MODS_RESOLVE_DEPS_ARRAY_REQUIRED",
  /** server/routes/mods.js -- PUT /restart-options, checkInterval outside the same 60000-7200000ms range
   * as /check-interval above but through a differently-named field and its own
   * wording -- own code, not merged. */
  MODS_RESTART_CHECK_INTERVAL_INVALID: "MODS_RESTART_CHECK_INTERVAL_INVALID",
  /** server/routes/mods.js -- PUT /restart-options, delayIfPlayersOnline not a boolean. */
  MODS_RESTART_DELAY_IF_PLAYERS_ONLINE_INVALID: "MODS_RESTART_DELAY_IF_PLAYERS_ONLINE_INVALID",
  /** server/routes/mods.js -- PUT /restart-options, maxDelayMinutes outside 0-1440. */
  MODS_RESTART_MAX_DELAY_MINUTES_INVALID: "MODS_RESTART_MAX_DELAY_MINUTES_INVALID",
  /** server/routes/mods.js -- PUT /restart-options, warningMinutes outside 0-1440. */
  MODS_RESTART_WARNING_MINUTES_INVALID: "MODS_RESTART_WARNING_MINUTES_INVALID",
  /** server/routes/mods.js -- POST /save-order, an entry isn't a string or exceeds 200 chars. */
  MODS_SAVE_ORDER_MODID_STRING_REQUIRED: "MODS_SAVE_ORDER_MODID_STRING_REQUIRED",
  /** server/routes/mods.js -- POST /save-order, modIds.length exceeds 2000. */
  MODS_SAVE_ORDER_TOO_MANY: "MODS_SAVE_ORDER_TOO_MANY",
  /** server/routes/mods.js -- POST /search-workshop-mods, query under 2 characters. */
  MODS_SEARCH_QUERY_TOO_SHORT: "MODS_SEARCH_QUERY_TOO_SHORT",
  /** server/routes/mods.js -- (5 sites: POST /presets, POST /apply-preset x2, POST /save-order, GET-ish)
   * -- resolved .ini path doesn't exist. Identical wording across all 5
   * (status code varies 400/404 by route but the text and meaning are
   * identical), shared code. */
  MODS_SERVER_INI_NOT_FOUND: "MODS_SERVER_INI_NOT_FOUND",
  /** server/routes/mods.js -- (3 sites: GET /conflicts, GET /conflicts/stream via SSE `send("error",
   * {...})`, GET /conflicts/diff) -- getServerPath() returned null. Identical
   * wording across all three (including the SSE-shaped one), shared code. */
  MODS_SERVER_INSTALL_PATH_NOT_SET: "MODS_SERVER_INSTALL_PATH_NOT_SET",
  /** server/routes/mods.js -- (3 sites: dependency-resolution routes reading getServerPath()) -- with
   * trailing period, distinct literal from
   * MODS_SERVER_PATH_NOT_CONFIGURED_NOPERIOD above. Identical wording across
   * these 3, shared code. */
  MODS_SERVER_PATH_NOT_CONFIGURED: "MODS_SERVER_PATH_NOT_CONFIGURED",
  /** server/routes/mods.js -- GET /mod-details/:workshopId, getServerPath() returned null. Bare wording,
   * no trailing period -- distinct literal from
   * MODS_SERVER_PATH_NOT_CONFIGURED below (which does have one), kept
   * separate. */
  MODS_SERVER_PATH_NOT_CONFIGURED_NOPERIOD: "MODS_SERVER_PATH_NOT_CONFIGURED_NOPERIOD",
  /** server/routes/mods.js -- POST /start, modChecker.start() returned false. Covers both of its
   * false cases (workshopAcfPath unset, or set but the file doesn't exist on disk) -- same message,
   * same fix (configure a valid install path), so one code for both is correct, not a gap. */
  MODS_START_ACF_PATH_NOT_SET: "MODS_START_ACF_PATH_NOT_SET",
  /** server/routes/mods.js -- POST /collection/test, sessionId/loginSecure not stored. */
  MODS_STEAM_SESSION_COOKIES_NOT_CONFIGURED: "MODS_STEAM_SESSION_COOKIES_NOT_CONFIGURED",
  /** server/routes/mods.js -- POST /toggle-mod-id, `enabled` not a boolean. */
  MODS_TOGGLE_ENABLED_REQUIRED: "MODS_TOGGLE_ENABLED_REQUIRED",
  /** server/routes/mods.js -- POST /toggle-mod-id, no modId. */
  MODS_TOGGLE_MOD_ID_REQUIRED: "MODS_TOGGLE_MOD_ID_REQUIRED",
  /** server/routes/mods.js -- POST /toggle-mod-id, an ENABLE targets a workshop-ID-shaped modId.
   * Singular-toggle counterpart of MODS_BATCH_TOGGLE_WORKSHOP_ID_IN_MODS below
   * -- own wording (this route names the specific ID), kept separate. */
  MODS_TOGGLE_WORKSHOP_ID_IN_MODID: "MODS_TOGGLE_WORKSHOP_ID_IN_MODID",
  /** server/routes/mods.js -- (2 sites: POST /batch-delete-disk-mods, POST /batch-purge) --
   * `workshopIds` missing/empty/not an array. Identical wording, shared code. */
  MODS_WORKSHOP_IDS_ARRAY_REQUIRED: "MODS_WORKSHOP_IDS_ARRAY_REQUIRED",
  /** server/routes/mods.js -- (6 sites: POST /track, /get-mod-info, /add-to-ini, /write-to-ini,
   * /add-mod-advanced, GET-ish helpers) -- no workshopId in the body.
   * Identical wording, shared code. */
  MODS_WORKSHOP_ID_REQUIRED: "MODS_WORKSHOP_ID_REQUIRED",
  /** server/routes/mods.js -- POST /write-to-ini, `mods` missing or not an array. */
  MODS_WRITE_TO_INI_MODS_ARRAY_REQUIRED: "MODS_WRITE_TO_INI_MODS_ARRAY_REQUIRED",
  /** server/routes/mods.js -- getModChecker() helper (many GET/POST routes) -- req.app.get("modChecker")
   * returned nothing. */
  MOD_CHECKER_NOT_INITIALIZED: "MOD_CHECKER_NOT_INITIALIZED",

  // --- legacy: wire value frozen (client compares it with === today),
  //     constant name invented only so a locale key exists ---

  /** server/routes/chunks.js (4 sites) -- wire value "server_running",
   * already compared exactly by client/src/pages/ChunkCleaner.tsx. Do not
   * rename the value. NOT used by server/index.js's Docker-update path any
   * more as of the 2026-08-22 split -- see SERVER_RUNNING_RCON_UNAVAILABLE
   * above for that one; it carries a different, more specific reason and
   * was deliberately given its own code rather than reusing this one. */
  SERVER_RUNNING_LEGACY: "server_running",
  /** server/services/dockerUpdateProxy.js -- Docker update controller not configured. */
  DOCKER_UPDATER_NOT_CONFIGURED_LEGACY: "docker_updater_not_configured",
  /** server/services/dockerUpdateProxy.js, server/services/panelUpdateChecker.js,
   * server/index.js -- wire value "apply_in_progress", already compared
   * exactly by client/src/pages/Settings.tsx. Do not rename the value. */
  APPLY_IN_PROGRESS_LEGACY: "apply_in_progress",
  /** server/services/panelUpdateChecker.js -- downloadUpdate() called while
   * a download is already running. */
  ALREADY_DOWNLOADING_LEGACY: "already_downloading",
  /** server/services/panelUpdateChecker.js -- downloadUpdate() called with
   * nothing new to download. */
  NO_UPDATE_LEGACY: "no_update",
  /** server/index.js -- Docker-update apply path, caller didn't pass
   * `confirm: true`. */
  CONFIRMATION_REQUIRED_LEGACY: "confirmation_required",
  /** server/index.js -- Docker-update apply path, world save failed before
   * shutdown. */
  SAVE_FAILED_LEGACY: "save_failed",
  /** server/index.js -- Docker-update apply path, server wouldn't shut down. */
  STOP_FAILED_LEGACY: "stop_failed",

  // --- server/routes/panelBridge.js ---

  /** server/routes/panelBridge.js (many sites across the /command,
   * /weather/*, /climate/*, /time, /events, /vehicle/*, /chat/* etc.
   * routes) -- `bridge.bridgePath` isn't set. Identical wording/meaning
   * everywhere, shared code -- same reasoning as WIPE_TARGETS_REQUIRED
   * elsewhere in this file. */
  BRIDGE_NOT_CONFIGURED: "BRIDGE_NOT_CONFIGURED",
  /** server/routes/panelBridge.js (many sites, same routes as
   * BRIDGE_NOT_CONFIGURED above) -- `bridge.isRunning` is false. Own
   * wording ("...Start it first.") from BRIDGE_NOT_RUNNING_BARE below --
   * kept separate rather than merged. */
  BRIDGE_NOT_RUNNING: "BRIDGE_NOT_RUNNING",
  /** server/routes/panelBridge.js (many sites: the character import/export,
   * faction, safehouse, vehicle-detail routes) -- `bridge.isRunning` is
   * false. Bare wording ("Bridge not running", no "Start it first."
   * suffix) -- kept separate from BRIDGE_NOT_RUNNING above rather than
   * merged. */
  BRIDGE_NOT_RUNNING_BARE: "BRIDGE_NOT_RUNNING_BARE",
  /** server/routes/panelBridge.js (many sites: player/faction/safehouse
   * routes) -- `username` fails BRIDGE_USERNAME_REGEX. */
  BRIDGE_INVALID_USERNAME_FORMAT: "BRIDGE_INVALID_USERNAME_FORMAT",
  /** server/routes/panelBridge.js (4 sites: /message, /chat/*) -- `message`
   * missing or exceeds 2000 characters. */
  BRIDGE_MESSAGE_REQUIRED: "BRIDGE_MESSAGE_REQUIRED",
  /** server/routes/panelBridge.js (4 sites: moderation kick/ban routes) --
   * `username` missing or not a non-empty string. */
  BRIDGE_VALID_USERNAME_REQUIRED: "BRIDGE_VALID_USERNAME_REQUIRED",
  /** server/routes/panelBridge.js (4 sites: /vehicle/* fuel/battery-style
   * routes) -- `value` missing, own wording ("(0.0-1.0)", no "number")
   * from PANELBRIDGE_VALUE_REQUIRED_NUMBER_0_1 below -- kept separate. */
  BRIDGE_VALUE_REQUIRED_0_1: "BRIDGE_VALUE_REQUIRED_0_1",
  /** server/routes/panelBridge.js (3 sites: /climate/fog, /climate/clouds,
   * and one more climate shortcut) -- `value` provided but out of 0-1
   * range. */
  BRIDGE_VALUE_MUST_BE_NUMBER_0_1: "BRIDGE_VALUE_MUST_BE_NUMBER_0_1",
  /** server/routes/panelBridge.js (2 sites: /weather/snow,
   * /weather/rain/start) -- `intensity` provided but out of 0-1 range. */
  BRIDGE_INTENSITY_MUST_BE_NUMBER_0_1: "BRIDGE_INTENSITY_MUST_BE_NUMBER_0_1",
  /** server/routes/panelBridge.js (2 sites: /events/lightning-adjacent
   * routes) -- `x`/`y` both missing. */
  BRIDGE_XY_COORDS_REQUIRED: "BRIDGE_XY_COORDS_REQUIRED",
  /** server/routes/panelBridge.js (2 sites: moderation kick/ban routes) --
   * `username` missing or fails format check, combined message. */
  BRIDGE_INVALID_OR_MISSING_USERNAME: "BRIDGE_INVALID_OR_MISSING_USERNAME",
  /** server/routes/panelBridge.js -- POST /auto-configure, GET
   * /scan-server/:serverId, POST /install/from-lua-path (3 sites) --
   * `serverId` doesn't match a known server. Sends `{ serverId }` at all
   * three sites. */
  PANELBRIDGE_SERVER_ID_NOT_FOUND: "PANELBRIDGE_SERVER_ID_NOT_FOUND",
  /** server/routes/panelBridge.js (2 sites: POST /auto-configure, GET
   * /scan-server/:serverId) -- resolved server has no serverName/name set.
   * Identical wording/meaning both sites, shared code. */
  PANELBRIDGE_SERVER_NAME_NOT_CONFIGURED: "PANELBRIDGE_SERVER_NAME_NOT_CONFIGURED",
  /** server/routes/panelBridge.js (2 sites: POST /install/from-lua-path,
   * POST /install) -- no active server configured. Identical wording/
   * meaning both sites, shared code. Distinct from PANELBRIDGE_
   * AUTO_CONFIGURE_NO_ACTIVE_SERVER below (own wording, own route). */
  PANELBRIDGE_NO_ACTIVE_SERVER: "PANELBRIDGE_NO_ACTIVE_SERVER",
  /** server/routes/panelBridge.js -- POST /auto-configure, no active server
   * and no serverId given. Own wording ("Please configure a server
   * first.") from PANELBRIDGE_NO_ACTIVE_SERVER above -- kept separate. */
  PANELBRIDGE_AUTO_CONFIGURE_NO_ACTIVE_SERVER: "PANELBRIDGE_AUTO_CONFIGURE_NO_ACTIVE_SERVER",
  /** server/routes/panelBridge.js -- POST /auto-configure, none of the
   * candidate bridge paths could be determined for the server. */
  PANELBRIDGE_PATH_NOT_DETERMINED: "PANELBRIDGE_PATH_NOT_DETERMINED",
  /** server/routes/panelBridge.js -- POST /auto-detect, no `serverName` in
   * the body. */
  PANELBRIDGE_SERVER_NAME_REQUIRED: "PANELBRIDGE_SERVER_NAME_REQUIRED",
  /** server/routes/panelBridge.js -- POST /auto-detect,
   * `zomboidUserFolder` fails isValidBridgePath(). */
  PANELBRIDGE_INVALID_ZOMBOID_USER_FOLDER: "PANELBRIDGE_INVALID_ZOMBOID_USER_FOLDER",
  /** server/routes/panelBridge.js -- POST /configure, no
   * `zomboidSavePath` in the body. */
  PANELBRIDGE_SAVE_PATH_REQUIRED: "PANELBRIDGE_SAVE_PATH_REQUIRED",
  /** server/routes/panelBridge.js -- POST /configure, `zomboidSavePath`
   * fails isValidBridgePath(). */
  PANELBRIDGE_INVALID_SAVE_PATH: "PANELBRIDGE_INVALID_SAVE_PATH",
  /** server/routes/panelBridge.js -- POST /configure-direct, no
   * `bridgePath` string in the body. */
  PANELBRIDGE_BRIDGE_PATH_REQUIRED: "PANELBRIDGE_BRIDGE_PATH_REQUIRED",
  /** server/routes/panelBridge.js -- POST /configure-direct, `bridgePath`
   * fails path.isAbsolute() on the raw input. */
  PANELBRIDGE_PATH_MUST_BE_ABSOLUTE: "PANELBRIDGE_PATH_MUST_BE_ABSOLUTE",
  /** server/routes/panelBridge.js -- POST /configure-direct, resolved path
   * matches a BLOCKED_BRIDGE_PATH_PREFIXES entry. */
  PANELBRIDGE_PATH_PROTECTED_SYSTEM_DIR: "PANELBRIDGE_PATH_PROTECTED_SYSTEM_DIR",
  /** server/routes/panelBridge.js -- POST /command, active server is
   * remote with neither SFTP nor a local bridge transport running. */
  PANELBRIDGE_COMMAND_REMOTE_TRANSPORT_UNAVAILABLE: "PANELBRIDGE_COMMAND_REMOTE_TRANSPORT_UNAVAILABLE",
  /** server/routes/panelBridge.js -- POST /command, no `action` in the
   * body. */
  PANELBRIDGE_ACTION_REQUIRED: "PANELBRIDGE_ACTION_REQUIRED",
  /** server/routes/panelBridge.js -- POST /command, `action` not in
   * VALID_ACTIONS. */
  PANELBRIDGE_UNKNOWN_ACTION: "PANELBRIDGE_UNKNOWN_ACTION",
  /** server/routes/panelBridge.js -- POST /command, `args` provided but
   * isn't a plain object. */
  PANELBRIDGE_ARGS_MUST_BE_OBJECT: "PANELBRIDGE_ARGS_MUST_BE_OBJECT",
  /** server/routes/panelBridge.js -- POST /command, `action` is one of the
   * four moderation actions (BRIDGE_ACTION_CAPABILITY) and the caller holds
   * bridge.command but not the specific capability (players.moderate) that
   * governs discipline actions everywhere else in the app.
   * bug-hunt-2026-08-27: Pam's cross-route-family capability sweep. */
  PANELBRIDGE_ACTION_CAPABILITY_REQUIRED: "PANELBRIDGE_ACTION_CAPABILITY_REQUIRED",
  /** server/routes/panelBridge.js -- POST /command action=spawnVehicleAt,
   * `vehicle`/`scriptName` fails VEHICLE_SCRIPT_REGEX. */
  PANELBRIDGE_INVALID_VEHICLE_SCRIPT_NAME: "PANELBRIDGE_INVALID_VEHICLE_SCRIPT_NAME",
  /** server/routes/panelBridge.js -- POST /command action=spawnVehicleAt,
   * x/y/z out of the RCON-supported range. */
  PANELBRIDGE_SPAWN_VEHICLE_INVALID_COORDS: "PANELBRIDGE_SPAWN_VEHICLE_INVALID_COORDS",
  /** server/routes/panelBridge.js -- POST /command action=airdrop, x/y out
   * of range. */
  PANELBRIDGE_AIRDROP_INVALID_COORDS: "PANELBRIDGE_AIRDROP_INVALID_COORDS",
  /** server/routes/panelBridge.js -- POST /command action=airdrop, `preset`
   * not in VALID_PRESETS. Sends `{ presets: VALID_PRESETS.join(", ") }`. */
  PANELBRIDGE_AIRDROP_INVALID_PRESET: "PANELBRIDGE_AIRDROP_INVALID_PRESET",
  /** server/routes/panelBridge.js -- POST /command action=airdrop, `items`
   * provided but not an array of at most 50 entries. */
  PANELBRIDGE_AIRDROP_ITEMS_ARRAY_INVALID: "PANELBRIDGE_AIRDROP_ITEMS_ARRAY_INVALID",
  /** server/routes/panelBridge.js -- POST /command action=airdrop, an
   * `items` entry isn't an object. */
  PANELBRIDGE_AIRDROP_ITEM_INVALID: "PANELBRIDGE_AIRDROP_ITEM_INVALID",
  /** server/routes/panelBridge.js -- POST /command action=airdrop, an
   * `items` entry's `itemType` fails ITEM_TYPE_REGEX. Sends `{ itemType }`
   * (the same 60-char-truncated value embedded in the English message). */
  PANELBRIDGE_AIRDROP_ITEM_TYPE_INVALID: "PANELBRIDGE_AIRDROP_ITEM_TYPE_INVALID",
  /** server/routes/panelBridge.js -- POST /command action=airdrop, an
   * `items` entry's `count` is outside 1-20. */
  PANELBRIDGE_AIRDROP_ITEM_COUNT_INVALID: "PANELBRIDGE_AIRDROP_ITEM_COUNT_INVALID",
  /** server/routes/panelBridge.js -- POST /weather/storm, `duration`
   * outside 0-168. */
  PANELBRIDGE_STORM_DURATION_INVALID: "PANELBRIDGE_STORM_DURATION_INVALID",
  /** server/routes/panelBridge.js -- POST /weather/generate, `strength`
   * outside 0-1. */
  PANELBRIDGE_WEATHER_STRENGTH_INVALID: "PANELBRIDGE_WEATHER_STRENGTH_INVALID",
  /** server/routes/panelBridge.js -- POST /weather/generate, `frontType`
   * outside 0-5. */
  PANELBRIDGE_WEATHER_FRONT_TYPE_INVALID: "PANELBRIDGE_WEATHER_FRONT_TYPE_INVALID",
  /** server/routes/panelBridge.js -- POST /weather/lightning, `x` provided
   * but not a finite number. */
  PANELBRIDGE_LIGHTNING_X_INVALID: "PANELBRIDGE_LIGHTNING_X_INVALID",
  /** server/routes/panelBridge.js -- POST /weather/lightning, `y` provided
   * but not a finite number. */
  PANELBRIDGE_LIGHTNING_Y_INVALID: "PANELBRIDGE_LIGHTNING_Y_INVALID",
  /** server/routes/panelBridge.js -- POST /climate/float, `floatId` or
   * `value` missing. */
  PANELBRIDGE_CLIMATE_FLOAT_FIELDS_REQUIRED: "PANELBRIDGE_CLIMATE_FLOAT_FIELDS_REQUIRED",
  /** server/routes/panelBridge.js -- POST /climate/float, `floatId`
   * outside 0-12. */
  PANELBRIDGE_CLIMATE_FLOAT_ID_INVALID: "PANELBRIDGE_CLIMATE_FLOAT_ID_INVALID",
  /** server/routes/panelBridge.js -- POST /climate/float, `value` not a
   * finite number. */
  PANELBRIDGE_CLIMATE_FLOAT_VALUE_INVALID: "PANELBRIDGE_CLIMATE_FLOAT_VALUE_INVALID",
  /** server/routes/panelBridge.js -- POST /climate/temperature, `value`
   * outside -50 to 50. */
  PANELBRIDGE_TEMPERATURE_VALUE_INVALID: "PANELBRIDGE_TEMPERATURE_VALUE_INVALID",
  /** server/routes/panelBridge.js -- POST /time/set (or similar), `hour`
   * outside 0-23. */
  PANELBRIDGE_GAMETIME_HOUR_INVALID: "PANELBRIDGE_GAMETIME_HOUR_INVALID",
  /** server/routes/panelBridge.js -- same route as above, `day` outside
   * 1-31. */
  PANELBRIDGE_GAMETIME_DAY_INVALID: "PANELBRIDGE_GAMETIME_DAY_INVALID",
  /** server/routes/panelBridge.js -- same route as above, `month` outside
   * 1-12. */
  PANELBRIDGE_GAMETIME_MONTH_INVALID: "PANELBRIDGE_GAMETIME_MONTH_INVALID",
  /** server/routes/panelBridge.js -- same route as above, `year` outside
   * 1-9999. */
  PANELBRIDGE_GAMETIME_YEAR_INVALID: "PANELBRIDGE_GAMETIME_YEAR_INVALID",
  /** server/routes/panelBridge.js -- GET /player/:username (or similar),
   * bridge.getPlayerDetails() threw. Fixed generic catch string (not a
   * sanitizeError(error.message) passthrough), so it gets a code like any
   * other static message. */
  PANELBRIDGE_GET_PLAYER_DETAILS_FAILED: "PANELBRIDGE_GET_PLAYER_DETAILS_FAILED",
  /** server/routes/panelBridge.js -- POST /player/teleport (or similar),
   * `x`/`y`/`z` provided but not numbers. */
  PANELBRIDGE_TELEPORT_COORDS_NOT_NUMBERS: "PANELBRIDGE_TELEPORT_COORDS_NOT_NUMBERS",
  /** server/routes/panelBridge.js -- same teleport route, x/y outside
   * 0-24000. */
  PANELBRIDGE_TELEPORT_XY_OUT_OF_RANGE: "PANELBRIDGE_TELEPORT_XY_OUT_OF_RANGE",
  /** server/routes/panelBridge.js -- same teleport route, z outside 0-8. */
  PANELBRIDGE_TELEPORT_Z_OUT_OF_RANGE: "PANELBRIDGE_TELEPORT_Z_OUT_OF_RANGE",
  /** server/routes/panelBridge.js -- same teleport route, bridge.
   * teleportPlayer() threw. Fixed generic catch string, same reasoning as
   * PANELBRIDGE_GET_PLAYER_DETAILS_FAILED above. */
  PANELBRIDGE_TELEPORT_FAILED: "PANELBRIDGE_TELEPORT_FAILED",
  /** server/routes/panelBridge.js -- POST /install/from-lua-path, auto-
   * install refused (isRemote/canAutoInstall check). */
  PANELBRIDGE_AUTO_INSTALL_NOT_AVAILABLE: "PANELBRIDGE_AUTO_INSTALL_NOT_AVAILABLE",
  /** server/routes/panelBridge.js -- POST /install, active server is
   * remote. Own wording from PANELBRIDGE_AUTO_INSTALL_NOT_AVAILABLE above
   * -- kept separate. */
  PANELBRIDGE_INSTALL_REMOTE_NOT_AVAILABLE: "PANELBRIDGE_INSTALL_REMOTE_NOT_AVAILABLE",
  /** server/routes/panelBridge.js -- POST /install, canAutoInstall()
   * false for a local server. */
  PANELBRIDGE_INSTALL_CANNOT_AUTO_INSTALL: "PANELBRIDGE_INSTALL_CANNOT_AUTO_INSTALL",
  /** server/routes/panelBridge.js -- POST /install/from-lua-path, no
   * `serverLuaPath` in the body. */
  PANELBRIDGE_SERVER_LUA_PATH_REQUIRED: "PANELBRIDGE_SERVER_LUA_PATH_REQUIRED",
  /** server/routes/panelBridge.js -- POST /install/from-lua-path,
   * `serverLuaPath` isn't a string or exceeds 500 characters. */
  PANELBRIDGE_SERVER_LUA_PATH_FORMAT_INVALID: "PANELBRIDGE_SERVER_LUA_PATH_FORMAT_INVALID",
  /** server/routes/panelBridge.js -- POST /install/from-lua-path,
   * `serverLuaPath` isn't absolute. */
  PANELBRIDGE_SERVER_LUA_PATH_NOT_ABSOLUTE: "PANELBRIDGE_SERVER_LUA_PATH_NOT_ABSOLUTE",
  /** server/routes/panelBridge.js -- POST /install/from-lua-path, resolved
   * path doesn't end in media/lua/server/. */
  PANELBRIDGE_SERVER_LUA_PATH_WRONG_DIRECTORY: "PANELBRIDGE_SERVER_LUA_PATH_WRONG_DIRECTORY",
  /** server/routes/panelBridge.js -- POST /install/from-lua-path, no
   * embedded Lua and no on-disk pz-mod source found to copy. */
  PANELBRIDGE_SOURCE_MOD_NOT_FOUND: "PANELBRIDGE_SOURCE_MOD_NOT_FOUND",
  /** server/routes/panelBridge.js -- POST /audio/play-sound (or similar),
   * x/y out of range. Own wording ("Coordinates out of range") from
   * PANELBRIDGE_TELEPORT_XY_OUT_OF_RANGE above -- kept separate, own
   * route. */
  PANELBRIDGE_SOUND_COORDS_OUT_OF_RANGE: "PANELBRIDGE_SOUND_COORDS_OUT_OF_RANGE",
  /** server/routes/panelBridge.js -- same play-sound route, bridge.
   * playSoundNearPlayer() threw. Fixed generic catch string. */
  PANELBRIDGE_PLAY_SOUND_FAILED: "PANELBRIDGE_PLAY_SOUND_FAILED",
  /** server/routes/panelBridge.js -- POST /audio/gunshot (or similar),
   * bridge.triggerGunshot() threw. Fixed generic catch string. */
  PANELBRIDGE_TRIGGER_GUNSHOT_FAILED: "PANELBRIDGE_TRIGGER_GUNSHOT_FAILED",
  /** server/routes/panelBridge.js -- POST /character/import (or similar),
   * no `data` in the body. */
  PANELBRIDGE_CHARACTER_DATA_REQUIRED: "PANELBRIDGE_CHARACTER_DATA_REQUIRED",
  /** server/routes/panelBridge.js -- same character-import route, `data`
   * isn't a plain object. */
  PANELBRIDGE_CHARACTER_DATA_NOT_OBJECT: "PANELBRIDGE_CHARACTER_DATA_NOT_OBJECT",
  /** server/routes/panelBridge.js -- same character-import route, `data`
   * has none of the recognised sections. Sends
   * `{ sections: validSections.join(", ") }`. */
  PANELBRIDGE_CHARACTER_DATA_NO_VALID_SECTION: "PANELBRIDGE_CHARACTER_DATA_NO_VALID_SECTION",
  /** server/routes/panelBridge.js -- POST /zombies/clear-near (or
   * similar), `count` outside 1-100. */
  PANELBRIDGE_HORDE_COUNT_INVALID: "PANELBRIDGE_HORDE_COUNT_INVALID",
  /** server/routes/panelBridge.js -- POST /zombies/clear (or similar),
   * `radius` outside 1-500. */
  PANELBRIDGE_CLEAR_ZOMBIES_RADIUS_INVALID: "PANELBRIDGE_CLEAR_ZOMBIES_RADIUS_INVALID",
  /** server/routes/panelBridge.js (5 sites: /vehicle/* fuel/battery-style
   * routes) -- `value` missing. Own wording ("(number 0.0-1.0)", includes
   * "number") from BRIDGE_VALUE_REQUIRED_0_1 above -- kept separate. */
  PANELBRIDGE_VALUE_REQUIRED_NUMBER_0_1: "PANELBRIDGE_VALUE_REQUIRED_NUMBER_0_1",
  /** server/routes/panelBridge.js -- POST /chat/admin, neither PanelBridge
   * nor RCON available to send an admin chat message. */
  PANELBRIDGE_ADMIN_CHAT_UNAVAILABLE: "PANELBRIDGE_ADMIN_CHAT_UNAVAILABLE",
  /** server/routes/panelBridge.js -- same admin-chat route, sending the
   * message itself threw. Fixed generic catch string. */
  PANELBRIDGE_SEND_ADMIN_MESSAGE_FAILED: "PANELBRIDGE_SEND_ADMIN_MESSAGE_FAILED",
  /** server/routes/panelBridge.js -- POST /chat/general (or similar),
   * neither PanelBridge nor RCON available for regular chat. Own wording
   * ("for chat") from PANELBRIDGE_ADMIN_CHAT_UNAVAILABLE above -- kept
   * separate. */
  PANELBRIDGE_CHAT_UNAVAILABLE: "PANELBRIDGE_CHAT_UNAVAILABLE",
  /** server/routes/panelBridge.js -- POST /chat/alert (or similar), neither
   * RCON nor PanelBridge available. Own wording (word order swapped, no
   * "for X" suffix) from the two codes above -- kept separate. */
  PANELBRIDGE_RCON_AND_BRIDGE_UNAVAILABLE: "PANELBRIDGE_RCON_AND_BRIDGE_UNAVAILABLE",
  /** server/routes/panelBridge.js -- POST /sandbox/get-object (or
   * similar), `object` fails the alphanumeric/dot identifier check. */
  PANELBRIDGE_INVALID_OBJECT_NAME: "PANELBRIDGE_INVALID_OBJECT_NAME",
  /** server/routes/panelBridge.js -- same sandbox-object route, `method`
   * fails the alphanumeric/dot identifier check. */
  PANELBRIDGE_INVALID_METHOD_NAME: "PANELBRIDGE_INVALID_METHOD_NAME",
  /** server/routes/panelBridge.js -- GET /items/scan (or similar), bridge
   * not running so the item catalogue can't be read from the live server. */
  PANELBRIDGE_SCAN_ITEMS_NOT_RUNNING: "PANELBRIDGE_SCAN_ITEMS_NOT_RUNNING",
  /** server/routes/panelBridge.js -- GET /vehicles/scan (or similar), same
   * reasoning as PANELBRIDGE_SCAN_ITEMS_NOT_RUNNING above for vehicles. */
  PANELBRIDGE_SCAN_VEHICLES_NOT_RUNNING: "PANELBRIDGE_SCAN_VEHICLES_NOT_RUNNING",

  /** server/services/panelBridgeSftp.js -- classifySftpErrorCode(), one of
   * seven codes for the PanelBridge SFTP transport (POST /panel-bridge/
   * sftp/test, /sftp/configure, and the transport.lastErrorCode field on GET
   * /panel-bridge/status). Added 2026-08-26: formatSftpError()/
   * getSftpErrorGuidance() already classified these failures correctly (a
   * chrooted account vs. a bad password vs. a missing remote path vs. a
   * network failure, ...) and appended a tailored English "Fix: ..."
   * sentence, but that classifier was a parallel system that never fed into
   * this registry -- every non-English user saw the raw English sentence
   * regardless of locale. Each code's errors.json translation reproduces
   * formatSftpError()'s exact "{{detail}} Fix: ..." shape via a {{detail}}
   * param carrying the original error.message, so the dynamic specifics the
   * English version carried (the literal path, the literal errno) survive
   * translation instead of being replaced by a vaguer generic sentence --
   * see resolveRegisteredTranslation's params-required-or-null design (used
   * by RCON_CONNECT_AUTH_FAILED et al.) for why a missing `detail` param
   * falls back to the raw message rather than ever rendering a broken
   * "{{detail}}" literal. SFTP_UNKNOWN is the catch-all last entry in
   * classifySftpError()'s ordered list -- always matches, never actually
   * "unregistered". */
  SFTP_CHROOTED_ACCOUNT: "SFTP_CHROOTED_ACCOUNT",
  /** Same file, sibling of SFTP_CHROOTED_ACCOUNT above -- wrong username or
   * password, or the account can't complete the SSH handshake at all. */
  SFTP_AUTH_FAILED: "SFTP_AUTH_FAILED",
  /** Same file -- reachable, authenticated, but the account lacks write
   * access to the remote bridge folder or its parent. Distinct from the
   * unrelated RBAC-level PERMISSION_DENIED above: that one means "this
   * panel user can't call this API"; this one means "the remote SFTP
   * account can't write this remote path" -- two unconnected concepts that
   * happen to share the English phrase "permission denied". */
  SFTP_PERMISSION_DENIED: "SFTP_PERMISSION_DENIED",
  /** Same file -- the configured remote bridge path doesn't exist yet
   * (first-time setup, or a typo). */
  SFTP_REMOTE_PATH_MISSING: "SFTP_REMOTE_PATH_MISSING",
  /** Same file -- something already occupies the exact path PanelBridge.lua
   * needs to write to, and it isn't a regular file (e.g. a directory with
   * that name). */
  SFTP_PATH_OCCUPIED: "SFTP_PATH_OCCUPIED",
  /** Same file -- connection-level failure (refused, timed out, DNS
   * failure, host unreachable) reaching the SFTP host at all. */
  SFTP_UNREACHABLE: "SFTP_UNREACHABLE",
  /** Same file -- classifySftpError()'s catch-all: none of the six more
   * specific patterns above matched. Always has a match (last entry's test
   * is unconditional), so this is a real, reachable outcome, not dead code. */
  SFTP_UNKNOWN: "SFTP_UNKNOWN",

  /** server/routes/server.js -- formatWritablePathError("install", ...),
   * /install and /quick-setup, installPath fails the post-checks writable
   * probe, not running in a container. Split from the single WRITABLE_PATH_
   * ERROR above (2026-08-22 correction) -- that code covered 4 distinct
   * English sentences (2 labels x 2 remediation branches) behind one
   * locale key with an untranslatable {{label}}/addendum split, and never
   * actually sent params, so every response silently fell back to English
   * in both languages. label and isContainer are word/sentence choices,
   * not values -- only the path is a real param. WRITABLE_PATH_ERROR itself
   * stays registered (no longer emitted, kept for registry completeness --
   * additive-only edit, nothing removed). */
  WRITABLE_PATH_INSTALL_BAREMETAL: "WRITABLE_PATH_INSTALL_BAREMETAL",
  /** server/routes/server.js -- same call site as ..._BAREMETAL above,
   * Docker/container detected (bind-mount remediation instead). */
  WRITABLE_PATH_INSTALL_CONTAINER: "WRITABLE_PATH_INSTALL_CONTAINER",
  /** server/routes/server.js -- formatWritablePathError("data", ...),
   * /install and /quick-setup, the Zomboid data folder fails the writable
   * probe, not running in a container. See WRITABLE_PATH_INSTALL_BAREMETAL
   * above for why this is a separate code from the install-path variants
   * (label is a word choice, not a param). */
  WRITABLE_PATH_DATA_BAREMETAL: "WRITABLE_PATH_DATA_BAREMETAL",
  /** server/routes/server.js -- same call site as ..._BAREMETAL above,
   * Docker/container detected. */
  WRITABLE_PATH_DATA_CONTAINER: "WRITABLE_PATH_DATA_CONTAINER",
  /** server/routes/server.js -- POST /api/server/list-directory,
   * fs.readdirSync() threw (permissions), isWindows true. Split from the
   * single DIRECTORY_READ_FAILED above (2026-08-22 correction, same
   * reasoning as the WRITABLE_PATH_* split) -- the Windows/POSIX guidance
   * are two full sentences, not a {{guidance}} hole. DIRECTORY_READ_FAILED
   * itself stays registered (no longer emitted, kept for registry
   * completeness -- additive-only edit, nothing removed). */
  DIRECTORY_READ_FAILED_WINDOWS: "DIRECTORY_READ_FAILED_WINDOWS",
  /** server/routes/server.js -- same call site as ..._WINDOWS above,
   * isWindows false (Linux/macOS guidance). */
  DIRECTORY_READ_FAILED_POSIX: "DIRECTORY_READ_FAILED_POSIX",

  /** server/services/oidc.js -- testOidcDiscovery()'s credential check (POST
   * /api/auth/oidc/test-connection). The token-endpoint round trip with a
   * deliberately bogus authorization code got back invalid_client -- the
   * provider rejected the client ID or client secret itself, not just the
   * fabricated code. Distinct from OIDC_TEST_UNDETERMINED below: this is a
   * CONFIRMED rejection, not an ambiguous outcome. */
  OIDC_CREDENTIALS_REJECTED: "OIDC_CREDENTIALS_REJECTED",
  /** server/services/oidc.js -- testOidcDiscovery()'s credential check, two
   * sites: an OAuth error code that's neither invalid_grant (success) nor
   * invalid_client (confirmed rejection), or a non-OAuth failure (network
   * error, HTML error page, timeout) after discovery already succeeded.
   * Deliberately NOT reported as success and NOT the same claim as
   * OIDC_CREDENTIALS_REJECTED -- "the issuer is reachable, but we can't
   * confirm the credentials are valid" is a third, genuinely distinct
   * outcome the whole point of this feature is to stop collapsing into a
   * false "connection successful". Carries `{{reason}}` (the underlying
   * OAuth error code or failure message, sanitizeError()'d). */
  OIDC_TEST_UNDETERMINED: "OIDC_TEST_UNDETERMINED",

  // --- server/routes/players.js -- never adopted this registry at all
  // until now (2026-08-26 bug hunt round 2, Angela's find): every
  // validation branch in the GM-tools surface (add-item, add-xp,
  // vehicle-spawn, moderation, notes, exports) was a bare error string
  // with no code, so none of it could be translated, carry a fix-it
  // destination, or be classified, in any of the six languages. Grouped
  // identical wording across sites into one shared code, same convention
  // AUTH_USERNAME_PASSWORD_REQUIRED etc. already established -- listed
  // below by first call site, all sharing sites named in the comment. ---

  /** server/routes/players.js (10 sites: /kick, /ban, /unban,
   * /whitelist/add, /whitelist/remove, /godmode, /invisible, /noclip,
   * /voiceban, /adduser) -- `username` missing from the body. Identical
   * wording/meaning at every site, shared code. */
  PLAYERS_USERNAME_REQUIRED: "PLAYERS_USERNAME_REQUIRED",
  /** server/routes/players.js (14 sites: /kick, /ban, /unban,
   * /access-level, /whitelist/add, /whitelist/remove, /add-item, /add-xp,
   * /add-vehicle, /godmode, /invisible, /noclip, /voiceban, /adduser) --
   * `username` fails isValidUsername() (control chars/quotes/backslash
   * guard against RCON command injection). Identical wording/meaning at
   * every site, shared code. Distinct from PLAYERS_TELEPORT_INVALID_
   * PLAYER1/2 below, which name which specific field failed on /teleport
   * rather than reusing this generic wording. */
  PLAYERS_INVALID_USERNAME: "PLAYERS_INVALID_USERNAME",
  /** server/routes/players.js (3 sites: /ban, /banid) -- optional `reason`
   * fails isValidText(). Identical wording/meaning both routes, shared
   * code. */
  PLAYERS_INVALID_REASON: "PLAYERS_INVALID_REASON",
  /** server/routes/players.js -- POST /api/players/ban, `banIp` present but
   * not a boolean. */
  PLAYERS_INVALID_BAN_IP: "PLAYERS_INVALID_BAN_IP",
  /** server/routes/players.js -- POST /api/players/access-level, `username`
   * and/or `level` missing. Own code from PLAYERS_USERNAME_REQUIRED above
   * -- this route requires a second field in the same check, different
   * wording. */
  PLAYERS_ACCESS_LEVEL_FIELDS_REQUIRED: "PLAYERS_ACCESS_LEVEL_FIELDS_REQUIRED",
  /** server/routes/players.js -- POST /api/players/access-level, `level`
   * not one of ACCESS_LEVELS. Carries `{{validLevels}}` (ACCESS_LEVELS
   * joined) as a param -- same shape as AUTH_INVALID_ROLE's `{{roles}}`
   * above. */
  PLAYERS_INVALID_ACCESS_LEVEL: "PLAYERS_INVALID_ACCESS_LEVEL",
  /** server/routes/players.js (2 sites: /whitelist/add, /adduser) --
   * optional `password` fails its alphanumeric-plus-symbols/length format
   * check. Identical wording/meaning both sites, shared code. */
  PLAYERS_INVALID_PASSWORD: "PLAYERS_INVALID_PASSWORD",
  /** server/routes/players.js -- POST /api/players/teleport, x/y/z present
   * but fail isValidNumber() range checks (0-24000 for x/y, 0-8 for z). */
  PLAYERS_TELEPORT_INVALID_COORDINATES: "PLAYERS_TELEPORT_INVALID_COORDINATES",
  /** server/routes/players.js (2 sites, both within POST
   * /api/players/teleport) -- `player1` fails isValidUsername(), in either
   * the coordinate-teleport branch or the player-to-player branch. Own
   * wording ("player1", not the generic "username") from PLAYERS_INVALID_
   * USERNAME above, so the response names which field. */
  PLAYERS_TELEPORT_INVALID_PLAYER1: "PLAYERS_TELEPORT_INVALID_PLAYER1",
  /** server/routes/players.js -- POST /api/players/teleport, coordinate
   * branch: `player1` given but PanelBridge isn't running, and RCON's
   * `teleportto` can't target another player. */
  PLAYERS_TELEPORT_BRIDGE_OFFLINE: "PLAYERS_TELEPORT_BRIDGE_OFFLINE",
  /** server/routes/players.js -- POST /api/players/teleport,
   * player-to-player branch: optional `player2` fails isValidUsername().
   * See PLAYERS_TELEPORT_INVALID_PLAYER1 above for why this names the
   * field rather than reusing the generic username code. */
  PLAYERS_TELEPORT_INVALID_PLAYER2: "PLAYERS_TELEPORT_INVALID_PLAYER2",
  /** server/routes/players.js -- POST /api/players/teleport, neither
   * coordinates nor a target player were given. */
  PLAYERS_TELEPORT_TARGET_REQUIRED: "PLAYERS_TELEPORT_TARGET_REQUIRED",
  /** server/routes/players.js -- POST /api/players/add-item, `item`
   * missing. */
  PLAYERS_ITEM_REQUIRED: "PLAYERS_ITEM_REQUIRED",
  /** server/routes/players.js -- POST /api/players/add-item, `item` fails
   * isValidItem() (must be "Module.ItemName" shape). */
  PLAYERS_INVALID_ITEM: "PLAYERS_INVALID_ITEM",
  /** server/routes/players.js -- POST /api/players/add-item, optional
   * `count` fails isValidNumber(1, 100). */
  PLAYERS_INVALID_ITEM_COUNT: "PLAYERS_INVALID_ITEM_COUNT",
  /** server/routes/players.js -- POST /api/players/add-item, `item`/`count`
   * valid but no `username` given -- unlike /add-vehicle, add-item has no
   * self-target concept, so a player must be picked. */
  PLAYERS_ADD_ITEM_TARGET_REQUIRED: "PLAYERS_ADD_ITEM_TARGET_REQUIRED",
  /** server/routes/players.js -- POST /api/players/add-xp,
   * `username`/`perk`/`amount` missing (checked together). */
  PLAYERS_ADD_XP_FIELDS_REQUIRED: "PLAYERS_ADD_XP_FIELDS_REQUIRED",
  /** server/routes/players.js -- POST /api/players/add-xp, `perk` not one
   * of PERKS. Carries `{{validPerks}}` (PERKS joined) as a param, same
   * shape as PLAYERS_INVALID_ACCESS_LEVEL above. */
  PLAYERS_INVALID_PERK: "PLAYERS_INVALID_PERK",
  /** server/routes/players.js -- POST /api/players/add-xp, `amount` fails
   * isValidNumber(0, 100000). */
  PLAYERS_INVALID_XP_AMOUNT: "PLAYERS_INVALID_XP_AMOUNT",
  /** server/routes/players.js -- POST /api/players/add-vehicle, `vehicle`
   * missing. */
  PLAYERS_VEHICLE_REQUIRED: "PLAYERS_VEHICLE_REQUIRED",
  /** server/routes/players.js (2 sites: /add-vehicle, /add-vehicle-at) --
   * `vehicle` fails the "Module.VehicleName" format check. Identical
   * wording/meaning both sites, shared code. */
  PLAYERS_INVALID_VEHICLE_ID: "PLAYERS_INVALID_VEHICLE_ID",
  /** server/routes/players.js -- POST /api/players/add-vehicle-at, x/y/z
   * fail isValidNumber() range checks. Own wording ("map coordinates", no
   * range spelled out) from PLAYERS_TELEPORT_INVALID_COORDINATES above --
   * different route, different phrasing. */
  PLAYERS_INVALID_MAP_COORDINATES: "PLAYERS_INVALID_MAP_COORDINATES",
  /** server/routes/players.js (4 sites: /godmode, /invisible, /noclip,
   * /voiceban) -- `enabled` present but not a boolean. Identical
   * wording/meaning at every site, shared code. */
  PLAYERS_INVALID_ENABLED_FLAG: "PLAYERS_INVALID_ENABLED_FLAG",
  /** server/routes/players.js (2 sites: /banid, /unbanid) -- `steamId`
   * missing. Identical wording/meaning both sites, shared code. */
  PLAYERS_STEAMID_REQUIRED: "PLAYERS_STEAMID_REQUIRED",
  /** server/routes/players.js (4 sites: /banid, /unbanid,
   * /whitelist/steamid/add, /whitelist/steamid/remove) -- `steamId` fails
   * the 17-digit format check. Identical wording/meaning at every site,
   * shared code. */
  PLAYERS_INVALID_STEAMID: "PLAYERS_INVALID_STEAMID",
  /** server/routes/players.js -- GET /api/players/whitelist, no active
   * server configured. */
  PLAYERS_NO_ACTIVE_SERVER: "PLAYERS_NO_ACTIVE_SERVER",
  /** server/routes/players.js -- POST /api/players/notes, `playerName`
   * missing. */
  PLAYERS_NOTE_PLAYER_NAME_REQUIRED: "PLAYERS_NOTE_PLAYER_NAME_REQUIRED",
  /** server/routes/players.js -- POST /api/players/notes, `playerName`
   * fails isValidUsername(). Own code from PLAYERS_INVALID_USERNAME above
   * -- this route's own wording ("player name", not "username"). */
  PLAYERS_INVALID_NOTE_PLAYER_NAME: "PLAYERS_INVALID_NOTE_PLAYER_NAME",
  /** server/routes/players.js -- POST /api/players/notes, `note` present
   * but not a string. */
  PLAYERS_NOTE_MUST_BE_TEXT: "PLAYERS_NOTE_MUST_BE_TEXT",
  /** server/routes/players.js -- POST /api/players/notes, `note` exceeds
   * 10000 characters. */
  PLAYERS_NOTE_TOO_LONG: "PLAYERS_NOTE_TOO_LONG",
  /** server/routes/players.js -- POST /api/players/notes, `tags` present
   * but not an array. */
  PLAYERS_NOTE_TAGS_MUST_BE_ARRAY: "PLAYERS_NOTE_TAGS_MUST_BE_ARRAY",
  /** server/routes/players.js -- POST /api/players/notes, a `tags` entry
   * isn't a string or exceeds 50 characters. */
  PLAYERS_NOTE_INVALID_TAGS: "PLAYERS_NOTE_INVALID_TAGS",
  /** server/routes/players.js -- DELETE /api/players/notes/:playerName, no
   * note existed for that player. */
  PLAYERS_NOTE_NOT_FOUND: "PLAYERS_NOTE_NOT_FOUND",
  /** server/routes/players.js (2 sites: GET /exports/:username/:filename,
   * DELETE /exports/:username/:filename) -- `username`/`filename` fail
   * their path-traversal-safe format checks. Identical wording/meaning
   * both sites, shared code. */
  PLAYERS_EXPORT_INVALID_PARAMETERS: "PLAYERS_EXPORT_INVALID_PARAMETERS",
  /** server/routes/players.js (2 sites: GET /exports/:username/:filename,
   * DELETE /exports/:username/:filename) -- resolved export file doesn't
   * exist on disk. Identical wording/meaning both sites, shared code. */
  PLAYERS_EXPORT_NOT_FOUND: "PLAYERS_EXPORT_NOT_FOUND",

  /** server/routes/scheduler.js (2 sites: POST /tasks, PUT /tasks/:id) --
   * request body missing/not an object/an array. Identical wording/meaning
   * both sites, shared code. */
  SCHEDULER_REQUEST_BODY_INVALID: "SCHEDULER_REQUEST_BODY_INVALID",
  /** server/routes/scheduler.js -- POST /tasks, name/cronExpression/command
   * missing. PUT /tasks/:id has no equivalent (all fields optional there,
   * a partial update), so this is not shared. */
  SCHEDULER_TASK_FIELDS_REQUIRED: "SCHEDULER_TASK_FIELDS_REQUIRED",
  /** server/routes/scheduler.js -- POST /validate-cron, `cronExpression` is
   * missing entirely. Deliberately its own code rather than reusing
   * SCHEDULER_TASK_FIELDS_REQUIRED: that one's translated text names three
   * required fields (name/cronExpression/command) for task creation, which
   * would be misleading on this single-field preview endpoint. */
  SCHEDULER_CRON_EXPRESSION_REQUIRED: "SCHEDULER_CRON_EXPRESSION_REQUIRED",
  /** server/routes/scheduler.js (2 sites: POST /tasks, PUT /tasks/:id) --
   * `name` present but not a string or exceeds 100 characters. Identical
   * wording/meaning both sites, shared code. */
  SCHEDULER_INVALID_TASK_NAME: "SCHEDULER_INVALID_TASK_NAME",
  /** server/routes/scheduler.js (2 sites: POST /tasks, PUT /tasks/:id) --
   * `command` present but not a string or exceeds 2000 characters.
   * Identical wording/meaning both sites, shared code. */
  SCHEDULER_INVALID_COMMAND: "SCHEDULER_INVALID_COMMAND",
  /** server/routes/scheduler.js -- POST /tasks, `cronExpression` present
   * but not a string or exceeds 100 characters (a type/length check, not
   * node-cron's own validator -- see SCHEDULER_INVALID_CRON_EXPRESSION for
   * that one). PUT /tasks/:id has no equivalent standalone check. */
  SCHEDULER_INVALID_CRON_FORMAT: "SCHEDULER_INVALID_CRON_FORMAT",
  /** server/routes/scheduler.js (3 sites: POST /tasks, PUT /tasks/:id,
   * POST /validate-cron) -- node-cron's own cron.validate() rejects the
   * expression. Identical meaning at all three sites; the raw English text
   * differs at the validate-cron site (a shorter preview-only phrasing) but
   * the client translates by this code, not the raw string, so that's fine. */
  SCHEDULER_INVALID_CRON_EXPRESSION: "SCHEDULER_INVALID_CRON_EXPRESSION",
  /** server/routes/scheduler.js (3 sites: POST /tasks, PUT /tasks/:id,
   * POST /validate-cron) -- a 6-field (seconds-precision) cron expression;
   * the panel only supports the standard 5-field form. Identical
   * wording/meaning all three sites, shared code. */
  SCHEDULER_CRON_SECONDS_UNSUPPORTED: "SCHEDULER_CRON_SECONDS_UNSUPPORTED",
  /** server/routes/scheduler.js (3 sites: POST /tasks, PUT /tasks/:id,
   * POST /validate-cron) -- isCronTooFrequent() rejects a schedule firing
   * more than once every 5 minutes (DoS guard). Identical wording/meaning
   * all three sites, shared code. */
  SCHEDULER_CRON_TOO_FREQUENT: "SCHEDULER_CRON_TOO_FREQUENT",
  /** server/routes/scheduler.js (2 sites: POST /tasks, PUT /tasks/:id) --
   * an explicitly given `serverId` doesn't match any known server.
   * Identical wording/meaning both sites, shared code. */
  SCHEDULER_TARGET_SERVER_NOT_FOUND: "SCHEDULER_TARGET_SERVER_NOT_FOUND",
  /** server/routes/scheduler.js -- POST /tasks, scheduler.scheduleTask()
   * rejected the task after the DB row was already created (row is rolled
   * back before this responds). Carries the underlying reason as the
   * `reason` param -- the specific cause (e.g. a scheduler-internal
   * rejection) is more useful here than a generic message, unlike the
   * file's catch-all 500s. */
  SCHEDULER_TASK_SCHEDULING_FAILED: "SCHEDULER_TASK_SCHEDULING_FAILED",
  /** server/routes/scheduler.js (4 sites: PUT /tasks/:id, DELETE
   * /tasks/:id, POST /tasks/:id/run, GET /history) -- the `:id`/`taskId`
   * param fails parseTaskId()'s bounded-integer check. Identical
   * wording/meaning at every site, shared code. */
  SCHEDULER_INVALID_TASK_ID: "SCHEDULER_INVALID_TASK_ID",
  /** server/routes/scheduler.js -- PUT /tasks/:id, `enabled` present but
   * not one of true/false/0/1. */
  SCHEDULER_INVALID_ENABLED_VALUE: "SCHEDULER_INVALID_ENABLED_VALUE",
  /** server/routes/scheduler.js (3 sites: PUT /tasks/:id, DELETE
   * /tasks/:id, POST /tasks/:id/run) -- no scheduled task exists for the
   * given ID. Identical wording/meaning at every site, shared code. */
  SCHEDULER_TASK_NOT_FOUND: "SCHEDULER_TASK_NOT_FOUND",
  /** server/routes/scheduler.js -- PUT /tasks/:id, scheduler.scheduleTask()
   * rejected the updated task; the previous DB record is restored before
   * this responds. Carries the underlying reason as the `reason` param,
   * same rationale as SCHEDULER_TASK_SCHEDULING_FAILED above. */
  SCHEDULER_TASK_RESCHEDULE_FAILED: "SCHEDULER_TASK_RESCHEDULE_FAILED",
  /** server/routes/scheduler.js -- POST /restart-now, the active server is
   * remote (this panel doesn't manage its process). */
  SCHEDULER_RESTART_REMOTE_NOT_SUPPORTED: "SCHEDULER_RESTART_REMOTE_NOT_SUPPORTED",
  /** server/routes/scheduler.js -- PUT /timezone, `timezone` missing, not a
   * string, or empty after trimming. */
  SCHEDULER_TIMEZONE_REQUIRED: "SCHEDULER_TIMEZONE_REQUIRED",
  /** server/routes/scheduler.js -- PUT /timezone, the given value isn't a
   * name Intl.DateTimeFormat (and therefore node-cron itself) accepts as a
   * real IANA zone. Rejected at save time deliberately -- an invalid zone
   * accepted here would only surface as a node-cron throw the night a
   * schedule actually tries to fire, per the 2026-08-29 timezone-picker
   * card's explicit requirement. Carries the rejected value as the `tz`
   * param so the message can name it. */
  SCHEDULER_INVALID_TIMEZONE: "SCHEDULER_INVALID_TIMEZONE",

  /** server/routes/config.js -- PUT /app-settings, `settings` missing or not
   * an object. */
  CONFIG_APP_SETTINGS_REQUIRED: "CONFIG_APP_SETTINGS_REQUIRED",
  /** server/routes/config.js -- PUT /app-settings, caller tried to CHANGE a
   * settings key (rconPassword, Steam credentials, PanelBridge SFTP,
   * discordGuildId, Workshop session cookies, ...) without holding the
   * capability that actually governs it -- panel.settings alone is not
   * enough for these. See SETTINGS_KEY_CAPABILITY in that file. */
  CONFIG_APP_SETTINGS_CAPABILITY_REQUIRED: "CONFIG_APP_SETTINGS_CAPABILITY_REQUIRED",
  /** server/routes/config.js -- PUT /app-settings, corsAllowedOrigins fails
   * validateCorsAllowedOrigins() (too long, too many origins, an origin too
   * long, or an invalid URL/protocol). Carries that function's own specific
   * message as the `reason` param rather than flattening five distinct
   * failure shapes into one generic sentence. */
  CONFIG_INVALID_CORS_ORIGINS: "CONFIG_INVALID_CORS_ORIGINS",
  /** server/routes/config.js -- PUT /app-settings, `serverName` fails the
   * filesystem-safe name regex (interpolated into `${serverName}.ini` and
   * the launch script name downstream). */
  CONFIG_INVALID_SERVER_NAME: "CONFIG_INVALID_SERVER_NAME",
  /** server/routes/config.js -- PUT /app-settings, `modCheckInterval` fails
   * minutesToCheckIntervalMs(). */
  CONFIG_INVALID_MOD_CHECK_INTERVAL: "CONFIG_INVALID_MOD_CHECK_INTERVAL",
  /** server/routes/config.js (12 sites: modRestartDelay,
   * serverAutoUpdateWarningMinutes, httpsPort, panelPort, rconPort,
   * serverPort, panelBridgeSftpPort, panelBridgeSftpPollIntervalSeconds,
   * minMemory, maxMemory, autoExportMaxPerPlayer, reconnectInterval) -- a
   * numeric app-setting fails its requireIntInRange()/parseBoundedInteger()
   * range check. Every site already produces a fully-formed, field-specific
   * message ("X must be a whole number between/from A and B") from those
   * two shared helpers -- carried as the `message` param rather than
   * inventing 12 near-duplicate codes/locale entries for the same shape. */
  CONFIG_INVALID_NUMERIC_FIELD: "CONFIG_INVALID_NUMERIC_FIELD",
  /** server/routes/config.js -- PUT /app-settings, `lanIpAddress` is
   * non-empty and not a valid IPv4 address. */
  CONFIG_INVALID_LAN_IP: "CONFIG_INVALID_LAN_IP",
  /** server/routes/config.js -- PUT /app-settings (14 boolean-shaped keys,
   * one shared check) -- a key that must be strictly true/false received a
   * non-boolean value. Carries the offending key name as the `field` param. */
  CONFIG_INVALID_BOOLEAN_FIELD: "CONFIG_INVALID_BOOLEAN_FIELD",
  /** server/routes/config.js -- PUT /app-settings, httpsCertPath/
   * httpsKeyPath given a non-string, non-empty value. Carries the field
   * name as the `field` param. */
  CONFIG_HTTPS_PATH_NOT_STRING: "CONFIG_HTTPS_PATH_NOT_STRING",
  /** server/routes/config.js -- PUT /app-settings, httpsCertPath/
   * httpsKeyPath points at a path that doesn't exist. Carries `field` and
   * `value` params. */
  CONFIG_HTTPS_PATH_NOT_FOUND: "CONFIG_HTTPS_PATH_NOT_FOUND",
  /** server/routes/config.js -- PUT /app-settings, httpsCertPath/
   * httpsKeyPath points at a directory, not a file. Carries `field` and
   * `value` params. */
  CONFIG_HTTPS_PATH_NOT_A_FILE: "CONFIG_HTTPS_PATH_NOT_A_FILE",
  /** server/routes/config.js -- PUT /app-settings, httpsCertPath/
   * httpsKeyPath exists but isn't readable by the panel process. Carries
   * `field` and `value` params. */
  CONFIG_HTTPS_PATH_NOT_READABLE: "CONFIG_HTTPS_PATH_NOT_READABLE",
  /** server/routes/config.js -- PUT /app-settings, `httpsPort` would collide
   * with the stored `panelPort`. Carries the conflicting port as the
   * `panelPort` param. */
  CONFIG_HTTPS_PORT_MATCHES_PANEL_PORT: "CONFIG_HTTPS_PORT_MATCHES_PANEL_PORT",
  /** server/routes/config.js -- PUT /app-settings, `panelPort` would
   * collide with the stored `httpsPort` -- the reverse direction of the
   * check above, kept as its own code rather than shared: the two
   * messages name different fields and read as different sentences, not
   * one meaning at two sites. Carries the conflicting port as the
   * `httpsPort` param. */
  CONFIG_PANEL_PORT_MATCHES_HTTPS_PORT: "CONFIG_PANEL_PORT_MATCHES_HTTPS_PORT",
  /** server/routes/config.js -- PUT /app-settings, `chatPresets` present
   * but not an array. */
  CONFIG_CHAT_PRESETS_NOT_ARRAY: "CONFIG_CHAT_PRESETS_NOT_ARRAY",
  /** server/routes/config.js -- PUT /app-settings, `chatPresets` exceeds 50
   * entries. */
  CONFIG_CHAT_PRESETS_TOO_MANY: "CONFIG_CHAT_PRESETS_TOO_MANY",
  /** server/routes/config.js -- PUT /app-settings, a `chatPresets` entry
   * isn't a string or exceeds 500 characters. */
  CONFIG_CHAT_PRESETS_INVALID_ENTRY: "CONFIG_CHAT_PRESETS_INVALID_ENTRY",
  /** server/routes/config.js (2 sites: GET /cors-debug, DELETE
   * /cors-debug/blocked) -- the CORS diagnostics hooks were never
   * registered on the app (req.app.get returns a non-function). Identical
   * wording/meaning both sites, shared code. */
  CONFIG_CORS_DIAGNOSTICS_UNAVAILABLE: "CONFIG_CORS_DIAGNOSTICS_UNAVAILABLE",
  /** server/routes/config.js -- POST /cors-debug/reload, the CORS config
   * reload hook was never registered on the app. */
  CONFIG_CORS_RELOAD_UNAVAILABLE: "CONFIG_CORS_RELOAD_UNAVAILABLE",

  /** server/routes/discord.js -- GET /config, PUT /config, POST /start,
   * POST /stop, POST /reset, POST /test-message, PUT /webhook-events, GET
   * /permissions, PUT /permissions: req.app.get("discordBot") returned
   * nothing, i.e. the bot was never constructed on this app instance.
   * Identical meaning at every site (there is nothing to operate on), so
   * one shared code despite differing HTTP status (most are 500, POST
   * /test-message uses 400) -- the status varies, the meaning doesn't. */
  DISCORD_BOT_NOT_INITIALIZED: "DISCORD_BOT_NOT_INITIALIZED",
  /** server/routes/discord.js -- PUT /config, neither a token nor
   * KEEP_EXISTING resolved to one, or guildId was missing. */
  DISCORD_TOKEN_AND_GUILD_REQUIRED: "DISCORD_TOKEN_AND_GUILD_REQUIRED",
  /** server/routes/discord.js -- PUT /config, `guildId` fails the Discord
   * Snowflake format check. Kept distinct from the four sibling ID-format
   * checks below despite an identical regex and message shape: each names
   * a different field, so a reader learns something different from each
   * one -- same lesson as config.js's two port-collision codes. */
  DISCORD_INVALID_GUILD_ID: "DISCORD_INVALID_GUILD_ID",
  /** server/routes/discord.js -- PUT /config, `adminRoleId` fails the
   * Discord Snowflake format check. */
  DISCORD_INVALID_ADMIN_ROLE_ID: "DISCORD_INVALID_ADMIN_ROLE_ID",
  /** server/routes/discord.js -- PUT /config, `modRoleId` fails the
   * Discord Snowflake format check. */
  DISCORD_INVALID_MOD_ROLE_ID: "DISCORD_INVALID_MOD_ROLE_ID",
  /** server/routes/discord.js -- PUT /config, `channelId` fails the
   * Discord Snowflake format check. */
  DISCORD_INVALID_CHANNEL_ID: "DISCORD_INVALID_CHANNEL_ID",
  /** server/routes/discord.js -- PUT /config, `chatRelayChannelId` fails
   * the Discord Snowflake format check. */
  DISCORD_INVALID_CHAT_RELAY_CHANNEL_ID: "DISCORD_INVALID_CHAT_RELAY_CHANNEL_ID",
  /** server/routes/discord.js -- PUT /config, `chatRelayScope` is present
   * but not one of "public"/"no-yell"/"general". */
  DISCORD_INVALID_CHAT_RELAY_SCOPE: "DISCORD_INVALID_CHAT_RELAY_SCOPE",
  /** server/routes/discord.js -- POST /start, discordBot.start() returned
   * false. Carries {{reason}} = describeStartFailure(discordBot.lastStartError). */
  DISCORD_START_FAILED: "DISCORD_START_FAILED",
  /** server/routes/discord.js -- POST /test, `token` missing, empty, or
   * over 200 characters. */
  DISCORD_TEST_TOKEN_INVALID_INPUT: "DISCORD_TEST_TOKEN_INVALID_INPUT",
  /** server/routes/discord.js -- POST /test, `token` fails the
   * URL-safe-base64-ish character check. */
  DISCORD_TEST_TOKEN_INVALID_FORMAT: "DISCORD_TEST_TOKEN_INVALID_FORMAT",
  /** server/routes/discord.js -- POST /test, Discord's API answered 429 to
   * the validation request. */
  DISCORD_TEST_RATE_LIMITED: "DISCORD_TEST_RATE_LIMITED",
  /** server/routes/discord.js -- POST /test, Discord's API answered 5xx.
   * Carries {{status}} = the real HTTP status Discord returned. */
  DISCORD_TEST_API_UNAVAILABLE: "DISCORD_TEST_API_UNAVAILABLE",
  /** server/routes/discord.js -- POST /test, Discord's API answered a
   * non-401, non-429, non-5xx failure status. Carries {{status}}. */
  DISCORD_TEST_REQUEST_REJECTED: "DISCORD_TEST_REQUEST_REJECTED",
  /** server/routes/discord.js -- POST /test, Discord's API answered 401 --
   * the token itself is wrong (not rate-limited, not down, not some other
   * rejection). This is the one pre-existing site with test coverage
   * (discordTestTokenErrors.test.js). */
  DISCORD_TEST_TOKEN_INVALID: "DISCORD_TEST_TOKEN_INVALID",
  /** server/routes/discord.js -- POST /test-message, discordBot exists but
   * `isRunning` is false. */
  DISCORD_BOT_NOT_RUNNING: "DISCORD_BOT_NOT_RUNNING",
  /** server/routes/discord.js -- POST /test-message, sendNotification()
   * returned false -- Discord accepted the request but didn't deliver
   * (bad channel ID, bot lacks permission to post there). */
  DISCORD_TEST_MESSAGE_REJECTED: "DISCORD_TEST_MESSAGE_REJECTED",
  /** server/routes/discord.js -- PUT /webhook-events, `events` missing or
   * not an object. */
  DISCORD_EVENTS_CONFIG_REQUIRED: "DISCORD_EVENTS_CONFIG_REQUIRED",
  /** server/routes/discord.js -- PUT /permissions, `permissions` missing
   * or not an object. */
  DISCORD_PERMISSIONS_OBJECT_REQUIRED: "DISCORD_PERMISSIONS_OBJECT_REQUIRED",
  /** server/routes/discord.js -- PUT /permissions, caller tried to CHANGE
   * a command's Discord authorization tier without holding the panel
   * capability that command maps to (e.g. lowering /rcon's tier to
   * "everyone" without holding rcon.execute). Setting a Discord tier is
   * handing out an authority through a second, unaudited door; you cannot
   * hand out one you do not hold yourself in the panel. */
  DISCORD_PERMISSIONS_CAPABILITY_REQUIRED: "DISCORD_PERMISSIONS_CAPABILITY_REQUIRED",

  // --- server/routes/templates.js + server/services/templateService.js:
  // the "simulation template" system (server/data/templates/*.json, sparse
  // SandboxVars/ini overrides). NOT the same feature as TEMPLATE_NOT_FOUND
  // etc. above -- those belong to serverFiles.js's own separate, simpler
  // embedded /templates routes (a different resource, different storage,
  // different ID space). Same English wording in places ("Template not
  // found") is coincidence, not shared meaning -- reusing the serverFiles.js
  // code here would make one code mean two different missing resources. ---
  /** server/services/templateService.js (5 sites, surfaced through
   * server/routes/templates.js's GET /:id, GET /:id/export, POST
   * /:id/preview, POST /:id/apply, DELETE /:id) -- the template id doesn't
   * match a built-in or a stored user template. Identical meaning all five,
   * shared code. */
  SIM_TEMPLATE_NOT_FOUND: "SIM_TEMPLATE_NOT_FOUND",
  /** server/services/templateService.js (2 sites: previewTemplate,
   * applyTemplate) -- `serverId` doesn't match a configured server. */
  SIM_TEMPLATE_SERVER_NOT_FOUND: "SIM_TEMPLATE_SERVER_NOT_FOUND",
  /** server/services/templateService.js (2 sites: previewTemplate,
   * applyTemplate) -- resolveServerPaths() couldn't derive an ini/SandboxVars
   * path (no serverConfigPath/zomboidDataPath, or serverName fails the
   * filename-safe charset check). */
  SIM_TEMPLATE_SERVER_NO_CONFIG_PATH: "SIM_TEMPLATE_SERVER_NO_CONFIG_PATH",
  /** server/services/templateService.js -- saveTemplate(), the submitted
   * `meta.id` matches one of the built-in templates. */
  SIM_TEMPLATE_BUILTIN_READONLY: "SIM_TEMPLATE_BUILTIN_READONLY",
  /** server/services/templateService.js (2 sites: saveTemplate,
   * importTemplate) -- validateTemplate() rejected the template. Carries
   * {{errors}} = the joined validation error list; a static translation
   * would discard the actual field-level detail. */
  SIM_TEMPLATE_VALIDATION_FAILED: "SIM_TEMPLATE_VALIDATION_FAILED",
  /** server/routes/templates.js (2 sites: POST /:id/preview, POST
   * /:id/apply) -- `serverId` missing from the request body. */
  SIM_TEMPLATE_SERVER_ID_REQUIRED: "SIM_TEMPLATE_SERVER_ID_REQUIRED",
  /** server/routes/templates.js (3 sites, all POST /:id/apply targeting the
   * currently active server) -- serverManager can't report process state
   * (no getServerProcessDetails, a scan that completed with scanFailed, or
   * the state check itself threw). Fails closed: "can't verify" is treated
   * the same as "don't apply," not as "must be stopped." */
  SIM_TEMPLATE_APPLY_STATE_UNKNOWN: "SIM_TEMPLATE_APPLY_STATE_UNKNOWN",
  /** server/routes/templates.js -- POST /:id/apply, the target is the
   * active server and it's confirmed running. */
  SIM_TEMPLATE_APPLY_SERVER_RUNNING: "SIM_TEMPLATE_APPLY_SERVER_RUNNING",
  /** server/routes/templates.js -- POST /:id/apply, the target is a
   * configured-but-not-active server. serverManager only tracks the active
   * server's process, so there's no way to check a different server's
   * running state -- refused rather than assumed stopped. See 2026-08-24
   * conv-template-privesc. */
  SIM_TEMPLATE_APPLY_INACTIVE_SERVER_UNVERIFIABLE:
    "SIM_TEMPLATE_APPLY_INACTIVE_SERVER_UNVERIFIABLE",
  /** server/services/templateService.js -- applyTemplate(), the target
   * server has `isRemote: true`. */
  SIM_TEMPLATE_APPLY_REMOTE_UNSUPPORTED: "SIM_TEMPLATE_APPLY_REMOTE_UNSUPPORTED",
  /** server/services/templateService.js -- applyTemplate(), the template
   * has ini keys to write but the server's .ini file doesn't exist yet
   * (server never started). Previously an uncaught throw from
   * prepareIniChange() that fell into templates.js's generic 500 catch;
   * now caught and returned as a normal {success:false} result like every
   * other applyTemplate failure. Deliberately NOT matching
   * prepareSandboxChange()'s sibling behavior (skip gracefully when
   * SandboxVars.lua is missing) -- that's a real asymmetry worth a second
   * look, but changing which files silently skip vs. hard-fail is a
   * behavior change outside this registry pass's scope; flagged, not
   * fixed, here. */
  SIM_TEMPLATE_APPLY_INI_MISSING: "SIM_TEMPLATE_APPLY_INI_MISSING",

  /** server/routes/debug.js -- POST /fix-writability, `target` is missing
   * or not one of the closed enum values this route supports (currently
   * just "db"). */
  WRITABILITY_TARGET_UNSUPPORTED: "WRITABILITY_TARGET_UNSUPPORTED",
  /** server/routes/debug.js -- POST /fix-writability, the resolved target
   * file doesn't exist (nothing to chmod). */
  WRITABILITY_TARGET_MISSING: "WRITABILITY_TARGET_MISSING",
  /** server/routes/debug.js -- POST /fix-writability, fs.promises.chmod()
   * itself threw (most commonly EPERM: not owned by the panel's process
   * user). */
  WRITABILITY_CHMOD_FAILED: "WRITABILITY_CHMOD_FAILED",
  /** server/routes/debug.js -- POST /fix-writability, chmod succeeded but
   * the file is still not writable afterward -- a real ACL/ownership
   * denial this route can't resolve, not the read-only attribute it's
   * built to clear. */
  WRITABILITY_STILL_BLOCKED: "WRITABILITY_STILL_BLOCKED",
});

/**
 * NOT in this registry, deliberately: `ETIMEDOUT` (server/services/
 * panelUpdateChecker.js, `timeoutError.code = "ETIMEDOUT"`). It's Node's
 * own conventional code for an internal GitHub-API timeout, read back by
 * isRetryableGitHubError() for retry logic -- it is never attached to a
 * client response and was never meant to be user-facing text. Bare
 * `err.code = "<literal>"` assignments like this one (as opposed to a
 * `code: "<literal>"` object-literal property) are NOT scanned by
 * errorCodeRegistry.test.js at all -- see that file's own header comment
 * for why, and for the one known case (`apply_in_progress` in
 * spawnWindowsApplyHelper()) where that same assignment shape IS user-
 * facing and is covered here anyway, just not by the automated scan.
 */

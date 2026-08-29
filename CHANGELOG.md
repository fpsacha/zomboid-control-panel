# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.9] - 2026-08-28

### Fixed

- Horde spawning now uses the coordinate-aware Build 42 API and reports zero-result failures honestly.
- Workshop cookie extraction now ignores expired cookies and pairs fresh credentials from the correct browser profile and domain.
- Vehicle and player map actions now work on click/tap, guard against stale or offline state, and prevent overlapping commands.
- Packaged updates preserve matching frontend/backend bundles and retain recovery data when Windows file operations fail.
- Unsafe client mutations are no longer retried automatically after uncertain transport failures.

## [1.2.8] - 2026-08-27

Completes the configuration-loss fix that v1.2.7 only half-delivered. If you run scheduled
restarts, this release matters more than v1.2.7 did.

### Security

- **Scanning for SteamCMD could run a program from a folder chosen in the same request.** When the
  panel needed the SteamCMD executable, it accepted the folder to look in as part of whichever
  request was being handled, and checked only that the path was absolute and contained no `..` -
  not that it was the folder you had actually configured. An account able to reach those routes
  could therefore point the panel at a directory of its choosing and have it run whatever
  SteamCMD-named file was there. Exploiting it also required some separate way to place a file at
  that location first, and every built-in role that can reach these routes already has equal or
  greater power by ordinary means - but a custom role built around installing the server alone
  would have gained more than its description implies. The executable is now always resolved from
  your saved SteamCMD path: browsing to a new location still works, it simply has to be saved
  before it is used.

- **Testing an RCON connection let you reach any address, not just your server.** The "test
  connection" action connects to whatever host and port it is given, and required only the
  permission to run RCON commands - a permission whose description promises the ability to talk to
  *your configured server*, not to open a connection to any address on your network. An account
  with only that permission could use the panel to find out which internal hosts and ports accept
  connections. Blocking local and private addresses was not an option, because same-machine and
  split-host installations legitimately use exactly those. Testing a connection now also requires
  permission to manage servers - if you can add a server, you can test one - and the target host
  and port are recorded in the log.

### Fixed

- **A scheduled restart could replace your server's settings with defaults.** This is the other
  half of the problem described in v1.2.7, and on its own it is the half that actually bites.
  The panel writes a start script for your server with the save-data location and server name
  written directly into it, and regenerates that script when you start the server from the panel.
  A *scheduled* restart never regenerated it. So if you changed your data path or server name in
  settings and then let a scheduled restart happen before ever starting the server manually, the
  server was launched with the old location still baked into the script. Project Zomboid, finding
  no configuration where it was told to look, created a fresh default one - which is why the
  password stopped working, the mod list emptied, and every sandbox setting reverted. Scheduled
  restarts now refresh the start script and RCON configuration exactly as a manual start does.

- **Nothing automatic ever took a configuration backup.** Backups of your server configuration were
  only ever made when a person edited and saved something, so no restart - scheduled or manual -
  and no automated task ever produced one. The single event most likely to damage a configuration
  unattended was the one event with no backup behind it, which is why the panel's own backup screen
  had nothing to offer when this went wrong. Every restart now takes a configuration backup first.
  A restart that changes nothing does not add a duplicate, so scheduled restarts cannot quietly
  push your real backups out of the retention limit.

- **Importing a Steam collection failed every time for any collection containing another
  collection.** Steam collections can contain sub-collections, and the panel treated those exactly
  like ordinary mods: listed as importable, tracked, written into the server configuration, and
  finally sent back to Steam as items to add. Steam refuses to place a collection inside another
  collection, for any account, regardless of how the browser session was set up - so the import
  failed completely and reported an error that pointed at login credentials, sending at least one
  person looking in the wrong place for days. Sub-collections are now recognised and skipped, with
  a notice saying so, and the error message names the actual cause instead of showing a raw
  protocol response.

- **A failed bulk action showed only the first error.** Selecting many mods and acting on them
  collected every failure correctly but displayed only one, so forty-seven different problems and
  forty-seven copies of the same problem looked identical. The result now says whether the failures
  shared one cause or how many distinct causes there were.

- **The panel reported regenerating a start script it had not written.** When a server was
  configured to use its own launcher file, the panel still attempted to rewrite the start script,
  quietly discarded the resulting error, and logged that it had regenerated the script anyway.
  Anyone investigating a configuration problem would have read that line as proof the script was
  current.

### Added

- **Custom launcher support.** If you point the panel at your own `.bat`, `.sh` or `.exe` instead
  of a server folder, that is now a supported mode rather than something that happened to work.
  The panel launches your file and does not attempt to manage or regenerate it, and the Add and
  Edit Server dialogs say so plainly - including the consequence, which is that memory, admin
  password, data path and server name changes made in the panel will not reach the server unless
  you put them in your script yourself. Existing setups already pointing at a launcher file keep
  working exactly as before. Server paths are now also checked when saved: previously neither the
  install path nor the server path was validated at all.

## [1.2.7] - 2026-08-27

### Security

- **Live log, performance, and player-list streams over the socket connection were gated on being
  logged in, not on permission.** The equivalent web requests already checked the specific
  capability each of those needed - diagnostics access for logs and performance, player-list access
  for players - but the socket subscriptions feeding the dashboard's live updates only checked that
  a session existed. A moderator account, which never holds diagnostics access under the default
  roles, could still subscribe to the same live diagnostics stream an administrator sees. All three
  subscriptions now check the same capability their web equivalents require.

- **A password typed into an RCON command reached the logs, the command history, and a live
  broadcast to every connected dashboard, in plain text.** Typing `adduser` to whitelist a player -
  or anything else typed directly into the RCON console - is the one command that carries a real
  password, and six separate places wrote it out unredacted: the saved command history, a
  debug-level log line, two warning-level log lines shown when the server rejects a command, the
  log line written for every command run through the console, and the live broadcast that pushes
  each command and its response to every dashboard subscribed to the log stream. Two of the six
  fire at the default log level, so no special configuration was needed to leak. All six now redact
  the password before it leaves the function that would have written or sent it.

- **The server's RCON and join passwords were readable in plain text in more places than the
  console.** Scanning for existing servers copied a discovered server's real RCON password into the
  browser and back on every scan. The raw and structured configuration-file editors returned the
  live password in the response and displayed it in a visible field. Saving a configuration template
  kept a permanent, plain-text copy of whichever password was set at the time, with no way for a
  later password change to ever reach it. All four now mask or omit the password at the point it
  would have left the server, and saving a masked field back no longer overwrites the real password
  with the placeholder.

- **A role granted a broad automation capability could reach specific, more sensitive actions it was
  never meant to.** Kicking, banning, or banning by IP or Steam ID; god mode, invisibility, noclip,
  and healing any player; and scheduling a server restart, save, or broadcast message each has its
  own capability when reached directly - but all of them could also be reached through the generic
  PanelBridge command relay or the task scheduler using only the broader capability those systems
  require, bypassing the narrower one entirely. Not reachable through any built-in role, which
  already holds both capabilities involved, but a custom role built around automation or
  world-event permissions could gain moderation or GM-tool power as an unintended side effect. All
  of the affected actions now also check the same specific capability their direct route requires.

- **Sending a message as the server, or endangering a specific player, required only the same
  permission as changing the weather.** Eleven actions that can put words in the server's mouth or
  put a named player in danger without their consent - admin and general chat broadcasts, spawning
  zombies near or behind a player, triggering a horde, and playing a gunshot, alarm, or other sound
  at a player's location - shared a capability with genuinely world-wide, non-impersonating effects.
  They now have their own capability, admin-only by default for both moderators and technicians,
  including when scheduled rather than triggered directly.

- **Eight of the permissions an administrator can grant undersold what they actually allowed.**
  Diagnostics access can copy the entire data directory - including every server's RCON password and
  the panel's own signing secret - to any path outside a short system-directory blocklist. RCON
  access grants read access to the full, unredacted command history. Mod management can extract the
  operator's live Steam session from their browser and overwrite the panel's stored Steam
  credentials. Five more descriptions had similar gaps. All eight now name what they actually grant,
  in every language the panel supports.

- **Deleting a server's install folder or map data checked that the target folder looked right, not
  that it was the right folder.** Deleting an install folder only required a marker file with a
  recognizable name to exist somewhere in the target directory - trivial to create anywhere on the
  host - and the map-chunk deletion tools accepted a custom path validated mostly by matching pieces
  of its name against expected words. Both now require the path to genuinely belong to a server or
  save location the panel already knows about, not just look like one.

- **The panel handed out a live Steam login token over its own API.** Extracting Steam credentials
  from a browser profile returned the session cookie and login token in the response body, so an
  account with mod-management permission - which includes the technician role, below administrator -
  could ask one endpoint for the panel host's live Steam session. The extraction now saves the
  credentials on the server and returns only whether it worked; the token never crosses the wire.

- **A server name could be made to point somewhere it should not.** The panel validates server
  names carefully everywhere it manages several servers, but one older settings screen accepted the
  name without checking it, and that value was used to build a file path. A name containing path
  navigation could therefore read or overwrite files outside the folder it was meant to stay in,
  including the name of the startup script the panel runs. Setting it required an account with
  permission to change panel settings, and the affected code path only runs on installations still
  using the original single-server settings rather than a server profile - but neither is a reason
  to leave it. The name is now checked when it is saved *and* again every time it is read, so an
  unsafe value already stored on an existing installation stops working too, without any migration
  step. It is ignored rather than used, and the panel behaves as though no name were set.

### Fixed

- **A server's saved settings could be replaced with a blank configuration when it started.**
  Before starting a server, the panel checks whether that server already has a configuration file,
  so that it can add the remote-console settings it needs on a genuinely new one. That check looked
  in only one of the four locations the rest of the panel recognises - different Project Zomboid
  installations and versions keep the file in different places, and the panel has always accepted
  all four everywhere else. On an installation whose real configuration lives in one of the other
  three, the check could not see it, concluded the server had never been set up, and wrote a fresh,
  almost-empty configuration in its place. Project Zomboid then supplied its own built-in defaults
  for everything that file did not mention - the server password, the mod list and every sandbox
  setting - which from the outside looks exactly like the server reverting to default. This was also
  the one configuration write that did not take a backup first, so the panel's own backup screen
  could not undo it. The check now looks in every location the panel recognises, and only treats a
  server as new when no configuration exists in any of them. Reported by a user whose settings and
  mod list reverted after a restart; this closes a demonstrated gap in the panel's own handling of
  those locations, and whether it was the exact cause of that report is still being confirmed.

- **Two backups taken within the same millisecond silently destroyed one of them.** Startup-script
  backups and configuration-file backups were both named from a timestamp precise to the
  millisecond, so two taken close together - an edit saved twice quickly, several servers backed up
  in the same pass - produced the same filename, and the second silently overwrote the first with no
  warning. Both now add a counter to the name the moment a collision would occur, so every backup
  taken is kept.

- **Fixing the collision above broke which backup got deleted first.** The counter added to a
  colliding backup's filename sorts before the plain name it disambiguates from as plain text, so
  the configuration-backup pruner - which compared filenames as text rather than the time the file
  was actually created - could rank the newest backup in a colliding pair as older than it really
  was, and delete it first while keeping the truly older one. This is very likely the cause of a
  report received today that backups looked inconsistent, with the most recent one over a week old.
  The pruner now sorts by the backup file's real creation time.

- **Two restore requests arriving close together could both run at once.** The panel refuses to
  start a second backup restore while one is already in progress, but the flag that blocks it was
  only set after an earlier check finished, leaving a window where two requests - a double-click
  before the button disabled, two admin sessions, a retried request - could both pass the check and
  restore concurrently, silently mixing or losing data. The flag is now set before that check begins.

- **Docker panel updates no longer stop after building with a duplicate container-name error.**
  The updater now gracefully replaces an existing manually created panel container before Compose
  recreates it, and uses the same safe replacement path during rollback.
- **A server created by the setup wizard could not start at all.** The admin password you typed was
  never saved with the server, so the panel launched Project Zomboid without it - and on a brand new
  server, where the game has to create the admin account, it stopped and asked for the password on a
  console that was not there, then exited. The logs showed only a Java error. Reported by two people
  on Discord, whose workaround - setting the password again on the server's own screen - was itself
  the clue: that was the only path that ever saved it. The wizard now saves it, and if a first start
  would fail for this reason the panel refuses and tells you where to set it instead of launching a
  server it knows will die. Three other settings were being dropped the same way, including the
  Docker container name, and a test now fails the moment a fourth one is.

- **Starting a stopped server quietly overwrote your startup script.** Every start rewrote
  `StartServer.bat` and its Linux twin with the panel's own generated version, so any Java or JVM
  flags you had added by hand disappeared with no warning - and the only nearby explanation said the
  panel would "detect" the file, which is the opposite of what it did. The panel now notices when the
  file is not the one it last wrote, keeps a timestamped copy beside it, and tells you where that
  copy is. Your configuration changes still take effect every time.

- **The UPnP tick box did nothing.** It was saved in two places and read in none; the setting that
  actually matters lives in the server's own configuration file, which only one screen ever wrote.
  Setting it in the wizard, or later on the server's own page, now reaches that file - and the panel
  says plainly that the change applies the next time the server starts, because that is when the game
  reads it.

- **"Restart initiated" was all you ever got.** Starting a restart or running a scheduled task by
  hand reported success immediately - meaning the request was accepted, not that it worked - and a
  genuine failure was written only to a log file you would never see. The real outcome now reaches
  you when it happens, wherever you are in the panel.

- **A badge could say three mods needed updating long after they were updated.** The count was only
  ever sent when it went up, never when it went down, so it could be wrong in one direction for the
  rest of the session. And the OIDC "Discovery succeeded" panel stayed on screen after you edited the
  client secret, implying credentials had been verified when they had not - so a broken login could
  be saved with a green tick in front of it.

- **Wiping a server destroyed the whole world with no way back.** Deleting the map, players or
  accounts had no backup step at all, while the equivalent chunk-deletion tools have offered one
  for a long time - and the confirmation only reassured you that your settings were safe, never
  saying the world itself was gone for good. A wipe now takes a backup first, on by default, and
  stops without deleting anything if that backup fails. The dialog says plainly what is about to be
  lost, and shows the backup's progress so a large world does not look like a freeze.

- **Closing the tab during an install lost the outcome entirely.** The wizard reported progress to
  the page and nowhere else, so a refresh, a stray click, or simply waiting elsewhere during a
  multi-gigabyte download meant the result - success *or* failure - arrived to nobody. The wizard
  now remembers an install was started and offers to pick it up where you left off.

- **"Failed to create server entry", on a server that was created.** Registering the new server and
  switching to it shared one error path, so a problem with the second step reported the first step
  as broken. The two now report separately.

- **The panel told you, in every language, to set an .ini key Project Zomboid does not recognise.**
  It said `LuaChecksum=false`; the real key is `DoLuaChecksum`. Anyone who followed the instructions
  exactly left the setting at its default and PanelBridge silently never worked. Corrected in 26
  places across all six languages, including the demo data, which was reading the wrong key for real.

- **The panel sent you to a button that had been renamed.** "Test SFTP" became "Verify and prepare
  SFTP", but the setup walkthrough and an SFTP error message still used the old name in all six
  languages. The last one lived in the message shown when the failure is unrecognised - exactly when
  you are already stuck.

- **Saving any setting failed when SFTP was switched off** (#118). The panel shipped `22` as the
  default SFTP port and then refused it, because one port rule was shared between ports the panel
  opens itself and ports it connects to elsewhere. Those are now separate rules, and the fields of any
  switched-off feature - SFTP, HTTPS, mod auto-restart, update warnings, auto-export and
  auto-reconnect - no longer block unrelated saves. Turning a feature on and configuring it in the
  same save still validates, because the check reads the settings you are submitting rather than the
  ones already stored.

- **The dashboard said "Container down" while the Docker panel showed it running** (#114). The status
  badge was reading a local process scan that cannot see inside another container. It now reads the
  container itself, and says "unknown" rather than "down" when it genuinely cannot tell. The badge
  turned out to be one of four places that made the same mistake: the dashboard headline (which also
  decided whether Start and Stop were available), the server cards, and the sidebar status dot -
  which had no such check at all, so it was wrong on every page for Docker and remote servers
  alike.

- **Number fields snapped back to a default the moment you cleared them.** Clearing a port to retype
  it silently restored `27015` or `16261` under your fingers. Fields across the setup wizards, server
  settings, players, scheduler, mod options, the item spawner and the map tools now keep what you
  typed and refuse on save instead. Memory sliders and summary screens no longer render `NaN` while
  a field is mid-edit.

- **Advice you could see but not act on.** The PanelBridge status badge told you where to go and was
  not clickable; empty screens could not offer a destination at all. Both now work. RCON
  authentication failures and permission-denied errors also point at the place that fixes them, and
  the login screen explains why local account recovery is unavailable instead of staying silent.

### Added

- **Swap is now shown alongside memory on the dashboard.** Host memory sitting at 95% is either
  perfectly normal or nearly fatal, and the panel had no way to tell you which. The telemetry card
  now reports host swap on Windows, Linux and macOS. A machine with no swap configured is shown as
  exactly that - a real answer, not an alarm - and if the figure genuinely cannot be read, it says
  so rather than reporting zero.

### Changed

- **Error messages now speak your language, and say what to do about it.** The panel already
  translated most of its failures, and then showed you the raw English one anyway, because the screen
  read the wrong half of the reply - so a French user saw an English sentence that had been sitting
  translated in the same file all along. Roughly a hundred and thirty places across every page now
  use the translated message, and point at the screen that fixes the problem where one exists. SFTP
  and player-moderation failures gained proper translated messages of their own, keeping the specific
  detail - the path, the error code - rather than replacing it with something vaguer.

- **Warnings now match what is actually at stake.** Stopping a server looked as alarming as deleting
  one, on one page but not another; kicking or banning a player from the moderation tools happened on
  a single click with no confirmation at all, while the same action elsewhere asked first. Fifty-two
  confirmation and warning styles were reviewed against a single rule - how recoverable is it, and
  does it affect anyone but you - so that the serious ones stand out instead of blending into the
  routine ones.

- **Buttons for actions your role could not perform were often still clickable.** The server was
  already the real authority - every one of these routes was already gated there - but roughly a
  dozen pages let you click through to a request the server would then refuse, sometimes only after
  a confirmation dialog and a wait. Servers, Mods, Players, Discord, the RCON console, Scheduler,
  Chat, the Dashboard, server setup, Backups, ChunkCleaner, WorldMap, Templates, and server
  configuration now disable or hide those controls up front, and a new lint rule stops a future page
  from shipping the same gap.

- **Installation guides for every setup**, in `docs/install/`: Windows, Linux, Docker and Unraid,
  rented/managed servers, and a symptom-first troubleshooting guide. They ship inside the release
  archive, so they work with no internet. The README is now a one-read chooser rather than five
  platforms interleaved.

## [1.2.6] - 2026-08-25

### Fixed

- **Horde spawning now creates zombies on Build 42 instead of reporting a false success.** The
  PanelBridge was calling a different `VirtualZombieManager` overload that does not accept map
  coordinates, then treating the resulting no-op as a confirmed spawn. It now uses the coordinate
  API, counts returned zombies, and reports failure when none were created.
- **Docker panel updates no longer stop after building with a duplicate container-name error.**
  The updater now gracefully replaces an existing manually created panel container before Compose
  recreates it, and uses the same safe replacement path during rollback.
- **Docker-managed servers no longer appear stopped on the Dashboard.** Active status now reads the
  mapped container from Docker instead of scanning only the panel host, refreshes after lifecycle
  actions, and reports an unknown state when Docker status cannot be verified.
- **Manual backups no longer retain hundreds of thousands of ZIP entries in the Node.js heap.**
  Large saves now stream file data while writing the ZIP central directory to disk, and abandoned
  backup temporary files are cleaned up before the next run.
- **Manual upgrades no longer leave a permanent false update-failure banner.** If the panel is
  already running a newer version and the obsolete staged binary is gone, the old pending marker
  is cleared automatically; genuine failed applies remain visible and retryable.
- **New Docker installs no longer start an unreachable Project Zomboid server.** The primary
  Docker setup now uses a one-command all-in-one installer when the panel owns PZ. It validates
  Docker, generates secrets and LAN access settings, pulls exact release images with a local-build
  fallback, installs PZ, and publishes both required UDP ports automatically. The panel-only setup
  remains available for existing servers.
- **Conflict scans with heavily overlapping mod files no longer exhaust the panel's Node.js heap.**
  The grouped pair output now has its own global budget, preventing a bounded file index from
  expanding into millions of duplicate pair-file rows while building the response.
- **Mod conflict results now stay truthful after load-order changes.** Critical, Medium, and Low
  pair totals are mutually exclusive; winner badges refresh after reordering; cached scans detect
  order changes; incomplete scans cannot report a clean result; and labels distinguish
  higher-impact conflicts from low-impact file overrides.
- **Mod and update shortcuts now open the relevant settings directly.** Workshop Collection's
  Configure action opens the Mods tab, and the sidebar Update badge opens the Updates tab.
- **Reviewing an unresolved `Mods=` diagnostic now opens the setting that can fix it.** The action
  opens Server Configuration filtered to `Mods`, carries the exact unresolved IDs into a visible
  warning, and no longer sends operators to the unrelated missing-dependencies screen.
- **Lifecycle operations now fail closed when process state is unknown.** Server start/restart,
  backup restore, Docker panel updates, status reporting, and the Windows force-stop path no
  longer treat a failed process scan or unconfirmed kill as a clean stop.
- **Backup and scheduler settings reject malformed values instead of silently coercing them.**
  Six-field cron schedules, invalid booleans/counts, malformed numeric query limits, and invalid
  discovered ports are now refused or safely bounded.
- **Scheduled-task mutations roll back completely when rescheduling fails, and deleting a missing
  task no longer reports success.**
- **Standalone and discovery metadata now stays truthful.** Linux launchers no longer promise a
  fixed port, Steam Finder preserves false dedicated flags, and malformed discovery settings are
  reported instead of replaced with defaults.
- **Backup archives are safer and more reliable.** Same-millisecond filename collisions are
  avoided, symbolic links are not followed outside the save directory, and audit-log failures no
  longer turn completed backup/restore operations into hangs or false failures.
- **Player toggles and RCON ports now require correctly typed input, and diagnostics preserve an
  unknown server state instead of displaying a false stopped state.**
- **Server Finder now handles A2S challenge responses, and PanelBridge enforces its command budget
  for rejected or duplicate queue entries as well as successful commands.**
- **Multi-server profiles reject malformed bodies, ports, flags, and empty updates; startup will
  not auto-launch a duplicate server while process detection is unavailable.**
- **Active-server RCON changes now report reconnect failures instead of silently claiming a refresh.**
  Malformed persisted RCON ports fail closed, and per-server status keeps healthy profiles visible
  when another profile contains invalid data.
- **Scheduler, configuration, player, and PanelBridge endpoints now fail cleanly on malformed bodies
  and boolean values.** Cron previews and unattended jobs share the same five-minute guard, including
  bare minute ranges, and malformed task/profile IDs cannot be truncated into another record.
- **Game-port guidance now matches the derived UDP-port limit.** The valid maximum is 65534, while
  RCON retains the full 1-65535 range.

## [1.2.5] - 2026-08-25

### Fixed

- **Standalone self-updates could apply a stale executable from a mismatched release.**
  Updates now verify that the downloaded binary and release archive share the
  expected version and checksum, and the release pipeline refuses to publish
  artifacts built from a different package version.

- **Fresh all-in-one installs could fail with SteamCMD's misleading "Missing file
  permissions" error.** SteamCMD and the panel now receive an explicit writable
  home directory instead of inheriting an invalid root home in non-interactive
  containers.

## [1.2.4] - 2026-08-25

### Fixed

- **Scheduled backups could exhaust the packaged panel's Node.js heap on large
  saves.** Backup traversal now uses bounded directory handles and feeds ZIP
  entries one at a time instead of materializing directory listings or the
  archiver's recursive glob queue.

## [1.2.3] - 2026-08-24

### Fixed

- **INI validation feedback**: identify the invalid INI values that keep the save action disabled, instead of leaving the operator without an explanation.

## [1.2.2] - 2026-08-24

### Fixed

- **Reverse-proxy requests triggered `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`** when Express saw
  `X-Forwarded-For` but did not trust the configured nginx hop. `TRUST_PROXY` now accepts a hop count,
  IP, subnet, or comma-separated IP/subnet list, and the Docker/systemd templates document how to set it
  without enabling unsafe trust-all behavior (#110).

- **World Map fallback zoom stopped at low resolution when build discovery returned HTTP 403.** The
  hardcoded 42.20.0 fallback now preserves its verified level-22 tile ceiling while still falling
  back to coarser tiles for individual missing edge tiles.

- **Windows server-state checks could not distinguish an empty successful process scan from a failed
  PowerShell probe.** The panel now invokes PowerShell explicitly, reports diagnostics, and fails
  closed when the probe returns an error or stderr output.

- **World Map bridge polling could overlap while large responses were still in flight.** Player and
  vehicle/safehouse polling now uses single-flight gates to prevent competing requests and reduce
  memory pressure.

- **Windows release packages could contain an LF-only `Start.bat`.** The launcher generator now
  writes CRLF line endings for reliable Windows execution.

## [1.2.1] - 2026-08-23

### Fixed

- **World Map went black above ~137% zoom** while player and vehicle markers kept showing (#109). The
  panel assumed the map was rendered to full depth and asked for tiles that do not exist. It now checks
  how deep the map really goes, and covers any missing tile with the next coarser one instead of nothing.

- **Scanning a large mod library for conflicts could crash the panel.** The file index was capped per
  mod but not in total, so it grew until memory ran out - 150 mods was enough to exhaust 4GB. Now capped
  overall, and it tells you when the conflict list is incomplete rather than showing a partial one.

- **A scheduled task could be set to run every few seconds.** The five-minute minimum only understood
  5-field cron; a 6-field one had its seconds column read as minutes. Seconds-precision schedules are
  now rejected with a clear message.

- **A config template could rewrite your RCON password, ports and public server name.** The list of
  protected settings was read from the template itself, so a template declaring it empty switched the
  protection off. That list is now fixed in the panel and a template may only add to it.

- **Applying a template to a non-selected server skipped the are-you-stopped check.** The panel can only
  inspect the active server, so it now declines and asks you to switch to that server first.

- **Twelve places showed "something went wrong" when the panel knew exactly what failed** - clearing the
  server log, seven actions on the Debug page, the Dashboard auto-start setting, and loading your
  servers, scheduled tasks and backups. All now report the real reason.

- **Two more places where text or a button ran off a phone screen:** the Server Log's file path, and the
  button row above Server Configuration that pushed Save past the right edge.

- **Scanning a large mod library froze the rest of the panel.** The scan never paused, stalling the
  player list, RCON and every other tab. Just under 0.7s in a single block, now under 30ms.

- **Ban and Unban by Steam ID accepted anything you typed**, unlike the allowlist field beside them. All
  three now enforce 17 digits.

- **The panel's own port accepted any number, then sent you to a dead address.** Restart Panel pointed
  the browser at whatever you typed while the panel fell back to 3001. Out-of-range ports are now
  refused, as on the HTTPS port field.

- **Out-of-range numbers in the Install and Quick Setup wizards were silently replaced.** Type port 80
  and the server installed on 16261 with no message. Those fields now refuse and name the valid range.

- **Mod thumbnails did not load for anyone in 1.2.0.** Image tags cannot send a login header, and last
  release's group-wide permission gate rejected them before checking anything else. The exemption is now
  explicit at the gate, with a test.

- **Add/Edit Server accepted out-of-range game and RCON ports.** Only one of the four fields had a range
  check; all four now do.

- **Removed Create Faction and Remove Faction from the Events page.** Project Zomboid provides no way to
  do either from a mod, so both had always failed.

- **Four more places could act on a server whose state the panel could not determine** - deleting chunks
  or a region, restoring a backup, applying a template, and clearing stale locks. All now refuse rather
  than treating "cannot tell" as "stopped".

- **A sandbox setting could report saved and be gone after restart.** The game's world-save result was
  discarded, so a failed save still reported success. It is now checked and reported.

- **Several RCON-only actions reported success while doing nothing**, because only one wording for
  "the game refused this" was recognised. Kicking never sent the reason, releasing a safehouse cannot
  work over RCON at all, and god mode/invisibility on another player used the self-targeting command.

- **Three more places reported success without checking:** the second half of a template apply, a
  Discord reconnect after changing token or server ID, and the reload half of save-and-reload.

- **The off-screen-button bug fixed for Backups was hiding on three more screens** - Scheduler, Debug
  Logs and Players. The fix now lives in one shared component instead of being copied a fifth time.

- **Several disabled buttons and badges explained themselves only to a mouse.** The Mods page
  Add/Remove buttons, the PanelBridge connection badge and a mod conflict badge now work for keyboard,
  touch and screen-reader users.

- **Player traits never loaded on Build 42.** All three method names the bridge tried are absent from
  B42. Fixed alongside two of the same kind: enum sandbox options and inventory progress values.

- **Deleting the active server left the panel talking to the deleted one.** The database updated but the
  connection layer was never told. It now uses the same path as activating a server.

- **Password changes had no length limit and were silently truncated.** The hashing stops reading after
  72 bytes, so two long passwords sharing a prefix unlocked the same account. Overlong passwords are now
  rejected.

- **The Server Log's "Clear" button deleted the real log file** while its tooltip promised it did not -
  permanently, with no confirmation. It now asks first and the tooltip is honest.

- **The "server is running" notice claimed every setting needed a restart**, untrue on three of the four
  screens it appeared on. It now says that some changes need a restart and the save confirmation tells
  you which.

- **The map repeated the same format-discovery lookup for every tile** on first load. One lookup is now
  shared.

- **Missing map tiles were indistinguishable from a page frozen mid-load.** The upstream service is
  missing a block of Build 42 tiles; confirmed-missing tiles now render as a deliberate-looking area.

- **Map Cleanup read your entire save twice on open.** Both answers now come from one pass - on a
  147,000-chunk save, 15.3s to 5.6s.

- **Behind a reverse proxy, every visitor looked local.** Local-machine account recovery decided by
  request address, and with nginx or Caddy in front every request arrives from localhost. The panel now
  detects the proxy, stops claiming it can tell, and points you at the two paths that still work.

- **"Cannot verify whether the server is stopped" - the panel could never confirm a stopped server on
  Windows.** An empty process list read as a failed check, so anything needing a confirmed-stopped
  server refused forever. Three related faults fixed alongside. Not new in 1.2.0 - the old code read a
  failed check as "stopped", so a wipe or update could have run against a live server; 1.2.0 made it
  visible.

- **Thirteen faults in the in-game bridge**, found by the first automated audit of all 96 commands -
  mostly reporting success without checking. Hotwires reported as crashes, unverified horde counts, and
  the same fault in healing, teleport, god mode, noclip, sandbox settings and the power/water controls.

- **A Diagnostics check silently stopped answering on large saves.** The stale-lock scan timed out and
  showed nothing at all - no error, no warning - while the abandoned scan kept running. It now stops
  cleanly and says it could not finish. The manual clear-stale-locks action had no time limit at all.

- **Map Cleanup opens roughly twice as fast**, following the earlier fix: the initial save listing
  walked every chunk file before you had picked a save, then the next step walked them again. 13.7s to
  6-8s on a 147,000-chunk save.

- **The wipe preview froze the whole panel while counting** - over twenty seconds of unresponsiveness on
  a large save, for every signed-in admin. It no longer blocks, and says so if it cannot finish rather
  than presenting a possibly-incomplete total.

### Added

- **In-game actions now report whether they were confirmed** - confirmed by reading the game's state
  back, done but not verifiable, or no verification at all (meaning your bridge mod is older than the
  panel). Toggles now wait for that confirmation instead of switching the instant you click.

- **The panel is now available in Haitian Creole.** Kreyol ayisyen joins the other five languages - all
  55 sets of text, around 7,000 strings. Translated carefully from a shared glossary but not by a native
  speaker; the genuine judgment calls are listed in `client/src/locales/GLOSSARY.ht.md` for review.

- **Two more Debug page health checks:** one reports how many mods have no Workshop thumbnail and why
  (and stops re-requesting them once it knows Steam is unreachable), the other lists RCON commands the
  game itself refused over the last day.

## [1.2.0] - 2026-08-22

> **TL;DR:** This is a big update. The panel now has broader multilingual support,
> translated server settings and contextual help, stronger config, server lifecycle,
> mod, workshop, backup and authentication workflows, richer support bundles, and
> a substantial reliability, security and release-tooling pass. Earlier releases
> below cover Build 42 compatibility, PanelBridge, Docker, map handling, Discord,
> and the fixes that made the panel safer to operate day to day.

### Added


- **The support bundle now knows about everything this release added.** The zip you generate from the
  Debug page is what someone looks at when they are trying to help you, and it had not kept up. It
  now also reports your single sign-on configuration, which roles exist and who holds them (so
  "why can this person not see X" is finally answerable), how the World Map worked out which map
  build to use - including whether `curl` is even installed on the host - the health of the panel's
  own database writes, your recent backup runs, the Discord bot's connection state, and whether the
  game server was actually running at the moment the bundle was made. It also records which
  language the panel was being used in - and says so plainly when it cannot tell, rather than
  guessing English, because a wrong guess in a support file is worse than an honest gap. Passwords, tokens and client
  secrets are still masked, and the bundle's own "what is not in here" list has been kept accurate.

- **Help where people actually get stuck.** A small "?" next to a setting now explains what it does,
  what happens if you get it wrong, and what the sensible choice is - in all five languages. It
  opens on tap as well as hover, so it works on a phone, and it is reachable by keyboard and
  readable by a screen reader. There are fifteen of them across nine screens, and that number is
  deliberate: most settings in the panel already show a permanent description under the label, and
  adding an icon there would only repeat what is already on screen. These are the places nothing was
  explaining - things like the difference between a Workshop item's numeric ID and the internal mod
  ID it actually registers (leave one out and part of the mod silently will not load), what RCON is
  and why changing its password elsewhere makes the panel lose control of the server, that applying
  a config template overwrites rather than merges, and what a Discord bot's requested permissions
  do - and, just as importantly, what they do not.
- **Server setting names and descriptions can now be translated.** The Server Configuration page
  draws its 154 server settings and 269 sandbox settings from a schema that held its text in English
  only, so that page stayed English no matter which language you picked. The text now resolves
  through the translation system, falling back to the English in the schema wherever a language has
  no entry yet - so nothing changes until a translation exists, and English never needs one.
- **The panel is now available in German**: every screen, dialog, error message and health check -
  6,855 pieces of text across 54 files - has been translated, and Deutsch now appears in the
  language picker alongside English, French, Simplified Chinese and Spanish.

  German addresses you as *du*, the way a tool you run for your own server should, and buttons read
  as instructions rather than commands (*Speichern*, *Neu starten*). Project Zomboid's own
  vocabulary stays where a German-speaking player expects it: *Mod*, *Chunk*, *Sandbox* and
  *Safehouse* keep their English forms, as do mod IDs, Workshop IDs, chat tags like `[ADMIN]`,
  `SERVER.INI` section names and SteamCMD's own output - so what you read in the panel still matches
  what you see in a real log. A shared glossary keeps one word per concept across every screen.

  German is longer than English - roughly a third longer, on average - so labels that live in narrow
  spaces were written short on purpose: status chips, tab names, table headers and the CPU / RAM /
  Netz / Disk row on the server card keep the compact wording German server tooling already uses.

  Sentences that name something you picked - a mod, a player, a preset - were rewritten so the
  grammar around them cannot go wrong. German changes the article and the ending depending on the
  word being substituted, which no translation can know in advance, so those messages put the name
  after a colon or at the front of the sentence instead of guessing.

- **The panel is now available in Spanish**: every screen, dialog, error message and health check -
  6,855 pieces of text across 54 files - has been translated, and Español now appears in the
  language picker alongside English, French and Simplified Chinese.

  Spanish addresses you directly, the way a tool you run for your own server should, and keeps
  Project Zomboid's own vocabulary where a Spanish-speaking player expects it: mod, chunk and
  sandbox stay as they are, along with mod IDs, Workshop IDs, chat tags and SteamCMD's own output.
  A shared glossary keeps one word per concept across every screen.

- **The panel is now available in Simplified Chinese**: every screen, dialog, error message and
  health check - 6,855 pieces of text across 54 files - has been translated, and 简体中文 now appears
  in the language picker alongside English and French. The choice is remembered in your browser.

  Project Zomboid's own vocabulary was kept where a Chinese-speaking player would expect it: mod IDs,
  Workshop IDs, chat tags like `[ADMIN]`, `SERVER.INI` section names and SteamCMD's own output are
  left exactly as the game and the tools print them, rather than translated into something you could
  not match against a real log. A shared glossary keeps one word per concept across every screen -
  the same term for "server", "backup" or "permission" wherever you see it.

  A test enforces that Chinese has every key English does, with no gaps and no leftovers, so the
  translation cannot quietly rot as the panel grows.

- **Panel settings, Integrations and Operations are reachable before you add a server.** With no
  server configured, thirteen of the fifteen sections in the menu were switched off - including
  three that have nothing to do with a game server. You can now open your own panel settings and set
  up Discord on a fresh install. The sections that genuinely do need a server still say so, and now
  say it in a tooltip you can actually see rather than one that takes a second to appear and never
  appears at all on a touchscreen.

- **Roles & Permissions groups its capability list, and the pages that load slowly say so.** The
  permission matrix opens with twelve groups you can collapse, so a long list is navigable instead
  of endless; everything starts expanded, so nothing changes unless you want it to. Users, Roles and
  Settings now show the shape of the page while it loads rather than a bare spinner.

- **A Sign-in (OIDC) settings screen: single sign-on can be set up from the panel itself, without
  editing environment variables and restarting.** OIDC (Google, Authentik, Keycloak, Azure AD and
  anything else that speaks the standard) previously had to be configured by editing environment
  variables and restarting; it can now be configured under Access Control > Sign-in, and the change
  takes effect immediately. Enter your provider's address, client ID and secret, and press Test
  Connection to check the provider answers before you save.

  The redirect URI - the one value your identity provider needs and that you cannot guess - is
  worked out from the address you are actually using to reach the panel, so it is correct behind a
  reverse proxy, and is offered with a single action that fills it in and copies it. The client
  secret is stored outside the main database, is never sent back to the browser (not even masked),
  and is never shown back to you once saved. If you had already set any of this through environment
  variables, those still win, per field, so nothing you pinned deliberately gets overridden.
- **You can now delete a user**: the Users screen could create and list accounts but there was no
  way to remove one. There is now. The panel refuses to delete the last account that can manage
  users and roles, so you cannot empty out your own administrators, and it refuses to let you
  delete your own account - ask another administrator to do that, since deleting yourself would
  sign you out mid-action with nothing left to sign back in to.

  **Deleting someone takes effect immediately, not whenever their session would have expired.** If
  they are signed in right now on another machine, their very next click fails. This was verified
  by signing a real session in and deleting the account underneath it, not by reading the code.
- **A Users screen, and a new Access Control section in the menu**: there is now a screen listing
  everyone who can sign in to the panel, and a form to add someone. The role picker offers every
  role that actually exists on your panel, including ones you created yourself, rather than only
  the three built-in ones. Users and Roles & Permissions have moved out of Settings & Tools into
  their own Access Control section, since managing who can do what is not a tool.

- **The three Access Control screens now look like the rest of the panel**: Users, Sign-in and
  Roles & Permissions were built last and did not quite match the twenty screens around them.
  They now carry a short label above their titles the way the panel's other sections do - one that
  names the page rather than the section, since no two sibling pages elsewhere in the panel repeat
  the same one. Users' header icon matches its own menu icon, the Sign-in form is split into
  Provider and Advanced groups presented the way Settings presents its own groups, instead of seven
  fields of identical weight, and the permissions grid's twelve group headings read as headings
  rather than as more rows. No colours, fonts or components were invented for this - every change
  reuses something the panel already does elsewhere.

- **Server install and update progress now reports in French**: the running commentary while the
  panel installs or updates a server - downloading, extracting, verifying, saving RCON settings,
  installing the PanelBridge mod, and the completion and failure lines - is now written in French
  instead of English.

  **SteamCMD's own output is deliberately left exactly as SteamCMD prints it.** Those lines are the
  tool's words, not the panel's, and translating them would mean showing you French that SteamCMD
  never produced and that would not match a real SteamCMD log if you compared them. The two kinds of
  line were previously indistinguishable to the panel; they now travel differently, and a raw
  SteamCMD line is structurally incapable of being translated by accident.

- **Debug > World Map now reports in French too**: the fourteen health checks behind the World Map
  tab - whether the map tiles were found, which game build they came from, whether the PanelBridge
  mod is running and heard from recently, and which save the panel is reading - are now written in
  French rather than falling back to English. Checks whose wording genuinely changes with the
  situation get a properly written French sentence for each case, not one sentence with a word
  swapped out. As with the Diagnostics tab, a test enforces that every check has both languages and
  that no entry is left behind for a check that was removed.

- **Debug > Diagnostics now reports in French**: 46 of the 47 health checks - their titles, their
  verdicts and the specific details they carry, such as how many mods are affected or which folder
  is missing - are now written in French rather than falling back to English. Checks whose wording
  changes with the situation, not just the numbers, get a properly written French sentence for each
  case instead of a translated sentence with an English word dropped into it.

  One check is still English: the configuration-drift check, which stitches together a variable
  number of separate findings into one sentence. Translating it correctly means changing what the
  server sends, not just the wording, so it was left alone rather than half-done.

  A test now enforces that every check the panel can produce has both an English and a French
  entry, and that no leftover entry survives for a check that was removed - so this cannot quietly
  rot the next time someone adds a health check.
- **The parts of the panel that appear on every screen are now in French too**: the
  connection-status indicator, the server and PanelBridge status badges, the disk-space warning
  banner, both crash-recovery screens, the keyboard shortcuts dialog, the folder browser, the
  "add discovered server" wizard, and every Simulation Templates dialog. Previously a French
  operator could open any of these from an otherwise-French page and land back in English.
- **A Roles & Permissions screen, so the permission system is something you can actually see and
  use**: until now roles and their permissions existed only inside the server, with no way to look
  at them. There is now a screen at Roles & Permissions showing every role as a column and every
  permission as a row - 27 permissions in 12 groups. Tick a box to grant a permission, untick it to
  take it away, and it saves as you go. You can create a role, rename it, delete it, and put a
  person on it.

  The screen refuses, with the reason spelled out, any change that would leave nobody able to manage
  users and roles - so you cannot lock yourself out of your own panel by editing the wrong box. The
  permission list is read from the server rather than written into the screen, so it cannot drift
  out of date. Available in English and French.
- **A custom role can now actually be given to someone**: previously the permissions work let you
  create a role but only the built-in administrator, technician and moderator roles could be assigned
  to an account. Any role can now be assigned. The panel refuses a change that would leave nobody able
  to manage users and roles, so it is not possible to lock yourself out by moving the last
  administrator onto a role that cannot undo it.
- **Regenerate the login signing key from Settings**: an administrator can now replace the key that
  signs login sessions, from Settings > Security. You would do this if a backup taken before this
  release - which still contains the old key in plain text - may have been exposed. It signs out
  every user on every device immediately, including you, and the screen says so twice before you
  confirm it.
- **Roles are becoming editable, not fixed**: the panel now stores roles in its database with a list
  of what each one is allowed to do, instead of three names hard-coded into the program. Upgrading
  changes nothing you can see - your existing administrator, technician and moderator accounts keep
  exactly the permissions they have today - but it is the foundation for creating your own roles and
  editing what each may do. The screen for that comes next.

- **French, phase 2 - Dashboard, Console and Players**: the dashboard, the whole Console page (server
  log viewer, RCON console, quick commands, broadcasts and command history) and the whole Players page
  (roster, kick and ban dialogs, item and vehicle spawning, XP, powers, notes, activity log and
  character import/export) are now available in French, alongside sign-in, first-run setup and the
  navigation. Project Zomboid's own log tags and Steam ID formats stay as the game writes them. The
  remaining screens follow.

- **French language support (phase 1)**: sign-in, first-run setup and the sidebar navigation can now
  be switched between English and French, with the choice remembered in your browser. The remaining
  screens are still English only and will be translated in stages.

- **User roles**: accounts can now be created as **administrator**, **technician** or
  **moderator** instead of every account being an administrator. Technicians can operate the server
  — start, stop, backups, mods, configuration — while moderators hold in-game player authority, and
  only administrators manage user accounts. The last remaining administrator cannot be demoted, so a
  panel cannot be locked out of its own account management.

- **Sign in with SSO (OIDC)**: administrators can now enable sign-in through an external identity
  provider — Google, Discord, Authentik, Keycloak, or any standards-compliant OpenID Connect
  provider — alongside the existing username and password login, which always keeps working as a
  fallback even if SSO is unavailable. An external sign-in must already be linked to a local
  account to succeed; unrecognised identities are refused rather than automatically given access.

- **First-run setup now requires a setup token**: the very first account can no longer be claimed by
  whoever reaches the panel first. On a fresh install the panel prints a one-time setup token to its
  startup log, and the setup screen asks for it before creating the administrator account. Restarting
  the panel reprints the same token if it is lost, so this cannot lock anyone out. Previously a panel
  reachable over the network before setup was completed could be taken over by any stranger who found
  the port, and every page answered without a login until setup finished - now everything except the
  setup screen itself refuses until an account exists.

- **Exposure warning on startup**: a panel still awaiting first-run setup that is reachable on a
  network address now says so loudly in its startup log, naming the address, rather than leaving the
  window silently open.
- **Adding a new language is now a two-step job**: translators can add a language by registering one
  line and dropping in a folder of translation files - nothing in the application code needs
  changing. Language names are shown in their own language (Deutsch, not German), and a check fails
  loudly with the exact missing keys if a translation is incomplete. See
  `client/src/locales/README.md`.

### Fixed

Ordered so what actually hurts you comes first: things that can lose data or leave you locked out,
then who can do what, then places the panel told you something that was not true, then general
reliability, then interface and translation.

#### Data loss, dangerous actions, and things that never worked at all

- **Deleting a server's files could be done while the server was still running, and without
  confirming anything.** Removing a server with "delete its files too", and clearing a stuck
  install folder, both go through an endpoint that recursively deletes an entire Project Zomboid
  install directory - not just the saves. Wiping the world, which does comparable damage, refuses
  unless the request explicitly confirms it and refuses while the server is running; deleting the
  files checked neither. It only ever ran from a screen that asks you first, so nothing could have
  gone wrong by accident - but the only thing standing between a mistake and a deleted install was
  a screen remembering to ask. It now refuses both cases, and, like wiping, refuses outright when
  it cannot tell whether the server is running rather than assuming it is stopped.


- **On a phone, the Backups page could push the buttons for your backups completely off the side of
  the screen.** When a backup's filename was long - which it is whenever the server has a
  descriptive name, since the filename is built from it - the rows in the Backup Files list grew
  wider than the screen, carrying the view, restore, download and delete buttons out of sight. That
  list cannot be scrolled sideways, so those buttons were not just awkward to reach, they were
  unreachable: on the one page where they are how you get your data back. Most obvious in German or
  another language with longer labels, but it happened in English too. Rows now stack on narrow
  screens, so the buttons stay reachable and the filename stays readable.

- **Every support bundle ever generated was silently missing five pieces of information.** The
  section describing your server's configuration - the settings checksum, the effective settings,
  the mod list, the Workshop item list and the map - was failing to build because of a missing
  internal reference, and the safeguard that stops one faulty section from destroying the whole zip
  quietly swallowed the error and moved on. So the bundle always looked complete and never was. It
  builds correctly now.


- **The panel was quietly deleting backups you uploaded yourself**: automatic cleanup kept only the
  most recent backups and treated an archive you had uploaded by hand exactly like one the panel
  made on a schedule. On the default settings that meant a backup you deliberately saved was deleted
  within a couple of days, with nothing to tell you it had happened. The code even carried a note
  saying uploaded archives were protected - they were not. They are now: automatic cleanup skips
  them entirely.

- **If the panel could not tell whether your server was running, it assumed it was stopped.** The
  check that looks for the running game process reports a plain "not running" both when the server
  is genuinely stopped and when the check itself fails - an unreadable process list, a permissions
  problem, a hung scan. Four things trusted that answer and acted on it. **Wiping the world** could
  therefore proceed against a server that was actually running. **Updating the server through
  SteamCMD** could too - it even caught the check's own error and carried on regardless. The
  unattended auto-updater would skip saving and shutting down cleanly first. And an automatic mod
  restart could mark the update as handled without ever performing it, so it would never be retried.
  All four now tell the difference between "stopped" and "cannot tell", and refuse to act on the
  second.

- **Three things stopped working without saying so.** Mod update checking silently fell back to a
  weaker local-only comparison during a Steam outage, and reported nothing. Disk monitoring returned
  exactly the same "plenty of space" shape whether the disk was healthy or the volume had become
  unreachable, so the low-disk warning went quiet at precisely the moment it mattered. And the
  short-lived cache used when editing configuration on a remote server was keyed only on the server
  name, so changing the host or credentials and immediately reading a file could serve content
  fetched over the old connection. All three now report their real state.


- **"Success" messages that were not true**: 42 places in the panel showed a green success message
  as soon as the request came back, without checking whether the action had actually worked. Banning
  or unbanning a player, giving an item, spawning a vehicle, triggering a scheduled task, restarting
  the server and sending a broadcast all reported success even when the game server was offline and
  nothing had happened. The two worst were the restart and the broadcast: an operator would announce
  a restart to players and walk away, or believe players had been warned, when neither had taken
  place. All of these now show the real error the server returned.

- **If you locked yourself out of the local administrator account, the recovery form could never
  work.** Resetting a lost local password requires a one-time token that the panel writes to
  `data/reset-token.txt` - but the form had no field to type it into. The token was therefore always
  empty, the submit button was enabled anyway, and pressing it failed every time with a complaint
  about the missing token. This is the panel's only self-service way back into a locked-out local
  admin account, and it could not be completed by anybody. The form now has the field, and the
  button stays disabled until you fill it in.

- **A wrong HTTPS certificate path or port could stop the panel starting at all, permanently**:
  Settings accepted any text in the HTTPS certificate path, key path and port fields without
  checking them, and saved it with a success message. Nothing went wrong until the next restart -
  possibly days later - at which point the whole panel failed to start, not just HTTPS, and stayed
  down until someone edited the stored setting from the filesystem. Anyone without that access was
  locked out of their own panel by a single save. Those fields are now checked when you save, with
  a message naming the problem; and if a path that was valid later becomes invalid - moved, deleted
  or permissions changed - the panel now starts with HTTPS switched off and says so, instead of
  refusing to start.

- **The panel would not start at all on some Windows machines**: the launcher started the panel by
  its bare filename, which relies on Windows searching the folder the launcher is sitting in. That
  search is switched off by a setting some corporate and security-hardened Windows images apply, and
  when it is off the panel never starts - you get "is not recognized as an internal or external
  command", five retry attempts, and a "Panel crashed" banner that tells you nothing useful. The
  launcher now uses the full path. The rest of the launcher was checked for the same mistake; this
  was the only place it occurred.

- **The World Map was blank - every single tile was 404ing.** The upstream map host moved: tiles
  and the per-build descriptors are now served from `tiles.pzmap.org` and no longer sit under a
  `/maps` path segment. The panel was still asking for the old address, so nothing loaded at all.
  Only part of the site moved, which is what made this awkward - the map's build list is still on
  the original host and asking the new one for it fails outright - so the panel now keeps the two
  apart and uses the right host for each. The browser-direct fallback, used when a deployment lets
  the browser reach the map but not the panel, had the old path hardcoded separately and was fixed
  too. **Debug > World Map** was also reporting on the wrong address, in all five languages; a
  diagnostic that is wrong about the thing it exists to diagnose is worse than none, so it now
  probes what the panel actually requests.

- **"Ping" on the Server Finder never worked, and said "N/A" instead of saying so.** The ping
  request was sent without the panel's own credentials, so the server rejected it before it ever
  reached the game server being tested - every time, for every signed-in user. The page then showed
  "N/A", which is exactly what an unreachable server looks like, so a working server and a broken
  feature were impossible to tell apart. Pings now return real times.

- **You can now edit server configuration without stopping the server.** The panel used to refuse
  every configuration save while the server was running - the `.ini`, sandbox settings, spawn points
  and spawn regions - on the grounds that Project Zomboid would overwrite the file on shutdown and
  throw your work away. We tested that against a real Build 42 server rather than assuming it: a
  shutdown does not touch those files at all, and the next startup keeps an edit made while the
  server was running. That applies to a forced stop as well as a clean one. So the refusal was
  protecting against something that does not happen. Saving now works whenever you like, and tells
  you plainly that the change reaches the running game when the server restarts. **Restoring a
  backup and applying a template still require a stopped server** - those replace a whole file at
  once rather than editing values, and that is a different question we have not yet answered.

- **The Sandbox tab claimed to reload settings it cannot reload.** After saving sandbox settings the
  panel sent the game a "reload options" command and could report "saved and reloaded". That command
  only re-reads the main server `.ini`; it has never applied sandbox values. Until now the claim was
  unreachable - the save itself was blocked while the server ran, so the command always failed and
  you saw the honest "restart to apply" message instead. Allowing saves on a running server would
  have made it reachable for the first time and it would have "succeeded" while doing nothing. The
  panel no longer makes that claim for sandbox settings; it tells you to restart, which is true in
  every case.

- **Changing a mod setting told you to do something impossible.** Editing a mod setting reported
  "Stop the server before editing configuration" - but the Mod Settings page cannot load with the
  server stopped, so following the instruction left you with no way back in. The panel already had
  the honest message written for this case and a generic error lookup was burying it. **And the
  change now actually sticks.** The panel was refusing to save the setting to disk while the server
  ran, on the assumption that Project Zomboid rewrites its configuration on shutdown and would throw
  the edit away. We tested that against a real Build 42 server instead of assuming it: a clean
  shutdown does not touch `SandboxVars.lua` or the server `.ini` at all, and the next startup
  preserves a change written while the server was running. So the refusal was protecting against
  something that does not happen, on the one setting that could never be saved any other way. Mod
  settings now apply to the running game and survive a restart.

- **Turning mods on could silently leave some of them switched off.** When the panel writes your mod
  selection into the server configuration, a mod whose internal ID cannot be worked out is left out
  of the active list while still being subscribed - so the game downloads it and never loads it,
  and the panel used to report plain success. Saving now warns you when that happens and names the
  mods affected, so "I subscribed it and it never loads" has a visible cause instead of being a
  mystery. The underlying limitation is unchanged: a mod whose ID cannot be resolved still cannot
  be enabled automatically.

- **A panel with no server configured yet could mistake somebody else's Project Zomboid server for
  its own.** Before you point the panel at a server it had no name to work with, so it assumed
  `servertest` - which is Project Zomboid's own default server name. If the machine was already
  running a vanilla PZ server, that server matches, and the panel identified it as *definitely*
  the one it manages. On a box where you installed the panel alongside a server you were already
  running, it could report that server's state as its own before you had finished setting anything
  up. A panel that does not know which server it manages now says so instead of guessing, and
  treats any process it cannot identify as exactly that.

- **Servers created without a name all shared one.** If you did not fill in the in-game server name,
  the panel permanently wrote `servertest` - Project Zomboid's own default name - into its database
  as if you had chosen it. Everything downstream then treated that as your real server name forever,
  so two servers set up this way would quietly point at the same configuration and save files. The
  panel now takes a name from the display name you did provide, and refuses to create the server if
  neither is usable, rather than inventing an identity and writing it down.

- **The French wording for "Wipe server" said "reset", not "erase"**: the dialog title, the
  confirm button and both menu entries used *Réinitialiser* - the word this panel uses for ordinary,
  recoverable resets elsewhere - directly above body text correctly warning that the action deletes
  everything permanently. A French-speaking operator read a reassuring title over an alarming
  description. It now says *Effacer*. The same mismatch on the "Wipe the world" permission label is
  fixed too. Delete-old-backups and chunk deletion were checked and were already correct.

#### Who can do what

- **Anyone who could reach the panel could create an administrator account, with no password**:
  requests to the account-management endpoints were not checking who was calling them. On any panel
  that had finished setup, a request with no credentials at all could list every account, create a
  new administrator, change any account's role, or sign every user out. The screens always implied a
  login was required; the server was not enforcing it. It is enforced now. **If this panel has ever
  been reachable from outside your own machine, review your accounts and treat any you did not create
  yourself as suspect.** This was not introduced by any recent change - it dates back several months.
- **Permission checks now refuse by default instead of allowing by default**: underneath the
  account-management bug above sat the reason it was possible - if the panel could not tell who was
  making a request, the permission checks treated that as "nothing to check" and let it through. That
  was written when it was safe, and it quietly stopped being safe. Every request now has an identity
  attached before any check runs, and if one is ever missing, the panel now refuses by default. The
  practical difference: a future mistake of this kind produces a door that will not open, which
  someone reports the same day, instead of one that is open to everybody, which went unnoticed for
  months.
- **Anyone who could reach the panel could see where every player was standing**: one address used
  by the live map returned, for every player currently online, their name, their exact position in
  the world, and how injured they were - without asking for a login. On a PvP server that is enough
  to hunt someone. It now requires an account with permission to view players, which all three
  built-in roles have, so nothing you already use stops working. A comment in the code describing
  this address as deliberately public has been corrected, so it does not get re-opened later.
- **Downloading a backup now needs permission**: every other backup action - create, delete,
  restore, upload - required a permission, but downloading required none, so any account of any
  role could pull down a complete copy of your world save. If a backup had ever been taken with the
  panel's own settings file included, that copy also contained the stored password hashes for every
  account. Downloading now needs its own "download backups" permission.

  **On upgrade**, that permission is granted automatically to any role that could already manage
  backups, so nobody loses access they had yesterday. You can take it away again per role from
  Roles & Permissions.
- **A role that could only manage scheduled tasks could actually run any server command**: the
  "manage scheduled tasks" permission let someone save a task containing any command at all and
  then run it - including shutting the server down or banning players - and those runs did not
  appear in the command history. Anyone who built a limited role such as a backup operator was
  granting far more than the permission's name suggested. Saving, editing or running a task whose
  command is not one of the ordinary ones (restart, save, broadcast) now also requires the
  permission for running server commands directly.
- **Role permissions now actually restrict access everywhere**: every panel route has been reviewed
  and now enforces the role that matches what it does. Diagnostics and database maintenance are
  administrator-only; mods, server files, scheduling and integrations are administrator and
  technician; in-game player actions - kick, ban, whitelist, teleport - are open to moderators as
  intended, and read-only status pages stay open to everyone signed in. Previously, once any account
  existed beyond the first administrator, many of these were reachable by any signed-in user
  regardless of role, including the endpoints that back up and compact the panel database.
- **Server start, stop, install and configuration endpoints now enforce technician-or-above**:
  starting, stopping, restarting or force-stopping the server; installing or updating it through
  SteamCMD; editing its RCON or network settings; and browsing the host filesystem to set any of
  that up were previously reachable by any signed-in account, including moderators — the same gap
  the role-permissions review above closed for diagnostics and file management, just missed in this
  file. In-game tools (weather, world events, server messages, releasing a safehouse) and read-only
  status pages are unaffected and stay open to everyone signed in.
- **PanelBridge integration and panel configuration endpoints now enforce technician-or-above**:
  connecting or reconfiguring the PanelBridge mod link, its own diagnostics and item/vehicle catalog
  scans, saving the game world through it, editing the panel's server config or RCON settings, and
  CORS diagnostics were previously reachable by any signed-in account, including moderators. In-game
  GM tools that live in this same file — weather, zombie and player events, sound, chat, utilities,
  character import/export — are unaffected and stay open to every role, same as the equivalent tools
  elsewhere in the panel.
- **Restoring a backup no longer comes with the Technician role by default**: previously any
  administrator or technician account could roll the live world back to an older backup. Deleting,
  pruning or creating backups is routine housekeeping and stays with Technician, but restoring one
  discards everything since that backup for every player currently on the server — a decision about
  other people's time, not a maintenance task — so it now ships granted to Administrator only.
  **This is a default, not a restriction.** "Restore a backup" is its own entry in Roles &
  Permissions, so you can tick it back on for Technician, or for any custom role you have made,
  whenever that suits how your team works.
- **Only the panel's own startup script may run inline**: the browser was previously told to allow
  any inline script on the page, which weakens the main defence against a script being injected into
  it. It is now restricted to the exact fingerprint of the panel's own theme bootstrap, recalculated
  on every start so it can never go stale. **Inline styles are still permitted** - that half is
  scoped as separate work and is not fixed by this change.
- **A built-in role could be deleted, despite the screen saying it could not**: the Roles &
  Permissions screen greys out delete for the built-in administrator, technician and moderator
  roles and says they cannot be removed. Only the button was stopping it - the server never
  checked. Anyone able to manage roles could delete the administrator role itself, not just remove
  someone from it. The server now refuses outright, so the message on screen is now true of the
  system and not just of the button.
- **Giving a custom role permission to manage users now actually works**: the screens for listing
  and creating accounts were still checking for the built-in administrator role by name, rather than
  checking the permission. So you could tick "manage users" for a role you had created, the panel
  would save it and show it as granted, and that role still could not see the user list - the tick
  box now means something. Changing an account's role already worked correctly; it is the other two
  that were inconsistent with it.

  One deliberate exception, left as it is on purpose: regenerating the login signing key is still
  administrator-only and cannot be delegated to a custom role. It signs everybody out of every
  device immediately, including you, and there is no way to undo it or wait it out - so it is not
  something one role should be able to do to another.
- **RCON password, Discord bot token and Steam session moved out of `db.json`**: these credentials now
  live in their own files rather than inside the database, so none of them are swept into a database
  backup by accident. Existing installs move them automatically on the first start after upgrading -
  same values, safer location, nothing to re-enter. **Any backup taken before this upgrade still
  contains all three in plain text inside `db.json`**, and those are not fixed retroactively.
- **The login signing key no longer lives inside `db.json`**: the key the panel uses to sign your
  login sessions has moved into its own file, so it is no longer copied along every time `db.json` is
  backed up. Existing installs move it automatically on the first start after upgrading - it is the
  same key in a new place, so nobody is signed out. **Any backup taken before this upgrade still
  contains the old key in plain text**; those are not fixed retroactively. If one of them may have
  been exposed, an administrator can regenerate the key, which immediately signs out every user on
  every device. There is no button for this yet - it is available to administrators through the
  panel's API at `POST /api/auth/regenerate-jwt-secret`, and a Settings control is coming.

#### Places the panel told you something that was not true

- **The World Map now actually works out which map build to use, instead of always guessing.** The
  panel is supposed to ask the map service which build is current. It had been failing every time
  and silently falling back to a build number written into the panel - which happened to be right,
  so nothing looked wrong. Two separate things were broken. The address it asked no longer exists;
  the map site moved to a different one some time ago, so every request was answered with "not
  found". And the request itself was being refused by the map site's bot protection, which rejects
  the panel's own network library but not the standard `curl` tool the panel already ships with -
  so discovery now goes through that instead. There was also a third problem waiting behind those
  two: the panel walked the list of builds from oldest to newest and stopped at the first usable
  one, so a genuinely newer build would never have been reached even once the requests started
  working. It now asks the map service directly which build is current, and only falls back to
  searching the list - newest first - if that one is not usable yet.

- **The Debug page and the Chunk Cleaner named map websites the panel had stopped using.** Their
  labels still pointed at the addresses the map tiles used to come from, two moves ago - in all five
  languages, because the English was wrong and every translation faithfully repeated it. The labels
  now simply say which game build they refer to, which is the part that was ever useful: both builds
  are served from the same place now, so the address could no longer tell them apart, and the Debug
  page already shows the exact address it is testing directly underneath.

- **The panel could stop noticing new Project Zomboid map releases without ever saying so.** The
  World Map works out which map build to use by asking the upstream map site, and if that lookup
  fails it falls back to a build number written into the panel. That fallback had been failing
  silently - and because the hardcoded build happens to match the current one, everything looked
  healthy. The first sign of trouble would have been the next time Project Zomboid released a map
  update: the panel would have quietly carried on serving the old geometry, and it would have shown
  up as a map that is subtly wrong rather than as an error. **Debug > World Map** now has its own
  check for this and says plainly when the panel is using the fallback and why, in all five
  languages. The underlying lookup is still blocked by bot protection on the upstream host, which
  is not something the panel can fix from its side - so the point of this change is that you will
  find out, instead of finding out from a wrong map.

- **"Test connection" on the Sign-in page did not test your credentials.** It fetched the
  provider's public configuration document and reported success - which proves only that the issuer
  URL is reachable. A wrong client ID, a wrong client secret, or an unregistered redirect URI all
  passed the test, and you found out by signing out and getting stuck. The test now actually
  authenticates against the provider's token endpoint and can tell the three cases apart: your
  credentials are accepted, your credentials were rejected, or it could not determine an answer -
  and "could not determine" is never reported as success.

- **Crash Logs showed the wrong folder's logs if you had moved your data directory**: the Crash
  Logs tab looked for crash reports next to wherever the panel happened to be started from, rather
  than in the data directory you configured. If you have ever used the "move my data folder"
  setting, that tab has been showing you the old location - and on a developer machine it was
  displaying an unrelated log file entirely, with test data in it, presented as genuine crash
  history. Every other log view in the panel already got this right. A file cache used by the
  SFTP connection had the same fault and is fixed too.

- **"Database accessible" always claimed to know nothing**: the Diagnostics check that reports on
  your database always printed "? collections, 0 MB" no matter what was actually stored. It was
  counting the wrong kind of value and reading a size that was never provided, so it could never
  have shown a real answer. It now reports the real figures.

- **Invented server on an unconfigured panel**: the Server Configuration page and its sibling
  file, sandbox and spawn-point pages no longer present a fabricated `servertest` server — fully
  populated and fully editable — when no server has actually been added through Server Setup or My
  Servers. Those pages now correctly report that nothing is configured; a genuinely configured
  server, including one relying on settings carried over from an older install, still loads exactly
  as before.

- **Stopping the server usually worked but often said it had failed.** When Project Zomboid shuts
  down it closes the panel's command connection as it goes - which is what a successful shutdown
  looks like. The panel treated that closed connection as a failed command, so pressing Stop could
  report an error while the server was, in fact, stopping perfectly normally. The panel also skipped
  marking the server as stopped in its own records when that happened, so its state could disagree
  with reality until the next status check. Scheduled restarts logged the same false failure.
  A shutdown that ends with the server closing the connection is now recognised as what it is: a
  successful stop. The two cases that genuinely mean the command never arrived - the server already
  being stopped, or still starting up - are still reported as failures.

- **The player activity log could record actions that never happened.** Kicks, access-level
  changes, god mode, invisibility, noclip, and granting items, XP or vehicles were all written into
  the activity history as soon as the panel sent them - without checking whether the game server
  actually accepted the command. If the server was offline or restarting, the command quietly went
  nowhere while the history recorded it as done. Reviewing what an administrator had done would
  then show actions that never reached the game. Bans and whitelist changes were already fixed for
  this; these eight had been missed. The history now records an action only once the server has
  confirmed it.

- **Bans recorded that never happened**: banning, unbanning or voice-banning a player — by username
  or by SteamID — while the game server is offline or restarting no longer writes the action into
  the panel's own ban list and history as though it had succeeded. Previously the in-game command
  silently did nothing while the panel recorded it anyway, so its ban list could permanently
  disagree with the server.

- **Scheduled tasks could vanish from the Scheduler page even though they were fine.** The page
  loaded its tasks alongside several other things, and if any one of those other requests hiccupped
  - the preset list, the run history, the scheduler's own status - the whole load was discarded and
  the page said "no tasks scheduled". Your tasks were there, still scheduled, still running. Each of
  those side requests now fails on its own without taking the task list down with it.

- **The Bridge status could say "offline" long after the bridge came back.** The panel stops polling
  the game bridge when it sees a failure, and the thing that restarts the polling was the polling
  itself - so once it stopped, nothing was left to notice a recovery. Restarting the game or
  reloading the mod would reconnect the bridge while the panel went on showing "Bridge offline"
  until you reloaded the page. It now keeps checking and recovers on its own.

- **The Console could keep showing RCON as "online" after the connection had died.** The page only
  recognised two specific raw connection errors, but the server translates most real disconnects
  into readable sentences first - so the messages the page was watching for never arrived, and the
  badge kept its last known good state. Sending an announcement did not update the badge at all,
  even on the errors it did recognise. Both now react to the messages the server actually sends.

- **Accents were stripped from ban reasons before they reached the server**: a ban reason written
  in French was recorded intact in the panel's own log but arrived at the game server with the
  accented letters removed entirely - *répété* became *rpt* - so the two records disagreed and
  nothing told you. Accented letters are now converted to their closest plain equivalent
  (*repete*), which the server can carry, and the same conversion is used for broadcasts.

#### Reliability and clearer feedback

- **Windows panel recovery after a crash**: on Windows the panel launcher only restarted the panel
  when an update was being applied, so any other crash left it stopped — waiting on a keypress —
  while the game server carried on running unattended. It now relaunches automatically, backing off
  between attempts, and still stops and shows the exit code if the panel is crashing repeatedly
  rather than hiding a genuine problem behind an endless restart loop. A clean shutdown stays shut
  down. Takes effect in the next Windows build.

- **Stuck "stop in progress" after a wedged kill**: force-stopping the server no longer hangs
  forever if the operating system's own kill command stalls — for example under antivirus
  interference. The panel gives up waiting after a bounded time, stays able to start, stop and
  restart the server afterwards, and tells you plainly when it could not confirm the process
  actually exited instead of silently reporting success.

- **Server Setup could hide the one thing stopping you finishing.** An admin password is required
  before a server can start, and the final button refuses without it - but the field sat inside the
  collapsed Advanced Options section among genuinely optional toggles. You could work through every
  step and only discover the requirement at the review screen at the end. It now has its own visible
  card, like the RCON settings, and the step tells you it is missing at the point you can act on it.
  Both the quick and full setup flows.

- **Failed actions showed a blank or generic error instead of saying what went wrong**: on the world
  map, every vehicle action - repair, refuel, replace battery, remove, hotwire - reported failure as
  a bare "Error" with no explanation at all. Teleporting a player, calling an airdrop and spawning a
  vehicle were the same. The specific messages had been written, but the code holding them could
  never run, so nobody ever saw them. 29 of these unreachable failure paths were found across the
  world map, Settings, Console, Debug, Backups, Servers, Chat and Events; 13 of them were showing
  you meaningfully worse information than intended.

- **"Test Connection" failures said "Action failed" instead of naming what failed**: a request that
  the server answered with an explicit failure was being reported under a generic title, because the
  code meant to handle that case could never run. The real reason was already shown underneath; now
  the heading matches it.

- **"Failed to start bot - check configuration" now tells you what is actually wrong.** The Discord
  bot reported the same sentence whatever went wrong, and the real reason was being thrown away one
  line before the response was written - the server knew, logged it, and then discarded it. The most
  common cause is not a configuration mistake at all: this bot needs the **Server Members** and
  **Message Content** privileged intents, which are toggles in the Discord Developer Portal that are
  off by default and are separate from the token. A correct token and correct IDs fail every time
  until those are on, and nothing in the panel said so. Start failures now name the cause - missing
  intents, a bad token, no token at all, or Discord not answering - and the intents message says
  plainly that it is not a credentials problem. The reason also stays on screen: it is recorded
  against the bot's status rather than shown once, so leaving the page and coming back still shows
  why the last start failed, and it clears itself as soon as a start succeeds.

- **Setting up single sign-on now tells you what it found.** There are presets for Google,
  Authentik, Keycloak, Azure AD, Okta and Auth0 that fill in the shape of the issuer URL and the
  scope each expects, so you are editing an example rather than guessing the format from scratch -
  Keycloak wants a realm in the path, Azure wants a tenant, and nothing in the panel used to say so.
  Custom is still the default and behaves exactly as before. After a successful test the panel also
  shows what the provider actually returned - its endpoints and the scopes it advertises - so you
  can check it against your provider's admin screen instead of taking "success" on trust.

- **A start command the panel warns about could still be saved.** The server edit dialog flags a
  start command containing characters it will not accept, but saving went through anyway - and the
  server applies the same rule when you actually press Start. So you could save, be told it saved,
  and only discover the problem later with nothing pointing back to the dialog. The dialog now
  refuses it at the point you save.

- **RCON reconnect targeting**: a panel with no server configured no longer repeatedly attempts RCON
  logins against whatever happens to be listening on the default port, and once a server is added it
  is targeted correctly — including one that has no RCON password set yet — instead of silently
  falling back to defaults. A server added while the panel is running is picked up on the next
  reconnect attempt, with no restart.

- **RCON reconnect stability**: a failure while automatically restarting Panel Bridge after RCON
  reconnects no longer has a path to crash the entire panel process.

- **Server-running detection after a panel restart**: the panel now remembers the process it started
  and rechecks that one directly first, falling back to the full host-wide process scan whenever
  there is any doubt — the process died, or its command line no longer matches. Recognizing an
  already-running server after the panel restarts or updates is faster, and no longer depends solely
  on scanning and pattern-matching every process on the machine.

- **Map Cleanup took far too long to open, and the wait got dramatically worse the bigger your
  save was.** Two separate causes, both fixed. The scan read your save's chunk directories strictly
  one at a time, so the wait tracked the *number of directories* rather than the amount of data -
  measured on a test save, splitting the same 9,000 files across more directories took four times
  longer with no extra data to read. On a NAS or a spinning disk, where each read costs far more
  than on an SSD, that difference is much larger. Separately, the page asks for the file list and
  the storage totals at the same time, and the totals were walking parts of the save up to three
  times over, competing with the file list for the same disk. The totals are now gathered in a
  single pass, and both walks read a bounded number of directories at once instead of either
  one-at-a-time or all-at-once. On the same test save the file list went from 1.5s to 0.4s and the
  totals from 1.25s to 0.65s - but the number that matters is the two together, which is what
  actually happens when you open the page: it was swinging between 1.7 and 12.4 seconds and is now
  a steady 1 second. The unpredictability was most of what made it feel broken.

- **Dragging the Map Cleanup map was jerky.** Panning or drawing a selection redrew the whole map
  on every single mouse movement the browser reported - dozens of full repaints a second, each one
  redrawing every visible chunk. The map now paints at most once per frame no matter how fast the
  mouse moves: in a test firing 60 movements in a single burst, the old code would have attempted 60
  repaints and the new code does exactly one. The map itself is unchanged - same chunks, same
  colours, same selection behaviour - it simply stops doing work it was throwing away.

- **Two places recorded a failure and then lost it.** A diagnostics auto-fix that failed, and the
  inline actions on the Events page (vehicle repair, alarms, locks, adding a player to a safehouse),
  both reported problems only as a pop-up notification. Once it faded, or you changed tabs, there
  was no sign anything had been attempted. Both now leave a record you can still see afterwards.

- **A failed backup left an error card on screen forever.** When backup creation failed immediately,
  the error card was shown but never scheduled to clear itself, unlike every other backup error. It
  now clears like the rest.

- **The Voice Ban button did nothing the first time you pressed it.** If you opened Voice Ban for a
  selected player and left the name field as-is, the first press was silently ignored - no error, no
  message - and only a second press worked. It now works on the first press.

- **On Windows, a failed installation told you to edit a Linux service file.** When the install path
  is not writable, the panel appended advice about editing `zomboid-panel.service` and restarting
  the service - instructions that do not exist on Windows, which is a fully supported platform here.
  The advice is now shown only on Linux.

- **The lost-password button could describe the wrong thing.** For an administrator who had already
  saved recovery codes, the button offered to create a recovery file while actually opening the
  recovery-code entry form. It now says what it does.

#### Interface and translation

- **Users, Roles & Permissions and Sign-in have moved into Panel Settings.** They used to be their
  own "Access Control" section in the left sidebar; they are now tabs alongside the panel's other
  settings, and the sidebar section is gone. **Existing links and bookmarks still work** - the old
  addresses redirect to the right tab. Two long-standing layout annoyances were tidied up in the
  process: the Roles & Permissions grid header, where each role's name, badge, member count and
  buttons sat on three uneven lines with the "Capability" heading floating at mid-height; and the
  Sign-in page, which put six mostly-short fields on their own full-width rows and made a short
  form feel long. Related fields now share a row on wider screens and stack again on a phone.

- **Two different server settings were both called "Safety System".** The anti-cheat toggle and the
  safety-system toggle shared a label, so there was no way to tell which one you were changing.

- **Chinese showed a stray Latin "s" on Chinese words, and German pluralised three phrases wrongly.**
  The Mods screen worked out plural endings in code - add an "s" unless the count is one - and handed
  the same answer to every language. That is an English grammar rule, and it was correct for French
  and Spanish by luck only. Chinese does not inflect for number at all, so eight messages had a Latin
  letter stuck onto the end of Chinese text on screen. Those messages now use real per-language plural
  forms, and the languages that were quietly relying on the old behaviour were corrected at the same
  time - French had a missing elision and several past participles frozen in one form regardless of
  count.
- **Latin full stops and commas appeared inside Chinese sentences.** Several toasts and diagnostics
  lines are assembled from fragments, and the code joined them with an English full stop and an
  English comma. Chinese punctuates with its own full-width marks and its own enumeration comma, so
  the result read as a Chinese sentence with foreign punctuation grafted on. The separators now
  follow the language.
- **Times and dates followed the wrong language.** The dashboard's performance charts formatted their
  time axis for US English regardless of your language, and three timestamps on the Server
  Configuration page followed your browser's language rather than the one you chose in the panel - so
  a German panel on an English browser showed German text with US times.
- **Switching language left some text in the old one until you reloaded the page.** The "last
  checked" time on Debug > Diagnostics, the dashboard's performance chart axis and a diagnostics
  action label were all computed once and then kept, so picking a new language changed the rest of
  the screen around them while they stayed as they were. They now change with everything else, the
  moment you pick.
- **The page heading overlapped its own buttons in German, French and Spanish.** On My Servers the
  description ran underneath the button row rather than beside it. The buttons were laid out at their
  natural width inside a column capped at 48%, so they simply overflowed it; they now wrap within
  their column. English was unaffected only because its description happens to be short enough.
- **The world map's control label was cut off in German**, rendering as "STEUERL" in a rail built for
  a four-character English label. It now reads "Strg", which is what a German keyboard has printed on
  that key.
- **Template comparisons and difficulty badges were English-only**, showing "On", "Off", "(not set)"
  and "Custom" in every language, and now also show translated server-setting names rather than raw
  English ones.
- **Relative timestamps in Debug were English-only** - "5m ago", "just now" - regardless of language.
- **Error messages that mention a specific thing now say it in French too**: messages that name a
  permission, a role, a count or a reason - such as refusing a change that would leave nobody able to
  manage roles - previously fell back to English, because the panel had no way to carry that
  detail across in a translatable form. It does now, and the permission is named using the same
  wording the Roles & Permissions screen uses.

  Eleven more of these were finished off in the same way: the messages about deleting too many map
  chunks or too large a region, rejecting an invalid mod or Workshop ID, an unknown server, an
  unrecognised airdrop preset or item type, character data with nothing usable in it, and a failed
  sandbox-repair backup. Each of them names a specific count, ID or file, and each now carries that
  detail across so the French version says it too instead of dropping back to English.

  The last two were a different problem and needed a different fix. "This folder is not writable"
  and "cannot read this folder" each ended with a line of advice that changed completely depending
  on whether the panel runs in Docker or directly on the machine, and on Windows versus Linux -
  four and two entirely different sentences respectively, all sharing one message. Those are not one
  sentence with a blank in it, so they are now separate messages, each written properly in both
  languages, rather than a French frame with an English instruction stapled on the end.
- **"Restart now" no longer files its failures under "Auto Restart"**: a restart you triggered by
  hand was recorded in Schedule History as though it had been automatic, so a failure looked like a
  scheduled job misbehaving.

- **A normal mod state was styled like a problem.** A mod whose ID has not been resolved yet - the
  ordinary state before it has been downloaded - was shown with the same warning styling as a real
  duplicate-ID conflict, so routine setup looked like something had gone wrong. It is now shown as
  information, which is what the code always intended it to be.

- **Browse Public told you to do things you could not do.** The page invited you to copy a server
  address and to click a row for more detail; neither was possible - the row had no click handler
  and there was no copy control anywhere on it. The address is now a copy button that confirms when
  it has copied, so the instruction is true.

- **The World Map's "no players" message could be unreadable on a phone.** The text is drawn onto
  the map itself and was centred without accounting for the floating zoom and layer controls, so on
  a narrow screen the first words of it sat underneath an opaque button.

- **The save picker on Map Cleanup squeezed a whole list row into a closed drop-down.** When shut it
  reused the full multi-line entry - name, date and size - inside a single-line control, so a long
  save name was cut to around fifteen characters and you could not tell which save was selected.

- **The rights matrix is readable at full size**: with 27 permissions across 12 groups, scrolling
  the table lost track of which column was which role and which row was which permission. The role
  headings and the permission names now stay pinned while you scroll.

- **The unRAID Community Applications listing showed a broken icon.** The template pointed at an
  image file that has never existed in the project; it now points at the panel's actual icon.

### Security and maintenance

- **Any non-administrator account could take over the administrator account.** The recovery-codes
  endpoint checked that you were signed in, but not *who* you were - and the recovery codes it
  issues have never belonged to the caller, they belong to the administrator. So anyone holding a
  moderator or technician account could ask for a fresh set of administrator recovery codes, receive
  them in plain text, and use one from the sign-in screen to set the administrator's password to
  whatever they liked. Two requests, no cooperation from the administrator, and it would also have
  quietly invalidated whatever recovery codes the real administrator had saved. Reading and
  generating those codes is now administrator-only, and there are tests holding that gate shut.

  **If you run an older version and have ever created a second account of any kind, treat this as
  live.** The same endpoint is ungated in 1.1.x. Upgrading closes it; until then, an administrator
  can regenerate their recovery codes to invalidate any set that was issued behind their back.

- **Steam branch lookup could run an arbitrary program on the host**: the Steam-branches endpoint
  (used when picking which PZ build to install) took a SteamCMD folder from the request and ran
  whatever executable it found there, without checking the path first — unlike every other endpoint
  that takes a filesystem path. A technician account, which is meant to operate the game server and
  nothing more, could have pointed it at any program on the machine and had the panel run it. It now
  validates the path the same way installation and update do, and refuses anything that isn't one.
  Two related gaps in the PanelBridge mod-connection settings, where a relative folder path was
  silently accepted instead of rejected, were fixed the same way.

- **The RCON command history was readable without a permission check**, and it can contain
  whitelist passwords typed into the console.

- **Leftover database copies after a crash**: if the panel is killed while saving, a full copy of
  the database file — including the RCON password and login secret — no longer lingers on disk
  indefinitely. It is cleaned up automatically the next time the panel starts, once it can confirm
  the process that left it behind is no longer running.

- **Changing two permissions quickly could silently put one of them back.** On the Roles &
  Permissions grid, each tick sends the role's whole capability list. Ticking or unticking a second
  box before the first had finished saving built that second request from the state as it was
  *before* the first change - so whichever save landed last won, and the other change was quietly
  undone. The dangerous direction is removal: an administrator taking two capabilities away from a
  role in quick succession could end up giving one of them back, with the grid showing it as
  removed. Responses arriving out of order could do the same thing on their own. Each change is now
  based on the most recent state rather than the state on screen when the page last drew, and a
  reply that has already been superseded is ignored instead of applied.

- **The panel now hides administration it knows you cannot use.** Until now every signed-in
  account, whatever its role, could see Users, Roles & Permissions and Sign-in in the menu and open
  those pages - the server refused the actions behind them, but the pages themselves opened and
  simply failed. That mattered more once these became tabs inside Panel Settings, a page people open
  for ordinary reasons, so they are now shown only to accounts whose role actually grants the
  capability, and typing the address directly does not get you in either. **The server has not
  become more permissive:** every one of those actions was already refused server-side and still is.
  This only stops the panel offering you doors that were always locked. If the panel cannot work out
  what your role allows, it shows the tabs rather than hiding them, so a hiccup cannot lock an
  administrator out of their own settings.

- **A single-use recovery code could be used more than once.** Recovery codes are meant to work
  exactly once, and each redemption marks the code as spent. But two redemptions arriving at the
  same moment were each reading the stored codes before either had written its result, so both saw
  an unused code and both reset the password. The redemption path now takes the same lock the panel
  already used for creating users and changing roles, so redemptions are handled strictly one at a
  time and a spent code is spent.

- **Renaming a role could lock you out of your own panel, instantly and permanently.** The panel
  works out what you are allowed to do by looking up your role *by its name*. Renaming a role
  changed the role but left every member still pointing at the old name, so the lookup stopped
  matching and everyone in that role lost every permission they had - in a single request, with
  no warning. Renaming the administrator role locked the entire panel, including the person who
  had just done it. The safeguards that stop you removing your own last administrator did not
  help, because they only watch for permissions being taken away, and this was only a rename.
  Built-in roles can no longer be renamed at all, and renaming a custom role now updates every
  member with it.

- **A backup could be left truncated and still appear in the list as a normal backup.** Archives
  were written straight to their final filename, so a crash or a power cut partway through left a
  half-written file sitting in your backup list with nothing to distinguish it from a good one -
  which you would only discover when you tried to restore it. Backups are now written alongside and
  moved into place only once the archive has closed cleanly.

- **Server Setup could tell you it had finished when it had not.** Both the full and the quick
  install wizards showed the success screen as soon as the game files were downloaded, even if
  adding the server to the panel afterwards failed - so the files were on disk, the server was
  missing from My Servers, and nothing said why. The wizards now only claim success when the server
  really was added, and say plainly what happened when it was not. Re-running setup is safe.

- **The panel's own update check could fail open.** Before downloading a panel update, the panel
  runs a preflight check to refuse early if applying it would fail. If that check could not reach
  the server it returned nothing at all - and "we don't know" was being read as "everything is
  fine", so the download went ahead exactly when the safety check had failed. It now refuses unless
  the check actually passed.

- **GitHub release notes**: releases now publish the real changelog entries for their version. The
  matcher that pulled them out of this file depended on which `awk` the build runner happened to
  ship — under one of them it matched nothing at all, and the release quietly published a generic
  "See CHANGELOG.md for details" placeholder instead. A version with no changelog section now also
  logs a visible warning in the build output rather than passing silently.

## [1.1.55] - 2026-08-21

### Fixed

- **Server Configuration crash**: tolerate missing numeric keys while loading older or partially generated server profiles.
- **Sandbox decimal input**: accept comma decimals such as `0,8`, normalize them to `0.8`, and reject malformed or out-of-range numeric values before saving.
- **Configuration editing feedback**: show why local configuration must be saved while the server is stopped and disable save actions while it is running.

## [1.1.53] - 2026-08-20

### Fixed

- **Build 42 configuration ownership**: keep shared gameplay settings such as `MinutesPerPage`, loot respawn, and blood lifespan in the SandboxVars editor instead of exposing duplicate INI controls with conflicting defaults.
- **Configuration save verification**: show the resolved config file path and verify INI writes by reading the value back from disk.
- **Server lifecycle status**: keep the Servers page synchronized through start and stop transitions, including delayed process shutdowns and status events.
- **Remote RCON setup guidance**: clarify that the host field is the machine running Project Zomboid and that `127.0.0.1` is only correct when the panel shares that machine.

## [1.1.52] - 2026-08-20

### Fixed

- **Workshop update detection**: automatically find the Steam Workshop ACF from common server and SteamCMD layouts, refresh detection when switching or editing servers, and provide a direct folder picker when the path is missing.

## [1.1.51] - 2026-08-20

### Added

- **Scheduled tasks**: schedule commands weekly with a visual Monday-to-Sunday selector.
- **Discord presence**: show the live player count and configured capacity, such as `Playing 19/32`.
- **Server launch mode**: choose Steam or non-Steam dedicated-server launch mode when editing a local server.

### Fixed

- **World Map access**: use the current `pzmap.org` host for browser-direct B42 tiles when the panel host receives a Cloudflare 403.
- **Dashboard server controls**: stop events now reach connected dashboards immediately, stale composed status no longer overrides live local process status, and stopped servers no longer retain stale uptime.
- **Portable world restores**: restore world saves from archives whose nested folder names differ from the destination machine.
- **First-run panel port**: persist the selected setup port and fall back to a free port when the requested port is occupied.

### PanelBridge

- Updated PanelBridge to `1.7.38` for this panel release. No protocol changes.

## [1.1.50] - 2026-08-19

### Fixed

- **Fresh install admin password**: fresh installs and quick setup now persist the entered administrator password into the created server profile, so the first launch receives `-adminpassword` instead of waiting for unavailable console input.
- **PanelBridge installer safety**: remote profiles are rejected with clear manual/SFTP guidance, invalid local paths are blocked, duplicate installer logic was removed, and a newer installed bridge is never downgraded.
- **SFTP chroot guidance**: permission failures for `/home` paths now explain that chrooted accounts must use the path visible in their SFTP client without the `/home` prefix.

### Security and maintenance

- **Repository hardening**: added CODEOWNERS, a security reporting policy, Dependabot configuration, CodeQL analysis, immutable GitHub Action pins, deterministic Pages installs, and protected `main` branch settings.
- **Template catalog controls**: administrators can now hide built-in templates from the panel as well as delete custom templates.
- **Dependency security**: updated vulnerable React Router, PostCSS, Nanoid, JS-YAML, Socket.IO parser, Undici, and brace-expansion lockfile entries; root and client audits now report zero vulnerabilities.
- **Fresh install admin password**: newly installed servers now persist the setup password into the created profile so the first launch receives `-adminpassword`.

## [1.1.49] - 2026-08-18

### Added

#### Player access

- **Whitelist management**: the Players page now lists per-server Build 42 whitelist accounts without exposing passwords, shows roles, Steam IDs, last connections, and online status, and supports account creation, removal, and allowed Steam ID management. Remote-server rosters remain unavailable until the remote database transport is implemented.

#### Backups

- **Server snapshots and durable history**: new backups embed a secret-free snapshot of the server identity and selected INI/sandbox settings. The Backups page can inspect the snapshot and shows persisted history for the active server.

#### Multi-server and Docker

- **Per-server RCON visibility**: each server card now reports its own bounded, short-lived RCON probe rather than showing connection truth only for the active profile.
- **Opt-in managed Docker controls**: explicitly labeled containers can expose state, CPU, memory, network, and disk metrics plus guarded start, stop, and restart controls. Docker access is disabled by default and requires both `PANEL_DOCKER_CONTROL_ENABLED=true` and the `zomboid-panel.managed=true` container label.

#### Hosted servers

- **Direct SFTP setup path**: remote server cards now select the intended profile before opening PanelBridge SFTP settings. The README includes simple Windows, Linux, macOS, Docker, Unraid, and Indifferent Broccoli installation steps.

#### Templates

- **Reusable server templates**: preview curated or saved templates against the active server, then apply selected `server.ini` and sandbox settings after the server is stopped. Templates exclude identity, network, and secret settings; local writes are backed up and roll back if a paired file update fails.

#### Server operations

- **Mount discovery and guided connection**: scan configured and common local Project Zomboid paths, inspect discovered server settings, and add an exact discovered server profile without typing paths or exposing RCON credentials in the browser.
- **RCON connection diagnostics**: test reachability and authentication from Servers or Settings before relying on control actions.
- **PanelBridge local installation**: when a local server is activated, the panel can install and verify the bundled bridge Lua file atomically.
- **Storage and server health**: surface low-disk and database write-circuit faults, and report host/process, RCON, and PanelBridge signals separately.

#### Remote servers

- **Edit a remote server's configuration over SFTP**: the Server Configuration page was closed to remote servers entirely, because everything under it reads and writes the panel host's own filesystem. Point Settings > PanelBridge at the remote `Server` folder and the panel now mirrors `<server>.ini`, `SandboxVars.lua`, `spawnpoints.lua` and `spawnregions.lua` over the SFTP credentials PanelBridge already uses, edits the local copy, and writes the changed files back atomically. Only `.ini` and `.lua` files are ever transferred, and only the four the editor touches. Requests are serialized so two overlapping saves cannot lose each other's edits. Sandbox settings applied through PanelBridge now persist on remote servers too.

#### Servers

- **Spell out what a second server on the same machine needs**: adding another local server now lists the four things that must be unique (install folder, Zomboid data folder, config name, ports) and the one thing that is safe to share (SteamCMD itself), and flags a real clash against the servers you already have — same config name, same RCON port, a game port within one of another server's pair, or a shared save or install folder.

#### Discord

- **Keep Q shouts out of the Discord chat relay**: the relay's "Which messages to forward" setting gains a "Public chat without yells" option, so `HEY!`, `HEY YOU!` and `OVER HERE!` no longer flood the channel every time someone presses Q. Build 42 labels both ordinary talking and yells as `Local`, so the panel now reads the chat room id from the game's own delivery log line to tell them apart.

### Fixed

- **Remote PanelBridge SFTP reliability**: setup now prepares remote queue folders, gives actionable recovery guidance, protects queue transfers from partial uploads, recovers queue numbering after a cleared panel cache, and records sanitized SFTP diagnostics in support bundles.
- **SandboxVars nested tables**: structured sandbox saves now preserve the `Music` and `Debug` tables instead of corrupting their child settings into top-level values.
- **SteamCMD update path input**: asynchronous SteamCMD detection no longer overwrites a path entered while the update dialog is open.
- **Remote server dashboard status**: provider-aware host, RCON, and PanelBridge signals prevent a reachable remote server from being reported as stopped solely because it has no local process.
- **Local config edit safety**: configuration mutations now fail closed while the local game server is running or its state cannot be verified, preventing Project Zomboid from overwriting edits from memory.

- **Build 42 map visibility now matches the game**: Map Player Visibility includes the new `Friends and nearby players` value and the `Everyone` value, instead of treating value 3 as Everyone and hiding value 4.
- **Custom start commands now persist**: editing a managed server keeps its Custom Start Command and reloads it into the server manager when that server is active.
- **Lightning controls work on Build 42.20**: PanelBridge now triggers the server-side ThunderStorm event directly instead of relying solely on the ClimateManager transmit helper, which could report success without producing a visible strike.
- **SteamCMD retries are no longer blocked by failed setup**: an installation or update error before the SteamCMD process starts now clears its operation lock, so the next attempt is not rejected as already in progress.

- **Linux release compatibility**: pin standalone Linux artifact builds to Ubuntu 22.04 so the binary remains compatible with hosts using the documented glibc 2.28+ baseline. v1.1.44 was built through the moving `ubuntu-latest` runner after it moved to Ubuntu 24.04.

#### World Map and Chunk Cleaner

- **Blank Build 42 map tiles**: Project Zomboid moved its map build list behind a versioned static directory and removed the old `42.19.0` fallback. The panel now discovers the upstream static path dynamically, falls back to the available `42.20.0` geometry, and permits browser-created tile blobs under its Content Security Policy.

#### Managed Docker servers

- **Containerized servers could immediately come back after Stop**: stopping PID 1 through RCON or a host process kill triggered Docker's restart policy. Dashboard controls, Discord commands, scheduled restarts, and manual lifecycle actions now use Docker for explicitly managed containers. A running world is saved first; a failed save cancels the operation.
- **Docker control could appear available but lack socket permission**: supplemental container groups are preserved when the image drops privileges, and socket-access failures are surfaced instead of looking like an empty container list.

#### Safety and recovery

- **Docker stop/restart could skip the world save**: running managed containers now require a successful server-scoped RCON save before Docker is allowed to stop or restart them. Stopped containers can still start without impossible RCON checks.
- **Concurrent backup-history updates could lose a record**: history mutations are serialized so overlapping backup completion and deletion cannot overwrite each other.
- **Docker mappings by container name were rejected**: lifecycle requests now use the exact container reference stored on the server profile and revalidate its managed label immediately before acting.
- **Connection failures were dead ends**: RCON and PanelBridge failures now link directly to the relevant configuration surface.

#### Security and reliability

- **Safer local administration**: sensitive configuration fields are masked in responses, filesystem browsing is confined to approved roots, and server-name validation prevents path traversal.
- **Reliable local path defaults**: empty saved paths now fall back to `PZ_SERVER_PATH` and `PZ_SAVE_PATH` when configured.

#### PanelBridge

- **Repeated Lua stack traces in the game server log**: when a Java method is missing on a Build 42 server the game reports it as an error with no message, so the bridge never recognised it as unavailable and called it again on every poll. Vehicle, healing, and game-time queries could each fill the log with the same trace. The bridge now stops calling a method that has never once succeeded, while a method that has worked before is never disabled by a single broken modded object.
- **Game-time reads could flood the server log with Lua stack traces**: querying optional clock fields that Build 42 does not expose generated a trace per probe. The bridge now reads only the documented core clock values and derives minutes locally.

#### Discord

- **Chat relay privacy clarity**: the broad relay option now names Local chat explicitly and warns that it is forwarded to Discord; choose General tab only to keep proximity chat private.
- **Server start and stop notices could disappear permanently**: duplicate suppression now expires after one minute, so a missed state observation cannot silence later lifecycle notifications while still preventing repeated notices from overlapping checks.

#### PanelBridge

- **Healing a player could flood the server log with Lua stack traces**: the Build 42 handler still probed optional health, stat, and moodle methods. Project Zomboid logs each unavailable Java probe even when it is caught, so healing now uses only the documented body-part collection.
- **Build 42.20 startup errors**: capability caching now stringifies the Java class wrapper instead of calling its incompatible `getName()` member, preventing a non-fatal Lua error on every server start.
- **Healing a player could flood the server log with Lua stack traces**: Build 42.20 does not expose several optional body-damage APIs to Kahlua, and attempting to probe them logs an engine error even inside `pcall`. Healing now uses the known body-part slots without probing those unavailable APIs.
- **Killing a player could report success without killing them**: the command used unverified health fallbacks and returned success even when its final death check failed. It now uses Build 42's native death path and returns the failed verification to the panel.

#### Server status

- **A running systemd server could display as Offline**: strict per-server process ownership intentionally refuses to claim another local server, but a systemd-launched server can be difficult to attribute even when the panel's own RCON connection and PanelBridge heartbeat prove it is alive. Status reporting now accepts either direct connection as live evidence while keeping strict ownership requirements for stop and force-stop operations.

#### Event Console

- **Game Clock claimed success while changing nothing**: Build 42 can reject a clock setter from the Lua bridge, but the bridge discarded that error and still told the panel the time had changed. Clock updates now verify the requested hour, day, month, and year before reporting success; failures return their real reason instead.
- **World Map could flood a server log with Lua stack traces**: newer Build 42 revisions can expose a vehicle collection without a callable `get` method. The bridge now skips that unsupported live-vehicle source rather than repeatedly calling it while the map polls; saved vehicle markers remain available.

#### World Map and vehicles

- **Live vehicles could silently disappear from the World Map**: the bridge decided whether a Build 42 method existed by reading it as a property, but Project Zomboid exposes many Java methods that are callable while that property reads as empty. Every loaded vehicle was then discarded, leaving the map showing only saved markers with no fuel, battery, or repair controls. The bridge now determines availability by calling the method once and remembering the answer, so a method that genuinely is missing is attempted once per server session instead of on every poll.
- **Vehicle repair and area removal could report work they never did**: repairing a vehicle counted parts it had not actually changed, and removing vehicles in an area reported them as removed even when no removal method applied. Both now count only operations that genuinely succeeded.
- **Panel data went stale for several seconds after an action**: vehicle, safehouse, and player readouts are cached briefly to keep polling cheap, but the cache was not cleared when an admin action changed the world, so a refuel, repair, or battery change appeared not to have worked until the cache expired. Any state-changing command now refreshes those readouts immediately.
- **Game time and weather could report invented values**: the same property-based check made readings such as the in-game year, minute, view distance, and thunderstorm state fall back to hardcoded defaults instead of the server's real values.
- **Admin actions could report success while doing nothing**: the same property check gated 138 further call sites, so on affected Build 42 revisions the action was skipped and still reported as done. Healing a player could leave stats, wounds and moodles untouched; restoring or cutting power could skip light switches; and weather, sandbox, faction, teleport, item-spawn and vehicle commands could all silently no-op. Every one of these now reports what actually happened, and the heal result lists only the parts that were really restored.

#### Performance

- **Reduced the bridge's disk writes and per-tick work**: each command wrote its queue position to disk twice and persisted its counter once per result, and the legacy command file was re-read every quarter second even though the panel only writes it when a queued command fails. Bookkeeping is now written once per tick and the legacy file is checked on its own slower schedule.

#### Discord

- **Restart notices never reached the Discord chat channel players actually watch**: every countdown line the scheduler broadcasts in-game (`[SERVER] *** RESTART IN ... ***`) was filtered out of the Discord chat relay to avoid spamming ~13 messages per restart, but that filter also swallowed the one message players need most — that the restart is actually happening now (or was cancelled). The countdown ticks are still suppressed; the restart's outcome ("RESTARTING NOW", "Restart CANCELLED") is now relayed like any other server message.

## [1.1.31] - 2026-08-05

### Added

#### Settings > Mods

- **"Remove everywhere" for a mod you never want back**: every row in the collection table now has a single destructive action that takes the mod out of the Steam collection, the server config (`WorkshopItems`, `Mods` and `Map`), and the downloaded files on disk, then untracks it and adds it to the ignore list so a later scan can't quietly bring it back. Previously this took four separate steps across two pages, and nothing stopped the mod reappearing afterwards. Deleting a mod from disk now also clears its map folders from `Map=`, which it should always have done.
- **Add and remove mods from the server straight out of the collection table**: rows in Settings > Mods only ever offered collection and tracking buttons, so a mod sitting in the collection but not on the server could be spotted there but not acted on. Each row now also carries "To server" or "From server", matching the Mods > Import collection panel.

#### Documentation

- **Unraid and Indifferent Broccoli deployment guide**: the README now separates the panel's own `/app/data` and `/app/logs` state from shared Project Zomboid `/pz-server` and `/zomboid` mounts, explains RCON networking and PanelBridge access for a separate PZ container, and includes an importable Unraid template. It also calls out that `/panel-data` and `/panel-logs` are unused paths.

#### Project

- **A lint rule that stops the panel from ignoring a failed command**: many services here report failure by returning `{ success: false }` rather than by raising an error, and a third of the bugs fixed in this release were a discarded result — the panel telling you an action had worked when nothing had checked. `local/require-result-handling` now fails the build when the result of one of those calls is thrown away. Deliberately ignoring one is still allowed, but has to be written as `void`, so it shows up in review.

### Fixed

#### Server control

- **Stopping the server could lose progress, in three more places**: the panel's own Stop button, the automatic game-server update, and the pre-update shutdown before a Docker panel update all issued a save followed immediately by a quit without checking whether the save worked. A failed save meant quitting anyway and discarding everything since the last one. Each now refuses to shut down and says why. (The same fault was fixed in Discord's `/stop` earlier.)
- **Actions reported success when the underlying command had failed**: saving the server configuration, testing the RCON connection, `/start` in Discord, restarting from the panel, and scheduled tasks all announced success without checking the result they were handed. A scheduled task whose RCON command failed was recorded in the history as having run.

#### Discord

- **`/restart` always claimed the restart was starting**: the scheduler reports a refusal or a failure by returning a result rather than by raising an error, so the command ignored it. Asking for a restart while one was already running, or when the server failed to come back, still answered "Server restart initiated". The command now reports what actually happened, falling back to the notification channel if the warning period outlasted Discord's reply window.
- **Restart warnings were announced twice in game**: `/restart` sent its own warning immediately before the scheduler began its countdown with the same message. The duplicate is gone — and because it was the one countdown line without the `[SERVER]` prefix, it was also the only one still leaking into the chat relay.
- **/stop shut the server down even when the save failed**: the world save and the shutdown were issued back to back without checking the first one, so a failed save quietly cost everyone their progress since the last one. It now stops and reports the failure instead.
- **A cancelled restart was announced only in game**: Discord was told the restart was coming and then never told it had been called off, leaving anyone watching from Discord expecting the server to go down.
- **The restart countdown flooded the chat relay**: every warning, including the final second-by-second ticks, was forwarded to Discord on top of the single restart notification. Those broadcasts now stay in game where they are aimed.
- **In-game chat stopped reaching Discord**: v1.1.28 narrowed the relay to the General tab, but Build 42 records ordinary talking as `Say` and Q shouts as `Local`/`Shout`, so almost nothing was forwarded while server notifications kept arriving normally. All public chat is relayed again, and Discord > In-Game Chat Relay now has a "Which messages to forward" choice for anyone who wants the General tab only. Faction, safehouse, radio, whisper and admin chat are still never forwarded.
- **Turning the chat relay off only stopped half of it**: messages still flowed from Discord into the game, including from the notification channel when no separate relay channel was set. The switch now covers both directions, and is labelled as such.
- **Chat could arrive in Discord out of order**: relayed messages were sent in parallel, so Discord ordered them by whichever request finished first. They are now sent in the order the game logged them.
- **Chat could pile up faster than Discord accepts it**: a busy server or an in-game spammer could queue relayed messages without limit. The queue is capped and reports what it dropped rather than falling further and further behind.
- **In-game chat could inject formatting into Discord**: player names and messages were posted to Discord unescaped, so anything typed in game could apply Discord formatting — including a link with harmless-looking text pointing anywhere. Player text is now escaped, as it already was everywhere else.
- **Messages typed in Discord vanished when the game server was unreachable**: they were dropped with no reply and nothing in the channel to say so. Discord now gets a short notice, at most once a minute.
- **A broken chat channel silenced server notifications**: one circuit breaker covered all Discord sends, so three failures relaying chat to a deleted channel suppressed start/stop/backup notifications to a perfectly healthy channel for up to 30 minutes. Each channel now fails independently.
- **Nobody was announced for joining an empty server**: join and leave notifications were held back until the panel had seen at least one player online, which it works out from the previous poll. On an empty server that condition is never met, so the first person to arrive after every restart — and after every time the server emptied out — joined silently. The panel now tracks that it has taken a first look, separately from whether anyone was in it.
- **A blank notification template could silence Discord entirely**: an event enabled with an empty template, or one whose only placeholder resolved to nothing, sent an empty message. Discord rejects those, and three rejections in a row suppressed all notifications for half an hour. Blank templates can no longer be enabled, and a notification that renders to nothing is skipped instead of sent.
- **Turning on an event notification saved a blank message**: the switch enabled the event without filling in the template, so it sent nothing. Each event now starts from a sensible default wording.
- **Saving one notification could reset the others**: the events endpoint replaced the whole configuration with whatever was sent, so a partial update wiped every event it did not mention. Updates are merged now.
- **Long notifications were rejected**: a template plus a long player name could exceed Discord's message limit, failing the send and counting against the same suppression that silences later notifications.
- **Send Test Message always claimed success**: the result of the send was discarded, so the one button whose job is to prove Discord works reported "sent" even when the channel was wrong or the bot could not post. It now reports the failure.
- **The Admin and Moderator role settings did nothing**: every command was also locked on Discord's side to members holding Discord's own Administrator permission, so a role named in the panel could not see the command at all, let alone run it. Discord-side locks are now only applied when no role is configured, and changing a role re-registers the commands immediately instead of waiting for a bot restart.
- **Moderators could be refused their own commands**: the role check only understood a cached guild member, so an uncached one — whose roles arrive as a plain list — read as having no roles at all.
- **Discord IDs of valid length were rejected by the setup form**: the page required 17 to 19 digits while the server accepts 15 to 21.
- **A failed settings load looked like a fresh install**: if the configuration request failed, the page cleared everything and showed the first-time setup wizard, with no indication anything had gone wrong. It now keeps the last known values and says the read failed.
- **Saving and starting in one step reported the wrong failure**: if the bot failed to start, the message claimed the configuration had not been saved, when it had.

#### Chat

- **Chat messages could vanish from the panel's Chat page**: every message was tagged with the current millisecond, and a single read of the log file often produces several lines within the same millisecond. The page treats a repeated tag as a duplicate delivery, so when two people spoke at once only one of them appeared.
- **Players with an apostrophe in their name never appeared in Discord**: the chat log parser stopped reading the name at the first quote, so the whole line failed to match and every message from, say, O'Brien was dropped silently and permanently.
- **Chat messages were dropped at log-read boundaries**: the log tailer discarded any line that straddled two polls, and re-read one byte each time, corrupting the line after it. Partial lines are now held until the rest arrives. A log burst larger than 1MB is still skipped, but it now says so in the panel log instead of vanishing.
- **The first messages after a log rotation were missed**: when Project Zomboid started a new chat or user log, the tailer jumped to the end of it, skipping anything already written. It now reads a rotated file from the start, while still skipping history on panel startup.
- **Chat never started on a server that had not run yet**: the log tailer gave up if `server-console.txt` and the `Logs` folder were missing when the panel booted, which is exactly the case on a first start, and never looked again. It now keeps watching and picks the logs up as soon as the game server creates them.

#### Mods

- **A failed mod-update restart could block every later one**: the pending-restart flag was only cleared when the restart threw, not when it reported failure by return value, leaving the panel convinced a restart was still in flight.
- **Deactivated mods were silently deleted from tracking**: loading the mod list pruned every tracked mod missing from `WorkshopItems=` — exactly the set the Mods > Deactivated tab exists to show. The tab emptied itself on the next refresh, so a deactivated mod disappeared for good as soon as any other mod was removed. Deactivated mods are now kept until you re-enable or delete them.
- **The collection compared itself against the wrong thing**: drift was measured against the locally tracked mod list rather than `WorkshopItems=`, so a mod removed from the server still counted as "in sync" for as long as it stayed tracked, and the "Mismatch" badge could read 0 above a list of 26 rows. Every row is now classified against what the server actually loads, and the counts match the list they filter.

#### Mods > Conflicts

- **Mods could be reported as conflicting with themselves**: a mod that ships the same file under both `media/` and a Build 42 `42/media/` folder was counted twice, producing a nonsensical "ModA vs ModA" pair and inflating the file counts of every real pair it appeared in.
- **Translation files that failed to parse were silently treated as safe**: an unreadable or unparsable translation file now counts as a possible conflict instead of being skipped, matching how script and clothing files already behaved.
- **Script and clothing files with no definitions were reported as conflicts**: an empty file cannot collide with anything, and is now treated as additive. Only files that genuinely could not be parsed still fail closed.
- **A file was reported as identical when only one copy could actually be read**: the scan now requires every copy to be verified before calling a shared file safe.

#### Mods > Load order

- **A dependency cycle broke the load order of unrelated mods**: auto-sort used to give up on every mod it could not place and append them all in their old order, so a mod that merely required something caught in a cycle could still be sorted above it. Cycles are now detected precisely, and only the dependencies inside a cycle are ignored.
- **Auto-sort disagreed with the Conflicts tab about missing dependencies**: a `require=` satisfied by a `<required>_<suffix>` fork was accepted on the Conflicts tab but reported as missing by auto-sort, which then failed to order against it. Both now use the same rule.
- **Padded `require=` entries were treated as missing dependencies**: surrounding whitespace is now trimmed, and a requirement declared several times is only reported once.

#### Backups

- **Old backups were logged as cleaned up even when the deletion failed**, and a failed automatic update no longer reports nothing when the server does not come back.

### Changed

#### Mods > Conflicts

- **Conflict scan is faster and uses far less memory**: file sizes are compared before hashing, so files that obviously differ are never read; hashing is streamed instead of loading whole files into memory; `sandbox-options.txt` and `fileGuidTable.xml` are skipped before being read rather than after; and Lua files are parsed once instead of once per scanning pass.
- **Conflict scan progress no longer appears to stall**: the comparison phase reports progress instead of jumping from 60% to 85%, the stream sends a keep-alive so proxies do not drop long scans, and closing the page now stops the scan instead of letting it run to completion.

#### Mods > Load order

- **Load-order auto-sort reports each dependency cycle separately**: two unrelated circular dependencies used to be listed as one group of mods, which made it impossible to tell which mods were actually looping. Each cycle is now shown on its own, and the messages shown when there is nothing to sort explain whether the requirements are simply not enabled.

#### Settings > Mods

- **The Steam collection is now reconciled one mod at a time**: the "Sync all" / "Sync now" buttons are gone. Each row states plainly whether it is missing from the collection, in the collection but not on the server, or in sync, and carries its own buttons to add or remove it from the collection and from the server. Bulk operations are still available by ticking rows first.

## [1.1.30] - 2026-08-05

### Added

- **Settings that were previously unreachable**: the game server can now be set to start with the panel from Settings → RCON, and automatic character exports (including how many copies to keep per player) moved into Settings → Backups. The export retention limit had no interface at all before.
- **Where the rest of the settings live**: Settings → About now lists the pages that own their own configuration, such as server profiles, the Discord bot, scheduled tasks, game server config, and chat quick messages.
- **Automatic game-server updates**: an opt-in Settings → Mods & Workshop control can announce an update, wait a configurable player-warning period (15 minutes by default), save and stop the server through RCON, update through SteamCMD, and start it again. It never stops a server without RCON, only schedules one job, and attempts to restart after a SteamCMD failure.
- **Password recovery codes**: admins can generate one-time recovery codes in Settings → Security. The login page accepts a recovery code when normal access is unavailable, without requiring filesystem access.
- **Read-only remote server logs over SFTP**: Settings → PanelBridge can list and safely read the tail of remote `.log` and `.txt` files without granting write access.
- **Editable scheduled tasks**: existing scheduler tasks can be edited from the panel, including their schedule, command, and enabled state.

### Changed

- **Settings page reorganised**: the sections are grouped into Panel, Game server, Automation, and System in a sidebar instead of a single row of tabs that wrapped onto two lines. The former Panel tab held the port, remote access, and the updater in one long page; those are now separate sections, and the single-field API Keys tab was folded into Mods & Workshop. Existing links such as `?tab=rcon` still open the right section.
- **Mods navigation and active-server workflow redesigned**: the former nested tab maze is now a flat grouped navigation rail. Installed Workshop items, what the server actually loads, conflict repair, collections, and maintenance actions are distinct destinations. The Active on server view adds an attention filter, compact/detailed density, an always-available inspector, honest enabled-state colour, and shared row primitives.
- **Events and server configuration restyled**: Events now uses a searchable section rail and compact action groups; Server Configuration and Events no longer use the decorative corner-bracket treatment that made panels look misaligned.
- **Conflicts view extracted**: the 1,400-line conflict surface now lives in its own component with shared mod types and row primitives, making further repair-workflow changes safer.

### Fixed

- **Container failed to start under a non-root Kubernetes securityContext** ([#34](https://github.com/fpsacha/zomboid-control-panel/issues/34)): a pod that pins `runAsUser`/`runAsGroup` with `runAsNonRoot: true` never starts as root, so the entrypoint's `chown` failed with "Operation not permitted" and killed the script, and `setpriv --clear-groups` would then have failed too because `setgroups()` needs `CAP_SETGID`. Adding the `CHOWN` capability does not help, since Kubernetes only places it in a non-root container's bounding set. The entrypoint now detects that it is already running as a non-root user, skips both the ownership fix and the privilege drop, and executes the panel directly; it prints a note when the running UID/GID differs from `PUID`/`PGID`. Plain Docker and Docker Compose are unaffected and keep the existing `PUID`/`PGID` behaviour. The init-container and `command` overrides previously needed as a workaround can be removed.
- **Discord no longer reports the server online while it is still starting**: the Server Started notification now waits for an authenticated RCON connection instead of firing as soon as the Java process appears.
- **Chat no longer duplicates panel-sent General messages**: the page now recognises the server log's `[Admin] message` echo as the matching optimistic local entry.
- **Build 42 top-down map tiles load again**: the map proxy resolves the current upstream build and image format rather than assuming the old WebP endpoint.
- **Build 42 RCON command failures are visible**: unsupported commands now return a failure instead of appearing successful.
- **PanelBridge vehicle operations work with Build 42 Java collections**: live vehicle details, lookup, repair, battery, and area removal no longer discard valid loaded vehicles.
- **Vehicles near a player showed "no telemetry"** (PanelBridge 1.7.21): the World Map listed cars read from `vehicles.db` rather than live ones, so a car parked beside a player reported no fuel or battery and offered no repair or battery controls. The mod checked whether the game's vehicle list had a `get` field before reading it; that list reports its size correctly but does not expose `get` as a field, so every loaded vehicle was discarded. A live server with 21 loaded vehicles returned none. Vehicle lookup by id failed the same way, which also broke repair, battery, and area removal. Restart the game server once to load the updated mod.
- **Unresolved Workshop-mod review now opens the repair workflow**: the diagnostics action previously showed only a toast. It now opens Mods → Conflicts → Dependencies and starts the existing review scan, where each candidate can be checked and added individually.
- **RCON-only hosted servers no longer appear stopped**: profiles without local install, server, or save paths are now identified as provider-managed. Diagnostics explain that local process monitoring is unavailable while RCON controls remain usable.
- **RCON host with stray whitespace silently failed to connect**: a host copied from a game-server-provider panel often carries a leading or trailing space, which made the connection fail DNS resolution. The panel reported no players, Discord reported the server offline, and broadcasts failed, with nothing in the log to explain why. Whitespace is now stripped when the host is saved and when it is loaded, so existing configurations repair themselves.
- **Unreachable RCON is now reported**: a host that cannot be reached was only logged at debug level, leaving no diagnosis in the normal log. It now logs a throttled warning naming the host and port.

## [1.1.29] - 2026-08-04

### Added

- **Docker and Kubernetes secret files for credentials**: `RCON_PASSWORD_FILE` and `STEAM_API_KEY_FILE` read the value from a mounted secret file. The file takes precedence over the environment variable and over the value saved in Settings, so the credential is never written to the panel database.
- **`STEAM_API_KEY` environment variable**: the variable was documented in `.env.example` but never read by the panel. The Steam Web API key can now be supplied by environment, secret file, or Settings.
- **Support bundle server details**: the diagnostics bundle now includes a sanitized server configuration summary (selected INI settings, mod, workshop and map lists, and a sandbox integrity check) plus the installed Project Zomboid branch and Steam build ID.

### Fixed

- **Restoring a backup can no longer destroy the world** (#33): the archive is extracted to a staging folder and only swapped into place after it completes successfully. A corrupt or truncated backup now leaves the existing save untouched, and a failed swap restores the previous save automatically.
- **Restoring a backup on Windows**: the restore reported completion before every extracted file had finished writing, which made the final step fail with an `EPERM` error. It now waits for all files to be flushed.
- **Concurrent server wipes**: two wipe requests arriving at the same time could both pass the "wipe already in progress" check and delete the same save folder together.
- **Mod preset updates reported a false failure**: the preset was saved correctly, but the panel returned an error afterwards, so the change appeared not to have applied.
- **Network settings reported a false failure**: the server INI and panel settings were written correctly, but the response failed in the same way.
- **Discord integration could not reach the Discord API**: a dependency version override forced the Discord REST client onto an unsupported release, so every request failed with a header type error. Discord requests now work again.
- **Mod list loading failures are visible**: a failed mod list request previously left the page silently empty. The panel now reports the failure, retries once automatically, and explains how to retry manually if that also fails.
- **Backups of large saves use less memory**: counting files for the progress bar no longer walks the entire save tree in parallel.
- **Dashboard performance panel could break when telemetry first arrived**: the chart component changed its React hook count between renders, which React rejects. It now renders consistently whether or not history data is present.
- **Two slow memory leaks**: the client-error rate limiter and the CORS origin cache both grew without bound from values supplied by callers, and never released old entries.

### Security

- **Support bundles no longer reveal parts of secrets**: masked values previously kept the last four characters of passwords, tokens, and API keys.
- **Server wipe rate limiting**: the wipe endpoint is now covered by the same strict per-operation limit already applied to other destructive actions such as deleting server files and map regions.
- **Updated vulnerable dependencies**: `ip-address` (address parsing that could bypass SSRF and trust-boundary checks), `socket.io-parser` (memory exhaustion from zero-attachment packets), and `undici` (cookie and cache-directive handling). `npm audit` now reports no known vulnerabilities.

## [1.1.28] - 2026-08-03

### Fixed

- **Build 42 world-map floors**: map tiles now consistently use the upstream JPEG format, basement level B1 is selectable, and labels include Ekron, Brandenburg, Irvington, and Echo Creek.
- **Persisted vehicle visibility and actions**: the map reads parked-car positions from `vehicles.db` when vehicles are not streamed into memory. Database-only markers no longer offer controls that need a loaded game vehicle. Loaded vehicles use Build 42-compatible repair and battery APIs.
- **Map vehicle spawning**: coordinate-based map spawning now uses the supported Build 42 RCON `addvehicle` path instead of an unavailable PanelBridge command.
- **Map interaction**: player markers scale at close zoom, and long player or vehicle context menus remain inside the map with scrolling instead of being clipped.
- **Discord chat relay**: local Q shouts and Shout-channel messages remain visible in the panel but are no longer forwarded to Discord. Only public General chat is relayed.
- **Windows self-update extraction**: staged client archives retain their `.zip` extension, so PowerShell `Expand-Archive` no longer rejects them after a successful download and checksum verification.
- **Windows self-update recovery**: extraction now also makes a temporary `.zip` copy when an older staging path is extensionless, preventing the `Expand-Archive` format error reported in #30.

## [1.1.27] - 2026-08-03

### Fixed

- **Negative skill XP after character restore**: PanelBridge now ensures restored cumulative XP is never below the restored skill level's threshold. This prevents invalid states such as Welding level 5 with 0 XP, which Build 42 displays as negative progress.

## [1.1.26] - 2026-08-03

### Fixed

- **Sandbox configuration before first launch**: the Sandbox editor now opens with Project Zomboid defaults and creates a valid `SandboxVars.lua` on its first save, instead of requiring an administrator to manually create the file.
- **Build 42 anti-cheat settings**: replaced stale Build 41 controls with the current Build 42.20 anti-cheat keys and their correct Ban, Kick, Log, and Disabled values.
- **Valid item IDs**: item actions now accept Build 42 IDs that start with digits or contain documented punctuation, including `Base.556Clip` and `Base.3030Bullets`.
- **Vehicle map spawning**: map vehicle spawns now use the supported RCON `addvehicle` command on Build 42, returning a direct success or failure result instead of relying on unavailable Lua APIs.
- **Windows launcher line endings**: `Start.bat` is now always distributed with CRLF line endings, preventing `^M` command failures on Windows.

## [1.1.25] - 2026-08-03

### Fixed

- **Obsolete image settings**: removed the login, loading, and server-icon image controls. These INI options existed in Build 42.13, but Project Zomboid later made them obsolete and now discards them during `reloadoptions`, making the panel appear not to save the selected files.
- **Character inventory restore**: PanelBridge 1.7.17 now exports Build 42 inventory and worn-item Java lists correctly, so imported characters recover their saved items.
- **Discord relay and permissions**: Discord-to-game messages no longer echo back as duplicates, dedicated relay channels work both ways, and role-protected slash commands stay locked when no role is configured.
- **Discord delivery resilience**: invalid or non-text channels now report failed sends, oversized game-chat messages are capped below Discord's limit, and failed bot login cleanup no longer throws.
- **World map alignment**: custom map tiles and proxy bounds now remain centered with the game world.

## [1.1.24] - 2026-08-03

### Added

- **Docker runtime PUID/PGID**: prebuilt panel images now accept `PUID` and `PGID` environment variables, so bind-mounted PZ directories can use their existing owner without rebuilding the image. Startup re-owns only panel state and logs, never game or save mounts.

## [1.1.23] - 2026-08-02

### Fixed

- **Linux release artifacts**: the standalone Linux build no longer attempts to bundle SSH2's optional architecture-specific native addons. SSH2 uses its built-in JavaScript fallback, allowing GitHub Actions to create Linux binaries and archives again.

## [1.1.22] - 2026-08-02

### Fixed

- **First server startup**: the setup wizard now persists the configured admin password. New servers launch with `-adminpassword` instead of Project Zomboid attempting an unavailable interactive stdin prompt and exiting immediately.

## [1.1.21] - 2026-08-02

### Fixed

- **Remote server status**: remote servers are now considered online when RCON is connected or PanelBridge has a fresh heartbeat. The dashboard no longer marks a healthy hosted server inactive just because there is no local Java process to inspect.
- **SFTP PanelBridge commands**: queued commands upload before remote status/result reads and have a 60-second timeout, preventing high-latency VPS SFTP syncs from timing out before the game mod can respond.

## [1.1.20] - 2026-08-02

### Added

- **Remote PanelBridge over SFTP**: VPS and hosted-server operators can connect PanelBridge with SFTP credentials and an absolute remote bridge path. The panel synchronizes only the small status, queue-state, command-result, and queued-command files through a local cache. The Settings flow tests connectivity, reports round-trip latency, masks the saved password, and offers a configurable 2-10 second sync interval.
- **Mapped-drive support for remote PanelBridge**: an explicitly configured read/write path, including an SFTP-mounted drive such as RaiDrive, can now power PanelBridge for a remote server.
- **Force Stop**: Dashboard now provides a confirmation-gated emergency stop that kills the managed PZ process without requiring RCON. It refuses ambiguous multi-server process detection rather than risking the wrong server.
- **Collection cookie shortcut**: Workshop Collection now has a compact paste action for a Steam `Cookie:` header or copied cURL request. It extracts and stores `sessionid` and `steamLoginSecure` without navigating to Settings.
- **Utility controls**: Events has direct restore/shutoff actions for server electricity and water.

### Changed

- **PZ memory reporting**: normal JVM heap allocation is now shown as `normal` instead of being treated as a host-memory alert. Actual host RAM pressure remains monitored.
- **Scheduled restarts**: a restart stays pinned to the server it started against, even if the active server changes in the panel.

### Fixed

- **Sandbox and utility persistence**: edits to top-level sandbox values now write `<server>_SandboxVars.lua`, so changes survive restart. PanelBridge 1.7.16 also applies electricity/water changes correctly in the running world.
- **Unsafe backup restore**: restore is blocked while the target server is still running, preventing the running world from overwriting the restored save.
- **Mod-update restart settings**: legacy settings are normalized on load, and unknown player count keeps an automatic restart on hold instead of restarting blindly.
- **Workshop sync feedback**: Steam-rejected collection items now return their resolved titles rather than opaque IDs alone.

## [1.1.19] - 2026-08-01

### Fixed

- **Standalone update download failed with `expected MZ header, got 0x504b`**: the updater correctly downloaded the Windows ZIP needed to refresh `client/dist`, but incorrectly validated it as an executable. ZIP and gzip package signatures are now validated separately from executable signatures.

## [1.1.18] - 2026-07-31

### Fixed

- **Mod-update auto-restart could leave the server offline**: Settings saved the toggle and delay under different keys from the mod checker. After a panel restart it restored auto-restart as disabled, detected updates, and never scheduled the server restart. Existing values now migrate automatically, and saving the settings applies them to the running checker immediately.

## [1.1.17] - 2026-07-31

### Fixed

- **Standalone auto-updates left the web UI behind**: the updater downloaded only the executable, while the dashboard is served from the adjacent `client/dist` directory. It now verifies the matching platform archive and refreshes that directory too, without touching `data/`.

## [1.1.16] - 2026-07-31

### Added

- **Dashboard LAN Address picker**: Settings > Panel Settings now lists each non-internal IPv4 interface, so hosts running Tailscale, ZeroTier and a physical LAN can choose the address shown on the dashboard.

### Fixed

- **Dashboard React crash**: the LAN-address change accidentally returned an unresolved Promise as `{}` from panel-info. The dashboard now receives a real IP address.
- **Removed mods remained tracked**: tracking added IDs from `WorkshopItems=` but never removed old records. Opening Mod Manager now reconciles the list with the active server INI and prunes IDs no longer configured there.

## [1.1.15] - 2026-07-31

### Fixed

- **Mod settings did not survive a restart**: changing a setting on the Mod Settings tab only set the value on the running server. Nothing ever wrote `<server>_SandboxVars.lua`, which is the file the server reads at boot, so every mod option silently reverted on the next restart. Each edit is now written to that file as well.
- **Mod settings often had no effect at all**: PanelBridge set the value on the Java option but left the `SandboxVars` table stale, and that table is what mod code actually reads. The bridge now refreshes it (PanelBridge 1.7.15).
- **Numeric mod settings rejecting valid input**: options whose minimum was a fraction, such as `0.001`, refused whole numbers, because browsers count valid values up from the minimum in step increments. Only genuine integer options are constrained now.
- **Add XP was missing nine B42 skills**: Blacksmithing, Carving, Glassmaking, Knapping, Masonry, Pottery, Animal Care, Butchering and Tracking could not be selected at all.
- **Add XP silently doing nothing**: the perk name was quoted, which the server tokenises as two arguments and then rejects without an error.
- **God mode and invisibility**: these commands have no form that targets another player, so over RCON they were always a no-op. They now go through PanelBridge, which sets the flag on the player.
- **World Map tiles failing to load ("signal.lost / tiles offline")**: an earlier merge's map fallback and geometry-resolution logic had been committed but never actually deployed to the live server, so the client called a resolve endpoint the running backend didn't have. Redeployed; tiles load again.

### Added

- **Settings > Network: Dashboard LAN Address**: pick which detected network interface's IPv4 the dashboard displays, for hosts running more than one network (e.g. Tailscale and ZeroTier at once).

### Changed

- **Add XP perk list**: perks are now grouped by category and labelled the way the in-game skills screen labels them, rather than by internal id. Twelve differ, including Carpentry, Foraging, Welding and First Aid.

## [1.1.14] - 2026-07-30

### Fixed

- **World Map tiles**: the fallback that switches to a fully-rendered older B42 map build when the newest one isn't rendered upstream yet was deployed live in v1.1.12/v1.1.13 but never actually committed — this release includes it for real. If tiles were still failing to load on 1.1.13, this fixes it.
- **Public IP**: the address shown on the dashboard now expires its cache after 6 hours instead of indefinitely, so a residential ISP rotating your WAN IP no longer leaves a stale, no-longer-yours address displayed forever.

## [1.1.13] - 2026-07-30

### Fixed

- **World Map vehicle layer stuck at "0 loaded"**: `vehicles:get(i)` was called with no safety check, unlike the `.size` lookup right above it. On this game version that call threw "Object tried to call nil in pcall" for every vehicle every ~5s, flooding the server console. Now guarded the same way, along with a third call site that had the identical issue. PanelBridge bumped to 1.7.13, which also folds in the fork's parallel 1.7.11/1.7.12 work.

## [1.1.12] - 2026-07-30

### Fixed

- **"Remove from server" leaving mods active**: the action could report success and ignore-list a mod while silently leaving it in `Mods=`/`WorkshopItems=`. Ignore-list writes are now gated on the INI edit actually running, and `delete-disk-mod` got the same fix.

## [1.1.11] - 2026-07-29

### Docker

- **Compose installer**: documented `docker-compose.install.yml` for starting the published panel image with persistent Docker volumes.
- **Release package**: made the included Compose installer and its exact command visible in the generated release README.

### Fixed

- **Stale Steam operations**: install and update locks now track the SteamCMD process and clear automatically when that process has exited, preventing a dead operation from permanently blocking its install path.

## [1.1.10] - 2026-07-29

### Fixed

- **Linux first-time server installation**: the setup wizard now offers the safe systemd service path, `/opt/zomboid-panel/data/pzserver`, and explains that the paired `_Data` folder is created automatically for settings and save data.
- **Folder picker errors**: Linux directory browsing now reports the actual filesystem error code and the required service-account permissions instead of a generic “Access denied”.
- **Release documentation**: the packaged Linux README and the main setup guide include a copy-paste command for creating the safe install folder. They also explain how to use a custom `/opt` path safely through `ReadWritePaths`.
- **Clean dependency installs**: regenerated both lockfiles so `npm ci` no longer fails on a fresh checkout.

## [1.1.9] - 2026-07-29

### Fixed

- **PanelBridge on Build 42 build 24449161** — the Project Zomboid update released on 2026-07-29 restricted `getFileWriter` to an extension whitelist. Writing a `.json` file now returns `nil`, so the Lua mod silently failed on every file it owns and the heartbeat, queue state, and command results stopped reaching the panel. The server appeared permanently unresponsive.
- **Bridge file naming** — PanelBridge `1.7.8` appends `.txt` to every file it writes (`status.json.txt`, `outbox/res-<seq>.json.txt`, and so on). The folder layout is unchanged. Files the panel writes — `commands.json` and `inbox/cmd-*.json` — keep their plain names, because the panel is not affected by the restriction.
- **Backwards compatibility** — the panel prefers the new `.txt` files and falls back to the legacy names, so a server still running an older mod or an older game build keeps working without manual migration.
- **PanelBridge 1.7.4 regression** — reverted the `.init` sentinel shortcut added in 1.1.7. It skipped the sentinel write whenever the file already existed, which was never the real cause of the Build 42 failures.

## [1.1.8] - 2026-07-29

### Fixed

- **First-time reverse-proxy setup**: CORS block messages now explain how to set `CORS_ORIGINS` before an administrator account exists, without relaxing the origin policy.
- **Docker path permissions**: install and data-path validation now identifies missing writable bind mounts and container UID/GID ownership. The shipped Compose example correctly marks the PZ install mount writable for panel-managed install, update, and start workflows.

## [1.1.7] - 2026-07-29

### Fixed

- **PanelBridge on Build 42**: startup now accepts its existing `.init` sentinel instead of failing when Build 42 refuses to reopen it with `getFileWriter`. This restores PanelBridge initialization and its `status.json` heartbeat after a server restart.
- **PanelBridge version reporting**: the Lua runtime now reports `1.7.4`, matching the existing mod metadata so version-based deployment can recognize the fixed mod.

## [1.1.6] - 2026-07-29

### Fixed

- **Docker SteamCMD support**: the standard amd64 Docker image now uses a glibc-based runtime with Bash and the required 32-bit SteamCMD libraries, so Linux Docker installations can use the panel's SteamCMD setup and update workflows. The image remains multi-architecture for arm64 remote-server administration. Thanks to @Lynkes for identifying the Docker compatibility issue in [#16](https://github.com/fpsacha/zomboid-control-panel/pull/16).
- **Clean Docker builds**: the image no longer requires an untracked generated browser-extension ZIP that is excluded from the Docker build context. The extension download endpoint continues to report clearly when a bundle is unavailable.

## [1.1.5] - 2026-07-29

### Fixed

- **Unstable-to-Stable server upgrades**: fixes a SteamCMD bug where a dedicated-server install previously mounted to the Unstable branch could not update to Public (Stable), failing with an opaque access-denied exit code. The panel now backs up and clears only the stale app manifest before rebuilding Stable branch metadata. Save data, Workshop downloads, and game files remain in place.

## [1.1.4] - 2026-07-29

### Changed

- **Portable all-in-one Docker setup**: the public installer now resolves the latest release, stores its build state in a normal per-user directory by default, and uses Docker named volumes for panel data, logs, the PZ installation, and world saves. It no longer assumes an Unraid filesystem layout or a `zomboid.tower` hostname.
- **Portable network configuration**: new installs default to `http://localhost:3001`; remote-access, LAN address, and WAN address values are explicit optional configuration rather than values copied from a specific deployment.

## [1.1.3] - 2026-07-29

### Fixed

- **Docker update controller startup**: the updater image now clears the Docker CLI base image entrypoint before starting Node, preventing `node server.js` from being interpreted as a Docker subcommand and allowing the panel update controller to become healthy.

## [1.1.2] - 2026-07-29

### Added

- **Docker in-panel updates**: all-in-one deployments can now update from Settings. The token-protected updater saves and stops Project Zomboid through RCON, downloads the chosen GitHub release, rebuilds and health-checks the container, and restores the prior source and image if the rollout fails.

### Fixed

- **All-in-one Docker paths**: Workshop scanning and B42 log discovery now use the configured `PZ_SERVER_PATH` and `PZ_SAVE_PATH` when no panel server record exists yet.
- **All-in-one server status**: the Docker image includes `procps`, so the panel can use `pgrep` and `ps` to detect the running Java server accurately.

### Changed

- **Docker network addresses**: all-in-one deployments can set the LAN and WAN addresses in `.env`, preserving correct join and panel links after an in-panel update.

## [1.1.1] - 2026-07-28

### Added

- **Dependency-aware load order auto-sort**: the Load Order tab can now propose an order that places every mod declaring `require=` in its `mod.info` after the mods it depends on. Mods without a declared dependency keep their existing position, so the arrangement you built by hand is preserved rather than replaced by an alphabetical list.
- **Reviewable sort proposal**: auto-sort never writes on its own. It presents the mods that would move with their before and after positions, and the order is only staged when you apply it and saved when you confirm with Save Order.
- **Sort diagnostics**: circular `require=` chains are reported by name and keep their current order instead of being reordered arbitrarily, and requirements that point at mods which are not enabled are counted and surfaced rather than silently discarded.

### Changed

- **Focused move reporting**: the proposal lists only the mods whose position genuinely had to change, instead of every mod whose index shifted because an entry above it moved.

## [1.1.0] - 2026-07-28

### Added

- **Collection-first Steam Workshop management**: the Collection tab now identifies whether each item is tracked, in the Steam collection, and configured on the active server. Add collection items directly to the server, or remove server mods individually or in bulk after changing the Steam collection.
- **Complete server-enable action**: adding a mod from Collection updates `WorkshopItems=`, discovers and writes its internal mod ID to `Mods=`, includes map folders when available, and begins tracking the mod for update checks.
- **Safer collection synchronization**: optional collection-only mods are now a first-class neutral state instead of a false mismatch. Sync adds tracked mods that are missing from Steam without silently deleting optional collection items.
- **Operational dashboard signals**: added host disk headroom, next scheduled maintenance action, and current console error count to the dashboard.
- **Clearer collection actions**: bulk actions are disabled when they cannot apply to the current selection, and every mod row states whether it is on the server.

### Fixed

- **Mod removal semantics**: Collection-tab untracking no longer creates an ignore rule or changes Steam membership. Server removal consistently removes the mod from the server INI and tracking state, then mirrors to Steam only when collection auto-sync is enabled.
- **Workshop title resolution**: tracked and deactivated mods now resolve their real Steam titles automatically when local workshop files are unavailable; generic `Workshop Mod <id>` labels are repaired and persisted without manual intervention.
- **Steam collection rate limiting**: collection mutations use a dedicated limiter so normal collection management no longer collides with sensitive-operation limits.
- **Collection title accuracy**: placeholder tracked names no longer block Steam title lookups in the collection view.
- **Mod configuration reliability**: server mod removal handles Workshop IDs, internal mod IDs, and map-folder cleanup together; collection-driven server actions follow the same safe path.
- **Settings reliability**: browser-extension downloads are packaged in Docker images and clipboard copy falls back for browsers running on non-HTTPS local panel URLs.
- **Dashboard polish**: telemetry rows retain fixed geometry, the removed trace mode no longer leaves stale controls, and duplicated oversized error verdicts were replaced by a compact errors work item.

### Changed

- **Steam collection workflow**: the Collection tab is now the practical place to reconcile Steam membership with server configuration. With auto-sync enabled, removing a mod from the server also removes it from Steam; with auto-sync disabled, Steam membership stays unchanged and the UI says so.
- **Advanced mod actions**: `Remove from server INI` and `Remove from server` now have distinct names, shared destructive iconography, and hover explanations that make their tracking behavior explicit.

## [1.0.77] - 2026-07-22

### Added

- **SteamCMD discovery**: the server update dialog now detects and saves an installed SteamCMD path automatically, including the `/home/steam/steamcmd` location used by the all-in-one Docker image.
- **Branch details**: the server update dialog now explains the selected Steam channel and displays its Steam build number and last-updated time when available.

## [1.0.76] - 2026-07-22

### Fixed

- **All-in-one Docker update controller**: update and rollback Compose commands now load the deployment `.env` file, preserving required CORS and controller-token settings when the panel container is recreated.

## [1.0.75] - 2026-07-22

### Added

- **All-in-one Docker updater**: an opt-in, token-protected controller can download a tagged GitHub release, rebuild the all-in-one image, recreate the panel container, verify its health, and roll back the source and image if the rollout fails.
- **Docker update workflow**: Settings now offers an explicit Docker update confirmation that saves and stops Project Zomboid through RCON before recreating the container.
- **Host-independent bootstrap**: the all-in-one setup script runs Docker Compose inside the updater image, so Unraid hosts do not need a local Docker Compose installation.

## [1.0.72] - 2026-07-22

### Fixed

- **Configurable Steam Workshop update frequency**: the Mod Update Settings interval now accepts whole-minute values from 1 to 120 and applies a saved change immediately, without restarting the panel.
- **One-minute polling regression**: Settings stored values in minutes but startup treated them as milliseconds and clamped them to one minute. Existing millisecond values are migrated safely, and invalid values are rejected.
- **Mod-check timer edge cases**: rescheduling clears stale delayed startup checks without interrupting a pending player-aware restart; unexpected scheduled-check failures are caught and logged.

## [1.0.70] - 2026-07-17

### Added

- **Sandbox diagnostics + auto-repair**: detects a corrupted `SandboxVars.lua` (mismatched braces) and surfaces it as a critical Debug finding, with a one-click automated repair action (backs up the original file first, refuses to write unless the repair is verified syntactically balanced).

### Fixed

- **SandboxVars.lua values containing commas inside quotes could get corrupted when edited through the Sandbox editor**: settings like `WorldItemRemovalList` and `LootItemRemovalList` were truncated at the first comma inside the quotes, corrupting the file and preventing the dedicated server from booting. Quoted string values are now treated as atomic when parsing/writing.

## [1.0.68] - 2026-07-16

### Fixed

- **PanelBridge mod (v1.7.4): server freeze on Restore/Shut Off Utilities**: restoring or shutting off power/water scanned tens of thousands of grid squares synchronously on the game tick, freezing the whole server for every player. The scan now runs as a background job chunked across ticks when triggered from the panel.
- **PanelBridge mod (v1.7.4): character import drained real skill points**: restoring a saved character's perk levels called the skill-point-consuming `LevelPerk` variant, silently spending the live player's own unspent skill points on every restore. Now uses the no-cost restore path.

## [1.0.65] - 2026-07-13

### Fixed

- **Discord bot crash on newer Node versions (full fix)**: the earlier fix only covered slash-command registration. The Discord client's internal REST — used for login, notifications, the "Send Test Message" button, chat relay, and command replies — still crashed on Node 22+/24+ with the `Symbol(sensitiveHeaders)` header error. All Discord API traffic now goes through the safe request path.

### Security

- **Discord mention injection**: player-controlled text (in-game chat relay and player join/leave/death notifications) could ping Discord roles or users via raw mention syntax like `<@&roleId>`. The bot now blocks all outbound mentions, so relayed chat and notifications can no longer ping anyone.

### Changed

- Replaced the deprecated Discord `ephemeral` reply option with the current `MessageFlags.Ephemeral` form.
- Added a request timeout to the Discord token test so a stalled Discord API can no longer hang the check.

## [1.0.64] - 2026-07-07

### Fixed

- **World map and chunk cleaner tile loading**: fixed the Project Zomboid map tile breakage after the B42 CDN migration from b42map.com to map.projectzomboid.com. The panel now proxies tiles through the backend and resolves the current B42 map directory dynamically from upstream metadata, so newer map builds continue to work without manual updates.
- **Discord bot startup crash**: fixed a compatibility issue with newer Node/undici versions that caused the Discord bot to crash during REST requests. Discord API calls now use a safe request path that avoids the header constructor failure.
- **Server names with spaces**: server creation and validation now accept names containing spaces while still rejecting unsafe path characters.

### Changed

- **Release pipeline**: removed the hard dependency on the old garage deployment share so packaging and release steps no longer block on that dead target.

## [1.0.27] - 2026-05-13

### Fixed

- **Mod update restart loop for mods removed from INI**: if a previously subscribed mod was deleted from `WorkshopItems=` but still had a newer version on Steam, the panel kept flagging it as "Update available" and queued a `Restart Pending` cycle that could never resolve (a restart can't apply a mod the server isn't subscribed to). `modChecker.checkForUpdates()` now filters out updates for any workshop ID not present in the active server's INI before they reach the auto-restart pipeline.
- **"Flags out of sync" false positive from phantom updates**: `getStatus().updatesAvailable` was counted directly from the Workshop ACF without consulting the server INI, so even after the filter above the UI still showed `1 mod update reported by Steam — flags out of sync` and prompted a re-check. The status count is now filtered against `WorkshopItems=` as well.
- **Cancelling a pending mod-update restart silently disabled future auto-restarts for those mods**: `cancelPendingRestart()` left the `processedUpdates` dedup map populated, so the next poll cycle treated the same Steam timestamps as "already processed" and skipped them indefinitely. The map is now cleared on cancel, re-arming detection on the next check.

## [1.0.6] - 2026-04-16

### Fixed

- **RCON detection with WinGSM and other wrappers**: the panel failed to detect servers launched through WinGSM because the wrapper's process arguments did not match the old strict regex. `isWindowsDedicatedServerCommandLine` now recognizes WinGSM-wrapped launches, native `ProjectZomboid64.exe` with `-server`/`-servername`, and generic Zomboid command lines.
- **RCON startup port-probe fallback**: when Windows process detection returns a false negative (permissions, wrappers, unusual launchers), the panel now probes the RCON port directly at startup and connects immediately if it is listening, instead of waiting up to 60s for the auto-reconnect loop.
- **Stale RCON credentials after editing active server**: previously, editing the active server's RCON host/port/password kept the running RconService using cached credentials until the panel was restarted. Editing the active server now reloads and reconnects RCON and refreshes ServerManager paths when relevant fields change.
- **Force stop failed on wrapped servers**: the Windows force-kill path used a hardcoded PowerShell pipeline that only matched the raw `zombie.network.gameserver` Java class. WinGSM-wrapped or native-launcher processes were not stopped. Force stop now scans processes via WMI, matches them with the shared wrapper-aware logic, and falls back to generic kill only if detection fails.
- **Log download 401 errors**: "Download combined.log" and "Download error.log" in `/debug` used plain `<a href>` links that skipped the JWT bearer header. Replaced with authenticated `Blob` downloads.

### Added

- **Support Bundle ZIP**: new "Download Support Bundle (.zip)" button on `/debug` aggregates panel logs (`combined.log`, `error.log`), Zomboid install logs (`connection_log`, `workshop_log`, `content_log`, etc.), server runtime logs (`server-console.txt`, chat/debug logs), and any matching crash dumps (`hs_err_pid*`) into a single zip stream for bug reports.

### Changed

- **Safer Windows force stop**: `-server` / `startserver` in a command line alone no longer counts as a PZ server match. The native launcher or an explicit Zomboid path is now required, so unrelated Java processes on the same machine (for example a Minecraft server started with `java -server`) can never be falsely identified or killed by the panel.

## [1.0.1] - 2025-04-12

### Added

- **World Map — Vehicle overlay**: see every vehicle on the map, color-coded by fuel level. Right-click for quick actions (repair, fill fuel, charge battery, remove).
- **World Map — Safehouse overlay**: safehouses rendered as isometric diamonds with owner labels. Active safehouses glow brighter when a player is connected.
- **World Map — Toggle buttons**: Car and Home icons in the toolbar to show/hide vehicles and safehouses independently.
- **Chunk Cleaner — Vehicle overlay**: vehicles shown as colored dots on the chunk map with fuel-level coloring.
- **Chunk Cleaner — Safehouse overlay**: safehouses shown as dashed-border rectangles with owner labels.
- **Chunk Cleaner — Vehicle removal on delete**: checkbox in the delete dialog to remove vehicles in the selected area before chunk deletion, preventing orphaned entries in vehicles.db.
- **Chunk Cleaner — Safehouse warning**: delete dialog warns when safehouses overlap the selected chunks, listing affected owners.
- **PanelBridge `removeVehicle` handler**: permanently remove a single vehicle by ID.
- **PanelBridge `removeVehiclesInArea` handler**: remove all vehicles within a coordinate bounding box.

### Fixed

- "Ekron" label on both World Map and Chunk Cleaner corrected to "Fallas Lake".
- Vehicle overlay coordinate validation in Lua now checks `nil` instead of `== 0` (0,0 is a valid PZ coordinate).
- Safehouse label deduplication — owner name no longer shown twice when it matches the safehouse title.
- Stale overlay data cleared when switching saves in Chunk Cleaner.
- Delete dialog "Remove vehicles" checkbox resets on each open (no stale state from cancelled dialogs).

### Changed

- Vehicle fuel-level colors pre-resolved to canvas color refs instead of calling `getComputedStyle()` per frame per vehicle.
- Safehouse owner list in delete dialog truncated to 5 entries with "+N more" overflow.

## [1.0.0] - 2025-04-10

### Added

- Full-featured web admin panel for Project Zomboid dedicated servers.
- Dashboard with real-time server status, player list, and quick actions.
- Interactive World Map with DZI tile rendering, player position tracking, airdrops, and landmark labels.
- RCON console with command history and autocomplete.
- Player management: kick, ban, teleport, heal, godmode, inventory, character export/import.
- Weather and climate control via PanelBridge (storms, temperature, fog, wind, snow).
- Mod tracker with Steam Workshop update detection.
- Scheduler for automated tasks (restarts, backups, messages) via cron.
- Backup and restore with zip archives.
- Chunk Cleaner for resetting map areas with visual chunk selection.
- Server config INI editor with validation.
- Multi-server support with server finder auto-detection.
- Discord bot integration for server status and player notifications.
- PanelBridge Lua mod for advanced in-game operations (B41 + B42 compatible).
- JWT authentication with rate limiting and CORS configuration.
- Standalone Windows .exe and Linux binary builds via pkg.
- Docker support with docker-compose.
- 6 color themes (Dark, Midnight, Crimson, Forest, Hacker, Vapor).
- Responsive design with mobile support.

[1.0.6]: https://github.com/fpsacha/zomboid-control-panel/compare/v1.0.1...v1.0.6
[1.0.1]: https://github.com/fpsacha/zomboid-control-panel/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/fpsacha/zomboid-control-panel/releases/tag/v1.0.0

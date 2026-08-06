# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

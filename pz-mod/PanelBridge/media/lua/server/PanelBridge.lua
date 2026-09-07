---@diagnostic disable: undefined-global, deprecated
--[[
    PanelBridge - Server-side mod for Zomboid Control Panel
    Version: 1.7.54

    This mod enables external control panel communication with the PZ server.
    Communication happens via JSON files in the server save folder.

                v1.7.54 Changes:
                - Fix: readJSON() called json.decode with no pcall protection,
                    while processQueuedCommands wrapped the identical decode
                    500 lines away specifically because a malformed file
                    can't be allowed to throw. Same risk on all four readJSON
                    callers (queue state load, inbox resync self-heal, and
                    both legacy commands.json reads) is now closed the same
                    way: a decode failure returns nil (treated as absent
                    state, not empty) instead of crashing the mod's update
                    tick.

                v1.7.49 Changes:
                - Fix: Build 42 exposes VehicleParts as Java userdata;
                    capabilityKey() no longer indexes getClass on userdata,
                    which was flooding the dedicated log with Kahlua
                    "attempted index: getClass of non-table" traces during
                    vehicle detail polling.

                v1.7.48 Changes:
                - Bundled with panel v1.2.12. No additional bridge
                    protocol changes.

                v1.7.47 Changes:
                - Bundled with panel v1.2.11. No additional bridge
                    protocol changes.

                v1.7.46 Changes:
                - Fix: on a fresh world, Build 42 can report its sandbox
                    countdown as still powered while the live hydro state is
                    off. Startup now restores hydro power only when the same
                    countdown formula the game uses says scheduled power has
                    not yet shut off; intentional instant/expired settings
                    remain off.

                v1.7.45 Changes:
                - Fix: triggerSwarmEvent used to go straight to the
                    fire-and-forget horde APIs (createHordeInAreaTo/
                    createHordeFromTo/CreateSwarm) with no count to read
                    back. Now tries VirtualZombieManager.createRealZombieNow
                    first, same as spawnHordeNearPlayer/BehindPlayer, and
                    reports a real per-zombie spawned count when it does.
                - Fix: removeVehicle reported success purely on the removal
                    call not throwing. Now re-checks the vehicle's presence
                    via getVehiclesList() immediately after removal and only
                    reports success once it's genuinely gone -- confirmed
                    safe via javap -c: BaseVehicle.permanentlyRemove()/
                    removeFromWorld() both synchronously remove from
                    IsoCell's live vehicle Set, no tick-loop delay like the
                    ClimateFloat case had.

                v1.7.44 Changes:
                - Fix: setSnow/startRain/stopRain, the daylight/night/
                    desaturation/view-distance/ambient/temperature/wind/fog/
                    cloud climate floats, the generic setClimateFloat, and
                    resetClimateOverrides now confirm their write actually
                    took effect (getAdminValue/getPrecipitationIsSnow/
                    getPrecipitationIntensity/isRaining/isEnableAdmin, each
                    chosen per-handler against what is actually safe to read
                    immediately -- getFinalValue() is NOT, confirmed via
                    javap -c: it is not refreshed until the next natural
                    game tick) instead of reporting success on invoke() not
                    throwing.

                v1.7.43 Changes:
                - Fix: triggerBlizzard/triggerTropicalStorm/triggerStorm all
                    discarded the real boolean triggerCustomWeatherStage
                    returns, so triggering a second storm while one was
                    already running reported success and did nothing.
                - Fix: generateWeather tried a CLIENT->SERVER-only request
                    packet FIRST (never throws, so the real method was never
                    reached), meaning it very likely did nothing at all on
                    every real call. Now tries the real, verifiable method
                    first whenever the front type supports it.
                - All four now report ok=false with an actionable message
                    when a weather period is already running, instead of a
                    false success.

                v1.7.42 Changes:
                - Fix: stopWeather never cleared a lingering rain
                    admin-override left by startRain/setSnow -- "Stop All
                    Weather" correctly stopped the weather period, but
                    admin-forced rain (a separate ClimateFloat mechanism)
                    kept falling forever. Now also clears it and verifies
                    isRaining() before reporting success.
                - Fix: runEventSequence's `ok` field now reflects whether any
                    step actually failed, not just whether the loop finished.
                - Fix: json.decode dropped \uXXXX escapes into literal
                    "uXXXX" text instead of the real character.
                - This bump exists because the installer (panelBridgeInstaller.js)
                    only redeploys on a VERSION string difference -- the three
                    fixes above landed without one, so a server whose bridge
                    was never separately reinstalled since 1.7.41 does not
                    have them yet even though this VERSION says otherwise.

                v1.7.41 Changes:
                - Fix: the v1.7.12 inbox-desync resync (tryResyncInboxCursor)
                    trusted the panel's declared write position
                    (.queue-state-node.json) unconditionally, including moving
                    lastCommandSeq BACKWARD if that file's value was ever
                    lower than what this process had already processed -- a
                    real hazard demonstrated the same day by four zombie
                    nodemon-wrapped panel processes independently writing
                    that file. The resync is now forward-only, matching the
                    equivalent guard already shipped in panelBridge.js for
                    the opposite (results) direction. Also shortened the
                    stuck-detection window from 20s to 10s, comfortably under
                    Node's own 15s local-transport command timeout, so a real
                    desync always resolves before Node gives up on the
                    caller's request rather than 5s after.

                v1.7.40 Changes:
                - Fixed horde spawning to use the coordinate-aware
                    createRealZombieNow API and report zero-result failures.

                v1.7.39 Changes:
                - getServerInfo now sends isAlive, isInfected and accessLevel
                    per player. Previously absent from the wire entirely (not
                    conditional) -- the panel rendered "alive, uninfected,
                    non-admin" for every player regardless of actual state.
                    Client gates these three fields on this bridge version so
                    an older bridge is never misread as confidently-wrong data.

                v1.7.38 Changes:
                - Bundled with panel v1.1.54. No bridge protocol changes.

                v1.7.36 Changes:
                - Bundled with panel v1.1.49. No bridge protocol changes.

                v1.7.35 Changes:
                - Fixed triggerLightning on Build 42.20 by calling the
                    server-side ThunderStorm event directly. The climate
                    transmit helper can return without an error while no
                    lightning reaches connected clients.

                v1.7.34 Changes:
                - Bundled with panel v1.1.48. No bridge protocol changes.

                v1.7.33 Changes:
                - Bundled with panel v1.1.45. No bridge protocol changes.

                v1.7.32 Changes:
                - Bundled with panel v1.1.44. No bridge protocol changes.

                v1.7.31 Changes:
                - Bundled with panel v1.1.43. No bridge protocol changes.

                v1.7.30 Changes:
                - Bundled with panel v1.1.42. No bridge protocol changes.

                v1.7.29 Changes:
                - A Java method that is unavailable is now retried only a few
                    times before it is remembered as missing. Kahlua reports a
                    missing method as an empty RuntimeException, so the previous
                    text match never recognised it and the engine retraced the
                    same call on every poll. A method that has succeeded once is
                    never disabled, so one broken modded object cannot turn off
                    a working accessor.

                v1.7.28 Changes:
                - Game-time reads only call documented Build 42 clock methods.
                    Optional getter probes emitted a full Kahlua trace when
                    unavailable, even inside pcall.

                v1.7.27 Changes:
                - Healing no longer probes optional body-damage, Stats, or
                    Moodles Java methods. Build 42 logs a full engine trace
                    for each unavailable probe even inside pcall; healing now
                    uses only the documented body-part collection.

                v1.7.26 Changes:
                - Player health actions use the Build 42 body-part collection
                    and native death path without probing absent APIs.

                v1.7.24 Changes:
                - Java methods are now probed by calling them and caching the
                    outcome per class, instead of testing obj.method as a field.
                    A field test reports false for methods that are callable but
                    not exposed as Lua fields, which silently returned zero
                    vehicles (v1.7.23) and let safeGetValue fabricate defaults
                    such as game-time year 1993. A genuinely missing method now
                    costs one engine stack trace per class per session rather
                    than one per tick, and a getter that throws for a broken
                    modded object is never marked unavailable.
                - Live-state caches (vehicles, safehouses, player details) are
                    invalidated after any state-changing command, so a repair,
                    refuel, or battery change is no longer masked for 5 seconds.
                - Queue bookkeeping writes dropped from about five files per
                    command to two: the duplicate inbox cursor write is gone and
                    queue state is persisted once per tick instead of once per
                    result.
                - The legacy commands.json intake is polled every 2s instead of
                    every tick. The panel only writes that file when a numbered
                    queue write fails, so it stays a working fallback.
                - json.encode has a recursion depth limit, and logging no longer
                    rescans the level table or shifts the whole ring buffer on
                    every call.

                v1.7.23 Changes:
                - World Map vehicle polling now skips Java collections that do
                    not expose get as a Lua method. Calling the missing method
                    inside pcall still produces a full PZ server stack trace.

                v1.7.22 Changes:
                - Game clock updates now fail when a Build 42 setter cannot apply
                    the requested value, instead of reporting a false success.

                v1.7.21 Changes:
                - Loaded vehicles reach the panel again. The vehicle list reports
                    its size correctly but does not expose get as a Lua field, so the
                    field-existence guard discarded every vehicle: a live server with
                    21 loaded vehicles returned count 0 and skipped 21. The World Map
                    then showed only vehicles read from vehicles.db, which have no
                    telemetry and no repair or battery controls, even when a player
                    was standing next to the car. Same root cause as the collection
                    guard fixed in v1.7.17. Also restores vehicle lookup by id, so
                    repair, battery, and area removal work again.

                v1.7.20 Changes:
                - Repair and battery controls now use Build 42 vehicle-part APIs.
                - Corrected the runtime version constant so automatic updates
                    recognize this bridge as newer than v1.7.19.

                v1.7.19 Changes:
                - Character imports now preserve the invariant that cumulative XP is
                    at least the threshold for the restored skill level. This prevents
                    invalid states such as level 5 with 0 XP, which render in-game as
                    negative XP progress.

                v1.7.18 Changes:
                - Item validation now accepts valid Build 42 IDs that include numbers
                    or documented punctuation, including Base.556Clip and
                    Base.3030Bullets.
                - Vehicle spawning on Build 42 now uses the panel's supported RCON
                    command path instead of unavailable Lua map APIs.

                v1.7.17 Changes:
        - Fixed character inventory, worn-item, and trait exports on Build 42.
            Java collection methods can be invoked with `:size()` but do not always
            appear as Lua fields, so the previous field-existence guard reported
            every collection as empty before attempting to read it.

        v1.7.15 Changes:
    - setSandboxOption now calls toLua() after setting the value. setValue only
      updates the Java object; mod code reads the global SandboxVars table,
      which stayed stale, so a changed mod option had no visible effect.

    v1.7.14 Changes:
    - teleportPlayer now reports which position-sync APIs actually exist on
      this build. Live results from 42.20.0 showed setNetworkTeleportEnabled
      and setLx are absent, so the server moved the player authoritatively
      but no client was ever told, and the client's own position won.

    v1.7.13 Changes:
    - Merge of two independent fixes that landed under different version
      numbers on diverging branches (this fork's v1.7.12 queue-resync fix
      and an upstream v1.7.10 vehicle-list guard fix; bumped past both to
      keep the auto-updater's strictly-newer check unambiguous):
    - [upstream] Fixed "Object tried to call nil in pcall" spamming the
      console every tick from getVehiclesDetailed / findVehicleById. Both
      called vehicles:get(i) unconditionally, but unlike the .size lookup
      just above it (already guarded with `vehicles.size and
      vehicles:size()`), .get was never guarded — so on servers where the
      vehicle-list object doesn't expose .get, EVERY vehicle lookup threw
      and vehicle data never reached the panel (World Map's vehicle layer
      was stuck at "0 loaded"). Now guarded the same way: `vehicles.get
      and vehicles:get(i) or nil`.
    - Applied the same vehicles:get(i) guard to the area-vehicle-removal
      handler, which had the identical unguarded call site the upstream
      fix above didn't reach.

    v1.7.12 Changes:
    - Fix: the inbox (commands) and outbox (results) queues each require an
      exact sequential file match on both sides, but neither side could ever
      recover if the two independently-persisted sequence counters
      (.queue-state-node.json on the panel side, queue-state-lua.json.txt on
      the mod side) drifted apart — e.g. the panel's queue state file getting
      reset by a container redeploy while this mod's counter kept climbing
      across an uninterrupted game server uptime. A drift left every command
      (including ping) waiting forever/for a very long time on a sequence
      number the other side would never (or not soon) produce, while status
      polling kept reporting healthy since it doesn't go through the
      sequential queue. processQueuedCommands() now detects a sustained
      (20s+) stall waiting on a missing inbox file, peeks at the panel's own
      declared write position in .queue-state-node.json, and resyncs
      lastCommandSeq to match it instead of waiting indefinitely. See the
      matching fix in panelBridge.js for the outbox/results direction.

    v1.7.11 Changes:
    - Perf: flushResults() no longer does a read-modify-write of a legacy
      results.json on every flush. That path only existed for a panel that
      hadn't negotiated protocolVersion=queue-v1, but panel and mod are
      always shipped/auto-updated together in this fork, so it was dead
      weight — doubling the I/O cost of every result flush for zero real
      consumers. onServerStarted() now also clears any stale results.json
      left behind by a pre-retirement mod version.

    v1.7.10 Changes:
    - Merge of two independent 1.7.9 fixes (fork and upstream landed on the
      same version number for different changes; bumped to keep the
      auto-updater's strictly-newer check unambiguous):
    - writeFile() now resolves panel-owned filenames (commands.json,
      inbox/cmd-*.json) to their plain path itself, matching readFile's
      existing logic, instead of relying solely on clearFile's guard.
      Nothing currently calls writeFile with those names, but the previous
      version would have silently written a wrong "commands.json.txt" had
      it ever been called that way.
    - ensureDirectory()'s write-capability fallback now probes a dedicated
      ".write-check" file instead of the real status.json — canWritePath
      actually writes its probe text, so probing the production file could
      briefly hand a reader "PanelBridge probe" instead of valid JSON.

    v1.7.9 Changes:
    - Stopped logging the chat-to-RCON handoff as a failure. sendToServerChat
      returns "useRCON" when neither ChatServer nor an online player is
      available, which tells the panel to deliver the message over RCON — the
      documented primary path. The dispatcher counted that as a failed command
      and logged it at WARN, so every scheduled broadcast sent while the server
      was empty printed "Command failed: sendToServerChat" in the console. The
      sentinel now logs at debug and no longer inflates commandsFailed. The
      result still goes back as unsuccessful, so the RCON fallback is unchanged.

    v1.7.8 Changes:
    - CRITICAL: Build 42 buildid 24449161 (2026-07-29) restricted getFileWriter
      to an extension whitelist. Writing a .json file now returns nil, so every
      Lua-owned bridge file silently failed and the heartbeat, queue state and
      command results stopped reaching the panel. getFileReader is unaffected.
      Verified live with a write probe: .txt is accepted, while .json, .init and
      extension-less names are rejected; nested paths themselves are still fine.
      Every file the mod writes now carries a .txt suffix, e.g.
      panelbridge/<server>/status.json.txt. Reads prefer the suffixed file and
      fall back to the legacy name, and panel-owned files (commands.json and
      inbox/cmd-*.json) keep their plain names because the panel writes them.
      Directory creation is now solely the panel's responsibility.

    v1.7.6 / v1.7.7 Changes:
    - Superseded by v1.7.8. These builds worked around the same regression by
      writing files flat in <cachedir>/Lua/, which was the wrong diagnosis: the
      restriction is on the file extension, not on directory separators.

    v1.7.5 Changes:
    - CRITICAL: Reverted the v1.7.4 .init shortcut. Skipping the sentinel write
      when the file already existed left the bridge directory uninitialized for
      the running session, so Build 42 refused every subsequent write into it
      ("Could not write to panelbridge/<server>/status.json" and friends) and
      the heartbeat never reached the panel. The sentinel is written on every
      startup again; the existing-file check is now only a non-fatal fallback.

        v1.7.4 Changes:
        - Fixed B42 startup when the PanelBridge .init sentinel already exists.
            Reusing the existing sentinel avoids a getFileWriter refusal that
            prevented the heartbeat event from being initialized.

        v1.7.3 Changes:
    - CRITICAL: Fixed VERSION constant regression. It had been hand-edited back
      to "1.2.2" (and mod.info modversion along with it) despite the file
      already containing features documented through v1.7.2 below. Since the
      panel's auto-updater only overwrites the on-server file when its
      embedded version is STRICTLY NEWER than what's installed, a server
      already running real 1.7.x content was being permanently skipped by
      future updates — the exact class of bug the panel binary itself hit
      (v1.0.66 self-reporting v1.0.65). VERSION and mod.info modversion must
      always be bumped together from now on.
    - Fixed JSON decoder: null values inside arrays no longer silently vanish
      and shift later elements' indices (e.g. [1,null,2] used to decode as
      {1,2}). Nulls now decode to a `json.null` sentinel so array length and
      positions are preserved; json.encode serializes the sentinel back to
      `null`. Object keys with a null value are unaffected (still become an
      absent key, which was already the intended/documented behaviour).
    - Fixed processedIds cleanup: the "drop oldest half" trim iterated
      `pairs()`, whose order is unspecified in Lua — so it was really
      dropping an ARBITRARY half, not the oldest. Now tracks insertion order
      explicitly (a small FIFO of ids) so the true oldest half is dropped.
    - Added short TTL caching (5s) for the read-only catalog/enumeration
      handlers that are either expensive to scan (getItemCatalog,
      getVehicleCatalog, getAllSandboxOptions) or polled on a fixed schedule
      by the panel (getVehiclesDetailed, getSafehouses, getAllPlayerDetails).
      A panel view left open on the Items/Vehicles/Sandbox page no longer
      re-triggers a full synchronous game-thread scan on every poll.

    v1.2.2 Changes:
    - Fixed JSON encoder: empty Lua tables now serialize as [] (array) instead of {} (object).
      The previous behaviour crashed panel consumers that did .map/.filter on
      collection fields like safehouses/factions/vehicles when the server was empty.
    - Hardened JSON decoder: malformed objects with non-string keys are skipped
      instead of crashing the command-poll loop.

    v1.2.1 Changes:
    - Synced runtime VERSION constant with mod.info (was 1.1.1)
    - No behavioural changes; bump triggers panel auto-update on existing servers

    v1.7.2 Changes:
    - Fixed teleportPlayer: use NetworkTeleport.teleport() for proper network-synced teleport
    - setPosition() only moves server-side coords; NetworkTeleport handles client sync

    v1.7.1 Changes:
    - Item catalog now excludes vehicle entries (vehicles served separately)
    - Removed debug logging from catalog handler registration

    v1.7.0 Changes:
    - Added getAllSandboxOptions handler: enumerates ALL sandbox options (vanilla + mod-registered)
      with metadata (type, min/max, default, enum values), grouped by mod/table name

    v1.6.0 Changes:
    - Added vehicleSetFuel and vehicleSetBattery handlers for remote vehicle management
    - Added safehouse player list to getSafehouses response
    - Added getTimeSpeed / setTimeSpeed handlers for time multiplier control
    - Added triggerHelicopterEvent handler
    - Fixed processedIds cleanup: sliding window (drop oldest half) instead of full clear
    - Removed dead sendServerMessage handler (superseded by sendToServerChat)
    - Removed addLamppost/removeLamppost from backend whitelist (no Lua implementation)

    v1.5.0 Changes:
    - Fixed teleportPlayer for B42: use NetworkTeleport.teleport() for proper network sync
    - Added B41 fallback chain: setPosition → setX/Y/Z + setNetworkTeleportEnabled
    - Added airdrop system handler

    v1.4.3 Changes:
    - CRITICAL: Fixed JSON object parser infinite loop on malformed input (while true → bounded)
    - Added pcall protection to getWeather handler for cross-version safety
    - Added pcall protection to getServerInfo GameTime access
    - Added per-field pcall to setGameTime to prevent partial failure cascades
    - Added pcall to teleportPlayer for proper error reporting
    - Added safe individual access to getSandboxOptions for B42 compatibility
    - Clamped giveItem count to 1-100 per call to prevent server freeze
    - Fixed indentation in shutOffUtilities Step 8

    v1.4.2 Changes:
    - Fixed race condition in command processing (infinite command loops)
    - Improved type declaration safety for all Climate handlers (numeric parsing)
    - Fixed ambiguous inputs in generic climate float handler
    - Cleanup of unused reference code

    v1.4.1 Changes:
    - Increased status update frequency from 5s to 3s for faster panel detection

    v1.4.0 Changes:
    - Added comprehensive debug logging system with toggleable debug mode
    - Added API version detection (B41 vs B42)
    - Added method availability checking before calling API methods
    - Added detailed error context in all handlers
    - Added getDebugLog handler to retrieve recent log entries
    - Added setDebugMode handler to enable/disable verbose logging
    - Added checkAPI handler to test API method availability
    - Added getAvailableHandlers to list all supported commands
    - Improved error messages with stack traces when available
    - Added performance timing to command execution
    - Added command statistics tracking

    v1.3.1 Changes:
    - Fixed B42 compatibility for getPlayerTraits (traits now accessed via SurvivorDesc)
    - Improved trait extraction to handle both B41 and B42 API differences

    v1.3.0 Changes:
    - Added comprehensive player export/import system
    - exportPlayerData: Full character data including inventory, perks, traits, recipes
    - importPlayerData: Restore perks, stats, and recipes (inventory/traits require manual restore)
    - Added chat system handlers via ChatServer API
    - sendToServerChat: Server messages to all players (with alert option)
    - sendToAdminChat: Messages visible only to admins
    - sendToGeneralChat: General chat with custom author name
    - getChatInfo: Query available chat types and server status

    v1.2.0 Changes:
    - Added sound/noise control for zombie attraction
    - playWorldSound: Create sound at coordinates
    - playSoundNearPlayer: Create sound at player location
    - triggerGunshot: High-radius gunshot sound
    - triggerAlarmSound: Medium-radius alarm sound
    - createNoise: Customizable noise creation

    v1.1.0 Changes:
    - Added comprehensive climate controls (wind, temp, fog, clouds, precipitation)
    - Added rain/lightning control
    - Added ClimateFloat admin control system
    - Added time/date control
    - Added sandbox options querying
    - Added enhanced player info
    - Fixed snow to auto-enable rain
]]

-- Forward declaration (referenced in log() before definition below)
local json

local PanelBridge = {
    VERSION = "1.7.54",
    PROTOCOL_VERSION = "queue-v1",
    CHECK_INTERVAL = 250, -- milliseconds (fast command polling)
    lastCheck = 0,
    lastStatusUpdate = 0,
    STATUS_INTERVAL = 3000, -- status update every 3 seconds (faster for detection)
    processedIds = {},
    processedIdOrder = {}, -- insertion-order list of ids, parallel to processedIds (see L10 fix)
    processedIdCount = 0,
    basePath = nil,
    initialized = false,

    -- Debug/Logging system
    -- Default OFF: polled commands (getServerInfo every 3s, getVehiclesDetailed/getSafehouses
    -- every 15s) would otherwise produce thousands of console.txt lines per hour. Use the
    -- setDebugMode bridge command (or the Debug page) to enable verbose logging when needed.
    DEBUG_MODE = false,
    debugLog = {},      -- Recent debug entries (ring buffer)
    MAX_DEBUG_ENTRIES = 200,
    MAX_PENDING_RESULTS = 500,
    MAX_COMMANDS_PER_TICK = 200,
    QUEUE_SEQUENCE_WIDTH = 10,

    -- The panel only writes the legacy commands.json when a numbered queue
    -- write fails (see panelBridge.js), so polling it every tick costs far
    -- more than the rare fallback is worth.
    LEGACY_COMMANDS_INTERVAL = 2000,
    lastLegacyCheck = 0,

    -- Set when queueState changes; flushed to disk once per tick.
    queueStateDirty = false,

    -- API detection
    detectedVersion = nil,
    apiCapabilities = {},

    -- Cached results of Java method probes, keyed by class name + method.
    methodCapabilities = {},

    -- Consecutive failures per class+method, reset by any success.
    methodFailures = {},

    -- Statistics
    stats = {
        commandsProcessed = 0,
        commandsSucceeded = 0,
        commandsFailed = 0,
        errors = {},
        lastError = nil,
        startTime = nil
    },

    -- Pending results buffer (avoids read-modify-write race on results.json)
    pendingResults = {},

    -- Queue state persisted to disk for crash-safe resume
    queueState = {
        lastCommandSeq = 0,
        nextResultSeq = 1,
    },

    -- Tracks how long the inbox reader has been stalled waiting on a single
    -- missing sequence number, so a genuine counter desync (see v1.7.12) can
    -- be detected and resynced instead of stalling forever.
    inboxStuckState = {
        seq = nil,
        since = 0,
        nextCheckAt = 0,
    },
}

-- ============================================
-- DEBUG/LOGGING SYSTEM
-- ============================================

-- Log levels
local LOG_LEVEL = {
    DEBUG = 1,
    INFO = 2,
    WARN = 3,
    ERROR = 4
}

local LOG_LEVEL_NAME = {}
for name, val in pairs(LOG_LEVEL) do LOG_LEVEL_NAME[val] = name end

-- Lua 5.1/5.2 compatibility
local unpack = unpack or table.unpack

-- Internal logging function
function PanelBridge.log(level, message, context)
    local timestamp = nil
    if getTimestampMs then
        timestamp = getTimestampMs()
    elseif os and os.time then
        timestamp = os.time() * 1000
    else
        timestamp = 0
    end
    local levelName = LOG_LEVEL_NAME[level] or "INFO"

    local entry = {
        timestamp = timestamp,
        level = levelName,
        message = tostring(message),
        context = context
    }

    -- Ring buffer. getDebugLog reads this as an ordered array, so trim in
    -- batches from the front rather than shifting all entries on every call.
    table.insert(PanelBridge.debugLog, entry)
    if #PanelBridge.debugLog > PanelBridge.MAX_DEBUG_ENTRIES then
        local drop = math.floor(PanelBridge.MAX_DEBUG_ENTRIES / 4)
        if drop < 1 then drop = 1 end
        local kept = {}
        for i = drop + 1, #PanelBridge.debugLog do
            kept[#kept + 1] = PanelBridge.debugLog[i]
        end
        PanelBridge.debugLog = kept
    end

    -- Print to console
    local prefix = "[PanelBridge][" .. levelName .. "] "
    if level >= LOG_LEVEL.WARN or PanelBridge.DEBUG_MODE then
        print(prefix .. message)
        if context and PanelBridge.DEBUG_MODE and json and json.encode then
            print(prefix .. "  Context: " .. json.encode(context))
        end
    end

    -- Track errors
    if level == LOG_LEVEL.ERROR then
        PanelBridge.stats.lastError = entry
        table.insert(PanelBridge.stats.errors, entry)
        -- Keep only last 20 errors
        while #PanelBridge.stats.errors > 20 do
            table.remove(PanelBridge.stats.errors, 1)
        end
    end
end

function PanelBridge.debug(message, context)
    PanelBridge.log(LOG_LEVEL.DEBUG, message, context)
end

function PanelBridge.info(message, context)
    PanelBridge.log(LOG_LEVEL.INFO, message, context)
end

function PanelBridge.warn(message, context)
    PanelBridge.log(LOG_LEVEL.WARN, message, context)
end

function PanelBridge.error(message, context)
    PanelBridge.log(LOG_LEVEL.ERROR, message, context)
end

-- ============================================
-- API DETECTION & SAFE CALLING
-- ============================================

-- PZ's Java objects do not reliably expose their methods as readable Lua
-- fields: a method can be callable via obj:method() while obj.method reads
-- nil. Testing the field therefore produces false negatives that silently
-- discard real data (v1.7.17 collections, v1.7.21/v1.7.23 vehicles) or
-- substitute fabricated defaults. The only reliable test is to call it.
--
-- Calling a genuinely missing method makes the engine print a stack trace
-- even inside pcall, so the outcome is cached per class+method and the call
-- is never retried. A method that exists but throws (a broken modded
-- vehicle's getter) is NOT marked unavailable, so one bad object cannot
-- disable a working accessor server-wide.
local function capabilityKey(obj, methodName)
    -- Kahlua exposes some B42 Java wrappers as userdata rather than Lua
    -- tables. Indexing one with `obj:getClass()` raises "attempted index ...
    -- of non-table" before pcall can turn it into a quiet result (notably
    -- zombie.vehicles.VehicleParts). Only Lua tables may take this probe;
    -- userdata uses the default-toString fallback below.
    if type(obj) == "table" then
        local ok, classValue = pcall(function() return obj:getClass() end)
        if ok and classValue then
            -- Build 42.20 class wrappers stringify correctly but reject getName().
            return tostring(classValue) .. "#" .. methodName
        end
    end
    -- Some Java wrappers reject getClass(). Strip the identity hash so the key
    -- still identifies the class rather than the individual instance. This
    -- ONLY works for Java's default toString ("ClassName@hex") -- an object
    -- with an OVERRIDDEN toString (Stats, InventoryItem, ItemContainer, and
    -- the IsoMovingObject family -- IsoPlayer and BaseVehicle both inherit
    -- it -- confirmed real cases via jar audit, 2026-08-30) has no @hex to
    -- strip, so gsub would be a no-op and the "key" would become
    -- VALUE-derived instead of class-derived (e.g. a username, an item
    -- name). Two objects that happen to share a toString would then share a
    -- cache key: if the first fails MAX_METHOD_FAILURES times the key gets
    -- marked unavailable, and every OTHER object sharing it is then refused
    -- with "Method not available on this build" even though the method
    -- genuinely works on it -- a false negative that disables a working
    -- accessor. gsub's own second return (the substitution count) is the
    -- cheap, exact way to tell the two cases apart, so only actually cache
    -- when there was a real @hex to strip. Returning nil here is NOT a new
    -- path -- PanelBridge.invoke already guards every cache read/write with
    -- `if key`, so nil already means "do not cache," just now also for this
    -- case. DO NOT strip this: those 4+ receiver types simply don't get
    -- availability caching on this fallback path (a repeated pcall is
    -- cheap); a cached false negative on IsoPlayer is not.
    local textOk, text = pcall(tostring, obj)
    if textOk and text then
        local stripped, hashCount = text:gsub("@%x+", "")
        if hashCount > 0 then
            return stripped .. "#" .. methodName
        end
    end
    return nil
end

local function isMissingMethodError(err)
    local text = tostring(err or ""):lower()
    return text:find("call nil", 1, true) ~= nil
        or text:find("attempt to call", 1, true) ~= nil
        or text:find("not a function", 1, true) ~= nil
end

-- Build 42 raises a bare java.lang.RuntimeException with an empty message for a
-- missing method, which no error-text test can recognise. Stop calling a method
-- that has never once succeeded after this many consecutive failures.
local MAX_METHOD_FAILURES = 3

-- Returns: success, result (or error message on failure)
function PanelBridge.invoke(obj, methodName, ...)
    if obj == nil then
        return false, "Object is nil"
    end

    local key = capabilityKey(obj, methodName)
    if key and PanelBridge.methodCapabilities[key] == false then
        return false, "Method '" .. methodName .. "' not available on this build"
    end

    local args = { ... }
    local success, result = pcall(function()
        return obj[methodName](obj, unpack(args))
    end)

    if success then
        if key then
            PanelBridge.methodCapabilities[key] = true
            PanelBridge.methodFailures[key] = nil
        end
        return true, result
    end

    -- Never disable a method that has already worked: a single broken modded
    -- object must not turn off a genuine accessor for every other object.
    if key and PanelBridge.methodCapabilities[key] ~= true then
        local failures = (PanelBridge.methodFailures[key] or 0) + 1
        PanelBridge.methodFailures[key] = failures
        if isMissingMethodError(result) or failures >= MAX_METHOD_FAILURES then
            PanelBridge.methodCapabilities[key] = false
            PanelBridge.debug("Method unavailable on this build; will not retry", {
                method = methodName,
                class = key,
                failures = failures
            })
            return false, result
        end
    end

    PanelBridge.debug("invoke failed", { method = methodName, error = tostring(result) })
    return false, result
end

-- Advisory only: a false result does NOT prove the method is missing (see
-- PanelBridge.invoke). Never gate an action on this; use invoke instead.
function PanelBridge.hasMethod(obj, methodName)
    if not obj then return false end
    -- This is an advisory diagnostic only: never invoke an arbitrary method
    -- just to answer whether it exists. Java userdata cannot be indexed as a
    -- Lua table, so only inspect fields on actual Lua tables and otherwise
    -- rely on a capability result cached by a real invoke() caller.
    if type(obj) == "table" then
        local ok, method = pcall(function() return obj[methodName] end)
        if ok and type(method) == "function" then return true end
    end
    local key = capabilityKey(obj, methodName)
    if key and PanelBridge.methodCapabilities[key] == false then return false end
    return key ~= nil and PanelBridge.methodCapabilities[key] == true
end

-- Safely call a method that might not exist
-- Returns: success, result/error
function PanelBridge.safeCall(obj, methodName, ...)
    return PanelBridge.invoke(obj, methodName, ...)
end

-- B42 gates several single-argument cheat setters (setNoClip, setGodMod,
-- setInvisible) behind the TARGET character's own Role capability
-- (ToggleNoclipHimself / ToggleGodModHimself / ToggleInvisibleHimself) --
-- confirmed by reading the shipped jar's bytecode (2026-08-30, GitHub issue
-- #129: player:setNoClip(enabled) completes with no error, but the immediate
-- isNoClip() read-back is still false). A normal player's default Role does
-- not carry those "toggle on myself" capabilities -- they exist for admins
-- toggling their own debug cheats via a debug menu, not for an admin tool
-- acting on an arbitrary target player -- so the 1-arg setter silently
-- forces the value to false and the call reports success while doing
-- nothing. Each of the three has a 2-arg overload (value, true) whose second
-- argument skips that capability check entirely; its write is byte-for-byte
-- the same getCheats():set(CheatType, value) call the 1-arg setter makes
-- when the capability check passes -- no separate replication/network path,
-- confirmed from the same bytecode. Try the 2-arg bypass first (uncached --
-- a build lacking the overload just throws, which pcall catches cheaply) and
-- fall back to the 1-arg form only for a build that lacks the overload
-- entirely. setInvincible has the same capability gate (ToggleInvincibleHimself)
-- but no 2-arg overload exists for it on this build -- no bypass is possible
-- through this method.
function PanelBridge.setCharacterCheatBypassingRoleGate(player, methodName, enabled)
    if not player then
        return false, methodName .. " method not available in this PZ version"
    end
    local bypassOk, bypassErr = PanelBridge.invoke(player, methodName, enabled, true)
    if bypassOk then
        return true
    end
    local ok, err = PanelBridge.invoke(player, methodName, enabled)
    if ok then
        return true
    end
    return false, err or bypassErr
end

-- Safely get a value from a method, with default fallback
function PanelBridge.safeGet(obj, methodName, default)
    local success, result = PanelBridge.invoke(obj, methodName)
    if success and result ~= nil then
        return result
    end
    return default
end

-- Calls a method and returns its value, or nil if unavailable. Use this in
-- place of `obj.method and obj:method()`, which is unreliable on Java objects.
function PanelBridge.tryGet(obj, methodName, ...)
    local success, result = PanelBridge.invoke(obj, methodName, ...)
    if success then return result end
    return nil
end

-- zombie.characters.Stats has no getHunger/getThirst/getFatigue/etc -- it
-- works through ONE generic enum-parameterized getter, stats:get(CharacterStat.X),
-- confirmed against the real jar (get(Lzombie/characters/CharacterStat;)F)
-- and against real vanilla SERVER-side Lua that already calls it this exact
-- way (media/lua/server/ClientCommands.lua, XpSystem/XpUpdate.lua,
-- Farming/SFarmingSystem.lua -- none of them import/require CharacterStat,
-- it is a bare global in PZ's shared Lua environment the same way getWorld()
-- or Events is, reachable from any server-side file including this one).
-- 2026-08-30, Kevin's jar audit + follow-up. Defined here (rather than next
-- to its first caller) so it is in scope for every handler in the file,
-- including ones defined earlier in the chunk like getServerInfo.
--
-- Guards the ENUM FIELD LOOKUP itself in its own pcall, not just the method
-- call after it -- CharacterStat[enumName] is a plain Lua table index, not
-- something PanelBridge.invoke's pcall would catch if CharacterStat or one
-- of its fields were ever absent on some future build. Returns nil (never a
-- plausible-looking 0) on any failure at either step.
local function statGet(stats, enumName)
    if not stats then return nil end
    local ok, enumValue = pcall(function() return CharacterStat[enumName] end)
    if not ok or enumValue == nil then return nil end
    return PanelBridge.tryGet(stats, "get", enumValue)
end

-- Standardizes the FINAL (ok, data, err) shape for any handler that has
-- already computed a `verified` tri-state by comparing a real read-back
-- against what it just tried to do. This is the house convention as of the
-- 2026-08-23 handler-verification audit -- it does not decide HOW to
-- compare (that's inherently handler-specific: exact match, a numeric
-- tolerance, membership in a list, etc.), only what to DO with the answer.
--
-- The `verified` FIELD IN THE RESPONSE IS A STRING, ALWAYS PRESENT WHEN
-- ok=true -- never a boolean, never omitted. This is a deliberate ruling,
-- not a style choice: the bridge mod lives on the user's Project Zomboid
-- server and can be OLDER than the panel (an operator updates the panel and
-- forgets the mod, or runs a panel against a server someone else
-- administers). With an omitted-key-means-unverified convention, an OLD
-- bridge that never heard of this contract and a NEW bridge honestly saying
-- "I can't confirm this" would both arrive at the client as a missing key,
-- and the UI could not tell "unconfirmable operation" from "this bridge
-- predates the contract" -- two situations that deserve different words to
-- the operator. With the key always present, a MISSING key means exactly
-- one thing: an old bridge. See also: an absent value carrying two
-- different meanings is the exact shape of a separate, real bug this floor
-- hit the same night (empty stdout meaning both "scan failed" and "nothing
-- running", indistinguishable, that cost an operator a working button) --
-- this rule exists so `verified` does not become a second instance of it.
--
--   verified (the ARGUMENT to this function) == true  -> the write is
--       confirmed to have taken effect. Response gets verified="confirmed".
--   verified == false -> a real read-back disagrees with what was
--       requested. This handler must NOT report ok=true -- a false success
--       is silent and nobody ever learns otherwise; a false failure here is
--       loud and self-correcting (the operator just retries). Returns
--       ok=false with failMessage; there is no "succeeded but verified is
--       false" state for a client to special-case.
--   verified == nil -> no read-back was possible (the underlying game API
--       is void, or the requested change was too small to distinguish from
--       a no-op). This is NOT a failure -- the call was made, the result
--       cannot be confirmed. Response gets verified="unverifiable". Must
--       not be conflated with verified == false (see the a-and-b-or-c idiom
--       bug this file used to have: collapsing "confirmed wrong" and
--       "can't tell" into one value is exactly the bug that made an earlier
--       fix's gate unreachable).
--
-- `data` is the handler's own response table; this only adds/overwrites its
-- `verified` field. `failMessage` is used only when verified == false.
function PanelBridge.verifiedResult(verified, data, failMessage)
    if verified == false then
        return false, nil, failMessage or "Operation succeeded but did not take effect"
    end
    data = data or {}
    if verified == true then
        data.verified = "confirmed"
    else
        data.verified = "unverifiable"
    end
    return true, data
end

-- Detect PZ version and available APIs
function PanelBridge.detectVersion()
    local version = {
        build = "unknown",
        isB42 = false,
        isB41 = false,
        features = {}
    }

    -- 2026-08-30 (total-audit, god's own foundation lens): this used to
    -- gate four flags on PanelBridge.hasMethod, whose own doc comment says
    -- "Never gate an action on this; use invoke instead." BOTH of its
    -- branches were dead here: the field-test branch is unreliable for a
    -- Java-bound method on these receivers (this file's own recurring
    -- lesson -- e.g. world.saveWorld), and its capability-cache fallback is
    -- EMPTY BY CONSTRUCTION at this point, since detectVersion runs before
    -- any handler has ever called PanelBridge.invoke. So all four flags
    -- were permanently false/unset, reported as if a real check had run.
    --
    -- transmitTriggerBlizzard/transmitTriggerTropical are NOT safe to probe
    -- by actually calling them (PanelBridge.invoke) -- both genuinely
    -- trigger a real weather event on the live server (see
    -- handlers.generateWeather, which calls them for real). There is no
    -- side-effect-free way to confirm they exist without either inventing
    -- an unverified mechanism or triggering weather just to check, so
    -- features.blizzard/tropical are left OUT of the response entirely
    -- (nil omits the key) rather than reported as a false "false". Once a
    -- real weather-trigger command has run at least once, PanelBridge.
    -- methodCapabilities already has the true answer for anyone who wants
    -- to read it directly.
    --
    -- desc:getTraitList (the old isB42 probe) was independently confirmed
    -- ABSENT from B42's real class hierarchy by a full jar audit elsewhere
    -- in this file (see getPlayerTraits' own comment, 2026-08-23) -- it
    -- could never have indicated B42 even with a working detector, so it's
    -- removed rather than "fixed". The version-string fallback below
    -- already determines isB42/isB41 reliably from getCore():getVersion().
    --
    -- testPlayer:getTraits, by contrast, IS confirmed real B41 API (same
    -- comment) and is a plain read-only getter with no side effects, so
    -- it's safe to confirm with a real PanelBridge.invoke() call instead of
    -- the broken hasMethod probe.
    local onlinePlayers = getOnlinePlayers and getOnlinePlayers()
    local testPlayer = onlinePlayers and onlinePlayers:size() > 0 and onlinePlayers:get(0) or nil
    if testPlayer then
        if PanelBridge.invoke(testPlayer, "getTraits") then
            version.isB41 = true
        end
    end

    -- Try to get build version
    pcall(function()
        if getCore and getCore() and getCore().getVersion then
            version.build = getCore():getVersion()
        end
    end)

    -- Fallback: parse build string if player-based detection couldn't run
    if not version.isB42 and not version.isB41 and version.build ~= "unknown" then
        local major = version.build:match("^(%d+)%.")
        if major then
            local majorNum = tonumber(major)
            if majorNum and majorNum >= 42 then
                version.isB42 = true
            elseif majorNum and majorNum == 41 then
                version.isB41 = true
            end
        end
    end

    PanelBridge.detectedVersion = version
    PanelBridge.info("Detected PZ version", version)

    return version
end

-- ============================================
-- JSON LIBRARY (embedded for reliability)
-- ============================================
json = {}

-- Sentinel for JSON `null` encountered inside an ARRAY (see the array branch
-- of json.decode's parse_value below). A plain Lua `nil` can't be stored at
-- a specific array index without leaving an ambiguous hole (Lua's `#`/ipairs
-- semantics over tables with nil holes are undefined), which used to make
-- `[1, null, 2]` silently decode as `{1, 2}` — dropping the null AND
-- shifting index 2's value down to index 2 from its real index 3. This is a
-- unique, otherwise-inert table so `value == json.null` is a reliable
-- identity check; json.encode() turns it back into `null` on the way out.
-- Object keys with a null value are NOT affected — they still decode to an
-- absent key, which is the existing/intended behavior for that case.
json.null = setmetatable({}, { __tostring = function() return "null" end })

local function kind_of(obj)
    if type(obj) ~= 'table' then return type(obj) end
    -- Exit on the first non-numeric key instead of probing obj[i] on every
    -- iteration; object-shaped tables then cost one lookup rather than N.
    local count = 0
    for k in pairs(obj) do
        if type(k) ~= 'number' then return 'table' end
        count = count + 1
    end
    for i = 1, count do
        if obj[i] == nil then return 'table' end
    end
    -- Empty Lua tables are ambiguous (array vs object). The panel's JS
    -- consumers overwhelmingly expect collection fields like
    -- safehouses/factions/vehicles/players/options to be arrays, and an
    -- empty object ({}) crashes any downstream `.map`/`.filter`/`.length`
    -- call. Default empty -> array ([]) so an empty server still produces
    -- a JSON-safe response. Object-typed empty values are exceedingly rare
    -- in our handlers (they always carry at least one keyed field like
    -- `message` or `count`).
    return 'array'
end

local function escape_str(s)
    local in_char = {'\\', '"', '\b', '\f', '\n', '\r', '\t'}
    local out_char = {'\\', '"', 'b', 'f', 'n', 'r', 't'}
    for i, c in ipairs(in_char) do
        s = s:gsub(c, '\\' .. out_char[i])
    end
    -- Escape remaining control characters (0x00-0x1F) to produce valid JSON
    s = s:gsub('[%z\1-\31]', function(c)
        return string.format('\\u%04x', string.byte(c))
    end)
    return s
end

-- Guards against a cyclic or pathologically deep table taking down the tick
-- with a stack overflow. Handler payloads are far shallower than this.
local JSON_MAX_DEPTH = 64

function json.encode(obj, depth)
    depth = depth or 0
    if depth > JSON_MAX_DEPTH then
        return 'null'
    end
    if obj == json.null then
        return 'null'
    end
    local t = type(obj)
    if t == 'nil' then
        return 'null'
    elseif t == 'boolean' then
        return obj and 'true' or 'false'
    elseif t == 'number' then
        -- Handle NaN and Infinity which are not valid JSON
        if obj ~= obj then return 'null' end -- NaN check
        if obj == math.huge or obj == -math.huge then return 'null' end
        return tostring(obj)
    elseif t == 'string' then
        return '"' .. escape_str(obj) .. '"'
    elseif t == 'table' then
        local k = kind_of(obj)
        if k == 'array' then
            local parts = {}
            for i, v in ipairs(obj) do
                parts[i] = json.encode(v, depth + 1)
            end
            return '[' .. table.concat(parts, ',') .. ']'
        else
            local parts = {}
            for key, val in pairs(obj) do
                parts[#parts + 1] = json.encode(tostring(key), depth + 1) .. ':' .. json.encode(val, depth + 1)
            end
            return '{' .. table.concat(parts, ',') .. '}'
        end
    end
    return 'null'
end

-- Encodes a single Unicode codepoint (0-0xFFFF) as UTF-8 bytes. Lua strings
-- here are plain byte arrays, so a decoded \uXXXX escape must be turned into
-- the actual UTF-8 byte sequence by hand -- there is no utf8 stdlib in this
-- Lua environment (Kahlua/5.1-shaped) to do it for us. Astral characters
-- (codepoint > 0xFFFF) arrive as a UTF-16 surrogate PAIR of two \uXXXX
-- escapes in real JSON; this does not combine pairs (each half would encode
-- as its own, technically-invalid lone-surrogate 3-byte sequence) -- verified
-- 2026-08-31 that Node's JSON.stringify (the only real producer of \uXXXX in
-- this protocol) only ever emits it for ASCII control characters below
-- 0x20 that lack a named escape, never for astral characters, so this gap is
-- inert in practice rather than silently guessed away.
local function utf8EncodeCodepoint(code)
    if code < 0x80 then
        return string.char(code)
    elseif code < 0x800 then
        return string.char(
            0xC0 + math.floor(code / 0x40),
            0x80 + (code % 0x40))
    else
        return string.char(
            0xE0 + math.floor(code / 0x1000),
            0x80 + (math.floor(code / 0x40) % 0x40),
            0x80 + (code % 0x40))
    end
end

function json.decode(str)
    if not str or str == "" then return nil end

    local pos = 1
    local function skip_whitespace()
        while pos <= #str and str:sub(pos, pos):match('%s') do
            pos = pos + 1
        end
    end

    local function parse_value()
        skip_whitespace()
        local c = str:sub(pos, pos)

        if c == '"' then
            -- String
            pos = pos + 1
            local start = pos
            local result = ""
            while pos <= #str do
                c = str:sub(pos, pos)
                if c == '\\' then
                    result = result .. str:sub(start, pos - 1)
                    pos = pos + 1
                    local escape = str:sub(pos, pos)
                    if escape == 'n' then result = result .. '\n'
                    elseif escape == 'r' then result = result .. '\r'
                    elseif escape == 't' then result = result .. '\t'
                    elseif escape == 'b' then result = result .. '\b'
                    elseif escape == 'f' then result = result .. '\f'
                    elseif escape == '"' then result = result .. '"'
                    elseif escape == '\\' then result = result .. '\\'
                    elseif escape == '/' then result = result .. '/'
                    elseif escape == 'u' then
                        -- \uXXXX: the ONLY escape form that isn't a single
                        -- literal character -- everything above it just
                        -- appends one byte. Before this fix, falling into
                        -- the `else` branch below appended the literal
                        -- character "u" and left the four hex digits to be
                        -- copied as plain string content on the next four
                        -- loop iterations, e.g. A decoded as the 5
                        -- characters "u0041" instead of the 1 character "A"
                        -- -- corrupting any control character (0x00-0x1F)
                        -- that reaches Lua this way, which is exactly what
                        -- this file's OWN encoder (escape_str, above)
                        -- produces for any string field containing one, and
                        -- what Node's JSON.stringify produces for the same
                        -- (verified 2026-08-31 against both directions).
                        local hex = str:sub(pos + 1, pos + 4)
                        local code = hex:match('^%x%x%x%x$') and tonumber(hex, 16)
                        if code then
                            result = result .. utf8EncodeCodepoint(code)
                            pos = pos + 4
                        else
                            -- Malformed \u (not 4 hex digits): fail safe,
                            -- same as the pre-fix behavior for every escape
                            -- this branch didn't recognize.
                            result = result .. escape
                        end
                    else result = result .. escape end
                    pos = pos + 1
                    start = pos
                elseif c == '"' then
                    result = result .. str:sub(start, pos - 1)
                    pos = pos + 1
                    return result
                else
                    pos = pos + 1
                end
            end
            return result
        elseif c == '{' then
            -- Object
            pos = pos + 1
            local obj = {}
            skip_whitespace()
            if str:sub(pos, pos) == '}' then
                pos = pos + 1
                return obj
            end
            while pos <= #str do
                skip_whitespace()
                if pos > #str then break end
                local key = parse_value()
                skip_whitespace()
                if str:sub(pos, pos) == ':' then pos = pos + 1 end
                local value = parse_value()
                -- Defensive: only assign if key is a string (JSON keys must be strings).
                -- A malformed JSON object with non-string keys would otherwise crash
                -- the polling loop, even inside the surrounding pcall.
                if type(key) == 'string' then
                    obj[key] = value
                end
                skip_whitespace()
                c = str:sub(pos, pos)
                if c == '}' then
                    pos = pos + 1
                    return obj
                elseif c == ',' then
                    pos = pos + 1
                end
            end
            return obj
        elseif c == '[' then
            -- Array
            pos = pos + 1
            local arr = {}
            local idx = 0
            skip_whitespace()
            if str:sub(pos, pos) == ']' then
                pos = pos + 1
                return arr
            end
            while pos <= #str do
                idx = idx + 1
                local value = parse_value()
                -- See json.null above: preserve the slot (and every later
                -- index) instead of silently dropping it.
                if value == nil then value = json.null end
                arr[idx] = value
                skip_whitespace()
                if pos > #str then break end
                c = str:sub(pos, pos)
                if c == ']' then
                    pos = pos + 1
                    return arr
                elseif c == ',' then
                    pos = pos + 1
                end
            end
            return arr
        elseif str:sub(pos, pos + 3) == 'true' then
            pos = pos + 4
            return true
        elseif str:sub(pos, pos + 4) == 'false' then
            pos = pos + 5
            return false
        elseif str:sub(pos, pos + 3) == 'null' then
            pos = pos + 4
            return nil
        else
            -- Number
            local start = pos
            while pos <= #str and str:sub(pos, pos):match('[%d%.%-eE%+]') do
                pos = pos + 1
            end
            return tonumber(str:sub(start, pos - 1))
        end
    end

    local success, result = pcall(parse_value)
    if success then
        return result
    else
        print("[PanelBridge] JSON parse error: " .. tostring(result))
        return nil
    end
end

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Helper to get player by username (works in B42)
-- The global getPlayerByUsername may not exist in all versions
local function getPlayerByUsername(username)
    if not username then return nil end

    local onlinePlayers = getOnlinePlayers()
    if not onlinePlayers then return nil end

    local lowerUser = string.lower(username)
    for i = 0, onlinePlayers:size() - 1 do
        local player = onlinePlayers:get(i)
        if player then
            local ok, pname = pcall(function() return player:getUsername() end)
            if ok and pname and string.lower(pname) == lowerUser then
                return player
            end
        end
    end

    return nil
end

-- ============================================
-- FILE OPERATIONS
-- ============================================

function PanelBridge.getBasePath()
    if PanelBridge.basePath then
        return PanelBridge.basePath
    end

    -- For dedicated servers, we write to the Lua folder itself
    -- Files will be created in: {ServerInstall}/Lua/panelbridge/{serverName}/
    -- This is within the allowed write path for getFileWriter
    local serverName = getServerName()
    local safeServerName = nil
    if serverName and serverName ~= "" then
        safeServerName = tostring(serverName)
        safeServerName = safeServerName:gsub("[/\\:%*%?\"<>|]", "_")
        safeServerName = safeServerName:gsub("%s+", "_")
        if safeServerName == "" then safeServerName = nil end
    end

    if safeServerName then
        -- Simple path within allowed Lua folder
        PanelBridge.basePath = "panelbridge/" .. safeServerName .. "/"
    else
        -- Fallback
        PanelBridge.basePath = "panelbridge/"
    end

    print("[PanelBridge] Using path: " .. PanelBridge.basePath)
    return PanelBridge.basePath
end

-- Build 42 buildid 24449161 restricts getFileWriter to a small extension
-- whitelist: .txt is accepted, while .json, .init and extension-less names are
-- rejected outright (getFileWriter returns nil). Nested paths are still fine.
-- Every Lua-written bridge file therefore keeps its usual path with a .txt
-- suffix appended, e.g. panelbridge/DoomerZ/status.json.txt. The panel resolves
-- both the suffixed name and the legacy one.
PanelBridge.WRITE_SUFFIX = ".txt"

function PanelBridge.getWritePath(filename)
    return PanelBridge.getBasePath() .. filename .. PanelBridge.WRITE_SUFFIX
end

-- commands.json, inbox/cmd-*.json and .queue-state-node.json are written by
-- the panel, which is not subject to the Build 42 restriction and uses the
-- plain names.
function PanelBridge.isPanelOwnedFile(filename)
    return filename == "commands.json" or filename == ".queue-state-node.json"
        or filename:match("^inbox/cmd%-") ~= nil
end

-- Returns true when getFileWriter accepts the given path.
function PanelBridge.canWritePath(path)
    local ok, writer = pcall(function() return getFileWriter(path, true, false) end)
    if not ok or not writer then
        return false
    end
    local wrote = pcall(function()
        writer:write("PanelBridge probe")
        writer:close()
    end)
    return wrote and true or false
end

function PanelBridge.ensureDirectory()
    -- Build 42 no longer lets Lua create directories, so the panel owns the
    -- bridge folder. What matters here is that the write root is usable.
    local initPath = PanelBridge.getWritePath(".init")
    local writer = getFileWriter(initPath, true, false)
    if writer then
        local stamp = "unknown"
        if os and os.date then
            local ok, val = pcall(function() return os.date() end)
            if ok and val then stamp = tostring(val) end
        elseif getTimestampMs then
            stamp = tostring(getTimestampMs())
        end
        writer:write("PanelBridge initialized at " .. stamp)
        writer:close()
        return true
    end

    print("[PanelBridge] ERROR: could not write " .. initPath .. " in the Lua folder")
    -- The marker is only a convenience; keep running as long as writes work
    -- in general. Probe a dedicated throwaway name — NOT a real bridge file
    -- like status.json — since canWritePath actually writes its probe text,
    -- and doing that on a production file would briefly clobber real state
    -- with garbage for any reader unlucky enough to catch it mid-window.
    return PanelBridge.canWritePath(PanelBridge.getWritePath(".write-check"))
end

function PanelBridge.readPath(path)
    local reader = getFileReader(path, false)
    if not reader then
        return nil
    end

    local lines = {}
    local readOk, readErr = pcall(function()
        local line = reader:readLine()
        while line do
            lines[#lines + 1] = line
            line = reader:readLine()
        end
    end)
    reader:close()
    if not readOk then return nil end

    local content = table.concat(lines, "\n")
    return (content:gsub("^%s*(.-)%s*$", "%1")) -- trim
end

function PanelBridge.readFile(filename)
    local nestedPath = PanelBridge.getBasePath() .. filename
    if PanelBridge.isPanelOwnedFile(filename) then
        return PanelBridge.readPath(nestedPath)
    end

    -- Prefer the .txt-suffixed file this build writes, then fall back to the
    -- unsuffixed file left behind by a pre-Build-42-24449161 session.
    local content = PanelBridge.readPath(nestedPath .. PanelBridge.WRITE_SUFFIX)
    if content ~= nil then
        return content
    end
    return PanelBridge.readPath(nestedPath)
end

function PanelBridge.writeFile(filename, content)
    -- Mirror readFile's path resolution: panel-owned files (commands.json,
    -- inbox/cmd-*) live at their plain path — the panel writes/reads them
    -- directly and isn't subject to the Build 42 .txt restriction. Nothing
    -- currently calls writeFile with those names (clearFile short-circuits
    -- before reaching here), but resolving the wrong path silently here
    -- would be an easy trap for future callers.
    local path
    if PanelBridge.isPanelOwnedFile(filename) then
        path = PanelBridge.getBasePath() .. filename
    else
        path = PanelBridge.getWritePath(filename)
    end
    local writer = getFileWriter(path, true, false)
    if not writer then
        print("[PanelBridge] Error: Could not write to " .. path)
        return false
    end
    local writeOk, writeErr = pcall(function()
        writer:write(content)
    end)
    writer:close()
    if not writeOk then
        print("[PanelBridge] Error writing: " .. tostring(writeErr))
        return false
    end
    return true
end

function PanelBridge.readJSON(filename)
    local content = PanelBridge.readFile(filename)
    if not content or content == "" then
        return nil
    end
    -- pcall-protect json.decode so a malformed/torn file can't throw here --
    -- same precedent as processQueuedCommands' inline decode below, applied
    -- to every readJSON caller instead of just the one that already had it.
    -- All four current callers (readQueueState, tryResyncInboxCursor, the
    -- legacy commands.json intake x2) already treat a nil return as "no
    -- data yet" and fall back to their own defaults, so returning nil here
    -- on a decode failure is "absent", not "empty" -- it re-derives state
    -- from scratch rather than proceeding as if the file said nothing.
    local decodeOk, decoded = pcall(json.decode, content)
    if not decodeOk then
        PanelBridge.warn("Failed to decode JSON file, treating as absent", {
            file = filename,
            parseError = tostring(decoded)
        })
        return nil
    end
    return decoded
end

function PanelBridge.writeJSON(filename, data)
    local content = json.encode(data)
    return PanelBridge.writeFile(filename, content)
end

function PanelBridge.clearFile(filename)
    if PanelBridge.isPanelOwnedFile(filename) then
        -- Build 42 forbids writing into the nested bridge folder, and the panel
        -- prunes its own inbox from its cursor file, so this is a no-op now.
        -- Writing a flat copy would only litter the Lua folder.
        return true
    end
    return PanelBridge.writeFile(filename, "")
end

function PanelBridge.formatSeq(seq)
    local n = tonumber(seq) or 0
    if n < 0 then n = 0 end
    return string.format("%0" .. tostring(PanelBridge.QUEUE_SEQUENCE_WIDTH) .. "d", math.floor(n))
end

function PanelBridge.readQueueState()
    local state = PanelBridge.readJSON("queue-state-lua.json")
    if type(state) == "table" then
        local lastCommandSeq = tonumber(state.lastCommandSeq)
        local nextResultSeq = tonumber(state.nextResultSeq)
        if lastCommandSeq and lastCommandSeq >= 0 then
            PanelBridge.queueState.lastCommandSeq = math.floor(lastCommandSeq)
        end
        if nextResultSeq and nextResultSeq >= 1 then
            PanelBridge.queueState.nextResultSeq = math.floor(nextResultSeq)
        end
    end
end

function PanelBridge.writeQueueState()
    local ok = PanelBridge.writeJSON("queue-state-lua.json", {
        protocolVersion = PanelBridge.PROTOCOL_VERSION,
        lastCommandSeq = PanelBridge.queueState.lastCommandSeq,
        nextResultSeq = PanelBridge.queueState.nextResultSeq,
        updatedAt = getTimestampMs()
    })
    if ok then PanelBridge.queueStateDirty = false end
    return ok
end

function PanelBridge.writeInboxCursor(lastSeq)
    return PanelBridge.writeJSON("inbox/cursor.json", {
        protocolVersion = PanelBridge.PROTOCOL_VERSION,
        lastProcessedSeq = tonumber(lastSeq) or 0,
        updatedAt = getTimestampMs()
    })
end

-- ============================================
-- RESULT HANDLING
-- ============================================

function PanelBridge.sendResult(id, success, data, errorMsg)
    if #PanelBridge.pendingResults >= PanelBridge.MAX_PENDING_RESULTS then
        local dropped = PanelBridge.pendingResults[1]
        table.remove(PanelBridge.pendingResults, 1)
        PanelBridge.warn("Pending result buffer full, dropping oldest result", {
            max = PanelBridge.MAX_PENDING_RESULTS,
            droppedSeq = dropped and dropped.seq or nil,
            droppedId = dropped and dropped.id or nil
        })
        -- Write a tombstone for the dropped seq so Node's sequential reader
        -- doesn't block forever waiting for a result file that will never exist.
        if dropped and dropped.seq then
            local outFile = "outbox/res-" .. PanelBridge.formatSeq(dropped.seq) .. ".json"
            PanelBridge.writeJSON(outFile, {
                protocolVersion = PanelBridge.PROTOCOL_VERSION,
                seq = dropped.seq,
                result = {
                    id = dropped.id,
                    success = false,
                    data = nil,
                    error = "Result dropped: pending buffer overflow",
                    timestamp = getTimestampMs(),
                }
            })
        end
    end

    -- Buffer results in memory; they're flushed to disk once per tick in flushResults()
    -- This avoids the read-modify-write race where the Node side reads results.json
    -- between our read and our write, or two sendResult calls in the same tick
    -- overwrite each other.
    table.insert(PanelBridge.pendingResults, {
        protocolVersion = PanelBridge.PROTOCOL_VERSION,
        seq = PanelBridge.queueState.nextResultSeq,
        id = id,
        success = success,
        data = data,
        error = errorMsg,
        timestamp = getTimestampMs()
    })
    PanelBridge.queueState.nextResultSeq = PanelBridge.queueState.nextResultSeq + 1
    -- Persisted once per tick by flushResults rather than once per result.
    PanelBridge.queueStateDirty = true
end

function PanelBridge.flushResults()
    if #PanelBridge.pendingResults == 0 then
        if PanelBridge.queueStateDirty then
            PanelBridge.writeQueueState()
        end
        return
    end

    -- NOTE (audit L04, retired): this used to also do a read-modify-write of
    -- a legacy results.json on every flush, for panels that hadn't
    -- negotiated protocolVersion=queue-v1. Panel and mod are always shipped
    -- and auto-updated together in this fork (see server/index.js's
    -- tryStartPanelBridge), so a panel old enough to need that fallback can
    -- never actually be paired with this mod version — the read-modify-write
    -- was dead weight (double the I/O of every flush) with zero real
    -- consumers. The numbered outbox/res-*.json.txt writes below are the
    -- only path now; onServerStarted() clears any stale results.json left
    -- behind by a pre-retirement mod version.
    local writtenCount = 0
    for idx, r in ipairs(PanelBridge.pendingResults) do
        local seq = tonumber(r.seq) or 0
        local outFile = "outbox/res-" .. PanelBridge.formatSeq(seq) .. ".json"
        local ok = PanelBridge.writeJSON(outFile, {
            protocolVersion = PanelBridge.PROTOCOL_VERSION,
            seq = seq,
            result = {
                id = r.id,
                success = r.success,
                data = r.data,
                error = r.error,
                timestamp = r.timestamp,
            }
        })
        if not ok then
            PanelBridge.warn("Queue result write failed; will retry", { file = outFile, seq = seq })
            break
        end
        writtenCount = idx
    end

    if writtenCount <= 0 then
        if PanelBridge.queueStateDirty then
            PanelBridge.writeQueueState()
        end
        return
    end

    local remaining = {}
    for i = writtenCount + 1, #PanelBridge.pendingResults do
        table.insert(remaining, PanelBridge.pendingResults[i])
    end
    PanelBridge.pendingResults = remaining

    -- Persist the sequence counter only after the result files it refers to
    -- are on disk, so a crash can never leave a reusable seq pointing at an
    -- unconsumed result.
    if PanelBridge.queueStateDirty then
        PanelBridge.writeQueueState()
    end
end

-- ============================================
-- COMMAND HANDLERS
-- ============================================

local handlers = {}

-- TTL cache for expensive/polled read-only handlers (audit findings L02/L06).
-- Catalogs of static script data (items/vehicles) only change when the
-- server restarts (new mods added), so they get a long TTL and are never
-- invalidated early; live game-state enumerations get a short TTL so a
-- panel view left open on the Vehicles/Safehouses/Players page doesn't
-- re-trigger a full synchronous game-thread scan on every single poll,
-- while still staying reasonably fresh -- AND are dropped after every
-- state-changing command, since an admin action can change what they'd
-- return. Keyed by action name; only successful results are cached (a
-- transient failure must not get "stuck" being replayed for the TTL
-- window).
--
-- `live` is a REQUIRED field on every entry, not an optional afterthought:
-- this used to be two separately hand-maintained tables (a flat
-- action->TTL map here, plus a separate LIVE_STATE_CACHE_KEYS array naming
-- only 3 of the 6 cacheable actions) with nothing enforcing that the two
-- agreed. THAT SPLIT WAS THE BUG: getAllSandboxOptions had a real 300000ms
-- TTL but was never in the live-invalidation list, so setSandboxOption
-- writing a real, successful change left the panel serving up to 5 minutes
-- of stale sandbox data -- the exact class this file's own comment history
-- already fixed once, by enumerating the three keys that had bitten
-- someone (repair/refuel/battery), and it survived here with a TTL sixty
-- times longer because a 4th (well, 6th) entry didn't automatically get
-- the same treatment. Folding `live` into this one table means a 7th
-- cacheable action cannot be added tomorrow without an explicit answer to
-- "can this go stale after an admin action?" -- there is no second list to
-- forget to update.
local CACHEABLE_ACTIONS = {
    getItemCatalog       = { ttl = 300000, live = false }, -- static item scripts, only change on restart
    getVehicleCatalog    = { ttl = 300000, live = false }, -- static vehicle scripts, only change on restart
    getAllSandboxOptions = { ttl = 300000, live = true },  -- FIX: setSandboxOption changes this -- was never invalidated before
    getVehiclesDetailed  = { ttl = 5000,   live = true },  -- live vehicle state (panel polls every 15s)
    getSafehouses        = { ttl = 5000,   live = true },  -- live safehouse state (panel polls every 15s)
    getAllPlayerDetails  = { ttl = 5000,   live = true },  -- live player stats (panel polls every 15s)
}
local readOnlyCache = {}

local function invalidateLiveStateCache()
    for action, config in pairs(CACHEABLE_ACTIONS) do
        if config.live then
            readOnlyCache[action] = nil
        end
    end
end

-- Marks a command id as processed, keeping processedIds (O(1) lookup) and
-- processedIdOrder (insertion order, for the trim in processCommands) in sync.
local function markProcessed(id)
    PanelBridge.processedIds[id] = true
    table.insert(PanelBridge.processedIdOrder, id)
    PanelBridge.processedIdCount = PanelBridge.processedIdCount + 1
end

local function processSingleCommand(cmd)
    if type(cmd) ~= "table" then
        PanelBridge.stats.commandsFailed = PanelBridge.stats.commandsFailed + 1
        PanelBridge.warn("Skipping malformed command entry", { entryType = type(cmd) })
        return false
    end

    if cmd.id == nil and cmd.commandId ~= nil then
        cmd.id = cmd.commandId
    end
    if cmd.args == nil and type(cmd.payload) == "table" then
        cmd.args = cmd.payload
    end

    if not cmd.id then
        PanelBridge.stats.commandsFailed = PanelBridge.stats.commandsFailed + 1
        PanelBridge.warn("Skipping command without id", { action = tostring(cmd.action) })
        return false
    end

    if PanelBridge.processedIds[cmd.id] then
        return false
    end

    -- Honor Node-side timeout: if the command's expiresAt has already passed,
    -- skip the side effect but still write a result so Node can clear bookkeeping.
    -- Without this, a command that ran late (Lua paused / GC pause / heavy tick)
    -- would still execute its action long after the HTTP caller saw a timeout.
    if type(cmd.expiresAt) == "number" and cmd.expiresAt > 0 then
        local nowMs = getTimestampMs()
        if nowMs > cmd.expiresAt then
            markProcessed(cmd.id)
            PanelBridge.stats.commandsFailed = PanelBridge.stats.commandsFailed + 1
            PanelBridge.warn("Skipping expired command", {
                action = tostring(cmd.action),
                id = cmd.id,
                ageMs = nowMs - cmd.expiresAt
            })
            PanelBridge.sendResult(cmd.id, false, nil, "Command expired before mod could process it")
            return false
        end
    end

    markProcessed(cmd.id)
    PanelBridge.stats.commandsProcessed = PanelBridge.stats.commandsProcessed + 1

    -- Frequent polling commands log at DEBUG to avoid spam
    -- These commands are polled by the panel on a fixed schedule (every few seconds) so we
    -- log them at DEBUG only. INFO is reserved for one-shot admin actions.
    local quietCommands = { getServerInfo=true, ping=true, getWeather=true, getGameTime=true, getWorldStats=true, getUtilitiesStatus=true, getClimateFloats=true, getAllPlayerDetails=true, getVehiclesDetailed=true, getSafehouses=true, getZombieCount=true, getSandboxOptions=true }
    if quietCommands[cmd.action] then
        PanelBridge.debug("Processing command: " .. tostring(cmd.action), { id = cmd.id })
    else
        PanelBridge.info("Processing command: " .. tostring(cmd.action), { id = cmd.id })
    end

    local handler = handlers[cmd.action]
    if handler then
        -- Serve from cache if this action is cacheable and the cached entry
        -- is still within its TTL — skips the expensive handler entirely.
        local cacheConfig = CACHEABLE_ACTIONS[cmd.action]
        local cacheTtl = cacheConfig and cacheConfig.ttl
        if cacheTtl then
            local cached = readOnlyCache[cmd.action]
            if cached and (getTimestampMs() - cached.at) < cacheTtl then
                PanelBridge.stats.commandsSucceeded = PanelBridge.stats.commandsSucceeded + 1
                PanelBridge.debug("Command served from cache: " .. tostring(cmd.action), { id = cmd.id })
                PanelBridge.sendResult(cmd.id, cached.ok, cached.data, cached.err)
                return true
            end
        end

        local handlerArgs = {}
        if type(cmd.args) == "table" then
            handlerArgs = cmd.args
        elseif cmd.args ~= nil then
            PanelBridge.warn("Command args must be a table; defaulting to empty args", {
                id = cmd.id,
                action = tostring(cmd.action),
                argsType = type(cmd.args)
            })
        end

        local startTime = getTimestampMs()
        local pcallOk, success, data, errorMsg = pcall(handler, handlerArgs, cmd.id)
        local duration = getTimestampMs() - startTime

        if not pcallOk then
            PanelBridge.stats.commandsFailed = PanelBridge.stats.commandsFailed + 1
            local crashMsg = "Handler crashed: " .. tostring(success)
            PanelBridge.error("Command crashed: " .. tostring(cmd.action), {
                error = crashMsg,
                duration = duration .. "ms"
            })
            PanelBridge.sendResult(cmd.id, false, nil, crashMsg)
        elseif success == "DEFERRED" then
            -- Handler started a background job (see L02) and will call
            -- PanelBridge.sendResult itself once the job completes across
            -- later ticks -- don't send (or count success/failure) yet.
            PanelBridge.debug("Command deferred to background job: " .. tostring(cmd.action), {
                id = cmd.id,
                duration = duration .. "ms"
            })
        elseif success then
            PanelBridge.stats.commandsSucceeded = PanelBridge.stats.commandsSucceeded + 1
            PanelBridge.debug("Command succeeded: " .. tostring(cmd.action), {
                duration = duration .. "ms"
            })
            if cacheTtl then
                readOnlyCache[cmd.action] = { at = getTimestampMs(), ok = success, data = data, err = errorMsg }
            else
                -- Any non-cacheable command that succeeded may have mutated
                -- world state the live caches describe.
                invalidateLiveStateCache()
            end
            PanelBridge.sendResult(cmd.id, success, data, errorMsg)
        elseif errorMsg == "useRCON" then
            -- Routing signal, not a failure: the backend delivers this over RCON instead.
            PanelBridge.debug("Command routed to RCON: " .. tostring(cmd.action), {
                duration = duration .. "ms"
            })
            PanelBridge.sendResult(cmd.id, success, data, errorMsg)
        else
            PanelBridge.stats.commandsFailed = PanelBridge.stats.commandsFailed + 1
            PanelBridge.warn("Command failed: " .. tostring(cmd.action), {
                error = errorMsg,
                duration = duration .. "ms"
            })
            PanelBridge.sendResult(cmd.id, success, data, errorMsg)
        end
    else
        PanelBridge.stats.commandsFailed = PanelBridge.stats.commandsFailed + 1
        local errorMsg = "Unknown command: " .. tostring(cmd.action)
        PanelBridge.warn(errorMsg)
        PanelBridge.sendResult(cmd.id, false, nil, errorMsg)
    end

    return true
end

-- How long the inbox reader tolerates a missing next-sequence file before
-- suspecting a genuine counter desync (rather than the panel simply not
-- having sent a new command yet). Kept comfortably under Node's own
-- local-transport commandTimeoutMs (15000, server/services/panelBridge.js
-- config.commandTimeoutMs) so a real desync always resolves before Node
-- gives up on the caller's request, never 5s after (2026-08-30
-- bridge-resync-threshold-transport-aware: at the old 20000 value, ANY
-- command landing in the first 5s of a divergence was guaranteed to time
-- out Node-side before this stuck-detector even fired).
--
-- Deliberately ONE constant, not per-transport, despite commandTimeoutMs
-- itself being 60000 over SFTP: .queue-state-node.json is panel-owned and,
-- as of this writing, panelBridgeSftp.js's syncNow() never uploads it to
-- the remote host (it uploads inbox/cmd-*.json and downloads status.json /
-- queue-state-lua.json / outbox, but this file isn't in either list) -- so
-- PanelBridge.readJSON(".queue-state-node.json") below always returns nil
-- over SFTP today, and this whole function is a guaranteed no-op there
-- regardless of this constant's value. Tuning it per-transport would only
-- ever change behavior for the local/direct case in practice. Flagged
-- separately as its own gap (inbox self-heal is currently inert for
-- SFTP-connected bridges) rather than folded into this change.
local INBOX_RESYNC_STUCK_MS = 10000
-- Once stuck, how often to re-probe the panel's state file (avoids reading
-- it every tick while legitimately idle waiting for the next real command).
local INBOX_RESYNC_CHECK_INTERVAL_MS = 5000

-- Detects a stalled inbox cursor (missing file at the expected sequence for
-- a sustained period) and, if the panel's own persisted write position
-- (.queue-state-node.json) disagrees with what we're waiting for, resyncs
-- lastCommandSeq to match it instead of waiting forever. See v1.7.12.
local function tryResyncInboxCursor(nextSeq)
    local now = getTimestampMs()
    local stuck = PanelBridge.inboxStuckState

    if stuck.seq ~= nextSeq then
        stuck.seq = nextSeq
        stuck.since = now
        stuck.nextCheckAt = now + INBOX_RESYNC_STUCK_MS
        return false
    end
    if now < stuck.nextCheckAt then
        return false
    end
    stuck.nextCheckAt = now + INBOX_RESYNC_CHECK_INTERVAL_MS

    local nodeState = PanelBridge.readJSON(".queue-state-node.json")
    local panelNextSeq = nodeState and tonumber(nodeState.nextCommandSeq)
    if not panelNextSeq or panelNextSeq < 1 then
        return false
    end

    local panelHighWater = panelNextSeq - 1
    if panelHighWater == PanelBridge.queueState.lastCommandSeq then
        -- Genuinely idle and in sync — nothing to resync.
        return false
    end

    -- Forward-only, mirroring tryResyncInboxCommandCursor's guard in
    -- panelBridge.js for the same hazard on the opposite (results) side
    -- (2026-08-30). A read of .queue-state-node.json that's stale or racing
    -- a second writer -- e.g. the four zombie nodemon-wrapped panel
    -- processes that shared one bridge folder and drifted apart earlier
    -- this same day -- can only ever show a LOWER panelHighWater than the
    -- truth, never a fabricated higher one. Refusing to move lastCommandSeq
    -- backward makes rewinding into already-processed commands structurally
    -- impossible instead of merely unlikely, regardless of why the read was
    -- stale (multiple writers, or -- if the SFTP upload gap above is ever
    -- closed -- ordinary transport lag).
    if panelHighWater < PanelBridge.queueState.lastCommandSeq then
        return false
    end

    PanelBridge.warn("Inbox sequence desync detected, resyncing to panel position", {
        expectedSeq = nextSeq,
        panelHighWater = panelHighWater,
        previousLastCommandSeq = PanelBridge.queueState.lastCommandSeq
    })
    PanelBridge.queueState.lastCommandSeq = panelHighWater
    PanelBridge.writeQueueState()
    PanelBridge.writeInboxCursor(panelHighWater)
    stuck.seq = nil
    return true
end

-- `scanned` bounds the loop below and counts every inbox file touched this
-- tick, garbage included (empty / malformed / duplicate / expired) -- this
-- is what keeps one tick's file I/O bounded no matter what's queued.
-- `processed` counts only entries processSingleCommand actually attempted
-- (its return true) and is what's returned, logged and reported -- reusing
-- the loop bound for that purpose is what let 036a538 both undercount
-- (double-counting garbage as processed) and, in fixing that, accidentally
-- remove the ONLY bound on the loop (see panelBridgeQueueBudget.test.js).
local function processQueuedCommands(budget)
    local processed = 0
    local scanned = 0
    if budget <= 0 then return processed, scanned end

    local nextSeq = (PanelBridge.queueState.lastCommandSeq or 0) + 1
    local advanced = false

    while scanned < budget do
        local fileName = "inbox/cmd-" .. PanelBridge.formatSeq(nextSeq) .. ".json"
        local raw = PanelBridge.readFile(fileName)

        if raw == nil then
            if tryResyncInboxCursor(nextSeq) then
                -- Resynced to the panel's actual write position; loop back
                -- around and retry immediately at the new nextSeq.
                nextSeq = PanelBridge.queueState.lastCommandSeq + 1
            else
                break
            end
        else
            local shouldAdvance = false

            if raw == "" then
                shouldAdvance = true
            else
                -- pcall-protect json.decode so a malformed file can't throw and
                -- leave the cursor unmoved (which would cause an infinite re-parse loop).
                local decodeOk, decoded = pcall(json.decode, raw)
                local queued = decodeOk and decoded or nil
                if not queued then
                    PanelBridge.warn("Skipping malformed queued command file", {
                        file = fileName,
                        seq = nextSeq,
                        parseError = (not decodeOk) and tostring(decoded) or "decode returned nil"
                    })
                    PanelBridge.clearFile(fileName)
                    shouldAdvance = true
                else
                    -- The cursor is written once below via shouldAdvance; the
                    -- in-memory position is set here so a handler crash cannot
                    -- cause this command to be replayed.
                    PanelBridge.queueState.lastCommandSeq = nextSeq

                    local cmd = queued.command or queued
                    if processSingleCommand(cmd) then
                        processed = processed + 1
                    end

                    -- Keep files compact after consumption.
                    PanelBridge.clearFile(fileName)
                    shouldAdvance = true
                end
            end

            if shouldAdvance then
                scanned = scanned + 1
                PanelBridge.queueState.lastCommandSeq = nextSeq
                PanelBridge.writeInboxCursor(nextSeq)
                advanced = true
                nextSeq = nextSeq + 1
            end
        end
    end

    if advanced then
        PanelBridge.writeQueueState()
    end

    return processed, scanned
end

local function normalizeMessage(value, maxLen)
    if value == nil then return nil end
    local ok, message = pcall(tostring, value)
    if not ok then return nil end
    if message == "" then return nil end
    if maxLen and #message > maxLen then
        message = message:sub(1, maxLen)
    end
    return message
end

-- ============================================
-- DEBUG & UTILITY HANDLERS
-- ============================================

-- Get debug log entries
handlers.getDebugLog = function(args)
    local limit = tonumber(args.limit) or 50
    limit = math.floor(limit)
    if limit < 1 then limit = 1 end
    if limit > 200 then limit = 200 end

    local minLevel = tostring(args.minLevel or "DEBUG")
    minLevel = string.upper(minLevel)

    local entries = {}
    local levelMap = { DEBUG = 1, INFO = 2, WARN = 3, ERROR = 4 }
    local minLevelNum = levelMap[minLevel] or 1

    local startIdx = math.max(1, #PanelBridge.debugLog - limit + 1)
    for i = startIdx, #PanelBridge.debugLog do
        local entry = PanelBridge.debugLog[i]
        if entry and levelMap[entry.level] >= minLevelNum then
            table.insert(entries, entry)
        end
    end

    return true, {
        entries = entries,
        totalEntries = #PanelBridge.debugLog,
        debugMode = PanelBridge.DEBUG_MODE
    }
end

-- Toggle debug mode
handlers.setDebugMode = function(args)
    PanelBridge.DEBUG_MODE = args.enabled == true
    PanelBridge.info("Debug mode " .. (PanelBridge.DEBUG_MODE and "enabled" or "disabled"))
    return true, { debugMode = PanelBridge.DEBUG_MODE }
end

-- Get statistics
handlers.getStats = function(args)
    local uptime = 0
    if PanelBridge.stats.startTime then
        uptime = (getTimestampMs() - PanelBridge.stats.startTime) / 1000
    end

    return true, {
        version = PanelBridge.VERSION,
        uptime = uptime,
        commandsProcessed = PanelBridge.stats.commandsProcessed,
        commandsSucceeded = PanelBridge.stats.commandsSucceeded,
        commandsFailed = PanelBridge.stats.commandsFailed,
        lastError = PanelBridge.stats.lastError,
        recentErrors = PanelBridge.stats.errors,
        debugMode = PanelBridge.DEBUG_MODE,
        detectedVersion = PanelBridge.detectedVersion
    }
end

-- Check API availability
handlers.checkAPI = function(args)
    local objName = args.object or "ClimateManager"
    local methodName = args.method

    local obj = nil
    local result = { object = objName, available = false }

    -- Get the object
    if objName == "ClimateManager" then
        obj = getClimateManager and getClimateManager()
    elseif objName == "GameTime" then
        obj = getGameTime and getGameTime()
    elseif objName == "World" then
        obj = getWorld and getWorld()
    elseif objName == "ChatServer" then
        local chat = getChatSystem()
        if chat and chat.server then obj = chat.server end
    elseif objName == "SandboxOptions" then
        obj = getSandboxOptions and getSandboxOptions()
    end

    if obj then
        result.available = true
        result.type = type(obj)

        -- If method specified, check if it exists
        if methodName then
            result.method = methodName
            result.methodAvailable = PanelBridge.hasMethod(obj, methodName)
        else
            -- List available methods (limited)
            result.methods = {}
            local ok = pcall(function()
                local count = 0
                for k, v in pairs(obj) do
                    if type(v) == "function" and count < 50 then
                        table.insert(result.methods, k)
                        count = count + 1
                    end
                end
                table.sort(result.methods)
            end)
            if not ok then
                result.methods = nil
                result.methodsError = "Method enumeration not supported for this object type"
            end
        end
    end

    return true, result
end

-- Get list of all available handlers
handlers.getAvailableHandlers = function(args)
    local handlerList = {}
    for name, _ in pairs(handlers) do
        table.insert(handlerList, name)
    end
    table.sort(handlerList)
    return true, {
        handlers = handlerList,
        count = #handlerList,
        version = PanelBridge.VERSION
    }
end

-- Clear error log
handlers.clearErrors = function(args)
    local count = #PanelBridge.stats.errors
    PanelBridge.stats.errors = {}
    PanelBridge.stats.lastError = nil
    PanelBridge.info("Error log cleared", { count = count })
    return true, { message = "Cleared " .. count .. " errors" }
end

-- Ping/heartbeat
handlers.ping = function(args)
    local onlinePlayers = getOnlinePlayers()
    return true, {
        message = "pong",
        version = PanelBridge.VERSION,
        serverTime = getTimestampMs(),
        playerCount = onlinePlayers and onlinePlayers:size() or 0
    }
end

-- Get server info
handlers.getServerInfo = function(args)
    local players = {}
    local onlinePlayers = getOnlinePlayers()

    if onlinePlayers then
        for i = 0, onlinePlayers:size() - 1 do
            local player = onlinePlayers:get(i)
            if player then
                -- Wrap each player in pcall so one bad player doesn't break the whole list
                local ok, playerData = pcall(function()
                    local health = 100
                    local isInfected = false
                    local bodyDamage = player:getBodyDamage()
                    if bodyDamage then
                        health = bodyDamage:getOverallBodyHealth() or 100
                        isInfected = bodyDamage:IsInfected() or false
                    end
                    -- WorldMap.tsx's player dossier already types/reads
                    -- hunger/thirst/fatigue off this row -- they were never
                    -- actually sent, so the panel silently displayed nothing.
                    -- statGet degrades to nil (not a plausible 0) on any
                    -- build where stats or CharacterStat is unavailable.
                    local stats = player:getStats()
                    return {
                        name = player:getUsername() or "Unknown",
                        x = math.floor(player:getX() or 0),
                        y = math.floor(player:getY() or 0),
                        z = math.floor(player:getZ() or 0),
                        health = health,
                        isAlive = player:isAlive(),
                        isInfected = isInfected,
                        accessLevel = player:getAccessLevel() or "",
                        hunger = statGet(stats, "HUNGER"),
                        thirst = statGet(stats, "THIRST"),
                        fatigue = statGet(stats, "FATIGUE")
                    }
                end)
                if ok and playerData then
                    table.insert(players, playerData)
                end
            end
        end
    end

    local gameTime = getGameTime()
    local gameTimeData = nil
    if gameTime then
        pcall(function()
            -- Use getHour()/getMinutes() on B42, fall back to getTimeOfDay() on B41
            local hour, minute
            local hourValue = PanelBridge.tryGet(gameTime, "getHour")
            if hourValue then
                hour = hourValue
                minute = PanelBridge.safeGet(gameTime, "getMinutes", 0)
            else
                local tod = gameTime:getTimeOfDay()
                hour = math.floor(tod)
                minute = math.floor((tod - hour) * 60)
            end
            gameTimeData = {
                day = gameTime:getDay(),
                month = gameTime:getMonth() + 1, -- Lua 1-indexed
                year = gameTime:getYear(),
                hour = hour,
                minute = minute
            }
        end)
    end

    return true, {
        players = players,
        playerCount = #players,
        gameTime = gameTimeData
    }
end

-- Get weather info
-- Each field is read inside its own pcall -- this used to wrap all 15 field
-- reads (12 of them bare direct calls) in ONE pcall, so a single throwing
-- getter crashed the whole handler and lost the other 14 fields, which would
-- have read fine on their own. Same per-item isolation pattern as
-- getClimateFloats (see its 2026-08-30 fix) -- one broken field is skipped
-- (and counted in a new `skipped` field) instead of taking down the rest.
local GET_WEATHER_FIELDS = {
    { key = "temperature", get = function(c) return c:getTemperature() end },
    { key = "humidity", get = function(c) return c:getHumidity() end },
    { key = "windSpeed", get = function(c) return c:getWindspeedKph() end },
    { key = "windAngle", get = function(c) return c:getWindAngleDegrees() end },
    { key = "fogIntensity", get = function(c) return c:getFogIntensity() end },
    { key = "cloudIntensity", get = function(c) return c:getCloudIntensity() end },
    { key = "precipitationIntensity", get = function(c) return c:getPrecipitationIntensity() end },
    { key = "isRaining", get = function(c) return c:isRaining() end },
    { key = "isSnowing", get = function(c) return c:isSnowing() end },
    { key = "isThunderStorming", get = function(c) return PanelBridge.safeGet(c, "getIsThunderStorming", false) end },
    { key = "dayLight", get = function(c) return c:getDayLightStrength() end },
    { key = "nightStrength", get = function(c) return c:getNightStrength() end },
    { key = "desaturation", get = function(c) return c:getDesaturation() end },
    { key = "viewDistance", get = function(c) return PanelBridge.safeGet(c, "getViewDistance", 1.0) end },
    { key = "ambient", get = function(c) return PanelBridge.safeGet(c, "getAmbient", 1.0) end },
}

handlers.getWeather = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local data = {}
    local skipped = 0
    for _, field in ipairs(GET_WEATHER_FIELDS) do
        local ok, value = pcall(field.get, climate)
        if ok then
            data[field.key] = value
        else
            skipped = skipped + 1
        end
    end
    data.skipped = skipped

    return true, data
end

-- Trigger blizzard (duration is in hours, minimum ~2 hours in game)
-- 2026-08-31 bug hunt follow-up (operator: "fix them" -- this is the finding
-- from the stopWeather pass). triggerCustomWeatherStage returns a real
-- boolean (confirmed via javap -c against the real jar: it early-returns
-- false when weatherPeriod:isRunning() is already true, i.e. a period is
-- already active), but `if PanelBridge.invoke(...) then` only ever checks
-- invoke()'s FIRST return (whether the pcall threw), discarding the SECOND
-- (the callee's own boolean) -- so triggering a second storm/blizzard/
-- tropical-storm while one is already running reported success and did
-- nothing. Fixed the same way across all three trigger* handlers: capture
-- invoke()'s real result, and verify-gate on it via PanelBridge.verifiedResult
-- (same convention as stopWeather) instead of trusting invoke()'s pcall-only
-- signal. The transmitTrigger* fallback (legacy/B41, void return -- no
-- boolean to lose) is left as an unverifiable ("nil") outcome, same ceiling
-- every other void-API handler in this file already has.
handlers.triggerBlizzard = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    -- Duration is passed directly - the game adds its own minimum
    local duration = args.duration or 2.0

    local used, verified
    local success, err = pcall(function()
        if WeatherPeriod and WeatherPeriod.STAGE_BLIZZARD then
            local invokeOk, triggered = PanelBridge.invoke(climate, "triggerCustomWeatherStage", WeatherPeriod.STAGE_BLIZZARD, duration)
            if invokeOk then
                used = "triggerCustomWeatherStage"
                verified = triggered == true
            end
        end
        if not used then
            if PanelBridge.invoke(climate, "transmitTriggerBlizzard", duration) then
                used = "transmitTriggerBlizzard"
                verified = nil -- void method, no boolean to confirm against
            else
                error("No weather trigger method available")
            end
        end
        PanelBridge.debug("Blizzard triggered", { method = used, verified = verified })
    end)

    if not success then
        return false, nil, "Failed to trigger blizzard: " .. tostring(err)
    end

    return PanelBridge.verifiedResult(verified, { message = "Blizzard triggered", duration = duration },
        "A weather period is already running -- stop it first, or wait for it to finish")
end

-- Trigger tropical storm
-- See triggerBlizzard's comment above -- same fix, same reason.
handlers.triggerTropicalStorm = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local duration = args.duration or 2.0

    local used, verified
    local success, err = pcall(function()
        if WeatherPeriod and WeatherPeriod.STAGE_TROPICAL_STORM then
            local invokeOk, triggered = PanelBridge.invoke(climate, "triggerCustomWeatherStage", WeatherPeriod.STAGE_TROPICAL_STORM, duration)
            if invokeOk then
                used = "triggerCustomWeatherStage"
                verified = triggered == true
            end
        end
        if not used then
            if PanelBridge.invoke(climate, "transmitTriggerTropical", duration) then
                used = "transmitTriggerTropical"
                verified = nil
            else
                error("No weather trigger method available")
            end
        end
        PanelBridge.debug("Tropical storm triggered", { method = used, verified = verified })
    end)

    if not success then
        return false, nil, "Failed to trigger tropical storm: " .. tostring(err)
    end

    return PanelBridge.verifiedResult(verified, { message = "Tropical storm triggered", duration = duration },
        "A weather period is already running -- stop it first, or wait for it to finish")
end

-- Trigger regular storm
-- See triggerBlizzard's comment above -- same fix, same reason.
handlers.triggerStorm = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local duration = args.duration or 2.0

    local used, verified
    local success, err = pcall(function()
        if WeatherPeriod and WeatherPeriod.STAGE_STORM then
            local invokeOk, triggered = PanelBridge.invoke(climate, "triggerCustomWeatherStage", WeatherPeriod.STAGE_STORM, duration)
            if invokeOk then
                used = "triggerCustomWeatherStage"
                verified = triggered == true
            end
        end
        if not used then
            if PanelBridge.invoke(climate, "transmitTriggerStorm", duration) then
                used = "transmitTriggerStorm"
                verified = nil
            else
                error("No weather trigger method available")
            end
        end
        PanelBridge.debug("Storm triggered", { method = used, verified = verified })
    end)

    if not success then
        return false, nil, "Failed to trigger storm: " .. tostring(err)
    end

    return PanelBridge.verifiedResult(verified, { message = "Storm triggered", duration = duration },
        "A weather period is already running -- stop it first, or wait for it to finish")
end

-- Stop weather
--
-- 2026-08-31 live bug (operator: "the stop weather only worked in game and
-- not in the panel. i tried all buttons to remove the rain and it didnt
-- work"). Root cause proven against the real jar's bytecode (javap -c,
-- zombie.iso.weather.ClimateManager / ClimateManager$ClimateFloat), NOT
-- guessed from method names -- two separate findings, and the obvious
-- hypothesis (wrong method picked by the exists-first cascade below) turned
-- out to be a dead end:
--
--   1. stopWeatherAndThunder() -- the method this cascade already picks
--      FIRST, since it exists -- is the CORRECT server-side call, not a
--      wrong one. Its own bytecode: no-ops if GameClient.client is true,
--      otherwise stops weatherPeriod + thunderstorm and, if
--      GameServer.server is true, ALSO transmits a ServerOnly climate
--      packet to sync connected clients. And the in-game "Stop current
--      weather" debug button's own server-side packet handler
--      (serverReceiveClientChangeWeather, reached via transmitStopWeather's
--      ClientOnly request) calls this EXACT SAME method -- there is no
--      hidden extra step on the working path. transmitStopWeather itself is
--      a CLIENT->SERVER request packet (ClimateNetAuth.ClientOnly) -- the
--      wrong one to call FROM the server, not the missing piece.
--   2. The REAL gap: precipitationIntensity is a ClimateFloat with its own
--      admin-override mechanism (used by handlers.startRain /
--      handlers.setSnow, via setAdminValue+setEnableAdmin). ClimateFloat's
--      calculate() (decompiled) pins finalValue = adminValue UNCONDITIONALLY
--      whenever isAdminOverride is true, completely bypassing weatherPeriod
--      -- and isRaining() is defined as getPrecipitationIntensity() > 0 AND
--      NOT snow. stopWeatherAndThunder never touches this override; only
--      transmitServerStopRain (what handlers.stopRain already calls) does.
--      So once rain had EVER been admin-forced via the panel, "Stop All
--      Weather" stopped the weather PERIOD but the admin-pinned rain kept
--      falling forever -- exactly the reported symptom. The panel's "Stop
--      All Weather" button (Events.tsx) only ever called this handler, not
--      the separate "Reset Climate" button (handlers.resetClimateOverrides)
--      that WOULD have cleared it -- an easy thing for an operator to not
--      think to also press, and a much bigger hammer (resets every climate
--      float, not just rain) than "stop weather" should require anyway.
handlers.stopWeather = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local success, err = pcall(function()
        local used
        if PanelBridge.invoke(climate, "stopWeatherAndThunder") then
            used = "stopWeatherAndThunder"
        elseif PanelBridge.invoke(climate, "transmitServerStopWeather") then
            used = "transmitServerStopWeather"
        elseif PanelBridge.invoke(climate, "transmitStopWeather") then
            used = "transmitStopWeather"
        else
            error("No stop weather method available")
        end
        -- Clear a lingering rain admin-override regardless of which stop
        -- variant above ran -- same call handlers.stopRain already uses.
        -- Best-effort: stopping the weather period is still real progress
        -- even if this particular call fails, so don't let it fail the
        -- whole handler; the verify step below is the actual honesty check.
        PanelBridge.invoke(climate, "transmitServerStopRain")
        PanelBridge.debug("Weather stopped", { method = used })
    end)

    if not success then
        return false, nil, "Failed to stop weather: " .. tostring(err)
    end

    -- Verify against the same ground truth the operator actually sees --
    -- isRaining() -- rather than trusting that neither invoke() call threw.
    -- House convention (see PanelBridge.verifiedResult / setGodMode's
    -- comment for why this needs an explicit if/then, not `a and b or c`).
    local stillRaining = PanelBridge.tryGet(climate, "isRaining")
    local verified
    if stillRaining == nil then
        verified = nil
    elseif stillRaining == false then
        verified = true
    else
        verified = false
    end

    PanelBridge.info("Stop weather", { verified = verified })

    return PanelBridge.verifiedResult(verified, { message = "Weather stopped" },
        "Stop weather call succeeded but it is still raining")
end

-- Generate custom weather period
-- 2026-08-31 bug hunt follow-up -- a WORSE instance of the triggerBlizzard
-- defect above, not just the same one. transmitGenerateWeather was tried
-- FIRST and never throws (it's a real method on the jar), so
-- PanelBridge.invoke always reported success and triggerCustomWeather --
-- the real, boolean-returning, context-checked B42 method -- was NEVER
-- reached, for any frontType, ever. And transmitGenerateWeather is a
-- CLIENT->SERVER request packet (ClimateNetAuth.ClientOnly, confirmed via
-- javap -c against the real jar) -- the same wrong-direction method class as
-- transmitStopWeather, likely a no-op when called FROM the server, which is
-- every call this handler makes. So "Generate weather" very likely did
-- nothing at all, silently, on every real invocation.
--
-- triggerCustomWeather only supports warm/cold (a boolean) -- no stationary
-- front -- so it can only be tried, and is now tried FIRST, when
-- frontType ~= 0. Stationary fronts have no other verifiable server-side
-- method found yet; transmitGenerateWeather is kept as its best-effort
-- fallback (unverifiable, same ceiling as every void-API handler in this
-- file) rather than a hard failure, since removing it entirely would leave
-- stationary fronts with zero implementation instead of an unverified one.
handlers.generateWeather = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local strength = args.strength or 0.5
    local frontType = args.frontType or 0 -- 0 = stationary, 1 = cold, 2 = warm

    -- Map frontend frontType values to B42 Java constants:
    -- FRONT_COLD = -1, FRONT_STATIONARY = 0, FRONT_WARM = 1
    local javaFrontMap = { [0] = 0, [1] = -1, [2] = 1 }
    local javaFrontType = javaFrontMap[frontType] or 0

    local used, verified
    local success, err = pcall(function()
        if frontType ~= 0 then
            local invokeOk, triggered = PanelBridge.invoke(climate, "triggerCustomWeather", strength, frontType ~= 1)
            if invokeOk then
                used = "triggerCustomWeather"
                verified = triggered == true
            end
        end
        if not used then
            if PanelBridge.invoke(climate, "transmitGenerateWeather", strength, javaFrontType) then
                used = "transmitGenerateWeather"
                verified = nil -- ClientOnly packet, no boolean, no known read-back
            else
                error("No generate weather method available")
            end
        end
        PanelBridge.debug("Weather period generated", { method = used, verified = verified })
    end)

    if not success then
        return false, nil, "Failed to generate weather: " .. tostring(err)
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Weather period generated", strength = strength, frontType = frontType },
        "A weather period is already running -- stop it first, or wait for it to finish")
end

-- Set precipitation to snow (also starts rain if enabling snow)
handlers.setSnow = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local enabled = args.enabled ~= false
    local success, err

    -- If enabling snow and not currently raining, start rain first
    if enabled and PanelBridge.tryGet(climate, "isRaining") == false then
        PanelBridge.invoke(climate, "transmitServerStartRain", args.intensity or 0.5)
    end

    success, err = pcall(function()
        local applied = false
        -- Admin override is the robust (sticky) path -- see applyClimateFloat's
        -- comment for why its own effective-value read-back is stale
        -- immediately after setAdminValue. setPrecipitationIsSnow below is
        -- what actually makes this handler verifiable: confirmed via
        -- javap -c, it writes ClimateBool.finalValue DIRECTLY (no
        -- calculate() involved), so reading it straight back is safe.
        local snowBool = PanelBridge.tryGet(climate, "getClimateBool", 0) -- BOOL_IS_SNOW = 0
        if snowBool and PanelBridge.invoke(snowBool, "setEnableAdmin", true)
            and PanelBridge.invoke(snowBool, "setAdminValue", enabled) then
            applied = true
        end
        -- Also drive the normal setter so the live value matches the override.
        if PanelBridge.invoke(climate, "setPrecipitationIsSnow", enabled) then
            applied = true
        end
        if not applied then error("No method to set snow") end
    end)

    if not success then
        return false, nil, "Failed to set snow: " .. tostring(err)
    end

    local isSnowNow = PanelBridge.tryGet(climate, "getPrecipitationIsSnow")
    local verified
    if isSnowNow == nil then
        verified = nil
    else
        verified = isSnowNow == enabled
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Snow " .. (enabled and "enabled (with precipitation)" or "disabled") },
        "Snow call succeeded but did not take effect")
end

-- Start rain
--
-- 2026-08-31 bug hunt follow-up. Verifies via getPrecipitationIntensity(),
-- safely -- unlike the plain climate-float admin-override handlers above,
-- transmitServerStartRain (confirmed via javap -c) calls the private
-- updateOnTick() internally before returning, so precipitationIntensity's
-- finalValue is genuinely fresh by the time this Lua call gets control back
-- -- no staleness risk here, this is the same mechanism stopWeather's own
-- isRaining() read-back already relies on for transmitServerStopRain.
handlers.startRain = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local intensity = args.intensity or 0.5

    local success, err = PanelBridge.invoke(climate, "transmitServerStartRain", intensity)

    if not success then
        return false, nil, "Failed to start rain: " .. tostring(err)
    end

    local actualIntensity = PanelBridge.tryGet(climate, "getPrecipitationIntensity")
    local verified
    if actualIntensity == nil then
        verified = nil
    else
        -- setAdminValue clamps to the float's own [min,max] (0..1 here per
        -- this handler's own existing comment), so compare against the
        -- clamped expectation, not the raw request.
        local expected = intensity
        if expected < 0 then expected = 0 end
        if expected > 1 then expected = 1 end
        verified = math.abs(actualIntensity - expected) < 0.01
    end

    return PanelBridge.verifiedResult(verified, { message = "Rain started", intensity = intensity },
        "Start rain call succeeded but precipitation did not take effect")
end

-- Stop rain
-- Verifies via isRaining() -- same reasoning as startRain above and
-- stopWeather's own use of this exact call.
handlers.stopRain = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local success, err = PanelBridge.invoke(climate, "transmitServerStopRain")

    if not success then
        return false, nil, "Failed to stop rain: " .. tostring(err)
    end

    local stillRaining = PanelBridge.tryGet(climate, "isRaining")
    local verified
    if stillRaining == nil then
        verified = nil
    elseif stillRaining == false then
        verified = true
    else
        verified = false
    end

    return PanelBridge.verifiedResult(verified, { message = "Rain stopped" },
        "Stop rain call succeeded but it is still raining")
end

-- Trigger lightning
handlers.triggerLightning = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local x = math.floor(tonumber(args.x) or 0)
    local y = math.floor(tonumber(args.y) or 0)
    local strike = args.strike ~= false  -- default to true
    local light = args.light ~= false     -- default to true
    local rumble = args.rumble ~= false   -- default to true

    -- Build 42.20's transmit helper can complete without queuing a visible
    -- thunder event. Trigger the server-side ThunderStorm event directly.
    local thunderStorm = PanelBridge.tryGet(climate, "getThunderStorm")
    local success, err
    if thunderStorm then
        success, err = PanelBridge.invoke(thunderStorm, "triggerThunderEvent", x, y, strike, light, rumble)
    else
        success, err = PanelBridge.invoke(climate, "transmitServerTriggerLightning", x, y, strike, light, rumble)
    end

    if not success then
        return false, nil, "Failed to trigger lightning: " .. tostring(err)
    end

    return true, { message = "Lightning triggered", x = x, y = y }
end

-- Applies a climate float through the admin override, falling back to the
-- direct setter. Returns the method used (or nil), and a verified tri-state
-- (true/false/nil).
--
-- 2026-08-31 bug hunt follow-up (clearing the PROVISIONAL block). Verifies
-- via getAdminValue(), NOT getFinalValue() -- confirmed via javap -c against
-- the real jar: setAdminValue/setEnableAdmin never call calculate(), which
-- is the only thing that propagates adminValue into finalValue (the value
-- the game actually renders/simulates with). calculate() only runs from
-- ClimateManager's own tick loop -- the private updateOnTick() (unreachable
-- from Lua at all) or the public but far heavier update() (runs the full
-- per-tick simulation -- sandbox overrides, weatherPeriod, OnClimateTick --
-- unsafe to call manually mid-handler). Reading getFinalValue() immediately
-- after setting would risk reading pre-update stale data -- neither a real
-- confirmation nor a real refutation, and a false negative here (reporting
-- a genuinely-working button as failed) would be worse than the ceiling
-- this replaces. getAdminValue() is a trivial field read of exactly what
-- setAdminValue just wrote (after the game's own min/max clamp) -- safe,
-- immediate, no staleness -- and it catches a real failure class
-- pcall-not-throwing cannot: setAdminValue silently CLAMPS an out-of-range
-- request instead of throwing, so a caller-requested value outside the
-- float's real [min,max] would otherwise report success while quietly
-- applying a different value.
local function applyClimateFloat(climate, floatIndex, value, setterName)
    local cf = PanelBridge.tryGet(climate, "getClimateFloat", floatIndex)
    if cf and PanelBridge.invoke(cf, "setEnableAdmin", true)
        and PanelBridge.invoke(cf, "setAdminValue", value) then
        local adminValue = PanelBridge.tryGet(cf, "getAdminValue")
        local verified
        if adminValue == nil then
            verified = nil
        else
            verified = math.abs(adminValue - value) < 0.01
        end
        return "climateFloat", verified
    end
    if PanelBridge.invoke(climate, setterName, value) then
        -- Legacy/fallback direct setter -- no admin-value field to compare
        -- against, so this path stays unverifiable, same ceiling it always
        -- had.
        return setterName, nil
    end
    return nil, nil
end

-- Set daylight strength (for darkness control)
handlers.setDayLight = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local value = tonumber(args.value) or 1.0

    local verified
    local success, err = pcall(function()
        local used
        used, verified = applyClimateFloat(climate, 11, value, "setDayLightStrength") -- FLOAT_DAYLIGHT_STRENGTH = 11
        if not used then error("No method to set daylight") end
    end)

    if not success then
        return false, nil, "Failed to set daylight: " .. tostring(err)
    end

    return PanelBridge.verifiedResult(verified, { message = "Daylight set to " .. value },
        "Daylight call succeeded but the admin value did not stick (likely clamped out of range)")
end

-- Set night strength
handlers.setNightStrength = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local value = tonumber(args.value) or 0.0

    local verified
    local success, err = pcall(function()
        local used
        used, verified = applyClimateFloat(climate, 2, value, "setNightStrength") -- FLOAT_NIGHT_STRENGTH = 2
        if not used then error("No method to set night strength") end
    end)

    if not success then
        return false, nil, "Failed to set night strength: " .. tostring(err)
    end

    return PanelBridge.verifiedResult(verified, { message = "Night strength set to " .. value },
        "Night strength call succeeded but the admin value did not stick (likely clamped out of range)")
end

-- Set desaturation (color saturation control)
handlers.setDesaturation = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local value = tonumber(args.value) or 0.0

    local verified
    local success, err = pcall(function()
        local used
        used, verified = applyClimateFloat(climate, 0, value, "setDesaturation") -- FLOAT_DESATURATION = 0
        if not used then error("No method to set desaturation") end
    end)

    if not success then
        return false, nil, "Failed to set desaturation: " .. tostring(err)
    end

    return PanelBridge.verifiedResult(verified, { message = "Desaturation set to " .. value },
        "Desaturation call succeeded but the admin value did not stick (likely clamped out of range)")
end

-- Set view distance (fog approximation)
handlers.setViewDistance = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local value = tonumber(args.value) or 1.0

    local verified
    local success, err = pcall(function()
        local used
        used, verified = applyClimateFloat(climate, 10, value, "setViewDistance") -- FLOAT_VIEW_DISTANCE = 10
        if not used then error("No method to set view distance") end
    end)

    if not success then
        return false, nil, "Failed to set view distance: " .. tostring(err)
    end

    return PanelBridge.verifiedResult(verified, { message = "View distance set to " .. value },
        "View distance call succeeded but the admin value did not stick (likely clamped out of range)")
end

-- Set ambient light
handlers.setAmbient = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local value = tonumber(args.value) or 1.0

    local verified
    local success, err = pcall(function()
        local used
        used, verified = applyClimateFloat(climate, 9, value, "setAmbient") -- FLOAT_AMBIENT = 9
        if not used then error("No method to set ambient") end
    end)

    if not success then
        return false, nil, "Failed to set ambient: " .. tostring(err)
    end

    return PanelBridge.verifiedResult(verified, { message = "Ambient set to " .. value },
        "Ambient call succeeded but the admin value did not stick (likely clamped out of range)")
end

-- Same as applyClimateFloat (see its comment for the getAdminValue() vs
-- getFinalValue() reasoning) but for floats with NO direct-setter fallback
-- in the real API -- confirmed via javap -c: unlike setDayLightStrength/
-- setNightStrength/setDesaturation/setAmbient/setViewDistance,
-- ClimateManager has no setTemperature/setWind/setFog/setClouds method at
-- all. The admin override is the only mechanism these floats have.
local function applyClimateFloatAdminOnly(climate, floatIndex, value)
    local cf = PanelBridge.tryGet(climate, "getClimateFloat", floatIndex)
    if not (cf and PanelBridge.invoke(cf, "setEnableAdmin", true)
        and PanelBridge.invoke(cf, "setAdminValue", value)) then
        return nil, nil
    end
    local adminValue = PanelBridge.tryGet(cf, "getAdminValue")
    if adminValue == nil then
        return "climateFloat", nil
    end
    return "climateFloat", math.abs(adminValue - value) < 0.01
end

-- Set temperature (Celsius)
-- Ranges and Effects (Project Zomboid Mechanics):
-- <-10 C: Extreme Cold. Winter clothes required. Poor quality vehicles may fail to start.
-- < 0 C : Freezing. Snow replaces Rain. Farming crops loose health faster.
-- 0 - 20 C: Cold to Cool. Light to Medium insulation required depending on wind/wetness.
-- 22 C  : Neutral. Base "Room Temperature". Neutral impact on body heat.
-- > 30 C: Hot. Rate of fatigue and thirst increases. Thick clothes cause overheating.
-- > 40 C: Extreme Heat. Rapid dehydration. Hyperthermia risk even when naked.
handlers.setTemperature = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local value = tonumber(args.value) or 22.0 -- Default to 22C (Neutral)

    -- API Safety Clamp: -50C to +50C
    -- Note: Project Zomboid does not simulate water bodies freezing solid (rivers/lakes).
    if value < -50 then value = -50 end
    if value > 50 then value = 50 end

    local verified
    local success, err = pcall(function()
        local used
        used, verified = applyClimateFloatAdminOnly(climate, 4, value) -- FLOAT_TEMPERATURE = 4
        if not used then error("No method to set temperature") end
    end)

    if not success then
        return false, nil, "Failed to set temperature: " .. tostring(err)
    end

    return PanelBridge.verifiedResult(verified, { message = "Temperature set to " .. value .. "C" },
        "Temperature call succeeded but the admin value did not stick (likely clamped out of range)")
end

-- Set wind intensity
handlers.setWind = function(args)
    local climate = getClimateManager()
    if not climate then return false, nil, "ClimateManager not available" end

    local value = tonumber(args.value) or 0.5 -- 0 to 1

    local verified
    local success, err = pcall(function()
        local used
        used, verified = applyClimateFloatAdminOnly(climate, 6, value) -- FLOAT_WIND_INTENSITY = 6
        if not used then error("No method to set wind") end
    end)

    if not success then return false, nil, "Failed to set wind: " .. tostring(err) end
    return PanelBridge.verifiedResult(verified, { message = "Wind set to " .. value },
        "Wind call succeeded but the admin value did not stick (likely clamped out of range)")
end

-- Set fog intensity
handlers.setFog = function(args)
    local climate = getClimateManager()
    if not climate then return false, nil, "ClimateManager not available" end

    local value = tonumber(args.value) or 0.0 -- 0 (Clear) to 1 (Silent Hill)

    local verified
    local success, err = pcall(function()
        local used
        used, verified = applyClimateFloatAdminOnly(climate, 5, value) -- FLOAT_FOG_INTENSITY = 5
        if not used then error("No method to set fog") end
    end)

    if not success then return false, nil, "Failed to set fog: " .. tostring(err) end
    return PanelBridge.verifiedResult(verified, { message = "Fog set to " .. value },
        "Fog call succeeded but the admin value did not stick (likely clamped out of range)")
end

-- Set cloud intensity
handlers.setClouds = function(args)
    local climate = getClimateManager()
    if not climate then return false, nil, "ClimateManager not available" end

    local value = tonumber(args.value) or 0.0 -- 0 to 1

    local verified
    local success, err = pcall(function()
        local used
        used, verified = applyClimateFloatAdminOnly(climate, 8, value) -- FLOAT_CLOUD_INTENSITY = 8
        if not used then error("No method to set clouds") end
    end)

    if not success then return false, nil, "Failed to set clouds: " .. tostring(err) end
    return PanelBridge.verifiedResult(verified, { message = "Clouds set to " .. value },
        "Clouds call succeeded but the admin value did not stick (likely clamped out of range)")
end

-- Climate override control - set individual climate float values
-- This uses the ClimateFloat system for admin control
handlers.setClimateFloat = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    local floatId = tonumber(args.floatId)
    local value = tonumber(args.value)
    local enable = args.enable ~= false

    if floatId == nil or value == nil then
        return false, nil, "floatId and value are required numbers"
    end

    local climateFloat = climate:getClimateFloat(floatId)
    if not climateFloat then
        return false, nil, "Invalid float ID: " .. floatId
    end

    local verified
    local success, err = pcall(function()
        climateFloat:setEnableAdmin(enable)
        if enable then
            climateFloat:setAdminValue(value)
            -- See applyClimateFloat's comment for why getAdminValue(), not
            -- getFinalValue() -- same staleness reasoning, this handler IS
            -- the generic setter the specific ones wrap.
            local adminValue = PanelBridge.tryGet(climateFloat, "getAdminValue")
            if adminValue == nil then
                verified = nil
            else
                verified = math.abs(adminValue - value) < 0.01
            end
        else
            -- Disabling is a trivial, immediate field flip -- safe to
            -- confirm directly, no calculate()/staleness concern.
            local stillEnabled = PanelBridge.tryGet(climateFloat, "isEnableAdmin")
            if stillEnabled == nil then
                verified = nil
            else
                verified = stillEnabled == false
            end
        end
    end)

    if not success then
        return false, nil, "Failed to set climate float: " .. tostring(err)
    end

    return PanelBridge.verifiedResult(verified, {
        message = "Climate float set",
        floatId = floatId,
        value = value,
        enabled = enable,
        name = climateFloat:getName()
    }, "Climate float call succeeded but did not take effect")
end

-- Reads back isEnableAdmin() across the known float IDs (0-12) and the snow
-- bool -- a trivial field read each, no calculate()/staleness concern
-- (unlike getFinalValue(), see applyClimateFloat's comment) -- and returns
-- how many are still (wrongly) admin-overridden after a reset. 0 means
-- genuinely confirmed clean.
local function countStillOverridden(climate)
    local stillOn = 0
    local checked = 0
    for floatId = 0, 12 do
        local cf = PanelBridge.tryGet(climate, "getClimateFloat", floatId)
        if cf then
            local enabled = PanelBridge.tryGet(cf, "isEnableAdmin")
            if enabled ~= nil then
                checked = checked + 1
                if enabled then stillOn = stillOn + 1 end
            end
        end
    end
    local snowBool = PanelBridge.tryGet(climate, "getClimateBool", 0) -- BOOL_IS_SNOW
    if snowBool then
        local enabled = PanelBridge.tryGet(snowBool, "isEnableAdmin")
        if enabled ~= nil then
            checked = checked + 1
            if enabled then stillOn = stillOn + 1 end
        end
    end
    return stillOn, checked
end

-- Reset all climate overrides
--
-- 2026-08-31 bug hunt follow-up. The resetAdmin() fast path's own
-- comment used to claim success unconditionally on invoke() not throwing --
-- confirmed via javap -c that resetAdmin() itself is genuinely
-- unconditional (an unguarded loop calling setEnableAdmin(false) on every
-- float/bool/color, no failure path exists once `climate` itself is valid),
-- so that specific claim wasn't actually a lie -- but it also wasn't
-- CONFIRMED, just assumed. Now verifies by reading isEnableAdmin() back
-- across the same floats/bool afterward (safe, immediate, no staleness --
-- see countStillOverridden above) instead of trusting the call alone.
handlers.resetClimateOverrides = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    -- B42: resetAdmin() resets all float + bool admin overrides in one call
    if PanelBridge.invoke(climate, "resetAdmin") then
        local stillOn, checked = countStillOverridden(climate)
        local verified
        if checked == 0 then
            verified = nil
        else
            verified = stillOn == 0
        end
        return PanelBridge.verifiedResult(verified,
            { message = "Climate overrides reset via resetAdmin()", floatsReset = 13, boolsReset = 1 },
            "Reset call succeeded but " .. stillOn .. " of " .. checked .. " overrides are still active")
    end

    -- Fallback: disable admin override on all known float IDs (0-12)
    local resetCount = 0
    for floatId = 0, 12 do
        local cf = PanelBridge.tryGet(climate, "getClimateFloat", floatId)
        if cf and PanelBridge.invoke(cf, "setEnableAdmin", false) then
            resetCount = resetCount + 1
        end
    end

    -- Also reset ClimateBool overrides (e.g. BOOL_IS_SNOW = 0 set by setSnow)
    local boolsReset = 0
    pcall(function()
        local snowBool = climate:getClimateBool(0) -- BOOL_IS_SNOW
        if snowBool and snowBool.setEnableAdmin then
            snowBool:setEnableAdmin(false)
            boolsReset = boolsReset + 1
        end
    end)

    local stillOn, checked = countStillOverridden(climate)
    local verified
    if checked == 0 then
        verified = nil
    else
        verified = stillOn == 0
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Climate overrides reset", floatsReset = resetCount, boolsReset = boolsReset },
        "Reset call succeeded but " .. stillOn .. " of " .. checked .. " overrides are still active")
end

-- Get climate float IDs and their current values
handlers.getClimateFloats = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end

    -- Known ClimateFloat IDs from the API
    local floatIds = {
        { id = 0, name = "FLOAT_DESATURATION" },
        { id = 1, name = "FLOAT_GLOBAL_LIGHT_INTENSITY" },
        { id = 2, name = "FLOAT_NIGHT_STRENGTH" },
        { id = 3, name = "FLOAT_PRECIPITATION_INTENSITY" },
        { id = 4, name = "FLOAT_TEMPERATURE" },
        { id = 5, name = "FLOAT_FOG_INTENSITY" },
        { id = 6, name = "FLOAT_WIND_INTENSITY" },
        { id = 7, name = "FLOAT_WIND_ANGLE_INTENSITY" },
        { id = 8, name = "FLOAT_CLOUD_INTENSITY" },
        { id = 9, name = "FLOAT_AMBIENT" },
        { id = 10, name = "FLOAT_VIEW_DISTANCE" },
        { id = 11, name = "FLOAT_DAYLIGHT_STRENGTH" },
        { id = 12, name = "FLOAT_HUMIDITY" }
    }

    -- Each float is read inside its own pcall -- this loop previously had NO
    -- pcall protection at all (not merely a wide boundary shared across all
    -- 13 floats, an absent catch entirely), so a single float object's
    -- accessor throwing crashed this whole handler uncaught, straight past
    -- to the dispatcher's outer pcall as a generic "Handler crashed: ..."
    -- instead of a clean ok=false, and took every OTHER float down with it.
    -- Events.tsx polls this handler every 10s, making it the most-invoked
    -- one this fix touches.
    local floats = {}
    local skipped = 0
    for _, info in ipairs(floatIds) do
        local ok, entry = pcall(function()
            local cf = climate:getClimateFloat(info.id)
            if not cf then return nil end
            return {
                id = info.id,
                name = info.name,
                actualName = cf:getName(),
                value = cf:getFinalValue(),
                min = cf:getMin(),
                max = cf:getMax(),
                isAdminEnabled = PanelBridge.safeGet(cf, "isEnableAdmin", false)
            }
        end)
        if ok and entry then
            table.insert(floats, entry)
        else
            skipped = skipped + 1
        end
    end

    return true, { floats = floats, skipped = skipped }
end

-- ============================================
-- SOUND & NOISE HANDLERS
-- ============================================

-- Safely emit a world sound that zombies can hear.
-- The global addSound() is not guaranteed to exist on every B41/B42 build,
-- so fall back to the WorldSoundManager API when it is missing. Returns
-- (true, method) on success or (false, errorMessage) on failure so callers
-- never crash with "attempt to call nil value (global 'addSound')".
local function emitWorldSound(player, x, y, z, radius, volume)
    local method = "unknown"
    local ok, err = pcall(function()
        if addSound then
            addSound(player, x, y, z, radius, volume)
            method = "addSound"
        elseif getWorld and getWorld() and getWorld().getWorldSoundManager then
            local wsm = getWorld():getWorldSoundManager()
            if wsm and wsm.addSound then
                wsm:addSound(player, x, y, z, radius, volume)
                method = "WorldSoundManager.addSound"
            else
                error("No sound API available")
            end
        else
            error("No sound API available")
        end
    end)
    if not ok then
        return false, "sound emission failed: " .. tostring(err)
    end
    return true, method
end

-- Play a sound at specific world coordinates
-- This creates an audible sound that zombies can hear and respond to
handlers.playWorldSound = function(args)
    local x = tonumber(args.x)
    local y = tonumber(args.y)
    local z = tonumber(args.z) or 0
    local radius = tonumber(args.radius) or 50
    local volume = tonumber(args.volume) or 100

    if not x or not y then
        return false, nil, "x and y coordinates are required"
    end

    -- AddWorldSound creates a noise that zombies can hear
    -- Parameters: player (can be nil), x, y, z, radius, volume
    local ok, methodOrErr = emitWorldSound(nil, x, y, z, radius, volume)
    if not ok then
        return false, nil, methodOrErr
    end

    return true, {
        message = "World sound created",
        x = x,
        y = y,
        z = z,
        radius = radius,
        volume = volume,
        method = methodOrErr
    }
end

-- Play a sound near a specific player (zombies will hear it)
handlers.playSoundNearPlayer = function(args)
    local username = args.username
    local radius = tonumber(args.radius) or 50
    local volume = tonumber(args.volume) or 100

    if not username then
        return false, nil, "username is required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local x = player:getX()
    local y = player:getY()
    local z = player:getZ()

    -- Create sound at player's location
    local ok, methodOrErr = emitWorldSound(player, x, y, z, radius, volume)
    if not ok then
        return false, nil, methodOrErr
    end

    return true, {
        message = "Sound created near player",
        username = username,
        x = x,
        y = y,
        z = z,
        radius = radius,
        volume = volume,
        method = methodOrErr
    }
end

-- Simulate a gunshot sound (very loud, attracts zombies from far away)
handlers.triggerGunshot = function(args)
    local x = tonumber(args.x)
    local y = tonumber(args.y)
    local z = tonumber(args.z) or 0
    local username = args.username

    -- If username provided, use player's location
    if username then
        local player = getPlayerByUsername(username)
        if player then
            x = player:getX()
            y = player:getY()
            z = player:getZ()
        else
            return false, nil, "Player not found: " .. username
        end
    end

    if not x or not y then
        return false, nil, "Either coordinates (x, y) or username is required"
    end

    -- Gunshots have large radius and high volume to attract zombies from far away
    local gunshotRadius = 150
    local gunshotVolume = 200

    local ok, methodOrErr = emitWorldSound(nil, x, y, z, gunshotRadius, gunshotVolume)
    if not ok then
        return false, nil, methodOrErr
    end

    return true, {
        message = "Gunshot sound triggered",
        x = x,
        y = y,
        z = z,
        radius = gunshotRadius,
        method = methodOrErr
    }
end

-- Trigger an alarm sound (medium range, sustained attraction)
handlers.triggerAlarmSound = function(args)
    local x = tonumber(args.x)
    local y = tonumber(args.y)
    local z = tonumber(args.z) or 0
    local username = args.username

    -- If username provided, use player's location
    if username then
        local player = getPlayerByUsername(username)
        if player then
            x = player:getX()
            y = player:getY()
            z = player:getZ()
        else
            return false, nil, "Player not found: " .. username
        end
    end

    if not x or not y then
        return false, nil, "Either coordinates (x, y) or username is required"
    end

    -- Alarm has moderate radius
    local alarmRadius = 80
    local alarmVolume = 100

    local ok, methodOrErr = emitWorldSound(nil, x, y, z, alarmRadius, alarmVolume)
    if not ok then
        return false, nil, methodOrErr
    end

    return true, {
        message = "Alarm sound triggered",
        x = x,
        y = y,
        z = z,
        radius = alarmRadius,
        method = methodOrErr
    }
end

-- Create a loud noise to attract zombies to a location
handlers.createNoise = function(args)
    local x = tonumber(args.x)
    local y = tonumber(args.y)
    local z = tonumber(args.z) or 0
    local radius = tonumber(args.radius) or 100
    local volume = tonumber(args.volume) or 100
    local username = args.username

    -- If username provided, use player's location
    if username then
        local player = getPlayerByUsername(username)
        if player then
            x = player:getX()
            y = player:getY()
            z = player:getZ()
        else
            return false, nil, "Player not found: " .. username
        end
    end

    if not x or not y then
        return false, nil, "Either coordinates (x, y) or username is required"
    end

    -- Clamp values
    radius = math.min(math.max(radius, 10), 500)
    volume = math.min(math.max(volume, 1), 500)

    local ok, method = emitWorldSound(nil, x, y, z, radius, volume)
    if not ok then
        return false, nil, "createNoise failed: " .. tostring(method)
    end

    return true, {
        message = "Noise created",
        x = x,
        y = y,
        z = z,
        radius = radius,
        volume = volume,
        method = method
    }
end

-- ============================================
-- TIME & WORLD HANDLERS
-- ============================================

-- Helper to safely get a value from a method that might not exist (with default fallback)
local function safeGetValue(obj, methodName, default)
    local success, result = PanelBridge.invoke(obj, methodName)
    if success and result ~= nil then
        return result
    end
    return default
end

-- Get game time info
handlers.getGameTime = function(args)
    local gameTime = getGameTime()
    if not gameTime then
        return false, nil, "GameTime not available"
    end

    -- Build 42 logs a full Kahlua trace for an unavailable Java probe, even
    -- inside pcall. Restrict this to clock methods used by vanilla Lua.
    local timeOfDay = gameTime:getTimeOfDay()
    local hour = math.floor(timeOfDay)
    return true, {
        year = gameTime:getYear(),
        month = gameTime:getMonth() + 1, -- Lua 1-indexed
        day = gameTime:getDay(),
        hour = timeOfDay,
        minute = math.floor((timeOfDay - hour) * 60),
        dayOfWeek = 0,
        worldAgeHours = gameTime:getWorldAgeHours(),
        timeSinceApo = 0,
        moonPhase = 0,
        nightsSurvived = gameTime:getNightsSurvived(),
        -- Same GameTime singleton/field RCON's setTimeSpeed command writes
        -- via GameTime.getInstance():setMultiplier() (confirmed against the
        -- real jar) -- a real, authoritative read-back for the panel's
        -- time-speed slider (client/src/pages/Events.tsx), not a decorative
        -- one. Deliberately DEVIATES from every other getter above, which
        -- use bare colon-calls specifically to dodge the Kahlua-trace-log
        -- note at the top of this handler -- getMultiplier isn't one of the
        -- vanilla-confirmed clock methods that note restricts bare calls
        -- to, so it goes through tryGet instead, same as any other
        -- not-yet-vanilla-confirmed probe elsewhere in this file.
        multiplier = tonumber(PanelBridge.tryGet(gameTime, "getMultiplier")) or 1
    }
end

-- Set game time
handlers.setGameTime = function(args)
    local gameTime = getGameTime()
    if not gameTime then
        return false, nil, "GameTime not available"
    end

    local updated = {}

    local function setAndVerify(methodName, value, getterName, expected)
        local ok, err = PanelBridge.invoke(gameTime, methodName, value)
        if not ok then
            return false, "Failed to call " .. methodName .. ": " .. tostring(err)
        end

        local actual = safeGetValue(gameTime, getterName, nil)
        if actual ~= expected then
            return false, methodName .. " did not apply (expected " .. tostring(expected) .. ", got " .. tostring(actual) .. ")"
        end
        return true
    end

    if args.hour ~= nil then
        local hour = tonumber(args.hour) or 12
        local ok, err = setAndVerify("setTimeOfDay", hour, "getTimeOfDay", hour)
        if not ok then return false, nil, err end
        updated.hour = hour
    end

    if args.day ~= nil then
        local day = tonumber(args.day)
        if day then
            local ok, err = setAndVerify("setDay", day, "getDay", day)
            if not ok then return false, nil, err end
            updated.day = day
        end
    end

    if args.month ~= nil then
        local month = tonumber(args.month)
        if month then
            month = math.max(1, math.min(12, month))
            local ok, err = setAndVerify("setMonth", month - 1, "getMonth", month - 1)
            if not ok then return false, nil, err end
            updated.month = month
        end
    end

    if args.year ~= nil then
        local year = tonumber(args.year)
        if year then
            local ok, err = setAndVerify("setYear", year, "getYear", year)
            if not ok then return false, nil, err end
            updated.year = year
        end
    end

    return true, { message = "Game time updated", updated = updated }
end

-- Get world statistics
handlers.getWorldStats = function(args)
    local world = getWorld()
    if not world then
        return false, nil, "World not available"
    end

    local cell = world:getCell()
    local zombieCount = 0
    if cell and cell.getZombieList then
        pcall(function()
            local list = cell:getZombieList()
            if list then
                zombieCount = list:size()
            end
        end)
    end

    return true, {
        serverName = getServerName(),
        map = world:getMap() or "Unknown",
        zombiesInCell = zombieCount
    }
end

-- Get current time speed multiplier. Real and working, but still unused by
-- the panel: Events.tsx's time-speed slider gets its live read-back from
-- getGameTime's own `multiplier` field (added 2026-08-30, same GameTime
-- singleton) instead of this dedicated handler -- confirmed via a route/
-- client call-site check, this handler has none beyond its own registration
-- and tests. Not a bug to fix, just noting it so a future reader doesn't
-- re-diagnose the already-fixed stale-slider problem this handler predates.
handlers.getTimeSpeed = function(args)
    local gt = getGameTime()
    if not gt then
        return false, nil, "GameTime not available"
    end

    local multiplier = tonumber(PanelBridge.tryGet(gt, "getMultiplier")) or 1

    return true, { multiplier = multiplier }
end

-- Set time speed multiplier (1 = normal, higher = faster). The live path is
-- client/src/pages/Events.tsx's time-speed slider, which calls
-- executeCommand(`setTimeSpeed ${timeSpeed}`) -> rconApi.execute() -> the
-- server's own RCON setTimeSpeed/sts command, not this handler. Kept (not
-- deleted) as a clear, named failure rather than a silently-missing handler.
handlers.setTimeSpeed = function(args)
    return false, nil, "Time speed must use the server RCON command; PanelBridge cannot change the dedicated server clock multiplier"
end

-- Trigger a server-wide helicopter event. Currently unused by the panel:
-- the "Helicopter" quick-sound button in client/src/pages/Events.tsx calls
-- serverApi.triggerChopper() -> POST /server/events/chopper -> RCON's
-- chopper command instead, which targets a RANDOM online player (see that
-- file's own "chopper and gunshot target a RANDOM online player" comment).
--
-- 2026-08-30, operator: "Fix event." All four of this handler's previous
-- fallback tiers were fabricated -- verified ABSENT against the real B42
-- jar (Kevin's audit), not a B41/B42 divergence or a near-miss name:
--   HelicopterClass.getInstance()+activateForPlayer -- neither exists on
--     the real zombie.iso.Helicopter, and there is no singleton field
--   RZSUtil.triggerRandomEvent -- RZSUtil does not exist ANYWHERE in the
--     jar, nor in the shipped vanilla Lua tree
--   addHelicopter -- zero matches jar-wide, including on the GlobalObject
--     class that backs every other bare global in this file
--   ServerCheatInterface.triggerHelicopter -- the class does not exist
-- Deleted rather than kept "just in case": there is nothing for a future
-- reader to rediscover except the fact that they never existed.
--
-- What IS real: LuaManager$GlobalObject.testHelicopter() -- same bare-global
-- binding tier as getWorld()/getCell()/saveGame(), called directly, not on
-- a receiver -- ZERO-ARG. There is no per-player targeting API anywhere in
-- the confirmed jar, so this can no longer accept a username: silently
-- accepting an argument it cannot honour is the same defect class as
-- everything else fixed in this audit. A working server-wide helicopter
-- beats a per-player one that had never once fired.
handlers.triggerHelicopterEvent = function(args)
    if args.username then
        return false, nil, "Helicopter events cannot target a specific player on this build -- " ..
            "testHelicopter() (the only real API, confirmed against the real B42 jar) triggers " ..
            "server-wide and takes no arguments. Call this action with no username."
    end

    local ok, err = pcall(function()
        testHelicopter()
    end)

    if not ok then
        return false, nil, "Failed to trigger helicopter: " .. tostring(err)
    end

    PanelBridge.info("Helicopter triggered (server-wide)")
    return true, {
        message = "Helicopter event triggered server-wide (not per-player -- no per-player " ..
            "targeting API exists on this build)"
    }
end

-- Stop a running server-wide helicopter event. The trigger side above
-- (testHelicopter()) had no counterpart until now -- an operator could
-- start one and then had no way to end it early. endHelicopter() is the
-- real, adjacent sibling on the same bare-global binding tier, confirmed
-- directly against the real B42 jar (javap against
-- zombie.Lua.LuaManager$GlobalObject): `public static void endHelicopter()`,
-- zero-arg, same shape as testHelicopter(). 2026-08-30, god's foundation-lens
-- follow-up to ce29ee63.
--
-- No read-back exists to verify a helicopter event was actually running
-- before this call, or that it actually stopped -- there is no exposed
-- query for helicopter-event state anywhere in the confirmed jar. Calling
-- this when no event is active is not confirmed harmless from a static
-- read; pcall still guards it the same as every other bare-global call in
-- this file, so a throw here fails cleanly rather than crashing the mod.
--
-- Same username guard as triggerHelicopterEvent, same reason: endHelicopter()
-- is zero-arg and server-wide, so a per-player stop is exactly as impossible
-- as a per-player trigger. Silently ignoring a username here would be the
-- same defect class fixed everywhere else in this audit.
handlers.stopHelicopterEvent = function(args)
    if args.username then
        return false, nil, "Helicopter events cannot target a specific player on this build -- " ..
            "endHelicopter() (the only real API, confirmed against the real B42 jar) stops the " ..
            "server-wide event and takes no arguments. Call this action with no username."
    end

    local ok, err = pcall(function()
        endHelicopter()
    end)

    if not ok then
        return false, nil, "Failed to stop helicopter: " .. tostring(err)
    end

    PanelBridge.info("Helicopter stopped (server-wide)")
    return true, {
        message = "Helicopter event stop signal sent server-wide"
    }
end

-- Get detailed player info
handlers.getPlayerDetails = function(args)
    local username = args.username
    if not username then
        return false, nil, "Username required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local ok, playerData = pcall(function()
        -- Every field below is read via PanelBridge.tryGet, which pcalls the
        -- underlying call ITSELF (see PanelBridge.invoke) -- an absent method
        -- like Stats:getHunger() (2026-08-30, Kevin's jar audit: not on
        -- zombie.characters.Stats at all) now fails ALONE and returns nil,
        -- instead of throwing out of this whole function and losing
        -- position/username/accessLevel/etc, which all work fine. A field
        -- that cannot be read is left OUT of the table entirely (nil omits
        -- the key) rather than defaulted to 0 -- a 0 for hunger is a lie a
        -- UI would render as "not hungry". This outer pcall stays as a
        -- backstop for something genuinely unforeseen; it should no longer
        -- fire for the known-absent-stat case.
        local function get(obj, methodName)
            return PanelBridge.tryGet(obj, methodName)
        end

        local stats = PanelBridge.tryGet(player, "getStats")
        local bodyDamage = PanelBridge.tryGet(player, "getBodyDamage")

        local pd = {
            username = get(player, "getUsername"),
            displayName = get(player, "getDisplayName"),
            x = get(player, "getX"),
            y = get(player, "getY"),
            z = get(player, "getZ"),
            accessLevel = get(player, "getAccessLevel"),
            isAlive = get(player, "isAlive"),
            isAsleep = get(player, "isAsleep"),
            isSneaking = get(player, "isSneaking"),
            isRunning = get(player, "isRunning"),
            stats = {},
            health = {}
        }

        -- Get stats if available -- stats:get(CharacterStat.X), not named
        -- getters. See statGet() above for why.
        if stats then
            pd.stats = {
                hunger = statGet(stats, "HUNGER"),
                thirst = statGet(stats, "THIRST"),
                fatigue = statGet(stats, "FATIGUE"),
                stress = statGet(stats, "STRESS"),
                boredom = statGet(stats, "BOREDOM"),
                unhappiness = statGet(stats, "UNHAPPINESS"),
                pain = statGet(stats, "PAIN"),
                endurance = statGet(stats, "ENDURANCE")
            }
        end

        -- Get health if available
        if bodyDamage then
            -- getIsBleeding does not exist anywhere on BodyDamage (Kevin's
            -- jar audit, 2026-08-30) -- there is no boolean bleeding getter
            -- at all. The real method is getNumPartsBleeding() -> int; this
            -- is a SEMANTIC REINTERPRETATION (a count becoming a boolean),
            -- not a rename, so it's named explicitly rather than silently
            -- swapping method names under the same field.
            local numPartsBleeding = get(bodyDamage, "getNumPartsBleeding")

            -- getTemperature does not exist directly on BodyDamage either --
            -- it is two hops: bodyDamage:getThermoregulator():getCoreTemperature().
            -- getCoreTemperatureUI() also exists on the same object, but
            -- Kevin could not confirm from the descriptor alone whether it
            -- rounds or clamps the value, so this uses the raw getter for
            -- an API response rather than a UI-display one.
            local thermoregulator = PanelBridge.tryGet(bodyDamage, "getThermoregulator")

            -- NOT the `a and b or c` idiom: when numPartsBleeding is 0, that
            -- idiom's `b` (numPartsBleeding > 0) evaluates to `false`, which
            -- is itself falsy in Lua, so the whole expression would fall
            -- through to `c` and silently produce nil instead of the real
            -- `false` -- this file's own recurring lesson about that idiom,
            -- applied here before it could bite a THIRD time tonight.
            local isBleeding = nil
            if numPartsBleeding ~= nil then
                isBleeding = numPartsBleeding > 0
            end

            pd.health = {
                overallBodyHealth = get(bodyDamage, "getOverallBodyHealth"),
                isInfected = get(bodyDamage, "IsInfected"),
                isBleeding = isBleeding,
                health = get(bodyDamage, "getHealth"),
                temperature = thermoregulator and get(thermoregulator, "getCoreTemperature") or nil
                -- wetness deliberately removed: no whole-body wetness
                -- concept exists anywhere on BodyDamage under any name at
                -- any hop (Kevin's jar audit) -- only mutators, zero
                -- getters. Not substituted with a near-miss from a
                -- different object; the field is simply gone.
            }
        end

        return pd
    end)

    if not ok then
        return false, nil, "Error reading player details: " .. tostring(playerData)
    end

    return true, playerData
end

-- Get all players with details
handlers.getAllPlayerDetails = function(args)
    local onlinePlayers = getOnlinePlayers()
    local players = {}

    if not onlinePlayers then
        return true, { players = {} }
    end

    for i = 0, onlinePlayers:size() - 1 do
        local player = onlinePlayers:get(i)
        if player then
            local ok, playerData = pcall(function()
                -- Same fix as handlers.getPlayerDetails -- every field below
                -- goes through PanelBridge.tryGet (already-pcalled per call)
                -- so an absent stat getter fails alone instead of taking
                -- down this player's position/username/accessLevel with it.
                -- A field that can't be read is left OUT (nil omits the
                -- key), never defaulted to 0. This outer pcall + the
                -- {username, error} fallback below stay as a backstop for
                -- something genuinely unforeseen.
                local function get(obj, methodName)
                    return PanelBridge.tryGet(obj, methodName)
                end

                local stats = PanelBridge.tryGet(player, "getStats")
                local bodyDamage = PanelBridge.tryGet(player, "getBodyDamage")

                local pd = {
                    username = get(player, "getUsername"),
                    displayName = get(player, "getDisplayName"),
                    x = get(player, "getX"),
                    y = get(player, "getY"),
                    z = get(player, "getZ"),
                    accessLevel = get(player, "getAccessLevel"),
                    isAlive = get(player, "isAlive")
                }

                -- stats:get(CharacterStat.X), not named getters. See
                -- statGet() above getPlayerDetails for why.
                if stats then
                    pd.hunger = statGet(stats, "HUNGER")
                    pd.thirst = statGet(stats, "THIRST")
                    pd.fatigue = statGet(stats, "FATIGUE")
                end

                if bodyDamage then
                    pd.health = get(bodyDamage, "getOverallBodyHealth")
                    pd.isInfected = get(bodyDamage, "IsInfected")
                end

                return pd
            end)

            if ok and playerData then
                table.insert(players, playerData)
            else
                -- Include minimal info so the player isn't silently dropped
                local nameOk, name = pcall(function() return player:getUsername() end)
                table.insert(players, {
                    username = nameOk and name or "unknown",
                    error = tostring(playerData)
                })
            end
        end
    end

    return true, { players = players }
end

-- ============================================
-- COMPREHENSIVE PLAYER EXPORT (for backup/restore)
-- ============================================

-- Helper to serialize inventory items
local function serializeInventory(container, depth, maxItems, currentCount)
    depth = depth or 1
    maxItems = maxItems or 1000
    currentCount = currentCount or { n = 0 }

    if not container then return {}, "container is nil" end
    if depth > 4 then return {}, "max depth exceeded" end

    local items = {}

    -- B42: try getItems() first, then fall back to other methods
    local itemList = nil
    local method = "none"

    itemList = PanelBridge.tryGet(container, "getItems")
    if itemList then method = "getItems" end

    -- B42 fallback: some containers use getAllItems() or Items
    if not itemList and container.getAllItems then
        local ok, result = pcall(function() return container:getAllItems() end)
        if ok and result then
            itemList = result
            method = "getAllItems"
        end
    end

    if not itemList then return {}, "no items method (tried: getItems, getAllItems)" end

    local sizeOk, listSize = pcall(function() return itemList:size() end)
    if not sizeOk or type(listSize) ~= "number" then
        return {}, method .. " size() failed"
    end

    if listSize == 0 then return {}, method .. " returned size 0" end

    for i = 0, listSize - 1 do
        if currentCount.n >= maxItems then break end
        local item = itemList:get(i)
        if item then
            local ok, itemData = pcall(function()
                local data = {
                    fullType = item:getFullType(),
                    type = item:getType(),
                    name = item:getName(),
                    count = PanelBridge.safeGet(item, "getCount", 1),
                    isFavorite = PanelBridge.safeGet(item, "isFavorite", false),
                    isEquipped = PanelBridge.safeGet(item, "isEquipped", false)
                }

                data.condition = PanelBridge.tryGet(item, "getCondition")
                data.uses = PanelBridge.tryGet(item, "getCurrentUses")

                -- Handle containers (bags, etc.)
                if PanelBridge.tryGet(item, "IsInventoryContainer") then
                    local subContainer = item:getItemContainer()
                    if subContainer then
                        data.contents = serializeInventory(subContainer, depth + 1, maxItems, currentCount)
                    end
                end

                -- getDelta() does not exist on InventoryItem -- confirmed
                -- 2026-08-23 against the real shipped projectzomboid.jar --
                -- so this has always been nil. There is no single replacement:
                -- the jar declares two distinct real floats instead, getJobDelta
                -- (progress on a job left in the item, e.g. a partly-read book)
                -- and getUseDelta (remaining fraction on a drainable item, e.g.
                -- a lighter or propane tank) -- exporting both, additively,
                -- rather than guessing which one "delta" meant. data.delta
                -- itself is left as-is (still always nil) since fixing it would
                -- mean picking one of the two and silently dropping the other.
                data.jobDelta = PanelBridge.tryGet(item, "getJobDelta")
                data.useDelta = PanelBridge.tryGet(item, "getUseDelta")
                data.delta = PanelBridge.tryGet(item, "getDelta")

                return data
            end)

            if ok and itemData then
                table.insert(items, itemData)
                currentCount.n = currentCount.n + 1
            end
        end
    end

    return items
end

-- Helper to get all perk levels
-- Every call below used to be bare -- a throw from ANY of them (getXp,
-- getPerkLevel, xp:getXP) took the whole export down with it, including
-- traits/wornItems/inventory, which already degrade gracefully on their own.
-- pcall-per-perk here so one bad perk (or a bad getXp()/getPerkLevel on a
-- future build) doesn't cost the others -- same fix already applied to
-- getPlayerDetails/getAllPlayerDetails/getServerInfo tonight, just not yet
-- to this handler.
local function getPlayerPerks(player)
    local perks = {}

    local xpOk, xp = pcall(function() return player:getXp() end)
    if not xpOk or not xp then return perks, "player:getXp() failed or returned nil" end

    -- Known perks from PerkFactory
    local perkNames = {
        "Fitness", "Strength",
        "Sprinting", "Lightfoot", "Nimble", "Sneak",
        "Axe", "Blunt", "SmallBlunt", "LongBlade", "ShortBlade", "Spear", "Maintenance",
        "Woodwork", "Cooking", "Farming", "Doctor", "Electricity", "MetalWelding",
        "Mechanics", "Tailoring", "Aiming", "Reloading",
        "Fishing", "Trapping", "PlantScavenging"
    }

    local failures = 0
    for _, perkName in ipairs(perkNames) do
        -- Guards the TABLE INDEX itself, not just the method calls after
        -- it -- Perks[perkName] is a bare Lua table index, not something
        -- PanelBridge.invoke's pcall would catch if Perks itself were ever
        -- absent on some future build (same shape as statGet's
        -- CharacterStat guard above, 2026-08-30). An absent Perks used to
        -- throw uncaught here, crashing the ENTIRE exportPlayerData --
        -- losing traits/wornItems/inventory too -- directly contradicting
        -- this handler's own per-field pcall protection everywhere else.
        local perkOk, perk = pcall(function() return Perks[perkName] end)
        if not perkOk then
            failures = failures + 1
        elseif perk then
            local ok, level, perkXp = pcall(function()
                return player:getPerkLevel(perk), xp:getXP(perk)
            end)
            if ok then
                perks[perkName] = {
                    level = level,
                    xp = perkXp
                }
            else
                failures = failures + 1
            end
        end
    end

    if failures > 0 then return perks, failures .. " perk(s) failed to read" end
    return perks, "ok"
end

-- Helper to get player traits
local function getPlayerTraits(player)
    local traits = {}
    local traitList = nil
    local method = "none"

    -- B42 real path, verified 2026-08-23 by reading the constant pool of the
    -- shipped projectzomboid.jar directly (no javap/decompiler available, so
    -- each class file's method table was parsed by hand):
    --   zombie/characters/IsoGameCharacter.class declares
    --     getCharacterTraits() -> Lzombie/characters/traits/CharacterTraits;
    --   zombie/characters/traits/CharacterTraits.class declares
    --     getKnownTraits() -> Ljava/util/List;  (also get/set/add/remove take
    --     a single CharacterTrait, and getTraits() -> Map -- not list-shaped)
    --   zombie/scripting/objects/CharacterTrait.class has getName()/toString()
    --   but no getType() -- the existing per-item fallback below already
    --   tries getType() then toString(), so toString() (which returns the
    --   trait's script id) covers this without any change there.
    -- The three attempts that used to run here (desc:getTraitList,
    -- desc:getTraits, player:getTraits) were all confirmed absent from B42's
    -- real class hierarchy by a separate full-jar audit against every
    -- (receiver, method) pair this file calls (2026-08-23) -- kept below as
    -- harmless fallbacks in case this ever runs against a B41 server, since
    -- player:getTraits() was B41's real API, but they must never be tried
    -- FIRST on B42 again.
    local charTraits = PanelBridge.tryGet(player, "getCharacterTraits")
    if charTraits then
        traitList = PanelBridge.tryGet(charTraits, "getKnownTraits")
        if traitList then method = "player:getCharacterTraits():getKnownTraits" end
    end

    -- B42: Traits are accessed through SurvivorDesc
    local desc = PanelBridge.tryGet(player, "getDescriptor")

    if desc then
        -- B42 primary: getTraitList()
        if not traitList then
            traitList = PanelBridge.tryGet(desc, "getTraitList")
            if traitList then method = "desc:getTraitList" end
        end
        -- B42 alt: getTraits()
        if not traitList then
            traitList = PanelBridge.tryGet(desc, "getTraits")
            if traitList then method = "desc:getTraits" end
        end
    end

    -- B41 fallback: player:getTraits()
    if not traitList then
        traitList = PanelBridge.tryGet(player, "getTraits")
        if traitList then method = "player:getTraits" end
    end

    if not traitList then return {}, "no trait method worked (tried: player:getCharacterTraits():getKnownTraits, desc:getTraitList, desc:getTraits, player:getTraits)" end

    -- Get size safely
    local sizeOk, listSize = pcall(function() return traitList:size() end)
    if not sizeOk or type(listSize) ~= "number" then
        return {}, method .. " size() failed"
    end

    if listSize == 0 then return {}, method .. " returned size 0" end

    for i = 0, listSize - 1 do
        local ok, trait = pcall(function() return traitList:get(i) end)
        if ok and trait then
            if type(trait) == "string" then
                table.insert(traits, trait)
            else
                local typeOk, typeValue = PanelBridge.invoke(trait, "getType")
                if not typeOk then
                    typeOk, typeValue = PanelBridge.invoke(trait, "toString")
                end
                table.insert(traits, typeOk and typeValue or tostring(trait))
            end
        end
    end

    return traits, method .. " found " .. #traits
end

-- Helper to get known recipes. Same broad-pcall fix as getPlayerPerks above:
-- a throw from getKnownRecipes()/size()/get(i) used to take the whole export
-- down with it instead of just this field.
local function getKnownRecipes(player)
    local recipes = {}
    local listOk, recipeList = pcall(function() return player:getKnownRecipes() end)
    if not listOk or not recipeList then return recipes, "player:getKnownRecipes() failed or returned nil" end

    local sizeOk, listSize = pcall(function() return recipeList:size() end)
    if not sizeOk or type(listSize) ~= "number" then return recipes, "getKnownRecipes():size() failed" end

    for i = 0, listSize - 1 do
        local ok, recipe = pcall(function() return recipeList:get(i) end)
        if ok and recipe then table.insert(recipes, recipe) end
    end

    return recipes, #recipes .. " recipe(s) found"
end

-- Helper to get worn items
local function getWornItems(player)
    local worn = {}
    local wornItems = nil
    local method = "none"

    wornItems = PanelBridge.tryGet(player, "getWornItems")
    if wornItems then method = "getWornItems" end

    if not wornItems then return {}, "getWornItems returned nil or failed" end

    local sizeOk, listSize = pcall(function() return wornItems:size() end)
    if not sizeOk or type(listSize) ~= "number" then
        return {}, method .. " size() failed"
    end

    if listSize == 0 then return {}, method .. " returned size 0" end

    for i = 0, listSize - 1 do
        local ok, wornData = pcall(function()
            local item = wornItems:get(i)
            if item and item:getItem() then
                return {
                    location = item:getLocation(),
                    fullType = item:getItem():getFullType(),
                    condition = item:getItem():getCondition()
                }
            end
            return nil
        end)
        if ok and wornData then
            table.insert(worn, wornData)
        end
    end

    return worn, method .. " found " .. #worn
end

-- Comprehensive player export for backup/restore
handlers.exportPlayerData = function(args)
    local username = args.username
    if not username then
        return false, nil, "Username required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    -- Collect diagnostics
    local diag = {}

    -- Traits
    local traits, traitDiag = getPlayerTraits(player)
    diag.traits = traitDiag or "ok"

    -- Worn items
    local wornItems, wornDiag = getWornItems(player)
    diag.wornItems = wornDiag or "ok"

    -- Main inventory
    local mainInv = nil
    local invDiag = "not attempted"
    local playerInventory = PanelBridge.tryGet(player, "getInventory")
    if playerInventory then
        mainInv, invDiag = serializeInventory(playerInventory)
    else
        invDiag = "getInventory() failed or returned nil"
    end
    diag.inventory = invDiag

    -- Also try to get items from worn containers (backpacks, bags on body)
    local bagItems = {}
    local bagCount = 0
    if wornItems then
        for _, worn in ipairs(type(wornItems) == "table" and wornItems or {}) do
            if worn.fullType then
                -- Try to get this worn item's container
                local ok, wornObj = pcall(function()
                    local wi = player:getWornItems()
                    if wi then
                        for j = 0, wi:size() - 1 do
                            local w = wi:get(j)
                            if w and w:getItem() and w:getItem():getFullType() == worn.fullType then
                                if w:getItem().getItemContainer then
                                    local subContainer = w:getItem():getItemContainer()
                                    if subContainer then
                                        local subItems = serializeInventory(subContainer)
                                        if #subItems > 0 then
                                            -- 2026-08-30, total-audit batch 3, item 3:
                                            -- worn.location is item:getLocation()'s raw
                                            -- return value (a Java object), used here
                                            -- un-normalized as a Lua table key. Lua table
                                            -- keys compare by reference for non-primitive
                                            -- values, and json.encode's tostring(key) only
                                            -- runs at final serialization -- AFTER this
                                            -- grouping decision has already been made -- so
                                            -- it can't fix a key that never merged/compared
                                            -- the way a stable string would have.
                                            -- tostring() here, before the key is used, so
                                            -- the same conceptual location always produces
                                            -- the same key.
                                            local locationKey = worn.location and tostring(worn.location) or worn.fullType
                                            bagItems[locationKey] = subItems
                                            bagCount = bagCount + #subItems
                                        end
                                    end
                                end
                            end
                        end
                    end
                end)
            end
        end
    end
    diag.bagItems = bagCount .. " items in " .. (function() local c = 0; for _ in pairs(bagItems) do c = c + 1 end; return c end)() .. " bags"

    -- Perks/recipes/kills all go through tryGet/pcall (see getPlayerPerks and
    -- getKnownRecipes above) so a throw from any one of them degrades just
    -- that field instead of losing the whole export -- same granularity as
    -- traits/wornItems/inventory above, which already worked this way.
    local perks, perksDiag = getPlayerPerks(player)
    diag.perks = perksDiag

    local recipes, recipesDiag = getKnownRecipes(player)
    diag.recipes = recipesDiag

    local exportData = {
        version = "1.3",
        exportTime = getTimestampMs(),
        serverName = getServerName(),

        -- Basic info
        username = PanelBridge.tryGet(player, "getUsername"),
        displayName = PanelBridge.tryGet(player, "getDisplayName"),

        -- Skills/Perks with XP (this is what we need for restore)
        perks = perks,

        -- Traits
        traits = traits,

        -- Known recipes
        recipes = recipes,

        -- Worn items
        wornItems = wornItems,

        -- Kill stats
        kills = {
            zombies = PanelBridge.tryGet(player, "getZombieKills")
        },

        -- Main inventory
        inventory = mainInv or {},

        -- Items in worn bags/containers
        bagInventory = bagItems,

        -- Diagnostics for debugging
        _diagnostics = diag
    }

    return true, exportData
end

-- Import/restore player data (skills and inventory)
handlers.importPlayerData = function(args)
    local username = args.username
    local data = args.data
    local options = args.options or {}

    if not username then
        return false, nil, "Username required"
    end
    if not data then
        return false, nil, "Import data required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local restored = {
        perks = 0,
        items = 0
    }

    -- Restore perks/skills. getXp() was a bare call here -- a throw would
    -- have taken the whole handler down with it, including the inventory
    -- restore below, which is logically independent (gated on its own
    -- data.inventory check).
    if data.perks and options.restorePerks ~= false then
        local xp = PanelBridge.tryGet(player, "getXp")
        for perkName, perkData in pairs(data.perks) do
            -- Guards the TABLE INDEX itself -- Perks[perkName] is a bare Lua
            -- table index, not covered by the per-perk pcall below (which
            -- only starts after this line). Same shape as the already-fixed
            -- bare getXp() call above: an absent Perks would otherwise
            -- crash the ENTIRE handler, aborting the inventory restore
            -- below too even though it's logically independent (gated on
            -- its own data.inventory check).
            local perkOk, perk = pcall(function() return Perks[perkName] end)
            if perkOk and perk and perkData.level then
                -- Use pcall for safety
                pcall(function()
                    -- Reset perk to 0 first
                    player:level0(perk)
                    -- Level up to target. Use LevelPerk(perk, false) -- the
                    -- removePick=false overload -- so restoring a saved
                    -- level doesn't silently consume the player's real
                    -- unspent skill points (the single-arg LevelPerk(perk)
                    -- removes a skill point per call per B42 JavaDocs:
                    -- https://demiurgequantified.github.io/ProjectZomboidJavaDocs/zombie/characters/IsoGameCharacter.html#LevelPerk(zombie.characters.skills.PerkFactory.Perk)
                    -- vs the 2-arg overload used for automatic/passive
                    -- level-ups that shouldn't cost a point).
                    for lvl = 1, perkData.level do
                        player:LevelPerk(perk, false)
                    end
                    -- Count the restore here, once the real, provable action
                    -- (the level change above) has genuinely landed -- NOT
                    -- after the XP step below, which used to be the LAST
                    -- statement in this pcall. xp:setXP(perk, value) does
                    -- not exist anywhere in the confirmed API (Kevin's jar
                    -- audit, 2026-08-30), so every throw there used to
                    -- silently undercount restored.perks even though the
                    -- level change had already happened for real.
                    restored.perks = restored.perks + 1

                    -- Set within-level XP to the target level's own
                    -- threshold. xp:setXP(perk, exactValue) is absent
                    -- (above); restoring the EXACT saved within-level XP is
                    -- not provably expressible with the confirmed API either
                    -- -- the alternative (read getXP(perk), then
                    -- AddXPNoMultiplier(perk, delta)) could not be ruled out
                    -- to clamp, round, or trigger level-boundary side
                    -- effects without decompiling. Operator ruling,
                    -- 2026-08-30: an unprovable method that could silently
                    -- corrupt real player progression is strictly worse than
                    -- a provable one that loses part of one level's
                    -- progress -- and this is not a downgrade from what
                    -- already happens: level0()/LevelPerk() above already
                    -- run and land; this makes the XP side of that exact,
                    -- provable, and no longer able to undercount a perk that
                    -- DID restore. Wrapped in its OWN pcall, separate from
                    -- the count above, so a setXPToLevel failure cannot
                    -- un-count a level change that genuinely already
                    -- happened.
                    if xp then
                        pcall(function() xp:setXPToLevel(perk, perkData.level) end)
                    end
                end)
            end
        end
    end

    -- Restore inventory items
    if data.inventory and options.restoreInventory ~= false then
        local inventory = player:getInventory()
        if inventory then
            local MAX_DEPTH = 3
            local MAX_ITEMS = 500
            local totalAdded = 0
            -- Helper function to add items recursively with depth limit
            local function addItems(container, itemList, depth)
                if depth > MAX_DEPTH then return end
                if type(itemList) ~= "table" then return end
                for _, itemData in ipairs(itemList) do
                    if totalAdded >= MAX_ITEMS then break end
                    if type(itemData) ~= "table" or not itemData.fullType then
                        -- skip malformed entries
                    else
                        local ok, result = pcall(function()
                            local count = math.min(itemData.count or 1, 100) -- Clamp to prevent server freeze
                            for c = 1, count do
                                if totalAdded >= MAX_ITEMS then break end
                                local newItem = container:AddItem(itemData.fullType)
                                if newItem then
                                    -- Set condition if available
                                    if itemData.condition and newItem.setCondition then
                                        newItem:setCondition(itemData.condition)
                                    end
                                    -- Set uses if available (for drainable items)
                                    if itemData.uses and newItem.setCurrentUses then
                                        newItem:setCurrentUses(itemData.uses)
                                    end
                                    -- setDelta() does not exist either (same jar check as the
                                    -- export side, see serializeInventory) -- restore the two
                                    -- real fields a newer export may carry instead.
                                    if itemData.jobDelta and newItem.setJobDelta then
                                        newItem:setJobDelta(itemData.jobDelta)
                                    end
                                    if itemData.useDelta and newItem.setUseDelta then
                                        newItem:setUseDelta(itemData.useDelta)
                                    end
                                    -- Set delta if available
                                    if itemData.delta and newItem.setDelta then
                                        newItem:setDelta(itemData.delta)
                                    end
                                    -- Handle container contents (bags) with depth limit
                                    if itemData.contents and type(itemData.contents) == "table" and newItem.getItemContainer then
                                        local subContainer = newItem:getItemContainer()
                                        if subContainer then
                                            addItems(subContainer, itemData.contents, depth + 1)
                                        end
                                    end
                                    totalAdded = totalAdded + 1
                                    restored.items = restored.items + 1
                                end
                            end
                        end)
                        -- Silently skip items that fail to add
                    end
                end
            end

            addItems(inventory, data.inventory, 1)

            -- Network sync
            pcall(function()
                if sendPlayerExtraInfo then sendPlayerExtraInfo(player) end
            end)
        end
    end

    return true, {
        message = "Player data imported",
        restored = restored
    }
end

-- Teleport a player (hybrid: server position + client command for network sync)
handlers.teleportPlayer = function(args)
    local username = args.username
    local x = tonumber(args.x)
    local y = tonumber(args.y)
    local z = tonumber(args.z) or 0

    if not username or not x or not y then
        return false, nil, "Username, x, y required"
    end

    -- Validate coordinates (B42 vanilla map extends past 16800; cap generously for modded maps)
    if x < 0 or x > 24000 or y < 0 or y > 24000 then
        return false, nil, "Coordinates out of range (x/y: 0-24000)"
    end
    z = math.max(0, math.min(math.floor(z), 8))

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local oldX = player:getX()
    local oldY = player:getY()
    local oldZ = player:getZ()
    local debugInfo = {}

    -- Step 0a: If the player is in a vehicle, exit first — teleportTo silently
    -- fails when the occupant is bound to a vehicle seat.
    pcall(function()
        local v = PanelBridge.tryGet(player, "getVehicle")
        if v then
            if PanelBridge.invoke(v, "exit", player) then
                table.insert(debugInfo, "vehicle exit")
            end
        end
    end)

    -- Step 0b: Cancel any in-progress timed actions so PZ does not snap the
    -- player back after teleport.
    pcall(function()
        if ISTimedActionQueue and ISTimedActionQueue.clear then
            ISTimedActionQueue.clear(player)
            table.insert(debugInfo, "timedActionQueue cleared")
        end
    end)

    -- Step 0c: setNetworkTeleportEnabled does not exist anywhere in the real
    -- B42 IsoPlayer/IsoGameCharacter hierarchy -- confirmed 2026-08-23 by
    -- grepping the shipped projectzomboid.jar for the string "NetworkTeleport"
    -- across every .class file (zero hits) and separately reading every
    -- teleport-related method in IsoGameCharacter (only the teleportTo
    -- overloads exist). This call has therefore always been a silent no-op
    -- on B42; a live v1.7.14 test against 42.20.0 independently observed the
    -- resulting symptom (server moved the player, no client was told, the
    -- client's own stale position won -- see that changelog entry above).
    -- There is no known direct replacement: teleportTo appears to be the
    -- only surviving teleport-related API, so whatever authorization/
    -- broadcast responsibility this flag used to carry either moved inside
    -- teleportTo itself in B42 or has no Lua-exposed equivalent at all.
    -- Left in place (harmless pcall, and the Step 6 probe below already
    -- reports its real absence at runtime) rather than guessed at.
    if PanelBridge.invoke(player, "setNetworkTeleportEnabled", true) then
        table.insert(debugInfo, "networkTeleportEnabled(pre) set")
    end

    -- Step 1: Server-side position update via teleportTo (Java method)
    local okTeleport, teleportErr = PanelBridge.invoke(player, "teleportTo", x, y, z)
    if okTeleport then
        table.insert(debugInfo, "teleportTo called")
    else
        table.insert(debugInfo, "teleportTo unavailable: " .. tostring(teleportErr))
    end

    -- Step 1b: Hard-set XYZ as belt-and-braces — teleportTo alone does not
    -- always stick on B42 dedicated servers.
    local forcedX = PanelBridge.invoke(player, "setX", x)
    local forcedY = PanelBridge.invoke(player, "setY", y)
    local forcedZ = PanelBridge.invoke(player, "setZ", z)
    if forcedX or forcedY or forcedZ then
        table.insert(debugInfo, "setXYZ forced")
    end

    -- Step 2: Update last-known position for network consistency
    if PanelBridge.invoke(player, "setLx", x) then
        PanelBridge.invoke(player, "setLy", y)
        PanelBridge.invoke(player, "setLz", z)
        table.insert(debugInfo, "setLxyz done")
    end

    -- Step 3: same call as Step 0c, same verified-absent method (see comment
    -- there) -- kept only in case a future PZ build re-adds it.
    if PanelBridge.invoke(player, "setNetworkTeleportEnabled", true) then
        table.insert(debugInfo, "networkTeleportEnabled(post) set")
    end

    -- Step 4: Force position broadcast via sendPlayerExtraInfo (global, server-side).
    -- PanelBridge has no client-side mod, so sendServerCommand to a custom module
    -- would be a silent no-op. sendPlayerExtraInfo is the one broadcast mechanism
    -- here actually confirmed to exist -- setNetworkTeleportEnabled above does not
    -- (see Step 0c) and contributes nothing to sync today.
    pcall(function()
        if sendPlayerExtraInfo then
            sendPlayerExtraInfo(player)
            table.insert(debugInfo, "sendPlayerExtraInfo pushed")
        end
    end)

    -- Step 5: Verify position after teleport
    local verifyX = player:getX()
    local verifyY = player:getY()
    local verifyZ = player:getZ()
    table.insert(debugInfo, "verify pos: " .. verifyX .. "," .. verifyY .. "," .. verifyZ)

    -- Step 6: Record which sync APIs this build actually exposes. Everything
    -- above is wrapped in pcall, so a missing method looks identical to a
    -- successful one in the result; without this the reason a teleport does
    -- not reach the client is invisible.
    pcall(function()
        local probe = {}
        for _, name in ipairs({
            "setNetworkTeleportEnabled", "setLx", "setPosition", "teleportTo",
            "setForceUpdate", "sendObjectChange", "getOnlineID",
        }) do
            if player[name] then table.insert(probe, name) end
        end
        for _, name in ipairs({
            "sendPlayerExtraInfo", "syncPlayerFields", "NetworkTeleport",
            "sendServerCommand", "getPlayerInfo", "updatePlayerPosition",
        }) do
            if _G[name] then table.insert(probe, "_G." .. name) end
        end
        table.insert(debugInfo, "available: " .. table.concat(probe, ","))
    end)

    local debugStr = table.concat(debugInfo, " | ")
    PanelBridge.debug("teleportPlayer: " .. username .. " from " .. oldX .. "," .. oldY .. "," .. oldZ
        .. " to " .. x .. "," .. y .. "," .. z .. " — " .. debugStr)

    -- Verify the teleport actually happened. The real failure mode here is
    -- not "landed slightly off target" -- ground snap, z-level resolution
    -- and tile centring can all legitimately shift the final position by a
    -- tile or more, and gating on proximity to the target would manufacture
    -- false failures for those. The failure this file's own comments and
    -- changelog describe is teleportTo silently not sticking AT ALL: the
    -- player still sitting at their ORIGIN while the response claims they
    -- moved hundreds or thousands of tiles. So this compares distance
    -- ACTUALLY moved against distance REQUESTED, not proximity to the
    -- target -- no "how close counts as arrived" number needed.
    -- EPSILON is a floating-point/rounding tolerance (sub-tile), not a
    -- guess about game mechanics -- small enough that a genuine
    -- single-floor (z-only) teleport still registers as a real move.
    local EPSILON = 0.5
    local function dist3(ax, ay, az, bx, by, bz)
        return math.sqrt((ax - bx) ^ 2 + (ay - by) ^ 2 + (az - bz) ^ 2)
    end
    local requestedDistance = dist3(oldX, oldY, oldZ, x, y, z)
    local actualDistance = dist3(oldX, oldY, oldZ, verifyX, verifyY, verifyZ)

    local verified
    if requestedDistance <= EPSILON then
        -- Origin and target are too close together to tell "stayed put"
        -- from "arrived" apart -- report unverified rather than guess.
        verified = nil
    elseif actualDistance <= EPSILON then
        -- Asked to move a meaningful distance; the position barely changed
        -- at all. This is the silent-no-op failure, not a rounding blip.
        verified = false
    else
        verified = true
    end

    if verified == false then
        return false, {
            oldPosition = { x = oldX, y = oldY, z = oldZ },
            newPosition = { x = x, y = y, z = z },
            verifyPosition = { x = verifyX, y = verifyY, z = verifyZ },
            debug = debugStr
        }, "Teleport call succeeded but the player did not move (still at origin)"
    end

    -- verified is a STRING, always present -- never a boolean, never
    -- omitted. See PanelBridge.verifiedResult's own comment for why an
    -- absent key is a distinct, meaningful signal (an out-of-date bridge
    -- mod) that must not be confused with "unverifiable".
    local verifiedStr = "unverifiable"
    if verified == true then verifiedStr = "confirmed" end

    return true, {
        message = "Player teleported",
        oldPosition = { x = oldX, y = oldY, z = oldZ },
        newPosition = { x = x, y = y, z = z },
        verifyPosition = { x = verifyX, y = verifyY, z = verifyZ },
        verified = verifiedStr,
        debug = debugStr
    }
end

-- Get sandbox options (read-only)
-- Used to read back 11 hand-picked getters (getZombieCount, getZombieSpeed,
-- getDayLength, getStartMonth, getStartDay, getWaterShutoff, getElecShutoff,
-- getZombieLore, getCharactersPerPlayer, getSleepAllowed, getSleepNeeded) --
-- NONE of which exist anywhere on SandboxOptions in the real B42 jar
-- (Kevin's audit, 2026-08-30). Each was wrapped in its own pcall, so every
-- single failure was swallowed silently and `options` stayed `{}` -- this
-- reported a clean `true, { options = {} }` success, with nothing in it, on
-- every call.
-- 2026-08-30 operator ruling: this handler has an api.ts wrapper but ZERO UI
-- callers, so there is no flat-shape compatibility to preserve -- match
-- getAllSandboxOptions' shape instead of hand-picking a second, narrower
-- (and, it turns out, entirely broken) enumeration. That handler's primary
-- path (getNumOptions()+getOptionByIndex(i), both jar-confirmed real on the
-- same sandbox object) already reads every field this handler would need,
-- so this is now a thin delegate rather than a second implementation that
-- could drift out of sync with it.
handlers.getSandboxOptions = function(args)
    return handlers.getAllSandboxOptions(args)
end

-- Get ALL sandbox options including mod-added ones, grouped by source
handlers.getAllSandboxOptions = function(args)
    local sandbox = getSandboxOptions()
    if not sandbox then
        return false, nil, "SandboxOptions not available"
    end

    local allOptions = {}
    local totalCount = 0

    -- Helper to extract value from a sandbox option object
    local function getOptionValue(opt)
        local raw = nil
        -- Try getValue first (most common)
        raw = PanelBridge.tryGet(opt, "getValue")
        -- Try getIntValue for integer enums
        if raw == nil then
            raw = PanelBridge.tryGet(opt, "getIntValue")
        end
        -- Try direct value field
        if raw == nil and opt.value ~= nil then raw = opt.value end
        -- Ensure the value is JSON-serializable (not userdata/Java object)
        if raw == nil then return nil end
        local t = type(raw)
        if t == "string" or t == "number" or t == "boolean" then return raw end
        -- Userdata or table — coerce to string for safety
        local ok2, str = pcall(tostring, raw)
        return ok2 and str or nil
    end

    -- Helper to safely coerce a value to string, returning nil if the value is nil
    local function safeStr(fn)
        local ok, val = pcall(fn)
        if ok and val ~= nil then return tostring(val) end
        return nil
    end

    -- Helper to extract option metadata
    local function getOptionInfo(opt)
        local info = {}
        -- Get the option name (e.g., "MyMod.SettingName")
        info.name = safeStr(function() return opt:getName() end)
        -- Get the short name (just "SettingName")
        info.shortName = safeStr(function() return opt:getShortName() end)
        -- Get the table/page name (mod or category grouping)
        info.tableName = safeStr(function() return opt:getTableName() end)
        -- Get the tooltip/translation key
        info.tooltip = safeStr(function() return opt:getTooltip() end)
        -- Try to resolve tooltip via PZ translation (getText returns the translated string)
        if info.tooltip then
            pcall(function()
                local translated = getText(info.tooltip)
                if translated and translated ~= info.tooltip and translated ~= "" then
                    info.tooltipText = translated
                end
            end)
            -- If getText didn't work, check if tooltip already contains plain text (not a key)
            if not info.tooltipText and info.tooltip:find(" ") then
                info.tooltipText = info.tooltip
            end
        end
        -- Get the translated name if available
        info.translatedName = safeStr(function() return opt:getTranslatedName() end)
        -- Try getPageName for sub-category
        info.pageName = safeStr(function() return opt:getPageName() end)
        -- Get value
        info.value = getOptionValue(opt)
        -- Get type info
        pcall(function()
            if not opt.getClass then return end
            local classObj = opt:getClass()
            if not classObj then return end
            local className = tostring(classObj)
            if className:find("Boolean") then
                info.type = "boolean"
            elseif className:find("Double") or className:find("Integer") or className:find("Numeric") then
                info.type = "number"
            elseif className:find("Enum") then
                info.type = "enum"
                -- Try to get enum values. 2026-08-30, total-audit batch 3,
                -- item 4: this used to gate on `opt.getNumValues and
                -- opt.getValueName` (a field-test on a Java object -- the
                -- same anti-pattern this file bans elsewhere, e.g. world
                -- .saveWorld) and call opt:getValueName(i), a method that
                -- does not exist anywhere in the real jar's SandboxOption/
                -- ConfigOption hierarchy (confirmed by parsing
                -- EnumSandboxOption/StrongEnumSandboxOption/EnumConfigOption/
                -- ConfigOption's own class files) -- the real method is
                -- getValueTranslationByIndexOrNull. Either the field-test
                -- never fired (most likely, per this file's own established
                -- lesson about field-tests on Java objects) or the per-index
                -- pcall silently swallowed the throw every time -- either
                -- way, every enum sandbox option's enumValues came back
                -- empty or absent, always, with no error surfaced.
                pcall(function()
                    local numVals = tonumber(PanelBridge.tryGet(opt, "getNumValues"))
                    if numVals and numVals > 0 then
                        info.enumValues = {}
                        local cap = math.min(numVals, 50)
                        for i = 0, cap - 1 do
                            local translated = PanelBridge.tryGet(opt, "getValueTranslationByIndexOrNull", i)
                            if translated ~= nil then
                                table.insert(info.enumValues, tostring(translated))
                            end
                        end
                    end
                end)
                -- Get selected index for enums. getIntValue() does not exist
                -- anywhere in the SandboxOption/ConfigOption hierarchy, so this
                -- was always nil for every enum option -- verified 2026-08-23
                -- against the real shipped projectzomboid.jar: EnumSandboxOption
                -- extends EnumConfigOption extends IntegerConfigOption, and it is
                -- IntegerConfigOption that actually declares getValue() -> int
                -- (the enum's raw selected index; a plain int field under the
                -- hood). getOptionValue() above already calls plain getValue()
                -- first and works for enums today for exactly this reason --
                -- this line just needed to call the same real method.
                info.selectedIndex = PanelBridge.tryGet(opt, "getValue")
            elseif className:find("String") then
                info.type = "string"
            else
                info.type = className
            end
        end)
        -- Get min/max for numeric types
        local minValue = PanelBridge.tryGet(opt, "getMin")
        if type(minValue) == "number" then info.min = minValue end
        local maxValue = PanelBridge.tryGet(opt, "getMax")
        if type(maxValue) == "number" then info.max = maxValue end
        -- Get default value
        local defaultValue = PanelBridge.tryGet(opt, "getDefaultValue")
        if defaultValue ~= nil then
            local t = type(defaultValue)
            if t == "string" or t == "number" or t == "boolean" then
                info.default = defaultValue
            else
                local ok2, str = pcall(tostring, defaultValue)
                if ok2 then info.default = str end
            end
        end
        return info
    end

    -- Method 1: Try getNumOptions + getOptionByIndex (Java ArrayList-style)
    local enumerated = false
    pcall(function()
        local numOptions = sandbox:getNumOptions()
        if numOptions and numOptions > 0 then
            for i = 0, numOptions - 1 do
                pcall(function()
                    local opt = sandbox:getOptionByIndex(i)
                    if opt then
                        local info = getOptionInfo(opt)
                        if info.name then
                            -- Group by table name (mod name or vanilla category)
                            local group = (info.tableName and info.tableName ~= "") and info.tableName or "Vanilla"
                            if not allOptions[group] then
                                allOptions[group] = {}
                            end
                            table.insert(allOptions[group], info)
                            totalCount = totalCount + 1
                        end
                    end
                end)
            end
            enumerated = true
        end
    end)

    -- Method 2: Try iterating the options ArrayList directly
    if not enumerated then
        pcall(function()
            local optionsList = sandbox:getOptions()
            if optionsList then
                local size = optionsList:size()
                for i = 0, size - 1 do
                    pcall(function()
                        local opt = optionsList:get(i)
                        if opt then
                            local info = getOptionInfo(opt)
                            if info.name then
                                local group = (info.tableName and info.tableName ~= "") and info.tableName or "Vanilla"
                                if not allOptions[group] then
                                    allOptions[group] = {}
                                end
                                table.insert(allOptions[group], info)
                                totalCount = totalCount + 1
                            end
                        end
                    end)
                end
                enumerated = true
            end
        end)
    end

    -- Method 3: Try pairs enumeration on the sandbox object itself
    if not enumerated then
        pcall(function()
            for k, v in pairs(sandbox) do
                if type(v) ~= "function" then
                    pcall(function()
                        -- Check if it's a sandbox option object with getName
                        if v and type(v) == "userdata" and v.getName then
                            local info = getOptionInfo(v)
                            if info.name then
                                local group = (info.tableName and info.tableName ~= "") and info.tableName or "Vanilla"
                                if not allOptions[group] then
                                    allOptions[group] = {}
                                end
                                table.insert(allOptions[group], info)
                                totalCount = totalCount + 1
                            end
                        else
                            -- Simple key-value — coerce value for JSON safety
                            local group = "Vanilla"
                            if tostring(k):find("%.") then
                                group = tostring(k):match("^([^%.]+)")
                            end
                            if not allOptions[group] then
                                allOptions[group] = {}
                            end
                            local safeVal = v
                            local vt = type(v)
                            if vt ~= "string" and vt ~= "number" and vt ~= "boolean" and v ~= nil then
                                local ok3, str3 = pcall(tostring, v)
                                safeVal = ok3 and str3 or nil
                            end
                            table.insert(allOptions[group], {
                                name = tostring(k),
                                value = safeVal,
                                type = type(v)
                            })
                            totalCount = totalCount + 1
                        end
                    end)
                end
            end
            if totalCount > 0 then enumerated = true end
        end)
    end

    -- Sort options within each group by name
    for group, opts in pairs(allOptions) do
        table.sort(opts, function(a, b)
            return (a.name or "") < (b.name or "")
        end)
    end

    -- Build group list with counts
    local groups = {}
    for group, opts in pairs(allOptions) do
        table.insert(groups, { name = group, count = #opts })
    end
    table.sort(groups, function(a, b) return a.name < b.name end)

    PanelBridge.info("Sandbox options enumerated", {
        totalOptions = totalCount,
        groups = #groups,
        enumerated = enumerated
    })

    return true, {
        options = allOptions,
        groups = groups,
        totalCount = totalCount,
        enumerated = enumerated
    }
end

-- Set a single sandbox option value
handlers.setSandboxOption = function(args)
    local optName = args and args.name
    local newValue = args and args.value
    if not optName or optName == "" then
        return false, nil, "Missing option name"
    end
    if newValue == nil then
        return false, nil, "Missing value"
    end

    local sandbox = getSandboxOptions()
    if not sandbox then
        return false, nil, "SandboxOptions not available"
    end

    -- Find the option by name
    local targetOpt = nil
    pcall(function()
        local numOptions = sandbox:getNumOptions()
        if numOptions and numOptions > 0 then
            for i = 0, numOptions - 1 do
                local opt = sandbox:getOptionByIndex(i)
                if opt and opt.getName then
                    local name = opt:getName()
                    if name == optName then
                        targetOpt = opt
                        return
                    end
                end
            end
        end
    end)

    -- Fallback: try getOptions():get()
    if not targetOpt then
        pcall(function()
            local optionsList = sandbox:getOptions()
            if optionsList then
                local size = optionsList:size()
                for i = 0, size - 1 do
                    local opt = optionsList:get(i)
                    if opt and opt.getName then
                        local name = opt:getName()
                        if name == optName then
                            targetOpt = opt
                            return
                        end
                    end
                end
            end
        end)
    end

    if not targetOpt then
        return false, nil, "Option not found: " .. tostring(optName)
    end

    -- Determine the option type and apply the value
    local optType = nil
    pcall(function()
        if not targetOpt.getClass then return end
        local className = tostring(targetOpt:getClass())
        if className:find("Boolean") then optType = "boolean"
        elseif className:find("Double") or className:find("Numeric") then optType = "double"
        elseif className:find("Integer") then optType = "integer"
        elseif className:find("Enum") then optType = "enum"
        elseif className:find("String") then optType = "string"
        end
    end)

    local ok, err
    local appliedValue
    if optType == "boolean" then
        local boolVal = (newValue == true or newValue == "true" or newValue == 1)
        appliedValue = boolVal
        ok, err = pcall(function() targetOpt:setValue(boolVal) end)
    elseif optType == "enum" then
        local intVal = tonumber(newValue)
        if not intVal then return false, nil, "Invalid enum value" end
        intVal = math.floor(intVal)
        -- Bounds-check against getNumValues if available
        local numVals = tonumber(PanelBridge.tryGet(targetOpt, "getNumValues"))
        if numVals and intVal >= numVals then intVal = numVals - 1 end
        if intVal < 0 then intVal = 0 end
        appliedValue = intVal
        ok, err = pcall(function() targetOpt:setValue(intVal) end)
    elseif optType == "integer" then
        local intVal = tonumber(newValue)
        if not intVal then return false, nil, "Invalid integer value" end
        intVal = math.floor(intVal)
        -- Clamp to min/max if the option exposes them
        local intMin = PanelBridge.tryGet(targetOpt, "getMin")
        if type(intMin) == "number" and intVal < intMin then intVal = intMin end
        local intMax = PanelBridge.tryGet(targetOpt, "getMax")
        if type(intMax) == "number" and intVal > intMax then intVal = intMax end
        appliedValue = intVal
        ok, err = pcall(function() targetOpt:setValue(intVal) end)
    elseif optType == "double" then
        local numVal = tonumber(newValue)
        if not numVal then return false, nil, "Invalid numeric value" end
        -- Clamp to min/max
        local numMin = PanelBridge.tryGet(targetOpt, "getMin")
        if type(numMin) == "number" and numVal < numMin then numVal = numMin end
        local numMax = PanelBridge.tryGet(targetOpt, "getMax")
        if type(numMax) == "number" and numVal > numMax then numVal = numMax end
        appliedValue = numVal
        ok, err = pcall(function() targetOpt:setValue(numVal) end)
    elseif optType == "string" then
        local strVal = tostring(newValue)
        appliedValue = strVal
        ok, err = pcall(function() targetOpt:setValue(strVal) end)
    else
        -- Unknown type — try generic setValue with the raw value. No
        -- reliable comparison exists for an unknown Java type crossing the
        -- Lua/JSON boundary, so appliedValue stays nil and this branch is
        -- intentionally excluded from the verify-and-gate below.
        ok, err = pcall(function() targetOpt:setValue(newValue) end)
    end

    if not ok then
        return false, nil, "Failed to set value: " .. tostring(err)
    end

    -- Read back the value to confirm
    local confirmed = PanelBridge.tryGet(targetOpt, "getValue")
    if confirmed ~= nil then
        local t = type(confirmed)
        if t ~= "string" and t ~= "number" and t ~= "boolean" then
            local ok2, str = pcall(tostring, confirmed)
            confirmed = ok2 and str or nil
        end
    end

    -- Compare on MEANING, not identity: a value crossing the Lua/JSON
    -- boundary can legitimately come back as a different Lua type than what
    -- was sent (8 vs "8") without the write having failed. `verified` is
    -- nil (not false) whenever the comparison itself isn't trustworthy -- an
    -- unknown optType or a nil confirmed read -- rather than treating
    -- "can't tell" as "it worked". Written with explicit if/then, not the
    -- `a and b or c` idiom: that idiom silently turns a confirmed mismatch
    -- (b == false) into nil (see setGodMode's comment for the full story).
    -- (This field used to be called `matched` -- renamed to `verified` per
    -- the 2026-08-23 ruling that unified every handler on one field name;
    -- nothing had shipped carrying either name, so the rename was free.)
    local verified
    if appliedValue == nil or confirmed == nil then
        verified = nil
    elseif optType == "boolean" then
        if type(confirmed) == "boolean" then
            verified = (confirmed == appliedValue)
        else
            verified = (tostring(confirmed):lower() == tostring(appliedValue):lower())
        end
    elseif optType == "enum" or optType == "integer" or optType == "double" then
        local confirmedNum = tonumber(confirmed)
        if confirmedNum == nil then
            verified = nil
        else
            verified = (confirmedNum == appliedValue)
        end
    elseif optType == "string" then
        verified = (tostring(confirmed) == tostring(appliedValue))
    end

    PanelBridge.info("Sandbox option set", { name = optName, value = tostring(newValue), confirmed = tostring(confirmed), verified = verified })

    if verified == false then
        return false, nil, "Value set but did not take effect (requested " .. tostring(appliedValue) .. ", confirmed " .. tostring(confirmed) .. ")"
    end

    -- setValue only touches the Java object. Mod code reads the global
    -- SandboxVars table, which stays stale until toLua() rebuilds it.
    PanelBridge.invoke(sandbox, "toLua")

    -- Trigger a world save so the changed option persists across restarts.
    -- saveGame() is a bare global -- same LuaManager$GlobalObject binding
    -- tier as getWorld()/getCell(), both already called elsewhere in this
    -- file with identical bare-call syntax -- NOT a method on `world`.
    -- world:saveWorld() does not exist anywhere in the jar (Kevin's audit,
    -- 2026-08-30). The old `world.saveWorld` field-existence guard was
    -- always false regardless of world's real state (a Java method can be
    -- callable while the field reads nil, this file's own recurring lesson),
    -- so every sandbox change reported a FALSE persistence failure ("World
    -- not available") on top of a write that had genuinely already
    -- succeeded. saveGame() returns void -- there is no return value to
    -- check, so success can only come from the bare call not throwing.
    local persisted = false
    local saveErr = nil
    local saveOk, saveErrMsg = pcall(function() saveGame() end)
    if saveOk then
        persisted = true
    else
        saveErr = tostring(saveErrMsg)
    end
    if not persisted then
        PanelBridge.error("Sandbox option set but world save failed", { name = optName, error = saveErr })
    end

    local verifiedStr = "unverifiable"
    if verified == true then verifiedStr = "confirmed" end

    return true, {
        name = optName,
        value = confirmed,
        type = optType,
        verified = verifiedStr,
        persisted = persisted,
        saveError = saveErr
    }
end

-- ============================================
-- CHAT SYSTEM HANDLERS
-- ============================================

-- Helper: resolve a Java class from either a Lua global or the full package path
local function resolveJavaClass(globalName, fullPath)
    -- Try direct global access (through metatable — Kahlua exposes Java classes this way)
    local ok1, g = pcall(function() return _G[globalName] end)
    if ok1 and g then return g end
    -- Walk the full Java package path (e.g. zombie.network.chat.ChatServer)
    -- pcall each step to avoid Java null indexing errors
    local parts = {}
    for part in fullPath:gmatch("[^%.]+") do parts[#parts + 1] = part end
    local cur
    local ok
    ok, cur = pcall(function() return _G[parts[1]] end)
    if not ok or not cur then return nil end
    for i = 2, #parts do
        local parent = cur
        ok, cur = pcall(function() return parent[parts[i]] end)
        if not ok or not cur then return nil end
    end
    return cur
end

-- Helper: get chat system components
-- ChatServer (zombie.network.chat.ChatServer) = SERVER-SIDE chat API
-- On B42 dedicated servers this class exists in Java but is NOT exposed to Lua.
-- The function returns nil in that case — chat then falls through to RCON on the backend.
local function getChatSystem()
    local result = {}
    -- Try multiple access patterns for ChatServer
    local ChatServerClass = resolveJavaClass("ChatServer", "zombie.network.chat.ChatServer")
    if not ChatServerClass then
        ChatServerClass = resolveJavaClass("ChatServer", "zombie.chat.ChatServer")
    end
    -- Try getChatServer global if PZ exposes it
    if not ChatServerClass then
        local ok, cs = pcall(function() return getChatServer end)
        if ok and cs and type(cs) == "function" then
            local ok2, inst = pcall(cs)
            if ok2 and inst then
                result.server = inst
                return result
            end
        end
    end
    if ChatServerClass then
        local inited = true
        if ChatServerClass.isInited then
            local ok, val = pcall(function() return ChatServerClass.isInited() end)
            if ok then inited = val end
        end
        if inited then
            local ok, inst = pcall(function() return ChatServerClass.getInstance() end)
            if ok and inst then
                result.server = inst
            end
        end
    end
    if result.server then return result end
    return nil
end

-- Send message to server chat (appears to all players)
handlers.sendToServerChat = function(args)
    local message = normalizeMessage(args.message, 1000)
    local isAlert = args.alert or args.isAlert or false

    if not message then
        return false, nil, "Message required"
    end

    local chat = getChatSystem()

    -- ChatServer: server-side native API (available on builds that expose it to Lua)
    if chat and chat.server then
        local ok, err = pcall(function()
            if isAlert then
                chat.server:sendServerAlertMessageToServerChat(message)
            else
                chat.server:sendMessageToServerChat(message)
            end
        end)
        if ok then
            return true, { message = "Message sent to server chat", isAlert = isAlert, method = "ChatServer" }
        end
        -- ChatServer exists but send failed — fall through to player:Say
    end

    -- Fallback: Say to each player (shows as overhead text only, not in chat window)
    local ok3, sent3 = pcall(function()
        local players = getOnlinePlayers()
        if players and players:size() > 0 then
            for i = 0, players:size() - 1 do
                local p = players:get(i)
                if p then p:Say(message) end
            end
            return true
        end
        return false
    end)
    if ok3 and sent3 then
        return true, { message = "Message sent via player:Say (overhead text only)", isAlert = isAlert, method = "player:Say" }
    end

    -- No ChatServer and no players online — tell backend to use RCON
    return false, nil, "useRCON"
end

-- Send message to admin chat (only admins see it)
handlers.sendToAdminChat = function(args)
    local message = normalizeMessage(args.message, 1000)

    if not message then
        return false, nil, "Message required"
    end

    local chat = getChatSystem()

    -- ChatServer: server-side native API
    if chat and chat.server then
        local ok, err = pcall(function()
            chat.server:sendMessageToAdminChat(message)
        end)
        if ok then
            return true, { message = "Message sent to admin chat", method = "ChatServer" }
        end
    end

    -- Fallback: Say to each admin player (overhead text only)
    local ok3, sent3 = pcall(function()
        local players = getOnlinePlayers()
        if players and players:size() > 0 then
            for i = 0, players:size() - 1 do
                local p = players:get(i)
                if p and p.accessLevel and p:getAccessLevel() ~= "" then
                    p:Say("[ADMIN] " .. message)
                end
            end
            return true
        end
        return false
    end)
    if ok3 and sent3 then
        return true, { message = "Message sent via player:Say (admin, overhead text only)", method = "player:Say" }
    end

    return false, nil, "useRCON"
end

-- Send message to general chat (with custom author name)
handlers.sendToGeneralChat = function(args)
    local message = normalizeMessage(args.message, 1000)
    local author = normalizeMessage(args.author, 80) or "[Panel]"
    -- Strip control chars / newlines from author to prevent chat-log spoofing
    if author then
        author = author:gsub("[%c]", " ")
        if author == "" then author = "[Panel]" end
    end

    if not message then
        return false, nil, "Message required"
    end

    local chat = getChatSystem()

    -- ChatServer: server-side native API
    if chat and chat.server then
        local ok, err = pcall(function()
            chat.server:sendMessageFromDiscordToGeneralChat(author, message)
        end)
        if ok then
            return true, { message = "Message sent to general chat", author = author, method = "ChatServer" }
        end
    end

    -- Fallback: Say to each player with author prefix (overhead text only)
    local ok3, sent3 = pcall(function()
        local players = getOnlinePlayers()
        if players and players:size() > 0 then
            for i = 0, players:size() - 1 do
                local p = players:get(i)
                if p then p:Say("[" .. author .. "] " .. message) end
            end
            return true
        end
        return false
    end)
    if ok3 and sent3 then
        return true, { message = "Message sent via player:Say (overhead text only)", author = author, method = "player:Say" }
    end

    return false, nil, "useRCON"
end

-- Get available chat types info
handlers.getChatInfo = function(args)
    local chat = getChatSystem()
    local info = {
        availableChats = {
            "serverChat - Messages from server to all players",
            "adminChat - Messages visible only to admins",
            "generalChat - General chat with custom author name"
        },
        note = "Chat handlers try native ChatServer API first, then player:Say, then signal backend to use RCON",
        chatServerAvailable = chat ~= nil and chat.server ~= nil,
        rconFallback = chat == nil or chat.server == nil
    }

    return true, info
end

-- Force save the world
handlers.saveWorld = function(args)
    -- saveGame() is a bare global (same LuaManager$GlobalObject binding tier
    -- as getWorld()/getCell()), NOT a method on `world` -- world:saveWorld()
    -- does not exist anywhere in the jar (Kevin's audit, 2026-08-30). The old
    -- `world.saveWorld` field-existence guard was always false, so this
    -- handler could never succeed regardless of the server's real state.
    -- saveGame() returns void -- there is no return value to check, so
    -- success can only come from the bare call not throwing.
    local success, err = pcall(function()
        saveGame()
    end)
    if success then
        return true, { message = "World save triggered" }
    else
        return false, nil, "World save failed: " .. tostring(err)
    end
end

-- ============================================
-- INFRASTRUCTURE (POWER/WATER) HANDLERS
-- ============================================

-- Get current power and water status
handlers.getUtilitiesStatus = function(args)
    local world = getWorld()
    if not world then
        return false, nil, "World not available"
    end

    local hydroPowerOn = false
    local success, err = pcall(function()
        hydroPowerOn = world:isHydroPowerOn()
    end)

    if not success then
        return false, nil, "Failed to get utilities status: " .. tostring(err)
    end

    -- Also get sandbox shutdown times
    local sandbox = getSandboxOptions()
    local elecShut = "unknown"
    local waterShut = "unknown"
    local elecModifier = 0
    local waterModifier = 0

    -- Read sandbox settings and game time for diagnostics
    local currentHour = 0
    local currentDay = 0
    local nightsSurvived = 0
    local timeSinceApo = 1
    -- Power: Use the same formula the game uses (ISButtonPrompt.lua line 421):
    --   if (ElecShutModifier > -1 AND worldAgeDays < ElecShutModifier) OR square:haveElectricity()
    -- isHydroPowerOn() is NOT used by the game's Lua gameplay code.
    local powerActuallyOn = false
    local waterActuallyOn = false

    pcall(function()
        if sandbox then
            local elecOpt = sandbox:getOptionByName("ElecShut")
            local waterOpt = sandbox:getOptionByName("WaterShut")
            if elecOpt and elecOpt.getValue then
                elecShut = tostring(elecOpt:getValue())
            end
            if waterOpt and waterOpt.getValue then
                waterShut = tostring(waterOpt:getValue())
            end
            elecModifier = sandbox:getElecShutModifier()
            waterModifier = sandbox:getWaterShutModifier()
            timeSinceApo = PanelBridge.tryGet(sandbox, "getTimeSinceApo") or timeSinceApo
        end

        local gameTime = GameTime.getInstance()
        if gameTime then
            currentHour = gameTime:getWorldAgeHours()
            currentDay = currentHour / 24
            nightsSurvived = gameTime:getNightsSurvived()
        end

        -- Water has no Java flag like isHydroPowerOn().
        -- Use the same formula as power (matches game's internal check).
        -- Modifier > -1 AND worldAgeDays < modifier = water still on
        local worldAgeDays = currentHour / 24 + (timeSinceApo - 1) * 30

        -- Power check: same formula as ISButtonPrompt.lua line 421
        if elecModifier > -1 and worldAgeDays < elecModifier then
            powerActuallyOn = true
        end

        -- Water check: same formula
        if waterModifier > -1 and worldAgeDays < waterModifier then
            waterActuallyOn = true
        end
    end)

    return true, {
        hydroPowerOn = hydroPowerOn,
        powerOn = powerActuallyOn,
        waterOn = waterActuallyOn,
        currentWorldHour = currentHour,
        currentWorldDay = currentDay,
        nightsSurvived = nightsSurvived,
        timeSinceApo = timeSinceApo,
        elecShut = elecShut,
        waterShut = waterShut,
        elecShutModifier = elecModifier,
        waterShutModifier = waterModifier
    }
end

-- Helper: set haveElectricity on all loaded squares around players
-- This directly forces IsoGridSquare.haveElectricity() to return the desired
-- value, which is what the game's power checks (ISButtonPrompt, ISVehicleMenu,
-- ISWorldObjectContextMenu) actually read.
local function setElectricityOnLoadedSquares(enabled)
    local cell = getCell()
    if not cell then
        return 0, "No cell available"
    end

    local players = getOnlinePlayers()
    if not players or players:size() == 0 then
        return 0, "No players online"
    end

    local squareCount = 0

    for p = 0, players:size() - 1 do
        local player = players:get(p)
        if player then
            local px, py = math.floor(player:getX()), math.floor(player:getY())

            -- 50-square radius covers the playable area around each player
            for x = px - 50, px + 50 do
                for y = py - 50, py + 50 do
                    for z = 0, 3 do
                        local sq = cell:getGridSquare(x, y, z)
                        if sq then
                            pcall(function()
                                sq:setHaveElectricity(enabled)
                            end)
                            squareCount = squareCount + 1
                        end
                    end
                end
            end
        end
    end

    return squareCount, "success"
end

function PanelBridge.reconcileStartupPower()
    local world = getWorld()
    local sandbox = getSandboxOptions()
    local gameTime = getGameTime()
    if not world or not sandbox or not gameTime then return false end

    local shutdownDay = tonumber(PanelBridge.tryGet(sandbox, "getElecShutModifier"))
    local worldAgeHours = tonumber(PanelBridge.tryGet(gameTime, "getWorldAgeHours")) or 0
    local timeSinceApo = tonumber(PanelBridge.tryGet(sandbox, "getTimeSinceApo")) or 1
    local worldAgeDays = worldAgeHours / 24 + (timeSinceApo - 1) * 30
    if not shutdownDay or shutdownDay < 0 or worldAgeDays >= shutdownDay then
        return false
    end

    if PanelBridge.tryGet(world, "isHydroPowerOn") ~= false then return false end
    if not PanelBridge.invoke(world, "setHydroPowerOn", true) then return false end
    if PanelBridge.tryGet(world, "isHydroPowerOn") ~= true then return false end

    setElectricityOnLoadedSquares(true)
    PanelBridge.invoke(world, "transmitWeather")
    return true
end

-- Helper function to activate light switches in loaded chunks around all players
-- Drives a light switch to `enabled`.
-- Returns: inRequestedState, didChange
local function setLightSwitchState(obj, enabled)
    local state = PanelBridge.tryGet(obj, "isActivated")
    if state == enabled then return true, false end
    -- toggle only flips, so fall back to the explicit setter when absent.
    if not PanelBridge.invoke(obj, "toggle") then
        if not PanelBridge.invoke(obj, "setActive", enabled) then
            return false, false
        end
    end
    return PanelBridge.tryGet(obj, "isActivated") == enabled, true
end

local function activateLightSwitchesInLoadedChunks()
    local cell = getCell()
    if not cell then
        return 0, "No cell available"
    end

    local activatedCount = 0

    local players = getOnlinePlayers()
    if not players or players:size() == 0 then
        return 0, "No players online"
    end

    for p = 0, players:size() - 1 do
        local player = players:get(p)
        if player then
            local px, py = math.floor(player:getX()), math.floor(player:getY())

            for x = px - 30, px + 30 do
                for y = py - 30, py + 30 do
                    for z = 0, 3 do
                        local sq = cell:getGridSquare(x, y, z)
                        if sq then
                            local objects = sq:getObjects()
                            if objects then
                                for i = 0, objects:size() - 1 do
                                    local obj = objects:get(i)
                                    if obj and instanceof(obj, "IsoLightSwitch") then
                                        local success, toggleErr = pcall(function()
                                            if setLightSwitchState(obj, true) then
                                                activatedCount = activatedCount + 1
                                            end
                                        end)
                                    end
                                end
                            end
                        end
                    end
                end
            end
        end
    end

    return activatedCount, "success"
end

-- Deactivate light switches near online players (used when shutting off power)
local function deactivateLightSwitchesInLoadedChunks()
    local cell = getCell()
    if not cell then
        return 0, "No cell available"
    end

    local deactivatedCount = 0

    local players = getOnlinePlayers()
    if not players or players:size() == 0 then
        return 0, "No players online"
    end

    for p = 0, players:size() - 1 do
        local player = players:get(p)
        if player then
            local px, py = math.floor(player:getX()), math.floor(player:getY())

            for x = px - 30, px + 30 do
                for y = py - 30, py + 30 do
                    for z = 0, 3 do
                        local sq = cell:getGridSquare(x, y, z)
                        if sq then
                            -- Use switchLight(false) on the square itself to cut lighting
                            PanelBridge.invoke(sq, "switchLight", false)

                            local objects = sq:getObjects()
                            if objects then
                                for i = 0, objects:size() - 1 do
                                    local obj = objects:get(i)
                                    if obj and instanceof(obj, "IsoLightSwitch") then
                                        local success, err = pcall(function()
                                            local inState, changed = setLightSwitchState(obj, false)
                                            if inState and changed then
                                                deactivatedCount = deactivatedCount + 1
                                            end
                                        end)
                                    end
                                end
                            end
                        end
                    end
                end
            end
        end
    end

    return deactivatedCount, "success"
end

-- ============================================
-- BACKGROUND JOBS (cross-tick chunked work) — see L02 audit finding
-- ============================================
-- restoreUtilities/shutOffUtilities can touch tens of thousands of grid
-- squares (up to ~40k per online player for the electricity scan alone).
-- Doing that synchronously inside a single tick freezes the ENTIRE server
-- (every player) for the full duration. When invoked via the normal panel
-- command queue (cmdId is non-nil), these two handlers now defer the
-- square/light-switch scan to a background job that processes
-- JOB_UNITS_PER_TICK squares per real game tick instead of all of them at
-- once, and only send the command result once the scan is fully drained.
--
-- When called directly (e.g. from the scripted "sequence" step executor
-- around line 6100, which calls handlers.restoreUtilities/shutOffUtilities
-- as a plain Lua function and expects a synchronous (success, data, error)
-- return), cmdId is nil and the ORIGINAL fully-synchronous behavior is used
-- unchanged — this fix only applies to the interactive, panel-triggered
-- path, since retrofitting the sequence executor to understand deferred
-- jobs is a separate, larger change not attempted here.
PanelBridge.activeJob = nil
local JOB_UNITS_PER_TICK = 1500

-- Runs one tick's worth of work on the active background job, if any.
-- Called unconditionally from PanelBridge.onTick() every game tick.
function PanelBridge.processActiveJob()
    local job = PanelBridge.activeJob
    if not job then return end

    local phase = job.phases[job.phaseIdx]
    if not phase then
        -- Every phase is done — finalize and send the real command result.
        PanelBridge.activeJob = nil
        local ok, success, data, errMsg = pcall(job.onComplete)
        if not ok then
            PanelBridge.stats.commandsFailed = PanelBridge.stats.commandsFailed + 1
            PanelBridge.error("Background job finalize failed", { error = tostring(success) })
            PanelBridge.sendResult(job.cmdId, false, nil, "Background job finalize failed: " .. tostring(success))
        else
            if success then
                PanelBridge.stats.commandsSucceeded = PanelBridge.stats.commandsSucceeded + 1
            else
                PanelBridge.stats.commandsFailed = PanelBridge.stats.commandsFailed + 1
            end
            PanelBridge.sendResult(job.cmdId, success, data, errMsg)
        end
        return
    end

    job.phaseDone = false
    local ok, err = pcall(phase, job, JOB_UNITS_PER_TICK)
    if not ok then
        PanelBridge.activeJob = nil
        PanelBridge.stats.commandsFailed = PanelBridge.stats.commandsFailed + 1
        PanelBridge.error("Background job step failed", { error = tostring(err) })
        PanelBridge.sendResult(job.cmdId, false, nil, "Background job step failed: " .. tostring(err))
        return
    end
    if job.phaseDone then
        job.phaseIdx = job.phaseIdx + 1
    end
end

-- Starts a background job. `phases` is an ordered array of stepFn(job, budget)
-- functions; each must set job.phaseDone = true once its own work is
-- complete. `onComplete()` runs after every phase has finished and must
-- return (success, data, errorMsg) exactly like a normal command handler.
local function startBackgroundJob(cmdId, phases, onComplete)
    PanelBridge.activeJob = {
        cmdId = cmdId,
        phases = phases,
        phaseIdx = 1,
        onComplete = onComplete,
    }
end

-- Builds a resumable, cross-tick step function that walks the same
-- player-centered square grid the synchronous helpers above scan (for each
-- online player: x in [-radius,+radius], y in [-radius,+radius], z in
-- [0,zMax]), but processes only `budget` squares per call instead of the
-- whole grid at once. `applyFn(sq)` is called once per loaded square found;
-- it's invoked inside a pcall here so one bad square/object can't abort the
-- whole scan (matching the per-square pcall the original synchronous
-- helpers already used).
local function makeSquareScanStepFn(radius, zMax, applyFn)
    local players = getOnlinePlayers()
    local playerCoords = {}
    if players then
        for p = 0, players:size() - 1 do
            local player = players:get(p)
            if player then
                table.insert(playerCoords, { x = math.floor(player:getX()), y = math.floor(player:getY()) })
            end
        end
    end

    local playerIdx = 1
    local xOff, yOff, z = -radius, -radius, 0

    return function(job, budget)
        if #playerCoords == 0 then
            job.phaseDone = true
            return
        end
        local cell = getCell()
        if not cell then
            job.phaseDone = true
            return
        end
        local remaining = budget
        while remaining > 0 and playerIdx <= #playerCoords do
            local pc = playerCoords[playerIdx]
            local sq = cell:getGridSquare(pc.x + xOff, pc.y + yOff, z)
            if sq then
                pcall(applyFn, sq)
            end
            remaining = remaining - 1

            z = z + 1
            if z > zMax then
                z = 0
                yOff = yOff + 1
                if yOff > radius then
                    yOff = -radius
                    xOff = xOff + 1
                    if xOff > radius then
                        xOff = -radius
                        playerIdx = playerIdx + 1
                    end
                end
            end
        end
        if playerIdx > #playerCoords then
            job.phaseDone = true
        end
    end
end

-- Per-square operations used as the `applyFn` for makeSquareScanStepFn.
-- Each takes a `counter` table ({ n = 0 }) so the caller can read the final
-- tally after the job completes (mirrors the squareCount/switchesActivated/
-- switchesDeactivated return values the synchronous helpers produce).
local function makeElectricitySetter(enabled, counter)
    return function(sq)
        sq:setHaveElectricity(enabled)
        counter.n = counter.n + 1
    end
end

local function makeLightSwitchActivator(counter)
    return function(sq)
        local objects = sq:getObjects()
        if not objects then return end
        for i = 0, objects:size() - 1 do
            local obj = objects:get(i)
            if obj and instanceof(obj, "IsoLightSwitch") then
                if setLightSwitchState(obj, true) then
                    counter.n = counter.n + 1
                end
            end
        end
    end
end

local function makeLightSwitchDeactivator(counter)
    return function(sq)
        PanelBridge.invoke(sq, "switchLight", false)
        local objects = sq:getObjects()
        if not objects then return end
        for i = 0, objects:size() - 1 do
            local obj = objects:get(i)
            if obj and instanceof(obj, "IsoLightSwitch") then
                local inState, changed = setLightSwitchState(obj, false)
                if inState and changed then
                    counter.n = counter.n + 1
                end
            end
        end
    end
end

-- Restore power and water (turn hydro power on and reset shutdown timers)
handlers.restoreUtilities = function(args, cmdId)
    local world = getWorld()
    if not world then
        return false, nil, "World not available"
    end

    if cmdId and PanelBridge.activeJob then
        return false, nil, "Another utilities operation is already in progress"
    end

    local restorePower = args.power ~= false -- default true
    local restoreWater = args.water ~= false -- default true

    local debugInfo = {}

    local success, err = pcall(function()
        local gameTime = GameTime.getInstance()
        local nightsSurvived = 0
        if gameTime then
            nightsSurvived = gameTime:getNightsSurvived()
        end
        table.insert(debugInfo, "nightsSurvived=" .. tostring(nightsSurvived))

        local sandboxOptions = getSandboxOptions()

        -- Step 1: Set Lua SandboxVars FIRST (the authoritative source for updateFromLua)
        -- The game's actual power check (ISButtonPrompt.lua line 421) is:
        --   if (ElecShutModifier > -1 AND worldAgeDays < ElecShutModifier) OR square:haveElectricity()
        -- Setting -1 makes (> -1) FALSE = power always off!
        -- Integer.MAX_VALUE (2147483647) = documented sandbox max, "never shuts off"
        -- sentinel used by EPR / phobos-dthorga/mod-pz-epr-cleanup.
        local restoreDays = 2147483647
        if restorePower then
            SandboxVars.ElecShut = 9        -- 9 = Disabled (sandbox UI label)
            SandboxVars.ElecShutModifier = restoreDays
            table.insert(debugInfo, "Lua ElecShut=9(Disabled) ElecShutModifier=" .. tostring(restoreDays))
        end

        if restoreWater then
            SandboxVars.WaterShut = 9       -- 9 = Disabled (sandbox UI label)
            SandboxVars.WaterShutModifier = restoreDays
            table.insert(debugInfo, "Lua WaterShut=9(Disabled) WaterShutModifier=" .. tostring(restoreDays))
        end

        -- Step 2: Sync Lua -> Java via updateFromLua, then apply
        if sandboxOptions then
            if PanelBridge.invoke(sandboxOptions, "updateFromLua") then
                table.insert(debugInfo, "updateFromLua OK")
            end
            if PanelBridge.invoke(sandboxOptions, "applySettings") then
                table.insert(debugInfo, "applySettings OK")
            end
            -- Verify Java side got the values
            table.insert(debugInfo, "Java getElecShutModifier=" .. tostring(sandboxOptions:getElecShutModifier()))
            table.insert(debugInfo, "Java getWaterShutModifier=" .. tostring(sandboxOptions:getWaterShutModifier()))
            -- If applySettings recalculated, force restoreDays back via Java option
            if restorePower and sandboxOptions:getElecShutModifier() ~= restoreDays then
                PanelBridge.invoke(sandboxOptions:getOptionByName("ElecShutModifier"), "setValue", restoreDays)
                table.insert(debugInfo, "FORCED Java ElecShutModifier=" .. tostring(restoreDays))
            end
            if restoreWater and sandboxOptions:getWaterShutModifier() ~= restoreDays then
                PanelBridge.invoke(sandboxOptions:getOptionByName("WaterShutModifier"), "setValue", restoreDays)
                table.insert(debugInfo, "FORCED Java WaterShutModifier=" .. tostring(restoreDays))
            end
            -- Re-apply so the forced values take effect before setHydroPowerOn
            if PanelBridge.invoke(sandboxOptions, "applySettings") then
                table.insert(debugInfo, "applySettings(post-force) OK")
            end
            -- Sync Java -> Lua to confirm
            if PanelBridge.invoke(sandboxOptions, "toLua") then
                table.insert(debugInfo, "toLua OK")
            end
        end

        -- Step 3: Set hydro power ON *after* applySettings so it can't be overwritten
        if restorePower then
            world:setHydroPowerOn(true)
            table.insert(debugInfo, "setHydroPowerOn(true)")
        end
    end)

    if not success then
        -- 2026-08-30, total-audit batch 3, item 2 (mutate-then-fail): the
        -- pcall above can throw partway through -- SandboxVars, the Java
        -- sync, and/or the hydro power flag may already be mutated by the
        -- time it does. This used to return `nil` for data, discarding
        -- debugInfo (which already records exactly which steps completed
        -- before the throw) and leaving the caller with nothing but an
        -- error string -- no way to tell what, if anything, already landed.
        -- Not adding rollback (a retry with the same args is idempotent,
        -- per the operator-impact review this fix came from) -- just
        -- reporting what happened, now that a failure's data actually
        -- reaches the caller (see the processResult transport fix,
        -- 19f56d98 -- this handler is the reason that fix matters).
        local hydroPowerOn = nil
        pcall(function() hydroPowerOn = world:isHydroPowerOn() end)
        return false, {
            power = restorePower,
            water = restoreWater,
            hydroPowerOn = hydroPowerOn,
            debug = debugInfo
        }, "Failed to restore utilities: " .. tostring(err)
    end

    -- Steps 6-7 (client sync) + final verification logging, shared by every
    -- path below regardless of whether the grid scan ran synchronously,
    -- was skipped (water-only), or ran as a background job.
    local function finishRestoreUtilities()
        -- Step 6: /reloadoptions only re-reads ServerOptions.ini; sandbox vars are
        -- not in that file, so this is a nudge for connected clients, not the
        -- mechanism that moves ElecShutModifier across the wire.
        pcall(function()
            if executeCommand then
                executeCommand("/reloadoptions")
                table.insert(debugInfo, "executeCommand /reloadoptions OK")
            end
        end)

        -- Step 7: Transmit weather (forces world state sync including power)
            if PanelBridge.invoke(world, "transmitWeather") then
                table.insert(debugInfo, "transmitWeather OK")
            end

        -- NOTE: no custom client-side mod is distributed. Client sync relies on
        -- built-in PZ propagation: /reloadoptions (sandbox), transmitWeather
        -- (world state), and setHaveElectricity (per-square network update).

        -- Verify final state
        table.insert(debugInfo, "FINAL isHydroPowerOn=" .. tostring(world:isHydroPowerOn()))
        table.insert(debugInfo, "FINAL SandboxVars.ElecShutModifier=" .. tostring(SandboxVars.ElecShutModifier))
        table.insert(debugInfo, "FINAL SandboxVars.WaterShutModifier=" .. tostring(SandboxVars.WaterShutModifier))

        print("[PanelBridge] restoreUtilities debug: " .. table.concat(debugInfo, " | "))

        -- 2026-08-31 bug hunt: hydroPowerOn used to be reported as pure
        -- diagnostic data with no bearing on `ok` -- this handler already
        -- computes the real read-back (world:setHydroPowerOn can silently
        -- not stick, per Step 3's own comment above -- exactly the failure
        -- mode panelBridgeUtilitiesHydroPowerOnReporting.test.js already
        -- constructs), it just never used it to gate the one field a caller
        -- actually checks. Verified when power was requested: ok now means
        -- the requested state is confirmed on, not merely that the mutation
        -- attempt ran without throwing. Water has no equivalent read-back
        -- exposed anywhere in this file, so it isn't gated here -- only the
        -- power dimension this handler can actually confirm.
        local actualHydroPowerOn = world:isHydroPowerOn()
        local verified = (not restorePower) or actualHydroPowerOn
        -- NOT `verified and nil or errMsg` -- that Lua and/or idiom always
        -- picks errMsg, since `verified and nil` collapses to nil (falsy)
        -- regardless of verified, so `or errMsg` would always fire. An
        -- explicit if/else is the only safe way to conditionally produce nil.
        local errMsg = nil
        if not verified then
            errMsg = "Power restore did not take effect (hydro power is still off)"
        end
        return verified, {
            message = verified and "Utilities restored" or errMsg,
            power = restorePower,
            water = restoreWater,
            hydroPowerOn = actualHydroPowerOn,
            debug = debugInfo
        }, errMsg
    end

    if not restorePower then
        -- Nothing to scan (water-only restore) — finish synchronously.
        return finishRestoreUtilities()
    end

    if not cmdId then
        -- Direct/synchronous call path (e.g. the scripted sequence executor,
        -- which expects a normal synchronous return) — original behavior,
        -- unchanged: scan every square in one shot before returning.
        local squareCount = setElectricityOnLoadedSquares(true)
        table.insert(debugInfo, "setHaveElectricity(true) squares=" .. tostring(squareCount))
        local switchesActivated = activateLightSwitchesInLoadedChunks()
        table.insert(debugInfo, "switches=" .. tostring(switchesActivated))
        return finishRestoreUtilities()
    end

    -- Queue-triggered path: defer the grid scan to a background job so it
    -- doesn't block the tick loop (see L02). The command result is sent
    -- later, from the job's onComplete, once every phase has drained.
    local elecCounter = { n = 0 }
    local switchCounter = { n = 0 }
    startBackgroundJob(cmdId, {
        makeSquareScanStepFn(50, 3, makeElectricitySetter(true, elecCounter)),
        makeSquareScanStepFn(30, 3, makeLightSwitchActivator(switchCounter)),
    }, function()
        table.insert(debugInfo, "setHaveElectricity(true) squares=" .. tostring(elecCounter.n))
        table.insert(debugInfo, "switches=" .. tostring(switchCounter.n))
        return finishRestoreUtilities()
    end)

    return "DEFERRED"
end

-- Shut off power and water
handlers.shutOffUtilities = function(args, cmdId)
    local world = getWorld()
    if not world then
        return false, nil, "World not available"
    end

    if cmdId and PanelBridge.activeJob then
        return false, nil, "Another utilities operation is already in progress"
    end

    local shutPower = args.power ~= false -- default true
    local shutWater = args.water ~= false -- default true

    local debugInfo = {}

    local success, err = pcall(function()
        local gameTime = GameTime.getInstance()
        local nightsSurvived = 0
        if gameTime then
            nightsSurvived = gameTime:getNightsSurvived()
        end
        table.insert(debugInfo, "nightsSurvived=" .. tostring(nightsSurvived))

        -- Step 1: Set Lua SandboxVars to instant shutoff
        if shutPower then
            SandboxVars.ElecShut = 1        -- 1 = Instant
            SandboxVars.ElecShutModifier = 0   -- 0 = shut off at day 0
            table.insert(debugInfo, "Lua ElecShut=1(Instant) ElecShutModifier=0")
        end

        if shutWater then
            SandboxVars.WaterShut = 1       -- 1 = Instant
            SandboxVars.WaterShutModifier = 0  -- 0 = shut off at day 0
            table.insert(debugInfo, "Lua WaterShut=1(Instant) WaterShutModifier=0")
        end

        -- Step 2: Sync Lua -> Java and apply
        local sandboxOptions = getSandboxOptions()
        if sandboxOptions then
            PanelBridge.invoke(sandboxOptions, "updateFromLua")
            PanelBridge.invoke(sandboxOptions, "applySettings")
            table.insert(debugInfo, "Java getElecShutModifier=" .. tostring(sandboxOptions:getElecShutModifier()))
            table.insert(debugInfo, "Java getWaterShutModifier=" .. tostring(sandboxOptions:getWaterShutModifier()))
            -- applySettings can re-roll the modifier from the enum, so pin it back
            if shutPower and sandboxOptions:getElecShutModifier() ~= 0 then
                PanelBridge.invoke(sandboxOptions:getOptionByName("ElecShutModifier"), "setValue", 0)
                table.insert(debugInfo, "FORCED Java ElecShutModifier=0")
            end
            if shutWater and sandboxOptions:getWaterShutModifier() ~= 0 then
                PanelBridge.invoke(sandboxOptions:getOptionByName("WaterShutModifier"), "setValue", 0)
                table.insert(debugInfo, "FORCED Java WaterShutModifier=0")
            end
            PanelBridge.invoke(sandboxOptions, "applySettings")
            PanelBridge.invoke(sandboxOptions, "toLua")
            table.insert(debugInfo, "sandbox sync OK")
        end

        -- Step 3: Set hydro power OFF *after* applySettings
        if shutPower then
            world:setHydroPowerOn(false)
            table.insert(debugInfo, "setHydroPowerOn(false)")
        end
    end)

    if not success then
        -- See restoreUtilities' matching comment (2026-08-30, total-audit
        -- batch 3, item 2) -- same mutate-then-fail shape, same fix: report
        -- what debugInfo already recorded instead of discarding it as nil.
        local hydroPowerOn = nil
        pcall(function() hydroPowerOn = world:isHydroPowerOn() end)
        return false, {
            power = shutPower,
            water = shutWater,
            hydroPowerOn = hydroPowerOn,
            debug = debugInfo
        }, "Failed to shut off utilities: " .. tostring(err)
    end

    -- Steps 6-7 (client sync) + final verification, shared by every path
    -- below regardless of whether the grid scan ran synchronously, was
    -- skipped (water-only), or ran as a background job.
    local function finishShutOffUtilities()
        -- Step 6: /reloadoptions only re-reads ServerOptions.ini, not sandbox vars.
        pcall(function()
            if executeCommand then
                executeCommand("/reloadoptions")
                table.insert(debugInfo, "executeCommand /reloadoptions OK")
            end
        end)

        -- Step 7: Transmit weather
        if PanelBridge.invoke(world, "transmitWeather") then
            table.insert(debugInfo, "transmitWeather OK")
        end

        -- NOTE: no custom client-side mod is distributed. Client sync relies on
        -- built-in PZ propagation: /reloadoptions (sandbox), transmitWeather
        -- (world state), and setHaveElectricity (per-square network update).

        -- Final verification
        table.insert(debugInfo, "FINAL isHydroPowerOn=" .. tostring(world:isHydroPowerOn()))

        print("[PanelBridge] shutOffUtilities debug: " .. table.concat(debugInfo, " | "))

        -- 2026-08-31 bug hunt: same fix as restoreUtilities' finish function
        -- -- see its comment for the full reasoning. Verified when power was
        -- requested to shut off: ok now means hydro power is confirmed off,
        -- not merely that the mutation attempt ran without throwing.
        local actualHydroPowerOn = world:isHydroPowerOn()
        local verified = (not shutPower) or (not actualHydroPowerOn)
        local errMsg = nil
        if not verified then
            errMsg = "Power shutoff did not take effect (hydro power is still on)"
        end
        return verified, {
            message = verified and "Utilities shut off" or errMsg,
            power = shutPower,
            water = shutWater,
            hydroPowerOn = actualHydroPowerOn,
            debug = debugInfo
        }, errMsg
    end

    if not shutPower then
        -- Nothing to scan (water-only shutoff) — finish synchronously.
        return finishShutOffUtilities()
    end

    if not cmdId then
        -- Direct/synchronous call path (e.g. the scripted sequence executor)
        -- — original behavior, unchanged.
        local squareCount = setElectricityOnLoadedSquares(false)
        table.insert(debugInfo, "setHaveElectricity(false) squares=" .. tostring(squareCount))
        local switchesDeactivated = deactivateLightSwitchesInLoadedChunks()
        table.insert(debugInfo, "switches deactivated=" .. tostring(switchesDeactivated))
        return finishShutOffUtilities()
    end

    -- Queue-triggered path: defer the grid scan to a background job (L02).
    local elecCounter = { n = 0 }
    local switchCounter = { n = 0 }
    startBackgroundJob(cmdId, {
        makeSquareScanStepFn(50, 3, makeElectricitySetter(false, elecCounter)),
        makeSquareScanStepFn(30, 3, makeLightSwitchDeactivator(switchCounter)),
    }, function()
        table.insert(debugInfo, "setHaveElectricity(false) squares=" .. tostring(elecCounter.n))
        table.insert(debugInfo, "switches deactivated=" .. tostring(switchCounter.n))
        return finishShutOffUtilities()
    end)

    return "DEFERRED"
end

-- ============================================
-- PLAYER MANAGEMENT HANDLERS
-- ============================================

-- Heal a player fully
handlers.healPlayer = function(args)
    local username = args.username
    if not username then
        return false, nil, "Username required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    -- Build 42's documented body-part collection is the complete supported
    -- healing path. Optional Java-method probes log engine errors even inside
    -- pcall, so do not call bodyDamage/Stats/Moodles compatibility methods.
    -- No bodyDamage means the healing block below never runs at all -- that
    -- is not a partial heal, it is no heal, and must not report success.
    local bodyDamage = player:getBodyDamage()
    if not bodyDamage then
        return false, nil, "Could not access player body damage; nothing was healed"
    end

    local healed = {}
    local errors = {}

    local ok1, err1 = pcall(function()
        local bodyParts = bodyDamage:getBodyParts()
        for i = 0, bodyParts:size() - 1 do
            local part = bodyParts:get(i)
            part:RestoreToFullHealth()
            part:SetFakeInfected(false)
            healed.bodyDamage = true
        end
    end)
    if not ok1 then table.insert(errors, "bodyDamage: " .. tostring(err1)) end

    -- CRITICAL: Network sync — transmit changes to client
    -- Without this, the server has the healed state but the player client doesn't see it
    local ok4, err4 = pcall(function()
        local synced = false
        -- B42: sendPlayerExtraInfo sends full player state to all clients
        if sendPlayerExtraInfo then
            sendPlayerExtraInfo(player)
            synced = true
            healed.syncMethod = "sendPlayerExtraInfo"
        end
        -- B42: PacketTypes for fine-grained sync
        if syncPlayerFields then
            syncPlayerFields(player)
            synced = true
            healed.syncMethod = (healed.syncMethod or "") .. "+syncPlayerFields"
        end
        healed.networkSync = synced
    end)
    if not ok4 then table.insert(errors, "sync: " .. tostring(err4)) end

    if #errors > 0 then
        healed.errors = errors
    end

    PanelBridge.info("Healed player", { username = username, healed = healed })

    if not ok1 or not healed.bodyDamage then
        -- The core healing action itself did not happen -- this used to be
        -- an unconditional `return true` regardless of what actually
        -- occurred, so zero body parts healed (or the healing pcall itself
        -- throwing) still read as a clean success to any caller checking
        -- `ok` alone; the real reason sat only in a nested healed.errors
        -- array. Per the transport finding above (data is DROPPED on every
        -- failure, only the third slot survives), the real reason has to be
        -- IN the error string here, not just in the data table.
        -- Network sync failing on its OWN does not reach this branch: the
        -- player really was healed server-side even if the client doesn't
        -- see it yet until a future sync, a materially different (and
        -- lesser) problem than "nothing was healed" -- same distinction the
        -- faction sync fix drew between a real mutation and its
        -- propagation. That case still returns true, with the sync error
        -- visible in healed.errors (which DOES reach the caller on success).
        local reason = ok1 and "No body parts were healed (empty body part collection)"
            or ("Body healing failed: " .. tostring(err1))
        return false, { username = username, healed = healed }, reason
    end

    return true, { message = "Player healed", username = username, healed = healed }
end

-- Kill a player
handlers.killPlayer = function(args)
    local username = args.username
    if not username then
        return false, nil, "Username required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local debugInfo = {}

    -- Force godmode OFF — otherwise setHealth(0) is a no-op. This is a REAL
    -- MUTATION that happens before the kill itself can be confirmed to have
    -- worked -- if Kill(nil) below has no effect on this build, the player
    -- has ALREADY had godmode/invincibility stripped regardless. The failure
    -- return below says so explicitly instead of reporting a bare failure
    -- while that mutation silently stands (2026-08-30, the same
    -- mutate-then-fail class fixed for the faction handlers above: a real
    -- change landed but the caller was never told).
    --
    -- Uses the role-gate bypass (see setCharacterCheatBypassingRoleGate) --
    -- the plain 1-arg setGodMod is gated by the TARGET's own Role capability,
    -- so for a normal (non-admin) player this "force off" would silently
    -- no-op and leave godmode standing through the kill below.
    if PanelBridge.setCharacterCheatBypassingRoleGate(player, "setGodMod", false) then
        table.insert(debugInfo, "godMod disabled")
    elseif PanelBridge.setCharacterCheatBypassingRoleGate(player, "setGodMode", false) then
        table.insert(debugInfo, "godMode disabled")
    end
    -- setInvincible has the same capability gate (ToggleInvincibleHimself)
    -- but no 2-arg bypass overload exists on this build -- this call can
    -- still silently no-op for a target whose Role lacks that capability.
    if PanelBridge.invoke(player, "setInvincible", false) then
        table.insert(debugInfo, "invincible disabled")
    end

    -- Build 42's native death path performs the authoritative health and event updates.
    if PanelBridge.invoke(player, "Kill", nil) then
        table.insert(debugInfo, "Kill(nil) called")
    end

    -- Broadcast updated extra info + zombie-death flag for network sync.
    pcall(function()
        if sendPlayerExtraInfo then
            sendPlayerExtraInfo(player)
            table.insert(debugInfo, "sendPlayerExtraInfo")
        end
    end)
    pcall(function()
        if sendPlayerDeath then
            sendPlayerDeath(player)
            table.insert(debugInfo, "sendPlayerDeath")
        end
    end)

    local isDead = PanelBridge.tryGet(player, "isDead") == true

    local debugStr = table.concat(debugInfo, " | ")
    PanelBridge.info("Killed player", { username = username, isDead = isDead, debug = debugStr })

    if not isDead then
        -- Matches this file's (ok, data, err) contract the way teleportPlayer
        -- does: a real error string in the third slot (the dispatcher logs
        -- and forwards it to the panel), not left nil with the real reason
        -- buried in a data field the failure path never surfaces. Also names
        -- the mutate-then-fail hazard explicitly: godmode/invincibility were
        -- unconditionally disabled above and are NOT restored here.
        return false, {
            username = username,
            isDead = false,
            debug = debugStr
        }, "Kill attempted but player is not dead (Kill(nil) may have had no effect on this build, or the player respawned) -- godmode/invincibility were already disabled by this call and were NOT restored"
    end

    return true, {
        message = "Player killed",
        username = username,
        isDead = true,
        debug = debugStr
    }
end

-- Set player's godmode
handlers.setGodMode = function(args)
    local username = args.username
    local enabled = args.enabled == true

    if not username then
        return false, nil, "Username required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    -- B42/B41: setGodMod is the actual PZ method name (not a typo)
    --
    -- Uses the role-gate bypass (see setCharacterCheatBypassingRoleGate) --
    -- the plain 1-arg setter is gated by the TARGET player's own Role
    -- capability (ToggleGodModHimself), which an ordinary player's Role
    -- normally does not carry, so it silently no-ops for exactly the
    -- players an admin tool needs to act on.
    local method = nil
    local success, err
    success, err = PanelBridge.setCharacterCheatBypassingRoleGate(player, "setGodMod", enabled)
    if success then method = "setGodMod" end
    if not success then
        success, err = PanelBridge.setCharacterCheatBypassingRoleGate(player, "setGodMode", enabled)
        if success then method = "setGodMode" end
    end

    if not success then
        return false, nil, "Failed to set godmode: " .. tostring(err or "No godmode method available on player object")
    end

    -- Verify it took effect. Written with an explicit if/then rather than
    -- Lua's `a and b or c` idiom -- that idiom silently breaks when b (a
    -- real, confirmed mismatch) is `false`: `true and false` short-circuits
    -- to `false`, which is falsy, so it falls through to c (nil), making a
    -- CONFIRMED FAILURE indistinguishable from an unverifiable state. That
    -- would have made gating on verified==false below never actually fire.
    local godModeState = PanelBridge.tryGet(player, "isGodMod")
    local verified
    if godModeState == nil then
        verified = nil
    elseif godModeState == enabled then
        verified = true
    else
        verified = false
    end

    PanelBridge.info("Set godmode", { username = username, enabled = enabled, method = method, verified = verified })

    return PanelBridge.verifiedResult(verified, {
        message = "Godmode " .. (enabled and "enabled" or "disabled"),
        username = username
    }, "Godmode call succeeded but did not take effect (state is still " .. tostring(godModeState) .. ")")
end

-- Set player's invisibility
handlers.setInvisible = function(args)
    local username = args.username
    local enabled = args.enabled == true

    if not username then
        return false, nil, "Username required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    -- Uses the role-gate bypass (see setCharacterCheatBypassingRoleGate) --
    -- the plain 1-arg setInvisible is gated by the TARGET player's own Role
    -- capability (ToggleInvisibleHimself), which an ordinary player's Role
    -- normally does not carry, so it silently no-ops for exactly the
    -- players an admin tool needs to act on.
    local success, err = PanelBridge.setCharacterCheatBypassingRoleGate(player, "setInvisible", enabled)

    if not success then
        return false, nil, "Failed to set invisible: " .. tostring(err)
    end

    -- Verify. Explicit if/then, not `a and b or c` -- see setGodMode's comment
    -- above for why that idiom silently turns a confirmed mismatch into nil.
    local invisibleState = PanelBridge.tryGet(player, "isInvisible")
    local verified
    if invisibleState == nil then
        verified = nil
    elseif invisibleState == enabled then
        verified = true
    else
        verified = false
    end

    PanelBridge.info("Set invisible", { username = username, enabled = enabled, verified = verified })

    return PanelBridge.verifiedResult(verified, {
        message = "Invisibility " .. (enabled and "enabled" or "disabled"),
        username = username
    }, "Invisibility call succeeded but did not take effect (state is still " .. tostring(invisibleState) .. ")")
end

-- Set player's noclip
handlers.setNoclip = function(args)
    local username = args.username
    local enabled = args.enabled == true

    if not username then
        return false, nil, "Username required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    -- Uses the role-gate bypass (see setCharacterCheatBypassingRoleGate) --
    -- the plain 1-arg setNoClip is gated by the TARGET player's own Role
    -- capability (ToggleNoclipHimself), which an ordinary player's Role
    -- normally does not carry, so it silently no-ops for exactly the
    -- players an admin tool needs to act on (GitHub issue #129).
    local success, err = PanelBridge.setCharacterCheatBypassingRoleGate(player, "setNoClip", enabled)

    if not success then
        return false, nil, "Failed to set noclip: " .. tostring(err)
    end

    -- Verify. isNoClip confirmed present on IsoPlayer/IsoMovingObject by
    -- reading the real shipped B42 jar's constant pool directly (2026-08-23).
    local noclipState = PanelBridge.tryGet(player, "isNoClip")
    local verified
    if noclipState == nil then
        verified = nil
    elseif noclipState == enabled then
        verified = true
    else
        verified = false
    end

    PanelBridge.info("Set noclip", { username = username, enabled = enabled, verified = verified })

    return PanelBridge.verifiedResult(verified,
        { message = "Noclip " .. (enabled and "enabled" or "disabled"), username = username },
        "Noclip call succeeded but did not take effect (state is still " .. tostring(noclipState) .. ")")
end

-- Give item to player
handlers.giveItem = function(args)
    local username = args.username
    local itemType = args.itemType
    local count = math.min(math.max(tonumber(args.count) or 1, 1), 100) -- Clamp 1-100 per call

    if not username then
        return false, nil, "Username required"
    end
    if type(itemType) ~= "string" then
        return false, nil, "Item type required (e.g., 'Base.Axe')"
    end
    -- Basic format validation: must look like "Module.ItemName"
    if not itemType:match("^[%w_]+%.[%w_&%#%+%.%-]+$") then
        return false, nil, "Invalid item type format (expected Module.ItemName): " .. tostring(itemType)
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local inventory = PanelBridge.tryGet(player, "getInventory")
    if not inventory then
        return false, nil, "Could not access player inventory"
    end

    local added = 0
    local lastError = nil
    for i = 1, count do
        local ok, item = pcall(function()
            return inventory:AddItem(itemType)
        end)
        if ok and item then
            added = added + 1
        elseif not ok then
            lastError = tostring(item)
        end
    end

    if added == 0 then
        return false, nil, "Failed to add item '" .. itemType .. "'" .. (lastError and (": " .. lastError) or ". Item type may not exist.")
    end

    -- Network sync so client sees the new items
    PanelBridge.invoke(player, "sendObjectChange", "inventory")
    pcall(function()
        if sendPlayerExtraInfo then
            sendPlayerExtraInfo(player)
        end
    end)

    PanelBridge.info("Gave items", { username = username, itemType = itemType, count = added })
    return true, {
        message = "Gave " .. added .. "x " .. itemType,
        username = username,
        itemType = itemType,
        count = added
    }
end

-- ============================================
-- AIRDROP HANDLER
-- ============================================

-- Airdrop preset item lists
local AIRDROP_PRESETS = {
    military = {
        "Base.AssaultRifle2", "Base.Pistol3", "Base.556Bullets", "Base.9mmClip",
        "Base.Bullets9mmBox", "Base.556Box", "Base.HolsterSimple",
        "Base.Helmet_Army", "Base.Vest_BulletArmy", "Base.MilitaryBoots",
        "Base.WalkieTalkie5", "Base.KnifeHunting"
    },
    medical = {
        "Base.Bandage", "Base.Bandage", "Base.Bandage", "Base.AlcoholBandage",
        "Base.AlcoholBandage", "Base.SutureNeedle", "Base.Antibiotics",
        "Base.Disinfectant", "Base.Pills", "Base.PillsVitamins",
        "Base.FirstAidKit", "Base.Tweezers"
    },
    food = {
        "Base.CannedBeans", "Base.CannedBeans", "Base.CannedChili",
        "Base.CannedCorn", "Base.CannedTomato2", "Base.TunaTin",
        "Base.WaterBottleFull", "Base.WaterBottleFull", "Base.Pop3",
        "Base.CannedSardines", "Base.CannedPeaches", "Base.MRE"
    },
    building = {
        "Base.Plank", "Base.Plank", "Base.Plank", "Base.Plank",
        "Base.Nails", "Base.Nails", "Base.NailsBox",
        "Base.Hammer", "Base.Saw", "Base.Screwdriver",
        "Base.SheetRope", "Base.Axe"
    },
    weapons = {
        "Base.Shotgun", "Base.ShotgunShellsBox", "Base.ShotgunShellsBox",
        "Base.HuntingRifle", "Base.308Box", "Base.Pistol",
        "Base.Bullets9mmBox", "Base.BaseballBat", "Base.Crowbar",
        "Base.Katana", "Base.Machete", "Base.HolsterSimple"
    },
    tools = {
        "Base.Axe", "Base.Hammer", "Base.Saw", "Base.Screwdriver",
        "Base.Wrench", "Base.WeldingRods", "Base.BlowTorch",
        "Base.Crowbar", "Base.HandTorch", "Base.Battery",
        "Base.Rope", "Base.DuctTape"
    }
}

handlers.airdrop = function(args)
    local x = math.floor(tonumber(args.x) or 0)
    local y = math.floor(tonumber(args.y) or 0)
    local z = 0 -- always ground level
    local preset = args.preset -- "military", "medical", etc.
    local customItems = args.items -- custom item list (array of {itemType, count})
    local announce = args.announce ~= false -- default true
    local attractZombies = args.attractZombies ~= false -- default true
    local soundRadius = math.min(math.max(tonumber(args.soundRadius) or 150, 10), 500)

    -- Validate coordinates are within reasonable PZ world bounds
    if x < 0 or x > 24000 or y < 0 or y > 24000 then
        return false, nil, "Coordinates out of range (valid: 0 to 24000)"
    end
    if x == 0 and y == 0 then
        return false, nil, "Valid x and y coordinates are required"
    end

    -- Validate preset name if provided (whitelist only)
    if preset and not AIRDROP_PRESETS[preset] then
        if customItems == nil then
            return false, nil, "Unknown preset '" .. tostring(preset) .. "'. Valid: military, medical, food, building, weapons, tools"
        end
        preset = nil -- ignore invalid preset if custom items provided
    end

    -- Determine item list
    local itemsToSpawn = {}
    if customItems and type(customItems) == "table" then
        -- Custom item list: [{itemType: "Base.Axe", count: 2}, ...]
        for _, entry in ipairs(customItems) do
            if entry.itemType and type(entry.itemType) == "string" then
                -- Validate item type format: must be "Module.ItemName" pattern
                if not entry.itemType:match("^[%w_]+%.[%w_&%#%+%.%-]+$") then
                    return false, nil, "Invalid item type format: " .. tostring(entry.itemType) .. " (expected Module.ItemName)"
                end
                local count = math.min(math.max(tonumber(entry.count) or 1, 1), 20)
                for i = 1, count do
                    table.insert(itemsToSpawn, entry.itemType)
                end
            end
        end
    elseif preset and AIRDROP_PRESETS[preset] then
        itemsToSpawn = AIRDROP_PRESETS[preset]
    else
        return false, nil, "Either 'preset' (military/medical/food/building/weapons/tools) or 'items' array is required"
    end

    if #itemsToSpawn == 0 then
        return false, nil, "No items to drop"
    end

    -- Clamp total items
    if #itemsToSpawn > 50 then
        local clamped = {}
        for i = 1, 50 do
            clamped[i] = itemsToSpawn[i]
        end
        itemsToSpawn = clamped
    end

    -- Get the grid square at the target location
    local world = getWorld()
    if not world then
        return false, nil, "World not available"
    end

    local cell = world:getCell()
    if not cell then
        return false, nil, "Cell not available"
    end

    local sq = cell:getGridSquare(x, y, z)
    if not sq then
        return false, nil, "Grid square not loaded at " .. x .. "," .. y .. " — a player must be nearby"
    end

    -- Spawn items on the ground
    local added = 0
    local attempted = #itemsToSpawn
    local failedTypes = {}
    for _, itemType in ipairs(itemsToSpawn) do
        local ok, result = pcall(function()
            -- B42+ method: place directly on the ground by item type
            local placedOk, placed = PanelBridge.invoke(sq, "AddWorldInventoryItem", itemType, 0.5, 0.5, 0)
            if placedOk and placed then return placed end
            -- Fallback: use InventoryItemFactory + manual placement
            local item = InventoryItemFactory.CreateItem(itemType)
            if item and PanelBridge.invoke(sq, "AddWorldInventoryItem", item, 0.5, 0.5, 0) then
                return item
            end
            return nil
        end)
        if ok and result then
            added = added + 1
        else
            failedTypes[itemType] = true
        end
    end

    if added == 0 then
        return false, nil, "Failed to spawn any items (" .. attempted .. " attempted). The area may not be loaded or item types may be invalid."
    end

    -- Attract zombies with a loud sound
    if attractZombies then
        pcall(function()
            addSound(nil, x, y, z, soundRadius, 200)
        end)
    end

    -- Announce to all players
    if announce then
        pcall(function()
            local presetName = preset and (preset:sub(1,1):upper() .. preset:sub(2)) or "Custom"
            local msg = "[AIRDROP] " .. presetName .. " supply drop at coordinates " .. x .. ", " .. y .. "!"
            if sendServerMessage then
                sendServerMessage(msg)
            end
        end)
    end

    PanelBridge.info("Airdrop deployed", { x = x, y = y, preset = preset, itemCount = added, attempted = attempted })
    local failedCount = attempted - added
    -- Collect unique failed type names for diagnostics
    local failedList = {}
    for typeName, _ in pairs(failedTypes) do
        table.insert(failedList, typeName)
    end
    return true, {
        message = "Airdrop deployed: " .. added .. "/" .. attempted .. " items at " .. x .. ", " .. y,
        x = x,
        y = y,
        itemCount = added,
        attempted = attempted,
        failed = failedCount,
        failedTypes = #failedList > 0 and failedList or nil,
        preset = preset or "custom"
    }
end

-- ============================================
-- ZOMBIE MANAGEMENT HANDLERS
-- ============================================

-- Get zombie count in loaded cells
handlers.getZombieCount = function(args)
    local world = getWorld()
    if not world then
        return false, nil, "World not available"
    end

    local cell = world:getCell()
    if not cell then
        return false, nil, "Cell not available"
    end

    local zombieCount = 0
    local ok, list = pcall(function()
        return cell:getZombieList()
    end)

    if ok and list then
        zombieCount = list:size()
    end

    return true, {
        zombieCount = zombieCount,
        note = "Count is for currently loaded cells only"
    }
end

-- Clear zombies around a player
handlers.clearZombiesNearPlayer = function(args)
    local username = args.username
    local radius = tonumber(args.radius) or 50

    if not username then
        return false, nil, "Username required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local px, py, pz = player:getX(), player:getY(), player:getZ()
    local world = getWorld()
    local cell = world and world:getCell()

    if not cell then
        return false, nil, "Could not access world cell"
    end

    local removed = 0
    local ok, err = pcall(function()
        local zombies = cell:getZombieList()
        if zombies then
            -- Iterate backwards to safely remove
            for i = zombies:size() - 1, 0, -1 do
                local zombie = zombies:get(i)
                if zombie then
                    pcall(function()
                        local zx, zy, zz = zombie:getX(), zombie:getY(), zombie:getZ()
                        if zx and zy and zz then
                            local dist = math.sqrt((zx - px)^2 + (zy - py)^2 + (zz - pz)^2)
                            if dist <= radius then
                                zombie:removeFromSquare()
                                zombie:removeFromWorld()
                                removed = removed + 1
                            end
                        end
                    end)
                end
            end
        end
    end)

    if not ok then
        PanelBridge.warn("Error clearing zombies", { error = tostring(err) })
    end

    PanelBridge.info("Cleared zombies", { username = username, radius = radius, removed = removed })
    return true, {
        message = "Removed " .. removed .. " zombies",
        radius = radius,
        removed = removed
    }
end

-- Clear ALL zombies in loaded cells
handlers.clearAllZombies = function(args)
    local world = getWorld()
    if not world then
        return false, nil, "World not available"
    end

    -- Try ForceKillAllZombies first (reliable in both B41 and B42)
    local removed = 0
    local usedForceKill = PanelBridge.invoke(world, "ForceKillAllZombies") and true or false

    -- Fallback: manual removal from cell zombie list
    if not usedForceKill then
        local cell = world:getCell()
        if not cell then
            return false, nil, "Could not access world cell"
        end
        local ok, err = pcall(function()
            local zombies = cell:getZombieList()
            if zombies then
                for i = zombies:size() - 1, 0, -1 do
                    local zombie = zombies:get(i)
                    if zombie then
                        pcall(function()
                            zombie:removeFromSquare()
                            zombie:removeFromWorld()
                            removed = removed + 1
                        end)
                    end
                end
            end
        end)
        if not ok then
            PanelBridge.warn("Error clearing zombies manually", { error = tostring(err) })
        end
    end

    PanelBridge.warn("Cleared zombies", { usedForceKill = usedForceKill, manualRemoved = removed })
    return true, {
        message = usedForceKill and "Force-killed all zombies" or ("Removed " .. removed .. " zombies from loaded cells"),
        removed = removed,
        usedForceKill = usedForceKill
    }
end

-- Helper: resolve ZombiePopulationManager (not exposed as global in B42)
local function getZombiePopManager()
    local ZPM = resolveJavaClass("ZombiePopulationManager", "zombie.popman.ZombiePopulationManager")
    if ZPM and ZPM.instance then
        return ZPM.instance
    end
    return nil
end

-- Spawn horde near a player (40-80 tiles away)
handlers.spawnHordeNearPlayer = function(args)
    local username = args.username
    local count = math.floor(tonumber(args.count) or 50)
    count = math.min(math.max(count, 1), 500)

    if not username then
        return false, nil, "Username required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local px, py, pz = player:getX(), player:getY(), player:getZ()

    -- Spawn 15-25 tiles from player — close enough to be inside the player's
    -- loaded chunk radius on any vanilla config, so zombies actually materialize.
    local angle = ZombRand(360) * math.pi / 180
    local dist = 15 + ZombRand(11)
    local cx = math.floor(px + math.cos(angle) * dist)
    local cy = math.floor(py + math.sin(angle) * dist)
    local half = 8
    local method = "unknown"
    local spawned = 0
    local verified = false

    local ok, err = pcall(function()
        -- Primary method for B41+B42: VirtualZombieManager spawns real zombies
        -- one at a time in a radius. More reliable than horde APIs and works
        -- even when createHordeInAreaTo silently no-ops on unloaded chunks.
        local vzm = _G.VirtualZombieManager and _G.VirtualZombieManager.instance
        if vzm and vzm.createRealZombieNow then
            for i = 1, count do
                local dx = ZombRand(half * 2 + 1) - half
                local dy = ZombRand(half * 2 + 1) - half
                local tx = cx + dx
                local ty = cy + dy
                local okZ, zombie = pcall(function()
                    return vzm:createRealZombieNow(tx, ty, pz)
                end)
                if okZ and zombie then spawned = spawned + 1 end
            end
            method = "VirtualZombieManager.createRealZombieNow"
            verified = true
        else
            -- Fallback: ZombiePopulationManager horde APIs (may silently fail
            -- if the area isn't fully loaded on the server). None of these
            -- return a count, so `spawned` must not be set to `count` --
            -- that would be a fabricated number, not an unverified one.
            -- Report which method ran and leave spawned nil (unverified).
            local zpop = getZombiePopManager()
            if zpop and zpop.createHordeInAreaTo then
                zpop:createHordeInAreaTo(cx - half, cy - half, half * 2, half * 2, math.floor(px), math.floor(py), count)
                method = "createHordeInAreaTo"
                spawned = nil
            elseif zpop and zpop.createHordeFromTo then
                zpop:createHordeFromTo(cx, cy, math.floor(px), math.floor(py), count)
                method = "createHordeFromTo"
                spawned = nil
            else
                local world = getWorld()
                if world and world.CreateSwarm then
                    world:CreateSwarm(count, cx - half, cy - half, cx + half, cy + half)
                    method = "CreateSwarm"
                    spawned = nil
                else
                    error("No zombie spawning API available (VirtualZombieManager / ZombiePopulationManager / IsoWorld.CreateSwarm all missing)")
                end
            end
        end
    end)

    if not ok then
        return false, nil, "Failed to spawn horde: " .. tostring(err)
    end

    local verifiedStr = "unverifiable"
    if verified == true then verifiedStr = "confirmed" end

    if verified == true and spawned == 0 then
        PanelBridge.warn("Horde spawn created no zombies", { username = username, count = count, spawned = spawned, verified = verified, cx = cx, cy = cy, method = method })
        return false, nil, "Failed to spawn horde: no zombies were created (0/" .. count .. "); the target area may not be loaded or available"
    end

    PanelBridge.warn("Spawned horde near player", { username = username, count = count, spawned = spawned, verified = verified, cx = cx, cy = cy, method = method })

    return true, {
        message = verified
            and ("Spawned " .. spawned .. "/" .. count .. " zombies near " .. username)
            or ("Requested " .. count .. " zombies near " .. username .. " via " .. method .. " (spawn count not verifiable for this method)"),
        count = count,
        spawned = spawned,
        verified = verifiedStr,
        center = { x = cx, y = cy },
        distance = dist,
        method = method
    }
end

-- Spawn horde behind a player (based on facing direction)
handlers.spawnHordeBehindPlayer = function(args)
    local username = args.username
    local count = math.floor(tonumber(args.count) or 50)
    count = math.min(math.max(count, 1), 500)

    if not username then
        return false, nil, "Username required"
    end

    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end

    local px, py = player:getX(), player:getY()
    local pz = player:getZ()

    -- Get player facing direction and compute "behind" offset. getDir()
    -- returns the real IsoDirections Java enum, not a string -- vanilla Lua
    -- (client AND server: e.g. server/Animal/ISScytheGrassCursor.lua,
    -- ISPickDungCursor.lua) always COMPARES it by identity (`dir ==
    -- IsoDirections.N`), never via tostring(). The previous version of this
    -- fix replaced a string-keyed `dirMap[tostring(dir)]` lookup with an
    -- identity-keyed `dirMap[dir]` one -- but a TABLE LOOKUP is a different
    -- runtime operation from an `==` COMPARISON: it requires Kahlua to hash
    -- a Java object consistently as a Lua table key, which no vanilla site
    -- was ever found doing (every citation above is a comparison, not a
    -- key). If that assumption were wrong, `dirMap[dir]` would return nil
    -- for every direction and reproduce the EXACT original bug (silent
    -- fallback to facing=N, horde always spawns due south) -- indistinguishable
    -- from working, since nothing here could tell the two failure modes
    -- apart. Rewritten as an if/elseif chain on `==` instead: this uses only
    -- the exact operation the vanilla citations above demonstrate, with no
    -- table-keying assumption at all. Offsets below are the "behind" vector
    -- directly (facing negated), one branch per IsoDirections member.
    local dir = player:getDir()
    local behindX, behindY
    if     dir == IsoDirections.N  then behindX, behindY =  0,  1
    elseif dir == IsoDirections.NE then behindX, behindY = -1,  1
    elseif dir == IsoDirections.E  then behindX, behindY = -1,  0
    elseif dir == IsoDirections.SE then behindX, behindY = -1, -1
    elseif dir == IsoDirections.S  then behindX, behindY =  0, -1
    elseif dir == IsoDirections.SW then behindX, behindY =  1, -1
    elseif dir == IsoDirections.W  then behindX, behindY =  1,  0
    elseif dir == IsoDirections.NW then behindX, behindY =  1,  1
    else   behindX, behindY =  0,  1 -- unknown/nil facing: default as if facing N (matches original intent)
    end
    -- Human-readable direction for the response/logs only -- never fed back
    -- into the branch above. Vanilla always calls :toString() explicitly
    -- for this (never bare tostring()); pcall-guarded the same way this
    -- file treats any not-yet-vanilla-confirmed probe.
    local dirName = "unknown"
    if dir then
        local ok, name = pcall(function() return dir:toString() end)
        if ok and name then dirName = name end
    end

    -- Spawn 15-25 tiles behind — within the player's loaded chunk radius so
    -- VirtualZombieManager actually materialises the zombies.
    local dist = 15 + ZombRand(11)
    local cx = math.floor(px + behindX * dist)
    local cy = math.floor(py + behindY * dist)
    local half = 8
    local method = "unknown"
    local spawned = 0
    local verified = false

    local ok, err = pcall(function()
        local vzm = _G.VirtualZombieManager and _G.VirtualZombieManager.instance
        if vzm and vzm.createRealZombieNow then
            for i = 1, count do
                local dx = ZombRand(half * 2 + 1) - half
                local dy = ZombRand(half * 2 + 1) - half
                local tx = cx + dx
                local ty = cy + dy
                local okZ, zombie = pcall(function()
                    return vzm:createRealZombieNow(tx, ty, pz)
                end)
                if okZ and zombie then spawned = spawned + 1 end
            end
            method = "VirtualZombieManager.createRealZombieNow"
            verified = true
        else
            -- See spawnHordeNearPlayer: these fallback APIs return no count,
            -- so `spawned` must not be set to `count` -- that would be a
            -- fabricated number, not an unverified one.
            local zpop = getZombiePopManager()
            if zpop and zpop.createHordeInAreaTo then
                zpop:createHordeInAreaTo(cx - half, cy - half, half * 2, half * 2, math.floor(px), math.floor(py), count)
                method = "createHordeInAreaTo"
                spawned = nil
            elseif zpop and zpop.createHordeFromTo then
                zpop:createHordeFromTo(cx, cy, math.floor(px), math.floor(py), count)
                method = "createHordeFromTo"
                spawned = nil
            else
                local world = getWorld()
                if world and world.CreateSwarm then
                    world:CreateSwarm(count, cx - half, cy - half, cx + half, cy + half)
                    method = "CreateSwarm"
                    spawned = nil
                else
                    error("No zombie spawning API available")
                end
            end
        end
    end)

    if not ok then
        return false, nil, "Failed to spawn horde behind: " .. tostring(err)
    end

    local verifiedStr = "unverifiable"
    if verified == true then verifiedStr = "confirmed" end

    if verified == true and spawned == 0 then
        PanelBridge.warn("Horde spawn created no zombies", { username = username, count = count, spawned = spawned, verified = verified, direction = dirName, cx = cx, cy = cy, method = method })
        return false, nil, "Failed to spawn horde behind: no zombies were created (0/" .. count .. "); the target area may not be loaded or available"
    end

    PanelBridge.warn("Spawned horde behind player", { username = username, count = count, spawned = spawned, verified = verified, direction = dirName, cx = cx, cy = cy, method = method })

    return true, {
        message = verified
            and ("Spawned " .. spawned .. "/" .. count .. " zombies behind " .. username)
            or ("Requested " .. count .. " zombies behind " .. username .. " via " .. method .. " (spawn count not verifiable for this method)"),
        count = count,
        spawned = spawned,
        verified = verifiedStr,
        center = { x = cx, y = cy },
        playerDirection = dirName,
        distance = dist,
        method = method
    }
end

-- ============================================
-- SAFEHOUSE MANAGEMENT HANDLERS
-- ============================================

local function findSafehouseByRef(ref)
    if not ref then return nil, "safehouseRef required" end
    if not SafeHouse or not SafeHouse.getSafehouseList then
        return nil, "SafeHouse API not available"
    end

    local list = SafeHouse.getSafehouseList()
    if not list then return nil, "No safehouses found" end

    local refStr = tostring(ref)
    for i = 0, list:size() - 1 do
        local sh = list:get(i)
        if sh then
            local idOk, sid = pcall(function() return sh:getId() end)
            local titleOk, title = pcall(function() return sh:getTitle() end)
            if not idOk then sid = nil end
            if not titleOk then title = nil end
            if tostring(sid) == refStr or tostring(title) == refStr then
                return sh
            end
        end
    end

    return nil, "Safehouse not found: " .. refStr
end

handlers.getSafehouses = function(args)
    if not SafeHouse or not SafeHouse.getSafehouseList then
        return false, nil, "SafeHouse API not available"
    end

    local list = SafeHouse.getSafehouseList()
    local out = {}
    if list then
        for i = 0, list:size() - 1 do
            local sh = list:get(i)
            if sh then
                -- Collect allowed players
                local players = {}
                pcall(function()
                    local pList = sh:getPlayers()
                    if pList then
                        for j = 0, pList:size() - 1 do
                            table.insert(players, tostring(pList:get(j)))
                        end
                    end
                end)

                table.insert(out, {
                    id = safeGetValue(sh, "getId", nil),
                    title = safeGetValue(sh, "getTitle", nil),
                    owner = safeGetValue(sh, "getOwner", nil),
                    x = safeGetValue(sh, "getX", nil),
                    y = safeGetValue(sh, "getY", nil),
                    w = safeGetValue(sh, "getW", nil),
                    h = safeGetValue(sh, "getH", nil),
                    players = players,
                    playerConnected = safeGetValue(sh, "getPlayerConnected", 0),
                    lastVisited = safeGetValue(sh, "getLastVisited", nil)
                })
            end
        end
    end

    return true, { safehouses = out, count = #out }
end

handlers.safehouseAddPlayer = function(args)
    local sh, err = findSafehouseByRef(args.safehouseRef)
    if not sh then return false, nil, err end

    local username = normalizeMessage(args.username, 64)
    if not username then return false, nil, "Username required" end

    local ok, addErr = pcall(function()
        sh:addPlayer(username)
    end)
    if not ok then
        return false, nil, "Failed to add player to safehouse: " .. tostring(addErr)
    end

    -- SafeHouse.addPlayer is declared void (confirmed 2026-08-23 against
    -- the real B42 jar), so the only way to check it actually happened is
    -- to read the membership list back via getPlayers() (also confirmed
    -- present, and already used by handlers.getSafehouses).
    local verified
    local ok2, players = pcall(function() return sh:getPlayers() end)
    if ok2 and players then
        local found = false
        local ok3 = pcall(function()
            for i = 0, players:size() - 1 do
                if tostring(players:get(i)) == username then
                    found = true
                    break
                end
            end
        end)
        if ok3 then verified = found end
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Player added to safehouse", safehouseRef = args.safehouseRef, username = username },
        "Add player call succeeded but " .. username .. " is not in the safehouse player list")
end

handlers.safehouseRemovePlayer = function(args)
    local sh, err = findSafehouseByRef(args.safehouseRef)
    if not sh then return false, nil, err end

    local username = normalizeMessage(args.username, 64)
    if not username then return false, nil, "Username required" end

    local ok, removeErr = pcall(function()
        sh:removePlayer(username)
    end)
    if not ok then
        return false, nil, "Failed to remove player from safehouse: " .. tostring(removeErr)
    end

    -- Same void-method situation as safehouseAddPlayer -- verify via the
    -- membership list read-back instead.
    local verified
    local ok2, players = pcall(function() return sh:getPlayers() end)
    if ok2 and players then
        local found = false
        local ok3 = pcall(function()
            for i = 0, players:size() - 1 do
                if tostring(players:get(i)) == username then
                    found = true
                    break
                end
            end
        end)
        if ok3 then verified = not found end
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Player removed from safehouse", safehouseRef = args.safehouseRef, username = username },
        "Remove player call succeeded but " .. username .. " is still in the safehouse player list")
end

handlers.safehouseSetOwner = function(args)
    local sh, err = findSafehouseByRef(args.safehouseRef)
    if not sh then return false, nil, err end

    local owner = normalizeMessage(args.owner, 64)
    if not owner then return false, nil, "Owner username required" end

    local ok, setErr = pcall(function()
        sh:setOwner(owner)
    end)
    if not ok then
        return false, nil, "Failed to set safehouse owner: " .. tostring(setErr)
    end

    -- SafeHouse.setOwner is declared void; getOwner() (confirmed present,
    -- also used by handlers.getSafehouses) reads the real result back.
    local ok2, actualOwner = pcall(function() return sh:getOwner() end)
    local verified
    if not ok2 then
        verified = nil
    elseif actualOwner == owner then
        verified = true
    else
        verified = false
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Safehouse owner updated", safehouseRef = args.safehouseRef, owner = owner },
        "Set owner call succeeded but safehouse owner is still " .. tostring(actualOwner))
end

handlers.safehouseSetRespawn = function(args)
    local sh, err = findSafehouseByRef(args.safehouseRef)
    if not sh then return false, nil, err end

    local username = normalizeMessage(args.username, 64)
    if not username then return false, nil, "Username required" end
    local enabled = args.enabled == true

    local ok, setErr = pcall(function()
        sh:setRespawnInSafehouse(enabled, username)
    end)
    if not ok then
        return false, nil, "Failed to set safehouse respawn: " .. tostring(setErr)
    end

    -- SafeHouse.setRespawnInSafehouse is declared void; isRespawnInSafehouse
    -- (confirmed present on the real B42 jar, takes the same username) reads
    -- the real per-player result back.
    local ok2, actualRespawn = pcall(function() return sh:isRespawnInSafehouse(username) end)
    local verified
    if not ok2 then
        verified = nil
    elseif actualRespawn == enabled then
        verified = true
    else
        verified = false
    end

    return PanelBridge.verifiedResult(verified, {
        message = "Safehouse respawn updated",
        safehouseRef = args.safehouseRef,
        username = username,
        enabled = enabled
    }, "Set respawn call succeeded but did not take effect (still " .. tostring(actualRespawn) .. ")")
end

-- ============================================
-- FACTION MANAGEMENT HANDLERS
-- ============================================

handlers.getFactions = function(args)
    if not Faction or not Faction.getFactions then
        return false, nil, "Faction API not available"
    end

    local factions = Faction.getFactions()
    local out = {}
    if factions then
        for i = 0, factions:size() - 1 do
            local f = factions:get(i)
            if f then
                local players = {}
                local playersOk, fPlayers = pcall(function() return f:getPlayers() end)
                if not playersOk then fPlayers = nil end
                if fPlayers then
                    for j = 0, fPlayers:size() - 1 do
                        table.insert(players, tostring(fPlayers:get(j)))
                    end
                end
                table.insert(out, {
                    name = safeGetValue(f, "getName", nil),
                    owner = safeGetValue(f, "getOwner", nil),
                    tag = safeGetValue(f, "getTag", nil),
                    players = players,
                    playerCount = #players
                })
            end
        end
    end

    return true, { factions = out, count = #out }
end

handlers.createFaction = function(args)
    if not Faction or not Faction.createFaction then
        return false, nil, "Faction API not available"
    end

    local name = normalizeMessage(args.name, 64)
    local owner = normalizeMessage(args.owner, 64)
    if not name then return false, nil, "Faction name required" end
    if not owner then return false, nil, "Faction owner required" end

    -- Pre-check: faction name already taken
    if Faction.factionExist and Faction.factionExist(name) then
        return false, nil, "A faction named '" .. name .. "' already exists"
    end

    -- Pre-check: owner already in a faction
    if Faction.isAlreadyInFaction then
        local alreadyIn = false
        local okChk, _ = pcall(function() alreadyIn = Faction.isAlreadyInFaction(owner) end)
        if okChk and alreadyIn then
            local existingName = ""
            pcall(function()
                local f = Faction.getPlayerFaction(owner)
                if f then existingName = " (" .. tostring(f:getName()) .. ")" end
            end)
            return false, nil, "Owner '" .. owner .. "' is already in a faction" .. existingName
        end
    end

    -- Faction.createFaction does not exist ANYWHERE in the real B42 jar --
    -- confirmed 2026-08-23 by scanning every one of the jar's 23,740 class
    -- files for a method literally named createFaction: zero hits. (Two
    -- near-miss names exist on Faction itself, canCreateFaction() -- a
    -- permission check, not a creator -- and the unrelated createFactionChat.)
    -- FactionCreatePacket.class exists, suggesting real faction creation on
    -- B42 goes through a network packet flow rather than a direct Lua-callable
    -- method -- not investigated further here (out of scope for a
    -- verification-gating pass; a real replacement would need someone to
    -- trace that packet handler). The guard above and the pcall below already
    -- make this fail safely and honestly every time (verified: this returns
    -- ok=false, not a false success) -- nothing to fix for THIS audit's
    -- purposes, but "Create Faction" has likely never worked on a B42 server.
    local ok, factionOrErr = pcall(function()
        return Faction.createFaction(name, owner)
    end)
    if not ok then
        return false, nil, "Failed to create faction: " .. tostring(factionOrErr)
    end

    if not factionOrErr then
        return false, nil, "Faction creation failed (name may be taken or owner ineligible)"
    end

    -- Sync to clients
    PanelBridge.invoke(factionOrErr, "syncFaction")

    return true, { message = "Faction '" .. name .. "' created with owner '" .. owner .. "'", name = name, owner = owner }
end

handlers.factionAddPlayer = function(args)
    if not Faction or not Faction.getFaction then
        return false, nil, "Faction API not available"
    end

    local factionName = normalizeMessage(args.factionName, 64)
    local username = normalizeMessage(args.username, 64)
    if not factionName then return false, nil, "factionName required" end
    if not username then return false, nil, "username required" end

    local faction = Faction.getFaction(factionName)
    if not faction then return false, nil, "Faction not found: " .. factionName end

    local ok, err = pcall(function()
        faction:addPlayer(username)
    end)
    if not ok then
        return false, nil, "Failed to add player to faction: " .. tostring(err)
    end

    -- Faction.addPlayer is declared void (confirmed 2026-08-23 against the
    -- real B42 jar), so isMember(username) (also confirmed present) is the
    -- only way to check the add actually took effect.
    local ok2, isMemberNow = pcall(function() return faction:isMember(username) end)
    local verified
    if not ok2 then
        verified = nil
    else
        verified = (isMemberNow == true)
    end

    -- No syncFaction call here (there used to be one -- it silently no-opped
    -- every time). zombie.characters.Faction has no method named or spelled
    -- anything like sync/transmit/propagate/broadcast/update anywhere in its
    -- class or superclass chain -- confirmed against the real B42 jar
    -- including a constant-pool scan for the literal spellings, not just a
    -- guessed-name miss (Kevin's audit, 2026-08-30). The real client-sync
    -- path for a faction change is a network packet handler
    -- (FactionAcceptPacket / FactionRemoveMemberPacket /
    -- FactionChangeTagPacket), and that path is unreachable from ANY Lua --
    -- client or server -- confirmed by grepping the entire shipped media/lua
    -- tree for every packet/broadcast name involved: zero hits. This mutation
    -- is real and durable (isMember above just confirmed it server-side), but
    -- no mechanism this file can call propagates it to already-connected
    -- clients, so the result says that plainly instead of a clean success.
    local data = {
        message = "Player added to faction (applied server-side only -- not pushed to already-connected clients; they will see it on reconnect)",
        factionName = factionName,
        username = username,
        synced = false
    }
    return PanelBridge.verifiedResult(verified, data,
        "Add player call succeeded but " .. username .. " is not a faction member")
end

handlers.factionRemovePlayer = function(args)
    if not Faction or not Faction.getFaction then
        return false, nil, "Faction API not available"
    end

    local factionName = normalizeMessage(args.factionName, 64)
    local username = normalizeMessage(args.username, 64)
    if not factionName then return false, nil, "factionName required" end
    if not username then return false, nil, "username required" end

    local faction = Faction.getFaction(factionName)
    if not faction then return false, nil, "Faction not found: " .. factionName end

    local ok, err = pcall(function()
        faction:removePlayer(username)
    end)
    if not ok then
        return false, nil, "Failed to remove player from faction: " .. tostring(err)
    end

    -- Same void-method situation as factionAddPlayer -- verify via isMember.
    local ok2, isMemberNow = pcall(function() return faction:isMember(username) end)
    local verified
    if not ok2 then
        verified = nil
    else
        verified = (isMemberNow == false)
    end

    -- No syncFaction call -- see factionAddPlayer's comment above for why:
    -- the method does not exist on Faction (jar-confirmed, no near-miss
    -- spelling), and the real client-sync path is unreachable from any Lua.
    -- Same honest-result treatment: the mutation is real, propagation is not.
    local data = {
        message = "Player removed from faction (applied server-side only -- not pushed to already-connected clients; they will see it on reconnect)",
        factionName = factionName,
        username = username,
        synced = false
    }
    return PanelBridge.verifiedResult(verified, data,
        "Remove player call succeeded but " .. username .. " is still a faction member")
end

handlers.factionSetTag = function(args)
    if not Faction or not Faction.getFaction then
        return false, nil, "Faction API not available"
    end

    local factionName = normalizeMessage(args.factionName, 64)
    local tag = normalizeMessage(args.tag, 8)
    if not factionName then return false, nil, "factionName required" end
    if not tag then return false, nil, "tag required" end

    local faction = Faction.getFaction(factionName)
    if not faction then return false, nil, "Faction not found: " .. factionName end

    local ok, err = pcall(function()
        faction:setTag(tag)
    end)
    if not ok then
        return false, nil, "Failed to set faction tag: " .. tostring(err)
    end

    -- Faction.setTag is declared void; getTag() (confirmed present on the
    -- real B42 jar) reads the real result back.
    local ok2, actualTag = pcall(function() return faction:getTag() end)
    local verified
    if not ok2 then
        verified = nil
    elseif actualTag == tag then
        verified = true
    else
        verified = false
    end

    -- No syncFaction call -- see factionAddPlayer's comment above for why:
    -- the method does not exist on Faction (jar-confirmed, no near-miss
    -- spelling), and the real client-sync path is unreachable from any Lua.
    -- Same honest-result treatment: the mutation is real, propagation is not.
    local data = {
        message = "Faction tag updated (applied server-side only -- not pushed to already-connected clients; they will see it on reconnect)",
        factionName = factionName,
        tag = tag,
        synced = false
    }
    return PanelBridge.verifiedResult(verified, data,
        "Set tag call succeeded but faction tag is still " .. tostring(actualTag))
end

handlers.removeFaction = function(args)
    if not Faction or not Faction.getFaction then
        return false, nil, "Faction API not available"
    end

    local factionName = normalizeMessage(args.factionName, 64)
    if not factionName then return false, nil, "factionName required" end

    local faction = Faction.getFaction(factionName)
    if not faction then return false, nil, "Faction not found: " .. factionName end

    -- faction:removeFaction does not exist ANYWHERE in the real B42 jar --
    -- same full-jar scan as createFaction's comment above, zero hits. See
    -- that comment for the FactionCreatePacket/FactionDisbandPacket lead
    -- that was not chased further here. Fails safely and honestly today
    -- (ok=false, not a false success) -- "Remove Faction" has likely never
    -- worked on a B42 server either.
    local ok, err = pcall(function()
        faction:removeFaction()
    end)
    if not ok then
        return false, nil, "Failed to remove faction: " .. tostring(err)
    end

    return true, { message = "Faction removed", factionName = factionName }
end

-- ============================================
-- VEHICLE TRIAGE & RECOVERY HANDLERS
-- ============================================

local function getVehiclesList()
    local world = getWorld()
    if not world then return nil end
    local cellOk, cell = PanelBridge.invoke(world, "getCell")
    if not cellOk or not cell then return nil end
    local listOk, vehicles = PanelBridge.invoke(cell, "getVehicles")
    if not listOk then return nil end
    return vehicles
end

-- Returns the vehicle count, or nil when the list cannot be measured.
local function vehicleCount(vehicles)
    local ok, size = PanelBridge.invoke(vehicles, "size")
    if not ok then return nil end
    return tonumber(size)
end

-- The vehicle list exposes get(i) as a callable method but not always as an
-- indexable field, so it must be called rather than field-tested. See
-- PanelBridge.invoke for how a genuinely missing method is handled.
local function vehicleAt(vehicles, i)
    local ok, v = PanelBridge.invoke(vehicles, "get", i)
    if ok then return v end
    return nil
end

-- IsoCell.getVehicles()'s own compile-time descriptor declares java.util.Set
-- -- a JDK interface with NO get(int) at all -- yet PanelBridge.lua has
-- always called size()/get(i) on the result, matching real vanilla CLIENT
-- Lua (ISVehicleBloodUI.lua) which does the same unconditionally. The
-- concrete RUNTIME object PZ's Lua binding hands back is reflected against,
-- not the declared type, so which shape actually comes back cannot be
-- settled without a live server (Kevin's jar audit, 2026-08-30 -- correctly
-- left unresolved rather than guessed). 2026-08-30 operator ruling: don't
-- answer the question, make the code correct under EITHER answer.
--
-- This collects every reachable vehicle into a plain Lua array regardless of
-- which shape the collection turns out to be: it tries size()+get(i) first
-- (works if the runtime object is List-shaped, or a Set-lookalike that still
-- exposes get(i)), and if that yields nothing despite a nonzero size, falls
-- back to the iterator()/hasNext()/next() protocol that EVERY
-- java.util.Collection guarantees -- List and genuine Set alike -- unlike
-- get(i), which only List guarantees. So it no longer matters which one
-- IsoCell.getVehicles() actually returns.
--
-- Returns (list, nil) on success -- list is `{}` when there really are zero
-- vehicles, which is a legitimate, different outcome from failure. Returns
-- (nil, errorMessage) only when size() itself cannot be read, or when size()
-- reports vehicles exist but NEITHER access pattern could read even one of
-- them -- that combination means this build's vehicle-list object supports
-- neither shape this bridge knows, and every caller must fail loudly instead
-- of silently reporting zero vehicles as if none existed.
local function collectVehicles(vehicles)
    local size = vehicleCount(vehicles)
    if not size then return nil, "Vehicle list size lookup failed" end
    if size == 0 then return {}, nil end

    local out = {}
    for i = 0, size - 1 do
        local v = vehicleAt(vehicles, i)
        if v then table.insert(out, v) end
    end
    if #out > 0 then return out, nil end

    local iterOk, iterator = PanelBridge.invoke(vehicles, "iterator")
    if iterOk and iterator then
        while true do
            local hasNextOk, hasNext = PanelBridge.invoke(iterator, "hasNext")
            if not hasNextOk or not hasNext then break end
            local nextOk, item = PanelBridge.invoke(iterator, "next")
            if not nextOk or not item then break end
            table.insert(out, item)
        end
    end
    if #out > 0 then return out, nil end

    return nil, "size() reported " .. size ..
        " vehicle(s) but neither get(i) nor iterator() could read any of them " ..
        "-- this build's vehicle-list object exposes neither access pattern this bridge knows"
end

-- Reads a single vehicle property, returning nil when it is unavailable.
local function vehicleGet(v, methodName)
    local ok, value = PanelBridge.invoke(v, methodName)
    if ok then return value end
    return nil
end

-- getPartCount/getPartByIndex/getPartById/getBattery/getBatteryCharge live on
-- zombie.vehicles.VehicleParts, reachable ONLY via vehicle:getParts() -- they
-- are NOT on the vehicle object itself (zombie.vehicles.BaseVehicle). Every
-- call to one of those five methods must go through this, or it silently
-- returns nil despite the method genuinely existing (2026-08-30, Kevin's jar
-- audit: it just doesn't exist on the object being asked). getParts() can
-- itself return nil (no parts container), so every caller must still treat
-- the result as optional.
local function vehicleParts(vehicle)
    return PanelBridge.tryGet(vehicle, "getParts")
end

-- Returns (vehicle, nil) on success, (nil, err) on failure -- and "not
-- found" IS a real, distinct err (not just a bare nil) so callers can tell
-- "no vehicle has this id" apart from "the vehicle list itself could not be
-- read", which collectVehicles() may report separately. Discarding the
-- second return here used to collapse both into a bare nil, so every one of
-- this function's 8 callers (removeVehicle, vehicleRepair, vehicleHotwire,
-- vehicleSetFuel, vehicleSetBattery, vehicleSetSiren, vehicleSetAlarm,
-- vehicleSetTrunkLocked) reported "Vehicle not found" even when the real
-- cause was an unreadable collection -- sending an admin hunting a
-- vehicle-id problem that did not exist (god's catch, 2026-08-30, on code
-- written 20 minutes earlier in this same file).
local function findVehicleById(vehicleId)
    local vehicles = getVehiclesList()
    if not vehicles then return nil, "Vehicle list not available" end

    local targetId = tonumber(vehicleId)
    if not targetId then return nil, "Invalid vehicle id" end

    local list, collectErr = collectVehicles(vehicles)
    if not list then return nil, collectErr end

    for _, v in ipairs(list) do
        local idOk, id = PanelBridge.invoke(v, "getId")
        if idOk and tonumber(id) == targetId then
            return v
        end
    end
    return nil, "Vehicle not found: " .. tostring(vehicleId)
end

handlers.getVehiclesDetailed = function(args)
    -- Wrap the list lookup itself: getVehiclesList() / vehicles:size() can
    -- throw java.lang.RuntimeException on some modded servers (broken Ki5
    -- vehicles, missing scripts, etc.) BEFORE the per-vehicle pcall below
    -- gets a chance to fire. Without this outer guard, the entire handler
    -- crashes and the panel loses all vehicle visibility.
    local listOk, vehicles = pcall(getVehiclesList)
    if not listOk then
        return false, nil, "Vehicle list lookup failed: " .. tostring(vehicles)
    end
    if not vehicles then
        return false, nil, "Vehicle list not available"
    end

    -- collectVehicles() tries indexed get(i) first and falls back to
    -- iterator() if that yields nothing despite a nonzero size -- see its own
    -- comment for why (the runtime type behind IsoCell.getVehicles() is not
    -- confirmed, and this must work under either shape). A nil return here
    -- means it genuinely could not read the collection at all, which is
    -- different from "zero vehicles exist" and must not be reported as one.
    local list, collectErr = collectVehicles(vehicles)
    if not list then
        return false, nil, "Vehicle list lookup failed: " .. collectErr
    end

    local out = {}
    local skipped = 0
    for _, v in ipairs(list) do
        -- Wrap each vehicle individually: a single broken modded vehicle
        -- (e.g. Ki5 cars whose getters throw java.lang.RuntimeException)
        -- must not bring down the whole detail query, otherwise the panel
        -- loses visibility of every vehicle on the server.
        local ok, entry = pcall(function()
            -- Each getter is independently guarded so one broken accessor
            -- (e.g. a missing battery part on a modded vehicle) doesn't
            -- void the whole row.
            local function get(methodName)
                return vehicleGet(v, methodName)
            end
            -- getLightbarSirenMode does not exist on BaseVehicle in the real
            -- B42 jar (confirmed 2026-08-30, cross-checked against the same
            -- jar that also confirmed isAlarmed/isTrunkLocked genuinely DO
            -- exist -- this field alone was dead, not the whole trio).
            -- getLightbarSirenModeObject() is the real accessor; it returns
            -- a LightbarSirenMode wrapper whose own get():int is the same
            -- primitive this code already wants. Two-hop, both hops via
            -- tryGet (already nil-safe: PanelBridge.invoke itself treats a
            -- nil object as a clean failure, not a throw), since vehicleGet
            -- above only calls a method on `v` itself, not on an
            -- intermediate object a first call returns.
            local sirenModeObj = PanelBridge.tryGet(v, "getLightbarSirenModeObject")
            local sirenLevel = tonumber(PanelBridge.tryGet(sirenModeObj, "get")) or 0
            -- getBatteryCharge is a VehicleParts method, not a vehicle
            -- method -- see vehicleParts(). Every other get() call here
            -- targets a real BaseVehicle method and is unaffected.
            local parts = vehicleParts(v)
            return {
                id = get("getId"),
                x = get("getX"),
                y = get("getY"),
                z = get("getZ"),
                scriptName = get("getScriptName"),
                type = get("getVehicleType"),
                speedKmh = get("getCurrentSpeedKmHour") or 0,
                batteryCharge = parts and PanelBridge.tryGet(parts, "getBatteryCharge") or nil,
                fuelPct = get("getRemainingFuelPercentage"),
                alarmed = get("isAlarmed") == true,
                sirening = sirenLevel > 0,
                trunkLocked = get("isTrunkLocked") == true
            }
        end)
        if ok and entry then
            table.insert(out, entry)
        else
            skipped = skipped + 1
        end
    end

    return true, { vehicles = out, count = #out, skipped = skipped }
end

handlers.vehicleRepair = function(args)
    local vehicle, findErr = findVehicleById(args.vehicleId)
    if not vehicle then return false, nil, findErr or "Vehicle not found" end

    local ok, repairedOrErr = pcall(function()
        -- getPartCount/getPartByIndex are VehicleParts methods, not vehicle
        -- methods -- see vehicleParts(). Before this fix they were called
        -- directly on `vehicle`, always returned nil, and this handler could
        -- never repair anything on ANY vehicle regardless of real part
        -- condition (2026-08-30, Kevin's jar audit).
        local parts = vehicleParts(vehicle)
        if not parts then
            error("Vehicle has no accessible parts container (getParts() returned nothing on this build)")
        end
        local partCount = tonumber(PanelBridge.tryGet(parts, "getPartCount")) or 0
        local repaired = 0
        for i = 0, partCount - 1 do
            local part = PanelBridge.tryGet(parts, "getPartByIndex", i)
            if part then
                local item = PanelBridge.tryGet(part, "getInventoryItem")
                local condition = (item and tonumber(PanelBridge.tryGet(item, "getConditionMax"))) or 100
                -- Only count a part whose condition actually applied.
                if PanelBridge.invoke(part, "setCondition", condition) then
                    if item then
                        PanelBridge.invoke(item, "setCondition", condition)
                        PanelBridge.invoke(part, "doInventoryItemStats", item,
                            PanelBridge.tryGet(part, "getMechanicSkillInstaller"))
                    end
                    PanelBridge.invoke(vehicle, "transmitPartCondition", part)
                    if item then PanelBridge.invoke(vehicle, "transmitPartItem", part) end
                    PanelBridge.invoke(vehicle, "transmitPartModData", part)
                    repaired = repaired + 1
                end
            end
        end
        if repaired == 0 then
            -- Name the REAL reason instead of the old blanket "No repairable
            -- vehicle parts available", which used to fire on every single
            -- call (wrong receiver, not an actual absence of parts) and sent
            -- the operator looking for a vehicle problem that didn't exist.
            if partCount == 0 then
                error("This vehicle reports 0 parts -- nothing to repair")
            else
                error("Found " .. partCount .. " part(s) but none accepted a repaired condition (setCondition failed on all of them)")
            end
        end
        PanelBridge.invoke(vehicle, "updatePartStats")
        PanelBridge.invoke(vehicle, "updateBulletStats")
        return repaired
    end)
    if not ok then return false, nil, "Vehicle repair failed: " .. tostring(repairedOrErr) end

    return true, { message = "Vehicle repaired", vehicleId = tonumber(args.vehicleId), parts = repairedOrErr }
end

handlers.vehicleSetAlarm = function(args)
    local vehicle, findErr = findVehicleById(args.vehicleId)
    if not vehicle then return false, nil, findErr or "Vehicle not found" end
    local enabled = args.enabled == true

    local ok, err = pcall(function()
        if not PanelBridge.invoke(vehicle, "setAlarmed", enabled) then
            error("setAlarmed not available")
        end
        if enabled then PanelBridge.invoke(vehicle, "triggerAlarm") end
    end)
    if not ok then return false, nil, "Failed to update vehicle alarm: " .. tostring(err) end

    -- isAlarmed is already read elsewhere in this file (getVehiclesDetailed)
    -- -- reuse it here to confirm the write actually took effect.
    local okGet, actualAlarmed = PanelBridge.invoke(vehicle, "isAlarmed")
    local verified
    if not okGet then
        verified = nil
    else
        verified = ((actualAlarmed == true) == enabled)
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Vehicle alarm updated", vehicleId = tonumber(args.vehicleId), enabled = enabled },
        "Alarm call succeeded but did not take effect (still " .. tostring(actualAlarmed) .. ")")
end

handlers.vehicleSetSiren = function(args)
    local vehicle, findErr = findVehicleById(args.vehicleId)
    if not vehicle then return false, nil, findErr or "Vehicle not found" end

    local mode = tonumber(args.mode)
    if not mode then mode = (args.enabled == false and 0 or 1) end

    local ok, err = pcall(function()
        if not PanelBridge.invoke(vehicle, "setLightbarSirenMode", mode) then
            error("setLightbarSirenMode not available")
        end
    end)
    if not ok then return false, nil, "Failed to set vehicle siren mode: " .. tostring(err) end

    -- getLightbarSirenMode does not exist on BaseVehicle (see
    -- getVehiclesDetailed's own comment above for the jar evidence) --
    -- getLightbarSirenModeObject().get() is the real two-hop path, same as
    -- that read side now uses, so `verified` can finally reach true instead
    -- of being permanently pinned at nil/"unverifiable".
    local sirenModeObj = PanelBridge.tryGet(vehicle, "getLightbarSirenModeObject")
    local actualMode = tonumber(PanelBridge.tryGet(sirenModeObj, "get"))
    local verified
    if actualMode == nil then
        verified = nil
    else
        verified = (actualMode == mode)
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Vehicle siren mode updated", vehicleId = tonumber(args.vehicleId), mode = mode },
        "Siren mode call succeeded but did not take effect (still " .. tostring(actualMode) .. ")")
end

handlers.vehicleSetTrunkLocked = function(args)
    local vehicle, findErr = findVehicleById(args.vehicleId)
    if not vehicle then return false, nil, findErr or "Vehicle not found" end
    local locked = args.locked == true

    local ok, err = pcall(function()
        if not PanelBridge.invoke(vehicle, "setTrunkLocked", locked) then
            error("setTrunkLocked not available")
        end
    end)
    if not ok then return false, nil, "Failed to set trunk lock state: " .. tostring(err) end

    -- isTrunkLocked is already read elsewhere in this file (getVehiclesDetailed)
    -- -- reuse it here to confirm the write actually took effect.
    local okGet, actualLocked = PanelBridge.invoke(vehicle, "isTrunkLocked")
    local verified
    if not okGet then
        verified = nil
    else
        verified = ((actualLocked == true) == locked)
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Vehicle trunk lock updated", vehicleId = tonumber(args.vehicleId), locked = locked },
        "Trunk lock call succeeded but did not take effect (still " .. tostring(actualLocked) .. ")")
end

handlers.vehicleSetFuel = function(args)
    local vehicle, findErr = findVehicleById(args.vehicleId)
    if not vehicle then return false, nil, findErr or "Vehicle not found" end

    local pct = tonumber(args.percent)
    if not pct then return false, nil, "percent required (0-100)" end
    pct = math.min(math.max(pct, 0), 100)

    local ok, err = pcall(function()
        -- B42: fuel is stored as container content amount on the GasTank part
        -- Pattern from Vehicles.Create.GasTank / Vehicles.Update.GasTank.
        -- getPartById is a VehicleParts method, not a vehicle method -- see
        -- vehicleParts() (2026-08-30, Kevin's jar audit: wrong receiver meant
        -- this always fell through to the B41 fallback below, silently).
        local parts = vehicleParts(vehicle)
        local part = parts and PanelBridge.tryGet(parts, "getPartById", "GasTank")
        local capacity = part and tonumber(PanelBridge.tryGet(part, "getContainerCapacity"))
        if capacity and capacity > 0 then
            local amount = capacity * pct / 100
            if PanelBridge.invoke(part, "setContainerContentAmount", amount) then
                PanelBridge.invoke(vehicle, "transmitPartModData", part)
                return -- B42 success
            end
        end
        -- B41 fallback (also used if B42 GasTank has no capacity)
        if not PanelBridge.invoke(vehicle, "setRemainingFuelPercentage", pct) then
            error("No fuel setter available")
        end
    end)
    if not ok then return false, nil, "Failed to set fuel: " .. tostring(err) end

    -- getRemainingFuelPercentage is already read elsewhere in this file
    -- (getVehiclesDetailed) -- reuse it to confirm the write took effect.
    -- 1.0 percentage-point tolerance is float/rounding slack on a 0-100
    -- scale, not a guess about game mechanics.
    local FUEL_TOLERANCE = 1.0
    local okGet, actualPct = PanelBridge.invoke(vehicle, "getRemainingFuelPercentage")
    local verified
    if not okGet or tonumber(actualPct) == nil then
        verified = nil
    else
        verified = (math.abs(tonumber(actualPct) - pct) <= FUEL_TOLERANCE)
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Vehicle fuel set to " .. pct .. "%", vehicleId = tonumber(args.vehicleId), percent = pct },
        "Fuel call succeeded but did not take effect (still " .. tostring(actualPct) .. "%)")
end

handlers.vehicleSetBattery = function(args)
    local vehicle, findErr = findVehicleById(args.vehicleId)
    if not vehicle then return false, nil, findErr or "Vehicle not found" end

    local charge = tonumber(args.charge)
    if not charge then return false, nil, "charge required (0-100)" end
    charge = math.min(math.max(charge, 0), 100)

    -- getBattery is a VehicleParts method, not a vehicle method -- see
    -- vehicleParts() (2026-08-30, Kevin's jar audit). Before this fix
    -- getBattery was called directly on `vehicle`, always returned nil, so
    -- the primary VehicleUtils.chargeBattery path below could never even be
    -- attempted -- every call fell straight to the B41 fallback.
    local parts = vehicleParts(vehicle)

    local ok, err = pcall(function()
        local battery = parts and PanelBridge.tryGet(parts, "getBattery")
        local item = battery and PanelBridge.tryGet(battery, "getInventoryItem")
        local currentUses = item and tonumber(PanelBridge.tryGet(item, "getCurrentUsesFloat"))
        if currentUses and VehicleUtils and VehicleUtils.chargeBattery then
            VehicleUtils.chargeBattery(vehicle, charge / 100 - currentUses)
            return
        end
        -- setBatteryCharge does NOT exist anywhere in the B42 vehicle API
        -- (BaseVehicle, VehicleParts, VehiclePart -- no near-miss at all,
        -- 2026-08-30 jar audit). This is not a wrong-receiver bug like the
        -- others in this handler; rerouting the receiver cannot fix it. This
        -- call is kept only as a last-ditch attempt in case a future PZ
        -- build re-adds an equivalent method under this name; on every
        -- current build it is expected to fail, and the error below says so
        -- honestly instead of implying a real setter merely misfired.
        if not PanelBridge.invoke(vehicle, "setBatteryCharge", charge) then
            error("No working battery setter on this build: the battery item route needs a battery with an inventory item (none found), and setBatteryCharge does not exist in the B42 vehicle API")
        end
    end)
    if not ok then return false, nil, "Failed to set battery: " .. tostring(err) end

    -- getBatteryCharge is already read elsewhere in this file
    -- (getVehiclesDetailed) -- reuse it to confirm the write took effect.
    -- 1.0 percentage-point tolerance is float/rounding slack on a 0-100
    -- scale (the B42 path applies a computed DELTA via VehicleUtils, so
    -- exact-equality would be brittle), not a guess about game mechanics.
    local BATTERY_TOLERANCE = 1.0
    local okGet, actualCharge = false, nil
    if parts then
        okGet, actualCharge = PanelBridge.invoke(parts, "getBatteryCharge")
    end
    local verified
    if not okGet or tonumber(actualCharge) == nil then
        verified = nil
    else
        verified = (math.abs(tonumber(actualCharge) - charge) <= BATTERY_TOLERANCE)
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Vehicle battery set to " .. charge, vehicleId = tonumber(args.vehicleId), charge = charge },
        "Battery call succeeded but did not take effect (still " .. tostring(actualCharge) .. ")")
end

handlers.removeVehicle = function(args)
    local vehicle, findErr = findVehicleById(args.vehicleId)
    if not vehicle then return false, nil, findErr or "Vehicle not found" end

    local vId = tonumber(args.vehicleId)
    local vx = tonumber(PanelBridge.tryGet(vehicle, "getX")) or 0
    local vy = tonumber(PanelBridge.tryGet(vehicle, "getY")) or 0
    local scriptName = PanelBridge.tryGet(vehicle, "getScriptName") or "unknown"

    local ok, err = pcall(function()
        if PanelBridge.invoke(vehicle, "permanentlyRemove") then return end
        if PanelBridge.invoke(vehicle, "removeFromWorld") then return end
        if PanelBridge.invoke(vehicle, "removeVehicle") then return end
        -- Last resort: try to destroy via world cell
        local world = getWorld()
        local cell = world and PanelBridge.tryGet(world, "getCell")
        if not (cell and PanelBridge.invoke(cell, "removeVehicle", vehicle)) then
            error("No removal method available on this PZ build")
        end
    end)
    if not ok then return false, nil, "Failed to remove vehicle: " .. tostring(err) end

    -- Verify by effect (2026-08-31, clearing the last PROVISIONAL entries in
    -- the verify-enforcement gate): confirmed via javap -c against the real
    -- B42 jar that this is safe, unlike the climate/weather ClimateFloat
    -- case that turned out to need a DIFFERENT read-back. BaseVehicle.
    -- permanentlyRemove() calls removeFromWorld() directly in the same call
    -- stack, and removeFromWorld() synchronously does
    -- IsoWorld.instance.currentCell.vehicles:remove(this) (a java.util.Set) --
    -- and IsoCell.getVehicles() is a trivial `return this.vehicles` field
    -- read of that EXACT SAME Set, not a copy or a tick-deferred view. So
    -- re-finding this vehicle immediately after removal is a real synchronous
    -- read-back, not a false-negative risk the way getFinalValue() was.
    -- findVehicleById already handles every collection shape this build's
    -- getVehicles() might hand back (see collectVehicles) -- reuse it rather
    -- than re-deriving a second table scan.
    local stillPresent, recheckErr = findVehicleById(vId)
    local verified
    if stillPresent ~= nil then
        verified = false
    elseif type(recheckErr) == "string" and recheckErr:find("^Vehicle not found") then
        verified = true
    else
        -- The list itself became unreadable on the re-check (a different
        -- failure than "not found") -- genuinely can't confirm either way,
        -- not a false "still there".
        verified = nil
    end

    return PanelBridge.verifiedResult(verified,
        { message = "Vehicle removed", vehicleId = vId, scriptName = scriptName, x = vx, y = vy },
        "Vehicle removal call succeeded but the vehicle is still present in getVehiclesList()")
end

handlers.removeVehiclesInArea = function(args)
    if args.minX == nil or args.minY == nil or args.maxX == nil or args.maxY == nil then
        return false, nil, "minX, minY, maxX, maxY required"
    end
    local minX = math.floor(tonumber(args.minX) or 0)
    local minY = math.floor(tonumber(args.minY) or 0)
    local maxX = math.floor(tonumber(args.maxX) or 0)
    local maxY = math.floor(tonumber(args.maxY) or 0)
    if maxX < minX then minX, maxX = maxX, minX end
    if maxY < minY then minY, maxY = maxY, minY end

    -- Cap area to 2000x2000 tiles to prevent performance DoS
    local areaW = maxX - minX
    local areaH = maxY - minY
    if areaW > 2000 or areaH > 2000 then
        return false, nil, "Area too large (max 2000x2000 tiles). Use smaller selections."
    end

    local vehicles = getVehiclesList()
    if not vehicles then return false, nil, "Vehicle list not available" end

    -- Snapshot every reachable vehicle up front via collectVehicles() (see
    -- its comment on getVehiclesDetailed for why -- same runtime-type
    -- uncertainty, same nil-means-genuinely-unreadable contract). Snapshotting
    -- also means removal below no longer re-indexes into the live collection
    -- while mutating it, which is what made the old loop need to walk in
    -- reverse; iterating the snapshot in reverse is kept only to preserve
    -- prior removal order, not because it's required for correctness anymore.
    local list, collectErr = collectVehicles(vehicles)
    if not list then
        return false, nil, "Vehicle list lookup failed: " .. collectErr
    end

    local attempted = {}

    for i = #list, 1, -1 do
        local v = list[i]
        local vx = tonumber(vehicleGet(v, "getX")) or 0
        local vy = tonumber(vehicleGet(v, "getY")) or 0
        if vx >= minX and vx <= maxX and vy >= minY and vy <= maxY then
            local vId = vehicleGet(v, "getId")
            local scriptName = vehicleGet(v, "getScriptName") or "unknown"
            -- didRemove only means the call didn't throw -- PanelBridge.invoke
            -- returns true whenever pcall succeeds, regardless of what the
            -- underlying method actually did. That is exactly the gap
            -- removeVehicle (just above this handler) was fixed on
            -- 2026-08-31 to stop trusting, by re-confirming via a fresh
            -- getVehiclesList() read. This bulk sibling still only checked
            -- didRemove, so it could report a vehicle as removed purely
            -- because permanentlyRemove()/removeFromWorld() didn't throw.
            local didRemove = PanelBridge.invoke(v, "permanentlyRemove")
            if not didRemove then
                didRemove = PanelBridge.invoke(v, "removeFromWorld")
            end
            if didRemove then
                table.insert(attempted, { id = vId, scriptName = scriptName, x = vx, y = vy })
            end
        end
    end

    -- Verify by effect, same principle as removeVehicle -- re-fetch ONCE
    -- (not per-vehicle: a fresh findVehicleById() scan per candidate would
    -- be O(n) getVehiclesList()+collectVehicles() calls for an operation
    -- that can already touch up to a 2000x2000-tile area) and only report a
    -- vehicle as removed if it is genuinely absent from the fresh list.
    local stillPresentIds = {}
    local verifyOk = false
    if #attempted > 0 then
        local freshVehicles = getVehiclesList()
        local freshList
        if freshVehicles then
            freshList = collectVehicles(freshVehicles)
        end
        if freshList then
            verifyOk = true
            for _, v in ipairs(freshList) do
                local idOk, id = PanelBridge.invoke(v, "getId")
                if idOk then stillPresentIds[tonumber(id)] = true end
            end
        end
    end

    local removed = 0
    local removedList = {}
    for _, entry in ipairs(attempted) do
        -- If the re-check itself couldn't run (verifyOk false), fall back to
        -- the pre-verification result rather than silently dropping every
        -- entry -- same "unverifiable, not a false negative" treatment
        -- PanelBridge.verifiedResult gives a single-vehicle verified==nil.
        if not verifyOk or not stillPresentIds[tonumber(entry.id)] then
            removed = removed + 1
            table.insert(removedList, entry)
        end
    end

    return true, {
        message = removed .. " vehicle(s) removed from area",
        removed = removed,
        vehicles = removedList,
        bounds = { minX = minX, minY = minY, maxX = maxX, maxY = maxY },
        verified = verifyOk and "confirmed" or "unverifiable",
    }
end

-- The live path is client/src/pages/WorldMap.tsx's "Spawn Vehicle" tool,
-- which calls playersApi.addVehicleAt() -> POST /players/add-vehicle-at ->
-- the server's own RCON addvehicle command, not this handler. Kept (not
-- deleted) as a clear, named failure rather than a silently-missing handler.
handlers.spawnVehicleAt = function(args)
    return false, nil, "Vehicle spawning is handled by the panel through RCON on Build 42"
end

handlers.vehicleHotwire = function(args)
    local vehicle, findErr = findVehicleById(args.vehicleId)
    if not vehicle then return false, nil, findErr or "Vehicle not found" end

    local actions = {}

    local ok, err = pcall(function()
        -- 1. Hotwire state
        if PanelBridge.invoke(vehicle, "setHotwired", true) then
            table.insert(actions, "hotwired")
        end
        if PanelBridge.invoke(vehicle, "setHotwiredBroken", false) then
            table.insert(actions, "hotwireBroken=false")
        end
        -- B42: put keys in ignition as fallback
        if PanelBridge.invoke(vehicle, "setKeysInIgnition", true) then
            table.insert(actions, "keysInIgnition")
        end

        -- getPartCount/getPartByIndex/getPartById are VehicleParts methods,
        -- not vehicle methods -- see vehicleParts() (2026-08-30, Kevin's jar
        -- audit: wrong receiver meant doors never unlocked and the engine
        -- condition was never actually checked, though "unlocked" was still
        -- reported since setTrunkLocked below is genuinely a vehicle method).
        local parts = vehicleParts(vehicle)

        -- 2. Unlock all doors
        local partCount = parts and tonumber(PanelBridge.tryGet(parts, "getPartCount")) or 0
        for i = 0, partCount - 1 do
            local part = PanelBridge.tryGet(parts, "getPartByIndex", i)
            if part then
                local door = PanelBridge.tryGet(part, "getDoor")
                if door then
                    PanelBridge.invoke(door, "setLocked", false)
                end
            end
        end
        PanelBridge.invoke(vehicle, "setTrunkLocked", false)
        table.insert(actions, "unlocked")

        -- 3. Ensure engine part has enough condition to start
        local enginePart = parts and PanelBridge.tryGet(parts, "getPartById", "Engine")
        local engineCond = enginePart and tonumber(PanelBridge.tryGet(enginePart, "getCondition"))
        if engineCond and engineCond < 10 then
            if PanelBridge.invoke(enginePart, "setCondition", 20) then
                table.insert(actions, "engineCondRepaired")
            end
        end

        -- 4. Start engine — try multiple B42/B41 approaches
        --
        -- 2026-08-30, Kevin's jar audit: of the three methods tried below, only
        -- engineDoStarting exists on BaseVehicle in the real B42 jar, so it is the
        -- one that actually fires, every time. startEngine and setEngineRunning
        -- are both ABSENT from BaseVehicle -- despite the "B42/B41: setEngineRunning"
        -- label reading like a confirmed method name, it is not one; that tier
        -- (and the startEngine tier before it) never executes. Nothing here is
        -- user-visibly broken -- tier 3 always lands and vehicles start -- but two
        -- of the three "approaches" are dead code.
        --
        -- BaseVehicle also declares tryStartEngine (two overloads) and a real
        -- isEngineRunning getter, and this handler uses NEITHER. That is a
        -- deliberate choice, not an oversight: tryStartEngine reads like it may
        -- respect preconditions (key, fuel, battery) and refuse to start if they
        -- are unmet, where engineDoStarting reads like it drives the starting
        -- sequence directly regardless. Swapping to tryStartEngine could silently
        -- turn this working admin command into one that refuses on an unfueled
        -- vehicle, and nothing in this repo's test suite can tell us that -- it
        -- needs a live server to observe. Choosing between them is a product
        -- decision, not a cleanup, so it is left alone here.
        --
        -- All three tiers stay in place below, dead or not: removing the dead
        -- ones without this note would either get something new wired to a dead
        -- path, or get the live one deleted by a future reader thinking it's the
        -- duplicate.
        local engineStarted = false

        -- B42: startEngine method -- ABSENT from BaseVehicle; this branch never fires.
        if not engineStarted and vehicle.startEngine then
            vehicle:startEngine()
            engineStarted = true
            table.insert(actions, "startEngine")
        end

        -- B42/B41: setEngineRunning -- ABSENT from BaseVehicle, not "the real B42
        -- name"; this branch never fires either.
        if not engineStarted and vehicle.setEngineRunning then
            vehicle:setEngineRunning(true)
            engineStarted = true
            table.insert(actions, "setEngineRunning")
        end

        -- B42: engineDoStarting (forces engine into starting sequence) -- REAL on
        -- BaseVehicle, so this is the tier that actually runs, every time.
        if not engineStarted and vehicle.engineDoStarting then
            vehicle:engineDoStarting()
            engineStarted = true
            table.insert(actions, "engineDoStarting")
        end

        if not engineStarted then
            table.insert(actions, "noEngineMethod")
        end

        -- 5. Transmit state to clients — try all known methods
        if PanelBridge.invoke(vehicle, "transmitEngine") then
            table.insert(actions, "transmitEngine")
        end
        if PanelBridge.invoke(vehicle, "transmitVehicle") then
            table.insert(actions, "transmitVehicle")
        end
        -- B42: send full update to all clients
        if PanelBridge.invoke(vehicle, "updateFlags") then
            table.insert(actions, "updateFlags")
        end
    end)

    if not ok then
        return false, nil, "Hotwire failed: " .. tostring(err) .. " (completed: " .. table.concat(actions, ", ") .. ")"
    end

    return true, {
        message = "Vehicle hotwired and engine started",
        vehicleId = tonumber(args.vehicleId),
        actions = actions
    }
end

-- ============================================
-- AI DIRECTOR EVENT HANDLERS
-- ============================================

-- 2026-08-31, clearing the last PROVISIONAL entries in the verify-enforcement
-- gate: same VirtualZombieManager-first, fire-and-forget-fallback treatment
-- spawnHordeNearPlayer's own fix already established -- confirmed applicable
-- here too (VirtualZombieManager.createRealZombieNow(float,float,float) is a
-- general-purpose per-zombie spawn, not player-specific; only its CALLER
-- picked coordinates from a player before). Area has no player/z reference to
-- read a floor from, so z defaults to 0 (ground level, the same implicit
-- level every one of the fire-and-forget fallbacks below already operated at
-- -- none of them takes a z argument either), overridable via args.z.
handlers.triggerSwarmEvent = function(args)
    local count = math.floor(tonumber(args.count) or 25)
    local x1 = math.floor(tonumber(args.x1) or 0)
    local y1 = math.floor(tonumber(args.y1) or 0)
    local x2 = math.floor(tonumber(args.x2) or x1)
    local y2 = math.floor(tonumber(args.y2) or y1)
    local z = math.floor(tonumber(args.z) or 0)

    count = math.min(math.max(count, 1), 500)
    if x2 < x1 then x1, x2 = x2, x1 end
    if y2 < y1 then y1, y2 = y2, y1 end

    local midX = math.floor((x1 + x2) / 2)
    local midY = math.floor((y1 + y2) / 2)
    local method = "unknown"
    local spawned = 0
    local verified = false

    local ok, err = pcall(function()
        local vzm = _G.VirtualZombieManager and _G.VirtualZombieManager.instance
        if vzm and vzm.createRealZombieNow then
            for i = 1, count do
                local tx = x1 + ZombRand(x2 - x1 + 1)
                local ty = y1 + ZombRand(y2 - y1 + 1)
                local okZ, zombie = pcall(function()
                    return vzm:createRealZombieNow(tx, ty, z)
                end)
                if okZ and zombie then spawned = spawned + 1 end
            end
            method = "VirtualZombieManager.createRealZombieNow"
            verified = true
        else
            -- Fallback: fire-and-forget horde APIs, no count to read back --
            -- see spawnHordeNearPlayer's comment for why `spawned` must stay
            -- nil here rather than being fabricated as `count`.
            local zpop = getZombiePopManager()
            if zpop and zpop.createHordeInAreaTo then
                zpop:createHordeInAreaTo(x1, y1, x2 - x1, y2 - y1, midX, midY, count)
                method = "createHordeInAreaTo"
                spawned = nil
            elseif zpop and zpop.createHordeFromTo then
                zpop:createHordeFromTo(x1, y1, midX, midY, count)
                method = "createHordeFromTo"
                spawned = nil
            else
                local world = getWorld()
                if world and world.CreateSwarm then
                    world:CreateSwarm(count, x1, y1, x2, y2)
                    method = "CreateSwarm"
                    spawned = nil
                else
                    error("No zombie spawning API available (VirtualZombieManager / ZombiePopulationManager / IsoWorld.CreateSwarm all missing)")
                end
            end
        end
    end)
    if not ok then return false, nil, "Failed to trigger swarm: " .. tostring(err) end

    local verifiedStr = "unverifiable"
    if verified == true then verifiedStr = "confirmed" end

    if verified == true and spawned == 0 then
        PanelBridge.warn("Swarm event created no zombies", { count = count, area = { x1 = x1, y1 = y1, x2 = x2, y2 = y2 }, spawned = spawned, verified = verified, method = method })
        return false, nil, "Failed to trigger swarm: no zombies were created (0/" .. count .. "); the target area may not be loaded or available"
    end

    PanelBridge.warn("Swarm event triggered", { count = count, area = { x1 = x1, y1 = y1, x2 = x2, y2 = y2 }, spawned = spawned, verified = verified, method = method })
    return true, {
        message = verified
            and ("Spawned " .. spawned .. "/" .. count .. " zombies in the area")
            or ("Requested " .. count .. " zombies in the area via " .. method .. " (spawn count not verifiable for this method)"),
        count = count,
        spawned = spawned,
        verified = verifiedStr,
        area = { x1 = x1, y1 = y1, x2 = x2, y2 = y2 },
        method = method
    }
end

handlers.runEventSequence = function(args)
    local steps = args.steps
    if type(steps) ~= "table" then
        return false, nil, "steps array required"
    end

    local maxSteps = math.min(math.max(tonumber(args.maxSteps) or 20, 1), 50)
    local results = {}
    local executed = 0
    local failedCount = 0

    for i, step in ipairs(steps) do
        if executed >= maxSteps then break end
        if type(step) == "table" then
            local kind = tostring(step.kind or "")
            local ok, handlerSuccess, handlerData, handlerError = pcall(function()
                if kind == "chat" then
                    local msg = normalizeMessage(step.message, 1000)
                    if not msg then error("chat.message required") end
                    if step.channel == "admin" then
                        return handlers.sendToAdminChat({ message = msg })
                    elseif step.channel == "general" then
                        return handlers.sendToGeneralChat({ message = msg, author = step.author })
                    end
                    return handlers.sendToServerChat({ message = msg, isAlert = step.alert == true })
                elseif kind == "swarm" then
                    return handlers.triggerSwarmEvent(step)
                elseif kind == "weather" then
                    local weatherType = tostring(step.weatherType or "storm")
                    if weatherType == "blizzard" then
                        return handlers.triggerBlizzard({ duration = step.duration })
                    elseif weatherType == "tropical" then
                        return handlers.triggerTropicalStorm({ duration = step.duration })
                    elseif weatherType == "stop" then
                        return handlers.stopWeather({})
                    end
                    return handlers.triggerStorm({ duration = step.duration })
                elseif kind == "utilities" then
                    if step.mode == "off" then
                        return handlers.shutOffUtilities({ power = step.power, water = step.water })
                    end
                    return handlers.restoreUtilities({ power = step.power, water = step.water })
                elseif kind == "noise" then
                    return handlers.createNoise(step)
                else
                    error("Unsupported sequence step kind: " .. kind)
                end
            end)

            executed = executed + 1
            if not ok then
                failedCount = failedCount + 1
                table.insert(results, { index = i, kind = kind, success = false, error = tostring(handlerSuccess) })
            elseif handlerSuccess then
                table.insert(results, { index = i, kind = kind, success = true, data = handlerData })
            else
                failedCount = failedCount + 1
                table.insert(results, { index = i, kind = kind, success = false, error = tostring(handlerError) })
            end
        end
    end

    -- 2026-08-31 bug hunt: this used to unconditionally `return true` here,
    -- regardless of how many steps above actually failed -- a sequence where
    -- every single step failed still reported success, and Events.tsx (which
    -- gates its failure card on this top-level flag alone) showed a plain
    -- success card with the real per-step failures visible only by manually
    -- expanding raw JSON. ok is now verified against what actually happened:
    -- true only when no step failed, matching this file's own convention
    -- that ok=true must mean the thing asked for actually happened, not
    -- merely that the loop finished running. failedCount is exposed
    -- alongside the per-step `results` array (unchanged, always present, on
    -- either branch) so a caller can tell 9-of-10 from 0-of-10 without
    -- parsing that array itself.
    local allVerified = failedCount == 0
    local data = {
        message = allVerified
            and "Event sequence executed"
            or ("Event sequence completed with " .. failedCount .. "/" .. executed .. " step(s) failed"),
        executed = executed,
        maxSteps = maxSteps,
        failedCount = failedCount,
        results = results
    }

    if allVerified then
        return true, data
    end
    return false, data, data.message
end

-- ============================================
-- INFRASTRUCTURE MAP HANDLERS
-- ============================================

handlers.getInfrastructureSnapshot = function(args)
    local world = getWorld()
    local cell = (getCell and getCell()) or (world and PanelBridge.tryGet(world, "getCell"))
    if not world then return false, nil, "World not available" end

    local snapshot = {
        hydroPowerOn = PanelBridge.tryGet(world, "isHydroPowerOn"),
        globalTemperature = PanelBridge.tryGet(world, "getGlobalTemperature"),
        weather = PanelBridge.tryGet(world, "getWeather"),
        sample = nil
    }

    local sx = tonumber(args.x)
    local sy = tonumber(args.y)
    local sz = tonumber(args.z) or 0
    if cell and sx and sy then
        local sample = { x = sx, y = sy, z = sz }
        local ix, iy, iz = math.floor(sx), math.floor(sy), math.floor(sz)
        sample.dangerScore = PanelBridge.tryGet(cell, "getDangerScore", ix, iy)
        sample.heatSourceTemperature = PanelBridge.tryGet(cell, "getHeatSourceTemperature", ix, iy, iz)
        sample.heatSourceHighestTemperature = PanelBridge.tryGet(cell, "getHeatSourceHighestTemperature",
            snapshot.globalTemperature or 0, ix, iy, iz)
        local lightOk, lightSource = PanelBridge.invoke(cell, "getLightSourceAt", ix, iy, iz)
        if lightOk then sample.hasLamppost = lightSource ~= nil end
        snapshot.sample = sample
    end

    return true, snapshot
end

-- ============================================
-- MODERATION AUTOMATION HANDLERS
-- ============================================

handlers.moderationKickUser = function(args)
    local username = normalizeMessage(args.username, 64)
    local reason = normalizeMessage(args.reason, 120) or "Kicked by admin panel"
    local description = normalizeMessage(args.description, 240) or reason

    if not username then return false, nil, "Username required" end

    -- BanSystem.KickUser is declared `void` in the real B42 jar (verified
    -- 2026-08-23 by reading zombie/network/BanSystem.class's method table
    -- directly: KickUser(String,String,String)V) -- there is no return
    -- value to read back, ever. pcall not throwing is the only signal this
    -- API can give, and that ceiling is already what this handler checks.
    local ok, err = pcall(function()
        if BanSystem and BanSystem.KickUser then
            BanSystem.KickUser(username, reason, description)
        else
            error("BanSystem.KickUser not available")
        end
    end)
    if not ok then return false, nil, "Kick failed: " .. tostring(err) end

    return true, { message = "User kicked", username = username, reason = reason }
end

handlers.moderationBanUser = function(args)
    local username = normalizeMessage(args.username, 64)
    local reason = normalizeMessage(args.reason, 120) or "Banned by admin panel"
    local ban = args.ban ~= false

    if not username then return false, nil, "Username required" end

    local ok, resultOrErr = pcall(function()
        if BanSystem and BanSystem.BanUser then
            return BanSystem.BanUser(username, nil, reason, ban)
        end
        error("BanSystem.BanUser not available")
    end)
    if not ok then return false, nil, "Ban user failed: " .. tostring(resultOrErr) end

    -- BanSystem.BanUser returns a String (verified 2026-08-23 against the
    -- real B42 jar's method table: BanUser(String,UdpConnection,String,Z)
    -- Ljava/lang/String;). Reading the method's own bytecode string
    -- constants shows literal rejection messages baked in --
    -- "You don't have capability to ban/unban users." and "This user
    -- can't be banned." -- alongside an empty string on the path that
    -- reaches the actual ban/unban. Gate on that: empty/nil means nothing
    -- rejected the request, anything else is the game's own reason it did
    -- not happen -- this was previously captured as `details` and thrown away.
    if resultOrErr ~= nil and resultOrErr ~= "" then
        return false, nil, "Ban user rejected: " .. tostring(resultOrErr)
    end

    -- Reaching here means BanSystem's own rejection check passed (empty
    -- string) -- that IS the confirmation this API can give, per the
    -- 2026-08-23 ruling that every handler emits `verified` as a string,
    -- always, when ok=true.
    return true, {
        message = ban and "User banned" or "User unbanned",
        username = username,
        details = resultOrErr,
        verified = "confirmed"
    }
end

handlers.moderationBanIP = function(args)
    local ip = normalizeMessage(args.ip, 64)
    local reason = normalizeMessage(args.reason, 120) or "IP ban from admin panel"
    local ban = args.ban ~= false

    if not ip then return false, nil, "IP required" end

    local ok, resultOrErr = pcall(function()
        if BanSystem and BanSystem.BanIP then
            return BanSystem.BanIP(ip, nil, reason, ban)
        end
        error("BanSystem.BanIP not available")
    end)
    if not ok then return false, nil, "Ban IP failed: " .. tostring(resultOrErr) end

    -- Same String-return contract as BanUser -- see its comment for the
    -- jar evidence. Empty/nil means nothing rejected the request.
    if resultOrErr ~= nil and resultOrErr ~= "" then
        return false, nil, "Ban IP rejected: " .. tostring(resultOrErr)
    end

    -- See moderationBanUser's comment: reaching here IS the confirmation.
    return true, {
        message = ban and "IP banned" or "IP unbanned",
        ip = ip,
        details = resultOrErr,
        verified = "confirmed"
    }
end

handlers.moderationBanSteamID = function(args)
    local steamId = normalizeMessage(args.steamId, 32)
    local reason = normalizeMessage(args.reason, 120) or "SteamID ban from admin panel"
    local ban = args.ban ~= false

    if not steamId then return false, nil, "steamId required" end

    local ok, resultOrErr = pcall(function()
        if BanSystem and BanSystem.BanUserBySteamID then
            return BanSystem.BanUserBySteamID(steamId, nil, reason, ban)
        end
        error("BanSystem.BanUserBySteamID not available")
    end)
    if not ok then return false, nil, "Ban SteamID failed: " .. tostring(resultOrErr) end

    -- Same String-return contract as BanUser -- see its comment for the
    -- jar evidence. Empty/nil means nothing rejected the request.
    if resultOrErr ~= nil and resultOrErr ~= "" then
        return false, nil, "Ban SteamID rejected: " .. tostring(resultOrErr)
    end

    -- See moderationBanUser's comment: reaching here IS the confirmation.
    return true, {
        message = ban and "SteamID banned" or "SteamID unbanned",
        steamId = steamId,
        details = resultOrErr,
        verified = "confirmed"
    }
end

-- ============================================
-- CATALOG HANDLERS (item + vehicle enumeration)
-- ============================================

-- Debug: probe what category methods exist on item scripts
handlers.debugItemScript = function(args)
    local sm = ScriptManager and ScriptManager.instance
    if not sm then return false, nil, "ScriptManager not available" end

    local allItems = nil
    pcall(function() allItems = sm:getAllItems() end)
    if not allItems or allItems:size() == 0 then
        return false, nil, "No items found"
    end

    -- Test first 3 items
    local probes = {}
    local limit = math.min(3, allItems:size())
    for i = 0, limit - 1 do
        local script = allItems:get(i)
        if script then
            local probe = {}
            local nameOk, name = pcall(function() return script:getFullName() end)
            probe.id = nameOk and tostring(name) or "?"

            -- Try every possible category method
            local methods = {"getTypeString", "getType", "getCategory", "getDisplayCategory",
                             "getBodyLocation", "getSubCategory", "getCategories",
                             "getTypeToItem", "getScriptObjectType"}
            for _, m in ipairs(methods) do
                local ok, val = pcall(function()
                    if script[m] then
                        return script[m](script)
                    end
                    return nil
                end)
                if ok and val ~= nil then
                    probe[m] = tostring(val)
                else
                    probe[m] = ok and "nil" or ("ERROR: " .. tostring(val))
                end
            end
            table.insert(probes, probe)
        end
    end
    return true, { probes = probes }
end

handlers.getItemCatalog = function(args)
    local sm = ScriptManager and ScriptManager.instance
    if not sm then
        return false, nil, "ScriptManager not available"
    end

    local allItems = nil
    local ok, err = pcall(function()
        allItems = sm:getAllItems()
    end)
    if not ok or not allItems then
        return false, nil, "Failed to enumerate items: " .. tostring(err)
    end

    local catalog = {}
    local errors = 0
    local count = allItems:size()
    for i = 0, count - 1 do
        local script = allItems:get(i)
        if script then
            local entry = {}
            -- fullType is the ID used by AddItem / additem RCON
            local fullOk, fullType = pcall(function() return script:getFullName() end)
            if not fullOk or not fullType then
                fullOk, fullType = pcall(function() return script:getName() end)
            end
            if fullOk and fullType then
                entry.id = fullType

                local nameOk, displayName = pcall(function() return script:getDisplayName() end)
                entry.name = (nameOk and displayName) or fullType

                -- Category: use getDisplayCategory first (least crash-prone)
                -- Then extract module from fullType as fallback
                -- Avoid getTypeString/getType — they throw Java RuntimeExceptions
                -- on many items, spamming server logs even though pcall catches them
                local cat = nil

                -- Method 1: getDisplayCategory() — human-readable, works on most items
                local dcOk, dcVal = pcall(function() return script:getDisplayCategory() end)
                if dcOk and dcVal and tostring(dcVal) ~= "" then
                    cat = tostring(dcVal)
                end

                -- Method 2: Extract module prefix from fullType (e.g. "Base.Hammer" → "Base")
                if not cat and fullType then
                    local module = fullType:match("^([^%.]+)%.")
                    if module then cat = module end
                end

                entry.category = cat or "Other"

                -- Weight for display
                local wOk, w = pcall(function() return script:getActualWeight() end)
                if wOk and w then entry.weight = w end

                table.insert(catalog, entry)
            else
                errors = errors + 1
            end
        end
    end

    PanelBridge.info("Item catalog scanned", { count = #catalog, errors = errors })
    return true, { items = catalog, count = #catalog }
end

handlers.getVehicleCatalog = function(args)
    local sm = ScriptManager and ScriptManager.instance
    if not sm then
        return false, nil, "ScriptManager not available"
    end

    -- Try B42 method first, then B41 fallback
    local allVehicles = PanelBridge.tryGet(sm, "getAllVehicleScripts")
        or PanelBridge.tryGet(sm, "getAllVehicles")
    if not allVehicles then
        return false, nil, "Failed to enumerate vehicles: API not available"
    end

    local catalog = {}
    local count = allVehicles:size()
    for i = 0, count - 1 do
        local script = allVehicles:get(i)
        if script then
            local entry = {}
            local nameOk, fullName = pcall(function() return script:getFullName() end)
            if not nameOk or not fullName then
                nameOk, fullName = pcall(function() return script:getName() end)
            end
            if nameOk and fullName then
                entry.id = fullName

                -- Avoid getDisplayName() — throws RuntimeException in B42 Kahlua
                -- Use getName() which works, or strip module prefix from fullName
                local displayName = nil
                local shortOk, shortName = pcall(function() return script:getName() end)
                if shortOk and shortName and shortName ~= "" then
                    displayName = shortName
                else
                    displayName = fullName:match("%.(.+)$") or fullName
                end
                entry.name = displayName

                -- Grab mechanics info if available
                local massOk, mass = pcall(function() return script:getMass() end)
                if massOk and mass then entry.mass = mass end

                -- Avoid getSeatNumber() — throws RuntimeException in B42 Kahlua
                -- Try getPassengerCount/getMaxPassengers as safe alternatives
                local seats = nil
                if script.getPassengerCount then
                    local pcOk, pc = pcall(script.getPassengerCount, script)
                    if pcOk and pc then seats = pc end
                end
                if not seats and script.getMaxPassengers then
                    local mpOk, mp = pcall(script.getMaxPassengers, script)
                    if mpOk and mp then seats = mp end
                end
                if seats then entry.seats = seats end

                table.insert(catalog, entry)
            end
        end
    end

    PanelBridge.info("Vehicle catalog scanned", { count = #catalog })
    return true, { vehicles = catalog, count = #catalog }
end

-- ============================================
-- MAIN PROCESSING
-- ============================================

function PanelBridge.processCommands()
    local processedCount = 0
    -- scannedCount is the shared per-tick I/O budget across BOTH intake
    -- paths (numbered queue below, then legacy commands.json further down)
    -- -- matches the combined bound this function has always enforced via
    -- one counter; see processQueuedCommands' header comment for why that
    -- counter had to split into scanned (bounds work) vs processed (honest
    -- report) instead of continuing to serve both jobs.
    local scannedCount = 0
    local queueProcessed, queueScanned = processQueuedCommands(PanelBridge.MAX_COMMANDS_PER_TICK)
    processedCount = processedCount + queueProcessed
    scannedCount = scannedCount + queueScanned

    -- NOTE (audit L03): everything from here down is the LEGACY commands.json
    -- intake path — a fallback for a panel that hasn't negotiated
    -- protocolVersion=queue-v1, kept alongside the numbered queue above. It
    -- has an inherent lossy read-then-clear race (a command Node writes in
    -- the gap between our read and our clearFile() below is lost) that the
    -- numbered queue exists specifically to avoid. Do not build new features
    -- on this path; retire it (see the matching note in flushResults) once
    -- all deployed panels are confirmed on queue-v1.
    -- Legacy intake: the panel only writes commands.json when a numbered
    -- queue write fails, so it is polled on its own slower interval instead
    -- of every tick. See the race note above before building on this path.
    local nowMs = getTimestampMs()
    local commands = nil
    if nowMs - PanelBridge.lastLegacyCheck >= PanelBridge.LEGACY_COMMANDS_INTERVAL then
        PanelBridge.lastLegacyCheck = nowMs
        commands = PanelBridge.readJSON("commands.json")
    end
    if not commands or not commands.commands then
        if processedCount > 0 then
            PanelBridge.debug("Processed " .. processedCount .. " commands")
        end
        return
    end

    local deferredCommands = nil

    -- Clear commands file immediately after reading to minimise the race window
    -- where Node writes a new command between our read and our (old) post-loop clear.
    -- processedIds dedup ensures commands are never processed twice even if the Lua
    -- mod re-reads a file that Node repopulated in the gap.
    PanelBridge.clearFile("commands.json")

    for idx, cmd in ipairs(commands.commands) do
        if scannedCount >= PanelBridge.MAX_COMMANDS_PER_TICK then
            deferredCommands = {}
            for j = idx, #commands.commands do
                table.insert(deferredCommands, commands.commands[j])
            end
            PanelBridge.warn("Command batch limit reached; deferring remaining commands", {
                processed = processedCount,
                scanned = scannedCount,
                maxPerTick = PanelBridge.MAX_COMMANDS_PER_TICK,
                totalInFile = #commands.commands,
                deferredCount = #deferredCommands
            })
            break
        end

        scannedCount = scannedCount + 1
        if processSingleCommand(cmd) then
            processedCount = processedCount + 1
        end
    end

    if processedCount > 0 then
        PanelBridge.debug("Processed " .. processedCount .. " commands")
    end

    if deferredCommands and #deferredCommands > 0 then
        -- Merge deferred commands with any new commands that arrived while we were processing.
        local existing = PanelBridge.readJSON("commands.json") or { commands = {} }
        local merged = { commands = {} }

        for _, cmd in ipairs(deferredCommands) do
            table.insert(merged.commands, cmd)
        end

        if existing.commands then
            for _, cmd in ipairs(existing.commands) do
                table.insert(merged.commands, cmd)
            end
        end

        local requeueOk = PanelBridge.writeJSON("commands.json", merged)
        if not requeueOk then
            PanelBridge.error("Failed to requeue deferred commands", { count = #deferredCommands })
        end
    end

    -- Cleanup old processed IDs (sliding window: drop oldest half)
    -- Walks processedIdOrder (true insertion order) instead of pairs(), whose
    -- iteration order over processedIds is unspecified in Lua \u2014 iterating
    -- pairs() here used to drop an ARBITRARY half rather than the oldest half.
    if PanelBridge.processedIdCount > 500 then
        local oldCount = PanelBridge.processedIdCount
        local skip = math.floor(oldCount / 2)
        local newOrder = {}
        local newSet = {}
        for i = skip + 1, #PanelBridge.processedIdOrder do
            local id = PanelBridge.processedIdOrder[i]
            newOrder[#newOrder + 1] = id
            newSet[id] = true
        end
        PanelBridge.processedIds = newSet
        PanelBridge.processedIdOrder = newOrder
        PanelBridge.processedIdCount = #newOrder
        PanelBridge.debug("Trimmed processed IDs", { previous = oldCount, kept = PanelBridge.processedIdCount })
    end
end

function PanelBridge.updateStatus()
    local ok, err = pcall(function()
        local onlinePlayers = getOnlinePlayers()
        local playerNames = {}
        if onlinePlayers then
            for i = 0, onlinePlayers:size() - 1 do
                local player = onlinePlayers:get(i)
                if player then
                    table.insert(playerNames, player:getUsername())
                end
            end
        end

        local status = {
            alive = true,
            version = PanelBridge.VERSION,
            protocolVersion = PanelBridge.PROTOCOL_VERSION,
            timestamp = getTimestampMs(),
            serverName = getServerName(),
            playerCount = onlinePlayers and onlinePlayers:size() or 0,
            players = playerNames,
            path = PanelBridge.getBasePath(),
            debugMode = PanelBridge.DEBUG_MODE,
            stats = {
                processed = PanelBridge.stats.commandsProcessed,
                succeeded = PanelBridge.stats.commandsSucceeded,
                failed = PanelBridge.stats.commandsFailed
            },
            queue = {
                lastCommandSeq = PanelBridge.queueState.lastCommandSeq,
                nextResultSeq = PanelBridge.queueState.nextResultSeq
            }
        }

        PanelBridge.writeJSON("status.json", status)
    end)

    if not ok then
        PanelBridge.error("Failed to update status", { error = tostring(err) })
    end
end

function PanelBridge.onTick()
    if not PanelBridge.initialized then return end

    local now = getTimestampMs()

    -- Advance any active background job (see L02) by one tick's worth of
    -- work. Runs every tick (not gated by CHECK_INTERVAL) so a chunked
    -- restoreUtilities/shutOffUtilities scan drains as fast as the game
    -- loop itself, not the 250ms command-poll cadence.
    local jobOk, jobErr = pcall(PanelBridge.processActiveJob)
    if not jobOk then
        PanelBridge.error("Tick error in processActiveJob", { error = tostring(jobErr) })
    end

    -- Check for commands
    if now - PanelBridge.lastCheck >= PanelBridge.CHECK_INTERVAL then
        PanelBridge.lastCheck = now
        local success, err = pcall(PanelBridge.processCommands)
        if not success then
            PanelBridge.error("Tick error in processCommands", { error = tostring(err) })
        end
        -- Flush any buffered results to disk (single write per tick)
        local flushOk, flushErr = pcall(PanelBridge.flushResults)
        if not flushOk then
            PanelBridge.error("Tick error in flushResults", { error = tostring(flushErr) })
        end
    end

    -- Update status periodically
    if now - PanelBridge.lastStatusUpdate >= PanelBridge.STATUS_INTERVAL then
        PanelBridge.lastStatusUpdate = now
        pcall(PanelBridge.updateStatus)
    end
end

function PanelBridge.onServerStarted()
    print("[PanelBridge] ========================================")
    print("[PanelBridge] Initializing v" .. PanelBridge.VERSION)

    if not isServer() then
        print("[PanelBridge] Not running on server, disabling")
        return
    end

    -- Initialize stats
    PanelBridge.stats.startTime = getTimestampMs()
    PanelBridge.stats.commandsProcessed = 0
    PanelBridge.stats.commandsSucceeded = 0
    PanelBridge.stats.commandsFailed = 0
    PanelBridge.stats.errors = {}

    if not PanelBridge.ensureDirectory() then
        PanelBridge.error("Could not create directory")
        print("[PanelBridge] ERROR: Could not create directory")
        return
    end

    -- The panel creates the inbox/outbox folders. Build 42 no longer lets Lua
    -- create a directory, and results are written flat, so nothing to do here.

    -- Restore queue state from previous run.
    PanelBridge.readQueueState()
    PanelBridge.writeQueueState()
    PanelBridge.writeInboxCursor(PanelBridge.queueState.lastCommandSeq)

    -- Detect version and available APIs
    PanelBridge.detectVersion()

    if PanelBridge.reconcileStartupPower() then
        print("[PanelBridge] Restored startup power from the configured sandbox countdown")
    end

    -- Write initial status
    PanelBridge.updateStatus()

    -- Clear old commands and results
    PanelBridge.clearFile("commands.json")
    -- Retired in v1.7.10 (see flushResults): wipe any results.json left
    -- behind by a pre-retirement mod version so it doesn't linger forever
    -- as stale, endlessly-reprocessed (though harmlessly deduped) content.
    PanelBridge.clearFile("results.json")

    -- Write a startup log entry
    PanelBridge.writeJSON("startup.json", {
        version = PanelBridge.VERSION,
        startTime = PanelBridge.stats.startTime,
        path = PanelBridge.getBasePath(),
        detectedVersion = PanelBridge.detectedVersion,
        serverName = getServerName()
    })

    -- Reset time speed to 1x so fast-forward doesn't persist across reboots
    pcall(function()
        local gt = getGameTime()
        local multiplier = tonumber(PanelBridge.tryGet(gt, "getMultiplier"))
        if multiplier and multiplier ~= 1 then
            if PanelBridge.invoke(gt, "setMultiplier", 1) then
                print("[PanelBridge] Reset time speed from " .. tostring(multiplier) .. "x to 1x")
            end
        end
    end)

    PanelBridge.initialized = true
    PanelBridge.info("PanelBridge ready", { path = PanelBridge.getBasePath() })
    print("[PanelBridge] Ready at: " .. PanelBridge.getBasePath())
    print("[PanelBridge] Debug mode: " .. (PanelBridge.DEBUG_MODE and "ON" or "OFF"))

    -- Probe chat system availability for diagnostics
    -- NOTE: On B42 dedicated servers, ChatServer is NOT exposed to Lua (the Java class exists
    -- but PZ doesn't register it as a Lua global). This is normal — chat messages are sent
    -- via RCON 'servermsg' by the Node.js backend instead. PanelBridge chat handlers are a
    -- secondary enhancement that only works on builds where ChatServer is Lua-accessible.
    local chatProbe = getChatSystem()
    if chatProbe and chatProbe.server then
        print("[PanelBridge] ChatServer: available (native chat API)")
    else
        print("[PanelBridge] ChatServer: not exposed to Lua (normal on B42 — chat uses RCON servermsg)")
    end

    print("[PanelBridge] ========================================")
end

-- Register events
Events.OnServerStarted.Add(PanelBridge.onServerStarted)
-- Use OnTickEvenPaused so the bridge works even when no players are connected
Events.OnTickEvenPaused.Add(PanelBridge.onTick)

-- Exposes the handler table for the JS test harness (fengari) to call
-- directly. Additive only: nothing in this file or on the panel side does
-- pairs(PanelBridge)/ipairs(PanelBridge) or otherwise enumerates this table
-- (verified by grep before landing) -- the only enumeration in this file is
-- pairs(handlers) inside handlers.getAvailableHandlers, which walks the
-- separate `handlers` local and is unaffected by this field.
PanelBridge.handlers = handlers

-- TEST-ONLY EXPOSURE, same additive-only precedent as PanelBridge.handlers
-- above and for the same reason: the JS test harness (fengari) has no other
-- way to reach a file-local like `json` to exercise json.encode/json.decode
-- directly. This is not a public API for other mods to depend on -- it
-- exists solely so vitest can call into this file's own JSON parser.
-- Nothing in this file or on the panel side enumerates PanelBridge's own
-- fields (verified by the same grep as the handlers exposure above).
PanelBridge.json = json

return PanelBridge

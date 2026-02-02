--[[
    PanelBridge - Server-side mod for Zomboid Control Panel
    Version: 1.4.2
    
    This mod enables external control panel communication with the PZ server.
    Communication happens via JSON files in the server save folder.
    
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

local PanelBridge = {
    VERSION = "1.4.2",
    CHECK_INTERVAL = 1000, -- milliseconds
    lastCheck = 0,
    lastStatusUpdate = 0,
    STATUS_INTERVAL = 3000, -- status update every 3 seconds (faster for detection)
    processedIds = {},
    basePath = nil,
    initialized = false,
    
    -- Debug/Logging system
    DEBUG_MODE = false, -- Set to true to enable verbose logging
    debugLog = {},      -- Recent debug entries (ring buffer)
    MAX_DEBUG_ENTRIES = 200,
    
    -- API detection
    detectedVersion = nil,
    apiCapabilities = {},
    
    -- Statistics
    stats = {
        commandsProcessed = 0,
        commandsSucceeded = 0,
        commandsFailed = 0,
        errors = {},
        lastError = nil,
        startTime = nil
    }
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

-- Internal logging function
function PanelBridge.log(level, message, context)
    local timestamp = getTimestampMs and getTimestampMs() or os.time() * 1000
    local levelName = "INFO"
    for name, val in pairs(LOG_LEVEL) do
        if val == level then levelName = name break end
    end
    
    local entry = {
        timestamp = timestamp,
        level = levelName,
        message = tostring(message),
        context = context
    }
    
    -- Add to ring buffer
    table.insert(PanelBridge.debugLog, entry)
    while #PanelBridge.debugLog > PanelBridge.MAX_DEBUG_ENTRIES do
        table.remove(PanelBridge.debugLog, 1)
    end
    
    -- Print to console
    local prefix = "[PanelBridge][" .. levelName .. "] "
    if level >= LOG_LEVEL.WARN or PanelBridge.DEBUG_MODE then
        print(prefix .. message)
        if context and PanelBridge.DEBUG_MODE then
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

-- Check if a method exists on an object
function PanelBridge.hasMethod(obj, methodName)
    if not obj then return false end
    return type(obj[methodName]) == "function"
end

-- Safely call a method that might not exist
-- Returns: success, result/error
function PanelBridge.safeCall(obj, methodName, ...)
    if not obj then
        return false, "Object is nil"
    end
    
    if not PanelBridge.hasMethod(obj, methodName) then
        return false, "Method '" .. methodName .. "' not available"
    end
    
    local args = {...}
    local success, result = pcall(function()
        return obj[methodName](obj, unpack(args))
    end)
    
    if success then
        return true, result
    else
        PanelBridge.debug("safeCall failed", { method = methodName, error = result })
        return false, result
    end
end

-- Safely get a value from a method, with default fallback
function PanelBridge.safeGet(obj, methodName, default)
    local success, result = PanelBridge.safeCall(obj, methodName)
    if success then
        return result
    end
    return default
end

-- Detect PZ version and available APIs
function PanelBridge.detectVersion()
    local version = {
        build = "unknown",
        isB42 = false,
        isB41 = false,
        features = {}
    }
    
    -- Check for B42-specific APIs
    local climate = getClimateManager and getClimateManager()
    if climate then
        -- B42 has some different climate methods
        if PanelBridge.hasMethod(climate, "transmitTriggerBlizzard") then
            version.features.blizzard = true
        end
        if PanelBridge.hasMethod(climate, "transmitTriggerTropical") then
            version.features.tropical = true
        end
    end
    
    -- Check player API differences
    local testPlayer = getOnlinePlayers and getOnlinePlayers():size() > 0 and getOnlinePlayers():get(0) or nil
    if testPlayer then
        -- B42 traits are accessed via SurvivorDesc
        local desc = testPlayer:getDescriptor()
        if desc and PanelBridge.hasMethod(desc, "getTraitList") then
            version.isB42 = true
        end
        if PanelBridge.hasMethod(testPlayer, "getTraits") then
            version.isB41 = true
        end
    end
    
    -- Try to get build version
    pcall(function()
        if getCore and getCore() and getCore().getVersion then
            version.build = getCore():getVersion()
        end
    end)
    
    PanelBridge.detectedVersion = version
    PanelBridge.info("Detected PZ version", version)
    
    return version
end

-- ============================================
-- JSON LIBRARY (embedded for reliability)
-- ============================================
local json = {}

local function kind_of(obj)
    if type(obj) ~= 'table' then return type(obj) end
    local i = 1
    for _ in pairs(obj) do
        if obj[i] ~= nil then i = i + 1 else return 'table' end
    end
    if i == 1 then return 'table' else return 'array' end
end

local function escape_str(s)
    local in_char = {'\\', '"', '\b', '\f', '\n', '\r', '\t'}
    local out_char = {'\\', '"', 'b', 'f', 'n', 'r', 't'}
    for i, c in ipairs(in_char) do
        s = s:gsub(c, '\\' .. out_char[i])
    end
    return s
end

function json.encode(obj)
    local t = type(obj)
    if t == 'nil' then
        return 'null'
    elseif t == 'boolean' then
        return obj and 'true' or 'false'
    elseif t == 'number' then
        return tostring(obj)
    elseif t == 'string' then
        return '"' .. escape_str(obj) .. '"'
    elseif t == 'table' then
        local k = kind_of(obj)
        if k == 'array' then
            local parts = {}
            for i, v in ipairs(obj) do
                parts[i] = json.encode(v)
            end
            return '[' .. table.concat(parts, ',') .. ']'
        else
            local parts = {}
            for key, val in pairs(obj) do
                parts[#parts + 1] = json.encode(tostring(key)) .. ':' .. json.encode(val)
            end
            return '{' .. table.concat(parts, ',') .. '}'
        end
    end
    return 'null'
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
                    elseif escape == '"' then result = result .. '"'
                    elseif escape == '\\' then result = result .. '\\'
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
            while true do
                skip_whitespace()
                local key = parse_value()
                skip_whitespace()
                if str:sub(pos, pos) == ':' then pos = pos + 1 end
                local value = parse_value()
                obj[key] = value
                skip_whitespace()
                c = str:sub(pos, pos)
                if c == '}' then
                    pos = pos + 1
                    return obj
                elseif c == ',' then
                    pos = pos + 1
                end
            end
        elseif c == '[' then
            -- Array
            pos = pos + 1
            local arr = {}
            skip_whitespace()
            if str:sub(pos, pos) == ']' then
                pos = pos + 1
                return arr
            end
            while true do
                arr[#arr + 1] = parse_value()
                skip_whitespace()
                c = str:sub(pos, pos)
                if c == ']' then
                    pos = pos + 1
                    return arr
                elseif c == ',' then
                    pos = pos + 1
                end
            end
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
    
    for i = 0, onlinePlayers:size() - 1 do
        local player = onlinePlayers:get(i)
        if player and player:getUsername() == username then
            return player
        end
    end
    
    return nil
end

-- Wrap a handler function with error catching and timing
local function wrapHandler(name, handler)
    return function(args)
        local startTime = getTimestampMs and getTimestampMs() or 0
        
        PanelBridge.debug("Executing handler: " .. name, { args = args })
        
        local success, result1, result2, result3 = pcall(function()
            return handler(args)
        end)
        
        local duration = (getTimestampMs and getTimestampMs() or 0) - startTime
        
        if success then
            PanelBridge.debug("Handler completed: " .. name, { 
                success = result1, 
                duration = duration .. "ms" 
            })
            return result1, result2, result3
        else
            -- pcall failed - the handler threw an error
            local errorMsg = "Handler error: " .. tostring(result1)
            PanelBridge.error(errorMsg, { 
                handler = name, 
                args = args,
                duration = duration .. "ms"
            })
            return false, nil, errorMsg
        end
    end
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
    
    if serverName and serverName ~= "" then
        -- Simple path within allowed Lua folder
        PanelBridge.basePath = "panelbridge/" .. serverName .. "/"
    else
        -- Fallback
        PanelBridge.basePath = "panelbridge/"
    end
    
    print("[PanelBridge] Using path: " .. PanelBridge.basePath)
    return PanelBridge.basePath
end

function PanelBridge.ensureDirectory()
    local path = PanelBridge.getBasePath()
    -- Create directory by writing init file
    local initPath = path .. ".init"
    local writer = getFileWriter(initPath, true, false)
    if writer then
        writer:write("PanelBridge initialized at " .. os.date())
        writer:close()
        return true
    end
    return false
end

function PanelBridge.readFile(filename)
    local path = PanelBridge.getBasePath() .. filename
    local reader = getFileReader(path, false)
    if not reader then
        return nil
    end
    
    local content = ""
    local line = reader:readLine()
    while line do
        content = content .. line .. "\n"
        line = reader:readLine()
    end
    reader:close()
    
    return content:gsub("^%s*(.-)%s*$", "%1") -- trim
end

function PanelBridge.writeFile(filename, content)
    local path = PanelBridge.getBasePath() .. filename
    local writer = getFileWriter(path, true, false)
    if not writer then
        print("[PanelBridge] Error: Could not write to " .. path)
        return false
    end
    writer:write(content)
    writer:close()
    return true
end

function PanelBridge.readJSON(filename)
    local content = PanelBridge.readFile(filename)
    if not content or content == "" then
        return nil
    end
    return json.decode(content)
end

function PanelBridge.writeJSON(filename, data)
    local content = json.encode(data)
    return PanelBridge.writeFile(filename, content)
end

function PanelBridge.clearFile(filename)
    return PanelBridge.writeFile(filename, "")
end

-- ============================================
-- RESULT HANDLING
-- ============================================

function PanelBridge.sendResult(id, success, data, errorMsg)
    local results = PanelBridge.readJSON("results.json") or { results = {} }
    if not results.results then results.results = {} end
    
    table.insert(results.results, {
        id = id,
        success = success,
        data = data,
        error = errorMsg,
        timestamp = getTimestampMs()
    })
    
    -- Keep only last 50 results
    while #results.results > 50 do
        table.remove(results.results, 1)
    end
    
    PanelBridge.writeJSON("results.json", results)
end

-- ============================================
-- COMMAND HANDLERS
-- ============================================

local handlers = {}

-- ============================================
-- DEBUG & UTILITY HANDLERS
-- ============================================

-- Get debug log entries
handlers.getDebugLog = function(args)
    local limit = args.limit or 50
    local minLevel = args.minLevel or "DEBUG"
    
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
        local ok, chatServer = pcall(function() return ChatServer.getInstance() end)
        if ok then obj = chatServer end
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
            local count = 0
            for k, v in pairs(obj) do
                if type(v) == "function" and count < 50 then
                    table.insert(result.methods, k)
                    count = count + 1
                end
            end
            table.sort(result.methods)
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
                local health = 100
                local bodyDamage = player:getBodyDamage()
                if bodyDamage then
                    health = bodyDamage:getOverallBodyHealth() or 100
                end
                table.insert(players, {
                    name = player:getUsername() or "Unknown",
                    x = math.floor(player:getX() or 0),
                    y = math.floor(player:getY() or 0),
                    z = math.floor(player:getZ() or 0),
                    health = health
                })
            end
        end
    end
    
    local gameTime = getGameTime()
    local gameTimeData = nil
    if gameTime then
        gameTimeData = {
            day = gameTime:getDay(),
            month = gameTime:getMonth() + 1, -- Lua 1-indexed
            year = gameTime:getYear(),
            hour = gameTime:getHour(),
            minute = gameTime:getMinutes()
        }
    end
    
    return true, {
        players = players,
        playerCount = #players,
        gameTime = gameTimeData
    }
end

-- Get weather info
handlers.getWeather = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end
    
    -- Get ClimateFloat values for more detailed info
    local cloudIntensity = climate:getCloudIntensity()
    local precipIntensity = climate:getPrecipitationIntensity()
    
    return true, {
        temperature = climate:getTemperature(),
        humidity = climate:getHumidity(),
        windSpeed = climate:getWindspeedKph(),
        windAngle = climate:getWindAngleDegrees(),
        fogIntensity = climate:getFogIntensity(),
        cloudIntensity = cloudIntensity,
        precipitationIntensity = precipIntensity,
        isRaining = climate:isRaining(),
        isSnowing = climate:isSnowing(),
        isThunderStorming = climate.isThunderStorming and climate:isThunderStorming() or false,
        dayLight = climate:getDayLightStrength(),
        nightStrength = climate:getNightStrength(),
        desaturation = climate:getDesaturation(),
        viewDistance = climate.getViewDistance and climate:getViewDistance() or 1.0,
        ambient = climate.getAmbient and climate:getAmbient() or 1.0
    }
end

-- Trigger blizzard (duration is in hours, minimum ~2 hours in game)
handlers.triggerBlizzard = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end
    
    -- Duration is passed directly - the game adds its own minimum
    local duration = args.duration or 2.0
    
    local success, err = pcall(function()
        if climate.triggerCustomWeatherStage and WeatherPeriod and WeatherPeriod.STAGE_BLIZZARD then
            print("PanelBridge: Triggering Blizzard via triggerCustomWeatherStage")
            climate:triggerCustomWeatherStage(WeatherPeriod.STAGE_BLIZZARD, duration)
        elseif climate.transmitTriggerBlizzard then
            print("PanelBridge: Triggering Blizzard via transmitTriggerBlizzard (fallback)")
            climate:transmitTriggerBlizzard(duration)
        else
            error("No weather trigger method available")
        end
    end)
    
    if not success then
        return false, nil, "Failed to trigger blizzard: " .. tostring(err)
    end
    
    return true, { message = "Blizzard triggered", duration = duration }
end

-- Trigger tropical storm
handlers.triggerTropicalStorm = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end
    
    local duration = args.duration or 2.0
    
    local success, err = pcall(function()
        if climate.triggerCustomWeatherStage and WeatherPeriod and WeatherPeriod.STAGE_TROPICAL_STORM then
             print("PanelBridge: Triggering Tropical Storm via triggerCustomWeatherStage")
            climate:triggerCustomWeatherStage(WeatherPeriod.STAGE_TROPICAL_STORM, duration)
        elseif climate.transmitTriggerTropical then
            print("PanelBridge: Triggering Tropical Storm via transmitTriggerTropical (fallback)")
            climate:transmitTriggerTropical(duration)
        else
            error("No weather trigger method available")
        end
    end)
    
    if not success then
        return false, nil, "Failed to trigger tropical storm: " .. tostring(err)
    end
    
    return true, { message = "Tropical storm triggered", duration = duration }
end

-- Trigger regular storm
handlers.triggerStorm = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end
    
    local duration = args.duration or 2.0
    
    local success, err = pcall(function()
        if climate.triggerCustomWeatherStage and WeatherPeriod and WeatherPeriod.STAGE_STORM then
            print("PanelBridge: Triggering Storm via triggerCustomWeatherStage")
            climate:triggerCustomWeatherStage(WeatherPeriod.STAGE_STORM, duration)
        elseif climate.transmitTriggerStorm then
            print("PanelBridge: Triggering Storm via transmitTriggerStorm (fallback)")
            climate:transmitTriggerStorm(duration)
        else
            error("No weather trigger method available")
        end
    end)
    
    if not success then
        return false, nil, "Failed to trigger storm: " .. tostring(err)
    end
    
    return true, { message = "Storm triggered", duration = duration }
end

-- Stop weather
handlers.stopWeather = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end
    
    local success, err = pcall(function()
        if climate.stopWeatherAndThunder then
            print("PanelBridge: Stopping weather via stopWeatherAndThunder")
            climate:stopWeatherAndThunder()
        elseif climate.transmitServerStopWeather then
             print("PanelBridge: Stopping weather via transmitServerStopWeather (fallback)")
            climate:transmitServerStopWeather()
        elseif climate.transmitStopWeather then
             print("PanelBridge: Stopping weather via transmitStopWeather (fallback)")
            climate:transmitStopWeather()
        else
            error("No stop weather method available")
        end
    end)
    
    if not success then
        return false, nil, "Failed to stop weather: " .. tostring(err)
    end
    
    return true, { message = "Weather stopped" }
end

-- Generate custom weather period
handlers.generateWeather = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end
    
    local strength = args.strength or 0.5
    local frontType = args.frontType or 0 -- 0 = stationary, 1 = cold, 2 = warm
    
    local success, err = pcall(function()
        if climate.triggerCustomWeather then
            print("PanelBridge: Generating weather via triggerCustomWeather")
            climate:triggerCustomWeather(strength, frontType == 0)
        elseif climate.transmitGenerateWeather then
            print("PanelBridge: Generating weather via transmitGenerateWeather (fallback)")
            climate:transmitGenerateWeather(strength, frontType)
        else
            error("No generate weather method available")
        end
    end)
    
    if not success then
        return false, nil, "Failed to generate weather: " .. tostring(err)
    end
    
    return true, { message = "Weather period generated", strength = strength, frontType = frontType }
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
    if enabled and climate.isRaining and not climate:isRaining() then
        local intensity = args.intensity or 0.5
        if climate.transmitServerStartRain then
            pcall(function() climate:transmitServerStartRain(intensity) end)
        end
    end
    
    success, err = pcall(function()
        -- Try Admin Override (Robust method)
        local snowBool = climate:getClimateBool(0) -- BOOL_IS_SNOW = 0
        if snowBool then
            snowBool:setEnableAdmin(true)
            snowBool:setAdminValue(enabled)
            -- Also trigger normal method just in case
            if climate.setPrecipitationIsSnow then
                climate:setPrecipitationIsSnow(enabled)
            end
        elseif climate.setPrecipitationIsSnow then
            climate:setPrecipitationIsSnow(enabled)
        else
            error("No method to set snow")
        end
    end)
    
    if not success then
        return false, nil, "Failed to set snow: " .. tostring(err)
    end
    
    return true, { message = "Snow " .. (enabled and "enabled (with precipitation)" or "disabled") }
end

-- Start rain
handlers.startRain = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end
    
    local intensity = args.intensity or 0.5
    
    local success, err
    if climate.transmitServerStartRain then
        success, err = pcall(function() climate:transmitServerStartRain(intensity) end)
    else
        return false, nil, "transmitServerStartRain method not available in this version"
    end
    
    if not success then
        return false, nil, "Failed to start rain: " .. tostring(err)
    end
    
    return true, { message = "Rain started", intensity = intensity }
end

-- Stop rain
handlers.stopRain = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end
    
    local success, err
    if climate.transmitServerStopRain then
        success, err = pcall(function() climate:transmitServerStopRain() end)
    else
        return false, nil, "transmitServerStopRain method not available in this version"
    end
    
    if not success then
        return false, nil, "Failed to stop rain: " .. tostring(err)
    end
    
    return true, { message = "Rain stopped" }
end

-- Trigger lightning
handlers.triggerLightning = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end
    
    local x = args.x or 0
    local y = args.y or 0
    local strike = args.strike ~= false  -- default to true
    local light = args.light ~= false     -- default to true
    local rumble = args.rumble ~= false   -- default to true
    
    local success, err
    if climate.transmitServerTriggerLightning then
        success, err = pcall(function() climate:transmitServerTriggerLightning(x, y, strike, light, rumble) end)
    else
        return false, nil, "transmitServerTriggerLightning method not available in this version"
    end
    
    if not success then
        return false, nil, "Failed to trigger lightning: " .. tostring(err)
    end
    
    return true, { message = "Lightning triggered", x = x, y = y }
end

-- Set daylight strength (for darkness control)
handlers.setDayLight = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end
    
    local value = tonumber(args.value) or 1.0
    
    local success, err = pcall(function()
        local cf = climate:getClimateFloat(11) -- FLOAT_DAYLIGHT_STRENGTH = 11
        if cf then
            cf:setEnableAdmin(true)
            cf:setAdminValue(value)
        elseif climate.setDayLightStrength then
            climate:setDayLightStrength(value)
        else
            error("No method to set daylight")
        end
    end)
    
    if not success then
        return false, nil, "Failed to set daylight: " .. tostring(err)
    end
    
    return true, { message = "Daylight set to " .. value }
end

-- Set night strength
handlers.setNightStrength = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end
    
    local value = tonumber(args.value) or 0.0
    
    local success, err = pcall(function()
        local cf = climate:getClimateFloat(2) -- FLOAT_NIGHT_STRENGTH = 2
        if cf then
            cf:setEnableAdmin(true)
            cf:setAdminValue(value)
        elseif climate.setNightStrength then
            climate:setNightStrength(value)
        else
            error("No method to set night strength")
        end
    end)
    
    if not success then
        return false, nil, "Failed to set night strength: " .. tostring(err)
    end
    
    return true, { message = "Night strength set to " .. value }
end

-- Set desaturation (color saturation control)
handlers.setDesaturation = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end
    
    local value = tonumber(args.value) or 0.0
    
    local success, err = pcall(function()
        local cf = climate:getClimateFloat(0) -- FLOAT_DESATURATION = 0
        if cf then
            cf:setEnableAdmin(true)
            cf:setAdminValue(value)
        elseif climate.setDesaturation then
            climate:setDesaturation(value)
        else
            error("No method to set desaturation")
        end
    end)
    
    if not success then
        return false, nil, "Failed to set desaturation: " .. tostring(err)
    end
    
    return true, { message = "Desaturation set to " .. value }
end

-- Set view distance (fog approximation)
handlers.setViewDistance = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end
    
    local value = tonumber(args.value) or 1.0
    
    local success, err = pcall(function()
        local cf = climate:getClimateFloat(10) -- FLOAT_VIEW_DISTANCE = 10
        if cf then
            cf:setEnableAdmin(true)
            cf:setAdminValue(value)
        elseif climate.setViewDistance then
            climate:setViewDistance(value)
        else
            error("No method to set view distance")
        end
    end)
    
    if not success then
        return false, nil, "Failed to set view distance: " .. tostring(err)
    end
    
    return true, { message = "View distance set to " .. value }
end

-- Set ambient light
handlers.setAmbient = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end
    
    local value = tonumber(args.value) or 1.0
    
    local success, err = pcall(function()
        local cf = climate:getClimateFloat(9) -- FLOAT_AMBIENT = 9
        if cf then
            cf:setEnableAdmin(true)
            cf:setAdminValue(value)
        elseif climate.setAmbient then
            climate:setAmbient(value)
        else
            error("No method to set ambient")
        end
    end)
    
    if not success then
        return false, nil, "Failed to set ambient: " .. tostring(err)
    end
    
    return true, { message = "Ambient set to " .. value }
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

    local success, err = pcall(function()
        local cf = climate:getClimateFloat(4) -- FLOAT_TEMPERATURE = 4
        if cf then
            cf:setEnableAdmin(true)
            cf:setAdminValue(value)
        else
            error("No method to set temperature")
        end
    end)
    
    if not success then
        return false, nil, "Failed to set temperature: " .. tostring(err)
    end
    
    return true, { message = "Temperature set to " .. value .. "C" }
end

-- Set wind intensity
handlers.setWind = function(args)
    local climate = getClimateManager()
    if not climate then return false, nil, "ClimateManager not available" end
    
    local value = tonumber(args.value) or 0.5 -- 0 to 1
    
    local success, err = pcall(function()
        local cf = climate:getClimateFloat(6) -- FLOAT_WIND_INTENSITY = 6
        if cf then
            cf:setEnableAdmin(true)
            cf:setAdminValue(value)
        else
             error("No method to set wind")
        end
    end)
    
    if not success then return false, nil, "Failed to set wind: " .. tostring(err) end
    return true, { message = "Wind set to " .. value }
end

-- Set fog intensity
handlers.setFog = function(args)
    local climate = getClimateManager()
    if not climate then return false, nil, "ClimateManager not available" end
    
    local value = tonumber(args.value) or 0.0 -- 0 (Clear) to 1 (Silent Hill)
    
    local success, err = pcall(function()
        local cf = climate:getClimateFloat(5) -- FLOAT_FOG_INTENSITY = 5
        if cf then
            cf:setEnableAdmin(true)
            cf:setAdminValue(value)
        else
             error("No method to set fog")
        end
    end)
    
    if not success then return false, nil, "Failed to set fog: " .. tostring(err) end
    return true, { message = "Fog set to " .. value }
end

-- Set cloud intensity
handlers.setClouds = function(args)
    local climate = getClimateManager()
    if not climate then return false, nil, "ClimateManager not available" end
    
    local value = tonumber(args.value) or 0.0 -- 0 to 1
    
    local success, err = pcall(function()
        local cf = climate:getClimateFloat(8) -- FLOAT_CLOUD_INTENSITY = 8
        if cf then
            cf:setEnableAdmin(true)
            cf:setAdminValue(value)
        else
             error("No method to set clouds")
        end
    end)
    
    if not success then return false, nil, "Failed to set clouds: " .. tostring(err) end
    return true, { message = "Clouds set to " .. value }
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
    
    climateFloat:setEnableAdmin(enable)
    if enable then
        climateFloat:setAdminValue(value)
    end
    
    return true, { 
        message = "Climate float set", 
        floatId = floatId, 
        value = value, 
        enabled = enable,
        name = climateFloat:getName()
    }
end

-- Reset all climate overrides
handlers.resetClimateOverrides = function(args)
    local climate = getClimateManager()
    if not climate then
        return false, nil, "ClimateManager not available"
    end
    
    -- Disable admin override on all known float IDs (0-12)
    local resetCount = 0
    for floatId = 0, 12 do
        local cf = climate:getClimateFloat(floatId)
        if cf and cf.setEnableAdmin then
            cf:setEnableAdmin(false)
            resetCount = resetCount + 1
        end
    end
    
    return true, { message = "Climate overrides reset", floatsReset = resetCount }
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
    
    local floats = {}
    for _, info in ipairs(floatIds) do
        local cf = climate:getClimateFloat(info.id)
        if cf then
            table.insert(floats, {
                id = info.id,
                name = info.name,
                actualName = cf:getName(),
                value = cf:getFinalValue(),
                min = cf:getMin(),
                max = cf:getMax(),
                isAdminEnabled = cf.isEnableAdmin and cf:isEnableAdmin() or false
            })
        end
    end
    
    return true, { floats = floats }
end

-- ============================================
-- SOUND & NOISE HANDLERS
-- ============================================

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
    addSound(nil, x, y, z, radius, volume)
    
    return true, { 
        message = "World sound created", 
        x = x, 
        y = y, 
        z = z, 
        radius = radius, 
        volume = volume 
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
    addSound(player, x, y, z, radius, volume)
    
    return true, { 
        message = "Sound created near player", 
        username = username,
        x = x, 
        y = y, 
        z = z, 
        radius = radius, 
        volume = volume 
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
    
    addSound(nil, x, y, z, gunshotRadius, gunshotVolume)
    
    return true, { 
        message = "Gunshot sound triggered", 
        x = x, 
        y = y, 
        z = z, 
        radius = gunshotRadius 
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
    
    addSound(nil, x, y, z, alarmRadius, alarmVolume)
    
    return true, { 
        message = "Alarm sound triggered", 
        x = x, 
        y = y, 
        z = z, 
        radius = alarmRadius 
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
    
    addSound(nil, x, y, z, radius, volume)
    
    return true, { 
        message = "Noise created", 
        x = x, 
        y = y, 
        z = z, 
        radius = radius,
        volume = volume 
    }
end

-- ============================================
-- TIME & WORLD HANDLERS
-- ============================================

-- Helper to safely call a method that might not exist
local function safeCall(obj, methodName, default)
    if obj and obj[methodName] then
        local success, result = pcall(function() return obj[methodName](obj) end)
        if success then
            return result
        end
    end
    return default
end

-- Get game time info
handlers.getGameTime = function(args)
    local gameTime = getGameTime()
    if not gameTime then
        return false, nil, "GameTime not available"
    end
    
    -- Use safeCall for methods that may not exist in all PZ versions
    return true, {
        year = safeCall(gameTime, "getYear", 1993),
        month = (safeCall(gameTime, "getMonth", 0) or 0) + 1, -- Lua 1-indexed
        day = safeCall(gameTime, "getDay", 1),
        hour = safeCall(gameTime, "getTimeOfDay", 12),
        minute = safeCall(gameTime, "getMinutes", 0),
        dayOfWeek = safeCall(gameTime, "getDayOfWeek", nil),
        worldAgeHours = safeCall(gameTime, "getWorldAgeHours", 0),
        timeSinceApo = safeCall(gameTime, "getTimeSinceApo", 0),
        moonPhase = safeCall(gameTime, "getMoon", nil),
        nightsSurvived = safeCall(gameTime, "getNightsSurvived", 0)
    }
end

-- Set game time
handlers.setGameTime = function(args)
    local gameTime = getGameTime()
    if not gameTime then
        return false, nil, "GameTime not available"
    end
    
    if args.hour ~= nil then
        local hour = tonumber(args.hour) or 12
        -- Use transmit for multiplayer sync
        if gameTime.transmitSetTimeOfDay then
            gameTime:transmitSetTimeOfDay(hour)
        else
            gameTime:setTimeOfDay(hour)
        end
    end
    
    if args.day ~= nil then
        gameTime:setDay(tonumber(args.day) or gameTime:getDay())
    end
    
    if args.month ~= nil then
        gameTime:setMonth(tonumber(args.month) - 1) -- Convert to 0-indexed
    end
    
    if args.year ~= nil then
        gameTime:setYear(tonumber(args.year) or gameTime:getYear())
    end
    
    return true, { message = "Game time updated" }
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
        zombieCount = cell:getZombieList():size()
    end
    
    return true, {
        serverName = getServerName(),
        map = world:getMap() or "Unknown",
        zombiesInCell = zombieCount
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
    
    local stats = player:getStats()
    local bodyDamage = player:getBodyDamage()
    
    local playerData = {
        username = player:getUsername(),
        displayName = player:getDisplayName(),
        x = player:getX(),
        y = player:getY(),
        z = player:getZ(),
        accessLevel = player:getAccessLevel(),
        isAlive = player:isAlive(),
        isAsleep = player:isAsleep(),
        isSneaking = player:isSneaking(),
        isRunning = player:isRunning(),
        stats = {},
        health = {}
    }
    
    -- Get stats if available
    if stats then
        playerData.stats = {
            hunger = stats:getHunger(),
            thirst = stats:getThirst(),
            fatigue = stats:getFatigue(),
            stress = stats:getStress(),
            boredom = stats:getBoredom(),
            unhappiness = stats:getUnhappyness(),
            pain = stats:getPain(),
            endurance = stats:getEndurance()
        }
    end
    
    -- Get health if available
    if bodyDamage then
        playerData.health = {
            overallBodyHealth = bodyDamage:getOverallBodyHealth(),
            isInfected = bodyDamage:IsInfected(),
            isBleeding = bodyDamage:getIsBleeding(),
            health = bodyDamage:getHealth(),
            temperature = bodyDamage:getTemperature(),
            wetness = bodyDamage:getWetness()
        }
    end
    
    return true, playerData
end

-- Get all players with details
handlers.getAllPlayerDetails = function(args)
    local onlinePlayers = getOnlinePlayers()
    local players = {}
    
    for i = 0, onlinePlayers:size() - 1 do
        local player = onlinePlayers:get(i)
        local stats = player:getStats()
        local bodyDamage = player:getBodyDamage()
        
        local playerData = {
            username = player:getUsername(),
            displayName = player:getDisplayName(),
            x = player:getX(),
            y = player:getY(),
            z = player:getZ(),
            accessLevel = player:getAccessLevel(),
            isAlive = player:isAlive()
        }
        
        if stats then
            playerData.hunger = stats:getHunger()
            playerData.thirst = stats:getThirst()
            playerData.fatigue = stats:getFatigue()
        end
        
        if bodyDamage then
            playerData.health = bodyDamage:getOverallBodyHealth()
            playerData.isInfected = bodyDamage:IsInfected()
        end
        
        table.insert(players, playerData)
    end
    
    return true, { players = players }
end

-- ============================================
-- COMPREHENSIVE PLAYER EXPORT (for backup/restore)
-- ============================================

-- Helper to serialize inventory items
local function serializeInventory(container)
    if not container then return {} end
    
    local items = {}
    local itemList = container:getItems()
    if not itemList then return {} end
    
    for i = 0, itemList:size() - 1 do
        local item = itemList:get(i)
        if item then
            -- Use pcall to safely get item properties (B42 API may differ)
            local ok, itemData = pcall(function()
                local data = {
                    fullType = item:getFullType(),
                    type = item:getType(),
                    name = item:getName(),
                    count = item.getCount and item:getCount() or 1,
                    isFavorite = item.isFavorite and item:isFavorite() or false,
                    isEquipped = item.isEquipped and item:isEquipped() or false
                }
                
                -- Safely get condition
                if item.getCondition then
                    data.condition = item:getCondition()
                end
                
                -- Safely get uses
                if item.getCurrentUses then
                    data.uses = item:getCurrentUses()
                end
                
                -- Handle containers (bags, etc.) - check method exists
                if item.IsInventoryContainer and item:IsInventoryContainer() then
                    local subContainer = item:getItemContainer()
                    if subContainer then
                        data.contents = serializeInventory(subContainer)
                    end
                end
                
                -- Handle drainable items (flashlights, etc.)
                if item.getDelta then
                    data.delta = item:getDelta()
                end
                
                return data
            end)
            
            if ok and itemData then
                table.insert(items, itemData)
            end
        end
    end
    
    return items
end

-- Helper to get all perk levels
local function getPlayerPerks(player)
    local perks = {}
    
    -- Get XP object
    local xp = player:getXp()
    if not xp then return perks end
    
    -- Known perks from PerkFactory
    local perkNames = {
        "Fitness", "Strength",
        "Sprinting", "Lightfoot", "Nimble", "Sneak",
        "Axe", "Blunt", "SmallBlunt", "LongBlade", "ShortBlade", "Spear", "Maintenance",
        "Woodwork", "Cooking", "Farming", "Doctor", "Electricity", "MetalWelding",
        "Mechanics", "Tailoring", "Aiming", "Reloading",
        "Fishing", "Trapping", "PlantScavenging"
    }
    
    for _, perkName in ipairs(perkNames) do
        local perk = Perks[perkName]
        if perk then
            local level = player:getPerkLevel(perk)
            local perkXp = xp:getXP(perk)
            perks[perkName] = {
                level = level,
                xp = perkXp
            }
        end
    end
    
    return perks
end

-- Helper to get player traits
local function getPlayerTraits(player)
    local traits = {}
    
    -- B42: Traits are accessed through SurvivorDesc
    -- B41: Traits were accessed directly via player:getTraits()
    local traitList = nil
    
    -- Try B42 method first (via SurvivorDesc)
    local desc = player:getDescriptor()
    if desc then
        -- B42 uses getTraitList() or getTraits() on SurvivorDesc
        if desc.getTraitList then
            traitList = desc:getTraitList()
        elseif desc.getTraits then
            traitList = desc:getTraits()
        end
    end
    
    -- Fallback to B41 method if available
    if not traitList and player.getTraits then
        traitList = player:getTraits()
    end
    
    if traitList then
        -- Handle both ArrayList and other iterable types
        if traitList.size then
            for i = 0, traitList:size() - 1 do
                local trait = traitList:get(i)
                -- In B42, traits might be objects; get the type/name
                if type(trait) == "string" then
                    table.insert(traits, trait)
                elseif trait and trait.getType then
                    table.insert(traits, trait:getType())
                elseif trait and trait.toString then
                    table.insert(traits, trait:toString())
                else
                    table.insert(traits, tostring(trait))
                end
            end
        end
    end
    
    return traits
end

-- Helper to get known recipes
local function getKnownRecipes(player)
    local recipes = {}
    local recipeList = player:getKnownRecipes()
    
    if recipeList then
        for i = 0, recipeList:size() - 1 do
            table.insert(recipes, recipeList:get(i))
        end
    end
    
    return recipes
end

-- Helper to get worn items
local function getWornItems(player)
    local worn = {}
    local wornItems = player:getWornItems()
    
    if wornItems then
        for i = 0, wornItems:size() - 1 do
            local item = wornItems:get(i)
            if item and item:getItem() then
                table.insert(worn, {
                    location = item:getLocation(),
                    fullType = item:getItem():getFullType(),
                    condition = item:getItem():getCondition()
                })
            end
        end
    end
    
    return worn
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
    
    local exportData = {
        version = "1.1",
        exportTime = getTimestampMs(),
        serverName = getServerName(),
        
        -- Basic info
        username = player:getUsername(),
        displayName = player:getDisplayName(),
        
        -- Skills/Perks with XP (this is what we need for restore)
        perks = getPlayerPerks(player),
        
        -- Kill stats (for reference, can't easily restore)
        kills = {
            zombies = player:getZombieKills()
        },
        
        -- Main inventory
        inventory = serializeInventory(player:getInventory())
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
    
    -- Restore perks/skills
    if data.perks and options.restorePerks ~= false then
        local xp = player:getXp()
        for perkName, perkData in pairs(data.perks) do
            local perk = Perks[perkName]
            if perk and perkData.level then
                -- Use pcall for safety
                pcall(function()
                    -- Reset perk to 0 first
                    player:level0(perk)
                    -- Level up to target
                    for lvl = 1, perkData.level do
                        player:LevelPerk(perk)
                    end
                    -- Set XP if available
                    if xp and perkData.xp then
                        xp:setXP(perk, perkData.xp)
                    end
                    restored.perks = restored.perks + 1
                end)
            end
        end
    end
    
    -- Restore inventory items
    if data.inventory and options.restoreInventory ~= false then
        local inventory = player:getInventory()
        if inventory then
            -- Helper function to add items recursively
            local function addItems(container, itemList)
                for _, itemData in ipairs(itemList) do
                    local ok, result = pcall(function()
                        local count = itemData.count or 1
                        for c = 1, count do
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
                                -- Set delta if available
                                if itemData.delta and newItem.setDelta then
                                    newItem:setDelta(itemData.delta)
                                end
                                -- Handle container contents (bags)
                                if itemData.contents and newItem.getItemContainer then
                                    local subContainer = newItem:getItemContainer()
                                    if subContainer then
                                        addItems(subContainer, itemData.contents)
                                    end
                                end
                                restored.items = restored.items + 1
                            end
                        end
                    end)
                    -- Silently skip items that fail to add
                end
            end
            
            addItems(inventory, data.inventory)
        end
    end
    
    return true, {
        message = "Player data imported",
        restored = restored
    }
end

-- Teleport a player
handlers.teleportPlayer = function(args)
    local username = args.username
    local x = tonumber(args.x)
    local y = tonumber(args.y)
    local z = tonumber(args.z) or 0
    
    if not username or not x or not y then
        return false, nil, "Username, x, y required"
    end
    
    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end
    
    -- Use setPosition for server-side teleport
    player:setX(x)
    player:setY(y)
    player:setZ(z)
    
    return true, { 
        message = "Player teleported",
        newPosition = { x = x, y = y, z = z }
    }
end

-- Send a server message (to all players)
handlers.sendServerMessage = function(args)
    local message = args.message
    local color = args.color or "white" -- white, red, green, blue, yellow
    
    if not message then
        return false, nil, "Message required"
    end
    
    -- Use the global sendServerMessage function if available
    if sendServerMessage then
        sendServerMessage(message)
    else
        -- Fallback: send to each player individually
        local onlinePlayers = getOnlinePlayers()
        for i = 0, onlinePlayers:size() - 1 do
            local player = onlinePlayers:get(i)
            player:Say(message)
        end
    end
    
    return true, { message = "Message sent" }
end

-- Get sandbox options (read-only)
handlers.getSandboxOptions = function(args)
    local sandbox = getSandboxOptions()
    if not sandbox then
        return false, nil, "SandboxOptions not available"
    end
    
    -- Get commonly used sandbox settings
    local options = {
        zombieCount = sandbox:getZombieCount(),
        zombieSpeed = sandbox:getZombieSpeed(),
        dayLength = sandbox:getDayLength(),
        startMonth = sandbox:getStartMonth(),
        startDay = sandbox:getStartDay(),
        waterShutoff = sandbox:getWaterShutoff(),
        elecShutoff = sandbox:getElecShutoff(),
        zombieLore = sandbox:getZombieLore(),
        charactersPerPlayer = sandbox:getCharactersPerPlayer(),
        sleepAllowed = sandbox:getSleepAllowed(),
        sleepNeeded = sandbox:getSleepNeeded()
    }
    
    return true, { options = options }
end

-- ============================================
-- CHAT SYSTEM HANDLERS
-- ============================================

-- Send message to server chat (appears to all players)
handlers.sendToServerChat = function(args)
    local message = args.message
    local isAlert = args.isAlert or false
    
    if not message then
        return false, nil, "Message required"
    end
    
    -- Try ChatServer (primary method)
    local success, err = pcall(function()
        local chatServer = ChatServer.getInstance()
        if chatServer then
            if isAlert then
                chatServer:sendServerAlertMessageToServerChat(message)
            else
                chatServer:sendMessageToServerChat(message)
            end
        end
    end)
    
    if success then
        return true, { message = "Message sent to server chat", isAlert = isAlert }
    end
    
    -- Fallback to global sendServerMessage if available
    if sendServerMessage then
        sendServerMessage(message)
        return true, { message = "Message sent via fallback", isAlert = isAlert }
    end
    
    return false, nil, "ChatServer not available: " .. tostring(err)
end

-- Send message to admin chat (only admins see it)
handlers.sendToAdminChat = function(args)
    local message = args.message
    
    if not message then
        return false, nil, "Message required"
    end
    
    local success, err = pcall(function()
        local chatServer = ChatServer.getInstance()
        if chatServer then
            chatServer:sendMessageToAdminChat(message)
        else
            error("ChatServer not available")
        end
    end)
    
    if success then
        return true, { message = "Message sent to admin chat" }
    end
    
    return false, nil, "Failed to send to admin chat: " .. tostring(err)
end

-- Send message to general chat (with custom author name)
handlers.sendToGeneralChat = function(args)
    local message = args.message
    local author = args.author or "[Panel]"
    
    if not message then
        return false, nil, "Message required"
    end
    
    local success, err = pcall(function()
        local chatServer = ChatServer.getInstance()
        if chatServer then
            -- Uses the Discord->General method which allows author name
            chatServer:sendMessageFromDiscordToGeneralChat(author, message)
        else
            error("ChatServer not available")
        end
    end)
    
    if success then
        return true, { message = "Message sent to general chat", author = author }
    end
    
    return false, nil, "Failed to send to general chat: " .. tostring(err)
end

-- Get available chat types info
handlers.getChatInfo = function(args)
    local info = {
        availableChats = {
            "serverChat - Messages from server to all players",
            "adminChat - Messages visible only to admins",
            "generalChat - General chat with custom author name"
        },
        note = "Use sendToServerChat, sendToAdminChat, or sendToGeneralChat handlers"
    }
    
    -- Check if ChatServer is available
    local chatServerAvailable = false
    pcall(function()
        if ChatServer and ChatServer.getInstance() then
            chatServerAvailable = true
        end
    end)
    
    info.chatServerAvailable = chatServerAvailable
    
    return true, info
end

-- Force save the world
handlers.saveWorld = function(args)
    if triggerEvent then
        -- Try to trigger server save
        if getWorld() and getWorld().saveWorld then
            getWorld():saveWorld()
            return true, { message = "World save triggered" }
        end
    end
    
    return false, nil, "Cannot trigger world save from Lua"
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
    local sandbox = SandboxOptions.instance
    local elecShut = "unknown"
    local waterShut = "unknown"
    local elecModifier = 0
    local waterModifier = 0
    
    -- Check actual shutdown state from GameTime modData
    local currentHour = 0
    local elecShutStart = nil
    local waterShutStart = nil
    local powerActuallyOn = hydroPowerOn
    local waterActuallyOn = hydroPowerOn
    
    pcall(function()
        if sandbox then
            -- Use getOptionByName for B42 compatibility
            local elecOpt = sandbox:getOptionByName("ElecShut")
            local waterOpt = sandbox:getOptionByName("WaterShut")
            if elecOpt and elecOpt.getValue then
                elecShut = tostring(elecOpt:getValue())
            end
            if waterOpt and waterOpt.getValue then
                waterShut = tostring(waterOpt:getValue())
            end
            -- These are direct methods that exist
            elecModifier = sandbox:getElecShutModifier()
            waterModifier = sandbox:getWaterShutModifier()
        end
        
        -- Check the actual shutdown timers
        local gameTime = GameTime:getInstance()
        if gameTime then
            currentHour = gameTime:getWorldAgeHours()
            local modData = gameTime:getModData()
            if modData then
                elecShutStart = modData.ElecShutStart
                waterShutStart = modData.WaterShutStart
                
                -- Power is on if: hydroPowerOn is true AND (no shutdown time set OR shutdown time is in the future OR set to -1 for permanent)
                if elecShutStart then
                    if elecShutStart == -1 then
                        powerActuallyOn = hydroPowerOn -- -1 means never shut off
                    elseif elecShutStart > 0 and currentHour >= elecShutStart then
                        powerActuallyOn = false -- Past the shutdown time
                    end
                end
                
                if waterShutStart then
                    if waterShutStart == -1 then
                        waterActuallyOn = hydroPowerOn
                    elseif waterShutStart > 0 and currentHour >= waterShutStart then
                        waterActuallyOn = false
                    end
                end
            end
        end
    end)
    
    return true, {
        hydroPowerOn = hydroPowerOn,
        powerOn = powerActuallyOn,
        waterOn = waterActuallyOn,
        currentWorldHour = currentHour,
        elecShutStart = elecShutStart,
        waterShutStart = waterShutStart,
        elecShut = elecShut,
        waterShut = waterShut,
        elecShutModifier = elecModifier,
        waterShutModifier = waterModifier
    }
end

-- Helper function to activate light switches in loaded chunks around all players
local function activateLightSwitchesInLoadedChunks()
    local cell = getCell()
    if not cell then
        return 0, "No cell available"
    end
    
    local activatedCount = 0
    
    -- Get all online players to find loaded areas
    local players = getOnlinePlayers()
    if not players or players:size() == 0 then
        return 0, "No players online"
    end
    
    -- Process light switches around each player
    for p = 0, players:size() - 1 do
        local player = players:get(p)
        if player then
            local px, py = math.floor(player:getX()), math.floor(player:getY())
            
            -- Scan a reasonable area around each player (loaded chunks)
            -- Chunks are 10x10, loaded chunks extend about 50 squares around player
            for x = px - 50, px + 50 do
                for y = py - 50, py + 50 do
                    for z = 0, 7 do  -- All building levels
                        local sq = cell:getGridSquare(x, y, z)
                        if sq then
                            local objects = sq:getObjects()
                            if objects then
                                for i = 0, objects:size() - 1 do
                                    local obj = objects:get(i)
                                    -- Check if this is a light switch using instanceof
                                    if obj and instanceof(obj, "IsoLightSwitch") then
                                        -- Activate the light switch using toggle method
                                        -- IsoLightSwitch has toggle() and setActive() methods
                                        local success, toggleErr = pcall(function()
                                            if obj.toggle then
                                                -- Only toggle if currently off
                                                if not obj:isActivated() then
                                                    obj:toggle()
                                                    activatedCount = activatedCount + 1
                                                end
                                            elseif obj.setActive then
                                                obj:setActive(true)
                                                activatedCount = activatedCount + 1
                                            end
                                        end)
                                        -- Ignore individual toggle errors, continue with other switches
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

-- Helper function to set sandbox option properly via Java API
local function setSandboxOptionValue(optionName, value)
    local sandboxOptions = getSandboxOptions()
    if not sandboxOptions then
        return false, "getSandboxOptions() returned nil"
    end
    
    -- Try to get the option by name and set its value
    local option = sandboxOptions:getOptionByName(optionName)
    if option then
        -- Try different setter methods
        if option.setValue then
            local success, err = pcall(function()
                option:setValue(value)
            end)
            if success then
                return true, "setValue worked"
            end
        end
        
        -- Try setValueFromString if setValue didn't work
        if option.setValueFromString then
            local success, err = pcall(function()
                option:setValueFromString(tostring(value))
            end)
            if success then
                return true, "setValueFromString worked"
            end
        end
        
        -- Try direct value assignment
        if option.value ~= nil then
            local success, err = pcall(function()
                option.value = value
            end)
            if success then
                return true, "direct value assignment worked"
            end
        end
        
        return false, "Option found but couldn't set value"
    else
        return false, "Option not found: " .. optionName
    end
end

-- Restore power and water (turn hydro power on and reset shutdown timers)
handlers.restoreUtilities = function(args)
    local world = getWorld()
    if not world then
        return false, nil, "World not available"
    end
    
    local restorePower = args.power ~= false -- default true
    local restoreWater = args.water ~= false -- default true
    
    local debugInfo = {}
    
    local success, err = pcall(function()
        -- Get current day using getNightsSurvived() (same as RicksMLC_PowerGrid uses)
        local gameTime = GameTime.getInstance()
        local nightsSurvived = 0
        if gameTime then
            nightsSurvived = gameTime:getNightsSurvived()
        end
        table.insert(debugInfo, "nightsSurvived=" .. tostring(nightsSurvived))
        
        -- Calculate restore days - set to far future (same pattern as RicksMLC_PowerGrid)
        -- The game checks: power is ON when NightsSurvived < ElecShutModifier
        local restoreDays = nightsSurvived + 99999
        table.insert(debugInfo, "restoreDays=" .. tostring(restoreDays))
        
        if restorePower then
            -- APPROACH: Try multiple methods to restore power
            
            -- Step 1: Set the global hydro power flag ON
            world:setHydroPowerOn(true)
            table.insert(debugInfo, "setHydroPowerOn(true) called")
            
            -- Step 2: Set sandbox options via Java API
            local sandboxOptions = getSandboxOptions()
            if sandboxOptions then
                local elecOption = sandboxOptions:getOptionByName("ElecShutModifier")
                if elecOption and elecOption.setValue then
                    elecOption:setValue(restoreDays)
                    table.insert(debugInfo, "elecOption:setValue(" .. tostring(restoreDays) .. ")")
                end
            end
            
            -- Step 3: Set Lua SandboxVars table
            SandboxVars.ElecShutModifier = restoreDays
            table.insert(debugInfo, "Set SandboxVars.ElecShutModifier = " .. tostring(restoreDays))
            
            -- Step 4: Try to use GameServer.sendWorldState if available
            local gs = GameServer
            if gs then
                -- Try various GameServer methods
                if gs.sendWorldState then
                    pcall(function() gs.sendWorldState() end)
                    table.insert(debugInfo, "GameServer.sendWorldState called")
                end
                
                -- Try syncSandboxOptions
                if gs.syncSandboxOptions then
                    pcall(function() gs.syncSandboxOptions() end)
                    table.insert(debugInfo, "GameServer.syncSandboxOptions called")
                end
                
                -- Try sendSandboxOptionsToClient for each player
                if gs.sendSandboxOptionsToClient then
                    local players = getOnlinePlayers()
                    if players then
                        for i = 0, players:size() - 1 do
                            local player = players:get(i)
                            if player then
                                pcall(function()
                                    gs.sendSandboxOptionsToClient(player:getOnlineID())
                                end)
                            end
                        end
                        table.insert(debugInfo, "sendSandboxOptionsToClient called for all players")
                    end
                end
            end
            
            -- Step 5: Try ServerOptions if available (for syncing to clients)
            if ServerOptions and ServerOptions.instance then
                local serverOpts = ServerOptions.instance
                if serverOpts.sync then
                    pcall(function() serverOpts:sync() end)
                    table.insert(debugInfo, "ServerOptions sync called")
                end
            end
            
            -- Step 6: Activate light switches in loaded chunks
            local switchesActivated, statusMsg = activateLightSwitchesInLoadedChunks()
            table.insert(debugInfo, "Light switches activated: " .. tostring(switchesActivated))
            
            -- Step 7: Trigger the power on event
            if triggerEvent then
                pcall(function() triggerEvent("OnHydroPowerOn") end)
                table.insert(debugInfo, "Triggered OnHydroPowerOn event")
            end
            
            -- Step 7: Verify Java API value
            local sandboxOptions2 = getSandboxOptions()
            if sandboxOptions2 then
                local elecOption2 = sandboxOptions2:getOptionByName("ElecShutModifier")
                if elecOption2 and elecOption2.getValue then
                    local javaValue = elecOption2:getValue()
                    table.insert(debugInfo, "Java ElecShutModifier getValue: " .. tostring(javaValue))
                end
            end
            
            -- Step 8: Try transmitWeather to sync world state
            if world.transmitWeather then
                pcall(function() world:transmitWeather() end)
                table.insert(debugInfo, "transmitWeather called")
            end
            
            -- Step 9: Try to use the server's built-in sandbox sync
            -- In B42, need to find the right method
            pcall(function()
                -- Try to force a world state update
                if world.setHydroPowerOn then
                    -- Turn it OFF then ON again to trigger any listeners
                    world:setHydroPowerOn(false)
                    world:setHydroPowerOn(true)
                    table.insert(debugInfo, "Toggled hydro power to trigger update")
                end
            end)
            
            -- Step 10: Use IsoWorld's triggerNPCEvent if available
            pcall(function()
                if world.triggerNPCEvent then
                    world:triggerNPCEvent("HydroPowerChanged")
                    table.insert(debugInfo, "triggerNPCEvent called")
                end
            end)
            
            -- Step 11: Try all GameServer static methods we can find
            pcall(function()
                if GameServer then
                    local methods = {}
                    for k, v in pairs(GameServer) do
                        if type(v) == "function" and (k:lower():find("sync") or k:lower():find("sandbox") or k:lower():find("send")) then
                            table.insert(methods, k)
                        end
                    end
                    if #methods > 0 then
                        table.insert(debugInfo, "GameServer sync methods found: " .. table.concat(methods, ", "))
                    end
                end
            end)
            
            -- Step 12: Send command to all clients to refresh their power state
            local players = getOnlinePlayers()
            if players then
                for i = 0, players:size() - 1 do
                    local player = players:get(i)
                    if player then
                        sendServerCommand(player, "PanelBridge", "refreshPowerState", {powerOn = true, elecShutModifier = restoreDays})
                        -- Also send a visible message so players know to reconnect if power doesn't work
                        sendServerCommand(player, "chat", "addMessage", {
                            message = "[Server] Power has been restored. If lights don't work, reconnect to the server.",
                            type = "server"
                        })
                    end
                end
                table.insert(debugInfo, "Sent refreshPowerState to " .. tostring(players:size()) .. " players")
            end
            
            -- Step 13: Skip save() - it requires a ByteBuffer argument that can't be provided from Lua
            -- Instead, rely on applySettings which syncs the options without file I/O
            pcall(function()
                if getSandboxOptions() and getSandboxOptions().applySettings then
                    getSandboxOptions():applySettings()
                    table.insert(debugInfo, "SandboxOptions applySettings() called")
                end
            end)
            
            -- Step 14: Try sending reloadoptions command (this is what the admin panel uses)
            pcall(function()
                if executeCommand then
                    executeCommand("/reloadoptions")
                    table.insert(debugInfo, "executeCommand /reloadoptions called")
                end
            end)
            
            -- Step 15: Try ServerAPI if available
            pcall(function()
                if ServerAPI and ServerAPI.ReloadOptions then
                    ServerAPI.ReloadOptions()
                    table.insert(debugInfo, "ServerAPI.ReloadOptions called")
                end
            end)
        end
        
        if restoreWater then
            -- Same pattern for water - set WaterShutModifier to far future
            SandboxVars.WaterShutModifier = restoreDays
            table.insert(debugInfo, "Set SandboxVars.WaterShutModifier = " .. tostring(restoreDays))
        end
        
        -- Final verification
        local isPowerOn = world:isHydroPowerOn()
        table.insert(debugInfo, "After restore: isHydroPowerOn = " .. tostring(isPowerOn))
        table.insert(debugInfo, "nightsSurvived < ElecShutModifier = " .. tostring(nightsSurvived < restoreDays))
    end)
    
    if not success then
        return false, nil, "Failed to restore utilities: " .. tostring(err)
    end
    
    -- Log debug info
    print("[PanelBridge] restoreUtilities debug: " .. table.concat(debugInfo, " | "))
    
    return true, { 
        message = "Utilities restored",
        power = restorePower,
        water = restoreWater,
        hydroPowerOn = true,
        debug = debugInfo
    }
end

-- Shut off power and water
handlers.shutOffUtilities = function(args)
    local world = getWorld()
    if not world then
        return false, nil, "World not available"
    end
    
    local shutPower = args.power ~= false -- default true
    local shutWater = args.water ~= false -- default true
    
    local debugInfo = {}
    
    local success, err = pcall(function()
        -- Get current NightsSurvived (same pattern as RicksMLC_PowerGrid)
        local gameTime = GameTime.getInstance()
        local nightsSurvived = 0
        if gameTime then
            nightsSurvived = gameTime:getNightsSurvived()
        end
        table.insert(debugInfo, "nightsSurvived=" .. tostring(nightsSurvived))
        
        if shutPower then
            -- Step 1: Turn off hydro power (same as BWOEvents.SetHydroPower)
            world:setHydroPowerOn(false)
            table.insert(debugInfo, "setHydroPowerOn(false) called")
            
            -- Step 2: Set ElecShutModifier to a PAST value (0 = instant shutoff)
            -- The game checks: power is ON when NightsSurvived < ElecShutModifier
            -- By setting ElecShutModifier to 0, and NightsSurvived >= 0, power stays OFF
            SandboxVars.ElecShutModifier = 0
            table.insert(debugInfo, "Set SandboxVars.ElecShutModifier = 0")
            
            -- Step 3: Set sandbox options via Java API (like restoreUtilities)
            local sandboxOptions = getSandboxOptions()
            if sandboxOptions then
                local elecOption = sandboxOptions:getOptionByName("ElecShutModifier")
                if elecOption and elecOption.setValue then
                    elecOption:setValue(0)
                    table.insert(debugInfo, "elecOption:setValue(0)")
                end
            end
            
            -- Step 4: Try to use GameServer.sendWorldState if available
            local gs = GameServer
            if gs then
                if gs.sendWorldState then
                    pcall(function() gs.sendWorldState() end)
                    table.insert(debugInfo, "GameServer.sendWorldState called")
                end
                
                if gs.syncSandboxOptions then
                    pcall(function() gs.syncSandboxOptions() end)
                    table.insert(debugInfo, "GameServer.syncSandboxOptions called")
                end
                
                if gs.sendSandboxOptionsToClient then
                    local players = getOnlinePlayers()
                    if players then
                        for i = 0, players:size() - 1 do
                            local player = players:get(i)
                            if player then
                                pcall(function() gs.sendSandboxOptionsToClient(player:getOnlineID()) end)
                            end
                        end
                        table.insert(debugInfo, "sendSandboxOptionsToClient called for all players")
                    end
                end
            end
            
            -- Step 5: Activate light switches (turn them off)
            -- REMOVED: activateLightSwitchesInLoadedChunks() checks for OFF loops and turns them ON.
            -- calling this during shutoff actually TURNS LIGHTS BACK ON.
            -- local switchesActivated, statusMsg = activateLightSwitchesInLoadedChunks()
            -- instead, we rely on the power cut.
            
            -- Step 6: Transmit weather to sync world state
            if world.transmitWeather then
                pcall(function() world:transmitWeather() end)
                table.insert(debugInfo, "transmitWeather called")
            end
            
            -- Step 7: Apply settings
            pcall(function()
                if getSandboxOptions() and getSandboxOptions().applySettings then
                    getSandboxOptions():applySettings()
                    table.insert(debugInfo, "SandboxOptions applySettings() called")
                end
            end)
            
            -- Step 8: Notify players
             local players = getOnlinePlayers()
            if players then
                for i = 0, players:size() - 1 do
                    local player = players:get(i)
                    if player then
                        sendServerCommand(player, "PanelBridge", "refreshPowerState", {powerOn = false, elecShutModifier = 0})
                        -- Also send a visible message
                        sendServerCommand(player, "chat", "addMessage", {
                            message = "[Server] Power has been shut off.",
                            type = "server"
                        })
                    end
                end
            end
        end
        
        if shutWater then
            -- Same pattern for water
            SandboxVars.WaterShutModifier = 0
            table.insert(debugInfo, "Set SandboxVars.WaterShutModifier = 0")
            
            -- Sync Java options for water too
            local sandboxOptions = getSandboxOptions()
            if sandboxOptions then
                local waterOption = sandboxOptions:getOptionByName("WaterShutModifier")
                if waterOption and waterOption.setValue then
                    waterOption:setValue(0)
                    table.insert(debugInfo, "waterOption:setValue(0)")
                end
            end
        end
        
        -- Final verification
        local isPowerOn = world:isHydroPowerOn()
        table.insert(debugInfo, "After shutoff: isHydroPowerOn = " .. tostring(isPowerOn))
    end)
    
    if not success then
        return false, nil, "Failed to shut off utilities: " .. tostring(err)
    end
    
    -- Log debug info
    print("[PanelBridge] shutOffUtilities debug: " .. table.concat(debugInfo, " | "))
    
    return true, { 
        message = "Utilities shut off",
        power = shutPower,
        water = shutWater,
        hydroPowerOn = false,
        debug = debugInfo
    }
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
    
    local healed = {}
    
    -- Heal body damage
    local bodyDamage = player:getBodyDamage()
    if bodyDamage then
        pcall(function()
            -- Restore overall health
            for i = 0, bodyDamage:getNumOfBodyParts() - 1 do
                local part = bodyDamage:getBodyPart(i)
                if part then
                    part:SetBitten(false)
                    part:SetBleeding(false)
                    part:SetScratched(false, false)
                    part:SetDeepWounded(false)
                    part:SetInfected(false)
                    part:SetHealth(100)
                end
            end
            bodyDamage:RestoreToFullHealth()
            healed.bodyDamage = true
        end)
    end
    
    -- Restore stats
    local stats = player:getStats()
    if stats then
        pcall(function()
            stats:setHunger(0)
            stats:setThirst(0)
            stats:setFatigue(0)
            stats:setStress(0)
            stats:setBoredom(0)
            stats:setPain(0)
            stats:setEndurance(1)
            healed.stats = true
        end)
    end
    
    -- Clear moodles/effects if possible
    pcall(function()
        local moodles = player:getMoodles()
        if moodles then
            moodles:reset()
            healed.moodles = true
        end
    end)
    
    PanelBridge.info("Healed player", { username = username, healed = healed })
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
    
    local success, err = pcall(function()
        player:setHealth(0)
    end)
    
    if not success then
        return false, nil, "Failed to kill player: " .. tostring(err)
    end
    
    PanelBridge.info("Killed player", { username = username })
    return true, { message = "Player killed", username = username }
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
    
    local success, err = pcall(function()
        player:setGodMod(enabled)
    end)
    
    if not success then
        return false, nil, "Failed to set godmode: " .. tostring(err)
    end
    
    PanelBridge.info("Set godmode", { username = username, enabled = enabled })
    return true, { message = "Godmode " .. (enabled and "enabled" or "disabled"), username = username }
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
    
    local success, err = pcall(function()
        player:setInvisible(enabled)
    end)
    
    if not success then
        return false, nil, "Failed to set invisible: " .. tostring(err)
    end
    
    PanelBridge.info("Set invisible", { username = username, enabled = enabled })
    return true, { message = "Invisibility " .. (enabled and "enabled" or "disabled"), username = username }
end

-- Give item to player
handlers.giveItem = function(args)
    local username = args.username
    local itemType = args.itemType
    local count = args.count or 1
    
    if not username then
        return false, nil, "Username required"
    end
    if not itemType then
        return false, nil, "Item type required (e.g., 'Base.Axe')"
    end
    
    local player = getPlayerByUsername(username)
    if not player then
        return false, nil, "Player not found: " .. username
    end
    
    local inventory = player:getInventory()
    if not inventory then
        return false, nil, "Could not access player inventory"
    end
    
    local added = 0
    for i = 1, count do
        local ok, item = pcall(function()
            return inventory:AddItem(itemType)
        end)
        if ok and item then
            added = added + 1
        end
    end
    
    if added == 0 then
        return false, nil, "Failed to add item. Check item type: " .. itemType
    end
    
    PanelBridge.info("Gave items", { username = username, itemType = itemType, count = added })
    return true, { 
        message = "Gave " .. added .. "x " .. itemType,
        username = username,
        itemType = itemType,
        count = added
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
    local radius = args.radius or 50
    
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
                    local zx, zy = zombie:getX(), zombie:getY()
                    local dist = math.sqrt((zx - px)^2 + (zy - py)^2)
                    if dist <= radius then
                        zombie:removeFromWorld()
                        zombie:removeFromSquare()
                        removed = removed + 1
                    end
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

-- ============================================
-- MAIN PROCESSING
-- ============================================

function PanelBridge.processCommands()
    local commands = PanelBridge.readJSON("commands.json")
    if not commands or not commands.commands then
        return
    end
    
    local processedCount = 0
    
    for _, cmd in ipairs(commands.commands) do
        if cmd.id and not PanelBridge.processedIds[cmd.id] then
            PanelBridge.processedIds[cmd.id] = true
            processedCount = processedCount + 1
            
            PanelBridge.stats.commandsProcessed = PanelBridge.stats.commandsProcessed + 1
            PanelBridge.info("Processing command: " .. tostring(cmd.action), { id = cmd.id })
            
            local handler = handlers[cmd.action]
            if handler then
                -- Wrap execution for timing and error catching
                local startTime = getTimestampMs()
                local success, data, errorMsg = handler(cmd.args or {})
                local duration = getTimestampMs() - startTime
                
                if success then
                    PanelBridge.stats.commandsSucceeded = PanelBridge.stats.commandsSucceeded + 1
                    PanelBridge.debug("Command succeeded: " .. tostring(cmd.action), { 
                        duration = duration .. "ms" 
                    })
                else
                    PanelBridge.stats.commandsFailed = PanelBridge.stats.commandsFailed + 1
                    PanelBridge.warn("Command failed: " .. tostring(cmd.action), { 
                        error = errorMsg,
                        duration = duration .. "ms"
                    })
                end
                
                PanelBridge.sendResult(cmd.id, success, data, errorMsg)
            else
                PanelBridge.stats.commandsFailed = PanelBridge.stats.commandsFailed + 1
                local errorMsg = "Unknown command: " .. tostring(cmd.action)
                PanelBridge.warn(errorMsg)
                PanelBridge.sendResult(cmd.id, false, nil, errorMsg)
            end
        end
    end
    
    -- Clear commands file after processing
    -- We clear if we found ANY commands, even if they were duplicates (already processed),
    -- to prevent the file from getting stuck with old commands that prevent new ones.
    if commands.commands and #commands.commands > 0 then
        PanelBridge.clearFile("commands.json")
        if processedCount > 0 then
            PanelBridge.debug("Processed " .. processedCount .. " commands")
        end
    end
    
    -- Cleanup old processed IDs (keep manageable size, remove oldest half)
    local count = 0
    for _ in pairs(PanelBridge.processedIds) do count = count + 1 end
    if count > 100 then
        -- In Lua, we can't easily keep order, so clear half randomly
        -- This is acceptable since the main purpose is preventing re-execution
        -- and commands are processed quickly
        local removeCount = 0
        local toRemove = math.floor(count / 2)
        for id in pairs(PanelBridge.processedIds) do
            if removeCount >= toRemove then break end
            PanelBridge.processedIds[id] = nil
            removeCount = removeCount + 1
        end
        PanelBridge.debug("Cleaned up processed IDs", { removed = removeCount })
    end
end

function PanelBridge.updateStatus()
    local ok, err = pcall(function()
        local onlinePlayers = getOnlinePlayers()
        local playerNames = {}
        for i = 0, onlinePlayers:size() - 1 do
            table.insert(playerNames, onlinePlayers:get(i):getUsername())
        end
        
        local status = {
            alive = true,
            version = PanelBridge.VERSION,
            timestamp = getTimestampMs(),
            serverName = getServerName(),
            playerCount = onlinePlayers:size(),
            players = playerNames,
            path = PanelBridge.getBasePath(),
            debugMode = PanelBridge.DEBUG_MODE,
            stats = {
                processed = PanelBridge.stats.commandsProcessed,
                succeeded = PanelBridge.stats.commandsSucceeded,
                failed = PanelBridge.stats.commandsFailed
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
    
    -- Check for commands
    if now - PanelBridge.lastCheck >= PanelBridge.CHECK_INTERVAL then
        PanelBridge.lastCheck = now
        local success, err = pcall(PanelBridge.processCommands)
        if not success then
            PanelBridge.error("Tick error in processCommands", { error = tostring(err) })
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
    
    -- Detect version and available APIs
    PanelBridge.detectVersion()
    
    -- Write initial status
    PanelBridge.updateStatus()
    
    -- Clear old commands and results
    PanelBridge.clearFile("commands.json")
    
    -- Write a startup log entry
    PanelBridge.writeJSON("startup.json", {
        version = PanelBridge.VERSION,
        startTime = PanelBridge.stats.startTime,
        path = PanelBridge.getBasePath(),
        detectedVersion = PanelBridge.detectedVersion,
        serverName = getServerName()
    })
    
    PanelBridge.initialized = true
    PanelBridge.info("PanelBridge ready", { path = PanelBridge.getBasePath() })
    print("[PanelBridge] Ready at: " .. PanelBridge.getBasePath())
    print("[PanelBridge] Debug mode: " .. (PanelBridge.DEBUG_MODE and "ON" or "OFF"))
    print("[PanelBridge] ========================================")
end

-- Register events
Events.OnServerStarted.Add(PanelBridge.onServerStarted)
-- Use OnTickEvenPaused so the bridge works even when no players are connected
Events.OnTickEvenPaused.Add(PanelBridge.onTick)

return PanelBridge

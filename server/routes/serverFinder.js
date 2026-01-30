import express from 'express';
import dgram from 'dgram';
import { logger } from '../utils/logger.js';
import { getSetting } from '../database/init.js';

const router = express.Router();

// Project Zomboid App ID on Steam
const PZ_APP_ID = 108600;

// Steam Master Server addresses
const MASTER_SERVERS = [
  { host: 'hl2master.steampowered.com', port: 27011 },
];

// Timeout for queries (ms)
const QUERY_TIMEOUT = 10000;
const SERVER_QUERY_TIMEOUT = 3000;

/**
 * Query a single game server for detailed info using A2S_INFO protocol
 */
async function queryServerInfo(ip, port) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const timeout = setTimeout(() => {
      socket.close();
      resolve(null);
    }, SERVER_QUERY_TIMEOUT);

    socket.on('error', () => {
      clearTimeout(timeout);
      socket.close();
      resolve(null);
    });

    socket.on('message', (msg) => {
      clearTimeout(timeout);
      try {
        const info = parseA2SInfoResponse(msg);
        info.ip = ip;
        info.port = port;
        info.queryPort = port;
        socket.close();
        resolve(info);
      } catch (e) {
        socket.close();
        resolve(null);
      }
    });

    // A2S_INFO query packet
    // Header: 0xFFFFFFFF + 'T' (0x54) + "Source Engine Query\0"
    const query = Buffer.from([
      0xFF, 0xFF, 0xFF, 0xFF, 0x54,
      ...Buffer.from('Source Engine Query\0'),
    ]);

    socket.send(query, port, ip);
  });
}

/**
 * Parse A2S_INFO response
 */
function parseA2SInfoResponse(buffer) {
  let offset = 4; // Skip header (0xFFFFFFFF)
  
  const header = buffer.readUInt8(offset++);
  
  // Check for challenge response (0x41 = 'A')
  if (header === 0x41) {
    // Server sent a challenge, we'd need to resend with the challenge
    // For simplicity, we'll skip servers that require challenges
    throw new Error('Challenge required');
  }
  
  // 'I' (0x49) = Source server info response
  // 'm' (0x6D) = Obsolete GoldSource response
  if (header !== 0x49 && header !== 0x6D) {
    throw new Error('Invalid response header');
  }

  const info = {};

  // Protocol version
  info.protocol = buffer.readUInt8(offset++);

  // Read null-terminated strings
  const readString = () => {
    const start = offset;
    while (buffer[offset] !== 0 && offset < buffer.length) offset++;
    const str = buffer.toString('utf8', start, offset);
    offset++; // Skip null terminator
    return str;
  };

  info.name = readString();
  info.map = readString();
  info.folder = readString();
  info.game = readString();

  // Steam App ID (short)
  info.appId = buffer.readUInt16LE(offset);
  offset += 2;

  // Players
  info.players = buffer.readUInt8(offset++);
  info.maxPlayers = buffer.readUInt8(offset++);
  info.bots = buffer.readUInt8(offset++);

  // Server type: 'd' = dedicated, 'l' = listen, 'p' = SourceTV
  info.serverType = String.fromCharCode(buffer.readUInt8(offset++));

  // Environment: 'l' = Linux, 'w' = Windows, 'm'/'o' = Mac
  info.environment = String.fromCharCode(buffer.readUInt8(offset++));

  // Visibility: 0 = public, 1 = private
  info.visibility = buffer.readUInt8(offset++);
  info.isPrivate = info.visibility === 1;

  // VAC: 0 = unsecured, 1 = secured
  info.vac = buffer.readUInt8(offset++);

  // Version
  info.version = readString();

  // Extra data flag (EDF)
  if (offset < buffer.length) {
    const edf = buffer.readUInt8(offset++);
    
    // Port
    if (edf & 0x80) {
      info.gamePort = buffer.readUInt16LE(offset);
      offset += 2;
    }
    
    // Steam ID
    if (edf & 0x10) {
      // 64-bit Steam ID
      offset += 8;
    }
    
    // SourceTV
    if (edf & 0x40) {
      info.sourceTvPort = buffer.readUInt16LE(offset);
      offset += 2;
      info.sourceTvName = readString();
    }
    
    // Keywords/Tags
    if (edf & 0x20) {
      info.keywords = readString();
    }
    
    // Game ID
    if (edf & 0x01) {
      // 64-bit Game ID
      offset += 8;
    }
  }

  return info;
}

/**
 * Query Steam Master Server for game servers
 */
async function queryMasterServer(masterHost, masterPort, region = 0xFF, filters = '') {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const servers = [];
    let lastIp = '0.0.0.0';
    let lastPort = 0;

    const timeout = setTimeout(() => {
      socket.close();
      resolve(servers);
    }, QUERY_TIMEOUT);

    socket.on('error', (err) => {
      clearTimeout(timeout);
      socket.close();
      reject(err);
    });

    socket.on('message', (msg) => {
      // Parse response
      // Header: 0xFF 0xFF 0xFF 0xFF 0x66 0x0A
      if (msg.length < 6) return;

      let offset = 6;
      while (offset + 6 <= msg.length) {
        const ip = `${msg[offset]}.${msg[offset + 1]}.${msg[offset + 2]}.${msg[offset + 3]}`;
        const port = msg.readUInt16BE(offset + 4);
        offset += 6;

        // 0.0.0.0:0 marks end of list
        if (ip === '0.0.0.0' && port === 0) {
          clearTimeout(timeout);
          socket.close();
          resolve(servers);
          return;
        }

        servers.push({ ip, port });
        lastIp = ip;
        lastPort = port;
      }

      // Request more servers if list continues
      if (servers.length > 0) {
        sendQuery(lastIp, lastPort);
      }
    });

    const sendQuery = (seedIp = '0.0.0.0', seedPort = 0) => {
      // Master Server Query packet
      // Type: 0x31
      // Region: 0xFF (all regions)
      // IP:Port seed
      // Filter string
      const seedAddr = `${seedIp}:${seedPort}`;
      const filterStr = filters + '\0';
      
      const packet = Buffer.alloc(2 + seedAddr.length + 1 + filterStr.length);
      let offset = 0;
      
      packet.writeUInt8(0x31, offset++); // Query type
      packet.writeUInt8(region, offset++); // Region
      
      // Seed address
      Buffer.from(seedAddr).copy(packet, offset);
      offset += seedAddr.length;
      packet.writeUInt8(0, offset++); // Null terminator
      
      // Filter
      Buffer.from(filterStr).copy(packet, offset);
      
      socket.send(packet, masterPort, masterHost);
    };

    sendQuery();
  });
}

// Simple in-memory cache for server list
let serverCache = {
  data: null,
  timestamp: 0,
  ttl: 60000, // 1 minute cache
};

/**
 * Alternative: Use Steam Web API to get server list
 * Requires steamApiKey from settings database
 * Makes parallel requests with different filters to get more servers
 */
async function getServersFromSteamAPI(apiKey, useCache = true) {
  if (!apiKey) {
    throw new Error('Steam API Key not configured in Settings');
  }

  // Check cache
  if (useCache && serverCache.data && (Date.now() - serverCache.timestamp) < serverCache.ttl) {
    logger.debug(`Returning ${serverCache.data.length} servers from cache`);
    return serverCache.data;
  }

  const allServers = new Map(); // Use Map to deduplicate by addr
  
  // Different filters to maximize server coverage (run in parallel)
  const baseFilters = [
    `\\appid\\${PZ_APP_ID}`, // All servers (up to limit)
    `\\appid\\${PZ_APP_ID}\\white\\1`, // Whitelisted servers
    `\\appid\\${PZ_APP_ID}\\full\\1`, // Full servers (might be missed otherwise)
  ];

  const fetchWithFilter = async (filter) => {
    try {
      const url = `https://api.steampowered.com/IGameServersService/GetServerList/v1/?key=${apiKey}&filter=${encodeURIComponent(filter)}&limit=10000`;
      const response = await fetch(url);
      if (!response.ok) {
        logger.warn(`Steam API request failed for filter ${filter}: ${response.status}`);
        return [];
      }
      const data = await response.json();
      return data.response?.servers || [];
    } catch (error) {
      logger.warn(`Steam API request failed for filter ${filter}:`, error.message);
      return [];
    }
  };

  // Fetch all filters in parallel
  const results = await Promise.all(baseFilters.map(fetchWithFilter));
  
  // Merge and deduplicate
  for (const servers of results) {
    for (const server of servers) {
      if (server.addr) {
        allServers.set(server.addr, server);
      }
    }
  }
  
  logger.info(`Steam API returned ${allServers.size} unique servers`);
  
  // Update cache
  const serverArray = Array.from(allServers.values());
  serverCache = {
    data: serverArray,
    timestamp: Date.now(),
    ttl: 60000,
  };

  return serverArray;
}

/**
 * Get server list - tries Steam API first, falls back to master server query
 */
router.get('/', async (req, res) => {
  try {
    let servers = [];
    let source = 'steam_api';
    const steamApiKey = await getSetting('steamApiKey');
    let apiKeyConfigured = !!steamApiKey;
    const forceRefresh = req.query.refresh === 'true';
    let cached = false;

    // Try Steam Web API first (more reliable)
    if (steamApiKey) {
      try {
        // Check if using cache
        if (!forceRefresh && serverCache.data && (Date.now() - serverCache.timestamp) < serverCache.ttl) {
          cached = true;
        }
        const apiServers = await getServersFromSteamAPI(steamApiKey, !forceRefresh);
        servers = apiServers.map(s => {
          // Parse gametype for version and tags
          // Format: "hidden;hosted;vanilla;pvp;VERSION:42.13"
          const gametype = s.gametype || '';
          const tags = gametype.split(';').filter(t => t && !t.startsWith('VERSION:'));
          const versionMatch = gametype.match(/VERSION:([0-9.]+)/);
          const gameVersion = versionMatch ? versionMatch[1] : '';
          
          // Safely parse IP and port from addr (format: "ip:port")
          const addrParts = s.addr?.split(':') || [];
          const ip = addrParts[0] || '';
          const portFromAddr = addrParts[1] ? parseInt(addrParts[1], 10) : NaN;
          const port = !isNaN(portFromAddr) ? portFromAddr : (s.gameport || 16261);
          
          return {
            name: s.name || 'Unknown',
            ip,
            port,
            gamePort: s.gameport,
            players: s.players || 0,
            maxPlayers: s.max_players || 0,
            map: s.map || 'Muldraugh, KY',
            version: gameVersion, // Actual game version from gametype
            vac: s.secure || false,
            isPrivate: s.password || false,
            os: s.os === 'l' ? 'Linux' : s.os === 'w' ? 'Windows' : 'Unknown',
            dedicated: s.dedicated || true,
            bots: s.bots || 0,
            steamId: s.steamid,
            gamedir: s.gamedir,
            keywords: gametype, // Full gametype string
            tags: tags, // Parsed tags array (hidden, hosted, vanilla, pvp, etc.)
            ping: null, // Not available from API
          };
        });
        
        logger.info(`Found ${servers.length} PZ servers via Steam API`);
      } catch (apiError) {
        logger.warn('Steam API failed, trying master server query:', apiError.message);
        source = 'master_server';
      }
    }

    // Fallback to master server query (less reliable but works without API key)
    if (servers.length === 0) {
      source = 'master_server';
      try {
        // Query master server for Project Zomboid servers
        const filter = `\\appid\\${PZ_APP_ID}`;
        
        for (const master of MASTER_SERVERS) {
          try {
            const masterServers = await queryMasterServer(master.host, master.port, 0xFF, filter);
            
            // Query each server for details (limit concurrent queries)
            const batchSize = 50;
            for (let i = 0; i < masterServers.length; i += batchSize) {
              const batch = masterServers.slice(i, i + batchSize);
              const results = await Promise.all(
                batch.map(s => queryServerInfo(s.ip, s.port))
              );
              
              servers.push(...results.filter(Boolean));
            }
            
            if (servers.length > 0) break;
          } catch (e) {
            logger.warn(`Master server ${master.host} query failed:`, e.message);
          }
        }
        
        logger.info(`Found ${servers.length} PZ servers via master server`);
      } catch (masterError) {
        logger.error('Master server query failed:', masterError.message);
      }
    }

    // Sort by player count (descending)
    servers.sort((a, b) => (b.players || 0) - (a.players || 0));

    // Calculate statistics
    const totalPlayers = servers.reduce((sum, s) => sum + (s.players || 0), 0);
    const activeServers = servers.filter(s => s.players > 0).length;
    const totalCapacity = servers.reduce((sum, s) => sum + (s.maxPlayers || 0), 0);

    res.json({
      success: true,
      source,
      cached,
      count: servers.length,
      totalPlayers,
      activeServers,
      totalCapacity,
      servers, // Return ALL servers, frontend handles pagination
      apiKeyConfigured,
    });
  } catch (error) {
    logger.error('Failed to get server list:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Query a specific server for its current info
 */
router.get('/query', async (req, res) => {
  const { ip, port } = req.query;
  
  if (!ip || !port) {
    return res.status(400).json({
      success: false,
      error: 'IP and port are required',
    });
  }

  // Validate port is a valid number
  const portNum = parseInt(port, 10);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return res.status(400).json({
      success: false,
      error: 'Invalid port number',
    });
  }

  try {
    const info = await queryServerInfo(ip, portNum);
    
    if (!info) {
      return res.status(504).json({
        success: false,
        error: 'Server did not respond',
      });
    }

    res.json({
      success: true,
      server: info,
    });
  } catch (error) {
    logger.error('Failed to query server:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Ping a server to get latency
 */
router.get('/ping', async (req, res) => {
  const { ip, port } = req.query;
  
  if (!ip || !port) {
    return res.status(400).json({
      success: false,
      error: 'IP and port are required',
    });
  }

  // Validate port is a valid number
  const portNum = parseInt(port, 10);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return res.status(400).json({
      success: false,
      error: 'Invalid port number',
    });
  }

  const startTime = Date.now();
  
  try {
    const info = await queryServerInfo(ip, portNum);
    const ping = Date.now() - startTime;
    
    if (!info) {
      return res.json({
        success: true,
        ping: null,
        online: false,
      });
    }

    res.json({
      success: true,
      ping,
      online: true,
    });
  } catch (error) {
    res.json({
      success: true,
      ping: null,
      online: false,
    });
  }
});

/**
 * Debug endpoint - get raw Steam API data for a sample of servers
 */
router.get('/debug', async (req, res) => {
  try {
    const steamApiKey = await getSetting('steamApiKey');
    if (!steamApiKey) {
      return res.status(400).json({ error: 'Steam API key not configured' });
    }

    // Get just a few servers with raw data
    const url = `https://api.steampowered.com/IGameServersService/GetServerList/v1/?key=${steamApiKey}&filter=\\appid\\${PZ_APP_ID}\\noplayers\\0&limit=10`;
    
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(500).json({ error: `Steam API error: ${response.status}` });
    }

    const data = await response.json();
    const servers = data.response?.servers || [];

    res.json({
      success: true,
      count: servers.length,
      rawServers: servers,
      fieldNames: servers.length > 0 ? Object.keys(servers[0]) : [],
    });
  } catch (error) {
    logger.error('Debug endpoint error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;

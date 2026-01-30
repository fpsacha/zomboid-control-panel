import RconPackage from 'rcon-srcds';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import { logCommand, getSetting, getActiveServer } from '../database/init.js';

// Handle the nested default export from rcon-srcds
const Rcon = RconPackage.default || RconPackage;

export class RconService extends EventEmitter {
  constructor() {
    super();
    // Increase max listeners to prevent warnings during rapid reconnection cycles
    this.setMaxListeners(20);
    
    this.client = null;
    this.connected = false;
    this.connecting = false; // Mutex to prevent concurrent connection attempts
    this.connectPromise = null; // Store ongoing connection promise
    this.config = {
      host: process.env.RCON_HOST || '127.0.0.1',
      port: parseInt(process.env.RCON_PORT) || 27015,
      password: process.env.RCON_PASSWORD || ''
    };
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 5000;
    // Throttle connection failure logging to avoid spam
    this.lastConnectionErrorLog = 0;
    this.connectionErrorLogCooldown = 60000; // Only log once per minute
    this.configLoaded = false;
    this.serverManager = null; // Reference to ServerManager for server status checks
    
    // Periodic auto-reconnect when server is running but RCON disconnected
    this.autoReconnectInterval = null;
    this.autoReconnectDelay = 60000; // Try to reconnect every 60s if disconnected
    this.lastSuccessfulCommand = null; // Track when last command succeeded
    this.serverStarting = false; // Flag to prevent reconnects during server startup
    this.serverStartingTimeout = null; // Failsafe timeout to clear serverStarting flag
    this.connectionVersion = 0; // Version counter to invalidate stale connection attempts
    this.reconnecting = false; // Mutex to prevent concurrent reconnection attempts
    this.reconnectPromise = null; // Store ongoing reconnection promise
    
    // Connection timeout - how long to wait for authenticate() before giving up
    this.connectionTimeout = 10000; // 10 seconds
    
    // Periodic health check to detect stale connections
    this.healthCheckInterval = null;
    this.healthCheckDelay = 60000; // Check every 60s
    this.lastHealthCheck = null;
    this.consecutiveHealthFailures = 0;
    this.maxHealthFailures = 3; // Disconnect after 3 consecutive failures
    
    // Track pending clients to ensure cleanup (prevents memory leaks)
    this.pendingClients = new Set();
  }

  // Set serverStarting flag with automatic timeout failsafe
  setServerStarting(value) {
    this.serverStarting = value;
    
    // Clear any existing timeout
    if (this.serverStartingTimeout) {
      clearTimeout(this.serverStartingTimeout);
      this.serverStartingTimeout = null;
    }
    
    // If setting to true, set a failsafe timeout to clear it after 5 minutes
    if (value) {
      this.serverStartingTimeout = setTimeout(() => {
        if (this.serverStarting) {
          logger.warn('RCON: serverStarting flag was stuck for 5 minutes, clearing it');
          this.serverStarting = false;
        }
      }, 5 * 60 * 1000); // 5 minutes
    }
  }

  // Set reference to ServerManager (called after both services are instantiated)
  setServerManager(serverManager) {
    this.serverManager = serverManager;
  }

  // Start periodic auto-reconnection attempts
  startAutoReconnect() {
    if (this.autoReconnectInterval) return;
    
    this.autoReconnectInterval = setInterval(async () => {
      // Skip if server is starting - startup sequence handles connections
      if (this.serverStarting) {
        logger.debug('RCON auto-reconnect: Skipping - server is starting');
        return;
      }
      
      // Skip if already connected
      if (this.connected) {
        return;
      }
      
      // Skip if any connection attempt is already in progress
      if (this.connecting || this.reconnecting) {
        logger.debug('RCON auto-reconnect: Skipping - connection already in progress');
        return;
      }
      
      // Check if server is running before attempting
      if (this.serverManager) {
        try {
          const isRunning = await this.serverManager.checkServerRunning();
          if (isRunning) {
            logger.info('RCON auto-reconnect: Server is running, attempting connection...');
            try {
              const result = await this.connect();
              if (result) {
                logger.info('RCON auto-reconnect: Successfully connected!');
              }
            } catch (e) {
              logger.warn(`RCON auto-reconnect: Connection failed: ${e.message}`);
            }
          }
        } catch (e) {
          logger.debug(`RCON auto-reconnect: Server check error: ${e.message}`);
        }
      }
    }, this.autoReconnectDelay);
    
    // Start health check interval to detect stale connections
    this.startHealthCheck();
    
    logger.info('RCON auto-reconnect enabled (30s interval)');
  }

  // Start periodic health checks to detect dead connections
  startHealthCheck() {
    if (this.healthCheckInterval) return;
    
    this.healthCheckInterval = setInterval(async () => {
      // Only check if we think we're connected
      if (!this.connected || !this.client) {
        this.consecutiveHealthFailures = 0;
        return;
      }
      
      // Skip during server startup
      if (this.serverStarting) {
        return;
      }
      
      try {
        const result = await this.healthCheck();
        this.lastHealthCheck = Date.now();
        
        if (result.healthy) {
          this.consecutiveHealthFailures = 0;
          logger.debug('RCON health check: OK');
        } else {
          this.consecutiveHealthFailures++;
          logger.warn(`RCON health check failed (${this.consecutiveHealthFailures}/${this.maxHealthFailures}): ${result.reason}`);
          
          if (this.consecutiveHealthFailures >= this.maxHealthFailures) {
            logger.error('RCON health check: Too many failures, forcing disconnect');
            this.forceResetConnectionState();
          }
        }
      } catch (e) {
        this.consecutiveHealthFailures++;
        logger.warn(`RCON health check error (${this.consecutiveHealthFailures}/${this.maxHealthFailures}): ${e.message}`);
        
        if (this.consecutiveHealthFailures >= this.maxHealthFailures) {
          logger.error('RCON health check: Too many errors, forcing disconnect');
          this.forceResetConnectionState();
        }
      }
    }, this.healthCheckDelay);
    
    logger.info('RCON health check enabled (60s interval)');
  }

  // Stop periodic health checks
  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      this.consecutiveHealthFailures = 0;
    }
  }

  // Stop periodic auto-reconnection
  stopAutoReconnect() {
    if (this.autoReconnectInterval) {
      clearInterval(this.autoReconnectInterval);
      this.autoReconnectInterval = null;
      logger.info('RCON auto-reconnect disabled');
    }
    this.stopHealthCheck();
  }

  // Load RCON settings from active server first, then fallback to legacy settings
  async loadConfig() {
    if (this.configLoaded) return;
    try {
      // First try to get from active server
      const activeServer = await getActiveServer();
      if (activeServer?.rconPassword) {
        this.config.password = activeServer.rconPassword;
        this.config.host = activeServer.rconHost || '127.0.0.1';
        this.config.port = parseInt(activeServer.rconPort) || 27015;
        logger.info('RCON config loaded from active server');
        this.configLoaded = true;
        return;
      }
      
      // Fallback to legacy settings
      const dbHost = await getSetting('rconHost');
      const dbPort = await getSetting('rconPort');
      const dbPassword = await getSetting('rconPassword');
      
      if (dbPassword) {
        this.config.password = dbPassword;
        logger.info('RCON password loaded from legacy settings');
      }
      if (dbPort) {
        this.config.port = parseInt(dbPort);
      }
      if (dbHost) {
        this.config.host = dbHost;
      }
      this.configLoaded = true;
    } catch (error) {
      logger.debug(`Could not load RCON config from database: ${error.message}`);
    }
  }

  // Force reload config (called when active server changes)
  async reloadConfig() {
    this.configLoaded = false;
    // Disconnect if connected since credentials may have changed
    if (this.connected) {
      await this.disconnect();
    }
    await this.loadConfig();
  }

  // Force reset connection state (called when a connection attempt times out)
  // This aggressively destroys everything to ensure next attempt starts completely fresh
  forceResetConnectionState() {
    // Increment version to invalidate any in-flight connection attempts
    this.connectionVersion++;
    const version = this.connectionVersion;
    logger.info(`RCON: Force resetting connection state (version ${version})`);
    
    this.connecting = false;
    this.connectPromise = null;
    this.reconnecting = false;
    this.reconnectPromise = null;
    this.reconnectAttempts = 0;
    this.connected = false;
    this.consecutiveHealthFailures = 0;
    
    // Clear serverStarting timeout to prevent memory leak
    if (this.serverStartingTimeout) {
      clearTimeout(this.serverStartingTimeout);
      this.serverStartingTimeout = null;
    }
    this.serverStarting = false;
    
    // Clean up all pending clients to prevent memory leaks
    this._cleanupAllPendingClients();
    
    // Clean up main client
    this._cleanupClient();
    
    logger.info(`RCON: Connection state forcibly reset (ready for new attempt)`);
    this.emit('disconnected');
  }

  // Helper to clean up the RCON client socket - more aggressive cleanup to prevent memory leaks
  _cleanupClient(clientToClean = null) {
    const client = clientToClean || this.client;
    if (!client) return;
    
    // Remove from pending clients set
    this.pendingClients.delete(client);
    
    try {
      // Try multiple ways to access the underlying socket
      const socket = client.connection || client.socket || client._socket;
      if (socket) {
        try {
          // Remove all listeners first
          socket.removeAllListeners('data');
          socket.removeAllListeners('error');
          socket.removeAllListeners('close');
          socket.removeAllListeners('end');
          socket.removeAllListeners('connect');
          socket.removeAllListeners('timeout');
          socket.removeAllListeners();
          // End the connection gracefully first
          socket.end();
          // Then destroy immediately
          socket.destroy();
        } catch (e) {
          // Ignore cleanup errors
        }
      }
      
      try {
        client.disconnect();
      } catch (e) {
        // Ignore
      }
      
      try {
        if (typeof client.removeAllListeners === 'function') {
          client.removeAllListeners();
        }
      } catch (e) {
        // Ignore
      }
    } catch (e) {
      // Ignore all cleanup errors
    }
    
    // Only null out main client if we're cleaning the main client
    if (client === this.client) {
      this.client = null;
    }
  }
  
  // Clean up all pending clients (called during force reset)
  _cleanupAllPendingClients() {
    for (const client of this.pendingClients) {
      this._cleanupClient(client);
    }
    this.pendingClients.clear();
  }

  async connect() {
    // If already connected, return immediately
    if (this.connected && this.client) {
      return true;
    }
    
    // If a connection attempt is already in progress, wait for it
    if (this.connecting && this.connectPromise) {
      return this.connectPromise;
    }
    
    // Set mutex and create promise for concurrent callers to await
    this.connecting = true;
    this.connectPromise = this._doConnect();
    
    try {
      const result = await this.connectPromise;
      return result;
    } finally {
      this.connecting = false;
      this.connectPromise = null;
    }
  }

  async _doConnect() {
    // Capture current version at start - if it changes, this attempt is stale
    const startVersion = this.connectionVersion;
    
    // Load config from database before connecting
    await this.loadConfig();
    
    // Check if version changed (connection was force reset)
    if (this.connectionVersion !== startVersion) {
      logger.info('RCON: Connection attempt cancelled (force reset occurred)');
      return false;
    }
    
    // Check if server is running before attempting connection (skip if disabled)
    // This check can be slow on some systems, so we allow bypassing it
    const skipServerCheck = process.env.RCON_SKIP_SERVER_CHECK === 'true';
    
    if (!skipServerCheck && this.serverManager) {
      let timeoutId;
      try {
        // Add a shorter timeout for the server check to avoid long waits
        const checkPromise = this.serverManager.checkServerRunning();
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Server check timeout')), 5000);
        });
        
        const isServerRunning = await Promise.race([checkPromise, timeoutPromise]);
        clearTimeout(timeoutId);
        if (!isServerRunning) {
          logger.debug('RCON: Skipping connection - server is not running');
          this.connected = false;
          return false;
        }
      } catch (error) {
        clearTimeout(timeoutId);
        // On timeout or error, proceed with connection attempt anyway
        logger.debug(`RCON: Server check failed (${error.message}), attempting connection anyway...`);
      }
    }
    
    // Check if version changed again
    if (this.connectionVersion !== startVersion) {
      logger.info('RCON: Connection attempt cancelled (force reset occurred)');
      return false;
    }
    
    // Double-check in case connection completed while waiting
    if (this.connected && this.client) {
      return true;
    }

    try {
      // Clean up any existing client before creating new one
      if (this.client) {
        try {
          const socket = this.client.connection || this.client.socket || this.client._socket;
          if (socket) {
            socket.removeAllListeners();
            socket.destroy();
          }
          this.client.disconnect();
        } catch (e) {
          // Ignore disconnect errors
        }
        this.client = null;
      }
      
      logger.info(`RCON: Creating new client for ${this.config.host}:${this.config.port} (version ${startVersion})`);
      
      const newClient = new Rcon({
        host: this.config.host,
        port: this.config.port,
        timeout: 5000
      });
      
      // Increase max listeners on the internal socket to prevent warnings during rapid reconnections
      try {
        const socket = newClient.connection || newClient.socket || newClient._socket;
        if (socket && typeof socket.setMaxListeners === 'function') {
          socket.setMaxListeners(20);
        }
      } catch (e) {
        // Ignore - socket may not be created yet
      }
      
      // Track this client so it can be cleaned up if connection is force reset
      this.pendingClients.add(newClient);
      this.client = newClient;

      logger.info('RCON: Calling authenticate()...');
      
      // Wrap authenticate() with a timeout to prevent hanging forever
      let authTimeoutId;
      const authPromise = this.client.authenticate(this.config.password);
      const timeoutPromise = new Promise((_, reject) => {
        authTimeoutId = setTimeout(() => {
          reject(new Error(`Authentication timed out after ${this.connectionTimeout}ms`));
        }, this.connectionTimeout);
      });
      
      try {
        await Promise.race([authPromise, timeoutPromise]);
      } finally {
        clearTimeout(authTimeoutId);
      }
      
      // Check if version changed during authenticate (which can hang)
      if (this.connectionVersion !== startVersion) {
        logger.info('RCON: Connection succeeded but version changed - discarding stale connection');
        this._cleanupClient(newClient);
        return false;
      }
      
      // Connection successful - remove from pending and keep as main client
      this.pendingClients.delete(newClient);
      this.connected = true;
      this.reconnectAttempts = 0;
      this.consecutiveHealthFailures = 0;
      logger.info(`RCON connected to ${this.config.host}:${this.config.port}`);
      // Emit connected event for other services (like PanelBridge) to react
      this.emit('connected');
      return true;
    } catch (error) {
      this.connected = false;
      // Clean up failed client to prevent memory leak
      this._cleanupClient();
      
      // Throttle connection failure logs to avoid spam when server is offline
      const now = Date.now();
      if (now - this.lastConnectionErrorLog > this.connectionErrorLogCooldown) {
        this.lastConnectionErrorLog = now;
        // Use warn for expected errors (server offline), error for unexpected
        if (error.message.includes('ECONNREFUSED') || error.message.includes('ETIMEDOUT') || error.message.includes('timed out')) {
          logger.warn(`RCON connection failed (server may be offline): ${error.message}`);
        } else {
          logger.error(`RCON connection failed: ${error.message}`);
        }
      }
      throw error;
    }
  }

  async disconnect() {
    const wasConnected = this.connected;
    
    if (this.client) {
      try {
        this.client.disconnect();
      } catch (e) {
        // Ignore disconnect errors
      }
      this.client = null;
    }
    
    this.connected = false;
    this.lastSuccessfulCommand = null;
    
    if (wasConnected) {
      logger.info('RCON disconnected');
      // Emit disconnected event
      this.emit('disconnected');
    }
  }

  async reconnect() {
    // Don't attempt reconnect during server startup - the startup sequence handles it
    if (this.serverStarting) {
      logger.debug('RCON reconnect: Skipping - server is starting');
      return false;
    }
    
    // If already connected, no need to reconnect
    if (this.connected) {
      logger.debug('RCON reconnect: Already connected');
      return true;
    }
    
    // If a reconnection is already in progress, wait for it instead of starting a new one
    if (this.reconnecting && this.reconnectPromise) {
      logger.debug('RCON reconnect: Already in progress, waiting for existing attempt...');
      return this.reconnectPromise;
    }
    
    // If a connection is in progress, wait for it
    if (this.connecting && this.connectPromise) {
      logger.debug('RCON reconnect: Connection in progress, waiting...');
      try {
        return await this.connectPromise;
      } catch (e) {
        // Connection failed, continue to reconnect
      }
    }
    
    // Set mutex and create promise for concurrent callers to await
    this.reconnecting = true;
    this.reconnectPromise = this._doReconnect();
    
    try {
      const result = await this.reconnectPromise;
      return result;
    } finally {
      this.reconnecting = false;
      this.reconnectPromise = null;
    }
  }

  async _doReconnect() {
    // Capture version at start - if it changes, we should abort
    const startVersion = this.connectionVersion;
    
    await this.disconnect();
    
    while (this.reconnectAttempts < 30) {
      // Check if force reset happened - abort immediately
      if (this.connectionVersion !== startVersion) {
        logger.debug('RCON reconnect: Version changed (force reset), aborting');
        this.reconnectAttempts = 0;
        return false;
      }
      
      this.reconnectAttempts++;
      logger.info(`RCON reconnecting... Attempt ${this.reconnectAttempts}`);
      
      // Exponential backoff with cap: 5s, 10s, 15s, 20s, 25s, then stay at 30s
      const delay = Math.min(this.reconnectDelay * this.reconnectAttempts, 30000);
      await new Promise(resolve => setTimeout(resolve, delay));
      
      // Check again after delay
      if (this.connectionVersion !== startVersion) {
        logger.debug('RCON reconnect: Version changed (force reset), aborting');
        this.reconnectAttempts = 0;
        return false;
      }
      
      // Check if server startup began while we were waiting
      if (this.serverStarting) {
        logger.debug('RCON reconnect: Server starting, aborting reconnect loop');
        this.reconnectAttempts = 0;
        return false;
      }
      
      // If already connected (by another path), we're done
      if (this.connected) {
        logger.debug('RCON reconnect: Already connected, stopping');
        this.reconnectAttempts = 0;
        return true;
      }
      
      try {
        const result = await this.connect();
        if (result) {
          // Reset attempts on successful reconnection
          this.reconnectAttempts = 0;
          logger.info('RCON reconnected successfully');
          return true;
        }
        // If connect returns false (server not running), don't retry
        logger.debug('RCON reconnect: Server not running, stopping attempts');
        this.reconnectAttempts = 0;
        return false;
      } catch (error) {
        // Connection failed, will retry in next loop iteration
        logger.debug(`RCON reconnect attempt ${this.reconnectAttempts} failed: ${error.message}`);
      }
    }
    
    // Max attempts reached
    logger.warn('RCON reconnect: Max attempts (30) reached, giving up. Auto-reconnect will retry later.');
    this.reconnectAttempts = 0;
    return false;
  }

  // Execute a command with optional skipLog to avoid polluting command history with automatic commands
  async execute(command, { skipLog = false } = {}) {
    try {
      // If server is starting, don't try to connect yet
      if (this.serverStarting) {
        return { success: false, error: 'Server is starting, please wait...' };
      }
      
      if (!this.connected) {
        const connectResult = await this.connect();
        // If connect returns false, server is not running
        if (connectResult === false) {
          return { success: false, error: 'Server is not running' };
        }
      }

      logger.debug(`RCON executing: ${command}`);
      const response = await this.client.execute(command);
      
      // Track successful command for connection health monitoring
      this.lastSuccessfulCommand = Date.now();
      
      // Log to database (unless skipLog is set for automatic commands)
      if (!skipLog) {
        logCommand(command, response, true);
      }
      
      logger.debug(`RCON response: ${response}`);
      return { success: true, response: response || 'Command executed successfully' };
    } catch (error) {
      const errorMsg = error.message || 'Unknown error';
      
      // Categorize errors for better handling
      const isConnectionError = errorMsg.includes('ECONNREFUSED') || 
                                 errorMsg.includes('ETIMEDOUT') || 
                                 errorMsg.includes('ECONNRESET') ||
                                 errorMsg.includes('EPIPE') ||
                                 errorMsg.includes('not connected') || 
                                 errorMsg.includes('timeout') ||
                                 errorMsg.includes('socket');
      
      const isServerOffline = errorMsg.includes('Server is not running');
      
      // Use debug for connection-related failures to avoid log spam
      if (isConnectionError || isServerOffline) {
        logger.debug(`RCON command skipped (${isServerOffline ? 'server offline' : 'connection error'}): ${command}`);
      } else {
        logger.warn(`RCON command failed: ${errorMsg}`);
      }
      
      // Mark as disconnected on connection errors
      if (isConnectionError) {
        this.connected = false;
        this.client = null;
        
        // Don't try to reconnect during server startup - the startup sequence handles it
        if (this.serverStarting) {
          if (!skipLog) {
            logCommand(command, 'Server is starting...', false);
          }
          return { success: false, error: 'Server is starting, please wait...' };
        }
        
        // Try to reconnect and retry the command
        try {
          await this.reconnect();
          // Retry the command after reconnection (if reconnect succeeded)
          if (this.connected && this.client) {
            const response = await this.client.execute(command);
            this.lastSuccessfulCommand = Date.now();
            if (!skipLog) {
              logCommand(command, response, true);
            }
            return { success: true, response: response || 'Command executed successfully' };
          } else {
            // Reconnect returned false or didn't connect
            if (!skipLog) {
              logCommand(command, 'Connection failed', false);
            }
            return { success: false, error: 'RCON reconnection failed' };
          }
        } catch (reconnectError) {
          const reconnectMsg = this.getUserFriendlyError(reconnectError.message);
          if (!skipLog) {
            logCommand(command, reconnectMsg, false);
          }
          return { success: false, error: reconnectMsg };
        }
      }
      
      const friendlyError = this.getUserFriendlyError(errorMsg);
      if (!skipLog) {
        logCommand(command, friendlyError, false);
      }
      return { success: false, error: friendlyError };
    }
  }

  // Convert technical errors to user-friendly messages
  getUserFriendlyError(errorMsg) {
    if (!errorMsg) return 'Unknown error occurred';
    
    if (errorMsg.includes('ECONNREFUSED')) {
      return 'Cannot connect to server. Is the game server running with RCON enabled?';
    }
    if (errorMsg.includes('ETIMEDOUT') || errorMsg.includes('timed out')) {
      return 'Connection timed out. Server may be unresponsive or firewall is blocking.';
    }
    if (errorMsg.includes('ECONNRESET') || errorMsg.includes('EPIPE')) {
      return 'Connection was reset. Server may have restarted or crashed.';
    }
    if (errorMsg.includes('authentication') || errorMsg.includes('password')) {
      return 'Authentication failed. Check RCON password in server settings.';
    }
    if (errorMsg.includes('Max reconnection attempts')) {
      return 'Could not reconnect after multiple attempts. Server may be offline.';
    }
    if (errorMsg.includes('not connected')) {
      return 'Not connected to server. Please check if server is running.';
    }
    if (errorMsg.includes('Server is not running')) {
      return 'Game server is not running.';
    }
    
    return errorMsg;
  }

  // Sanitize input for RCON commands to prevent injection
  sanitize(input) {
    if (input === null || input === undefined) return '';
    // Remove/escape characters that could break command parsing
    return String(input).replace(/["\\]/g, '');
  }

  // Server commands
  async save({ skipLog = false } = {}) {
    return this.execute('save', { skipLog });
  }

  async quit({ skipLog = false } = {}) {
    // The quit command will shutdown the server and close the connection
    // This may result in connection errors which are expected
    try {
      const result = await this.execute('quit', { skipLog });
      // Mark as disconnected since server is shutting down
      this.connected = false;
      this.client = null;
      return result;
    } catch (error) {
      // Connection errors are expected when server shuts down
      // The server may close the connection before we receive a response
      if (error.message.includes('ECONNRESET') || 
          error.message.includes('EPIPE') ||
          error.message.includes('ECONNREFUSED') ||
          error.message.includes('socket') ||
          error.message.includes('connection')) {
        this.connected = false;
        this.client = null;
        return { success: true, response: 'Server shutting down' };
      }
      throw error;
    }
  }

  async serverMessage(message, { skipLog = false } = {}) {
    return this.execute(`servermsg "${this.sanitize(message)}"`, { skipLog });
  }

  async getPlayers() {
    // Skip logging for automatic player polling to avoid cluttering command history
    const result = await this.execute('players', { skipLog: true });
    if (result.success) {
      return { 
        success: true, 
        players: this.parsePlayers(result.response) 
      };
    }
    return result;
  }

  parsePlayers(response) {
    // Parse the players response
    // Format typically: "Players connected (X):\n-username\n-username2"
    const players = [];
    if (!response) return players;
    
    const lines = response.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('-')) {
        players.push({
          name: trimmed.substring(1).trim(),
          online: true
        });
      }
    }
    return players;
  }

  // Player commands
  async kickPlayer(username, reason = '') {
    const safeUser = this.sanitize(username);
    const safeReason = this.sanitize(reason);
    const cmd = safeReason 
      ? `kick "${safeUser}" -r "${safeReason}"`
      : `kick "${safeUser}"`;
    return this.execute(cmd);
  }

  async banPlayer(username, banIp = false, reason = '') {
    const safeUser = this.sanitize(username);
    const safeReason = this.sanitize(reason);
    let cmd = `banuser "${safeUser}"`;
    if (banIp) cmd += ' -ip';
    if (safeReason) cmd += ` -r "${safeReason}"`;
    return this.execute(cmd);
  }

  async unbanPlayer(username) {
    return this.execute(`unbanuser "${this.sanitize(username)}"`);
  }

  async setAccessLevel(username, level) {
    return this.execute(`setaccesslevel "${this.sanitize(username)}" "${this.sanitize(level)}"`);
  }

  async addToWhitelist(username) {
    return this.execute(`addusertowhitelist "${this.sanitize(username)}"`);
  }

  async removeFromWhitelist(username) {
    return this.execute(`removeuserfromwhitelist "${this.sanitize(username)}"`);
  }

  async teleportPlayer(player1, player2 = null) {
    const safeP1 = this.sanitize(player1);
    if (player2) {
      return this.execute(`teleport "${safeP1}" "${this.sanitize(player2)}"`);
    }
    return this.execute(`teleport "${safeP1}"`);
  }

  async teleportTo(x, y, z) {
    // Coordinates are already validated as numbers in routes
    return this.execute(`teleportto ${x},${y},${z}`);
  }

  // Items and XP
  async addItem(username, item, count = 1) {
    const safeItem = this.sanitize(item);
    if (username) {
      return this.execute(`additem "${this.sanitize(username)}" "${safeItem}" ${count}`);
    }
    return this.execute(`additem "${safeItem}" ${count}`);
  }

  async addXp(username, perk, amount) {
    return this.execute(`addxp "${this.sanitize(username)}" ${this.sanitize(perk)}=${amount}`);
  }

  async addVehicle(vehicle, username = null) {
    const safeVehicle = this.sanitize(vehicle);
    if (username) {
      return this.execute(`addvehicle "${safeVehicle}" "${this.sanitize(username)}"`);
    }
    return this.execute(`addvehicle "${safeVehicle}"`);
  }

  // Weather
  async startRain(intensity = null) {
    if (intensity) {
      return this.execute(`startrain ${intensity}`);
    }
    return this.execute('startrain');
  }

  async stopRain() {
    return this.execute('stoprain');
  }

  async startStorm(duration = null) {
    if (duration) {
      return this.execute(`startstorm ${duration}`);
    }
    return this.execute('startstorm');
  }

  async stopWeather() {
    return this.execute('stopweather');
  }

  // Events
  async triggerChopper() {
    return this.execute('chopper');
  }

  async triggerGunshot() {
    return this.execute('gunshot');
  }

  async triggerLightning(username = null) {
    if (username) {
      return this.execute(`lightning "${this.sanitize(username)}"`);
    }
    return this.execute('lightning');
  }

  async triggerThunder(username = null) {
    if (username) {
      return this.execute(`thunder "${this.sanitize(username)}"`);
    }
    return this.execute('thunder');
  }

  async createHorde(count, username = null) {
    // count is validated as number in routes
    if (username) {
      return this.execute(`createhorde ${count} "${this.sanitize(username)}"`);
    }
    return this.execute(`createhorde ${count}`);
  }

  // Admin modes
  async setGodMode(username, enabled) {
    const value = enabled ? '-true' : '-false';
    if (username) {
      return this.execute(`godmod "${this.sanitize(username)}" ${value}`);
    }
    return this.execute(`godmod ${value}`);
  }

  async setInvisible(username, enabled) {
    const value = enabled ? '-true' : '-false';
    if (username) {
      return this.execute(`invisible "${this.sanitize(username)}" ${value}`);
    }
    return this.execute(`invisible ${value}`);
  }

  async setNoclip(username, enabled) {
    const value = enabled ? '-true' : '-false';
    if (username) {
      return this.execute(`noclip "${this.sanitize(username)}" ${value}`);
    }
    return this.execute(`noclip ${value}`);
  }

  // Mod check
  async checkModsNeedUpdate() {
    return this.execute('checkModsNeedUpdate');
  }

  // Options
  async showOptions() {
    return this.execute('showoptions');
  }

  async reloadOptions() {
    return this.execute('reloadoptions');
  }

  async changeOption(optionName, newValue) {
    // Options are pre-validated in routes, but sanitize anyway
    return this.execute(`changeoption ${this.sanitize(optionName)} "${this.sanitize(newValue)}"`);
  }

  // Ban by SteamID
  async banSteamId(steamId) {
    return this.execute(`banid ${this.sanitize(steamId)}`);
  }

  async unbanSteamId(steamId) {
    return this.execute(`unbanid ${this.sanitize(steamId)}`);
  }

  // Voice ban
  async voiceBan(username, enabled) {
    const value = enabled ? '-true' : '-false';
    return this.execute(`voiceban "${this.sanitize(username)}" ${value}`);
  }

  // Whitelist management
  async addUser(username, password) {
    return this.execute(`adduser "${this.sanitize(username)}" "${this.sanitize(password)}"`);
  }

  async addAllToWhitelist() {
    return this.execute('addalltowhitelist');
  }

  // Events
  async alarm() {
    return this.execute('alarm');
  }

  // Lua
  async reloadLua(filename) {
    return this.execute(`reloadlua "${this.sanitize(filename)}"`);
  }

  // Logging
  async setLogLevel(type, level) {
    return this.execute(`log "${this.sanitize(type)}" ${this.sanitize(level)}`);
  }

  // Statistics
  async setStats(mode, period = null) {
    if (period) {
      return this.execute(`stats ${this.sanitize(mode)} ${period}`);
    }
    return this.execute(`stats ${this.sanitize(mode)}`);
  }

  // Remove zombies
  async removeZombies() {
    return this.execute('removezombies');
  }

  // Safehouse
  async releaseSafehouse() {
    return this.execute('releasesafehouse');
  }

  // Test if connection is actually alive by sending a simple command
  async healthCheck() {
    if (!this.connected || !this.client) {
      return { healthy: false, reason: 'Not connected' };
    }
    
    try {
      // Use 'players' command as a lightweight health check
      const response = await this.client.execute('players');
      this.lastSuccessfulCommand = Date.now();
      return { healthy: true, lastCommand: this.lastSuccessfulCommand };
    } catch (error) {
      // Connection is dead, mark as disconnected
      this.connected = false;
      this.client = null;
      logger.warn(`RCON health check failed: ${error.message}`);
      this.emit('disconnected');
      return { healthy: false, reason: error.message };
    }
  }

  // Status check
  isConnected() {
    return this.connected;
  }

  getConfig() {
    return {
      host: this.config.host,
      port: this.config.port,
      connected: this.connected,
      lastSuccessfulCommand: this.lastSuccessfulCommand,
      reconnectAttempts: this.reconnectAttempts,
      autoReconnectEnabled: !!this.autoReconnectInterval
    };
  }

  updateConfig(host, port, password) {
    this.config.host = host || this.config.host;
    this.config.port = port || this.config.port;
    this.config.password = password || this.config.password;
    
    // Reconnect with new config
    if (this.connected) {
      this.disconnect();
    }
  }
}

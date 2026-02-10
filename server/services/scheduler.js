import cron from 'node-cron';
import { createLogger } from '../utils/logger.js';
const log = createLogger('Scheduler');
import { 
  getScheduledTasks, 
  updateTaskLastRun, 
  logServerEvent,
  logScheduleExecution,
  getSetting,
  setSetting 
} from '../database/init.js';

export class Scheduler {
  constructor(rconService, serverManager) {
    this.rconService = rconService;
    this.serverManager = serverManager;
    this.backupService = null;
    this.jobs = new Map();
    this.autoRestartJob = null;
    this.backupJob = null;
    this.modUpdateRestartPending = false;
    this.restartInProgress = false;
    this.runningTasks = new Set(); // Track tasks currently executing to prevent duplicates
    this.warningJobs = []; // Initialize to prevent undefined iteration
  }

  setBackupService(backupService) {
    this.backupService = backupService;
  }

  async init() {
    // Load saved scheduled tasks
    await this.loadScheduledTasks();
    
    // Setup auto-restart if enabled
    this.setupAutoRestart();
    
    // Setup backup schedule if enabled
    await this.setupBackupSchedule();
    
    log.info('Scheduler initialized');
  }

  async loadScheduledTasks() {
    try {
      const tasks = await getScheduledTasks();
      
      if (!tasks || !Array.isArray(tasks)) {
        log.info('No scheduled tasks found');
        return;
      }
      
      for (const task of tasks) {
        if (task.enabled) {
          const scheduled = this.scheduleTask(task);
          if (!scheduled) {
              log.warn(`Failed to schedule task ${task.id} (${task.name}) - see previous errors`);
          }
        }
      }
      
      log.info(`Loaded ${tasks.length} scheduled tasks`);
    } catch (error) {
      log.error(`Failed to load scheduled tasks: ${error.message}`);
    }
  }

  scheduleTask(task) {
    if (!cron.validate(task.cron_expression)) {
      log.error(`Invalid cron expression for task ${task.id} (${task.name}): ${task.cron_expression}`);
      return false;
    }

    // Cancel existing job if any
    if (this.jobs.has(task.id)) {
      this.jobs.get(task.id).stop();
    }

    const job = cron.schedule(task.cron_expression, async () => {
      // Prevent duplicate execution of same task
      if (this.runningTasks.has(task.id)) {
        log.debug(`Skipping duplicate execution of task ${task.name} (already running)`);
        return;
      }
      
      this.runningTasks.add(task.id);
      log.info(`Executing scheduled task: ${task.name}`);
      const startTime = Date.now();
      try {
        await this.executeTask(task);
        const duration = Date.now() - startTime;
        await updateTaskLastRun(task.id);
        await logScheduleExecution(task.id, task.name, task.command, true, 'Completed successfully', duration);
        await logServerEvent('scheduled_task', `Executed: ${task.name}`);
      } catch (error) {
        const duration = Date.now() - startTime;
        log.error(`Scheduled task failed ${task.name}: ${error.message}`);
        await logScheduleExecution(task.id, task.name, task.command, false, error.message, duration);
        await logServerEvent('scheduled_task_error', `${task.name}: ${error.message}`);
      } finally {
        this.runningTasks.delete(task.id);
      }
    });

    this.jobs.set(task.id, job);
    log.info(`Scheduled task: ${task.name} (${task.cron_expression})`);
    return true;
  }

  async executeTask(task) {
    const commandLower = task.command.toLowerCase();
    
    // Handle special commands - skip logging for automated scheduled tasks
    if (commandLower === 'restart') {
      const result = await this.performRestart();
      // If restart was skipped (already in progress), throw to mark task as failed
      if (!result.success && result.message === 'Restart already in progress') {
        throw new Error('Restart skipped - already in progress');
      }
    } else if (commandLower === 'save') {
      await this.rconService.save({ skipLog: true });
    } else if (commandLower.startsWith('servermsg ')) {
      // Preserve original casing for the message text
      const message = task.command.substring(10);
      await this.rconService.serverMessage(message, { skipLog: true });
    } else {
      // Execute as raw RCON command - skip logging for scheduled tasks
      await this.rconService.execute(task.command, { skipLog: true });
    }
  }

  cancelTask(taskId) {
    if (this.jobs.has(taskId)) {
      this.jobs.get(taskId).stop();
      this.jobs.delete(taskId);
      log.info(`Cancelled scheduled task: ${taskId}`);
      return true;
    }
    return false;
  }

  /**
   * Cancel an in-progress restart countdown
   */
  cancelRestart() {
    if (this.restartInProgress) {
      this.restartCancelled = true;
      log.info('Restart cancellation requested');
      return { success: true, message: 'Restart cancellation requested' };
    }
    return { success: false, message: 'No restart in progress' };
  }

  /**
   * Stop all scheduled jobs - used for graceful shutdown
   */
  stopAllJobs() {
    // Stop all task jobs
    for (const [taskId, job] of this.jobs) {
      job.stop();
      log.debug(`Stopped scheduled task: ${taskId}`);
    }
    this.jobs.clear();
    
    // Stop auto-restart job
    if (this.autoRestartJob) {
      this.autoRestartJob.stop();
      this.autoRestartJob = null;
    }
    
    // Stop warning jobs
    if (this.warningJobs) {
      for (const job of this.warningJobs) {
        job.stop();
      }
      this.warningJobs = [];
    }
    
    // Stop backup job
    if (this.backupJob) {
      this.backupJob.stop();
      this.backupJob = null;
    }
    
    log.info('All scheduled jobs stopped');
  }

  async setupBackupSchedule() {
    // Stop existing backup job if any
    if (this.backupJob) {
      this.backupJob.stop();
      this.backupJob = null;
    }

    if (!this.backupService) {
      log.debug('Backup service not available');
      return;
    }

    try {
      const settings = await this.backupService.getSettings();
      
      if (!settings.enabled) {
        log.info('Scheduled backups are disabled');
        return;
      }

      if (!cron.validate(settings.schedule)) {
        log.error(`Invalid backup schedule cron expression: ${settings.schedule}`);
        return;
      }

      this.backupJob = cron.schedule(settings.schedule, async () => {
        log.info('Executing scheduled backup');
        const startTime = Date.now();
        try {
          const result = await this.backupService.createBackup({ includeDb: settings.includeDb });
          const duration = Date.now() - startTime;
          if (result.success) {
            await logScheduleExecution(null, 'Scheduled Backup', 'backup', true, `Created: ${result.backup.name}`, duration);
            log.info(`Scheduled backup completed: ${result.backup.name}`);
          } else {
            await logScheduleExecution(null, 'Scheduled Backup', 'backup', false, result.message, duration);
            log.error(`Scheduled backup failed: ${result.message}`);
          }
        } catch (error) {
          const duration = Date.now() - startTime;
          await logScheduleExecution(null, 'Scheduled Backup', 'backup', false, error.message, duration);
          log.error(`Scheduled backup error: ${error.message}`);
        }
      });

      log.info(`Backup schedule configured: ${settings.schedule}`);
    } catch (error) {
      log.error(`Failed to setup backup schedule: ${error.message}`);
    }
  }

  setupAutoRestart() {
    const enabled = process.env.AUTO_RESTART_ENABLED === 'true';
    const cronExpression = process.env.AUTO_RESTART_CRON || '0 */6 * * *';
    const warningMinutes = parseInt(process.env.RESTART_WARNING_MINUTES, 10) || 5;

    if (!enabled) {
      log.info('Auto-restart is disabled');
      return;
    }

    if (!cron.validate(cronExpression)) {
      log.error(`Invalid auto-restart cron expression: ${cronExpression}`);
      return;
    }

    // Stop existing auto-restart job if any to prevent leaks
    if (this.autoRestartJob) {
      this.autoRestartJob.stop();
      this.autoRestartJob = null;
    }

    // Schedule warnings before restart
    this.scheduleRestartWarnings(cronExpression, warningMinutes);

    // Schedule the actual restart
    this.autoRestartJob = cron.schedule(cronExpression, async () => {
      log.info('Executing scheduled auto-restart');
      await this.performRestart();
    });

    log.info(`Auto-restart scheduled: ${cronExpression}`);
  }

  scheduleRestartWarnings(restartCron, warningMinutes) {
    // Stop existing warning jobs to prevent leaks
    if (this.warningJobs) {
      for (const job of this.warningJobs) {
        job.stop();
      }
    }
    this.warningJobs = [];
    
    // Note: The actual warnings are handled in performRestart() with a countdown
    // This method is a placeholder for more sophisticated warning scheduling
    // For now, we don't need separate cron jobs for warnings since performRestart
    // handles the countdown internally
    log.debug(`Restart warnings configured for ${warningMinutes} minutes before restart`);
  }

  async performRestart(warningMinutesParam = null) {
    // Prevent concurrent restarts
    if (this.restartInProgress) {
      log.info('Restart already in progress, ignoring duplicate request');
      return { success: false, message: 'Restart already in progress' };
    }
    
    this.restartInProgress = true;
    this.restartCancelled = false; // Allow cancellation
    const warningMinutes = warningMinutesParam ?? (parseInt(process.env.RESTART_WARNING_MINUTES, 10) || 5);
    const restartStartTime = Date.now();
    
    try {
      // Check if server is actually running - use multiple methods
      let wasRunning = await this.serverManager.checkServerRunning();
      log.info(`Auto-restart: Process check returned: ${wasRunning}`);
      
      // If process check says not running, also try RCON as a fallback
      // RCON connection success is a reliable indicator the server is running
      if (!wasRunning && this.rconService.connected) {
        log.info('Auto-restart: Process check failed but RCON is connected - server IS running');
        wasRunning = true;
      }
      
      // Also try a quick RCON command if we think server might be running
      if (!wasRunning) {
        try {
          const testResult = await this.rconService.execute('players', { skipLog: true });
          if (testResult.success) {
            log.info('Auto-restart: RCON command succeeded - server IS running');
            wasRunning = true;
          }
        } catch (e) {
          // RCON failed, server probably not running
          log.debug(`Auto-restart: RCON test failed: ${e.message}`);
        }
      }
      
      if (!wasRunning) {
        // Server wasn't running - just start it
        log.info('Auto-restart triggered but server was not running - starting server');
        await this.serverManager.startServer();
        
        // Wait a bit and verify it started
        await this.sleep(10000);
        const isNowRunning = await this.serverManager.checkServerRunning();
        
        const restartDuration = Date.now() - restartStartTime;
        if (isNowRunning) {
          await logScheduleExecution(null, 'Auto Restart', 'restart', true, 'Server was offline - started successfully', restartDuration);
          logServerEvent('auto_restart', 'Server was offline - started successfully');
          log.info('Server started successfully (was not running)');
        } else {
          await logScheduleExecution(null, 'Auto Restart', 'restart', false, 'Server was offline - failed to start', restartDuration);
          logServerEvent('auto_restart_error', 'Server was offline - failed to start');
          log.error('Failed to start server');
        }
        return { success: isNowRunning, wasRunning: false };
      }
      
      // Server is running - perform full restart with warnings
      // First, verify RCON is connected and working
      if (!this.rconService.connected) {
        log.info('Auto-restart: RCON not connected, attempting to connect...');
        try {
          await this.rconService.connect();
        } catch (e) {
          log.error(`Auto-restart: Failed to connect RCON: ${e.message}`);
        }
      }
      
      // Test RCON with a simple command before proceeding
      const testResult = await this.rconService.execute('players', { skipLog: true });
      if (!testResult.success) {
        const restartDuration = Date.now() - restartStartTime;
        const errorMsg = `RCON not available: ${testResult.error || 'connection failed'}`;
        log.error(`Auto-restart failed: ${errorMsg}`);
        await logScheduleExecution(null, 'Auto Restart', 'restart', false, errorMsg, restartDuration);
        logServerEvent('auto_restart_error', errorMsg);
        return { success: false, message: errorMsg };
      }
      
      log.info('Auto-restart: RCON verified, sending warnings...');
      
      if (warningMinutes > 0) {
        // Send countdown warnings - skip logging for automated restart messages
        for (let i = warningMinutes; i > 0; i--) {
          if (this.restartCancelled) {
            log.info('Auto-restart: Cancelled during countdown');
            await this.rconService.serverMessage('ℹ️ Server restart has been cancelled.', { skipLog: true });
            return { success: false, message: 'Restart cancelled' };
          }
          const msgResult = await this.rconService.serverMessage(`⚠️ Server restarting in ${i} minute(s)!`, { skipLog: true });
          if (!msgResult.success) {
            log.warn(`Auto-restart: Warning message failed: ${msgResult.error}`);
          }
          
          if (i > 1) {
            await this.sleep(60000); // Wait 1 minute
          }
        }

        if (this.restartCancelled) {
          log.info('Auto-restart: Cancelled during countdown');
          await this.rconService.serverMessage('ℹ️ Server restart has been cancelled.', { skipLog: true });
          return { success: false, message: 'Restart cancelled' };
        }

        // 30 second warning
        await this.rconService.serverMessage('⚠️ Server restarting in 30 seconds!', { skipLog: true });
        await this.sleep(25000);

        // Final warning
        await this.rconService.serverMessage('🔄 Server restarting NOW! Please reconnect in a few minutes.', { skipLog: true });
        await this.sleep(5000);
      } else {
        // Immediate restart - just a brief message
        await this.rconService.serverMessage('🔄 Server restarting NOW!', { skipLog: true });
        await this.sleep(2000);
      }

      // Save world - skip logging for automated save
      log.info('Auto-restart: Saving world...');
      const saveResult = await this.rconService.save({ skipLog: true });
      if (!saveResult.success) {
        log.warn(`Auto-restart: Save command may have failed: ${saveResult.error}`);
      }
      await this.sleep(3000);

      // Quit server - skip logging for automated quit
      log.info('Auto-restart: Sending quit command...');
      await this.rconService.quit({ skipLog: true });
      await this.sleep(10000);

      // Wait for server to stop
      let attempts = 0;
      while (await this.serverManager.checkServerRunning() && attempts < 60) {
        await this.sleep(1000);
        attempts++;
      }

      // Force stop if needed
      if (await this.serverManager.checkServerRunning()) {
        await this.serverManager.stopServer(false);
        await this.sleep(5000);
      }

      // Set flag to prevent RCON auto-reconnect from interfering during startup
      // Use setServerStarting which has a 5-minute failsafe timeout
      if (this.rconService.setServerStarting) {
        this.rconService.setServerStarting(true);
      } else {
        this.rconService.serverStarting = true;
      }

      // Start server
      log.info('Auto-restart: Starting server...');
      await this.serverManager.startServer();
      
      // Wait for server process to be running (up to 60 seconds)
      let serverStarted = false;
      for (let i = 0; i < 60; i++) {
        await this.sleep(1000);
        if (await this.serverManager.checkServerRunning()) {
          serverStarted = true;
          log.info('Auto-restart: Server process detected as running');
          break;
        }
      }
      
      if (!serverStarted) {
        if (this.rconService.setServerStarting) {
          this.rconService.setServerStarting(false);
        } else {
          this.rconService.serverStarting = false;
        }
        const restartDuration = Date.now() - restartStartTime;
        await logScheduleExecution(null, 'Auto Restart', 'restart', false, 'Server stopped but failed to start', restartDuration);
        logServerEvent('auto_restart_error', 'Server stopped but failed to start');
        log.error('Auto-restart: Server stopped but failed to start');
        return { success: false, wasRunning: true };
      }
      
      // Wait for RCON to be ready (PZ server takes 60-180s to fully initialize)
      // Keep serverStarting=true the whole time to block auto-reconnect
      log.info('Auto-restart: Waiting for RCON to be ready...');
      const rconDelays = [60000, 45000, 45000, 45000, 45000]; // 60s + 4x45s = 240s total (4 minutes)
      let rconConnected = false;
      
      for (let i = 0; i < rconDelays.length; i++) {
        const delaySeconds = rconDelays[i] / 1000;
        log.info(`Auto-restart: RCON waiting ${delaySeconds}s before attempt ${i + 1}/${rconDelays.length}...`);
        await this.sleep(rconDelays[i]);
        
        // Reset connection state before each attempt to clear any stalled state
        if (this.rconService.forceResetConnectionState) {
          this.rconService.forceResetConnectionState();
        }
        
        // Attempt connection with a 15s timeout to prevent hanging
        try {
          log.info(`Auto-restart: RCON attempting connection ${i + 1}/${rconDelays.length}...`);
          const connectPromise = this.rconService.connect();
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Connection attempt timed out after 15s')), 15000)
          );
          
          const connectResult = await Promise.race([connectPromise, timeoutPromise]);
          
          if (this.rconService.connected) {
            rconConnected = true;
            log.info('Auto-restart: RCON connected after server startup');
            break;
          } else {
            log.info(`Auto-restart: RCON attempt ${i + 1} - not connected (result: ${connectResult})`);
          }
        } catch (e) {
          log.info(`Auto-restart: RCON attempt ${i + 1} failed: ${e.message}`);
          // Reset state on failure/timeout so next attempt starts fresh
          if (this.rconService.forceResetConnectionState) {
            this.rconService.forceResetConnectionState();
          }
        }
        // Don't toggle serverStarting - keep it true to block auto-reconnect
      }
      
      // Log completion status
      if (rconConnected) {
        log.info('Auto-restart: RCON startup sequence completed - connected');
      } else {
        log.warn('Auto-restart: RCON startup sequence completed - NOT connected (auto-reconnect will keep trying every 30s)');
      }
      
      // Clear the flag when done
      if (this.rconService.setServerStarting) {
        this.rconService.setServerStarting(false);
      } else {
        this.rconService.serverStarting = false;
      }
      
      const restartDuration = Date.now() - restartStartTime;
      
      if (serverStarted) {
        const rconStatus = rconConnected ? ' (RCON connected)' : ' (RCON not yet connected)';
        await logScheduleExecution(null, 'Auto Restart', 'restart', true, 'Server restarted successfully' + rconStatus, restartDuration);
        logServerEvent('auto_restart', 'Server restarted successfully' + rconStatus);
        log.info(`Auto-restart completed successfully (took ${Math.round(restartDuration / 1000)}s)${rconStatus}`);
      } else {
        await logScheduleExecution(null, 'Auto Restart', 'restart', false, 'Server stopped but failed to start', restartDuration);
        logServerEvent('auto_restart_error', 'Server stopped but failed to start');
        log.error('Auto-restart: Server stopped but failed to start');
      }
      
      return { success: serverStarted, wasRunning: true };
    } catch (error) {
      const restartDuration = Date.now() - restartStartTime;
      log.error(`Auto-restart failed: ${error.message}`);
      await logScheduleExecution(null, 'Auto Restart', 'restart', false, error.message, restartDuration);
      logServerEvent('auto_restart_error', error.message);
      // Clear serverStarting flag on error so auto-reconnect can resume
      if (this.rconService.setServerStarting) {
        this.rconService.setServerStarting(false);
      } else {
        this.rconService.serverStarting = false;
      }
      throw error;
    } finally {
      this.restartInProgress = false;
    }
  }

  async triggerModUpdateRestart() {
    if (this.modUpdateRestartPending) {
      log.info('Mod update restart already pending');
      return;
    }

    this.modUpdateRestartPending = true;
    log.info('Mod update detected - scheduling restart');

    try {
      await this.rconService.serverMessage('🔧 Mod updates detected! Server will restart in 5 minutes.');
      await this.performRestart(5);  // Explicitly pass 5 minutes to match the message
      this.modUpdateRestartPending = false;
    } catch (error) {
      this.modUpdateRestartPending = false;
      throw error;
    }
  }

  getStatus() {
    const tasks = [];
    for (const [id, job] of this.jobs) {
      tasks.push({ id, running: true });
    }

    return {
      activeTasks: tasks.length,
      autoRestartEnabled: !!this.autoRestartJob,
      backupScheduleEnabled: !!this.backupJob,
      modUpdateRestartPending: this.modUpdateRestartPending
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  shutdown() {
    // Use stopAllJobs to ensure all jobs are properly stopped
    this.stopAllJobs();
    
    // Also stop backup job if running
    if (this.backupJob) {
      this.backupJob.stop();
      this.backupJob = null;
    }

    log.info('Scheduler shutdown complete');
  }
}

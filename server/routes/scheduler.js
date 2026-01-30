import express from 'express';
import cron from 'node-cron';
import { logger } from '../utils/logger.js';
import { 
  getScheduledTasks, 
  createScheduledTask, 
  updateScheduledTask, 
  deleteScheduledTask,
  getScheduleHistory,
  clearScheduleHistory
} from '../database/init.js';

const router = express.Router();

// Get scheduler status
router.get('/status', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const status = scheduler.getStatus();
    res.json(status);
  } catch (error) {
    logger.error(`Failed to get scheduler status: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get all scheduled tasks
router.get('/tasks', async (req, res) => {
  try {
    const tasks = await getScheduledTasks();
    res.json({ tasks });
  } catch (error) {
    logger.error(`Failed to get scheduled tasks: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Validate cron expression
router.post('/validate-cron', async (req, res) => {
  try {
    const { cronExpression } = req.body;
    if (!cronExpression) {
      return res.status(400).json({ valid: false, error: 'cronExpression is required' });
    }
    
    const isValid = cron.validate(cronExpression);
    if (!isValid) {
      return res.json({ valid: false, error: 'Invalid cron expression format' });
    }
    
    res.json({ valid: true });
  } catch (error) {
    res.status(500).json({ valid: false, error: error.message });
  }
});

// Create a new scheduled task
router.post('/tasks', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const { name, cronExpression, command } = req.body;
    
    if (!name || !cronExpression || !command) {
      return res.status(400).json({ error: 'Name, cronExpression, and command are required' });
    }
    
    // Validate cron expression before saving
    if (!cron.validate(cronExpression)) {
      return res.status(400).json({ error: 'Invalid cron expression. Use format: minute hour day month weekday (e.g., "0 */6 * * *" for every 6 hours)' });
    }
    
    const result = await createScheduledTask(name, cronExpression, command);
    const task = {
      id: result.id,
      name,
      cron_expression: cronExpression,
      command,
      enabled: 1
    };
    
    // Schedule the task
    scheduler.scheduleTask(task);
    
    res.json({ success: true, task });
  } catch (error) {
    logger.error(`Failed to create scheduled task: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Update a scheduled task
router.put('/tasks/:id', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const { id } = req.params;
    const { name, cronExpression, command, enabled } = req.body;
    
    const taskId = parseInt(id, 10);
    if (isNaN(taskId)) {
      return res.status(400).json({ error: 'Invalid task ID' });
    }
    
    // Validate cron expression before saving to prevent DB/scheduler inconsistency
    if (enabled && !cron.validate(cronExpression)) {
      return res.status(400).json({ error: 'Invalid cron expression. Use format: minute hour day month weekday (e.g., "0 */6 * * *" for every 6 hours)' });
    }
    
    await updateScheduledTask(taskId, name, cronExpression, command, enabled);
    
    // Reschedule or cancel the task
    if (enabled) {
      scheduler.scheduleTask({
        id: taskId,
        name,
        cron_expression: cronExpression,
        command,
        enabled: 1
      });
    } else {
      scheduler.cancelTask(taskId);
    }
    
    res.json({ success: true, message: 'Task updated' });
  } catch (error) {
    logger.error(`Failed to update scheduled task: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Delete a scheduled task
router.delete('/tasks/:id', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const { id } = req.params;
    
    const taskId = parseInt(id, 10);
    if (isNaN(taskId)) {
      return res.status(400).json({ error: 'Invalid task ID' });
    }
    
    scheduler.cancelTask(taskId);
    await deleteScheduledTask(taskId);
    
    res.json({ success: true, message: 'Task deleted' });
  } catch (error) {
    logger.error(`Failed to delete scheduled task: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Trigger immediate restart
router.post('/restart-now', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const { warningMinutes } = req.body;
    
    // Parse and validate warningMinutes (0-60 range)
    let parsedWarningMinutes = parseInt(warningMinutes, 10);
    if (isNaN(parsedWarningMinutes) || parsedWarningMinutes < 0) {
      parsedWarningMinutes = 5; // Default
    } else if (parsedWarningMinutes > 60) {
      parsedWarningMinutes = 60; // Cap at 60 minutes
    }
    
    // Run restart in background, passing warningMinutes directly
    scheduler.performRestart(parsedWarningMinutes).catch(err => {
      logger.error(`Restart failed: ${err.message}`);
    });
    
    res.json({ success: true, message: 'Restart initiated' });
  } catch (error) {
    logger.error(`Failed to trigger restart: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Common cron presets for convenience
router.get('/cron-presets', (req, res) => {
  res.json({
    presets: [
      { name: 'Every hour', cron: '0 * * * *' },
      { name: 'Every 2 hours', cron: '0 */2 * * *' },
      { name: 'Every 4 hours', cron: '0 */4 * * *' },
      { name: 'Every 6 hours', cron: '0 */6 * * *' },
      { name: 'Every 12 hours', cron: '0 */12 * * *' },
      { name: 'Daily at midnight', cron: '0 0 * * *' },
      { name: 'Daily at 6 AM', cron: '0 6 * * *' },
      { name: 'Daily at noon', cron: '0 12 * * *' },
      { name: 'Daily at 6 PM', cron: '0 18 * * *' },
      { name: 'Every 30 minutes', cron: '*/30 * * * *' },
      { name: 'Every 15 minutes', cron: '*/15 * * * *' }
    ]
  });
});

// Get schedule execution history
router.get('/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 100;
    const taskId = req.query.taskId ? parseInt(req.query.taskId, 10) : null;
    const history = await getScheduleHistory(limit, taskId);
    res.json({ history });
  } catch (error) {
    logger.error(`Failed to get schedule history: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Clear schedule execution history
router.delete('/history', async (req, res) => {
  try {
    await clearScheduleHistory();
    res.json({ success: true, message: 'History cleared' });
  } catch (error) {
    logger.error(`Failed to clear schedule history: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;

import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { createLogger } from '../utils/logger.js';
const log = createLogger('Discord');
import { getSetting, setSetting } from '../database/init.js';

export class DiscordBot {
  constructor(rconService, serverManager, scheduler, logTailer = null) {
    this.client = null;
    this.rconService = rconService;
    this.serverManager = serverManager;
    this.scheduler = scheduler;
    this.logTailer = logTailer;
    this.token = null;
    this.guildId = null;
    this.adminRoleId = null;
    this.channelId = null;
    this.isRunning = false;
    this.webhookEvents = {};
    
    // Setup Chat Bridge listener
    if (this.logTailer) {
        this.logTailer.on('chatMessage', (data) => this.handleGameChat(data));
    }
  }

  async handleGameChat(data) {
      // Don't echo back if the bot is not running or channel not set
      if (!this.isRunning || !this.channelId || !this.client) return;
      
      try {
          // Find channel
          const channel = await this.client.channels.fetch(this.channelId);
          if (channel && channel.isTextBased()) {
              // Send as embed or plain text? Plain text is more chat-like.
              // Avoid pinging everyone
              const cleanMessage = data.message.replace(/@everyone/g, '(everyone)').replace(/@here/g, '(here)');
              await channel.send(`**<${data.author}>** ${cleanMessage}`);
          }
      } catch (e) {
          log.warn(`Failed to bridge chat: ${e.message}`);
      }
  }

  async loadConfig() {
    this.token = await getSetting('discordBotToken');
    this.guildId = await getSetting('discordGuildId');
    this.adminRoleId = await getSetting('discordAdminRoleId');
    this.channelId = await getSetting('discordChannelId');
    
    // Load webhook events
    const savedEvents = await getSetting('discordWebhookEvents');
    if (savedEvents) {
      try {
        this.webhookEvents = typeof savedEvents === 'string' ? JSON.parse(savedEvents) : savedEvents;
      } catch (e) {
        this.webhookEvents = {};
      }
    }
  }

  async saveWebhookEvents(events) {
    this.webhookEvents = events;
    await setSetting('discordWebhookEvents', JSON.stringify(events));
  }

  async sendEventNotification(eventType, variables = {}) {
    if (!this.isRunning || !this.channelId) return;
    
    const event = this.webhookEvents[eventType];
    if (!event || !event.enabled) return;
    
    let message = event.template;
    for (const [key, value] of Object.entries(variables)) {
      message = message.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    
    await this.sendNotification(message);
  }

  async updateConfig(token, guildId, adminRoleId, channelId) {
    await setSetting('discordBotToken', token);
    await setSetting('discordGuildId', guildId);
    await setSetting('discordAdminRoleId', adminRoleId);
    await setSetting('discordChannelId', channelId || '');
    
    this.token = token;
    this.guildId = guildId;
    this.adminRoleId = adminRoleId;
    this.channelId = channelId;
  }

  getCommands() {
    return [
      new SlashCommandBuilder()
        .setName('status')
        .setDescription('Get the current server status'),
      
      new SlashCommandBuilder()
        .setName('players')
        .setDescription('List online players'),
      
      new SlashCommandBuilder()
        .setName('start')
        .setDescription('Start the Project Zomboid server')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
      
      new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop the server (with save)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
      
      new SlashCommandBuilder()
        .setName('restart')
        .setDescription('Restart the server with warning')
        .addIntegerOption(option =>
          option.setName('minutes')
            .setDescription('Warning time in minutes before restart')
            .setRequired(false)
            .setMinValue(0)
            .setMaxValue(30)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
      
      new SlashCommandBuilder()
        .setName('save')
        .setDescription('Save the world')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
      
      new SlashCommandBuilder()
        .setName('broadcast')
        .setDescription('Send a message to all players')
        .addStringOption(option =>
          option.setName('message')
            .setDescription('Message to broadcast')
            .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
      
      new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kick a player from the server')
        .addStringOption(option =>
          option.setName('player')
            .setDescription('Player name to kick')
            .setRequired(true)
        )
        .addStringOption(option =>
          option.setName('reason')
            .setDescription('Reason for kick')
            .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
      
      new SlashCommandBuilder()
        .setName('rcon')
        .setDescription('Execute a custom RCON command')
        .addStringOption(option =>
          option.setName('command')
            .setDescription('RCON command to execute')
            .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    ];
  }

  async registerCommands() {
    if (!this.token || !this.guildId) {
      throw new Error('Discord token and guild ID are required');
    }

    if (!this.client || !this.client.user) {
      throw new Error('Discord client not ready');
    }

    const rest = new REST({ version: '10' }).setToken(this.token);
    const commands = this.getCommands().map(cmd => cmd.toJSON());

    try {
      log.info('Registering Discord slash commands...');
      await rest.put(
        Routes.applicationGuildCommands(this.client.user.id, this.guildId),
        { body: commands }
      );
      log.info(`Registered ${commands.length} Discord commands`);
    } catch (error) {
      log.error(`Failed to register Discord commands: ${error.message}`);
      throw error;
    }
  }

  hasAdminRole(interaction) {
    if (!this.adminRoleId) return true; // No role configured, allow all
    
    const member = interaction.member;
    if (!member) return false;
    
    // Check if user has the admin role
    if (member.roles && member.roles.cache) {
      return member.roles.cache.has(this.adminRoleId);
    }
    
    return false;
  }

  async handleInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    
    // Check admin role for restricted commands
    const adminCommands = ['start', 'stop', 'restart', 'save', 'broadcast', 'kick', 'rcon'];
    if (adminCommands.includes(commandName) && !this.hasAdminRole(interaction)) {
      await interaction.reply({
        content: '❌ You do not have permission to use this command.',
        ephemeral: true
      });
      return;
    }

    try {
      switch (commandName) {
        case 'status':
          await this.handleStatus(interaction);
          break;
        case 'players':
          await this.handlePlayers(interaction);
          break;
        case 'start':
          await this.handleStart(interaction);
          break;
        case 'stop':
          await this.handleStop(interaction);
          break;
        case 'restart':
          await this.handleRestart(interaction);
          break;
        case 'save':
          await this.handleSave(interaction);
          break;
        case 'broadcast':
          await this.handleBroadcast(interaction);
          break;
        case 'kick':
          await this.handleKick(interaction);
          break;
        case 'rcon':
          await this.handleRcon(interaction);
          break;
        default:
          await interaction.reply({ content: 'Unknown command', ephemeral: true });
      }
    } catch (error) {
      log.error(`command error: ${error.message}`);
      try {
        const content = `❌ Error: ${error.message}`;
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content, ephemeral: true });
        } else {
          await interaction.reply({ content, ephemeral: true });
        }
      } catch (replyError) {
        log.error(`Failed to send error reply: ${replyError.message}`);
      }
    }
  }

  async handleStatus(interaction) {
    await interaction.deferReply();
    
    const isRunning = await this.serverManager.checkServerRunning();
    const status = await this.serverManager.getServerStatus();
    
    // Format uptime from seconds
    let uptimeStr = 'N/A';
    if (status.uptime && status.uptime > 0) {
      const hours = Math.floor(status.uptime / 3600);
      const minutes = Math.floor((status.uptime % 3600) / 60);
      uptimeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    }
    
    const embed = new EmbedBuilder()
      .setTitle('🧟 Project Zomboid Server Status')
      .setColor(isRunning ? 0x00ff00 : 0xff0000)
      .addFields(
        { name: 'Status', value: isRunning ? '🟢 Online' : '🔴 Offline', inline: true },
        { name: 'Uptime', value: uptimeStr, inline: true }
      )
      .setTimestamp();
    
    if (isRunning) {
      try {
        const players = await this.rconService.getPlayers();
        if (players.success) {
          embed.addFields({ 
            name: 'Players Online', 
            value: `${players.players?.length || 0}`, 
            inline: true 
          });
        }
      } catch {
        // Ignore RCON errors for status
      }
    }
    
    await interaction.editReply({ embeds: [embed] });
  }

  async handlePlayers(interaction) {
    await interaction.deferReply();
    
    const isRunning = await this.serverManager.checkServerRunning();
    if (!isRunning) {
      await interaction.editReply('🔴 Server is offline');
      return;
    }
    
    const result = await this.rconService.getPlayers();
    
    if (!result.success) {
      await interaction.editReply(`❌ Failed to get players: ${result.error}`);
      return;
    }
    
    const players = result.players || [];
    
    const embed = new EmbedBuilder()
      .setTitle('👥 Online Players')
      .setColor(0x3498db)
      .setDescription(players.length > 0 
        ? players.map(p => `• ${typeof p === 'object' ? p.name : p}`).join('\n')
        : 'No players online'
      )
      .setFooter({ text: `${players.length} player(s)` })
      .setTimestamp();
    
    await interaction.editReply({ embeds: [embed] });
  }

  async handleStart(interaction) {
    await interaction.deferReply();
    
    const isRunning = await this.serverManager.checkServerRunning();
    if (isRunning) {
      await interaction.editReply('⚠️ Server is already running');
      return;
    }
    
    await this.serverManager.startServer();
    await interaction.editReply('🚀 Server is starting...');
    
    // Send notification to channel
    await this.sendNotification(`🚀 **Server started** by ${interaction.user.tag}`);
  }

  async handleStop(interaction) {
    await interaction.deferReply();
    
    const isRunning = await this.serverManager.checkServerRunning();
    if (!isRunning) {
      await interaction.editReply('⚠️ Server is not running');
      return;
    }
    
    // Save first
    await this.rconService.save();
    await this.rconService.quit();
    
    await interaction.editReply('🛑 Server is stopping...');
    await this.sendNotification(`🛑 **Server stopped** by ${interaction.user.tag}`);
  }

  async handleRestart(interaction) {
    await interaction.deferReply();
    
    const minutes = interaction.options.getInteger('minutes') ?? 5;
    
    const isRunning = await this.serverManager.checkServerRunning();
    if (!isRunning) {
      await interaction.editReply('⚠️ Server is not running. Use /start to start the server.');
      return;
    }
    
    // Send initial message
    if (minutes > 0) {
      await this.rconService.serverMessage(`Server restarting in ${minutes} minute(s)!`);
    }
    
    await interaction.editReply(`🔄 Server restart initiated (${minutes} min warning)`);
    await this.sendNotification(`🔄 **Server restart** initiated by ${interaction.user.tag}`);
    
    // Use scheduler for proper restart with the specified warning time
    try {
      await this.scheduler.performRestart(minutes);
    } catch (error) {
      log.error(`restart failed: ${error.message}`);
      await this.sendNotification(`❌ **Server restart failed:** ${error.message}`);
    }
  }

  async handleSave(interaction) {
    await interaction.deferReply();
    
    const result = await this.rconService.save();
    
    if (result.success) {
      await interaction.editReply('💾 World saved successfully');
    } else {
      await interaction.editReply(`❌ Save failed: ${result.error}`);
    }
  }

  async handleBroadcast(interaction) {
    const message = interaction.options.getString('message');
    
    await interaction.deferReply();
    
    const result = await this.rconService.serverMessage(message);
    
    if (result.success) {
      await interaction.editReply(`📢 Broadcast sent: "${message}"`);
    } else {
      await interaction.editReply(`❌ Broadcast failed: ${result.error}`);
    }
  }

  async handleKick(interaction) {
    const player = interaction.options.getString('player');
    const reason = interaction.options.getString('reason') || 'No reason given';
    
    await interaction.deferReply();
    
    // Sanitize inputs to prevent command injection
    const safePlayer = this.rconService.sanitize(player);
    const safeReason = this.rconService.sanitize(reason);
    const result = await this.rconService.execute(`kick "${safePlayer}" "${safeReason}"`);
    
    if (result.success) {
      await interaction.editReply(`👢 Kicked ${player}: ${reason}`);
      await this.sendNotification(`👢 **${player}** was kicked by ${interaction.user.tag}\nReason: ${reason}`);
    } else {
      await interaction.editReply(`❌ Kick failed: ${result.error}`);
    }
  }

  async handleRcon(interaction) {
    const command = interaction.options.getString('command');
    
    await interaction.deferReply({ ephemeral: true });
    
    // Basic sanitization - remove potential injection characters
    const safeCommand = this.rconService.sanitize(command);
    const result = await this.rconService.execute(safeCommand);
    
    const response = result.success 
      ? `✅ **Response:**\n\`\`\`${result.response || 'No response'}\`\`\``
      : `❌ **Error:** ${result.error}`;
    
    await interaction.editReply(response);
  }

  async sendNotification(message) {
    if (!this.channelId || !this.client) return;
    
    try {
      const channel = await this.client.channels.fetch(this.channelId);
      if (channel && channel.isTextBased()) {
        await channel.send(message);
      }
    } catch (error) {
      log.error(`Failed to send Discord notification: ${error.message}`);
    }
  }

  async start() {
    await this.loadConfig();
    
    if (!this.token) {
      log.info('bot not configured (no token)');
      return false;
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers, // Required for role checks
        GatewayIntentBits.MessageContent // Required for reading chat messages
      ]
    });

    this.client.once('ready', async () => {
      log.info(`bot logged in as ${this.client.user.tag}`);
      await this.registerCommands();
      this.isRunning = true;
    });

    // Two-way Chat Bridge: Discord -> Server
    this.client.on('messageCreate', async (message) => {
        // Ignore stats from bots (including self) or if bot is stopped
        if (!this.isRunning || !this.channelId || message.author.bot) return;

        // Check if message is in the bridge channel
        if (message.channelId === this.channelId) {
            try {
                // Check if RCON is connected
                if (this.rconService && this.rconService.connected) {
                    const user = message.author.username;
                    // Sanitize content: remove newlines and double quotes to prevent command injection/formatting issues
                    let content = message.content;
                    if (!content) return; // Ignore empty messages (images etc)

                    const safeContent = content.replace(/"/g, "'").replace(/[\r\n]+/g, " ");
                    
                    // Broadcast to server
                    // Format: [Discord] User: Message
                    await this.rconService.serverMessage(`[Discord] ${user}: ${safeContent}`);
                }
            } catch (e) {
                log.warn(`Failed to bridge message to server: ${e.message}`);
            }
        }
    });

    this.client.on('interactionCreate', async (interaction) => {
      try {
        await this.handleInteraction(interaction);
      } catch (error) {
        log.error(`interaction handler error: ${error.message}`);
      }
    });

    this.client.on('error', (error) => {
      log.error(`client error: ${error.message}`);
    });

    try {
      await this.client.login(this.token);
      return true;
    } catch (error) {
      log.error(`Failed to start Discord bot: ${error.message}`);
      return false;
    }
  }

  async stop() {
    if (this.client) {
      await this.client.destroy();
      this.client = null;
      this.isRunning = false;
      log.info('bot stopped');
    }
  }

  getStatus() {
    return {
      running: this.isRunning,
      configured: !!this.token,
      username: this.client?.user?.tag || null,
      guildId: this.guildId,
      channelId: this.channelId
    };
  }
}

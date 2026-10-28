import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { copyText } from "@/lib/utils";
import { SectionCard } from "@/components/ui/section-card";
import { StatusPill, type StatusTone } from "@/components/ui/status-pill";
import { Stepper, type StepStatus } from "@/components/ui/stepper";
import { PageAlerts, type PageAlert } from "@/components/PageAlerts";
import { PageSkeleton } from "@/components/PageSkeleton";
import { SaveBar } from "@/components/SaveBar";
import { useUnsavedChangesGuard } from "@/contexts/UnsavedChangesContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HelpTip } from "@/components/HelpTip";
import { DisabledReason } from "@/components/DisabledReason";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { discordApi } from "@/lib/api";
import { getUserErrorMessage } from "@/lib/errorMessage";
import { useConfirm } from "@/contexts/ConfirmContext";
import { useAuth } from "@/contexts/AuthContext";
import {
  MessageSquare,
  Bot,
  Play,
  Square,
  RefreshCw,
  Loader2,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Eye,
  EyeOff,
  Send,
  ExternalLink,
  Shield,
  Hash,
  Server,
  Bell,
  Copy,
  Check,
  ChevronRight,
  ChevronLeft,
  Zap,
  Settings,
  ArrowRight,
  ToggleLeft,
  UserPlus,
  MessagesSquare,
  Users,
  Lock,
  Trash2,
  Info,
  BookOpen,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";

interface DiscordStatus {
  running: boolean;
  configured: boolean;
  connected?: boolean;
  username?: string;
  error?: string;
  lastStartError?: { kind: string | null; message: string } | null;
  // Debounced server-side against a routine, self-healing reconnect (a few
  // seconds) -- true only once the gateway connection has been unhealthy
  // for a sustained stretch. See services/discordBot.js's getStatus().
  gatewayIssue?: boolean;
  // ISO timestamp this specific degraded episode started, or null when
  // healthy -- used as the dismissal key so dismissing THIS episode doesn't
  // silence a later, different one.
  gatewayDegradedSince?: string | null;
  // Channels the bot no longer posts to because they aren't in the guild
  // set as the Guild ID (services/discordBot.js _sendToChannel()).
  channelsOutsideGuild?: string[];
}

interface DiscordConfig {
  token: string | null;
  hasToken: boolean;
  guildId: string;
  adminRoleId: string;
  modRoleId: string;
  channelId: string;
  autoStart: boolean;
  chatRelayEnabled: boolean;
  chatRelayChannelId: string;
  chatRelayScope: "public" | "no-yell" | "general";
}

interface BotInfo {
  username: string;
  id: string;
  discriminator: string;
  avatar: string | null;
}

interface WebhookEvent {
  enabled: boolean;
  template: string;
}

type WebhookEvents = Record<string, WebhookEvent>;
// Same cap as routes/discord.js applies to a saved template.
const EVENT_TEMPLATE_MAX_LENGTH = 500;
// The notifications that post player data (server/routes/discord.js
// PLAYER_EVENT_KEYS): players.view only.
const PLAYER_EVENT_KEYS = ["playerJoin", "playerLeave", "playerDeath"];
type FlashMessage = { type: "success" | "warning" | "error"; text: string };

// Small helper to copy text to clipboard
function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useTranslation("discord");
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = () => {
    copyText(text);
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 2000);
  };
  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleCopy}
      className="gap-1.5 shrink-0"
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-primary" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
      {label || (copied ? t("shared.copied") : t("shared.copy"))}
    </Button>
  );
}

function InlineFeedback({
  message,
  className,
}: {
  message: FlashMessage | null;
  className?: string;
}) {
  const { t } = useTranslation("discord");
  if (!message) return null;

  return (
    <Alert
      variant={
        message.type === "error"
          ? "destructive"
          : message.type === "warning"
            ? "warning"
            : "default"
      }
      className={className}
    >
      {message.type === "error" ? (
        <AlertCircle className="h-4 w-4" />
      ) : message.type === "warning" ? (
        <AlertTriangle className="h-4 w-4" />
      ) : (
        <CheckCircle2 className="h-4 w-4" />
      )}
      <AlertTitle>
        {message.type === "error"
          ? t("shared.errorTitle")
          : message.type === "warning"
            ? t("shared.warningTitle")
            : t("shared.successTitle")}
      </AlertTitle>
      <AlertDescription>{message.text}</AlertDescription>
    </Alert>
  );
}

function getEventLabels(t: TFunction): Record<
  string,
  {
    label: string;
    description: string;
    variables: string;
    defaultTemplate: string;
  }
> {
  return {
    serverStart: {
      label: t("events.serverStart.label"),
      description: t("events.serverStart.description"),
      variables: t("events.serverStart.variables"),
      defaultTemplate: t("events.serverStart.defaultTemplate"),
    },
    serverStop: {
      label: t("events.serverStop.label"),
      description: t("events.serverStop.description"),
      variables: t("events.serverStop.variables"),
      defaultTemplate: t("events.serverStop.defaultTemplate"),
    },
    playerJoin: {
      label: t("events.playerJoin.label"),
      description: t("events.playerJoin.description"),
      variables: t("events.playerJoin.variables"),
      defaultTemplate: t("events.playerJoin.defaultTemplate"),
    },
    playerLeave: {
      label: t("events.playerLeave.label"),
      description: t("events.playerLeave.description"),
      variables: t("events.playerLeave.variables"),
      defaultTemplate: t("events.playerLeave.defaultTemplate"),
    },
    scheduledRestart: {
      label: t("events.scheduledRestart.label"),
      description: t("events.scheduledRestart.description"),
      variables: t("events.scheduledRestart.variables"),
      defaultTemplate: t("events.scheduledRestart.defaultTemplate"),
    },
    backupComplete: {
      label: t("events.backupComplete.label"),
      description: t("events.backupComplete.description"),
      variables: t("events.backupComplete.variables"),
      defaultTemplate: t("events.backupComplete.defaultTemplate"),
    },
    playerDeath: {
      label: t("events.playerDeath.label"),
      description: t("events.playerDeath.description"),
      variables: t("events.playerDeath.variables"),
      defaultTemplate: t("events.playerDeath.defaultTemplate"),
    },
  };
}

function getSetupSteps(t: TFunction) {
  return [
    t("setupSteps.createApp"),
    t("setupSteps.botToken"),
    t("setupSteps.intents"),
    t("setupSteps.inviteBot"),
    t("setupSteps.serverIds"),
    t("setupSteps.launch"),
  ];
}

type ChatRelayScope = "public" | "no-yell" | "general";

// What the Bot Configuration form shows for a saved config: the same
// defaults loadData() applies, so the form and its dirty check agree.
function configFormValues(config: DiscordConfig | null) {
  return {
    guildId: config?.guildId || "",
    adminRoleId: config?.adminRoleId || "",
    modRoleId: config?.modRoleId || "",
    channelId: config?.channelId || "",
    chatRelayEnabled: config?.chatRelayEnabled !== false,
    chatRelayChannelId: config?.chatRelayChannelId || "",
    chatRelayScope: (config?.chatRelayScope === "general" ||
    config?.chatRelayScope === "no-yell"
      ? config.chatRelayScope
      : "public") as ChatRelayScope,
    autoStart: config?.autoStart !== false,
  };
}

const DISCORD_COMMANDS = [
  "status",
  "players",
  "save",
  "broadcast",
  "kick",
  "start",
  "stop",
  "restart",
  "leaderboard",
  "rcon",
] as const;

// A command with no saved tier runs at "admin" (the table below and the
// server both default to it), so an absent entry and "admin" are the same.
function samePermissions(a: Record<string, string>, b: Record<string, string>) {
  return DISCORD_COMMANDS.every(
    (command) => (a[command] || "admin") === (b[command] || "admin"),
  );
}

// Events the page never loaded read as off with no template, the same
// fallback the event list renders.
function sameWebhookEvents(a: WebhookEvents, b: WebhookEvents) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const left = a[key] || { enabled: false, template: "" };
    const right = b[key] || { enabled: false, template: "" };
    if (Boolean(left.enabled) !== Boolean(right.enabled)) return false;
    if ((left.template || "") !== (right.template || "")) return false;
  }
  return true;
}

type LoadParts = { config?: boolean; events?: boolean; permissions?: boolean };
const LOAD_ALL: LoadParts = { config: true, events: true, permissions: true };

const GATEWAY_ISSUE_DISMISSED_KEY = "pz-discord-gateway-issue-dismissed";

// Mirrors DISCORD_COMMAND_CAPABILITY in server/routes/discord.js: the panel
// capability behind each slash command. PUT /discord/config refuses a token,
// guild or admin role change unless the caller holds all of them, and a mod
// role change unless they hold those of the commands at the Moderator tier
// (security sweep AUTHZ-3), so the fields are locked here to match.
const DISCORD_COMMAND_CAPABILITY: Record<string, string | null> = {
  status: null,
  players: "players.view",
  save: "server.control",
  broadcast: "server.world_events",
  kick: "players.moderate",
  start: "server.control",
  stop: "server.control",
  restart: "server.control",
  rcon: "rcon.execute",
};

export default function Discord() {
  const { t } = useTranslation("discord");
  const eventLabels = useMemo(() => getEventLabels(t), [t]);
  const SETUP_STEPS = useMemo(() => getSetupSteps(t), [t]);
  const confirm = useConfirm();
  // Every mutating route on this page sits behind one whole-file server
  // gate -- router.use(requirePermission("integrations.manage")) in
  // server/routes/discord.js:41, no per-route override anywhere -- so a
  // single capability covers the entire page (verified against the live
  // route list, bug-hunt-2026-08-27 Tier-3 sweep). Open/true when
  // capabilities are unknown/null, same convention as every other
  // capability check in the app.
  const { can } = useAuth();
  const canManageIntegrations = can("integrations.manage");
  // Join, leave and death notifications post player data, which the server
  // gates on players.view (PUT /discord/webhook-events and /config): without
  // it they can be turned off but not on, their message stays as it is, and
  // the notification channel stays put while one of them is on.
  const canViewPlayers = can("players.view");
  const [status, setStatus] = useState<DiscordStatus | null>(null);
  // Stores the exact gatewayDegradedSince episode key that was dismissed,
  // not a boolean -- same reasoning as Dashboard.tsx's
  // PANEL_UPDATE_ERROR_DISMISSED_KEY: a later, DIFFERENT degraded episode
  // gets a new "since" timestamp and re-surfaces on its own, while
  // dismissing the current one persists across a reload (localStorage, not
  // sessionStorage).
  const [gatewayIssueDismissed, setGatewayIssueDismissed] = useState<
    string | null
  >(() => {
    try {
      return localStorage.getItem(GATEWAY_ISSUE_DISMISSED_KEY);
    } catch {
      return null;
    }
  });
  const [config, setConfig] = useState<DiscordConfig | null>(null);
  // Only the first load shows the skeleton; a refresh after a save or a
  // click on Refresh keeps the page (and its messages) on screen.
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [botInfo, setBotInfo] = useState<BotInfo | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [webhookEvents, setWebhookEvents] = useState<WebhookEvents>({});
  // What the server last returned, for the dirty check and Discard.
  const [savedWebhookEvents, setSavedWebhookEvents] = useState<WebhookEvents>({});
  const [savingEvents, setSavingEvents] = useState(false);
  const [autoStart, setAutoStart] = useState(true);
  const [commandPermissions, setCommandPermissions] = useState<
    Record<string, string>
  >({});
  const [savedCommandPermissions, setSavedCommandPermissions] = useState<
    Record<string, string>
  >({});
  const [savingPermissions, setSavingPermissions] = useState(false);
  // The setup guide reopened from the header on a bot that is already set up.
  const [guideOpen, setGuideOpen] = useState(false);

  // Form state
  const [token, setToken] = useState("");
  const [guildId, setGuildId] = useState("");
  const [adminRoleId, setAdminRoleId] = useState("");
  const [modRoleId, setModRoleId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [chatRelayEnabled, setChatRelayEnabled] = useState(true);
  const [chatRelayChannelId, setChatRelayChannelId] = useState("");
  const [chatRelayScope, setChatRelayScope] = useState<ChatRelayScope>("public");

  const applyConfigToForm = useCallback((saved: DiscordConfig | null) => {
    const values = configFormValues(saved);
    setGuildId(values.guildId);
    setAdminRoleId(values.adminRoleId);
    setModRoleId(values.modRoleId);
    setChannelId(values.channelId);
    setChatRelayEnabled(values.chatRelayEnabled);
    setChatRelayChannelId(values.chatRelayChannelId);
    setChatRelayScope(values.chatRelayScope);
    setAutoStart(values.autoStart);
  }, []);

  // Setup wizard state
  const [configMessage, setConfigMessage] = useState<FlashMessage | null>(null);
  const [eventsMessage, setEventsMessage] = useState<FlashMessage | null>(null);
  const [permissionsMessage, setPermissionsMessage] =
    useState<FlashMessage | null>(null);
  // True only while the most recent load's config fetch itself failed --
  // distinct from "genuinely not configured yet". See showSetupWizard.
  const [configLoadFailed, setConfigLoadFailed] = useState(false);

  const [setupStep, setSetupStep] = useState(0);

  // `parts` says which forms take the server's values: after a save, only
  // the forms that saved are reset, so a failed save keeps what was typed
  // in it. Status always refreshes.
  const loadData = useCallback(async (parts: LoadParts = LOAD_ALL) => {
    try {
      setLoading(true);
      let configFailed = false;
      let eventsFailed = false;
      let permsFailed = false;
      const [statusData, configData, eventsData, permsData] = await Promise.all(
        [
          discordApi
            .getStatus()
            .catch(() => ({ running: false, configured: false })),
          discordApi.getConfig().catch(() => {
            configFailed = true;
            return null;
          }),
          discordApi.getWebhookEvents().catch(() => {
            eventsFailed = true;
            return { events: {} };
          }),
          discordApi.getPermissions().catch(() => {
            permsFailed = true;
            return { permissions: {} };
          }),
        ],
      );

      setStatus(statusData);
      if (parts.events) {
        setWebhookEvents(eventsData.events || {});
        setSavedWebhookEvents(eventsData.events || {});
      }
      if (parts.permissions) {
        setCommandPermissions(permsData.permissions || {});
        setSavedCommandPermissions(permsData.permissions || {});
      }
      if (eventsFailed && parts.events) {
        setEventsMessage({
          type: "error",
          text: t("toasts.eventsReadFailedInline"),
        });
      }
      if (permsFailed && parts.permissions) {
        setPermissionsMessage({
          type: "error",
          text: t("toasts.permissionsReadFailedInline"),
        });
      }

      // Keep the last known config on a failed read. Clearing it made a fully
      // configured bot look like a first-time setup, inviting the user to
      // retype everything. configLoadFailed additionally blocks the
      // wizard/dashboard decision below from trusting a config we couldn't
      // actually read -- see showSetupWizard's own comment for why.
      setConfigLoadFailed(configFailed);
      if (configFailed) {
        setConfigMessage({
          type: "error",
          text: t("toasts.configReadFailedInline"),
        });
        return;
      }

      setConfig(configData);

      if (configData && parts.config) {
        applyConfigToForm(configData);
      }
    } catch {
      setConfigLoadFailed(true);
      setConfigMessage({
        type: "error",
        text: t("toasts.configLoadFailedInline"),
      });
    } finally {
      setLoading(false);
      setLoadedOnce(true);
    }
  }, [t, applyConfigToForm]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Poll for bot status every 20s to catch silent disconnects without a full reload.
  useEffect(() => {
    const pollId = setInterval(async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const nextStatus = await discordApi.getStatus().catch(() => null);
        if (nextStatus) setStatus(nextStatus as DiscordStatus);
      } catch {
        // Ignore transient polling failures and keep the last known status visible.
      }
    }, 20000);

    return () => clearInterval(pollId);
  }, []);

  // Discord ID validation (snowflake format). The range matches the server's
  // validator in routes/discord.js — a narrower one here rejects IDs the API
  // would have accepted.
  const isValidDiscordId = (id: string): boolean => {
    if (!id) return true; // Empty is allowed for optional fields
    return /^\d{15,21}$/.test(id);
  };

  const hasGuildIdError = Boolean(guildId && !isValidDiscordId(guildId));
  const hasChannelIdError = Boolean(channelId && !isValidDiscordId(channelId));
  const hasAdminRoleIdError = Boolean(
    adminRoleId && !isValidDiscordId(adminRoleId),
  );
  const hasModRoleIdError = Boolean(modRoleId && !isValidDiscordId(modRoleId));
  const hasChatRelayChannelIdError = Boolean(
    chatRelayChannelId && !isValidDiscordId(chatRelayChannelId),
  );
  const hasConfigValidationError =
    hasGuildIdError ||
    hasChannelIdError ||
    hasAdminRoleIdError ||
    hasModRoleIdError ||
    hasChatRelayChannelIdError;
  const canSaveConfig = Boolean(
    guildId && (token || config?.hasToken) && !hasConfigValidationError,
  );

  // See DISCORD_COMMAND_CAPABILITY above.
  const canChangeBotConnection = Object.values(DISCORD_COMMAND_CAPABILITY).every(
    (capability) => !capability || can(capability),
  );
  const canChangeModRole = Object.entries(DISCORD_COMMAND_CAPABILITY).every(
    ([command, capability]) =>
      !capability ||
      (commandPermissions[command] || "admin") !== "moderator" ||
      can(capability),
  );
  const botConnectionLockedReason = !canManageIntegrations
    ? t("shared.noPermission")
    : !canChangeBotConnection
      ? t("capabilityGate.connection")
      : null;
  const channelLockedReason =
    !canViewPlayers && PLAYER_EVENT_KEYS.some((key) => savedWebhookEvents[key]?.enabled)
      ? t("capabilityGate.playerEvents")
      : null;
  const modRoleLockedReason = !canManageIntegrations
    ? t("shared.noPermission")
    : !canChangeModRole
      ? t("capabilityGate.modRole")
      : null;

  // Unsaved edits per form. The page has one SaveBar for all three
  // (configuration, event notifications, command permissions), and leaving
  // the page with any of them dirty asks first.
  const savedConfigValues = configFormValues(config);
  const configDirty =
    Boolean(token) ||
    guildId !== savedConfigValues.guildId ||
    adminRoleId !== savedConfigValues.adminRoleId ||
    modRoleId !== savedConfigValues.modRoleId ||
    channelId !== savedConfigValues.channelId ||
    chatRelayEnabled !== savedConfigValues.chatRelayEnabled ||
    chatRelayChannelId !== savedConfigValues.chatRelayChannelId ||
    chatRelayScope !== savedConfigValues.chatRelayScope ||
    autoStart !== savedConfigValues.autoStart;
  const eventsDirty = !sameWebhookEvents(webhookEvents, savedWebhookEvents);
  const permissionsDirty = !samePermissions(
    commandPermissions,
    savedCommandPermissions,
  );
  const anyDirty = configDirty || eventsDirty || permissionsDirty;
  // Start, Stop and Refresh re-read the bot's state: a form holding unsaved
  // edits keeps them instead of snapping back to the saved values.
  const reloadKeepingEdits = () =>
    loadData({ config: !configDirty, events: !eventsDirty, permissions: !permissionsDirty });
  const savingAny = saving || savingEvents || savingPermissions;
  // The SaveBar guards the dashboard; the setup wizard has no SaveBar (it
  // saves with Save Draft / Save & Start), so it guards what was typed into
  // it here. Same condition as showSetupWizard below.
  const wizardShown =
    guideOpen ||
    (!configLoadFailed && !(config?.hasToken && config?.guildId) && !status?.running);
  useUnsavedChangesGuard(wizardShown && anyDirty);
  // Why Save can't run: the same checks handleSaveConfig makes, said
  // before the click instead of after it.
  const saveBlockedReason = !canManageIntegrations
    ? t("shared.noPermission")
    : !configDirty
      ? undefined
      : !token && !config?.hasToken
        ? t("toasts.tokenRequired")
        : !guildId
          ? t("toasts.guildIdRequired")
          : hasGuildIdError
            ? t("toasts.invalidGuildIdFormat")
            : hasChannelIdError
              ? t("toasts.invalidChannelIdFormat")
              : hasAdminRoleIdError
                ? t("toasts.invalidAdminRoleIdFormat")
                : hasModRoleIdError
                  ? t("toasts.invalidModRoleIdFormat")
                  : hasChatRelayChannelIdError
                    ? t("management.configuration.relayChannelError")
                    : undefined;

  // Saves the Bot Configuration form. True when the server stored it (even
  // if the bot then failed to reconnect or start, which it reports), so the
  // caller reloads; false when nothing was stored.
  const saveConfig = async (andStart = false): Promise<boolean> => {
    // The disabled attribute on the buttons below is only the affordance --
    // this early return is the real gate, in case another path ever calls
    // this handler directly (bug-hunt-2026-08-27 floor rule).
    if (!canManageIntegrations) return false;
    // Same floor for the locked connection and role fields.
    const changesBotConnection =
      Boolean(token) ||
      guildId !== (config?.guildId || "") ||
      adminRoleId !== (config?.adminRoleId || "");
    const changesModRole = modRoleId !== (config?.modRoleId || "");
    if (
      (changesBotConnection && !canChangeBotConnection) ||
      (changesModRole && !canChangeModRole)
    ) {
      return false;
    }
    try {
      setSaving(true);
      setConfigMessage(null);

      if (!token && !config?.hasToken) {
        setConfigMessage({ type: "error", text: t("toasts.tokenRequired") });
        return false;
      }

      if (!guildId) {
        setConfigMessage({ type: "error", text: t("toasts.guildIdRequired") });
        return false;
      }

      if (!isValidDiscordId(guildId)) {
        setConfigMessage({
          type: "error",
          text: t("toasts.invalidGuildIdFormat"),
        });
        return false;
      }

      if (channelId && !isValidDiscordId(channelId)) {
        setConfigMessage({
          type: "error",
          text: t("toasts.invalidChannelIdFormat"),
        });
        return false;
      }

      if (adminRoleId && !isValidDiscordId(adminRoleId)) {
        setConfigMessage({
          type: "error",
          text: t("toasts.invalidAdminRoleIdFormat"),
        });
        return false;
      }

      if (modRoleId && !isValidDiscordId(modRoleId)) {
        setConfigMessage({
          type: "error",
          text: t("toasts.invalidModRoleIdFormat"),
        });
        return false;
      }

      const tokenToSave = token || "KEEP_EXISTING";

      const saved = await discordApi.updateConfig(
        tokenToSave,
        guildId,
        adminRoleId || undefined,
        channelId || undefined,
        autoStart,
        modRoleId || undefined,
        chatRelayEnabled,
        // Sent even when empty: PUT /config keeps a relay channel it isn't
        // sent, so `|| undefined` here meant emptying the field never cleared
        // it. "" clears it and the relay uses the notification channel.
        chatRelayChannelId,
        chatRelayScope,
      );

      // The settings are stored, but the new token or guild needed the bot to
      // reconnect and it could not: say so instead of reporting a plain save.
      // (botStarted is absent when no reconnect was needed, null when one was
      // already under way elsewhere.)
      if (saved?.botStarted === false) {
        setConfigMessage({
          type: "warning",
          text: t("toasts.configSavedBotReconnectFailed", {
            reason: saved.botStartError || t("shared.unknownError"),
          }),
        });
        setToken("");
        return true;
      }

      if (andStart) {
        try {
          await discordApi.start();
        } catch (startError: unknown) {
          // The config did save — say so, rather than implying it was lost.
          const why =
            getUserErrorMessage(startError, t("shared.unknownError"));
          setConfigMessage({
            type: "error",
            text: t("toasts.configSavedBotStartFailed", { reason: why }),
          });
          return true;
        }
        setConfigMessage({
          type: "success",
          text: t("toasts.configSavedAndStarted"),
        });
      } else {
        setConfigMessage({
          type: "success",
          text: t("toasts.configSaved"),
        });
      }
      setToken("");
      return true;
    } catch (error: unknown) {
      const msg =
        getUserErrorMessage(error, t("toasts.saveConfigFailedFallback"));
      setConfigMessage({ type: "error", text: msg });
      return false;
    } finally {
      setSaving(false);
    }
  };

  // The setup wizard's Save draft / Save & Start: save, then reload all.
  const handleSaveConfig = async (andStart = false) => {
    if (await saveConfig(andStart)) {
      setGuideOpen(false);
      await loadData();
    }
  };

  const handleTestToken = async () => {
    if (!canManageIntegrations) return;
    try {
      setTesting(true);
      setConfigMessage(null);
      setBotInfo(null);
      setInviteUrl(null);

      if (!token) {
        setConfigMessage({ type: "error", text: t("toasts.enterTokenToTest") });
        return;
      }

      const result = await discordApi.testToken(token);
      setBotInfo(result.bot);
      setInviteUrl(result.inviteUrl || null);
      setConfigMessage({
        type: "success",
        text: t("toasts.tokenValidWithBot", { username: result.bot.username }),
      });
    } catch (error: unknown) {
      const msg = getUserErrorMessage(error, t("toasts.invalidTokenFallback"));
      setConfigMessage({ type: "error", text: msg });
    } finally {
      setTesting(false);
    }
  };

  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [resetting, setResetting] = useState(false);

  const handleStart = async () => {
    if (starting || !canManageIntegrations) return;
    try {
      setStarting(true);
      setConfigMessage(null);
      await discordApi.start();
      setConfigMessage({ type: "success", text: t("toasts.botStarted") });
      await reloadKeepingEdits();
    } catch (error: unknown) {
      const msg =
        getUserErrorMessage(error, t("toasts.startBotFailedFallback"));
      setConfigMessage({ type: "error", text: msg });
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    if (stopping || !canManageIntegrations) return;
    try {
      setStopping(true);
      setConfigMessage(null);
      await discordApi.stop();
      setConfigMessage({ type: "success", text: t("toasts.botStopped") });
      await reloadKeepingEdits();
    } catch (error: unknown) {
      const msg = getUserErrorMessage(error, t("toasts.stopBotFailedFallback"));
      setConfigMessage({ type: "error", text: msg });
    } finally {
      setStopping(false);
    }
  };

  const handleSendTestMessage = async () => {
    if (sendingTest || !canManageIntegrations) return;
    try {
      setSendingTest(true);
      setConfigMessage(null);
      await discordApi.sendTestMessage();
      setConfigMessage({
        type: "success",
        text: t("toasts.testMessageSent"),
      });
    } catch (error: unknown) {
      const msg =
        getUserErrorMessage(error, t("toasts.testMessageFailedFallback"));
      setConfigMessage({ type: "error", text: msg });
    } finally {
      setSendingTest(false);
    }
  };

  const handleResetConfig = async () => {
    if (resetting || !canManageIntegrations) return;

    const confirmed = await confirm({
      title: t("toasts.wipeConfirmTitle"),
      description: t("toasts.wipeConfirmDesc"),
      confirmLabel: t("toasts.wipeConfirmLabel"),
      destructive: true,
    });

    if (!confirmed) return;

    try {
      setResetting(true);
      setConfigMessage(null);
      const result = await discordApi.resetConfig();
      // The server keeps the tier of each command whose capability this
      // user doesn't hold (security sweep 2026-10-05, D1); say which.
      const keptCommands = Array.isArray(result?.keptCommandPermissions)
        ? result.keptCommandPermissions
        : [];
      setToken("");
      setGuildId("");
      setAdminRoleId("");
      setModRoleId("");
      setChannelId("");
      setChatRelayEnabled(true);
      setChatRelayChannelId("");
      setChatRelayScope("public");
      setAutoStart(true);
      setBotInfo(null);
      setInviteUrl(null);
      setWebhookEvents({});
      setCommandPermissions({});
      setSetupStep(0);
      setConfigMessage({
        type: "success",
        text:
          keptCommands.length > 0
            ? t("toasts.wipeSuccessKeptTiers", {
                commands: keptCommands.map((command) => `/${command}`).join(", "),
              })
            : t("toasts.wipeSuccess"),
      });
      await loadData();
    } catch (error: unknown) {
      const msg = getUserErrorMessage(error, t("toasts.wipeFailedFallback"));
      setConfigMessage({ type: "error", text: msg });
    } finally {
      setResetting(false);
    }
  };

  const handleToggleEvent = (eventKey: string, enabled: boolean) => {
    setWebhookEvents((prev) => {
      // An enabled event with a blank template sends an empty message, which
      // Discord rejects — fall back to the default wording instead.
      const template =
        prev[eventKey]?.template?.trim() ||
        (enabled ? eventLabels[eventKey]?.defaultTemplate || "" : "");
      return { ...prev, [eventKey]: { ...prev[eventKey], enabled, template } };
    });
  };

  const handleUpdateTemplate = (eventKey: string, template: string) => {
    setWebhookEvents((prev) => ({
      ...prev,
      [eventKey]: { ...prev[eventKey], template },
    }));
  };

  const saveWebhookEvents = async (): Promise<boolean> => {
    if (!canManageIntegrations) return false;
    try {
      setSavingEvents(true);
      await discordApi.updateWebhookEvents(webhookEvents);
      setEventsMessage({ type: "success", text: t("management.webhookEvents.savedMessage") });
      return true;
    } catch (error: unknown) {
      const msg = getUserErrorMessage(error, t("management.webhookEvents.saveFailedFallback"));
      setEventsMessage({ type: "error", text: msg });
      return false;
    } finally {
      setSavingEvents(false);
    }
  };

  const savePermissions = async (): Promise<boolean> => {
    if (!canManageIntegrations) return false;
    try {
      setSavingPermissions(true);
      const saved = await discordApi.updatePermissions(commandPermissions);
      // The tiers are saved either way; this only says whether
      // Discord took the slash command update that goes with them.
      setPermissionsMessage(
        saved?.commandsRegistered === false
          ? {
              type: "warning",
              text: t("management.commandPermissions.savedNotRegistered"),
            }
          : {
              type: "success",
              text: t("management.commandPermissions.savedMessage"),
            },
      );
      return true;
    } catch (error: unknown) {
      const msg = getUserErrorMessage(error, t("management.commandPermissions.saveFailedFallback"));
      setPermissionsMessage({ type: "error", text: msg });
      return false;
    } finally {
      setSavingPermissions(false);
    }
  };

  // The SaveBar: saves each form that has unsaved edits, then reloads only
  // the forms that saved, so one that failed keeps what was typed in it.
  const handleSaveAll = async () => {
    if (!canManageIntegrations || savingAny || saveBlockedReason) return;
    const saved = { config: false, events: false, permissions: false };
    if (permissionsDirty) saved.permissions = await savePermissions();
    if (eventsDirty) saved.events = await saveWebhookEvents();
    if (configDirty) saved.config = await saveConfig(false);
    if (saved.config || saved.events || saved.permissions) {
      await loadData(saved);
    }
  };

  // Puts every form back to what the server last returned.
  const handleDiscard = () => {
    setToken("");
    setBotInfo(null);
    setInviteUrl(null);
    applyConfigToForm(config);
    setWebhookEvents(savedWebhookEvents);
    setCommandPermissions(savedCommandPermissions);
  };

  if (loading && !loadedOnce) {
    return (
      <PageSkeleton
        variant="form"
        title={t("management.pageHeaderTitle")}
        description={t("management.pageHeaderDescription")}
        icon={<MessageSquare />}
        section="panel"
      />
    );
  }

  // ─── Determine if we should show setup wizard ───
  const isConfigured = config?.hasToken && config?.guildId;
  // configLoadFailed means we don't actually know isConfigured -- config
  // stayed null (or stale-but-unconfirmed) because the read itself failed,
  // not because there's genuinely nothing saved. Without this guard, a
  // FULLY CONFIGURED bot that is merely stopped (a normal, common state)
  // would show the first-time setup wizard instead of the dashboard on any
  // transient config-fetch hiccup at page load: isConfigured falls back to
  // false, status.running is honestly false (the bot really is stopped),
  // and the wizard condition below was satisfied by two unrelated reasons
  // that happened to point the same way. Falling through to the dashboard
  // when we can't verify config is the safer wrong guess -- the worst case
  // is a brand-new, never-configured bot briefly shows the dashboard
  // instead of the wizard until the next successful refresh, not an
  // already-running production bot getting told to set up from scratch.
  const showSetupWizard =
    guideOpen || (!configLoadFailed && !isConfigured && !status?.running);

  // How far into the wizard the operator has actually unlocked, mirroring each
  // step's own "Next" gate. Without this, the stepper let you click straight to
  // Launch with an unverified or mistyped token — the "Save & Start" button only
  // checks that a token string is present, not that Verify ever confirmed it.
  // A bot already set up has a saved token: reopened from the header, the
  // guide doesn't ask to verify it again unless a new one is typed.
  const tokenStepPassed =
    Boolean(botInfo) || (guideOpen && Boolean(config?.hasToken) && !token);
  const maxReachableStep = !tokenStepPassed
    ? 1
    : !guildId || hasGuildIdError || hasChannelIdError || hasAdminRoleIdError
      ? 4
      : 5;

  // ═════════════════════════════════════════════════
  // SETUP WIZARD — shown when bot is not yet configured
  // ═════════════════════════════════════════════════
  if (showSetupWizard) {
    const wizardSteps = SETUP_STEPS.map((label, i) => {
      const stepStatus: StepStatus =
        i === setupStep
          ? "current"
          : i < setupStep
            ? "done"
            : i > maxReachableStep
              ? "locked"
              : "upcoming";
      return {
        id: String(i),
        label,
        status: stepStatus,
        lockedReason: t("wizard.stepLocked"),
      };
    });
    return (
      <div className="space-y-6 page-transition">
        <PageHeader
          title={t("management.pageHeaderTitle")}
          description={t("wizard.pageHeaderDescription")}
          actions={
            guideOpen ? (
              <Button variant="outline" size="sm" onClick={() => setGuideOpen(false)}>
                <ChevronLeft className="rtl:-scale-x-100" aria-hidden="true" />
                {t("management.closeGuide")}
              </Button>
            ) : undefined
          }
        />

        {/* Status Message */}
        <InlineFeedback message={configMessage} />

        {/* Step Content */}
        <SectionCard title={t("wizard.pageHeaderTitle")} icon={Bot}>
          <Stepper
            steps={wizardSteps}
            onStepClick={(id) => {
              const step = Number(id);
              if (step <= maxReachableStep) setSetupStep(step);
            }}
            className="border-b border-border/60 pb-4"
          />
          <div>
            {/* ── Step 0: Create Application ── */}
            {setupStep === 0 && (
              <div className="space-y-6">
                <div className="space-y-2">
                  <h3 className="flex items-center gap-2 text-base font-semibold">
                    <Zap className="h-4 w-4 text-primary" />
                    {t("wizard.step0.heading")}
                  </h3>
                  <p className="text-muted-foreground">
                    {t("wizard.step0.description")}
                  </p>
                </div>

                <div className="space-y-4 ps-1">
                  <div className="flex items-start gap-3">
                    <div className="flex items-center justify-center w-7 h-7 rounded-full bg-primary/10 text-primary text-sm font-bold shrink-0 mt-0.5">
                      1
                    </div>
                    <div>
                      <p className="font-medium">
                        {t("wizard.step0.step1Title")}
                      </p>
                      <p className="text-sm text-muted-foreground mb-2">
                        {t("wizard.step0.step1Desc")}
                      </p>
                      <Button variant="outline" asChild>
                        <a
                          href="https://discord.com/developers/applications"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <ExternalLink className="w-4 h-4 me-2" /> {t("wizard.step0.openPortalButton")}{" "}
                          <span className="sr-only">{t("wizard.step0.opensInNewTab")}</span>
                        </a>
                      </Button>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <div className="flex items-center justify-center w-7 h-7 rounded-full bg-primary/10 text-primary text-sm font-bold shrink-0 mt-0.5">
                      2
                    </div>
                    <div>
                      <p className="font-medium">{t("wizard.step0.step2Title")}</p>
                      <p className="text-sm text-muted-foreground">
                        {t("wizard.step0.step2Desc")}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <div className="flex items-center justify-center w-7 h-7 rounded-full bg-primary/10 text-primary text-sm font-bold shrink-0 mt-0.5">
                      3
                    </div>
                    <div>
                      <p className="font-medium">{t("wizard.step0.step3Title")}</p>
                      <p className="text-sm text-muted-foreground">
                        <Trans i18nKey="wizard.step0.step3Desc" t={t} components={{ 1: <strong /> }} />
                      </p>
                    </div>
                  </div>
                </div>

                <Alert className="border-border/60 bg-muted/40 text-sm">
                  <Bot className="h-4 w-4 text-primary" />
                  <AlertTitle>{t("wizard.step0.whyBotTitle")}</AlertTitle>
                  <AlertDescription>
                    {t("wizard.step0.whyBotDesc")}
                  </AlertDescription>
                </Alert>

                <div className="flex justify-end">
                  <Button onClick={() => setSetupStep(1)}>
                    {t("wizard.step0.next")}{" "}
                    <ChevronRight className="w-4 h-4 ms-1" />
                  </Button>
                </div>
              </div>
            )}

            {/* ── Step 1: Bot Token ── */}
            {setupStep === 1 && (
              <div className="space-y-6">
                <div className="space-y-2">
                  <h3 className="flex items-center gap-2 text-base font-semibold">
                    <Bot className="h-4 w-4 text-primary" />
                    {t("wizard.step1.heading")}
                  </h3>
                  <p className="text-muted-foreground">
                    <Trans i18nKey="wizard.step1.description" t={t} components={{ 1: <strong /> }} />
                  </p>
                </div>

                <Alert className="border-warning/40 bg-warning/10 text-sm">
                  <AlertTriangle className="h-4 w-4 text-warning" />
                  <AlertTitle className="text-warning">{t("wizard.step1.warningTitle")}</AlertTitle>
                  <AlertDescription>
                    {t("wizard.step1.warningDesc")}
                  </AlertDescription>
                </Alert>

                <div className="space-y-3">
                  <Label htmlFor="setup-token" className="text-sm font-medium">
                    {t("wizard.step1.tokenLabel")}
                  </Label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Input
                        id="setup-token"
                        type={showToken ? "text" : "password"}
                        value={token}
                        onChange={(e) => {
                          setToken(e.target.value);
                          setBotInfo(null);
                          setInviteUrl(null);
                        }}
                        placeholder={t("wizard.step1.tokenPlaceholder")}
                        className="pe-10 font-mono text-sm"
                        maxLength={200}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-0 top-0 h-full"
                        onClick={() => setShowToken(!showToken)}
                        aria-label={showToken ? t("wizard.step1.hideToken") : t("wizard.step1.showToken")}
                      >
                        {showToken ? (
                          <EyeOff className="w-4 h-4" />
                        ) : (
                          <Eye className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                    <DisabledReason reason={!canManageIntegrations ? t("shared.noPermission") : null}>
                    <Button
                      onClick={handleTestToken}
                      disabled={testing || !token || !canManageIntegrations}
                      className="min-w-[100px]"
                    >
                      {testing ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <>
                          <Zap className="w-4 h-4 me-1.5" /> {t("wizard.step1.verify")}
                        </>
                      )}
                    </Button>
                    </DisabledReason>
                  </div>
                </div>

                {/* Token test result */}
                {botInfo && (
                  <Alert className="border-primary/30 bg-primary/10">
                    {botInfo.avatar && (
                      <img
                        src={botInfo.avatar}
                        alt={`${botInfo.username} avatar`}
                        className="w-12 h-12 rounded-full"
                        width={48}
                        height={48}
                        loading="lazy"
                      />
                    )}
                    <div>
                      <p className="flex items-center gap-2 font-semibold text-primary">
                        <CheckCircle2 className="w-4 h-4" /> {t("wizard.step1.tokenVerified")}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {t("wizard.step1.botLabel")}{" "}
                        <span className="font-mono font-medium">
                          {botInfo.username}
                        </span>{" "}
                        ({t("wizard.step1.idLabel")} <span className="font-mono">{botInfo.id}</span>)
                      </p>
                    </div>
                  </Alert>
                )}

                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setSetupStep(0)}>
                    <ChevronLeft className="w-4 h-4 me-1" /> {t("wizard.step1.back")}
                  </Button>
                  <Button onClick={() => setSetupStep(2)} disabled={!tokenStepPassed}>
                    {t("wizard.step1.next")}{" "}
                    <ChevronRight className="w-4 h-4 ms-1" />
                  </Button>
                </div>
              </div>
            )}

            {/* ── Step 2: Enable Intents ── */}
            {setupStep === 2 && (
              <div className="space-y-6">
                <div className="space-y-2">
                  <h3 className="flex items-center gap-2 text-base font-semibold">
                    <ToggleLeft className="h-4 w-4 text-primary" />
                    {t("wizard.step2.heading")}
                  </h3>
                  <p className="text-muted-foreground">
                    <Trans i18nKey="wizard.step2.description" t={t} components={{ 1: <strong />, 2: <strong /> }} />
                  </p>
                </div>

                <div className="space-y-3">
                  {[
                    {
                      name: t("wizard.step2.serverMembersIntentName"),
                      why: t("wizard.step2.serverMembersIntentWhy"),
                      required: true,
                    },
                    {
                      name: t("wizard.step2.messageContentIntentName"),
                      why: t("wizard.step2.messageContentIntentWhy"),
                      required: true,
                    },
                  ].map((intent) => (
                    <div
                      key={intent.name}
                      className="flex items-start gap-3 p-4 rounded-lg border bg-muted/30"
                    >
                      <div className="relative mt-0.5 h-5 w-10 shrink-0 rounded-full border border-primary/15 bg-primary/10">
                        <div className="absolute right-0.5 top-0.5 h-4 w-4 rounded-full bg-card shadow-sm" />
                      </div>
                      <div>
                        <p className="font-medium flex items-center gap-2">
                          {intent.name}
                          {intent.required && (
                            <Badge variant="secondary" className="text-xs">
                              {t("wizard.step2.required")}
                            </Badge>
                          )}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {intent.why}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>

                <Alert className="border-border/60 bg-muted/40 text-sm">
                  <Bell className="h-4 w-4 text-primary" />
                  <AlertTitle>{t("wizard.step2.saveReminderTitle")}</AlertTitle>
                  <AlertDescription>
                    {t("wizard.step2.saveReminderDesc")}
                  </AlertDescription>
                </Alert>

                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setSetupStep(1)}>
                    <ChevronLeft className="w-4 h-4 me-1" /> {t("wizard.step2.back")}
                  </Button>
                  <Button onClick={() => setSetupStep(3)}>
                    {t("wizard.step2.next")} <ChevronRight className="w-4 h-4 ms-1" />
                  </Button>
                </div>
              </div>
            )}

            {/* ── Step 3: Invite Bot ── */}
            {setupStep === 3 && (
              <div className="space-y-6">
                <div className="space-y-2">
                  <h3 className="flex items-center gap-2 text-base font-semibold">
                    <UserPlus className="h-4 w-4 text-primary" />
                    {t("wizard.step3.heading")}
                  </h3>
                  <p className="text-muted-foreground">
                    {inviteUrl
                      ? t("wizard.step3.descriptionWithInvite")
                      : t("wizard.step3.descriptionNoInvite")}
                  </p>
                </div>

                {inviteUrl ? (
                  <div className="space-y-4">
                    {/* One-click invite */}
                    <div className="p-5 rounded-lg border-2 border-primary/30 bg-primary/5 text-center space-y-3">
                      <p className="font-medium">{t("wizard.step3.inviteReady")}</p>
                      <Button asChild>
                        <a
                          href={inviteUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <UserPlus className="w-4 h-4 me-2" /> {t("wizard.step3.inviteButton")}{" "}
                          <span className="sr-only">{t("wizard.step3.opensInNewTab")}</span>
                        </a>
                      </Button>
                      <div className="flex w-full flex-col items-center justify-center gap-2 sm:flex-row">
                        <p className="max-w-md break-all text-start font-mono text-xs text-muted-foreground sm:text-center">
                          {inviteUrl}
                        </p>
                        <CopyButton text={inviteUrl} label={t("wizard.step3.copyUrl")} />
                      </div>
                    </div>

                    <div className="text-sm text-muted-foreground space-y-1">
                      <p className="flex flex-wrap items-center gap-1.5">
                        <span>
                          <strong>{t("wizard.step3.permissionsIncludedLabel")}</strong> {t("wizard.step3.permissionsIncludedList")}
                        </span>
                        <HelpTip label={t("wizard.step3.permissionsIncludedLabel")}>
                          {t("wizard.step3.permissionsIncludedHelp")}
                        </HelpTip>
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <Alert className="border-warning/40 bg-warning/10 text-sm">
                      <AlertTriangle className="h-4 w-4 text-warning" />
                      <AlertTitle className="text-warning">
                        {t("wizard.step3.manualInviteTitle")}
                      </AlertTitle>
                      <AlertDescription className="space-y-3">
                        <p>
                          {t("wizard.step3.manualInviteIntro")}
                        </p>
                        <ol className="text-muted-foreground space-y-2 list-decimal list-inside">
                          <li>
                            <Trans i18nKey="wizard.step3.manualStep1" t={t} components={{ 1: <strong />, 2: <strong /> }} />
                          </li>
                          <li>
                            <Trans i18nKey="wizard.step3.manualStep2" t={t} components={{ 1: <strong />, 2: <strong /> }} />
                          </li>
                          <li>
                            <Trans i18nKey="wizard.step3.manualStep3" t={t} components={{ 1: <strong />, 2: <strong />, 3: <strong />, 4: <strong /> }} />
                          </li>
                          <li>
                            {t("wizard.step3.manualStep4")}
                          </li>
                          <li>
                            <Trans i18nKey="wizard.step3.manualStep5" t={t} components={{ 1: <strong /> }} />
                          </li>
                        </ol>
                      </AlertDescription>
                    </Alert>
                    <p className="text-sm text-muted-foreground">
                      {t("wizard.step3.tip")}
                    </p>
                  </div>
                )}

                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setSetupStep(2)}>
                    <ChevronLeft className="w-4 h-4 me-1" /> {t("wizard.step3.back")}
                  </Button>
                  <Button onClick={() => setSetupStep(4)}>
                    {t("wizard.step3.next")} <ChevronRight className="w-4 h-4 ms-1" />
                  </Button>
                </div>
              </div>
            )}

            {/* ── Step 4: Get Server IDs ── */}
            {setupStep === 4 && (
              <div className="space-y-6">
                <div className="space-y-2">
                  <h3 className="flex items-center gap-2 text-base font-semibold">
                    <Hash className="h-4 w-4 text-primary" />
                    {t("wizard.step4.heading")}
                  </h3>
                  <p className="text-muted-foreground">
                    {t("wizard.step4.description")}
                  </p>
                </div>

                {/* Developer Mode instructions */}
                <Alert className="border-border/60 bg-muted/40 text-sm">
                  <Settings className="h-4 w-4 text-primary" />
                  <AlertTitle>{t("wizard.step4.devModeTitle")}</AlertTitle>
                  <AlertDescription>
                    <ol className="text-muted-foreground space-y-1 list-decimal list-inside">
                      <li>
                        <Trans i18nKey="wizard.step4.devModeStep1" t={t} components={{ 1: <strong /> }} />
                      </li>
                      <li>
                        <Trans i18nKey="wizard.step4.devModeStep2" t={t} components={{ 1: <strong /> }} />
                      </li>
                      <li>
                        <Trans i18nKey="wizard.step4.devModeStep3" t={t} components={{ 1: <strong /> }} />
                      </li>
                    </ol>
                    <p className="text-muted-foreground mt-2">
                      <Trans i18nKey="wizard.step4.devModeCopyIdHint" t={t} components={{ 1: <strong /> }} />
                    </p>
                  </AlertDescription>
                </Alert>

                <div className="space-y-5">
                  {/* Guild ID */}
                  <div className="space-y-2">
                    <Label
                      htmlFor="setup-guildId"
                      className="flex items-center gap-2 font-medium"
                    >
                      <Server className="w-4 h-4 text-primary" />
                      {t("wizard.step4.guildIdLabel")}
                      <Badge variant="secondary" className="text-xs">
                        {t("wizard.step4.required")}
                      </Badge>
                    </Label>
                    <Input
                      id="setup-guildId"
                      value={guildId}
                      onChange={(e) => setGuildId(e.target.value)}
                      placeholder="123456789012345678"
                      className="font-mono"
                      maxLength={20}
                    />
                    <p className="text-xs text-muted-foreground">
                      <Trans i18nKey="wizard.step4.guildIdHelp" t={t} components={{ 1: <strong /> }} />
                    </p>
                    {hasGuildIdError && (
                      <p className="text-xs text-destructive">
                        {t("wizard.step4.guildIdError")}
                      </p>
                    )}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Channel ID */}
                    <div className="space-y-2">
                      <Label
                        htmlFor="setup-channelId"
                        className="flex items-center gap-2 font-medium"
                      >
                        <Hash className="w-4 h-4 text-primary" />
                        {t("wizard.step4.channelIdLabel")}
                        <Badge variant="outline" className="text-xs">
                          {t("wizard.step4.recommended")}
                        </Badge>
                      </Label>
                      <Input
                        id="setup-channelId"
                        value={channelId}
                        onChange={(e) => setChannelId(e.target.value)}
                        placeholder="123456789012345678"
                        className="font-mono"
                        maxLength={20}
                      />
                      <p className="text-xs text-muted-foreground">
                        <Trans i18nKey="wizard.step4.channelIdHelp" t={t} components={{ 1: <strong /> }} />
                      </p>
                      {hasChannelIdError && (
                        <p className="text-xs text-destructive">
                          {t("wizard.step4.channelIdError")}
                        </p>
                      )}
                    </div>

                    {/* Admin Role ID */}
                    <div className="space-y-2">
                      <Label
                        htmlFor="setup-adminRole"
                        className="flex items-center gap-2 font-medium"
                      >
                        <Shield className="w-4 h-4 text-primary" />
                        {t("wizard.step4.adminRoleLabel")}
                        <Badge variant="outline" className="text-xs">
                          {t("wizard.step4.optional")}
                        </Badge>
                      </Label>
                      <Input
                        id="setup-adminRole"
                        value={adminRoleId}
                        onChange={(e) => setAdminRoleId(e.target.value)}
                        placeholder="123456789012345678"
                        className="font-mono"
                        maxLength={20}
                      />
                      <p className="text-xs text-muted-foreground">
                        <Trans i18nKey="wizard.step4.adminRoleHelp" t={t} components={{ 1: <strong /> }} />
                      </p>
                      {hasAdminRoleIdError && (
                        <p className="text-xs text-destructive">
                          {t("wizard.step4.adminRoleError")}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setSetupStep(3)}>
                    <ChevronLeft className="w-4 h-4 me-1" /> {t("wizard.step4.back")}
                  </Button>
                  <Button
                    onClick={() => setSetupStep(5)}
                    disabled={
                      !guildId ||
                      hasGuildIdError ||
                      hasChannelIdError ||
                      hasAdminRoleIdError
                    }
                  >
                    {t("wizard.step4.next")} <ChevronRight className="w-4 h-4 ms-1" />
                  </Button>
                </div>
              </div>
            )}

            {/* ── Step 5: Launch ── */}
            {setupStep === 5 && (
              <div className="space-y-6">
                <div className="space-y-2">
                  <h3 className="flex items-center gap-2 text-base font-semibold">
                    <Play className="h-4 w-4 text-primary" />
                    {t("wizard.step5.heading")}
                  </h3>
                  <p className="text-muted-foreground">
                    {t("wizard.step5.description")}
                  </p>
                </div>

                {/* Review */}
                <div className="space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-1 rounded-lg border border-border/60 bg-muted/30 p-3">
                      <p className="text-xs text-muted-foreground">{t("wizard.step5.botTokenLabel")}</p>
                      <p className="break-all font-mono text-sm">
                        {token
                          ? "••••••••" + token.slice(-4)
                          : t("wizard.step5.botTokenNotSet")}
                      </p>
                    </div>
                    <div className="space-y-1 rounded-lg border border-border/60 bg-muted/30 p-3">
                      <p className="text-xs text-muted-foreground">{t("wizard.step5.guildIdLabel")}</p>
                      <p className="break-all font-mono text-sm">
                        {guildId || t("wizard.step5.guildIdNotSet")}
                      </p>
                    </div>
                    <div className="space-y-1 rounded-lg border border-border/60 bg-muted/30 p-3">
                      <p className="text-xs text-muted-foreground">
                        {t("wizard.step5.channelIdLabel")}
                      </p>
                      <p className="break-all font-mono text-sm">
                        {channelId || t("wizard.step5.channelIdNone")}
                      </p>
                    </div>
                    <div className="space-y-1 rounded-lg border border-border/60 bg-muted/30 p-3">
                      <p className="text-xs text-muted-foreground">
                        {t("wizard.step5.adminRoleIdLabel")}
                      </p>
                      <p className="break-all font-mono text-sm">
                        {adminRoleId || t("wizard.step5.adminRoleIdNone")}
                      </p>
                    </div>
                  </div>
                  {botInfo && (
                    <Alert className="border-primary/30 bg-primary/10 py-3">
                      {botInfo.avatar && (
                        <img
                          src={botInfo.avatar}
                          alt={`${botInfo.username} avatar`}
                          className="w-8 h-8 rounded-full"
                          width={32}
                          height={32}
                          loading="lazy"
                        />
                      )}
                      <p className="text-sm">
                        <span className="font-medium text-primary">
                          {t("wizard.step5.tokenVerified")}
                        </span>{" "}
                        — {botInfo.username}
                      </p>
                    </Alert>
                  )}
                </div>

                {/* Auto-Start */}
                <div className="flex items-center justify-between p-4 rounded-lg border">
                  <div>
                    <Label className="font-medium">{t("wizard.step5.autoStartLabel")}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t("wizard.step5.autoStartDesc")}
                    </p>
                  </div>
                  <Switch checked={autoStart} onCheckedChange={setAutoStart} />
                </div>

                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setSetupStep(4)}>
                    <ChevronLeft className="w-4 h-4 me-1" /> {t("wizard.step5.back")}
                  </Button>
                  <div className="flex gap-2">
                    <DisabledReason reason={botConnectionLockedReason}>
                    <Button
                      variant="outline"
                      onClick={() => handleSaveConfig(false)}
                      disabled={saving || !canSaveConfig || !!botConnectionLockedReason}
                    >
                      {saving ? (
                        <Loader2 className="w-4 h-4 me-2 animate-spin" />
                      ) : (
                        <Settings className="w-4 h-4 me-2" />
                      )}
                      {t("wizard.step5.saveDraft")}
                    </Button>
                    </DisabledReason>
                    <DisabledReason reason={botConnectionLockedReason}>
                    <Button
                      onClick={() => handleSaveConfig(true)}
                      disabled={saving || !canSaveConfig || !!botConnectionLockedReason}
                    >
                      {saving ? (
                        <Loader2 className="w-4 h-4 me-2 animate-spin" />
                      ) : (
                        <Play className="w-4 h-4 me-2" />
                      )}
                      {t("wizard.step5.saveAndStart")}
                    </Button>
                    </DisabledReason>
                  </div>
                </div>
              </div>
            )}
          </div>
        </SectionCard>

        {/* What you get */}
        <SectionCard title={t("wizard.whatItDoes.title")}>
            <div className="divide-y divide-border/60 text-sm">
              <div className="flex gap-3 py-3 first:pt-0">
                <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div className="space-y-1">
                  <p className="font-medium">{t("wizard.whatItDoes.slashCommandsTitle")}</p>
                  <p className="text-muted-foreground">
                    {t("wizard.whatItDoes.slashCommandsDesc")}
                  </p>
                </div>
              </div>
              <div className="flex gap-3 py-3">
                <MessagesSquare className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div className="space-y-1">
                  <p className="font-medium">{t("wizard.whatItDoes.chatBridgeTitle")}</p>
                  <p className="text-muted-foreground">
                    {t("wizard.whatItDoes.chatBridgeDesc")}
                  </p>
                </div>
              </div>
              <div className="flex gap-3 py-3 last:pb-0">
                <Bell className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div className="space-y-1">
                  <p className="font-medium">{t("wizard.whatItDoes.eventNotifTitle")}</p>
                  <p className="text-muted-foreground">
                    {t("wizard.whatItDoes.eventNotifDesc")}
                  </p>
                </div>
              </div>
            </div>
        </SectionCard>
      </div>
    );
  }

  const noPermissionReason = !canManageIntegrations ? t("shared.noPermission") : null;
  const hasBotError = Boolean(status?.error || status?.lastStartError);
  const botTone: StatusTone =
    starting || stopping
      ? "busy"
      : status?.running
        ? status.gatewayIssue
          ? "warn"
          : "ok"
        : hasBotError
          ? "error"
          : "idle";
  const botLabel = starting
    ? t("management.botStatus.starting")
    : stopping
      ? t("management.botStatus.stopping")
      : status?.running
        ? t("management.statusRunning")
        : hasBotError
          ? t("management.botStatus.botErrorLabel")
          : t("management.statusStopped");

  const pageAlerts: PageAlert[] = [];
  // status.error is a live runtime/init failure; lastStartError is the
  // reason the last start() attempt failed, and unlike the one-time message
  // POST /start shows, it survives a page refresh or coming back later --
  // cleared server-side the moment a start actually succeeds.
  if (hasBotError) {
    pageAlerts.push({
      id: "bot-error",
      tone: "error",
      title: t("management.botStatus.botErrorLabel"),
      description: status?.error || status?.lastStartError?.message,
    });
  }
  // The bot posts only in the guild set as the Guild ID; 1.4.5 also posted
  // to channels in other guilds, so an operator who updates needs to see
  // why those notifications stopped.
  if (status?.channelsOutsideGuild && status.channelsOutsideGuild.length > 0) {
    pageAlerts.push({
      id: "channels-outside-guild",
      tone: "warning",
      title: t("management.channelOutsideGuild.title"),
      description: t("management.channelOutsideGuild.body", {
        channels: status.channelsOutsideGuild.join(", "),
      }),
    });
  }
  // Gateway connectivity degraded: the bot is still running, it just hasn't
  // been able to confirm its connection is healthy for a while. The server
  // already ruled out a routine, self-healing reconnect (a few seconds)
  // before this appears, so it is information worth a look, not an alarm:
  // the quiet (info) treatment, dismissable per degraded episode.
  if (
    status?.gatewayIssue &&
    status.gatewayDegradedSince &&
    gatewayIssueDismissed !== status.gatewayDegradedSince
  ) {
    const since = status.gatewayDegradedSince;
    pageAlerts.push({
      id: "gateway-issue",
      tone: "info",
      title: t("management.gatewayIssue.label"),
      onDismiss: () => {
        try {
          localStorage.setItem(GATEWAY_ISSUE_DISMISSED_KEY, since);
        } catch {
          /* ignore storage failures */
        }
        setGatewayIssueDismissed(since);
      },
    });
  }

  // ═════════════════════════════════════════════════
  // MANAGEMENT VIEW — shown when bot is configured
  // ═════════════════════════════════════════════════
  return (
    <div className="space-y-6 page-transition">
      <PageHeader
        title={t("management.pageHeaderTitle")}
        description={t("management.pageHeaderDescription")}
        status={<StatusPill tone={botTone} label={botLabel} pulse={botTone === "warn"} />}
        actions={
          <>
            <Button
              variant="ghost"
              size="iconDense"
              onClick={() => void reloadKeepingEdits()}
              aria-label={t("management.refreshAria")}
              title={t("management.refreshAria")}
            >
              {loading ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw aria-hidden="true" />
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSetupStep(0);
                setGuideOpen(true);
              }}
              aria-label={t("management.setupGuide")}
            >
              <BookOpen aria-hidden="true" />
              <span className="hidden sm:inline">{t("management.setupGuide")}</span>
            </Button>
            {/* Start or Stop, whichever applies: the page's one primary.
                Stopping is reversible (the bot restarts on demand), so it
                takes no confirmation, same as Servers.tsx's Stop. */}
            <DisabledReason reason={noPermissionReason}>
              {status?.running ? (
                <Button
                  variant="command"
                  size="sm"
                  onClick={handleStop}
                  disabled={stopping || !canManageIntegrations}
                >
                  {stopping ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Square aria-hidden="true" />
                  )}
                  {stopping ? t("management.botStatus.stopping") : t("management.botStatus.stop")}
                </Button>
              ) : (
                <Button
                  variant="command"
                  size="sm"
                  onClick={handleStart}
                  disabled={starting || !canManageIntegrations}
                >
                  {starting ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Play aria-hidden="true" />
                  )}
                  {starting ? t("management.botStatus.starting") : t("management.botStatus.start")}
                </Button>
              )}
            </DisabledReason>
          </>
        }
      />

      <PageAlerts alerts={pageAlerts} />

      {/* Status Message */}
      <InlineFeedback message={configMessage} />

      {/* items-start: the short Bot Status card keeps its own height next
          to the long Command Permissions list instead of stretching into an
          empty box. */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        {/* Bot Status */}
        <SectionCard
          title={t("management.botStatus.title")}
          icon={Bot}
          actions={
            status?.running && config?.channelId ? (
              <DisabledReason reason={noPermissionReason}>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSendTestMessage}
                  disabled={sendingTest || !canManageIntegrations}
                >
                  {sendingTest ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Send aria-hidden="true" />
                  )}
                  {sendingTest ? t("management.botStatus.sendingTest") : t("management.botStatus.sendTest")}
                </Button>
              </DisabledReason>
            ) : undefined
          }
        >
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="min-w-0 rounded-lg border border-border/60 bg-muted/25 p-3">
              <dt className="label-micro">{t("management.botStatus.botUserLabel")}</dt>
              <dd className="mt-1 truncate text-base font-semibold">
                {/* "Waiting for login" was only literally true for the few
                    seconds a start() call is in flight; "Not signed in" is
                    honest whether a start failed or was never tried. */}
                {status?.username || t("management.botStatus.notSignedIn")}
              </dd>
            </div>
            <div
              className={`min-w-0 rounded-lg border p-3 ${config?.channelId ? "border-border/60 bg-muted/25" : "border-warning/30 bg-warning/5"}`}
            >
              <dt className="label-micro">{t("management.botStatus.channelLabel")}</dt>
              <dd
                className={`mt-1 truncate text-base font-semibold ${config?.channelId ? "" : "text-warning"}`}
              >
                {/* Only says a channel ID is saved (config.channelId), not
                    that the bot has ever posted there: "Configured", like
                    the Bot Token field's own badge, not "Linked". */}
                {config?.channelId ? t("management.botStatus.configured") : t("management.botStatus.notSet")}
              </dd>
            </div>
          </dl>
          <p className="text-sm text-muted-foreground">
            {t("management.botStatus.dependencyNote")}
          </p>
        </SectionCard>

        {/* Command Permissions */}
        <SectionCard
          title={t("management.commandPermissions.title")}
          description={t("management.commandPermissions.description")}
          icon={Shield}
        >
            <Alert className="border-border/60 bg-muted/40 text-sm">
              <Info className="h-4 w-4 text-primary" />
              <AlertTitle>{t("management.commandPermissions.independenceTitle")}</AlertTitle>
              <AlertDescription>
                {t("management.commandPermissions.independenceDesc")}
              </AlertDescription>
            </Alert>

            {/* Tier legend */}
            <div className="flex flex-wrap gap-3 text-sm mb-2">
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-primary" />
                <span className="font-medium">{t("management.commandPermissions.tierEveryone")}</span>
                <span className="text-muted-foreground">{t("management.commandPermissions.tierEveryoneDesc")}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-muted-foreground" />
                <span className="font-medium">{t("management.commandPermissions.tierModerator")}</span>
                <span className="text-muted-foreground">
                  {t("management.commandPermissions.tierModeratorDesc")}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-destructive" />
                <span className="font-medium">{t("management.commandPermissions.tierAdmin")}</span>
                <span className="text-muted-foreground">{t("management.commandPermissions.tierAdminDesc")}</span>
              </div>
            </div>

            <div className="space-y-1.5">
              {[
                { cmd: "status", label: "/status", desc: t("management.commandPermissions.commands.status.desc") },
                {
                  cmd: "players",
                  label: "/players",
                  desc: t("management.commandPermissions.commands.players.desc"),
                },
                { cmd: "save", label: "/save", desc: t("management.commandPermissions.commands.save.desc") },
                {
                  cmd: "broadcast",
                  label: "/broadcast",
                  desc: t("management.commandPermissions.commands.broadcast.desc"),
                },
                { cmd: "kick", label: "/kick", desc: t("management.commandPermissions.commands.kick.desc") },
                { cmd: "start", label: "/start", desc: t("management.commandPermissions.commands.start.desc") },
                { cmd: "stop", label: "/stop", desc: t("management.commandPermissions.commands.stop.desc") },
                {
                  cmd: "restart",
                  label: "/restart",
                  desc: t("management.commandPermissions.commands.restart.desc"),
                },
                { cmd: "leaderboard", label: "/leaderboard", desc: t("management.commandPermissions.commands.leaderboard.desc") },
                { cmd: "rcon", label: "/rcon", desc: t("management.commandPermissions.commands.rcon.desc") },
              ].map((c) => {
                const level = commandPermissions[c.cmd] || "admin";
                return (
                  <div
                    key={c.cmd}
                    className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/30 p-2.5"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <code className="text-sm font-semibold shrink-0">
                        {c.label}
                      </code>
                      <span className="text-sm text-muted-foreground truncate hidden sm:inline">
                        {c.desc}
                      </span>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      {(["everyone", "moderator", "admin"] as const).map(
                        (tier) => {
                          const isActive = level === tier;
                          const variant = isActive
                            ? tier === "everyone"
                              ? "default"
                              : tier === "moderator"
                                ? "secondary"
                                : "destructive"
                            : "ghost";
                          const icons = {
                            everyone: <Users className="w-3 h-3" />,
                            moderator: <Shield className="w-3 h-3" />,
                            admin: <Lock className="w-3 h-3" />,
                          };
                          const tierLabels = {
                            everyone: t("management.commandPermissions.tierEveryone"),
                            moderator: t("management.commandPermissions.tierModerator"),
                            admin: t("management.commandPermissions.tierAdmin"),
                          };
                          return (
                            <DisabledReason
                              key={tier}
                              reason={!canManageIntegrations ? t("shared.noPermission") : null}
                            >
                              <Button
                                variant={variant}
                                size="sm"
                                className="h-7 gap-1 px-2 text-xs"
                                disabled={!canManageIntegrations}
                                onClick={() => {
                                  if (!canManageIntegrations) return;
                                  setCommandPermissions((prev) => ({
                                    ...prev,
                                    [c.cmd]: tier,
                                  }));
                                }}
                              >
                                {icons[tier]}
                                <span className="hidden sm:inline">
                                  {tierLabels[tier]}
                                </span>
                              </Button>
                            </DisabledReason>
                          );
                        },
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <InlineFeedback message={permissionsMessage} />
        </SectionCard>
      </div>

      {/* Configuration */}
      <SectionCard
        title={t("management.configuration.title")}
        description={t("management.configuration.description")}
        icon={Settings}
      >
          {/* Bot Token */}
          <div className="space-y-2">
            <Label htmlFor="token" className="flex items-center gap-2">
              <Bot className="w-4 h-4" />
              {t("management.configuration.botTokenLabel")}
              {config?.hasToken && (
                <Badge variant="outline" className="text-xs">
                  <CheckCircle2 className="w-3 h-3 me-1" /> {t("management.configuration.configuredBadge")}
                </Badge>
              )}
            </Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <DisabledReason reason={botConnectionLockedReason} className="w-full">
                <Input
                  id="token"
                  type={showToken ? "text" : "password"}
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value);
                    setBotInfo(null);
                    setInviteUrl(null);
                  }}
                  placeholder={
                    config?.hasToken
                      ? t("management.configuration.tokenPlaceholderHasToken")
                      : t("management.configuration.tokenPlaceholderNew")
                  }
                  className="pe-10"
                  maxLength={200}
                  disabled={!!botConnectionLockedReason}
                />
                </DisabledReason>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full"
                  onClick={() => setShowToken(!showToken)}
                  aria-label={showToken ? t("management.configuration.hideToken") : t("management.configuration.showToken")}
                >
                  {showToken ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </Button>
              </div>
              <DisabledReason reason={!canManageIntegrations ? t("shared.noPermission") : null}>
              <Button
                variant="outline"
                onClick={handleTestToken}
                disabled={testing || !token || !canManageIntegrations}
              >
                {testing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <Zap className="w-4 h-4 me-1.5" /> {t("management.configuration.verifyToken")}
                  </>
                )}
              </Button>
              </DisabledReason>
            </div>
            {botInfo && (
              <div className="flex items-center gap-2 text-sm text-primary">
                {botInfo.avatar && (
                  <img
                    src={botInfo.avatar}
                    alt={`${botInfo.username} avatar`}
                    className="w-5 h-5 rounded-full"
                    width={20}
                    height={20}
                    loading="lazy"
                  />
                )}
                <CheckCircle2 className="w-3.5 h-3.5" /> {t("management.configuration.validTokenPrefix")}{" "}
                {botInfo.username}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Guild ID */}
            <div className="space-y-2">
              <Label htmlFor="guildId" className="flex items-center gap-2">
                <Server className="w-4 h-4" />
                {t("management.configuration.guildIdLabel")}
              </Label>
              <DisabledReason reason={botConnectionLockedReason} className="w-full">
              <Input
                id="guildId"
                value={guildId}
                onChange={(e) => setGuildId(e.target.value)}
                placeholder="123456789012345678"
                className="font-mono"
                maxLength={20}
                disabled={!!botConnectionLockedReason}
              />
              </DisabledReason>
              <p className="text-xs text-muted-foreground">
                {t("management.configuration.guildIdHelp")}
              </p>
              {hasGuildIdError && (
                <p className="text-xs text-destructive">
                  {t("management.configuration.guildIdError")}
                </p>
              )}
            </div>

            {/* Channel ID */}
            <div className="space-y-2">
              <Label htmlFor="channelId" className="flex items-center gap-2">
                <Hash className="w-4 h-4" />
                {t("management.configuration.channelIdLabel")}
              </Label>
              <DisabledReason reason={channelLockedReason} className="w-full">
                <Input
                  id="channelId"
                  value={channelId}
                  onChange={(e) => setChannelId(e.target.value)}
                  placeholder={t("management.configuration.channelIdPlaceholder")}
                  className="font-mono"
                  maxLength={20}
                  disabled={!!channelLockedReason}
                />
              </DisabledReason>
              <p className="text-xs text-muted-foreground">
                {t("management.configuration.channelIdHelp")}
              </p>
              {hasChannelIdError && (
                <p className="text-xs text-destructive">
                  {t("management.configuration.channelIdError")}
                </p>
              )}
            </div>

            {/* Admin Role ID */}
            <div className="space-y-2">
              <Label htmlFor="adminRoleId" className="flex items-center gap-2">
                <Lock className="w-4 h-4 text-primary" />
                {t("management.configuration.adminRoleLabel")}
              </Label>
              <DisabledReason reason={botConnectionLockedReason} className="w-full">
              <Input
                id="adminRoleId"
                value={adminRoleId}
                onChange={(e) => setAdminRoleId(e.target.value)}
                placeholder={t("management.configuration.adminRolePlaceholder")}
                className="font-mono"
                maxLength={20}
                disabled={!!botConnectionLockedReason}
              />
              </DisabledReason>
              <p className="text-xs text-muted-foreground">
                {t("management.configuration.adminRoleHelp")}
              </p>
              {hasAdminRoleIdError && (
                <p className="text-xs text-destructive">
                  {t("management.configuration.adminRoleError")}
                </p>
              )}
            </div>

            {/* Moderator Role ID */}
            <div className="space-y-2">
              <Label htmlFor="modRoleId" className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-primary" />
                {t("management.configuration.modRoleLabel")}
              </Label>
              <DisabledReason reason={modRoleLockedReason} className="w-full">
              <Input
                id="modRoleId"
                value={modRoleId}
                onChange={(e) => setModRoleId(e.target.value)}
                placeholder={t("management.configuration.modRolePlaceholder")}
                className="font-mono"
                maxLength={20}
                disabled={!!modRoleLockedReason}
              />
              </DisabledReason>
              <p className="text-xs text-muted-foreground">
                {t("management.configuration.modRoleHelp")}
              </p>
              {hasModRoleIdError && (
                <p className="text-xs text-destructive">
                  {t("management.configuration.modRoleError")}
                </p>
              )}
            </div>
          </div>

          {/* Auto-Start */}
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-muted/25 p-3">
            <div className="space-y-0.5">
              <Label htmlFor="discord-auto-start" className="font-medium">
                {t("management.configuration.autoStartLabel")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("management.configuration.autoStartDesc")}
              </p>
            </div>
            <Switch id="discord-auto-start" checked={autoStart} onCheckedChange={setAutoStart} />
          </div>

          {/* Chat Relay */}
          <div className="space-y-4 rounded-xl border border-border/70 bg-background/40 p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="discord-chat-relay" className="font-medium">
                  {t("management.configuration.chatRelayLabel")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("management.configuration.chatRelayDesc")}
                </p>
              </div>
              <Switch
                id="discord-chat-relay"
                checked={chatRelayEnabled}
                onCheckedChange={setChatRelayEnabled}
              />
            </div>
            {chatRelayEnabled && (
              <div className="space-y-2">
                <Label htmlFor="chatRelayScope" className="text-sm">
                  {t("management.configuration.forwardScopeLabel")}
                </Label>
                <Select
                  value={chatRelayScope}
                  onValueChange={(v) => setChatRelayScope(v as ChatRelayScope)}
                >
                  <SelectTrigger id="chatRelayScope">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="public">
                      {t("management.configuration.scopeOptionPublic")}
                    </SelectItem>
                    <SelectItem value="no-yell">
                      {t("management.configuration.scopeOptionNoYell")}
                    </SelectItem>
                    <SelectItem value="general">{t("management.configuration.scopeOptionGeneral")}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t("management.configuration.scopeHelp")}
                </p>
                {chatRelayScope === "public" && (
                  <p className="text-xs text-warning">
                    {t("management.configuration.scopeWarningPublic")}
                  </p>
                )}
              </div>
            )}
            {chatRelayEnabled && (
              <div className="space-y-2">
                <Label htmlFor="chatRelayChannelId" className="text-sm">
                  {t("management.configuration.relayChannelLabel")}
                </Label>
                <Input
                  id="chatRelayChannelId"
                  value={chatRelayChannelId}
                  onChange={(e) => setChatRelayChannelId(e.target.value)}
                  placeholder={t("management.configuration.relayChannelPlaceholder")}
                  className="font-mono"
                  maxLength={20}
                />
                <p className="text-xs text-muted-foreground">
                  {t("management.configuration.relayChannelHelp")}
                </p>
                {hasChatRelayChannelIdError && (
                  <p className="text-xs text-destructive">
                    {t("management.configuration.relayChannelError")}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Saving lives in the SaveBar at the bottom of the page; the
              one action left here is the destructive wipe. */}
          <div className="flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              {t("management.configuration.wipeNote")}
            </p>
            <DisabledReason reason={noPermissionReason}>
              <Button
                variant="destructive"
                size="sm"
                className="shrink-0 self-start sm:self-auto"
                onClick={handleResetConfig}
                disabled={resetting || !canManageIntegrations}
              >
                {resetting ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <Trash2 aria-hidden="true" />
                )}
                {resetting ? t("management.configuration.wiping") : t("management.configuration.wipe")}
              </Button>
            </DisabledReason>
          </div>
      </SectionCard>

      {/* Webhook Events */}
      <SectionCard
        title={t("management.webhookEvents.title")}
        description={t("management.webhookEvents.description")}
        icon={Bell}
      >
          {Object.entries(eventLabels).map(
            ([eventKey, { label, description, variables }]) => {
              const event = webhookEvents[eventKey] || {
                enabled: false,
                template: "",
              };
              const playerEventLocked = PLAYER_EVENT_KEYS.includes(eventKey) && !canViewPlayers;
              return (
                <div key={eventKey} className="space-y-3 rounded-lg border border-border/60 bg-muted/25 p-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="space-y-0.5">
                      <Label htmlFor={`event-${eventKey}`} className="font-medium">
                        {label}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {description}
                      </p>
                      {playerEventLocked && (
                        <p className="text-xs text-muted-foreground">
                          {t("capabilityGate.playerEvents")}
                        </p>
                      )}
                    </div>
                    <Switch
                      id={`event-${eventKey}`}
                      checked={event.enabled}
                      disabled={playerEventLocked && !event.enabled}
                      onCheckedChange={(checked) =>
                        handleToggleEvent(eventKey, checked)
                      }
                    />
                  </div>
                  {event.enabled && (
                    <div className="space-y-2">
                      <Label
                        htmlFor={`template-${eventKey}`}
                        className="text-sm"
                      >
                        {t("management.webhookEvents.templateLabel")}
                      </Label>
                      <Textarea
                        id={`template-${eventKey}`}
                        value={event.template}
                        onChange={(e) =>
                          handleUpdateTemplate(eventKey, e.target.value)
                        }
                        placeholder={t("management.webhookEvents.templatePlaceholder")}
                        readOnly={playerEventLocked}
                        rows={3}
                        // The server keeps the first 500 characters
                        // (PUT /discord/webhook-events), so the field stops
                        // there instead of silently cutting what was typed.
                        maxLength={EVENT_TEMPLATE_MAX_LENGTH}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("management.webhookEvents.variablesLabel", { variables })}
                      </p>
                    </div>
                  )}
                </div>
              );
            },
          )}
          <InlineFeedback message={eventsMessage} />
      </SectionCard>

      {/* One save for the three forms above (configuration, event
          notifications, command permissions); it appears once any of them
          has unsaved edits and asks before leaving the page with them. */}
      <SaveBar
        dirty={anyDirty}
        saving={savingAny}
        onSave={handleSaveAll}
        onDiscard={handleDiscard}
        disabledReason={saveBlockedReason}
        saveLabel={t("management.configuration.saveChanges")}
      />
    </div>
  );
}

import { useTranslation } from 'react-i18next';
import { useState, useEffect, useCallback, useRef } from "react";
import { copyText } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { discordApi } from "@/lib/api";
import { useConfirm } from "@/contexts/ConfirmContext";
import {
  MessageSquare,
  Bot,
  Play,
  Square,
  RefreshCw,
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
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";

interface DiscordStatus {
  running: boolean;
  configured: boolean;
  connected?: boolean;
  username?: string;
  error?: string;
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
type FlashMessage = { type: "success" | "error"; text: string };

// Small helper to copy text to clipboard
function CopyButton({ text, label, copiedLabel }: { text: string; label: string; copiedLabel: string }) {
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
      {copied ? copiedLabel : label}
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
  const { t } = useTranslation('discord');
  if (!message) return null;

  return (
    <Alert
      variant={message.type === "error" ? "destructive" : "default"}
      className={className}
    >
      {message.type === "error" ? (
        <AlertCircle className="h-4 w-4" />
      ) : (
        <CheckCircle2 className="h-4 w-4" />
      )}
      <AlertTitle>{message.type === "error" ? t('feedback.error') : t('feedback.success')}</AlertTitle>
      <AlertDescription>{message.text}</AlertDescription>
    </Alert>
  );
}

const eventLabels: Record<
  string,
  { labelKey: string; descriptionKey: string; variables: string }
> = {
  serverStart: {
    labelKey: "events.serverStart",
    descriptionKey: "events.serverStartDescription",
    variables: "events.noneVariables",
  },
  serverStop: {
    labelKey: "events.serverStop",
    descriptionKey: "events.serverStopDescription",
    variables: "events.noneVariables",
  },
  playerJoin: {
    labelKey: "events.playerJoin",
    descriptionKey: "events.playerJoinDescription",
    variables: "{player}",
  },
  playerLeave: {
    labelKey: "events.playerLeave",
    descriptionKey: "events.playerLeaveDescription",
    variables: "{player}",
  },
  scheduledRestart: {
    labelKey: "events.scheduledRestart",
    descriptionKey: "events.scheduledRestartDescription",
    variables: "{minutes}",
  },
  backupComplete: {
    labelKey: "events.backupComplete",
    descriptionKey: "events.backupCompleteDescription",
    variables: "events.noneVariables",
  },
  playerDeath: {
    labelKey: "events.playerDeath",
    descriptionKey: "events.playerDeathDescription",
    variables: "{player}, {location}, {x}, {y}, {z}, {pvp}",
  },
};

const SETUP_STEPS = [
  { labelKey: "steps.createApp", icon: Zap },
  { labelKey: "steps.botToken", icon: Bot },
  { labelKey: "steps.intents", icon: ToggleLeft },
  { labelKey: "steps.inviteBot", icon: UserPlus },
  { labelKey: "steps.serverIds", icon: Hash },
  { labelKey: "steps.launch", icon: Play },
];

export default function Discord() {
  const { t } = useTranslation('discord');
  
  
  const confirm = useConfirm();
  const [status, setStatus] = useState<DiscordStatus | null>(null);
  const [config, setConfig] = useState<DiscordConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [botInfo, setBotInfo] = useState<BotInfo | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [webhookEvents, setWebhookEvents] = useState<WebhookEvents>({});
  const [savingEvents, setSavingEvents] = useState(false);
  const [autoStart, setAutoStart] = useState(true);
  const [commandPermissions, setCommandPermissions] = useState<
    Record<string, string>
  >({});
  const [savingPermissions, setSavingPermissions] = useState(false);

  // Form state
  const [token, setToken] = useState("");
  const [guildId, setGuildId] = useState("");
  const [adminRoleId, setAdminRoleId] = useState("");
  const [modRoleId, setModRoleId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [chatRelayEnabled, setChatRelayEnabled] = useState(true);
  const [chatRelayChannelId, setChatRelayChannelId] = useState("");

  // Setup wizard state
  const [configMessage, setConfigMessage] = useState<FlashMessage | null>(null);
  const [eventsMessage, setEventsMessage] = useState<FlashMessage | null>(null);
  const [permissionsMessage, setPermissionsMessage] =
    useState<FlashMessage | null>(null);

  const [setupStep, setSetupStep] = useState(0);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [statusData, configData, eventsData, permsData] = await Promise.all(
        [
          discordApi
            .getStatus()
            .catch(() => ({ running: false, configured: false })),
          discordApi.getConfig().catch(() => null),
          discordApi.getWebhookEvents().catch(() => ({ events: {} })),
          discordApi.getPermissions().catch(() => ({ permissions: {} })),
        ],
      );

      setStatus(statusData);
      setConfig(configData);
      setWebhookEvents(eventsData.events || {});
      setCommandPermissions(permsData.permissions || {});

      if (configData) {
        setGuildId(configData.guildId || "");
        setAdminRoleId(configData.adminRoleId || "");
        setModRoleId(configData.modRoleId || "");
        setChannelId(configData.channelId || "");
        setChatRelayEnabled(configData.chatRelayEnabled !== false);
        setChatRelayChannelId(configData.chatRelayChannelId || "");
        setAutoStart(configData.autoStart !== false);
      }
    } catch {
      setConfigMessage({
        type: "error",
        text: t('messages.loadFailed'),
      });
    } finally {
      setLoading(false);
    }
  }, [t]);

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

  // Discord ID validation (snowflake format - 17-19 digit number)
  const isValidDiscordId = (id: string): boolean => {
    if (!id) return true; // Empty is allowed for optional fields
    return /^\d{17,19}$/.test(id);
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

  const handleSaveConfig = async (andStart = false) => {
    try {
      setSaving(true);
      setConfigMessage(null);

      if (!token && !config?.hasToken) {
        setConfigMessage({ type: "error", text: t('errors.tokenRequired') });
        return;
      }

      if (!guildId) {
        setConfigMessage({ type: "error", text: t('errors.guildRequired') });
        return;
      }

      if (!isValidDiscordId(guildId)) {
        setConfigMessage({
          type: "error",
          text: t('errors.invalidGuildId'),
        });
        return;
      }

      if (channelId && !isValidDiscordId(channelId)) {
        setConfigMessage({
          type: "error",
          text: t('errors.invalidChannelId'),
        });
        return;
      }

      if (adminRoleId && !isValidDiscordId(adminRoleId)) {
        setConfigMessage({
          type: "error",
          text: t('errors.invalidAdminRoleId'),
        });
        return;
      }

      if (modRoleId && !isValidDiscordId(modRoleId)) {
        setConfigMessage({
          type: "error",
          text: t('errors.invalidModeratorRoleId'),
        });
        return;
      }

      const tokenToSave = token || "KEEP_EXISTING";

      await discordApi.updateConfig(
        tokenToSave,
        guildId,
        adminRoleId || undefined,
        channelId || undefined,
        autoStart,
        modRoleId || undefined,
        chatRelayEnabled,
        chatRelayChannelId || undefined,
      );

      if (andStart) {
        await discordApi.start();
        setConfigMessage({
          type: "success",
          text: t('messages.configurationStarted'),
        });
      } else {
        setConfigMessage({
          type: "success",
          text: t('messages.configurationSaved'),
        });
      }
      setToken("");
      await loadData();
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : t('messages.saveConfigurationFailed');
      setConfigMessage({ type: "error", text: msg });
    } finally {
      setSaving(false);
    }
  };

  const handleTestToken = async () => {
    try {
      setTesting(true);
      setConfigMessage(null);
      setBotInfo(null);
      setInviteUrl(null);

      if (!token) {
        setConfigMessage({ type: "error", text: t('messages.enterTokenToTest') });
        return;
      }

      const result = await discordApi.testToken(token);
      setBotInfo(result.bot);
      setInviteUrl(result.inviteUrl || null);
      setConfigMessage({
        type: "success",
        text: t('messages.tokenValid', { username: result.bot.username }),
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : t('messages.invalidToken');
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
    if (starting) return;
    try {
      setStarting(true);
      setConfigMessage(null);
      await discordApi.start();
      setConfigMessage({ type: "success", text: t('messages.botStarted') });
      await loadData();
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : t('messages.startBotFailed');
      setConfigMessage({ type: "error", text: msg });
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    if (stopping) return;
    try {
      setStopping(true);
      setConfigMessage(null);
      await discordApi.stop();
      setConfigMessage({ type: "success", text: t('messages.botStopped') });
      await loadData();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : t('messages.stopBotFailed');
      setConfigMessage({ type: "error", text: msg });
    } finally {
      setStopping(false);
    }
  };

  const handleSendTestMessage = async () => {
    if (sendingTest) return;
    try {
      setSendingTest(true);
      setConfigMessage(null);
      await discordApi.sendTestMessage();
      setConfigMessage({
        type: "success",
        text: t('messages.testMessageSent'),
      });
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : t('messages.testMessageFailed');
      setConfigMessage({ type: "error", text: msg });
    } finally {
      setSendingTest(false);
    }
  };

  const handleResetConfig = async () => {
    if (resetting) return;

    const confirmed = await confirm({
      title: t('reset.confirmTitle'),
      description: t('reset.confirmDescription'),
      confirmLabel: t('reset.confirmLabel'),
      destructive: true,
    });

    if (!confirmed) return;

    try {
      setResetting(true);
      setConfigMessage(null);
      await discordApi.resetConfig();
      setToken("");
      setGuildId("");
      setAdminRoleId("");
      setModRoleId("");
      setChannelId("");
      setChatRelayEnabled(true);
      setChatRelayChannelId("");
      setAutoStart(true);
      setBotInfo(null);
      setInviteUrl(null);
      setWebhookEvents({});
      setCommandPermissions({});
      setSetupStep(0);
      setConfigMessage({
        type: "success",
        text: t('messages.resetComplete'),
      });
      await loadData();
    } catch (error: unknown) {
      const msg =
        error instanceof Error
          ? error.message
          : t('messages.resetFailed');
      setConfigMessage({ type: "error", text: msg });
    } finally {
      setResetting(false);
    }
  };

  const handleToggleEvent = (eventKey: string, enabled: boolean) => {
    setWebhookEvents((prev) => ({
      ...prev,
      [eventKey]: { ...prev[eventKey], enabled },
    }));
  };

  const handleUpdateTemplate = (eventKey: string, template: string) => {
    setWebhookEvents((prev) => ({
      ...prev,
      [eventKey]: { ...prev[eventKey], template },
    }));
  };

  const handleSaveWebhookEvents = async () => {
    try {
      setSavingEvents(true);
      await discordApi.updateWebhookEvents(webhookEvents);
      setEventsMessage({ type: "success", text: t('messages.webhookEventsSaved') });
      await loadData();
    } catch (error: unknown) {
      const msg =
        error instanceof Error
          ? error.message
          : t('messages.webhookEventsSaveFailed');
      setEventsMessage({ type: "error", text: msg });
    } finally {
      setSavingEvents(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // ─── Determine if we should show setup wizard ───
  const isConfigured = config?.hasToken && config?.guildId;
  const showSetupWizard = !isConfigured && !status?.running;

  // ═════════════════════════════════════════════════
  // SETUP WIZARD — shown when bot is not yet configured
  // ═════════════════════════════════════════════════
  if (showSetupWizard) {
    return (
      <div className="space-y-6 page-transition">
        <PageHeader
          title={t("title")}
          description={t("description")}
          icon={<MessageSquare className="w-5 h-5" />}
        />

        {/* Status Message */}
        <InlineFeedback message={configMessage} />

        {/* Stepper */}
        <div className="flex items-center justify-between overflow-x-auto gap-1">
          {SETUP_STEPS.map((step, i) => {
            const Icon = step.icon;
            const isActive = i === setupStep;
            const isDone = i < setupStep;
            return (
              <div key={i} className="flex items-center flex-1 last:flex-none">
                <button
                  onClick={() => setSetupStep(i)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-sm font-medium shrink-0 ${
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : isDone
                        ? "bg-primary/10 text-primary hover:bg-primary/15"
                        : "bg-muted text-muted-foreground hover:bg-muted/80"
                  }`}
                >
                  {isDone ? (
                    <Check className="w-4 h-4" />
                  ) : (
                    <Icon className="w-4 h-4" />
                  )}
                  <span className="hidden md:inline">{t(step.labelKey)}</span>
                </button>
                {i < SETUP_STEPS.length - 1 && (
                  <div
                    className={`flex-1 h-px mx-2 ${isDone ? "bg-primary/30" : "bg-border"}`}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Step Content */}
        <Card>
          <CardContent className="pt-6">
            {/* ── Step 0: Create Application ── */}
            {setupStep === 0 && (
              <div className="space-y-6">
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Zap className="w-5 h-5 text-primary" />
                    {t('wizard.createApplicationTitle')}
                  </h3>
                  <p className="text-muted-foreground">
                    {t('wizard.createApplicationDescription')}
                  </p>
                </div>

                <div className="space-y-4 pl-1">
                  <div className="flex items-start gap-3">
                    <div className="flex items-center justify-center w-7 h-7 rounded-full bg-primary/10 text-primary text-sm font-bold shrink-0 mt-0.5">
                      1
                    </div>
                    <div>
                      <p className="font-medium">
                        {t('wizard.openDeveloperPortal')}
                      </p>
                      <p className="text-sm text-muted-foreground mb-2">
                        {t('wizard.openDeveloperPortalDescription')}
                      </p>
                      <Button variant="outline" asChild>
                        <a
                          href="https://discord.com/developers/applications"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <ExternalLink className="w-4 h-4 mr-2" /> {t('wizard.openDeveloperPortalButton')}
                          <span className="sr-only">{t('wizard.opensInNewTab')}</span>
                        </a>
                      </Button>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <div className="flex items-center justify-center w-7 h-7 rounded-full bg-primary/10 text-primary text-sm font-bold shrink-0 mt-0.5">
                      2
                    </div>
                    <div>
                      <p className="font-medium">{t('clickNewApplication')}</p>
                      <p className="text-sm text-muted-foreground">
                        {t('wizard.newApplicationDescription')}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <div className="flex items-center justify-center w-7 h-7 rounded-full bg-primary/10 text-primary text-sm font-bold shrink-0 mt-0.5">
                      3
                    </div>
                    <div>
                      <p className="font-medium">{t('goToTheBotSection')}</p>
                      <p className="text-sm text-muted-foreground">
                        {t('wizard.botSectionDescription')}
                      </p>
                    </div>
                  </div>
                </div>

                <Alert className="border-border/60 bg-muted/40 text-sm">
                  <Bot className="h-4 w-4 text-primary" />
                  <AlertTitle>{t('whyDoINeedABot')}</AlertTitle>
                  <AlertDescription>
                    {t('wizard.botWhyDescription')}
                  </AlertDescription>
                </Alert>

                <div className="flex justify-end">
                  <Button onClick={() => setSetupStep(1)}>
                    {t('wizard.nextBotToken')}{" "}
                    <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              </div>
            )}

            {/* ── Step 1: Bot Token ── */}
            {setupStep === 1 && (
              <div className="space-y-6">
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Bot className="w-5 h-5 text-primary" />
                    {t('wizard.copyBotTokenTitle')}
                  </h3>
                  <p className="text-muted-foreground">
                    {t('wizard.copyBotTokenDescription')}
                  </p>
                </div>

                <Alert className="border-warning/40 bg-warning/10 text-sm">
                  <AlertTriangle className="h-4 w-4 text-warning" />
                  <AlertTitle className="text-warning">{t('important')}</AlertTitle>
                  <AlertDescription>
                    {t('wizard.tokenWarning')}
                  </AlertDescription>
                </Alert>

                <div className="space-y-3">
                  <Label htmlFor="setup-token" className="text-sm font-medium">
                    {t('token.label')}
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
                        placeholder={t('token.placeholder')}
                        className="pr-10 font-mono text-sm"
                        maxLength={200}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-0 top-0 h-full"
                        onClick={() => setShowToken(!showToken)}
                        aria-label={showToken ? t('token.hide') : t('token.show')}
                      >
                        {showToken ? (
                          <EyeOff className="w-4 h-4" />
                        ) : (
                          <Eye className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                    <Button
                      onClick={handleTestToken}
                      disabled={testing || !token}
                      className="min-w-[100px]"
                    >
                      {testing ? (
                        <RefreshCw className="w-4 h-4 animate-spin" />
                      ) : (
                        <>
                          <Zap className="w-4 h-4 mr-1.5" /> {t('wizard.verify')}
                        </>
                      )}
                    </Button>
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
                        <CheckCircle2 className="w-4 h-4" /> {t('wizard.tokenVerified')}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {t('wizard.botInfo', { username: botInfo.username, id: botInfo.id })}
                      </p>
                    </div>
                  </Alert>
                )}

                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setSetupStep(0)}>
                    <ChevronLeft className="w-4 h-4 mr-1" /> {t('wizard.back')}
                  </Button>
                  <Button onClick={() => setSetupStep(2)} disabled={!botInfo}>
                    {t('wizard.nextIntents')}{" "}
                    <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              </div>
            )}

            {/* ── Step 2: Enable Intents ── */}
            {setupStep === 2 && (
              <div className="space-y-6">
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <ToggleLeft className="w-5 h-5 text-primary" />
                    {t('wizard.enableIntentsTitle')}
                  </h3>
                  <p className="text-muted-foreground">
                    {t('wizard.enableIntentsDescription')}
                  </p>
                </div>

                <div className="space-y-3">
                  {[
                    {
                      nameKey: "wizard.serverMembersIntent",
                      whyKey: "wizard.serverMembersIntentWhy",
                      required: true,
                    },
                    {
                      nameKey: "wizard.messageContentIntent",
                      whyKey: "wizard.messageContentIntentWhy",
                      required: true,
                    },
                  ].map((intent) => (
                    <div
                      key={intent.nameKey}
                      className="flex items-start gap-3 p-4 rounded-lg border bg-muted/30"
                    >
                      <div className="relative mt-0.5 h-5 w-10 shrink-0 rounded-full border border-primary/15 bg-primary/10">
                        <div className="absolute right-0.5 top-0.5 h-4 w-4 rounded-full bg-card shadow-sm" />
                      </div>
                      <div>
                        <p className="font-medium flex items-center gap-2">
                          {t(intent.nameKey)}
                          {intent.required && (
                            <Badge variant="secondary" className="text-xs">
                              {t('wizard.required')}
                            </Badge>
                          )}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {t(intent.whyKey)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>

                <Alert className="border-border/60 bg-muted/40 text-sm">
                  <Bell className="h-4 w-4 text-primary" />
                  <AlertTitle>{t('doNotForgetToSave')}</AlertTitle>
                  <AlertDescription>
                    {t('wizard.saveIntentsDescription')}
                  </AlertDescription>
                </Alert>

                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setSetupStep(1)}>
                    <ChevronLeft className="w-4 h-4 mr-1" /> {t('wizard.back')}
                  </Button>
                  <Button onClick={() => setSetupStep(3)}>
                    {t('wizard.nextInvite')} <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              </div>
            )}

            {/* ── Step 3: Invite Bot ── */}
            {setupStep === 3 && (
              <div className="space-y-6">
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <UserPlus className="w-5 h-5 text-primary" />
                    {t('wizard.inviteBotTitle')}
                  </h3>
                  <p className="text-muted-foreground">
                    {inviteUrl ? t('wizard.inviteReadyDescription') : t('wizard.inviteManualDescription')}
                  </p>
                </div>

                {inviteUrl ? (
                  <div className="space-y-4">
                    {/* One-click invite */}
                    <div className="p-5 rounded-lg border-2 border-primary/30 bg-primary/5 text-center space-y-3">
                      <p className="font-medium">{t('yourInviteLinkIsReady')}</p>
                      <Button size="lg" asChild>
                        <a
                          href={inviteUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <UserPlus className="w-5 h-5 mr-2" /> {t('wizard.inviteButton')}
                          <span className="sr-only">{t('wizard.opensInNewTab')}</span>
                        </a>
                      </Button>
                      <div className="flex w-full flex-col items-center justify-center gap-2 sm:flex-row">
                        <p className="max-w-md break-all text-left font-mono text-xs text-muted-foreground sm:text-center">
                          {inviteUrl}
                        </p>
                        <CopyButton text={inviteUrl} label={t('webhook.copy')} copiedLabel={t('feedback.copied')} />
                      </div>
                    </div>

                    <div className="text-sm text-muted-foreground space-y-1">
                      <p>
                        <strong>{t('permissionsIncluded')}</strong> {t('wizard.permissionsList')}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <Alert className="border-warning/40 bg-warning/10 text-sm">
                      <AlertTriangle className="h-4 w-4 text-warning" />
                      <AlertTitle className="text-warning">
                        {t('wizard.manualInvite')}
                      </AlertTitle>
                      <AlertDescription className="space-y-3">
                        <p>
                          {t('wizard.manualInviteDescription')}
                        </p>
                        <ol className="text-muted-foreground space-y-2 list-decimal list-inside">
                          <li>
                            {t('wizard.manualStep1')}
                          </li>
                          <li>
                            {t('wizard.manualStep2')}
                          </li>
                          <li>
                            {t('wizard.manualStep3')}
                          </li>
                          <li>
                            {t('wizard.manualStep4')}
                          </li>
                          <li>
                            {t('wizard.manualStep5')}
                          </li>
                        </ol>
                      </AlertDescription>
                    </Alert>
                    <p className="text-sm text-muted-foreground">
                      {t('wizard.inviteTip')}
                    </p>
                  </div>
                )}

                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setSetupStep(2)}>
                    <ChevronLeft className="w-4 h-4 mr-1" /> {t('wizard.back')}
                  </Button>
                  <Button onClick={() => setSetupStep(4)}>
                    {t('wizard.nextServerIds')} <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              </div>
            )}

            {/* ── Step 4: Get Server IDs ── */}
            {setupStep === 4 && (
              <div className="space-y-6">
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Hash className="w-5 h-5 text-primary" />
                    {t('wizard.configureServerIdsTitle')}
                  </h3>
                  <p className="text-muted-foreground">
                    {t('wizard.configureServerIdsDescription')}
                  </p>
                </div>

                {/* Developer Mode instructions */}
                <Alert className="border-border/60 bg-muted/40 text-sm">
                  <Settings className="h-4 w-4 text-primary" />
                  <AlertTitle>{t('howToEnableDeveloperMode')}</AlertTitle>
                  <AlertDescription>
                    <ol className="text-muted-foreground space-y-1 list-decimal list-inside">
                      <li>
                        {t('wizard.developerStep1')}
                      </li>
                      <li>
                        {t('wizard.developerStep2')}
                      </li>
                      <li>
                        {t('wizard.developerStep3')}
                      </li>
                    </ol>
                    <p className="text-muted-foreground mt-2">
                      {t('wizard.developerModeDescription')}
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
                      {t('wizard.guildServerId')}
                      <Badge variant="secondary" className="text-xs">
                        {t('wizard.required')}
                      </Badge>
                    </Label>
                    <Input
                      id="setup-guildId"
                      value={guildId}
                      onChange={(e) => setGuildId(e.target.value)}
                      placeholder={t('guild.placeholder')}
                      className="font-mono"
                      maxLength={20}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('wizard.copyServerIdInstruction')}
                    </p>
                    {hasGuildIdError && (
                      <p className="text-xs text-destructive">
                        {t('errors.invalidGuildId')}
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
                        {t('wizard.notificationChannelId')}
                        <Badge variant="outline" className="text-xs">
                          {t('wizard.recommended')}
                        </Badge>
                      </Label>
                      <Input
                        id="setup-channelId"
                        value={channelId}
                        onChange={(e) => setChannelId(e.target.value)}
                        placeholder={t('guild.placeholder')}
                        className="font-mono"
                        maxLength={20}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t('wizard.copyChannelIdInstruction')}
                      </p>
                      {hasChannelIdError && (
                        <p className="text-xs text-destructive">
                          {t('errors.invalidChannelId')}
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
                        {t('wizard.adminRoleId')}
                        <Badge variant="outline" className="text-xs">
                          {t('wizard.optional')}
                        </Badge>
                      </Label>
                      <Input
                        id="setup-adminRole"
                        value={adminRoleId}
                        onChange={(e) => setAdminRoleId(e.target.value)}
                        placeholder={t('guild.placeholder')}
                        className="font-mono"
                        maxLength={20}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t('wizard.copyRoleIdInstruction')}
                      </p>
                      {hasAdminRoleIdError && (
                        <p className="text-xs text-destructive">
                          {t('errors.invalidAdminRoleId')}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setSetupStep(3)}>
                    <ChevronLeft className="w-4 h-4 mr-1" /> {t('wizard.back')}
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
                    {t('wizard.nextLaunch')} <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              </div>
            )}

            {/* ── Step 5: Launch ── */}
            {setupStep === 5 && (
              <div className="space-y-6">
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Play className="w-5 h-5 text-primary" />
                    {t('wizard.readyToLaunchTitle')}
                  </h3>
                  <p className="text-muted-foreground">
                    {t('wizard.readyToLaunchDescription')}
                  </p>
                </div>

                {/* Review */}
                <div className="space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-1 rounded-lg border border-border/60 bg-muted/30 p-3">
                      <p className="text-xs text-muted-foreground">{t('botToken')}</p>
                      <p className="break-all font-mono text-sm">
                        {token
                          ? "••••••••" + token.slice(-4)
                          : t('wizard.notSetWillFail')}
                      </p>
                    </div>
                    <div className="space-y-1 rounded-lg border border-border/60 bg-muted/30 p-3">
                      <p className="text-xs text-muted-foreground">{t('guildId')}</p>
                      <p className="break-all font-mono text-sm">
                        {guildId || t('wizard.notSetRequired')}
                      </p>
                    </div>
                    <div className="space-y-1 rounded-lg border border-border/60 bg-muted/30 p-3">
                      <p className="text-xs text-muted-foreground">
                        {t('wizard.channelId')}
                      </p>
                      <p className="break-all font-mono text-sm">
                        {channelId || t('wizard.none')}
                      </p>
                    </div>
                    <div className="space-y-1 rounded-lg border border-border/60 bg-muted/30 p-3">
                      <p className="text-xs text-muted-foreground">
                        {t('wizard.adminRoleId')}
                      </p>
                      <p className="break-all font-mono text-sm">
                        {adminRoleId || t('wizard.noneAllUsers')}
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
                          {t('wizard.tokenVerified')}
                        </span>{" "}
                        — {botInfo.username}
                      </p>
                    </Alert>
                  )}
                </div>

                {/* Auto-Start */}
                <div className="flex items-center justify-between p-4 rounded-lg border">
                  <div>
                    <Label className="font-medium">{t('autostartBot')}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t('wizard.autoStartDescription')}
                    </p>
                  </div>
                  <Switch checked={autoStart} onCheckedChange={setAutoStart} />
                </div>

                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setSetupStep(4)}>
                    <ChevronLeft className="w-4 h-4 mr-1" /> {t('wizard.back')}
                  </Button>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={() => handleSaveConfig(false)}
                      disabled={saving || !canSaveConfig}
                    >
                      {saving ? (
                        <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Settings className="w-4 h-4 mr-2" />
                      )}
                      {t('wizard.saveDraft')}
                    </Button>
                    <Button
                      onClick={() => handleSaveConfig(true)}
                      disabled={saving || !canSaveConfig}
                    >
                      {saving ? (
                        <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Play className="w-4 h-4 mr-2" />
                      )}
                      {t('wizard.saveAndStart')}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* What you get */}
        <Card>
          <CardHeader>
            <CardTitle>{t('wizard.whatBotDoesTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border/60 text-sm">
              <div className="flex gap-3 py-3 first:pt-0">
                <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div className="space-y-1">
                  <p className="font-medium">{t('slashCommands')}</p>
                  <p className="text-muted-foreground">
                    {t('wizard.slashCommandsDescription')}
                  </p>
                </div>
              </div>
              <div className="flex gap-3 py-3">
                <MessagesSquare className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div className="space-y-1">
                  <p className="font-medium">{t('twowayChatBridge')}</p>
                  <p className="text-muted-foreground">
                    {t('wizard.chatBridgeDescription')}
                  </p>
                </div>
              </div>
              <div className="flex gap-3 py-3 last:pb-0">
                <Bell className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div className="space-y-1">
                  <p className="font-medium">{t('eventNotifications')}</p>
                  <p className="text-muted-foreground">
                    {t('wizard.eventNotificationsDescription')}
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ═════════════════════════════════════════════════
  // MANAGEMENT VIEW — shown when bot is configured
  // ═════════════════════════════════════════════════
  return (
    <div className="space-y-6 page-transition">
      {/* Header */}
      <PageHeader
        title={t("bot.title")}
        description={t("bot.description")}
        icon={<MessageSquare className="w-5 h-5" />}
        actions={
          <div className="flex items-center gap-2">
            <div
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide ${
                status?.running
                  ? "border-primary/40 bg-primary/[0.08] text-primary"
                  : "border-border/55 bg-muted/40 text-muted-foreground"
              }`}
            >
              {status?.running ? (
                <span
                  className="relative inline-flex w-2 h-2"
                  aria-hidden="true"
                >
                  <span className="absolute inset-0 rounded-full bg-primary/40 animate-ping motion-reduce:hidden" />
                  <span className="relative w-2 h-2 rounded-full bg-primary" />
                </span>
              ) : (
                <span
                  className="w-2 h-2 rounded-full border border-muted-foreground/50"
                  aria-hidden="true"
                />
              )}
              {status?.running ? t('status.running') : t('status.stopped')}
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={loadData}
              aria-label={t('status.refresh')}
              className="h-10 w-10"
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>
        }
      />

      {/* Status Message */}
      <InlineFeedback message={configMessage} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Bot Status */}
        <Card className="relative overflow-hidden">
          <div
            className={`absolute top-0 left-0 right-0 h-[2px] ${
              status?.running
                ? "bg-gradient-to-r from-primary via-primary/80 to-primary/30"
                : status?.error
                  ? "bg-gradient-to-r from-destructive via-destructive/80 to-destructive/30"
                  : "bg-gradient-to-r from-muted-foreground/40 via-muted-foreground/20 to-transparent"
            }`}
            aria-hidden="true"
          />
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="w-5 h-5" />
              {t('management.botStatus')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div
                className={`rounded-lg border px-4 py-3 ${status?.running ? "border-primary/30 bg-primary/5" : "border-border/60 bg-muted/40"}`}
              >
                <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  {t('management.runtime')}
                </p>
                <p
                  className={`mt-1 flex items-center gap-2 text-lg font-semibold ${status?.running ? "text-primary" : ""}`}
                >
                  {status?.running && (
                    <span
                      className="relative inline-flex w-2 h-2"
                      aria-hidden="true"
                    >
                      <span className="absolute inset-0 rounded-full bg-primary/40 animate-ping motion-reduce:hidden" />
                      <span className="relative w-2 h-2 rounded-full bg-primary" />
                    </span>
                  )}
                  {status?.running ? t('status.online') : t('status.offline')}
                </p>
              </div>
              <div className="min-w-0 rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  {t('management.botUser')}
                </p>
                <p className="mt-1 truncate text-lg font-semibold">
                  {status?.username || t('management.waitingForLogin')}
                </p>
              </div>
              <div
                className={`min-w-0 rounded-lg border px-4 py-3 ${config?.channelId ? "border-border/60 bg-muted/30" : "border-warning/30 bg-warning/[0.06]"}`}
              >
                <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  {t('management.channel')}
                </p>
                <p
                  className={`mt-1 truncate text-lg font-semibold ${config?.channelId ? "" : "text-warning"}`}
                >
                  {config?.channelId ? t('management.linked') : t('management.notSet')}
                </p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              {t('management.statusDescription')}
            </p>

            {status?.error && (
              <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
                <p className="text-sm text-destructive font-medium">
                  {t('management.botError')}
                </p>
                <p className="text-sm text-destructive/80">{status.error}</p>
              </div>
            )}

            <div className="flex gap-2">
              {status?.running ? (
                <Button
                  variant="destructive"
                  onClick={handleStop}
                  className="flex-1"
                  disabled={stopping}
                >
                  {stopping ? (
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Square className="w-4 h-4 mr-2" />
                  )}
                  {stopping ? t('management.stopping') : t('management.stopBot')}
                </Button>
              ) : (
                <Button
                  onClick={handleStart}
                  className="flex-1"
                  disabled={starting}
                >
                  {starting ? (
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4 mr-2" />
                  )}
                  {starting ? t('management.starting') : t('management.startBot')}
                </Button>
              )}

              {status?.running && config?.channelId && (
                <Button
                  variant="outline"
                  onClick={handleSendTestMessage}
                  disabled={sendingTest}
                >
                  {sendingTest ? (
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4 mr-2" />
                  )}
                  {sendingTest ? t('management.sending') : t('management.sendTest')}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Command Permissions */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5" />
              {t('management.commandPermissions')}
            </CardTitle>
            <CardDescription>
              {t('management.commandPermissionsDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Tier legend */}
            <div className="flex flex-wrap gap-3 text-sm mb-2">
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-primary" />
                <span className="font-medium">{t('everyone')}</span>
                <span className="text-muted-foreground">{t('management.anyUser')}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-muted-foreground" />
                <span className="font-medium">{t('moderator')}</span>
                <span className="text-muted-foreground">
                  {t('management.modOrAdminRole')}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-destructive" />
                <span className="font-medium">{t('admin')}</span>
                <span className="text-muted-foreground">{t('management.adminRoleOnly')}</span>
              </div>
            </div>

            <div className="space-y-1.5">
              {[
                { cmd: "status", label: "/status", descKey: "commands.status" },
                {
                  cmd: "players",
                  label: "/players",
                  descKey: "commands.players",
                },
                { cmd: "save", label: "/save", descKey: "commands.save" },
                {
                  cmd: "broadcast",
                  label: "/broadcast",
                  descKey: "commands.broadcast",
                },
                { cmd: "kick", label: "/kick", descKey: "commands.kick" },
                { cmd: "start", label: "/start", descKey: "commands.start" },
                { cmd: "stop", label: "/stop", descKey: "commands.stop" },
                {
                  cmd: "restart",
                  label: "/restart",
                  descKey: "commands.restart",
                },
                { cmd: "rcon", label: "/rcon", descKey: "commands.rcon" },
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
                        {t(c.descKey)}
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
                          return (
                            <Button
                              key={tier}
                              variant={variant}
                              size="sm"
                              className="h-7 gap-1 px-2 text-xs"
                              onClick={() =>
                                setCommandPermissions((prev) => ({
                                  ...prev,
                                  [c.cmd]: tier,
                                }))
                              }
                            >
                              {icons[tier]}
                              <span className="hidden sm:inline capitalize">
                                {t(`tiers.${tier}`)}
                              </span>
                            </Button>
                          );
                        },
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end pt-2">
              <Button
                onClick={async () => {
                  try {
                    setSavingPermissions(true);
                    await discordApi.updatePermissions(commandPermissions);
                    setPermissionsMessage({
                      type: "success",
                      text: t('messages.permissionsSaved'),
                    });
                  } catch (error: unknown) {
                    const msg =
                      error instanceof Error
                        ? error.message
                        : t('messages.permissionsSaveFailed');
                    setPermissionsMessage({ type: "error", text: msg });
                  } finally {
                    setSavingPermissions(false);
                  }
                }}
                disabled={savingPermissions}
              >
                {savingPermissions ? (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />{" "}
                    {t('management.saving')}
                  </>
                ) : (
                  t('management.savePermissions')
                )}
              </Button>
            </div>
            <InlineFeedback message={permissionsMessage} className="mt-3" />
          </CardContent>
        </Card>
      </div>

      {/* Configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="w-5 h-5" />
            {t('management.botConfiguration')}
          </CardTitle>
          <CardDescription>{t('updateBotCredentialsAndSettings')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Bot Token */}
          <div className="space-y-2">
            <Label htmlFor="token" className="flex items-center gap-2">
              <Bot className="w-4 h-4" />
              {t('token.label')}
              {config?.hasToken && (
                <Badge variant="outline" className="text-xs">
                  <CheckCircle2 className="w-3 h-3 mr-1" /> {t('management.configured')}
                </Badge>
              )}
            </Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
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
                      ? t('token.keepCurrentPlaceholder')
                      : t('token.enterPlaceholder')
                  }
                  className="pr-10"
                  maxLength={200}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full"
                  onClick={() => setShowToken(!showToken)}
                  aria-label={showToken ? t('token.hide') : t('token.show')}
                >
                  {showToken ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </Button>
              </div>
              <Button
                variant="outline"
                onClick={handleTestToken}
                disabled={testing || !token}
              >
                {testing ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <Zap className="w-4 h-4 mr-1.5" /> {t('token.verify')}
                  </>
                )}
              </Button>
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
                <CheckCircle2 className="w-3.5 h-3.5" /> {t('token.valid', { username: botInfo.username })}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Guild ID */}
            <div className="space-y-2">
              <Label htmlFor="guildId" className="flex items-center gap-2">
                <Server className="w-4 h-4" />
                {t('guild.serverIdRequired')}
              </Label>
              <Input
                id="guildId"
                value={guildId}
                onChange={(e) => setGuildId(e.target.value)}
                placeholder={t('guild.placeholder')}
                className="font-mono"
                maxLength={20}
              />
              <p className="text-xs text-muted-foreground">
                {t('guild.copyServerIdHint')}
              </p>
              {hasGuildIdError && (
                <p className="text-xs text-destructive">
                  {t('errors.invalidGuildId')}
                </p>
              )}
            </div>

            {/* Channel ID */}
            <div className="space-y-2">
              <Label htmlFor="channelId" className="flex items-center gap-2">
                <Hash className="w-4 h-4" />
                {t('channels.notificationChatLabel')}
              </Label>
              <Input
                id="channelId"
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
                placeholder={t('channels.mainChannel')}
                className="font-mono"
                maxLength={20}
              />
              <p className="text-xs text-muted-foreground">
                {t('channels.notificationChatHint')}
              </p>
              {hasChannelIdError && (
                <p className="text-xs text-destructive">
                  {t('errors.invalidChannelId')}
                </p>
              )}
            </div>

            {/* Admin Role ID */}
            <div className="space-y-2">
              <Label htmlFor="adminRoleId" className="flex items-center gap-2">
                <Lock className="w-4 h-4 text-primary" />
                {t('guild.adminRoleLabel')}
              </Label>
              <Input
                id="adminRoleId"
                value={adminRoleId}
                onChange={(e) => setAdminRoleId(e.target.value)}
                placeholder={t('channels.mainChannel')}
                className="font-mono"
                maxLength={20}
              />
              <p className="text-xs text-muted-foreground">
                {t('guild.adminRoleHint')}
              </p>
              {hasAdminRoleIdError && (
                <p className="text-xs text-destructive">
                  {t('errors.invalidAdminRoleId')}
                </p>
              )}
            </div>

            {/* Moderator Role ID */}
            <div className="space-y-2">
              <Label htmlFor="modRoleId" className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-primary" />
                {t('guild.moderatorRoleLabel')}
              </Label>
              <Input
                id="modRoleId"
                value={modRoleId}
                onChange={(e) => setModRoleId(e.target.value)}
                placeholder={t('channels.mainChannel')}
                className="font-mono"
                maxLength={20}
              />
              <p className="text-xs text-muted-foreground">
                {t('guild.moderatorRoleHint')}
              </p>
              {hasModRoleIdError && (
                <p className="text-xs text-destructive">
                  {t('errors.invalidModeratorRoleId')}
                </p>
              )}
            </div>
          </div>

          {/* Auto-Start */}
          <div className="flex items-center justify-between p-4 rounded-lg border">
            <div>
              <Label className="font-medium">{t('autostartOnPanelLaunch')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('management.autoStartDescription')}
              </p>
            </div>
            <Switch checked={autoStart} onCheckedChange={setAutoStart} />
          </div>

          {/* Chat Relay */}
          <div className="space-y-4 p-4 rounded-lg border">
            <div className="flex items-center justify-between">
              <div>
                <Label className="font-medium">{t('ingameChatRelay')}</Label>
                <p className="text-sm text-muted-foreground">
                  {t('management.chatRelayDescription')}
                </p>
              </div>
              <Switch
                checked={chatRelayEnabled}
                onCheckedChange={setChatRelayEnabled}
              />
            </div>
            {chatRelayEnabled && (
              <div className="space-y-2">
                <Label htmlFor="chatRelayChannelId" className="text-sm">
                  {t('channels.chatRelayLabel')}
                </Label>
                <Input
                  id="chatRelayChannelId"
                  value={chatRelayChannelId}
                  onChange={(e) => setChatRelayChannelId(e.target.value)}
                  placeholder={t('channels.mainChannel')}
                  className="font-mono"
                  maxLength={20}
                />
                <p className="text-xs text-muted-foreground">
                  {t('channels.chatRelayHint')}
                </p>
                {hasChatRelayChannelIdError && (
                  <p className="text-xs text-destructive">
                    {t('errors.invalidChatRelayChannelId')}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="rounded-lg border border-destructive/25 bg-destructive/[0.05] px-4 py-3 text-sm text-muted-foreground">
              {t('reset.managementHint')}
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="destructive"
                onClick={handleResetConfig}
                disabled={resetting}
              >
                {resetting ? (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />{" "}
                    {t('reset.wiping')}
                  </>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4 mr-2" /> {t('reset.button')}
                  </>
                )}
              </Button>
              <Button variant="outline" onClick={loadData}>
                {t('actions.cancel')}
              </Button>
              <Button
                onClick={() => handleSaveConfig(false)}
                disabled={saving || !canSaveConfig}
              >
                {saving ? (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />{" "}
                    {t('management.saving')}
                  </>
                ) : (
                  t('management.saveChanges')
                )}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Webhook Events */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="w-5 h-5" />
            {t('events.title')}
          </CardTitle>
          <CardDescription>
            {t('events.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {Object.entries(eventLabels).map(
            ([eventKey, { labelKey, descriptionKey, variables }]) => {
              const event = webhookEvents[eventKey] || {
                enabled: false,
                template: "",
              };
              return (
                <div key={eventKey} className="space-y-3 p-4 border rounded-lg">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-base font-medium">{t(labelKey)}</Label>
                      <p className="text-sm text-muted-foreground">
                        {t(descriptionKey)}
                      </p>
                    </div>
                    <Switch
                      checked={event.enabled}
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
                        {t('events.messageTemplate')}
                      </Label>
                      <Textarea
                        id={`template-${eventKey}`}
                        value={event.template}
                        onChange={(e) =>
                          handleUpdateTemplate(eventKey, e.target.value)
                        }
                        placeholder={t('notifications.placeholder')}
                        rows={3}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t('events.availableVariables', { variables: variables === 'events.noneVariables' ? t(variables) : variables })}
                      </p>
                    </div>
                  )}
                </div>
              );
            },
          )}
          <div className="flex justify-end">
            <Button onClick={handleSaveWebhookEvents} disabled={savingEvents}>
              {savingEvents ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> {t('management.saving')}
                </>
              ) : (
                t('events.save')
              )}
            </Button>
          </div>
          <InlineFeedback message={eventsMessage} className="mt-3" />
        </CardContent>
      </Card>
    </div>
  );
}

import { useTranslation } from 'react-i18next';
import { useEffect, useState, useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { usePageShortcut } from "../hooks/useKeyboardShortcuts";
import {
  Save,
  Server,
  Link,
  Clock,
  Shield,
  AlertTriangle,
  Eye,
  EyeOff,
  Loader2,
  Key,
  Cloud,
  Library,
  Zap,
  CheckCircle2,
  XCircle,
  Download,
  RefreshCw,
  Archive,
  Info,
  Trash2,
  HardDrive,
  RotateCcw,
  Settings2,
  Globe,
  RotateCw,
  Lock,
  User,
  ExternalLink,
  FolderOpen,
  Palette,
  Check,
  Heart,
  Coffee,
  MessageCircle,
  Plus,
  Minus,
  Search,
  Bookmark,
  BookmarkPlus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { reportClientError } from "@/lib/client-errors";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/components/ui/use-toast";
import { EmptyState } from "@/components/EmptyState";
import {
  configApi,
  panelBridgeApi,
  backupApi,
  authApi,
  serversApi,
  serverApi,
  panelUpdateApi,
  modsApi,
  BackupStatus,
  BackupFile,
  PanelUpdateStatus,
  PanelUpdatePreflight,
  ServerInstance,
} from "@/lib/api";
import { getAccessToken } from "@/lib/authToken";
import { useSocket } from "@/contexts/SocketContext";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme, type ThemeName } from "@/contexts/ThemeContext";
import { BridgeStatusBadge } from "@/components/BridgeStatusBadge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface AppSettings {
  // Bridge Settings
  panelBridgeAutoUpdate: boolean;
  panelBridgeSftpEnabled: boolean;
  panelBridgeSftpHost: string;
  panelBridgeSftpPort: string;
  panelBridgeSftpUsername: string;
  panelBridgeSftpPassword: string;
  panelBridgeSftpBridgePath: string;
  panelBridgeSftpPollIntervalSeconds: string;
  panelBridgeSftpLogPath: string;

  // Server automation settings
  autoStartServer: boolean;
  autoExportOnLogin: boolean;
  autoExportMaxPerPlayer: string;
  serverAutoUpdate: boolean;
  serverAutoUpdateWarningMinutes: string;

  // Mod Checker Settings
  modCheckInterval: string;
  modAutoRestart: boolean;
  modRestartDelay: string;
  steamUpdateAccount: string;

  // API Keys
  steamApiKey: string;

  // Workshop Collection Sync
  workshopCollectionId: string;
  workshopCollectionAutoSync: boolean;
  steamSessionId: string;
  steamLoginSecure: string;

  // General Settings
  darkMode: boolean;
  autoReconnect: boolean;
  reconnectInterval: string;

  // Panel Settings
  panelPort: string;

  // HTTPS Settings
  httpsEnabled: boolean;
  httpsPort: string;
  httpsKeyPath: string;
  httpsCertPath: string;

  // CORS Settings
  corsAllowedOrigins: string;
  corsAllowAll: boolean;
  corsAllowPrivateNetworks: boolean;
  corsDebug: boolean;

  // Privacy
  enablePublicIpLookup: boolean;

  // Which detected network interface's IPv4 the dashboard displays.
  // Empty string = auto-detect (first non-internal interface found).
  lanIpAddress: string;
}

interface CorsDiagnostics {
  allowAll: boolean;
  allowPrivateNetworks: boolean;
  debug: boolean;
  customOrigins: string[];
  effectiveAllowedOrigins: string[];
  blocked: Array<{
    id: number;
    origin: string;
    source: string;
    blockedAt: string;
  }>;
  blockedCount: number;
  lastLoadedAt: string | null;
}

const MAX_CORS_ALLOWED_ORIGINS = 100;
const MAX_CORS_ORIGIN_LENGTH = 256;

function toSettingBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

// Human-friendly age string for bridge diagnostics. Avoids showing the user
// raw seconds counts like "3344627s" which read as gibberish.
function formatBridgeAge(seconds: number, unknownLabel = "unknown"): string {
  if (!Number.isFinite(seconds) || seconds < 0) return unknownLabel;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

function ThemeSelect() {
  const { t } = useTranslation('settings');
  const { theme, setTheme } = useTheme();
  return (
    <Select value={theme} onValueChange={(v) => setTheme(v as ThemeName)}>
      <SelectTrigger className="w-[160px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="survival">{t('survivalDark')}</SelectItem>
        <SelectItem value="light">{t('light')}</SelectItem>
      </SelectContent>
    </Select>
  );
}

export default function Settings() {
  const { t } = useTranslation('settings');
  const socket = useSocket();
  const [settings, setSettings] = useState<AppSettings>({
    panelBridgeAutoUpdate: true,
    panelBridgeSftpEnabled: false,
    panelBridgeSftpHost: "",
    panelBridgeSftpPort: "22",
    panelBridgeSftpUsername: "",
    panelBridgeSftpPassword: "",
    panelBridgeSftpBridgePath: "",
    panelBridgeSftpPollIntervalSeconds: "3",
    panelBridgeSftpLogPath: "",
    autoStartServer: false,
    autoExportOnLogin: false,
    autoExportMaxPerPlayer: "3",
    serverAutoUpdate: false,
    serverAutoUpdateWarningMinutes: "15",
    modCheckInterval: "5",
    modAutoRestart: true,
    modRestartDelay: "5",
    steamUpdateAccount: "",
    steamApiKey: "",
    workshopCollectionId: "",
    workshopCollectionAutoSync: false,
    steamSessionId: "",
    steamLoginSecure: "",
    darkMode: true,
    autoReconnect: true,
    reconnectInterval: "5",
    panelPort: "3001",
    httpsEnabled: false,
    httpsPort: "3443",
    httpsKeyPath: "",
    httpsCertPath: "",
    corsAllowedOrigins: "",
    corsAllowAll: false,
    corsAllowPrivateNetworks: true,
    corsDebug: false,
    enablePublicIpLookup: false,
    lanIpAddress: "",
  });
  const [originalSettings, setOriginalSettings] = useState<AppSettings | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [showSteamApiKey, setShowSteamApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [corsOriginValidationError, setCorsOriginValidationError] = useState<
    string | null
  >(null);
  const [corsDiagnostics, setCorsDiagnostics] =
    useState<CorsDiagnostics | null>(null);
  const [corsLoading, setCorsLoading] = useState(false);
  const [corsUpdating, setCorsUpdating] = useState(false);
  const [testingRcon, setTestingRcon] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [panelUpdateStatus, setPanelUpdateStatus] =
    useState<PanelUpdateStatus | null>(null);
  const [panelUpdateStatusError, setPanelUpdateStatusError] = useState<
    string | null
  >(null);
  const [checkingPanelUpdate, setCheckingPanelUpdate] = useState(false);
  const [downloadingPanelUpdate, setDownloadingPanelUpdate] = useState(false);
  const [dockerUpdateConfirmOpen, setDockerUpdateConfirmOpen] = useState(false);
  const [panelUpdateReady, setPanelUpdateReady] = useState(false);
  const [panelUpdatePreflight, setPanelUpdatePreflight] =
    useState<PanelUpdatePreflight | null>(null);
  const [panelApplyLog, setPanelApplyLog] = useState<string | null>(null);
  const [panelApplyResultDismissed, setPanelApplyResultDismissed] =
    useState(false);
  const { toast } = useToast();
  const { user, authEnabled, logout } = useAuth();

  // Change password state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [localPasswordResetSupported, setLocalPasswordResetSupported] =
    useState(false);
  const [showLocalPasswordReset, setShowLocalPasswordReset] = useState(false);
  const [localPasswordResetToken, setLocalPasswordResetToken] = useState("");
  const [localPasswordResetPassword, setLocalPasswordResetPassword] =
    useState("");
  const [localPasswordResetConfirm, setLocalPasswordResetConfirm] =
    useState("");
  const [preparingLocalPasswordReset, setPreparingLocalPasswordReset] =
    useState(false);
  const [resettingLocalPassword, setResettingLocalPassword] = useState(false);
  const [showLocalResetPassword, setShowLocalResetPassword] = useState(false);
  const [recoveryCodeStatus, setRecoveryCodeStatus] = useState<{
    configured: boolean;
    remaining: number;
    total: number;
  } | null>(null);
  const [generatedRecoveryCodes, setGeneratedRecoveryCodes] = useState<string[]>([]);
  const [generatingRecoveryCodes, setGeneratingRecoveryCodes] = useState(false);

  // Panel Bridge state
  const [bridgeStatus, setBridgeStatus] = useState<{
    configured: boolean;
    bridgePath: string | null;
    isRunning: boolean;
    pendingCommands: number;
    modConnected: boolean;
    consecutiveFailures?: number;
    hasFileWatcher?: boolean;
    transport?: {
      type: "local" | "sftp";
      running: boolean;
      lastLatencyMs?: number | null;
      lastError?: string | null;
    };
    config?: {
      statusStaleMs: number;
      pollIntervalMs: number;
      statusCheckMs: number;
    };
    connection?: {
      healthy: boolean;
      canSendCommands: boolean;
      summary: string;
      issues: string[];
      checks: Record<string, boolean | number | null>;
    };
    statusFile?: {
      exists: boolean;
      path?: string;
      size?: number;
      modified?: string;
      age?: number;
      ageSeconds?: number;
      error?: string;
    };
    modStatus: {
      alive: boolean;
      version: string;
      serverName: string;
      playerCount?: number;
      players: string[];
      path: string;
      timestamp: number;
      age?: number;
      error?: string;
    } | null;
    detectedPaths?: {
      serverName: string;
      installPath: string;
      zomboidDataPath: string;
    } | null;
  } | null>(null);
  const [bridgeLoading, setBridgeLoading] = useState(false);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [pinging, setPinging] = useState(false);
  const [manualBridgePath, setManualBridgePath] = useState("");
  const [testingSftp, setTestingSftp] = useState(false);
  const [remoteLogs, setRemoteLogs] = useState<
    Array<{ name: string; size: number; modifiedAt: string | null }>
  >([]);
  const [remoteLogContent, setRemoteLogContent] = useState<{
    name: string;
    content: string;
    truncated: boolean;
    bytesReturned: number;
  } | null>(null);
  const [loadingRemoteLogs, setLoadingRemoteLogs] = useState(false);
  const [remoteLogError, setRemoteLogError] = useState<string | null>(null);

  // Server list for install dropdown
  const [servers, setServers] = useState<ServerInstance[]>([]);
  const [selectedInstallServerId, setSelectedInstallServerId] =
    useState<string>("");
  const [installingMod, setInstallingMod] = useState(false);

  // Backup state
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [backups, setBackups] = useState<BackupFile[]>([]);
  const [backupLoading, setBackupLoading] = useState(false);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null);
  const [restoreConfirmBackup, setRestoreConfirmBackup] = useState<
    string | null
  >(null);
  const [backupSchedule, setBackupSchedule] = useState("0 */6 * * *");
  const [backupMaxCount, setBackupMaxCount] = useState(10);

  // Track if there are unsaved changes
  const isDirty =
    originalSettings !== null &&
    JSON.stringify(settings) !== JSON.stringify(originalSettings);

  // Section navigation via tabs
  const settingsSections = [
    {
      id: "panel",
      label: t('sections.panel.label'),
      icon: Globe,
      group: "core",
      tip: t('sections.panel.tip'),
      description:
        t('sections.panel.description'),
    },
    {
      id: "https",
      label: t('sections.https.label'),
      icon: Lock,
      group: "core",
      tip: t('sections.https.tip'),
      description:
        t('sections.https.description'),
    },
    {
      id: "rcon",
      label: t('sections.rcon.label'),
      icon: Link,
      group: "connections",
      tip: t('sections.rcon.tip'),
      description:
        t('sections.rcon.description'),
    },
    {
      id: "bridge",
      label: t('sections.bridge.label'),
      icon: Zap,
      group: "connections",
      tip: t('sections.bridge.tip'),
      description:
        t('sections.bridge.description'),
    },
    {
      id: "mods",
      label: t('sections.mods.label'),
      icon: Clock,
      group: "features",
      tip: t('sections.mods.tip'),
      description:
        t('sections.mods.description'),
    },
    {
      id: "api-keys",
      label: t('sections.apiKeys.label'),
      icon: Key,
      group: "features",
      tip: t('sections.apiKeys.tip'),
      description:
        t('sections.apiKeys.description'),
    },
    {
      id: "backups",
      label: t('sections.backups.label'),
      icon: Archive,
      group: "features",
      tip: t('sections.backups.tip'),
      description:
        t('sections.backups.description'),
    },
    {
      id: "security",
      label: t('sections.security.label'),
      icon: Shield,
      group: "system",
      tip: t('sections.security.tip'),
      description:
        t('sections.security.description'),
    },
    {
      id: "about",
      label: t('sections.about.label'),
      icon: Server,
      group: "system",
      tip: t('sections.about.tip'),
      description: t('sections.about.description'),
    },
  ];
  const settingsGroups = settingsSections.reduce<
    { name: string; sections: typeof settingsSections }[]
  >((groups, section) => {
    const existing = groups.find((group) => group.name === section.group);
    if (existing) existing.sections.push(section);
    else groups.push({ name: section.group, sections: [section] });
    return groups;
  }, []);
  const validTabs = settingsSections.map((s) => s.id);
  const legacyTabAliases: Record<string, string> = {
    general: "panel",
    updates: "panel",
    access: "panel",
    connection: "rcon",
  };
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeSection, setActiveSection] = useState(() => {
    const tab = searchParams.get("tab");
    const resolvedTab = tab ? legacyTabAliases[tab] ?? tab : null;
    return resolvedTab && validTabs.includes(resolvedTab) ? resolvedTab : "panel";
  });

  // Sync active tab to URL
  const handleTabChange = useCallback(
    (value: string) => {
      setActiveSection(value);
      setSearchParams({ tab: value }, { replace: true });
    },
    [setSearchParams],
  );

  // Warn before leaving with unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  // Clean up restart redirect timer on unmount
  useEffect(
    () => () => {
      if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
    },
    [],
  );

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const data = await configApi.getAppSettings();
      if (data.settings) {
        // Use functional update to get current state and merge with loaded settings
        setSettings((prevSettings) => {
          const incoming = data.settings as Partial<AppSettings>;
          const loadedSettings: AppSettings = {
            ...prevSettings,
            ...incoming,
            autoStartServer: toSettingBoolean(incoming.autoStartServer, prevSettings.autoStartServer),
            autoExportOnLogin: toSettingBoolean(incoming.autoExportOnLogin, prevSettings.autoExportOnLogin),
            serverAutoUpdate: toSettingBoolean(incoming.serverAutoUpdate, prevSettings.serverAutoUpdate),
            autoExportMaxPerPlayer: String(incoming.autoExportMaxPerPlayer ?? prevSettings.autoExportMaxPerPlayer),
            serverAutoUpdateWarningMinutes: String(incoming.serverAutoUpdateWarningMinutes ?? prevSettings.serverAutoUpdateWarningMinutes),
          };
          setOriginalSettings(loadedSettings);
          return loadedSettings;
        });
      }
    } catch (error) {
      reportClientError("Failed to fetch settings.", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const fetchCorsDiagnostics = useCallback(async () => {
    setCorsLoading(true);
    try {
      const data = await configApi.getCorsDiagnostics();
      setCorsDiagnostics(data.diagnostics);
    } catch (error) {
      reportClientError("Failed to fetch CORS diagnostics.", error);
    } finally {
      setCorsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCorsDiagnostics();
  }, [fetchCorsDiagnostics]);

  const [networkInterfaces, setNetworkInterfaces] = useState<
    { name: string; address: string }[]
  >([]);
  useEffect(() => {
    serverApi
      .getNetworkInterfaces()
      .then((data) => setNetworkInterfaces(data.interfaces || []))
      .catch(() => setNetworkInterfaces([]));
  }, []);

  // Reload settings when active server changes
  useEffect(() => {
    if (!socket) return;

    const handleActiveServerChanged = () => {
      fetchSettings();
    };

    socket.on("activeServerChanged", handleActiveServerChanged);
    return () => {
      socket.off("activeServerChanged", handleActiveServerChanged);
    };
  }, [socket, fetchSettings]);

  const fetchPanelUpdateStatus = useCallback(async () => {
    try {
      const status = await panelUpdateApi.getStatus();
      setPanelUpdateStatus(status);
      setPanelUpdateStatusError(null);
      // "Ready to apply" reflects whether a binary is staged on disk, not just
      // whether the last click finished. Survives page reloads.
      if (status.stagedUpdate) {
        setPanelUpdateReady(true);
      } else if (!status.updateAvailable) {
        setPanelUpdateReady(false);
      }
      // If a previous apply failed, surface the helper log right away so the
      // user can see what happened without clicking anything.
      if (status.lastApplyResult?.status === "failed") {
        if (status.lastApplyResult.helperLog) {
          setPanelApplyLog(status.lastApplyResult.helperLog);
        } else {
          try {
            const { log: helperLog } = await panelUpdateApi.getApplyLog();
            setPanelApplyLog(helperLog);
          } catch {
            setPanelApplyLog(null);
          }
        }
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t('ui.couldNotLoadUpdaterStatus');
      setPanelUpdateStatusError(message);
      reportClientError("Failed to fetch panel update status.", error);
    }
  }, [t]);

  const fetchPanelUpdatePreflight = useCallback(async () => {
    try {
      const pre = await panelUpdateApi.preflight();
      setPanelUpdatePreflight(pre);
      return pre;
    } catch (error) {
      reportClientError("Failed to fetch panel update preflight.", error);
      return null;
    }
  }, []);

  useEffect(() => {
    fetchPanelUpdateStatus();
  }, [fetchPanelUpdateStatus]);

  const hasActionablePanelUpdate = Boolean(
    panelUpdateStatus?.updateAvailable || panelUpdateStatus?.stagedUpdate,
  );
  const isDockerPanelUpdate = panelUpdateStatus?.updateMode === "docker";
  const stagedPanelUpdatePath = panelUpdateStatus?.stagedUpdate?.path;

  // Run preflight once status tells us we're in a packaged build and there is
  // anything actionable (either an available update or a staged file on disk).
  useEffect(() => {
    if (!hasActionablePanelUpdate) return;
    fetchPanelUpdatePreflight();
  }, [
    hasActionablePanelUpdate,
    stagedPanelUpdatePath,
    fetchPanelUpdatePreflight,
  ]);

  const normalizePort = (value: string): string => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535) {
      return String(parsed);
    }
    return "3001";
  };

  const validateCorsOriginsInput = useCallback(
    (rawInput: string): string | null => {
      const origins = rawInput
        .split(/[\n,;]+/)
        .map((origin) => origin.trim())
        .filter(Boolean);

      if (origins.length > MAX_CORS_ALLOWED_ORIGINS) {
        return t('ui.tooManyOrigins', { max: MAX_CORS_ALLOWED_ORIGINS });
      }

      for (const origin of origins) {
        if (origin.length > MAX_CORS_ORIGIN_LENGTH) {
          return t('ui.originTooLong', {
            length: origin.length,
            max: MAX_CORS_ORIGIN_LENGTH,
          });
        }

        try {
          const parsed = new URL(origin);
          if (!["http:", "https:"].includes(parsed.protocol)) {
            return t('ui.onlyHttpOrigins', { origin });
          }
        } catch {
          return t('ui.invalidOriginFormat', { origin });
        }
      }

      return null;
    },
    [t],
  );

  useEffect(() => {
    setCorsOriginValidationError(
      validateCorsOriginsInput(settings.corsAllowedOrigins),
    );
  }, [settings.corsAllowedOrigins, validateCorsOriginsInput]);

  const fetchRecoveryCodeStatus = useCallback(async () => {
    if (!authEnabled) return;
    try {
      const status = await authApi.getRecoveryCodes();
      setRecoveryCodeStatus(status);
    } catch {
      setRecoveryCodeStatus(null);
    }
  }, [authEnabled]);

  useEffect(() => {
    void fetchRecoveryCodeStatus();
  }, [fetchRecoveryCodeStatus]);

  const handleGenerateRecoveryCodes = async () => {
    setGeneratingRecoveryCodes(true);
    try {
      const result = await authApi.generateRecoveryCodes();
      setGeneratedRecoveryCodes(result.codes || []);
      await fetchRecoveryCodeStatus();
      toast({
        title: t('latest.recoveryCodesGenerated'),
        description: t('latest.recoveryCodesSaveNow'),
        variant: "success" as const,
      });
    } catch (error) {
      toast({
        title: t('latest.recoveryCodesGenerateFailed'),
        description:
          error instanceof Error
            ? error.message
            : t('latest.tryAgain'),
        variant: "destructive",
      });
    } finally {
      setGeneratingRecoveryCodes(false);
    }
  };

  const handleSave = async () => {
    const validationError = validateCorsOriginsInput(
      settings.corsAllowedOrigins,
    );
    if (validationError) {
      setCorsOriginValidationError(validationError);
      toast({
        title: t('messages.invalidCorsOrigins'),
        description: validationError,
        variant: "destructive",
      });
      return;
    }

    setSaving(true);
    try {
      await configApi.updateAppSettings(
        settings as unknown as Record<string, unknown>,
      );
      setOriginalSettings(settings); // Reset dirty state after save
      try {
        await fetchCorsDiagnostics();
      } catch {
        // Settings are already saved; diagnostics refresh is best-effort.
      }
      toast({
        title: t('messages.settingsSavedTitle'),
        description: t('messages.settingsSaved'),
        variant: "success" as const,
      });
    } catch (error) {
      toast({
        title: t('messages.couldNotSaveSettings'),
        description:
          error instanceof Error
            ? error.message
            : t('messages.saveSettingsRetry'),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  // Ctrl+S to save settings
  usePageShortcut(
    "s",
    () => {
      if (isDirty && !saving) handleSave();
    },
    { ctrl: true },
  );

  const handleReloadCorsRules = async () => {
    setCorsUpdating(true);
    try {
      const data = await configApi.reloadCorsDiagnostics();
      setCorsDiagnostics(data.diagnostics);
      toast({
        title: t('messages.corsRulesReloaded'),
        description: t('messages.corsRulesReloadedDescription'),
        variant: "success" as const,
      });
    } catch (error) {
      toast({
        title: t('messages.couldNotReloadCorsRules'),
        description:
          error instanceof Error
            ? error.message
            : t('messages.reloadCorsRulesFailed'),
        variant: "destructive",
      });
    } finally {
      setCorsUpdating(false);
    }
  };

  const handleClearCorsBlocked = async () => {
    setCorsUpdating(true);
    try {
      const data = await configApi.clearCorsBlockedOrigins();
      setCorsDiagnostics(data.diagnostics);
      toast({
        title: t('messages.blockedOriginLogCleared'),
        description: t('messages.blockedOriginLogClearedDescription'),
        variant: "success" as const,
      });
    } catch (error) {
      toast({
        title: t('messages.couldNotClearLog'),
        description:
          error instanceof Error
            ? error.message
            : t('messages.clearBlockedLogFailed'),
        variant: "destructive",
      });
    } finally {
      setCorsUpdating(false);
    }
  };

  const restartPanelWithReconnect = useCallback(
    async (description: string) => {
      setRestarting(true);
      try {
        await serverApi.restartPanel();
        toast({
          title: t('messages.restartingPanel'),
          description,
        });

        if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
        restartTimeoutRef.current = setTimeout(() => {
          const newPort = normalizePort(settings.panelPort);
          const newUrl = `${window.location.protocol}//${window.location.hostname}:${newPort}${window.location.pathname}${window.location.search}${window.location.hash}`;
          window.location.href = newUrl;
        }, 3000);
      } catch (err) {
        setRestarting(false);
        // Apply-in-progress (409): another tab/client already triggered the
        // apply. Show a tailored message instead of the generic restart-fail.
        const apiErr = err as { code?: string; message?: string };
        if (apiErr?.code === "apply_in_progress") {
          toast({
            title: t('messages.updateAlreadyInProgress'),
            description:
              apiErr.message ||
              t('messages.updateAlreadyInProgressDescription'),
          });
          return;
        }
        toast({
          title: t('messages.restartFailed'),
          description:
            t('messages.restartFailedDescription'),
          variant: "destructive",
        });
      }
    },
    [settings.panelPort, t, toast],
  );

  const handleCheckPanelUpdate = async () => {
    setCheckingPanelUpdate(true);
    setPanelUpdateStatusError(null);
    try {
      const status = await panelUpdateApi.check();
      setPanelUpdateStatus(status);

      if (status.updateAvailable) {
        toast({
          title: t('messages.updateAvailable'),
          description: t('messages.updateAvailableDescription', { latest: status.latestVersion, current: status.currentVersion }),
        });
      } else {
        setPanelUpdateReady(false);
        toast({
          title: t('messages.upToDate'),
          description: t('messages.upToDateDescription', { current: status.currentVersion }),
          variant: "success" as const,
        });
      }
    } catch (error) {
      toast({
        title: t('messages.updateCheckFailed'),
        description:
          error instanceof Error
            ? error.message
            : t('messages.updateCheckFailedDescription'),
        variant: "destructive",
      });
    } finally {
      setCheckingPanelUpdate(false);
    }
  };

  const handleDownloadPanelUpdate = async () => {
    if (!panelUpdateStatus?.updateAvailable) {
      toast({
        title: t('messages.noUpdateAvailable'),
        description:
          t('messages.noUpdateAvailableDescription'),
      });
      return;
    }

    setDownloadingPanelUpdate(true);
    setPanelUpdateStatusError(null);
    try {
      // Pre-flight before touching disk — refuse early if we know apply will fail.
      const pre = await fetchPanelUpdatePreflight();
      if (pre && !pre.ok) {
        throw new Error(
          pre.blockers[0] || t('ui.updateBlockedFallback'),
        );
      }

      const result = await panelUpdateApi.download(isDockerPanelUpdate);
      if (!result.success) {
        if (result.preflight) setPanelUpdatePreflight(result.preflight);
        throw new Error(
          result.error || result.message || t('messages.updateDownloadFailed'),
        );
      }

      if (!isDockerPanelUpdate) setPanelUpdateReady(true);
      toast({
        title: isDockerPanelUpdate ? t('messages.dockerUpdateStarted') : t('messages.updateDownloaded'),
        description:
          result.message ||
          isDockerPanelUpdate
            ? t('messages.dockerUpdateStartedDescription')
            : t('messages.updateDownloadedDescription'),
        variant: "success" as const,
      });
      await fetchPanelUpdateStatus();
    } catch (error) {
      toast({
        title: t('messages.downloadFailed'),
        description:
          error instanceof Error
            ? error.message
            : t('messages.downloadFailedDescription'),
        variant: "destructive",
      });
    } finally {
      setDownloadingPanelUpdate(false);
    }
  };

  const formatTimestamp = (value: string | null): string => {
    if (!value) return t('ui.never');
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t('ui.unknownValue');
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  };

  useEffect(() => {
    if (!socket) return;

    const handlePanelUpdateAvailable = (data: {
      latestVersion?: string;
      currentVersion?: string;
      releaseUrl?: string;
    }) => {
      setPanelUpdateStatus((prev) => {
        const base: PanelUpdateStatus = prev || {
          currentVersion: data.currentVersion || "Unknown",
          updateAvailable: true,
          latestVersion: data.latestVersion || null,
          releaseUrl: data.releaseUrl || null,
          releaseNotes: null,
          publishedAt: null,
          isChecking: false,
          isDownloading: false,
          downloadProgress: 0,
          lastCheck: new Date().toISOString(),
          lastError: null,
          stagedUpdate: null,
          lastApplyResult: null,
        };
        return {
          ...base,
          updateAvailable: true,
          latestVersion: data.latestVersion || base.latestVersion,
          currentVersion: data.currentVersion || base.currentVersion,
          releaseUrl: data.releaseUrl || base.releaseUrl,
          lastError: null,
        };
      });
    };

    const handlePanelDownloadProgress = (data: {
      progress?: number;
      status?: string;
    }) => {
      setPanelUpdateStatus((prev) => {
        const base: PanelUpdateStatus = prev || {
          currentVersion: "Unknown",
          updateAvailable: true,
          latestVersion: null,
          releaseUrl: null,
          releaseNotes: null,
          publishedAt: null,
          isChecking: false,
          isDownloading: false,
          downloadProgress: 0,
          lastCheck: null,
          lastError: null,
          stagedUpdate: null,
          lastApplyResult: null,
        };
        const bounded = Math.max(
          0,
          Math.min(100, data.progress ?? base.downloadProgress),
        );
        return {
          ...base,
          isDownloading:
            data.status === "downloading" || data.status === "preparing",
          downloadProgress: bounded,
        };
      });
    };

    const handlePanelUpdateReady = (data: { version?: string }) => {
      setPanelUpdateReady(true);
      toast({
        title: t('messages.updateReady'),
        description: data.version
          ? t('messages.updateReadyDescription', { version: data.version })
          : t('messages.updateReadyDescriptionGeneric'),
        variant: "success" as const,
      });
      setPanelUpdateStatusError(null);
      fetchPanelUpdateStatus();
    };

    const handlePanelUpdateApplied = (data: { version?: string }) => {
      setPanelUpdateReady(false);
      setPanelApplyResultDismissed(false);
      setPanelApplyLog(null);
      toast({
        title: t('messages.updateApplied'),
        description: data.version
          ? t('messages.updateAppliedDescription', { version: data.version })
          : t('messages.updateAppliedDescriptionGeneric'),
        variant: "success" as const,
      });
      fetchPanelUpdateStatus();
    };

    const handlePanelUpdateApplyFailed = (data: {
      pendingVersion?: string;
      helperLog?: string | null;
    }) => {
      setPanelApplyResultDismissed(false);
      if (data?.helperLog) setPanelApplyLog(data.helperLog);
      toast({
        title: t('updateFailedToApply'),
        description: data?.pendingVersion
          ? t('messages.updateFailedToApplyDescription', { version: data.pendingVersion })
          : t('messages.updateFailedToApplyDescriptionGeneric'),
        variant: "destructive",
      });
      fetchPanelUpdateStatus();
    };

    socket.on("panel:updateAvailable", handlePanelUpdateAvailable);
    socket.on("panel:downloadProgress", handlePanelDownloadProgress);
    socket.on("panel:updateReady", handlePanelUpdateReady);
    socket.on("panel:updateApplied", handlePanelUpdateApplied);
    socket.on("panel:updateApplyFailed", handlePanelUpdateApplyFailed);

    return () => {
      socket.off("panel:updateAvailable", handlePanelUpdateAvailable);
      socket.off("panel:downloadProgress", handlePanelDownloadProgress);
      socket.off("panel:updateReady", handlePanelUpdateReady);
      socket.off("panel:updateApplied", handlePanelUpdateApplied);
      socket.off("panel:updateApplyFailed", handlePanelUpdateApplyFailed);
    };
  }, [socket, toast, fetchPanelUpdateStatus, t]);

  const handleTestRcon = async () => {
    setTestingRcon(true);
    try {
      await configApi.testRcon();
      toast({
        title: t('messages.rconConnected'),
        description: t('messages.rconConnectedDescription'),
        variant: "success" as const,
      });
    } catch (error) {
      toast({
        title: t('messages.rconConnectionFailed'),
        description:
          error instanceof Error
            ? error.message
            : t('messages.rconConnectionFailedDescription'),
        variant: "destructive",
      });
    } finally {
      setTestingRcon(false);
    }
  };

  // Panel Bridge functions
  const fetchBridgeStatus = useCallback(async () => {
    try {
      const status = await panelBridgeApi.getStatus();
      setBridgeStatus(status);
      setBridgeError(null);
    } catch (error) {
      reportClientError("Failed to fetch bridge status.", error);
    }
  }, []);

  // Fetch servers list for install dropdown
  const fetchServers = useCallback(async () => {
    try {
      const data = await serversApi.getAll();
      setServers(data.servers || []);
      // Auto-select active server
      const activeServer = data.servers?.find((s) => s.isActive);
      if (activeServer && !selectedInstallServerId) {
        setSelectedInstallServerId(String(activeServer.id));
      }
    } catch (error) {
      reportClientError("Failed to fetch servers.", error);
    }
  }, [selectedInstallServerId]);

  // Install PanelBridge mod to selected server
  const handleInstallMod = async () => {
    if (!selectedInstallServerId) {
      toast({
        title: t('messages.selectServer'),
        description: t('messages.selectServerDescription'),
        variant: "destructive",
      });
      return;
    }

    setInstallingMod(true);
    try {
      const result = await panelBridgeApi.installModAuto(
        selectedInstallServerId,
      );
      toast({
        title: t('messages.panelBridgeInstalled'),
        description: t('messages.panelBridgeInstalledDescription', { server: result.serverName || t('messages.selectedServer') }),
        variant: "success" as const,
      });
    } catch (error) {
      toast({
        title: t('messages.installationFailed'),
        description:
          error instanceof Error
            ? error.message
            : t('messages.installationFailedDescription'),
        variant: "destructive",
      });
    } finally {
      setInstallingMod(false);
    }
  };

  // Use ref for bridge polling interval to avoid recreation issues
  const bridgeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bridgeStatusRef = useRef(bridgeStatus);

  // Keep ref in sync with state
  useEffect(() => {
    bridgeStatusRef.current = bridgeStatus;
  }, [bridgeStatus]);

  useEffect(() => {
    fetchBridgeStatus();
    fetchServers();

    // Use recursive setTimeout for adaptive interval based on current status
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const scheduleNextFetch = () => {
      const status = bridgeStatusRef.current;
      // Poll faster when waiting for mod to connect
      const interval =
        status?.isRunning && !status?.modConnected ? 3000 : 10000;

      timeoutId = setTimeout(async () => {
        if (document.visibilityState !== "hidden") {
          await fetchBridgeStatus();
        }
        scheduleNextFetch();
      }, interval);
    };

    scheduleNextFetch();

    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (bridgeIntervalRef.current) {
        clearInterval(bridgeIntervalRef.current);
        bridgeIntervalRef.current = null;
      }
    };
  }, [fetchBridgeStatus, fetchServers]);

  // Backup functions
  const fetchBackupStatus = useCallback(async () => {
    try {
      const status = await backupApi.getStatus();
      setBackupStatus(status);
      setBackupSchedule(status.schedule);
      setBackupMaxCount(status.maxBackups);
    } catch (error) {
      reportClientError("Failed to fetch backup status.", error);
    }
  }, []);

  const fetchBackups = useCallback(async () => {
    try {
      const data = await backupApi.listBackups();
      setBackups(data.backups || []);
    } catch (error) {
      reportClientError("Failed to fetch backups.", error);
    }
  }, []);

  useEffect(() => {
    fetchBackupStatus();
    fetchBackups();
  }, [fetchBackupStatus, fetchBackups]);

  const handleCreateBackup = async () => {
    setCreatingBackup(true);
    try {
      const result = await backupApi.createBackup();
      if (result.success && result.backup) {
        toast({
          title: t('messages.backupCreated'),
          description: t('messages.backupCreatedDescription', { name: result.backup.name, duration: result.duration?.toFixed(1) }),
          variant: "success" as const,
        });
        await fetchBackups();
        await fetchBackupStatus();
      } else {
        throw new Error(result.message || t('messages.backupCreateFailed'));
      }
    } catch (error) {
      toast({
        title: t('messages.backupFailed'),
        description:
          error instanceof Error ? error.message : t('messages.backupCreateFailed'),
        variant: "destructive",
      });
    } finally {
      setCreatingBackup(false);
    }
  };

  const handleDeleteBackup = async (name: string) => {
    try {
      const result = await backupApi.deleteBackup(name);
      if (result.success) {
        toast({
          title: t('messages.backupDeleted'),
          description: t('messages.backupDeletedDescription', { name }),
          variant: "success" as const,
        });
        await fetchBackups();
      } else {
        throw new Error(result.message || t('messages.backupDeleteFailed'));
      }
    } catch (error) {
      toast({
        title: t('messages.deleteFailed'),
        description:
          error instanceof Error ? error.message : t('messages.backupDeleteFailed'),
        variant: "destructive",
      });
    }
  };

  const handleRestoreBackup = async (name: string) => {
    setRestoringBackup(name);
    try {
      const result = await backupApi.restoreBackup(name, {
        createPreRestoreBackup: true,
      });
      if (result.success) {
        toast({
          title: t('messages.backupRestored'),
          description: t('messages.backupRestoredDescription', { name, duration: (result.duration || 0).toFixed(1) }),
          variant: "success" as const,
        });
        await fetchBackups();
      } else {
        throw new Error(result.message || t('messages.backupRestoreFailed'));
      }
    } catch (error) {
      toast({
        title: t('messages.restoreFailed'),
        description:
          error instanceof Error ? error.message : t('messages.backupRestoreFailed'),
        variant: "destructive",
      });
    } finally {
      setRestoringBackup(null);
      setRestoreConfirmBackup(null);
    }
  };

  // Basic cron validation helper
  const isValidCron = (cron: string): boolean => {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return false;

    const patterns = [
      /^(\*|\d+|\*\/\d+|\d+-\d+|\d+(,\d+)*)$/, // minute
      /^(\*|\d+|\*\/\d+|\d+-\d+|\d+(,\d+)*)$/, // hour
      /^(\*|\d+|\*\/\d+|\d+-\d+|\d+(,\d+)*)$/, // day of month
      /^(\*|\d+|\*\/\d+|\d+-\d+|\d+(,\d+)*)$/, // month
      /^(\*|\d+|\*\/\d+|\d+-\d+|\d+(,\d+)*)$/, // day of week
    ];

    return parts.every((part, i) => patterns[i].test(part));
  };

  const handleSaveBackupSettings = async () => {
    // Validate cron expression before saving
    if (!isValidCron(backupSchedule)) {
      toast({
        title: t('messages.invalidSchedule'),
        description: t('messages.invalidScheduleDescription'),
        variant: "destructive",
      });
      return;
    }

    setBackupLoading(true);
    try {
      await backupApi.updateSettings({
        enabled: backupStatus?.enabled || false,
        schedule: backupSchedule,
        maxBackups: backupMaxCount,
      });
      await fetchBackupStatus();
      toast({
        title: t('messages.backupSettingsSaved'),
        description: t('messages.backupSettingsSavedDescription'),
        variant: "success" as const,
      });
    } catch (error) {
      toast({
        title: t('messages.couldNotSaveBackupSettings'),
        description:
          error instanceof Error
            ? error.message
            : t('messages.couldNotSaveBackupSettingsDescription'),
        variant: "destructive",
      });
    } finally {
      setBackupLoading(false);
    }
  };

  const toggleBackupEnabled = async (enabled: boolean) => {
    setBackupLoading(true);
    try {
      await backupApi.updateSettings({ enabled });
      await fetchBackupStatus();
      toast({
        title: enabled
          ? t('messages.scheduledBackupsEnabled')
          : t('messages.scheduledBackupsDisabled'),
        description: enabled
          ? t('messages.scheduledBackupsEnabledDescription')
          : t('messages.scheduledBackupsDisabledDescription'),
        variant: "success" as const,
      });
    } catch (error) {
      toast({
        title: t('messages.couldNotUpdateBackups'),
        description:
          error instanceof Error
            ? error.message
            : t('messages.couldNotUpdateBackupsDescription'),
        variant: "destructive",
      });
    } finally {
      setBackupLoading(false);
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024)
      return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  };

  // Listen for real-time bridge status updates via Socket.IO
  // Use ref to avoid stale closure issues with fetchBridgeStatus
  const fetchBridgeStatusRef = useRef(fetchBridgeStatus);
  useEffect(() => {
    fetchBridgeStatusRef.current = fetchBridgeStatus;
  }, [fetchBridgeStatus]);

  useEffect(() => {
    if (!socket) return;

    const handleBridgeStatus = (data: {
      isRunning: boolean;
      bridgePath: string;
    }) => {
      setBridgeStatus((prev) =>
        prev
          ? { ...prev, isRunning: data.isRunning, bridgePath: data.bridgePath }
          : null,
      );
      // Fetch full status to get all details
      fetchBridgeStatusRef.current();
    };

    const handleModStatus = (data: {
      alive: boolean;
      version?: string;
      serverName?: string;
      playerCount?: number;
      players?: string[] | Record<string, unknown>;
      path?: string;
      timestamp?: number;
    }) => {
      setBridgeStatus((prev) => {
        if (!prev) return null;
        // Create a proper modStatus object, preserving previous values if new ones are missing
        const prevModStatus = prev.modStatus;
        const newModStatus = {
          alive: data.alive,
          version: data.version || prevModStatus?.version || "",
          serverName: data.serverName || prevModStatus?.serverName || "",
          // When alive, use playerCount (defaulting to 0); when offline, leave undefined
          playerCount: data.alive ? (data.playerCount ?? 0) : undefined,
          players: Array.isArray(data.players)
            ? data.players
            : Object.keys(data.players || {}),
          path: data.path || prevModStatus?.path || "",
          timestamp: data.timestamp || Date.now(),
        };
        return {
          ...prev,
          modConnected: data.alive,
          modStatus: newModStatus,
        };
      });
    };

    const handleBridgeConfigured = (data: { bridgePath: string }) => {
      setBridgeStatus((prev) =>
        prev
          ? { ...prev, bridgePath: data.bridgePath, configured: true }
          : null,
      );
      fetchBridgeStatusRef.current();
    };

    socket.on("panelBridge:status", handleBridgeStatus);
    socket.on("panelBridge:modStatus", handleModStatus);
    socket.on("panelBridge:configured", handleBridgeConfigured);

    return () => {
      socket.off("panelBridge:status", handleBridgeStatus);
      socket.off("panelBridge:modStatus", handleModStatus);
      socket.off("panelBridge:configured", handleBridgeConfigured);
    };
  }, [socket]); // Only depend on socket, use ref for fetchBridgeStatus

  // Auto-configure from active server settings (one-click setup)
  const handleAutoConfigure = async () => {
    setBridgeLoading(true);
    setBridgeError(null);
    try {
      const result = await panelBridgeApi.autoConfigure();
      if (result.success) {
        toast({
          title: t('messages.bridgeAutoConfigured'),
          description: t('messages.bridgeAutoConfiguredDescription', { server: result.serverName }),
          variant: "success" as const,
        });
        await fetchBridgeStatus();
      } else {
        setBridgeError(result.error || t('messages.bridgeAutoConfigureFailed'));
      }
    } catch (error) {
      setBridgeError(
        error instanceof Error ? error.message : t('messages.bridgeAutoConfigureFailed'),
      );
    } finally {
      setBridgeLoading(false);
    }
  };

  const handleStopBridge = async () => {
    setBridgeLoading(true);
    try {
      await panelBridgeApi.stop();
      toast({
        title: t('messages.bridgeStopped'),
        description: t('messages.bridgeStoppedDescription'),
        variant: "success" as const,
      });
      await fetchBridgeStatus();
    } catch (error) {
      toast({
        title: t('messages.bridgeStopFailed'),
        description:
          error instanceof Error
            ? error.message
            : t('messages.bridgeStopFailedDescription'),
        variant: "destructive",
      });
    } finally {
      setBridgeLoading(false);
    }
  };

  const handleManualConfigure = async () => {
    const trimmed = manualBridgePath.trim();
    if (!trimmed) return;
    setBridgeLoading(true);
    setBridgeError(null);
    try {
      const result = await panelBridgeApi.configureDirect(trimmed);
      if (result.success) {
        toast({
          title: t('messages.bridgeConfigured'),
          description: t('messages.bridgeConfiguredDescription', { path: result.bridgePath }),
          variant: "success" as const,
        });
        setManualBridgePath("");
        await fetchBridgeStatus();
      } else {
        setBridgeError(result.error || t('messages.bridgeConfigureFailed'));
      }
    } catch (error) {
      setBridgeError(
        error instanceof Error
          ? error.message
          : t('messages.bridgeConfigureFailedManual'),
      );
    } finally {
      setBridgeLoading(false);
    }
  };

  const sftpConfig = () => ({
    host: settings.panelBridgeSftpHost,
    port: settings.panelBridgeSftpPort,
    username: settings.panelBridgeSftpUsername,
    password: settings.panelBridgeSftpPassword,
    bridgePath: settings.panelBridgeSftpBridgePath,
    pollIntervalSeconds: settings.panelBridgeSftpPollIntervalSeconds,
  });

  const handleTestSftp = async () => {
    setTestingSftp(true);
    try {
      const result = await panelBridgeApi.testSftp(sftpConfig());
      toast({
        title: t('messages.sftpConnected'),
        description: result.statusExists
          ? t('messages.sftpConnectedWithStatus', { latency: result.latencyMs })
          : t('messages.sftpConnectedWithoutStatus', { latency: result.latencyMs }),
        variant: "success" as const,
      });
    } catch (error) {
      toast({ title: t('messages.sftpTestFailed'), description: error instanceof Error ? error.message : t('messages.sftpTestFailedDescription'), variant: "destructive" });
    } finally {
      setTestingSftp(false);
    }
  };

  const handleConfigureSftp = async () => {
    setBridgeLoading(true);
    setBridgeError(null);
    try {
      await panelBridgeApi.configureSftp(sftpConfig());
      updateSetting("panelBridgeSftpEnabled", true);
      toast({ title: t('messages.sftpBridgeStarted'), description: t('messages.sftpBridgeStartedDescription'), variant: "success" as const });
      await fetchBridgeStatus();
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : t('messages.sftpBridgeStartFailed'));
    } finally {
      setBridgeLoading(false);
    }
  };

  const handleListRemoteLogs = async () => {
    setLoadingRemoteLogs(true);
    setRemoteLogError(null);
    try {
      const result = await panelBridgeApi.listSftpLogs({
        ...sftpConfig(),
        logPath: settings.panelBridgeSftpLogPath,
      });
      setRemoteLogs(result.files || []);
      setRemoteLogContent(null);
      if (!result.files?.length) setRemoteLogError(t('latest.noRemoteLogs'));
    } catch (error) {
      setRemoteLogs([]);
      setRemoteLogError(
        error instanceof Error ? error.message : t('latest.couldNotListRemoteLogs'),
      );
    } finally {
      setLoadingRemoteLogs(false);
    }
  };

  const handleTailRemoteLog = async (name: string) => {
    setLoadingRemoteLogs(true);
    setRemoteLogError(null);
    try {
      const result = await panelBridgeApi.tailSftpLog({
        ...sftpConfig(),
        logPath: settings.panelBridgeSftpLogPath,
        name,
      });
      setRemoteLogContent({
        name: result.name,
        content: result.content,
        truncated: result.truncated,
        bytesReturned: result.bytesReturned,
      });
    } catch (error) {
      setRemoteLogContent(null);
      setRemoteLogError(
        error instanceof Error ? error.message : t('latest.couldNotReadRemoteLog'),
      );
    } finally {
      setLoadingRemoteLogs(false);
    }
  };

  const handlePingMod = async () => {
    setPinging(true);
    try {
      const result = await panelBridgeApi.ping();
      if (result.success) {
        toast({
          title: t('messages.modConnected'),
          description: t('messages.modConnectedDescription', { server: result.modStatus?.serverName || t('messages.server') }),
          variant: "success" as const,
        });
      } else {
        toast({
          title: t('messages.modDidNotRespond'),
          description:
            result.error ||
            t('messages.modDidNotRespondDescription'),
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: t('messages.pingFailed'),
        description:
          error instanceof Error
            ? error.message
            : t('messages.pingFailedDescription'),
        variant: "destructive",
      });
    } finally {
      setPinging(false);
    }
  };

  const updateSetting = <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => {
    // Validate numeric string fields
    if (
      typeof value === "string" &&
      [
        "modCheckInterval",
        "modRestartDelay",
        "reconnectInterval",
        "panelPort",
        "httpsPort",
      ].includes(key)
    ) {
      // Allow empty string but reject non-numeric values
      if (value !== "" && isNaN(parseInt(value))) {
        return; // Don't update with invalid value
      }
    }
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  // Lock-out guard: if the user disables "Allow Private/LAN Origins" while
  // "Allow All" is also off and the explicit allow-list is empty, the panel
  // will reject every browser request after the next CORS reload — including
  // theirs. Confirm before letting that through.
  const [pendingCorsLanDisable, setPendingCorsLanDisable] = useState(false);
  const handleCorsLanToggle = (value: boolean) => {
    if (
      !value &&
      !settings.corsAllowAll &&
      !settings.corsAllowedOrigins.trim()
    ) {
      setPendingCorsLanDisable(true);
      return;
    }
    updateSetting("corsAllowPrivateNetworks", value);
  };

  const selectedInstallServer =
    servers.find((server) => String(server.id) === selectedInstallServerId) ||
    null;
  const trimmedHttpsKeyPath = settings.httpsKeyPath.trim();
  const trimmedHttpsCertPath = settings.httpsCertPath.trim();
  const hasPartialHttpsCertPath =
    Boolean(trimmedHttpsKeyPath) !== Boolean(trimmedHttpsCertPath);
  const usingAutoGeneratedHttpsCert =
    settings.httpsEnabled && !trimmedHttpsKeyPath && !trimmedHttpsCertPath;
  const httpsPortPreview = normalizePort(settings.httpsPort || "3443");
  const httpPortPreview = normalizePort(settings.panelPort || "3001");
  const httpsPreviewUrl = `https://${window.location.hostname}:${httpsPortPreview}`;
  const httpPreviewUrl = `http://${window.location.hostname}:${httpPortPreview}`;

  const applyRecommendedHttpsDefaults = () => {
    updateSetting("httpsEnabled", true);
    updateSetting("httpsPort", "3443");
    updateSetting("httpsKeyPath", "");
    updateSetting("httpsCertPath", "");
  };

  // Detect path separator from install path; default to '/' (works on all platforms)
  const sep = selectedInstallServer?.installPath?.includes("\\") ? "\\" : "/";
  const selectedInstallTarget = selectedInstallServer
    ? `${selectedInstallServer.installPath}${sep}media${sep}lua${sep}server${sep}PanelBridge.lua`
    : null;

  useEffect(() => {
    let cancelled = false;

    if (!authEnabled) {
      setLocalPasswordResetSupported(false);
      setShowLocalPasswordReset(false);
      return () => {
        cancelled = true;
      };
    }

    fetch("/api/auth/reset-status")
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        setLocalPasswordResetSupported(data.localResetSupported === true);
      })
      .catch(() => {
        if (cancelled) return;
        setLocalPasswordResetSupported(false);
      });

    return () => {
      cancelled = true;
    };
  }, [authEnabled]);

  const handleChangePassword = async () => {
    if (!newPassword || !confirmPassword) return;
    if (newPassword !== confirmPassword) {
      toast({ title: t('messages.passwordsDoNotMatch'), variant: "destructive" });
      return;
    }
    if (newPassword.length < 6) {
      toast({
        title: t('messages.passwordMinLength'),
        variant: "destructive",
      });
      return;
    }
    setChangingPassword(true);
    try {
      await authApi.changePassword(currentPassword, newPassword);
      toast({
        title: t('messages.passwordChanged'),
        description: t('messages.passwordChangedDescription'),
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error) {
      toast({
        title: t('messages.changePasswordFailed'),
        description:
          error instanceof Error
            ? error.message
            : t('messages.changePasswordFailedDescription'),
        variant: "destructive",
      });
    } finally {
      setChangingPassword(false);
    }
  };

  const handlePrepareLocalPasswordReset = async () => {
    setPreparingLocalPasswordReset(true);
    try {
      const response = await fetch("/api/auth/reset-token/local", {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          data.error ||
            t('messages.recoveryPrepareFailed'),
        );
      }

      setLocalPasswordResetSupported(true);
      setShowLocalPasswordReset(true);
      setLocalPasswordResetToken("");
      toast({
        title: t('messages.recoveryReady'),
        description:
          typeof data.message === "string"
            ? data.message
            : t('messages.recoveryReadyDescription'),
      });
    } catch (error) {
      toast({
        title: t('messages.recoveryUnavailable'),
        description:
          error instanceof Error
            ? error.message
            : t('messages.recoveryPrepareFailed'),
        variant: "destructive",
      });
    } finally {
      setPreparingLocalPasswordReset(false);
    }
  };

  const handleResetLostPassword = async () => {
    if (!localPasswordResetToken) {
      toast({ title: t('messages.recoveryTokenMissing'), variant: "destructive" });
      return;
    }
    if (!localPasswordResetPassword || !localPasswordResetConfirm) return;
    if (localPasswordResetPassword !== localPasswordResetConfirm) {
      toast({ title: t('messages.passwordsDoNotMatch'), variant: "destructive" });
      return;
    }
    if (localPasswordResetPassword.length < 6) {
      toast({
        title: t('messages.passwordMinLength'),
        variant: "destructive",
      });
      return;
    }

    setResettingLocalPassword(true);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: localPasswordResetToken,
          newPassword: localPasswordResetPassword,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          data.error ||
            t('messages.passwordResetFailedDescription'),
        );
      }

      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setShowLocalPasswordReset(false);
      setLocalPasswordResetToken("");
      setLocalPasswordResetPassword("");
      setLocalPasswordResetConfirm("");
      toast({
        title: t('messages.passwordReset'),
        description: t('messages.passwordResetDescription'),
      });
      await logout();
    } catch (error) {
      toast({
        title: t('messages.passwordResetFailed'),
        description:
          error instanceof Error
            ? error.message
            : t('messages.passwordResetFailedDescription'),
        variant: "destructive",
      });
    } finally {
      setResettingLocalPassword(false);
    }
  };

  if (loading && !originalSettings) {
    return (
      <div className="flex items-center justify-center min-h-[320px] py-12">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="page-transition">
      {/* Unsaved Changes Warning */}
      {isDirty && (
        <div
          role="status"
          aria-live="polite"
          className="relative mb-5 overflow-hidden rounded-lg border border-warning/45 bg-warning/[0.08] shadow-sm"
        >
          <div
            className="absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b from-warning via-warning/80 to-warning/30"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-3 p-4 pl-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-warning/40 bg-warning/15 text-warning">
                <AlertTriangle className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className="relative inline-flex w-2 h-2"
                    aria-hidden="true"
                  >
                    <span className="absolute inset-0 rounded-full bg-warning/50 animate-ping motion-reduce:hidden" />
                    <span className="relative w-2 h-2 rounded-full bg-warning" />
                  </span>
                  <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-warning">
                    {t('ui.unsavedChanges')}
                  </p>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('ui.pendingEdits')}
                </p>
              </div>
            </div>
            <Button
              onClick={handleSave}
              disabled={saving || Boolean(corsOriginValidationError)}
              size="sm"
              variant="warning"
              className="self-start gap-2 sm:self-auto"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {t('ui.saveChanges')}
            </Button>
          </div>
        </div>
      )}

      <PageHeader
        title={t('title')}
        description={
          settingsSections.find((s) => s.id === activeSection)?.description ??
          t('ui.pageDescription')
        }
        eyebrow={t('ui.configuration')}
        tone="config"
        icon={<Settings2 className="w-5 h-5" />}
        actions={
          <Button
            variant="command"
            onClick={handleSave}
            disabled={saving || !isDirty || Boolean(corsOriginValidationError)}
            size="lg"
            className="w-full sm:w-auto gap-2"
          >
            {saving ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Save className="w-5 h-5" />
            )}
            {saving
              ? t('ui.saving')
              : isDirty
                ? t('ui.saveSettings')
                : t('ui.noUnsavedChanges')}
          </Button>
        }
      />

      <Tabs
        value={activeSection}
        onValueChange={handleTabChange}
        className="mt-6"
      >
        <TabsList
          aria-label={t('labels.settingsSections')}
          className="flex h-auto flex-wrap gap-1 bg-muted/30 border border-border/50 p-1 rounded-md w-full"
        >
          {settingsGroups.map((group) => (
            <div key={group.name} className="contents">
              <div className="basis-full px-2 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                {t(`latest.groups.${group.name}`)}
              </div>
              {group.sections.map((section) => {
                const Icon = section.icon;
                return (
                  <Tooltip key={section.id}>
                    <TooltipTrigger asChild>
                      <TabsTrigger
                        value={section.id}
                        aria-label={section.label}
                        className="settings-tab-trigger flex-1 min-w-[110px] flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium relative overflow-hidden text-muted-foreground/70 hover:text-foreground hover:bg-muted/50 data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none"
                      >
                        <Icon className="w-4 h-4 shrink-0" />
                        <span>{section.label}</span>
                      </TabsTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-[220px]">
                      <p className="text-xs">{section.tip}</p>
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          ))}
        </TabsList>

        {/* Tab Content */}
        <div className="mt-5 space-y-5">
          <TabsContent value="panel" className="mt-0">
            {/* Panel Settings */}
            <Card id="settings-panel">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-2">
                  <Globe className="w-4 h-4 text-primary" />
                  {t('ui.panelSettings')}
                </CardTitle>
                <CardDescription>
                  {t('ui.panelSettingsDescription')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="max-w-xs">
                  <Label htmlFor="panel-port">{t('panelPort')}</Label>
                  <Input
                    id="panel-port"
                    type="number"
                    value={settings.panelPort}
                    onChange={(e) => updateSetting("panelPort", e.target.value)}
                    onWheel={(e) => e.currentTarget.blur()}
                    min="1024"
                    max="65535"
                    placeholder={t('placeholders.port')}
                    inputMode="numeric"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('ui.portUsed', { port: 3001 })}
                  </p>
                </div>
                {originalSettings &&
                  settings.panelPort !== originalSettings.panelPort && (
                    <Alert className="border-warning/40 bg-warning/10">
                      <AlertTriangle className="h-4 w-4 text-warning" />
                      <AlertTitle className="text-warning">
                        {t('ui.restartRequired')}
                      </AlertTitle>
                      <AlertDescription>
                        {t('ui.portChangesRestart')}
                      </AlertDescription>
                    </Alert>
                  )}
                <div className="flex items-center gap-3">
                  <Button
                    variant="outline"
                    onClick={() =>
                      restartPanelWithReconnect(
                        t('ui.panelRestartingOnPort', { port: settings.panelPort }),
                      )
                    }
                    disabled={restarting || isDirty}
                    className="gap-2"
                  >
                    {restarting ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <RotateCw className="w-4 h-4" />
                    )}
                    {restarting ? t('ui.restarting') : t('ui.restartPanel')}
                  </Button>
                  {isDirty && (
                    <p className="text-xs text-muted-foreground">
                      {t('ui.saveBeforeRestart')}
                    </p>
                  )}
                </div>

                <div className="rounded-xl border border-border/70 bg-background/40 p-4 space-y-4">
                  <div className="space-y-1">
                    <p className="text-sm font-medium flex items-center gap-2">
                      <Palette className="w-4 h-4 text-primary" />
                      {t('ui.appearance')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('ui.appearanceDescription')}
                    </p>
                  </div>

                  <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/25 p-3">
                    <div>
                      <Label className="text-sm font-medium">{t('theme')}</Label>
                      <p className="text-xs text-muted-foreground">
                        {t('ui.themeDescription')}
                      </p>
                    </div>
                    <ThemeSelect />
                  </div>
                </div>

                <div className="rounded-xl border border-border/70 bg-background/40 p-4 space-y-4">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{t('remoteAccessCors')}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('ui.corsDescription')}
                    </p>
                  </div>

                  <Alert className="border-border/60 bg-muted/40">
                    <Globe className="h-4 w-4 text-primary" />
                    <AlertTitle>{t('quickStartForVpsRemoteAccess')}</AlertTitle>
                    <AlertDescription className="space-y-1 text-sm text-muted-foreground">
                      <p>
                        {t('ui.corsQuickKeep')} {" "}
                        <strong className="text-foreground">
                          {t('labels.allowPrivateLan')}
                        </strong>{" "}
                        {t('ui.corsQuickOn')}
                      </p>
                      <p>
                        {t('ui.corsQuickAddOrigin')} {" "}<code>http://YOUR_PUBLIC_IP:3001</code>).
                      </p>
                      <p>
                        {t('ui.corsQuickSave')} {" "}
                        <strong className="text-foreground">
                          {t('ui.reloadCorsRules')}
                        </strong>
                        .
                      </p>
                    </AlertDescription>
                  </Alert>

                  <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/25 p-3">
                    <div>
                      <Label className="text-sm font-medium">
                        {t('labels.allowPrivateLan')}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {t('ui.allowPrivateLanDescription')}
                      </p>
                    </div>
                    <Switch
                      checked={settings.corsAllowPrivateNetworks}
                      onCheckedChange={handleCorsLanToggle}
                      aria-label={t('labels.allowPrivateLan')}
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/25 p-3">
                    <div>
                      <Label className="text-sm font-medium">
                        {t('ui.showPublicIp')}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {t('ui.showPublicIpDescription')}
                      </p>
                    </div>
                    <Switch
                      checked={settings.enablePublicIpLookup}
                      onCheckedChange={(value) =>
                        updateSetting("enablePublicIpLookup", value)
                      }
                      aria-label={t('labels.enablePublicIpLookup')}
                    />
                  </div>

                  <div className="space-y-2 rounded-lg border border-border/60 bg-muted/25 p-3">
                    <div>
                      <Label className="text-sm font-medium">
                        {t('ui.dashboardLanAddress')}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {t('ui.dashboardLanAddressDescription')}
                      </p>
                    </div>
                    <Select
                      value={settings.lanIpAddress || "auto"}
                      onValueChange={(value) =>
                        updateSetting(
                          "lanIpAddress",
                          value === "auto" ? "" : value,
                        )
                      }
                    >
                      <SelectTrigger aria-label={t('labels.dashboardLanAddress')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">
                          {t('ui.autoDetectDefault')}
                        </SelectItem>
                        {networkInterfaces.map((iface) => (
                          <SelectItem key={iface.address} value={iface.address}>
                            {iface.name} — {iface.address}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="cors-origins">
                      {t('ui.additionalAllowedOrigins')}
                    </Label>
                    <Textarea
                      id="cors-origins"
                      value={settings.corsAllowedOrigins}
                      onChange={(e) =>
                        updateSetting("corsAllowedOrigins", e.target.value)
                      }
                      placeholder={
                        "http://123.45.67.89:3001\nhttps://panel.example.com"
                      }
                      rows={4}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('ui.oneOriginPerLine')}
                    </p>
                    {corsOriginValidationError && (
                      <p className="text-xs text-destructive">
                        {corsOriginValidationError}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center justify-between rounded-lg border border-warning/40 bg-warning/10 p-3">
                    <div>
                      <Label className="text-sm font-medium text-warning">
                        {t('ui.allowAllOriginsDebug')}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {t('ui.allowAllOriginsDebugDescription')}
                      </p>
                    </div>
                    <Switch
                      checked={settings.corsAllowAll}
                      onCheckedChange={(value) =>
                        updateSetting("corsAllowAll", value)
                      }
                      aria-label={t('labels.allowAllOrigins')}
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/25 p-3">
                    <div>
                      <Label className="text-sm font-medium">
                        {t('ui.enableCorsDebug')}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {t('ui.enableCorsDebugDescription')}
                      </p>
                    </div>
                    <Switch
                      checked={settings.corsDebug}
                      onCheckedChange={(value) =>
                        updateSetting("corsDebug", value)
                      }
                      aria-label={t('labels.enableCorsDebug')}
                    />
                  </div>

                  {settings.corsAllowAll && (
                    <Alert className="border-warning/40 bg-warning/10">
                      <AlertTriangle className="h-4 w-4 text-warning" />
                      <AlertTitle className="text-warning">
                        {t('ui.securityWarning')}
                      </AlertTitle>
                      <AlertDescription>
                        {t('ui.allowAllOriginsWarning')}
                      </AlertDescription>
                    </Alert>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleReloadCorsRules}
                      disabled={
                        corsUpdating ||
                        saving ||
                        Boolean(corsOriginValidationError)
                      }
                      className="gap-2"
                    >
                      {corsUpdating ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4" />
                      )}
                      {t('ui.reloadCorsRules')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={fetchCorsDiagnostics}
                      disabled={corsLoading || corsUpdating}
                      className="gap-2"
                    >
                      <RefreshCw
                        className={cn("w-4 h-4", corsLoading && "animate-spin")}
                      />
                      {t('ui.refreshDiagnostics')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleClearCorsBlocked}
                      disabled={corsUpdating || !corsDiagnostics?.blockedCount}
                      className="gap-2 text-muted-foreground"
                    >
                      <Trash2 className="w-4 h-4" />
                      {t('ui.clearBlockedLog')}
                    </Button>
                  </div>

                  <div className="grid gap-3 text-xs sm:grid-cols-3">
                    <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                      <p className="text-muted-foreground">{t('blockedOrigins')}</p>
                      <p className="mt-1 font-medium text-foreground">
                        {corsDiagnostics?.blockedCount ?? 0}
                      </p>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                      <p className="text-muted-foreground">
                        {t('ui.effectiveAllowlist')}
                      </p>
                      <p className="mt-1 font-medium text-foreground">
                        {corsDiagnostics?.effectiveAllowedOrigins.length ?? 0}
                      </p>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                      <p className="text-muted-foreground">{t('lastReload')}</p>
                      <p className="mt-1 font-medium text-foreground">
                        {formatTimestamp(corsDiagnostics?.lastLoadedAt || null)}
                      </p>
                    </div>
                  </div>

                  {!!corsDiagnostics?.blocked.length && (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-foreground">
                        {t('recentBlockedOrigins')}
                      </p>
                      <ScrollArea className="h-[150px] rounded-lg border border-border/60 bg-muted/20 p-2">
                        <div className="space-y-2 pr-2">
                          {corsDiagnostics.blocked.slice(0, 12).map((entry) => (
                            <div
                              key={entry.id}
                              className="rounded-md border border-border/50 bg-background/60 px-2 py-1.5 text-xs"
                            >
                              <p className="font-mono break-all text-foreground">
                                {entry.origin}
                              </p>
                              <p className="text-muted-foreground">
                                {entry.source.toUpperCase()} •{" "}
                                {formatTimestamp(entry.blockedAt)}
                              </p>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-border/70 bg-muted/30 p-4 space-y-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-sm font-medium">{t('panelAutoUpdate')}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('ui.panelAutoUpdateDescription')}
                      </p>
                    </div>
                    {checkingPanelUpdate || panelUpdateStatus?.isChecking ? (
                      <span className="inline-flex items-center rounded-full border border-border/60 bg-background/60 px-2.5 py-0.5 text-xs font-semibold text-foreground/85">
                        {t('ui.checking')}
                      </span>
                    ) : downloadingPanelUpdate ||
                      panelUpdateStatus?.isDownloading ? (
                      <span className="inline-flex items-center rounded-full border border-primary/35 bg-primary/12 px-2.5 py-0.5 text-xs font-semibold text-primary">
                        {t('ui.downloading')}
                      </span>
                    ) : panelUpdateStatus?.updateAvailable ? (
                      <span className="inline-flex items-center rounded-full border border-warning/35 bg-warning/12 px-2.5 py-0.5 text-xs font-semibold text-warning">
                        {t('ui.updateAvailableStatus')}
                      </span>
                    ) : panelUpdateStatusError ? (
                      <span className="inline-flex items-center rounded-full border border-destructive/35 bg-destructive/12 px-2.5 py-0.5 text-xs font-semibold text-destructive">
                        {t('ui.cannotReachUpdater')}
                      </span>
                    ) : !panelUpdateStatus ? (
                      <span className="inline-flex items-center rounded-full border border-border/60 bg-background/60 px-2.5 py-0.5 text-xs font-semibold text-foreground/80">
                        {t('ui.notChecked')}
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">
                        {t('messages.upToDate')}
                      </span>
                    )}
                  </div>

                  {panelUpdateStatusError && (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>{t('updaterError')}</AlertTitle>
                      <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <span className="break-words">
                          {panelUpdateStatusError}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={fetchPanelUpdateStatus}
                          disabled={
                            checkingPanelUpdate ||
                            downloadingPanelUpdate ||
                            restarting
                          }
                          className="self-start"
                        >
                          {t('ui.retry')}
                        </Button>
                      </AlertDescription>
                    </Alert>
                  )}

                  <div className="grid gap-3 text-xs sm:grid-cols-2">
                    <div className="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
                      <p className="text-muted-foreground">{t('installed')}</p>
                      <p className="mt-1 font-medium text-foreground">
                        v{panelUpdateStatus?.currentVersion || t('ui.unknownValue')}
                      </p>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
                      <p className="text-muted-foreground">{t('latest')}</p>
                      <p className="mt-1 font-medium text-foreground">
                        {panelUpdateStatus?.latestVersion
                          ? `v${panelUpdateStatus.latestVersion}`
                          : t('ui.notCheckedYet')}
                      </p>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
                      <p className="text-muted-foreground">{t('lastCheck')}</p>
                      <p className="mt-1 font-medium text-foreground">
                        {formatTimestamp(panelUpdateStatus?.lastCheck || null)}
                      </p>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
                      <p className="text-muted-foreground">{t('releasePublished')}</p>
                      <p className="mt-1 font-medium text-foreground">
                        {formatTimestamp(
                          panelUpdateStatus?.publishedAt || null,
                        )}
                      </p>
                    </div>
                  </div>

                  {(downloadingPanelUpdate ||
                    panelUpdateStatus?.isDownloading) && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{t('downloadingUpdate')}</span>
                        <span>{panelUpdateStatus?.downloadProgress ?? 0}%</span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full w-full bg-primary transition-transform duration-200 ease-out"
                          style={{
                            transform: `translateX(-${100 - (panelUpdateStatus?.downloadProgress ?? 0)}%)`,
                          }}
                        />
                      </div>
                    </div>
                  )}

                  {panelUpdateStatus?.lastError && (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>{t('lastUpdateError')}</AlertTitle>
                      <AlertDescription className="break-words whitespace-pre-wrap">
                        {panelUpdateStatus.lastError}
                      </AlertDescription>
                    </Alert>
                  )}

                  {panelUpdateStatus?.lastApplyResult &&
                    !panelApplyResultDismissed &&
                    (panelUpdateStatus.lastApplyResult.status === "success" ? (
                      // Hide the stale success banner if the panel has since moved to a different
                      // version (or there's already a newer staged update). The banner should only
                      // reflect the version that's currently running.
                      (panelUpdateStatus.lastApplyResult.appliedVersion &&
                        panelUpdateStatus.currentVersion &&
                        panelUpdateStatus.lastApplyResult.appliedVersion !==
                          panelUpdateStatus.currentVersion) ||
                      panelUpdateStatus.stagedUpdate ? null : (
                        <Alert variant="success">
                          <AlertTitle>{t('updateApplied')}</AlertTitle>
                          <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                            <span>
                              {t('ui.panelRunningVersion', {
                                version:
                                  panelUpdateStatus.lastApplyResult
                                    .appliedVersion ||
                                  panelUpdateStatus.currentVersion,
                                applied: panelUpdateStatus.lastApplyResult.at
                                  ? ` (${formatTimestamp(panelUpdateStatus.lastApplyResult.at)})`
                                  : "",
                              })}
                            </span>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setPanelApplyResultDismissed(true)}
                              className="self-start"
                            >
                              {t('ui.dismiss')}
                            </Button>
                          </AlertDescription>
                        </Alert>
                      )
                    ) : (
                      <Alert variant="destructive">
                        <AlertTriangle className="h-4 w-4" />
                        <AlertTitle>{t('updateFailedToApply')}</AlertTitle>
                        <AlertDescription className="flex flex-col gap-2">
                          <span className="break-words">
                            {panelUpdateStatus.lastApplyResult.stagedStillPresent
                              ? t('ui.updateStillRunningPreviousWithFile', {
                                  current:
                                    panelUpdateStatus.lastApplyResult.currentVersion ||
                                    panelUpdateStatus.currentVersion,
                                  expected: panelUpdateStatus.lastApplyResult.pendingVersion
                                    ? ` v${panelUpdateStatus.lastApplyResult.pendingVersion}`
                                    : "",
                                })
                              : t('ui.updateStillRunningPreviousMissingFile', {
                                  current:
                                    panelUpdateStatus.lastApplyResult.currentVersion ||
                                    panelUpdateStatus.currentVersion,
                                  expected: panelUpdateStatus.lastApplyResult.pendingVersion
                                    ? ` v${panelUpdateStatus.lastApplyResult.pendingVersion}`
                                    : "",
                                })}
                          </span>
                          {panelUpdateStatus.lastApplyResult.likelyCause ===
                            "av_quarantine" && (
                            <div className="rounded-md border border-destructive/40 bg-background/50 p-2 text-xs leading-relaxed">
                              <strong className="text-destructive-foreground">
                                {t('ui.likelyCause')}
                              </strong>{" "}
                              {t('ui.antivirusDeletedBinary')}
                              {panelUpdateStatus.lastApplyResult
                                .panelFolder && (
                                <div className="mt-1">
                                  {t('ui.addFolderToAvExclusions')}
                                  <pre className="mt-1 rounded bg-background/70 p-1 text-[11px]">
                                    {
                                      panelUpdateStatus.lastApplyResult
                                        .panelFolder
                                    }
                                  </pre>
                                  <div className="mt-1 text-[11px] opacity-80">
                                    {t('ui.windowsDefender')}{" "}
                                    <code>
                                      Add-MpPreference -ExclusionPath{" "}
                                      {JSON.stringify(
                                        panelUpdateStatus.lastApplyResult
                                          .panelFolder,
                                      )}
                                    </code>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                          {panelUpdateStatus.lastApplyResult.likelyCause ===
                            "rename_locked" && (
                            <div className="rounded-md border border-destructive/40 bg-background/50 p-2 text-xs leading-relaxed">
                              <strong className="text-destructive-foreground">
                                {t('ui.likelyCause')}
                              </strong>{" "}
                              {t('ui.renameLockedDescription')}
                            </div>
                          )}
                          {panelUpdateStatus.lastApplyResult.likelyCause ===
                            "permission" && (
                            <div className="rounded-md border border-destructive/40 bg-background/50 p-2 text-xs leading-relaxed">
                              <strong className="text-destructive-foreground">
                                {t('ui.likelyCause')}
                              </strong>{" "}
                              {t('ui.permissionDescription')}
                            </div>
                          )}
                          {panelUpdateStatus.lastApplyResult.likelyCause ===
                            "helper_blocked" && (
                            <div className="rounded-md border border-destructive/40 bg-background/50 p-2 text-xs leading-relaxed">
                              <strong className="text-destructive-foreground">
                                {t('ui.likelyCause')}
                              </strong>{" "}
                              {t('ui.helperBlockedDescription')}
                              {panelUpdateStatus.lastApplyResult
                                .panelFolder && (
                                <div className="mt-1">
                                  <strong>{t('recovery')}</strong>{" "}{t('ui.startBatRecovery')}
                                  <pre className="mt-1 rounded bg-background/70 p-1 text-[11px]">
                                    {
                                      panelUpdateStatus.lastApplyResult
                                        .panelFolder
                                    }
                                  </pre>
                                  <div className="mt-1 text-[11px] opacity-80">
                                    {t('ui.startBatRecoveryDescription')}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                          {panelUpdateStatus.lastApplyResult.likelyCause ===
                            "no_helper_log" && (
                            <div className="rounded-md border border-destructive/40 bg-background/50 p-2 text-xs leading-relaxed">
                              <strong className="text-destructive-foreground">
                                {t('ui.noHelperLog')}
                              </strong>{" "}
                              {t('ui.noHelperLogDescription')}
                            </div>
                          )}
                          {panelApplyLog && (
                            <details className="mt-1 text-xs">
                              <summary className="cursor-pointer font-medium">
                                {t('ui.showHelperLog')}
                              </summary>
                              <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-destructive/30 bg-background/60 p-2 text-[11px] leading-snug whitespace-pre-wrap break-all">
                                {panelApplyLog}
                              </pre>
                            </details>
                          )}
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setPanelApplyResultDismissed(true)}
                            >
                              {t('ui.dismiss')}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={async () => {
                                try {
                                  const { log: helperLog } =
                                    await panelUpdateApi.getApplyLog();
                                  setPanelApplyLog(
                                    helperLog || t('ui.noHelperLogFound'),
                                  );
                                } catch (error) {
                                  toast({
                                    title: t('messages.couldNotReadLog'),
                                    description:
                                      error instanceof Error
                                        ? error.message
                                        : t('ui.failedToReadHelperLog'),
                                    variant: "destructive",
                                  });
                                }
                              }}
                            >
                              {t('ui.refreshLog')}
                            </Button>
                          </div>
                        </AlertDescription>
                      </Alert>
                    ))}

                  {panelUpdatePreflight &&
                    !panelUpdatePreflight.ok &&
                    (panelUpdateStatus?.updateAvailable ||
                      panelUpdateStatus?.stagedUpdate) && (
                      <Alert variant="destructive">
                        <AlertTriangle className="h-4 w-4" />
                        <AlertTitle>{t('updateBlocked')}</AlertTitle>
                        <AlertDescription>
                          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                            {panelUpdatePreflight.blockers.map((b, i) => (
                              <li key={`blk-${i}`} className="break-words">
                                {b}
                              </li>
                            ))}
                          </ul>
                        </AlertDescription>
                      </Alert>
                    )}

                  {panelUpdatePreflight &&
                    panelUpdatePreflight.ok &&
                    panelUpdatePreflight.warnings.length > 0 &&
                    (panelUpdateStatus?.updateAvailable ||
                      panelUpdateStatus?.stagedUpdate) &&
                    !(
                      panelUpdateStatus?.lastApplyResult?.status === "failed" &&
                      !panelApplyResultDismissed
                    ) && (
                      <Alert variant="warning">
                        <AlertTriangle className="h-4 w-4" />
                        <AlertTitle>{t('beforeYouRestart')}</AlertTitle>
                        <AlertDescription>
                          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                            {panelUpdatePreflight.warnings.map((w, i) => (
                              <li key={`wrn-${i}`} className="break-words">
                                {w}
                              </li>
                            ))}
                          </ul>
                        </AlertDescription>
                      </Alert>
                    )}

                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      onClick={handleCheckPanelUpdate}
                      disabled={
                        checkingPanelUpdate ||
                        downloadingPanelUpdate ||
                        restarting
                      }
                      className="gap-2"
                    >
                      {checkingPanelUpdate ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4" />
                      )}
                      {checkingPanelUpdate
                        ? t('ui.checking')
                        : t('ui.checkForUpdates')}
                    </Button>

                    {isDockerPanelUpdate ? (
                      <AlertDialog
                        open={dockerUpdateConfirmOpen}
                        onOpenChange={setDockerUpdateConfirmOpen}
                      >
                        <AlertDialogTrigger asChild>
                          <Button
                            disabled={
                              !panelUpdateStatus?.updateAvailable ||
                              checkingPanelUpdate ||
                              downloadingPanelUpdate ||
                              restarting ||
                              panelUpdatePreflight?.ok === false
                            }
                            className="gap-2"
                          >
                            {downloadingPanelUpdate ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Download className="w-4 h-4" />
                            )}
                            {downloadingPanelUpdate
                              ? t('ui.applyingDockerUpdate')
                              : t('ui.applyDockerUpdate')}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              {t('ui.applyDockerUpdateQuestion')}
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              {t('ui.dockerUpdateDescription')}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => {
                                setDockerUpdateConfirmOpen(false);
                                handleDownloadPanelUpdate();
                              }}
                            >
                              {t('ui.stopServerAndUpdate')}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    ) : (
                      <Button
                        onClick={handleDownloadPanelUpdate}
                        disabled={
                          !panelUpdateStatus?.updateAvailable ||
                          checkingPanelUpdate ||
                          downloadingPanelUpdate ||
                          restarting ||
                          panelUpdatePreflight?.ok === false
                        }
                        className="gap-2"
                      >
                        {downloadingPanelUpdate ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Download className="w-4 h-4" />
                        )}
                        {downloadingPanelUpdate ? t('ui.downloading') : t('ui.downloadUpdate')}
                      </Button>
                    )}

                    {!isDockerPanelUpdate && <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="warning"
                          disabled={
                            !panelUpdateReady ||
                            restarting ||
                            isDirty ||
                            downloadingPanelUpdate ||
                            Boolean(panelUpdateStatus?.isDownloading) ||
                            panelUpdatePreflight?.ok === false
                          }
                          className="gap-2"
                        >
                          {restarting ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <RotateCw className="w-4 h-4" />
                          )}
                          {t('ui.restartAndApplyUpdate')}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            {t('ui.applyPanelUpdateQuestion')}
                          </AlertDialogTitle>
                          <AlertDialogDescription asChild>
                            <div className="space-y-3 text-sm">
                              <p>
                                {t('ui.panelUpdateExitDescription', {
                                  version: panelUpdateStatus?.stagedUpdate?.version
                                    ? ` v${panelUpdateStatus.stagedUpdate.version}`
                                    : "",
                                })}
                              </p>
                              {panelUpdatePreflight?.warnings.length ? (
                                <div>
                                  <p className="font-medium text-foreground">
                                    {t('ui.confirmBeforeContinuing')}
                                  </p>
                                  <ul className="mt-1 list-disc space-y-1 pl-5">
                                    {panelUpdatePreflight.warnings.map(
                                      (w, i) => (
                                        <li
                                          key={`confirm-wrn-${i}`}
                                          className="break-words"
                                        >
                                          {w}
                                        </li>
                                      ),
                                    )}
                                  </ul>
                                </div>
                              ) : null}
                              <p className="text-xs text-muted-foreground">
                                {t('ui.helperLogRecoveryHint')}{" "}
                                <code>%TEMP%</code>(
                                <code>zomboid-panel-update-*.log</code>) {t('ui.helperLogRelaunch')}
                              </p>
                            </div>
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() =>
                              restartPanelWithReconnect(
                                t('ui.applyingDownloadedUpdate'),
                              )
                            }
                          >
                            {t('ui.restartAndApply')}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>}

                    {panelUpdateStatus?.releaseUrl && (
                      <Button asChild variant="ghost" className="gap-2">
                        <a
                          href={panelUpdateStatus.releaseUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="max-w-full truncate"
                          title={panelUpdateStatus.releaseUrl}
                        >
                          <ExternalLink className="h-4 w-4" />
                          {t('ui.viewReleaseNotes')}{" "}
                          <span className="sr-only">({t('ui.opensInNewTab')})</span>
                        </a>
                      </Button>
                    )}
                  </div>

                  <p className="text-xs text-muted-foreground">
                    {isDirty
                      ? t('ui.saveBeforeUpdate')
                      : panelUpdateReady
                        ? t('ui.updateFilesReady')
                        : panelUpdateStatus?.updateAvailable
                          ? isDockerPanelUpdate
                            ? t('ui.dockerUpdateReadyDescription')
                            : t('ui.downloadThenRestart')
                          : t('ui.noUpdateReady')}
                  </p>

                  <p className="text-xs text-muted-foreground">
                    {isDockerPanelUpdate
                        ? t('ui.dockerUpdatesHostController')
                        : t('ui.autoUpdatePackagedOnly')}
                  </p>
                </div>
              </CardContent>
            </Card>
            <Card className="mt-4">
              <CardHeader className="pb-4">
                <CardTitle>{t('latest.serverAutomation')}</CardTitle>
                <CardDescription>{t('latest.serverAutomationDescription')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Label htmlFor="auto-start-server">{t('latest.autoStartServer')}</Label>
                    <p className="text-xs text-muted-foreground">{t('latest.autoStartServerDescription')}</p>
                  </div>
                  <Switch
                    id="auto-start-server"
                    checked={settings.autoStartServer}
                    onCheckedChange={(value) => updateSetting("autoStartServer", value)}
                  />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Label htmlFor="auto-export-on-login">{t('latest.autoExportOnLogin')}</Label>
                    <p className="text-xs text-muted-foreground">{t('latest.autoExportOnLoginDescription')}</p>
                  </div>
                  <Switch
                    id="auto-export-on-login"
                    checked={settings.autoExportOnLogin}
                    onCheckedChange={(value) => updateSetting("autoExportOnLogin", value)}
                  />
                </div>
                {settings.autoExportOnLogin && (
                  <div className="max-w-xs space-y-1.5">
                    <Label htmlFor="auto-export-max-per-player">{t('latest.autoExportMaxPerPlayer')}</Label>
                    <Input
                      id="auto-export-max-per-player"
                      type="number"
                      min="1"
                      max="50"
                      value={settings.autoExportMaxPerPlayer}
                      onChange={(event) => updateSetting("autoExportMaxPerPlayer", event.target.value)}
                    />
                  </div>
                )}
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Label htmlFor="server-auto-update">{t('latest.serverAutoUpdate')}</Label>
                    <p className="text-xs text-muted-foreground">{t('latest.serverAutoUpdateDescription')}</p>
                  </div>
                  <Switch
                    id="server-auto-update"
                    checked={settings.serverAutoUpdate}
                    onCheckedChange={(value) => updateSetting("serverAutoUpdate", value)}
                  />
                </div>
                {settings.serverAutoUpdate && (
                  <div className="max-w-xs space-y-1.5">
                    <Label htmlFor="server-auto-update-warning">{t('latest.serverAutoUpdateWarningMinutes')}</Label>
                    <Input
                      id="server-auto-update-warning"
                      type="number"
                      min="0"
                      max="120"
                      value={settings.serverAutoUpdateWarningMinutes}
                      onChange={(event) => updateSetting("serverAutoUpdateWarningMinutes", event.target.value)}
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="https" className="mt-0">
            {/* HTTPS Settings */}
            <Card id="settings-https">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-2">
                  <Lock className="w-4 h-4 text-primary" />
                  HTTPS
                </CardTitle>
                <CardDescription>
                  {t('ui.httpsDescription')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Alert className="border-border/60 bg-muted/40">
                  <Lock className="h-4 w-4 text-primary" />
                  <AlertTitle>{t('recommendedSetupMostServers')}</AlertTitle>
                  <AlertDescription className="space-y-2 text-sm text-muted-foreground">
                    <p>
                      {t('ui.httpsRecommendedStep')}
                    </p>
                    <p>
                      {t('ui.httpsAutoCertificate')}
                    </p>
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={applyRecommendedHttpsDefaults}
                      >
                        {t('ui.useRecommendedDefaults')}
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>

                <div className="flex items-center gap-3 p-4 rounded-xl bg-muted/50">
                  <Switch
                    checked={settings.httpsEnabled}
                    onCheckedChange={(value) =>
                      updateSetting("httpsEnabled", value)
                    }
                    aria-label={t('labels.enableHttps')}
                  />
                  <div>
                    <Label className="text-base">{t('enableHttps')}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t('ui.serveOverHttps')}
                    </p>
                  </div>
                </div>

                <div className="rounded-xl border border-border/60 bg-background/50 p-3 text-xs text-muted-foreground space-y-1">
                  <p>
                    <strong className="text-foreground">{t('httpUrl')}</strong>{" "}
                    <code className="break-all">{httpPreviewUrl}</code>
                  </p>
                  <p>
                    <strong className="text-foreground">{t('httpsUrl')}</strong>{" "}
                    <code className="break-all">{httpsPreviewUrl}</code>
                  </p>
                </div>

                {settings.httpsEnabled && (
                  <div className="ml-2 space-y-4 border-l-2 border-primary/20 pl-2">
                    <div className="max-w-xs">
                      <Label htmlFor="https-port">{t('httpsPort')}</Label>
                      <Input
                        id="https-port"
                        type="number"
                        value={settings.httpsPort}
                        onChange={(e) =>
                          updateSetting("httpsPort", e.target.value)
                        }
                        onWheel={(e) => e.currentTarget.blur()}
                        min="1024"
                        max="65535"
                        placeholder={t('placeholders.httpsPort')}
                        inputMode="numeric"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        {t('ui.httpsPortDescription')}
                      </p>
                    </div>
                    <div className="max-w-md">
                      <Label htmlFor="https-cert-path">
                        {t('ui.customCertificatePath')} {" "}
                        <span className="text-muted-foreground font-normal">
                          {t('ui.optional')}
                        </span>
                      </Label>
                      <Input
                        id="https-cert-path"
                        value={settings.httpsCertPath}
                        onChange={(e) =>
                          updateSetting("httpsCertPath", e.target.value)
                        }
                        placeholder={t('placeholders.certPath')}
                        maxLength={260}
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        {t('ui.certificatePathsDescription')}
                      </p>
                    </div>
                    <div className="max-w-md">
                      <Label htmlFor="https-key-path">
                        {t('ui.customKeyPath')} {" "}
                        <span className="text-muted-foreground font-normal">
                          {t('ui.optional')}
                        </span>
                      </Label>
                      <Input
                        id="https-key-path"
                        value={settings.httpsKeyPath}
                        onChange={(e) =>
                          updateSetting("httpsKeyPath", e.target.value)
                        }
                        placeholder={t('placeholders.keyPath')}
                        maxLength={260}
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        {t('ui.keyPathDescription')}
                      </p>
                    </div>

                    {hasPartialHttpsCertPath && (
                      <Alert className="border-warning/40 bg-warning/10">
                        <AlertTriangle className="h-4 w-4 text-warning" />
                        <AlertTitle className="text-warning">
                          {t('ui.provideBothCertificateFiles')}
                        </AlertTitle>
                        <AlertDescription>
                          {t('ui.provideBothCertificateFilesDescription')}
                        </AlertDescription>
                      </Alert>
                    )}

                    {usingAutoGeneratedHttpsCert && (
                      <Alert className="border-primary/30 bg-primary/10">
                        <Lock className="h-4 w-4 text-primary" />
                        <AlertTitle className="text-primary">
                          {t('ui.autoGeneratedCertificateMode')}
                        </AlertTitle>
                        <AlertDescription>
                          {t('ui.autoGeneratedCertificateDescription')}
                        </AlertDescription>
                      </Alert>
                    )}

                    <Alert className="border-border/60 bg-muted/35">
                      <Lock className="h-4 w-4 text-muted-foreground" />
                      <AlertTitle>{t('reverseProxyNote')}</AlertTitle>
                      <AlertDescription>
                        {t('ui.reverseProxyDescription')}
                      </AlertDescription>
                    </Alert>

                    {originalSettings &&
                      settings.httpsEnabled !==
                        originalSettings.httpsEnabled && (
                        <Alert className="border-warning/40 bg-warning/10">
                          <AlertTriangle className="h-4 w-4 text-warning" />
                          <AlertTitle className="text-warning">
                            {t('ui.restartRequired')}
                          </AlertTitle>
                          <AlertDescription>
                            {t('ui.httpsRestartDescription')}
                          </AlertDescription>
                        </Alert>
                      )}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="rcon" className="mt-0">
            {/* RCON Settings */}
            <Card id="settings-rcon">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-2">
                  <Link className="w-4 h-4 text-primary" />
                  {t('ui.rconConnection')}
                </CardTitle>
                <CardDescription>
                  {t('ui.rconDescription')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                  <Button
                    variant="outline"
                    onClick={handleTestRcon}
                    disabled={testingRcon}
                    className="w-full sm:w-auto"
                  >
                    {testingRcon ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : null}
                    {t('ui.testConnection')}
                  </Button>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={settings.autoReconnect}
                      onCheckedChange={(value) =>
                        updateSetting("autoReconnect", value)
                      }
                      aria-label={t('labels.autoReconnectRcon')}
                    />
                    <Label>{t('autoreconnectOnDisconnect')}</Label>
                  </div>
                </div>
                {settings.autoReconnect && (
                  <div className="max-w-xs">
                    <Label htmlFor="reconnect-interval">
                      {t('ui.reconnectInterval')}
                    </Label>
                    <Input
                      id="reconnect-interval"
                      type="number"
                      value={settings.reconnectInterval}
                      onChange={(e) =>
                        updateSetting("reconnectInterval", e.target.value)
                      }
                      onWheel={(e) => e.currentTarget.blur()}
                      min="1"
                      max="60"
                      inputMode="numeric"
                    />
                  </div>
                )}
                <div className="p-4 bg-muted rounded-xl text-sm">
                  <p className="font-medium mb-2">
                    {t('ui.rconPerServer')}
                  </p>
                  <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                    <li>
                      {t('ui.goToServersPage', { page: t('servers') })}
                    </li>
                    <li>
                      {t('ui.editServer', { action: t('edit') })}
                    </li>
                    <li>{t('configureRconHostPortAndPasswordThere')}</li>
                  </ol>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="bridge" className="mt-0">
            {/* Panel Bridge - Advanced Features */}
            <Card id="settings-bridge">
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Zap className="w-4 h-4 text-primary" />
                      {t('bridge.title')}
                    </CardTitle>
                    <CardDescription className="flex items-center gap-2">
                      {t('bridge.description')}{" "}
                      <Dialog>
                        <DialogTrigger asChild>
                          <button className="inline-flex items-center gap-1 text-xs text-primary hover:underline whitespace-nowrap">
                            <Info className="w-3.5 h-3.5" />
                            {t('bridge.howItWorks')}
                          </button>
                        </DialogTrigger>
                        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
                          <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                              <Zap className="w-4 h-4 text-primary" />
                              {t('bridge.title')}
                            </DialogTitle>
                            <DialogDescription>
                              {t('bridge.dialogDescription')}
                            </DialogDescription>
                          </DialogHeader>
                          <div className="space-y-5 text-sm">
                            {/* What it unlocks */}
                            <div>
                              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                                {t('bridge.whatItUnlocks')}
                              </p>
                              <div className="grid grid-cols-2 gap-2">
                                <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                                  <p className="font-medium text-foreground">
                                    {t('bridge.weatherClimate')}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {t('bridge.weatherClimateDescription')}
                                  </p>
                                </div>
                                <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                                  <p className="font-medium text-foreground">
                                    {t('bridge.playerActions')}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {t('bridge.playerActionsDescription')}
                                  </p>
                                </div>
                                <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                                  <p className="font-medium text-foreground">
                                    {t('bridge.worldControl')}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {t('bridge.worldControlDescription')}
                                  </p>
                                </div>
                                <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                                  <p className="font-medium text-foreground">
                                    {t('bridge.chatSound')}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {t('bridge.chatSoundDescription')}
                                  </p>
                                </div>
                              </div>
                            </div>

                            {/* How it works */}
                            <div>
                              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                                {t('bridge.howItWorks')}
                              </p>
                              <p className="text-muted-foreground mb-3">
                                {t('bridge.howItWorksDescription')}{" "}
                                <strong className="text-foreground">
                                  PanelBridge.lua
                                </strong>{" "}
                                {t('bridge.howItWorksDetails')}
                              </p>
                            </div>

                            {/* Setup steps */}
                            <div>
                              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                                {t('bridge.setup')}
                              </p>
                              <ol className="space-y-2">
                                <li className="flex gap-3 items-start">
                                  <span className="flex-none w-5 h-5 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center mt-0.5">
                                    1
                                  </span>
                                  <div>
                                    <p className="font-medium">
                                      {t('bridge.installLuaFile')}
                                    </p>
                                    <p className="text-muted-foreground text-xs">
                                      {t('bridge.installLuaDescription')}
                                    </p>
                                  </div>
                                </li>
                                <li className="flex gap-3 items-start">
                                  <span className="flex-none w-5 h-5 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center mt-0.5">
                                    2
                                  </span>
                                  <div>
                                    <p className="font-medium">
                                      {t('bridge.runAutoSetup')}
                                    </p>
                                    <p className="text-muted-foreground text-xs">
                                      {t('bridge.runAutoSetupDescription')}
                                    </p>
                                  </div>
                                </li>
                                <li className="flex gap-3 items-start">
                                  <span className="flex-none w-5 h-5 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center mt-0.5">
                                    3
                                  </span>
                                  <div>
                                    <p className="font-medium">
                                      {t('bridge.startPzServer')}
                                    </p>
                                    <p className="text-muted-foreground text-xs">
                                      {t('bridge.startPzServerDescription')}{" "}
                                      <strong className="text-warning">
                                        {t('bridge.waiting')}
                                      </strong>{" "}
                                      {t('bridge.statusTransitionTo')} {" "}
                                      <strong className="text-primary">
                                        {t('bridge.connected')}
                                      </strong>
                                      。
                                    </p>
                                  </div>
                                </li>
                              </ol>
                            </div>

                            {/* Requirement */}
                            <div className="rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-xs">
                              <p>
                                {t('bridge.checksumRequirement', {
                                  setting: t('requiresLuachecksumfalse'),
                                })}
                              </p>
                            </div>
                          </div>
                        </DialogContent>
                      </Dialog>
                    </CardDescription>
                  </div>
                  {bridgeStatus && (
                    <BridgeStatusBadge
                      connected={bridgeStatus.modConnected}
                      running={bridgeStatus.isRunning}
                      loading={bridgeLoading}
                      bridgePath={bridgeStatus.bridgePath}
                      summary={bridgeStatus.connection?.summary}
                    />
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Status Display - when connected */}
                {bridgeStatus?.modConnected && bridgeStatus.modStatus && (
                  <Alert
                    className="border-primary/30 bg-primary/10"
                    aria-live="polite"
                  >
                    <div className="flex items-center gap-3 mb-3">
                      <CheckCircle2 className="w-5 h-5 text-primary" />
                      <span className="font-semibold text-primary">
                        {t('bridge.connectedTo', { server: bridgeStatus.modStatus.serverName || t('messages.server') })}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-muted-foreground">
                          {t('bridge.modVersion')}:
                        </span>{" "}
                        <span className="font-medium">
                            {bridgeStatus.modStatus.version || t('bridge.unknown')}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">
                          {t('bridge.playersOnline')}:
                        </span>{" "}
                        <span className="font-medium">
                          {bridgeStatus.modStatus.alive
                            ? (bridgeStatus.modStatus.playerCount ?? 0)
                            : t('bridge.offline')}
                        </span>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">
                      {t('bridge.advancedFeatures')}
                    </p>
                  </Alert>
                )}

                {/* Not running - setup flow */}
                {!bridgeStatus?.isRunning && (
                  <div className="p-4 bg-muted rounded-xl space-y-3">
                    <p className="text-sm font-medium">{t('getStarted')}</p>
                    <ol className="space-y-1.5 text-sm text-muted-foreground list-decimal list-inside">
                      <li>
                        {t('bridge.install')} {" "}
                        <strong className="text-foreground">
                          PanelBridge.lua
                        </strong>{" "}
                        {t('bridge.installUsingSection')}
                      </li>
                      <li>
                        {t('bridge.set')} {" "}
                        <strong className="text-foreground">
                          LuaChecksum=false
                        </strong>{" "}
                        {t('bridge.inServerIni')}
                      </li>
                      <li>
                        {t('bridge.click')} {" "}
                        <strong className="text-foreground">{t('autoSetup')}</strong>{" "}
                        {t('bridge.toStartWatcher')}
                      </li>
                      <li>{t('startOrRestartThePzServer')}</li>
                    </ol>
                    <Button
                      onClick={() => handleAutoConfigure()}
                      disabled={bridgeLoading}
                      className="gap-2"
                    >
                      {bridgeLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Zap className="w-4 h-4" />
                      )}
                      {t('bridge.autoSetupButton')}
                    </Button>

                    <div className="border-t border-border/50 pt-3 mt-1 space-y-2">
                      <p className="text-xs text-muted-foreground">
                        {t('bridge.manualPathDescription')}
                      </p>
                      <div className="flex gap-2">
                        <Input
                          value={manualBridgePath}
                          onChange={(e) => setManualBridgePath(e.target.value)}
                          placeholder={t('placeholders.bridgePath')}
                          className="text-xs h-9"
                        />
                        <Button
                          onClick={handleManualConfigure}
                          disabled={bridgeLoading || !manualBridgePath.trim()}
                          variant="secondary"
                          size="sm"
                          className="shrink-0 gap-1.5"
                        >
                          {bridgeLoading ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <FolderOpen className="w-3.5 h-3.5" />
                          )}
                          {t('bridge.connect')}
                        </Button>
                      </div>
                    </div>

                    <div className="border-t border-border/50 pt-4 space-y-3">
                      <div>
                        <p className="text-sm font-medium">{t('remoteServerViaSftp')}</p>
                        <p className="text-xs text-muted-foreground">{t('syncsOnlyBridgeStatusQueueStateAndCommandResultFilesCommandDeliveryRunsEvery2To10Seconds')}</p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5"><Label htmlFor="sftp-host">{t('host')}</Label><Input id="sftp-host" value={settings.panelBridgeSftpHost} onChange={(event) => updateSetting("panelBridgeSftpHost", event.target.value)} placeholder={t('placeholders.hostname')} /></div>
                        <div className="space-y-1.5"><Label htmlFor="sftp-port">{t('port')}</Label><Input id="sftp-port" inputMode="numeric" value={settings.panelBridgeSftpPort} onChange={(event) => updateSetting("panelBridgeSftpPort", event.target.value)} /></div>
                        <div className="space-y-1.5"><Label htmlFor="sftp-user">{t('username')}</Label><Input id="sftp-user" autoComplete="username" value={settings.panelBridgeSftpUsername} onChange={(event) => updateSetting("panelBridgeSftpUsername", event.target.value)} /></div>
                        <div className="space-y-1.5"><Label htmlFor="sftp-password">{t('password')}</Label><Input id="sftp-password" type="password" autoComplete="current-password" value={settings.panelBridgeSftpPassword} onChange={(event) => updateSetting("panelBridgeSftpPassword", event.target.value)} placeholder={t('placeholders.storedSecurely')} /></div>
                      </div>
                      <div className="space-y-1.5"><Label htmlFor="sftp-bridge-path">{t('remoteAbsoluteBridgeFolder')}</Label><Input id="sftp-bridge-path" value={settings.panelBridgeSftpBridgePath} onChange={(event) => updateSetting("panelBridgeSftpBridgePath", event.target.value)} placeholder={t('placeholders.bridgePathExample')} /></div>
                      <div className="space-y-2 rounded-lg border border-border/60 bg-background/40 p-3">
                        <div>
                          <Label htmlFor="sftp-log-path">{t('latest.remoteLogFolder')}</Label>
                          <p className="text-xs text-muted-foreground">{t('latest.remoteLogFolderDescription')}</p>
                        </div>
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <Input
                            id="sftp-log-path"
                            value={settings.panelBridgeSftpLogPath}
                            onChange={(event) => updateSetting("panelBridgeSftpLogPath", event.target.value)}
                            placeholder={t('latest.remoteLogFolderPlaceholder')}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            onClick={handleListRemoteLogs}
                            disabled={loadingRemoteLogs || !settings.panelBridgeSftpLogPath.trim()}
                            className="shrink-0"
                          >
                            {loadingRemoteLogs && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            {t('latest.listLogs')}
                          </Button>
                        </div>
                        {remoteLogError && <p className="text-xs text-destructive">{remoteLogError}</p>}
                        {remoteLogs.length > 0 && (
                          <div className="space-y-1">
                            {remoteLogs.map((file) => (
                              <button
                                key={file.name}
                                type="button"
                                className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                                onClick={() => void handleTailRemoteLog(file.name)}
                              >
                                <span className="min-w-0 truncate font-mono">{file.name}</span>
                                <span className="shrink-0 text-muted-foreground">{file.size} B</span>
                              </button>
                            ))}
                          </div>
                        )}
                        {remoteLogContent && (
                          <div className="space-y-2">
                            <p className="text-xs font-medium">{remoteLogContent.name}</p>
                            <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-[11px] leading-5 whitespace-pre-wrap break-words">{remoteLogContent.content}</pre>
                            <p className="text-[11px] text-muted-foreground">
                              {t('latest.logBytesReturned', { bytes: remoteLogContent.bytesReturned })}
                              {remoteLogContent.truncated ? ` · ${t('latest.logTailTruncated')}` : ""}
                            </p>
                          </div>
                        )}
                      </div>
                      <div className="flex flex-wrap items-end gap-3">
                        <div className="w-36 space-y-1.5"><Label htmlFor="sftp-poll">{t('syncIntervalSeconds')}</Label><Input id="sftp-poll" inputMode="numeric" value={settings.panelBridgeSftpPollIntervalSeconds} onChange={(event) => updateSetting("panelBridgeSftpPollIntervalSeconds", event.target.value)} /></div>
                        <Button type="button" variant="outline" onClick={handleTestSftp} disabled={testingSftp || bridgeLoading}>{testingSftp ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link className="mr-2 h-4 w-4" />}{t('bridge.testSftp')}</Button>
                        <Button type="button" onClick={handleConfigureSftp} disabled={bridgeLoading}>{bridgeLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Cloud className="mr-2 h-4 w-4" />}{t('bridge.startSftpBridge')}</Button>
                      </div>
                      {bridgeStatus?.transport?.type === "sftp" && <p className="text-xs text-muted-foreground">SFTP {bridgeStatus.transport.running ? t('bridge.running') : t('bridge.stopped')}{bridgeStatus.transport.lastLatencyMs != null ? `, ${t('bridge.lastSync')} ${bridgeStatus.transport.lastLatencyMs} ms` : ""}{bridgeStatus.transport.lastError ? `, ${t('bridge.lastError')}: ${bridgeStatus.transport.lastError}` : ""}</p>}
                    </div>
                  </div>
                )}

                {/* Waiting for mod */}
                {bridgeStatus?.isRunning && !bridgeStatus?.modConnected && (
                  <Alert
                    className="border-warning/40 bg-warning/10"
                    aria-live="polite"
                  >
                    <Cloud className="h-4 w-4 text-warning" />
                    <AlertTitle className="text-warning">
                      {t('bridge.waitingForPzMod')}
                    </AlertTitle>
                    <AlertDescription className="space-y-2">
                      <p>
                        {t('bridge.waitingDescription')}{" "}
                        <strong className="text-foreground">
                          LuaChecksum=false
                        </strong>{" "}
                        {t('bridge.setSuffix')}
                      </p>
                      {bridgeStatus?.bridgePath && (
                        <p className="text-xs text-muted-foreground break-words">
                          {t('bridge.watching')} {" "}
                          <code className="rounded bg-background px-1 break-all">
                            {bridgeStatus.bridgePath}
                          </code>
                        </p>
                      )}
                    </AlertDescription>
                  </Alert>
                )}

                {/* Connection Diagnostics — shown when bridge is running but has issues */}
                {bridgeStatus?.isRunning &&
                  !bridgeStatus?.modConnected &&
                  bridgeStatus?.connection && (
                    <div className="rounded-lg border border-border/60 bg-muted/30 overflow-hidden">
                      <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 border-b border-border/40">
                        <Info className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="text-xs font-medium text-foreground">
                          {t('bridge.connectionDiagnostics')}
                        </span>
                        {bridgeStatus.consecutiveFailures != null &&
                          bridgeStatus.consecutiveFailures > 0 && (
                            <span className="ml-auto text-[10px] tabular-nums text-warning">
                              {t('bridge.consecutiveFailures', { count: bridgeStatus.consecutiveFailures })}
                            </span>
                          )}
                      </div>
                      <div className="p-3 space-y-3">
                        {/* Summary */}
                        <p className="text-xs text-muted-foreground">
                          {bridgeStatus.connection.summary}
                        </p>

                        {/* Issues list */}
                        {bridgeStatus.connection.issues &&
                          bridgeStatus.connection.issues.length > 0 && (
                            <div className="space-y-1">
                              {bridgeStatus.connection.issues.map(
                                (issue: string, i: number) => (
                                  <div
                                    key={i}
                                    className="flex items-start gap-1.5 text-xs text-destructive"
                                  >
                                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                                    <span>{issue}</span>
                                  </div>
                                ),
                              )}
                            </div>
                          )}

                        {/* File checks grid */}
                        {bridgeStatus.connection.checks && (
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                            {Object.entries(bridgeStatus.connection.checks).map(
                              ([key, val]) => {
                                if (key === "statusAgeMs") return null;
                                const label = key
                                  .replace(/([A-Z])/g, " $1")
                                  .replace(/^./, (s) => s.toUpperCase())
                                  .trim();
                                const passed = val === true;
                                return (
                                  <div
                                    key={key}
                                    className="flex items-center gap-1.5"
                                  >
                                    {passed ? (
                                      <CheckCircle2
                                        className="w-3 h-3 text-primary shrink-0"
                                        aria-hidden="true"
                                      />
                                    ) : (
                                      <XCircle
                                        className="w-3 h-3 text-destructive shrink-0"
                                        aria-hidden="true"
                                      />
                                    )}
                                    <span
                                      className={cn(
                                        passed
                                          ? "text-muted-foreground"
                                          : "text-destructive/90",
                                      )}
                                    >
                                      {label}
                                    </span>
                                  </div>
                                );
                              },
                            )}
                          </div>
                        )}

                        {/* Status file info */}
                        {bridgeStatus.statusFile && (
                          <div className="text-[11px] text-muted-foreground space-y-0.5 pt-1 border-t border-border/30">
                            <div className="flex items-center gap-1.5">
                              <span className="opacity-60">{t('statusFile')}</span>
                              <span
                                className={
                                  bridgeStatus.statusFile.exists
                                    ? "text-foreground"
                                    : "text-destructive/70"
                                }
                              >
                                {bridgeStatus.statusFile.exists
                                  ? t('bridge.present')
                                  : t('bridge.notFound')}
                              </span>
                              {bridgeStatus.statusFile.ageSeconds != null && (
                                <span className="opacity-50">
                                  (
                                  {formatBridgeAge(
                                    bridgeStatus.statusFile.ageSeconds,
                                    t('bridge.unknown'),
                                  )}{" "}
                                  {t('bridge.ago')})
                                </span>
                              )}
                            </div>
                            {bridgeStatus.statusFile.path && (
                              <div className="break-all opacity-50">
                                <code className="text-[10px]">
                                  {bridgeStatus.statusFile.path}
                                </code>
                              </div>
                            )}
                          </div>
                        )}

                        {/* File watcher status */}
                        <div className="flex items-center gap-3 text-[11px] text-muted-foreground pt-1 border-t border-border/30">
                          <span>
                            {t('bridge.fileWatcher')}: {" "}
                            {bridgeStatus.hasFileWatcher ? (
                              <span className="text-primary">{t('active')}</span>
                            ) : (
                              <span className="text-warning">{t('pollingOnly')}</span>
                            )}
                          </span>
                          {bridgeStatus.pendingCommands > 0 && (
                            <span>
                              {t('bridge.pending')}: {" "}
                              <span className="text-warning tabular-nums">
                                {bridgeStatus.pendingCommands}
                              </span>
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                {/* Error display */}
                {bridgeError && (
                  <Alert variant="destructive" aria-live="assertive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>{t('panelBridgeError')}</AlertTitle>
                    <AlertDescription>{bridgeError}</AlertDescription>
                  </Alert>
                )}

                {/* Control buttons when running */}
                {bridgeStatus?.isRunning && (
                  <div className="flex flex-wrap gap-3">
                    <Button
                      onClick={handleStopBridge}
                      disabled={bridgeLoading}
                      variant="outline"
                      size="sm"
                      className="gap-2"
                    >
                      {bridgeLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <XCircle className="w-4 h-4" />
                      )}
                      {t('bridge.stopBridge')}
                    </Button>
                    <Button
                      onClick={handlePingMod}
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      disabled={!bridgeStatus?.modConnected || pinging}
                    >
                      {pinging ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4" />
                      )}
                      {pinging ? t('bridge.pinging') : t('bridge.pingMod')}
                    </Button>
                    <Button
                      onClick={fetchBridgeStatus}
                      variant="ghost"
                      size="sm"
                      className="gap-2"
                    >
                      <RefreshCw className="w-4 h-4" />
                      {t('bridge.refreshStatus')}
                    </Button>
                  </div>
                )}

                {/* Auto-update toggle */}
                <div className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/25 p-4">
                  <div>
                    <Label className="text-sm font-medium">
                      {t('bridge.autoUpdateTitle')}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t('bridge.autoUpdateDescription')}
                    </p>
                  </div>
                  <Switch
                    checked={settings.panelBridgeAutoUpdate}
                    onCheckedChange={(value) =>
                      updateSetting("panelBridgeAutoUpdate", value)
                    }
                    aria-label={t('labels.autoUpdateBridge')}
                  />
                </div>

                {/* Install Mod */}
                <div className="p-4 bg-muted rounded-xl space-y-3">
                  <p className="text-sm font-medium">{t('installPanelbridgelua')}</p>
                  <div className="flex flex-wrap gap-3 items-center">
                    <Select
                      value={selectedInstallServerId}
                      onValueChange={setSelectedInstallServerId}
                    >
                      <SelectTrigger className="w-[200px]">
                        <SelectValue placeholder={t('placeholders.selectServer')} />
                      </SelectTrigger>
                      <SelectContent>
                        {servers.length === 0 ? (
                          <div className="px-2 py-1.5 text-sm text-muted-foreground">
                            {t('bridge.noServersConfigured')}
                          </div>
                        ) : (
                          servers.map((server) => (
                            <SelectItem
                              key={String(server.id)}
                              value={String(server.id)}
                            >
                              {server.name} {server.isActive ? `(${t('active')})` : ""}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                    <Button
                      onClick={handleInstallMod}
                      disabled={installingMod || !selectedInstallServerId}
                      className="gap-2"
                      variant="outline"
                    >
                      {installingMod ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Download className="w-4 h-4" />
                      )}
                      {t('bridge.installMod')}
                    </Button>
                  </div>
                  {selectedInstallTarget && (
                    <p className="text-xs text-muted-foreground break-all">
                      {t('bridge.destination')}:{" "}
                      <code className="bg-background px-1 rounded">
                        {selectedInstallTarget}
                      </code>
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="mods" className="mt-0">
            {/* Mod Update Settings */}
            <Card id="settings-mods">
              <CardHeader className="pb-4">
                <div className="flex items-center gap-3">
                  <CardTitle className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-primary" />
                      {t('ui.modUpdateSettings')}
                  </CardTitle>
                </div>
                <CardDescription>
                  {t('ui.modUpdateSettingsDescription')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="max-w-xs space-y-2">
                  <Label htmlFor="mod-check-interval" className="text-base">
                    {t('ui.checkIntervalMinutes')}
                  </Label>
                  <Input
                    id="mod-check-interval"
                    type="number"
                    value={settings.modCheckInterval}
                    onChange={(e) =>
                      updateSetting("modCheckInterval", e.target.value)
                    }
                    onWheel={(e) => e.currentTarget.blur()}
                    min="1"
                    max="120"
                    step="1"
                    className="h-11"
                    inputMode="numeric"
                  />
                  <p className="text-sm text-muted-foreground">
                    {t('ui.checkIntervalDescription')}
                  </p>
                </div>
                <div className="flex items-center gap-3 p-4 rounded-xl bg-muted/50">
                  <Switch
                    checked={settings.modAutoRestart}
                    onCheckedChange={(value) =>
                      updateSetting("modAutoRestart", value)
                    }
                    aria-label={t('labels.autoRestartOnModUpdate')}
                  />
                  <div>
                    <Label className="text-base">
                      {t('ui.autoRestartOnModUpdate')}
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {t('ui.autoRestartOnModUpdateDescription')}
                    </p>
                  </div>
                </div>
                {settings.modAutoRestart && (
                  <div className="max-w-xs space-y-2 pl-4 border-l-2 border-primary/30">
                    <Label htmlFor="mod-restart-delay" className="text-base">
                      {t('ui.restartDelayMinutes')}
                    </Label>
                    <Input
                      id="mod-restart-delay"
                      type="number"
                      value={settings.modRestartDelay}
                      onChange={(e) =>
                        updateSetting("modRestartDelay", e.target.value)
                      }
                      onWheel={(e) => e.currentTarget.blur()}
                      min="1"
                      max="30"
                      className="h-11"
                      inputMode="numeric"
                    />
                    <p className="text-sm text-muted-foreground">
                      {t('ui.restartDelayDescription')}
                    </p>
                  </div>
                )}
                <div className="border-t border-border/60 pt-6">
                  <div className="max-w-md space-y-2">
                    <Label htmlFor="steam-update-account" className="text-base">
                      {t('latest.steamUpdateAccount')}
                    </Label>
                    <Input
                      id="steam-update-account"
                      value={settings.steamUpdateAccount}
                      onChange={(e) => updateSetting("steamUpdateAccount", e.target.value)}
                      placeholder={t('latest.steamUpdateAccountPlaceholder')}
                      autoComplete="username"
                      className="h-11"
                    />
                    <p className="text-sm text-muted-foreground">
                      {t('latest.steamUpdateAccountDescription')}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Workshop Collection Sync ──────────────────────────────────────── */}
            <WorkshopCollectionSyncCard
              settings={settings}
              updateSetting={updateSetting}
            />
          </TabsContent>

          <TabsContent value="api-keys" className="mt-0">
            {/* API Keys */}
            <Card id="settings-api-keys">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-2">
                  <Key className="w-4 h-4 text-primary" />
                      {t('apiKeys.title')}
                </CardTitle>
                <CardDescription>
                  {t('ui.apiKeysDescription')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Label htmlFor="steam-api-key" className="text-base">
                      {t('ui.steamWebApiKey')}
                    </Label>
                    {/* Configured indicator — the API masks the value as "••••••••XXXX"
                  when set, so the presence of the bullets is a reliable signal
                  that a key is stored on the server. */}
                    {settings.steamApiKey &&
                    settings.steamApiKey.startsWith("•") ? (
                      <span className="inline-flex items-center gap-1 rounded border border-success/40 bg-success/10 px-1.5 py-0.5 text-[11px] font-medium text-success">
                        <Check className="w-3 h-3" aria-hidden="true" />{" "}
                        {t('ui.configured')}
                      </span>
                    ) : settings.steamApiKey ? (
                      <span className="inline-flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">
                        <AlertTriangle className="w-3 h-3" aria-hidden="true" />{" "}
                        {t('ui.pendingSave')}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded border border-muted-foreground/30 bg-muted/40 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                        {t('ui.notConfigured')}
                      </span>
                    )}
                  </div>
                  <div className="relative max-w-md">
                    <Input
                      id="steam-api-key"
                      type={showSteamApiKey ? "text" : "password"}
                      value={settings.steamApiKey}
                      onChange={(e) =>
                        updateSetting("steamApiKey", e.target.value)
                      }
                      placeholder={t('placeholders.steamApiKey')}
                      className="h-11 pr-10"
                      maxLength={128}
                    />
                    <button
                      type="button"
                      onClick={() => setShowSteamApiKey(!showSteamApiKey)}
                      className="absolute right-3 inset-y-0 flex items-center text-muted-foreground hover:text-foreground"
                      aria-label={
                        showSteamApiKey ? t('ui.hideApiKey') : t('ui.showApiKey')
                      }
                    >
                      {showSteamApiKey ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t('ui.steamApiKeyDescription')}
                  </p>
                  <div className="p-4 bg-muted rounded-xl text-sm mt-3">
                    <p className="font-medium mb-2">
                      {t('ui.howToGetSteamApiKey')}
                    </p>
                    <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                      <li>
                        {t('ui.goToRegistration')}{" "}
                        <a
                          href="https://steamcommunity.com/dev/apikey"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          {t('ui.steamApiKeyRegistration')} {" "}
                          <span className="sr-only">({t('ui.opensInNewTab')})</span>
                        </a>
                      </li>
                      <li>{t('logInWithYourSteamAccount')}</li>
                      <li>
                        {t('ui.enterSteamApiDomain')}
                      </li>
                      <li>{t('copyTheKeyAndPasteItHere')}</li>
                    </ol>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="backups" className="mt-0">
            {/* World Backups */}
            <Card id="settings-backups">
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Archive className="w-4 h-4 text-primary" />
                      {t('ui.worldBackups')}
                    </CardTitle>
                    <CardDescription>
                      {t('ui.worldBackupsDescription')}
                    </CardDescription>
                  </div>
                  <Button
                    onClick={handleCreateBackup}
                    disabled={creatingBackup || !backupStatus?.savesExists}
                    className="gap-2"
                  >
                    {creatingBackup ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Archive className="w-4 h-4" />
                    )}
                    {creatingBackup ? t('ui.creating') : t('ui.backupNow')}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Status */}
                {backupStatus && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-4 bg-muted/50 rounded-xl">
                    <div className="flex items-center gap-2">
                      <HardDrive className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm">
                        {backupStatus.savesExists ? (
                          <span className="text-primary">
                            {t('ui.savesFolderFound')}
                          </span>
                        ) : (
                          <span className="text-destructive">
                            {t('ui.savesFolderNotFound')}
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Archive className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm">
                        {t('ui.backupsStored', { count: backupStatus.backupCount })}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm">
                        {backupStatus.lastBackup
                          ? t('ui.lastBackup', { time: new Date(backupStatus.lastBackup.created).toLocaleString() })
                          : t('ui.noBackupsYet')}
                      </span>
                    </div>
                  </div>
                )}

                {/* Scheduled Backups */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label className="text-base">{t('scheduledBackups')}</Label>
                      <p className="text-sm text-muted-foreground">
                        {t('ui.scheduledBackupsDescription')}
                      </p>
                    </div>
                    <Switch
                      checked={backupStatus?.enabled || false}
                      onCheckedChange={toggleBackupEnabled}
                      disabled={backupLoading}
                      aria-label={t('labels.enableScheduledBackups')}
                    />
                  </div>

                  {backupStatus?.enabled && (
                    <div className="grid grid-cols-1 gap-4 border-l-2 border-primary/20 pl-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="backup-schedule">{t('schedule')}</Label>
                        <Input
                          id="backup-schedule"
                          value={backupSchedule}
                          onChange={(e) => setBackupSchedule(e.target.value)}
                          placeholder={t('placeholders.cronSchedule')}
                          className="font-mono"
                          maxLength={100}
                        />
                        <p className="text-xs text-muted-foreground">
                          {t('ui.cronDescription')}
                        </p>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="backup-max">{t('maxBackupsToKeep')}</Label>
                        <Input
                          id="backup-max"
                          type="number"
                          min={1}
                          max={100}
                          value={backupMaxCount}
                          onChange={(e) =>
                            setBackupMaxCount(parseInt(e.target.value) || 10)
                          }
                          onBlur={(e) => {
                            const v = parseInt(e.target.value);
                            if (!Number.isFinite(v) || v < 1)
                              setBackupMaxCount(1);
                            else if (v > 100) setBackupMaxCount(100);
                          }}
                          onWheel={(e) => e.currentTarget.blur()}
                          className="max-w-24"
                          inputMode="numeric"
                        />
                        <p className="text-xs text-muted-foreground">
                          {t('ui.maxBackupsDescription')}
                        </p>
                      </div>
                      <div className="sm:col-span-2">
                        <Button
                          onClick={handleSaveBackupSettings}
                          disabled={backupLoading}
                          variant="outline"
                          size="sm"
                        >
                          {backupLoading && (
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          )}
                          {t('ui.saveScheduleSettings')}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Backup List */}
                <div className="space-y-2">
                  <p className="text-base font-medium">{t('existingBackups')}</p>
                  {backups.length === 0 ? (
                    <EmptyState
                      compact
                      type="empty"
                      title={t('backups.noBackups')}
                      description={t('ui.noBackupsDescription')}
                    />
                  ) : (
                    <ScrollArea className="h-[200px] rounded-lg border">
                      <div className="p-2 space-y-2">
                        {backups.map((backup) => (
                          <div
                            key={backup.name}
                            className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <Archive className="w-4 h-4 text-primary flex-shrink-0" />
                              <div className="min-w-0">
                                <p className="text-sm font-medium truncate">
                                  {backup.name}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {formatBytes(backup.size)} •{" "}
                                  {new Date(backup.created).toLocaleString()}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <AlertDialog
                                open={restoreConfirmBackup === backup.name}
                                onOpenChange={(open) =>
                                  !open && setRestoreConfirmBackup(null)
                                }
                              >
                                <AlertDialogTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                      setRestoreConfirmBackup(backup.name)
                                    }
                                    disabled={restoringBackup !== null}
                                    className="text-warning hover:text-warning hover:bg-warning/10"
                                    title={t('backups.restoreTooltip')}
                                  >
                                    {restoringBackup === backup.name ? (
                                      <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : (
                                      <RotateCcw className="w-4 h-4" />
                                    )}
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle className="flex items-center gap-2">
                                      <AlertTriangle className="w-5 h-5 text-warning" />
                                      {t('ui.restoreBackup')}
                                    </AlertDialogTitle>
                                    <AlertDialogDescription className="text-left space-y-2">
                                      <p>
                                        {t('ui.restoreBackupPrefix')}{" "}
                                         <strong>{backup.name}</strong> {t('and')}{" "}
                                         <strong>{t('overwrite')}</strong> {t('ui.currentWorldData')}.
                                      </p>
                                      <ul className="list-disc list-inside text-sm space-y-1">
                                        <li>
                                          {t('ui.serverMustBe')}{" "}
                                          <strong>{t('stopped')}</strong>
                                        </li>
                                        <li>
                                          {t('ui.preRestoreBackupCreated')}
                                        </li>
                                        <li>{t('thisCannotBeUndone')}</li>
                                      </ul>
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>
                                      {t('cancel')}
                                    </AlertDialogCancel>
                                    <AlertDialogAction
                                      onClick={() =>
                                        handleRestoreBackup(backup.name)
                                      }
                                      className="bg-warning text-warning-foreground hover:bg-warning/90"
                                    >
                                      {t('ui.restoreBackup')}
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  backupApi.downloadBackup(backup.name)
                                }
                              >
                                <Download className="w-4 h-4" />
                              </Button>
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>
                                      {t('ui.deleteBackup')}
                                    </AlertDialogTitle>
                                    <AlertDialogDescription>
                                      {t('ui.deleteBackupConfirm', { name: backup.name })}
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>
                                      {t('cancel')}
                                    </AlertDialogCancel>
                                    <AlertDialogAction
                                      onClick={() =>
                                        handleDeleteBackup(backup.name)
                                      }
                                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                    >
                                      {t('ui.deleteBackup')}
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </div>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  )}
                </div>

                {/* Path Info */}
                {backupStatus?.savesPath && (
                  <div className="text-xs text-muted-foreground space-y-1">
                    <p>
                      <strong>{t('saves')}</strong> {backupStatus.savesPath}
                    </p>
                    <p>
                      <strong>{t('backupsLabel')}</strong> {backupStatus.backupsPath}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="security" className="mt-0">
            {/* Security & Authentication */}
            <Card id="settings-security">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-2">
                  <Shield className="w-4 h-4 text-primary" />
                  {t('ui.securityAuthentication')}
                </CardTitle>
                <CardDescription>
                  {t('ui.securityAuthenticationDescription')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Account Info */}
                {authEnabled && user && (
                  <div className="p-4 rounded-xl bg-muted/50 space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                        <User className="w-4 h-4 text-primary" />
                      </div>
                      <div>
                        <p className="font-medium">{user.username}</p>
                        <p className="text-xs text-muted-foreground capitalize">
                          {user.role}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Change Password */}
                {authEnabled && (
                  <div className="space-y-4">
                    <p className="text-base font-medium">{t('changePassword')}</p>
                    <form
                      className="max-w-sm space-y-3"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (changingPassword) return;
                        if (
                          !currentPassword ||
                          !newPassword ||
                          !confirmPassword
                        )
                          return;
                        if (newPassword !== confirmPassword) return;
                        if (newPassword.length < 6) return;
                        handleChangePassword();
                      }}
                    >
                      {/* Hidden username helps password managers associate creds */}
                      <input
                        type="text"
                        name="username"
                        value={user?.username || ""}
                        autoComplete="username"
                        readOnly
                        hidden
                      />
                      <div className="relative">
                        <Input
                          type={showCurrentPassword ? "text" : "password"}
                          value={currentPassword}
                          onChange={(e) => setCurrentPassword(e.target.value)}
                          placeholder={t('placeholders.currentPassword')}
                          className="h-11 pr-10"
                          maxLength={128}
                          autoComplete="current-password"
                          aria-label={t('labels.currentPassword')}
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setShowCurrentPassword(!showCurrentPassword)
                          }
                          className="absolute right-3 inset-y-0 flex items-center text-muted-foreground hover:text-foreground"
                          aria-label={
                            showCurrentPassword
                              ? t('ui.hidePassword')
                              : t('ui.showPassword')
                          }
                        >
                          {showCurrentPassword ? (
                            <EyeOff className="w-4 h-4" />
                          ) : (
                            <Eye className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                      <div className="relative">
                        <Input
                          type={showNewPassword ? "text" : "password"}
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          placeholder={t('placeholders.newPassword')}
                          className="h-11 pr-10"
                          maxLength={128}
                          autoComplete="new-password"
                          aria-label={t('labels.newPassword')}
                        />
                        <button
                          type="button"
                          onClick={() => setShowNewPassword(!showNewPassword)}
                          className="absolute right-3 inset-y-0 flex items-center text-muted-foreground hover:text-foreground"
                          aria-label={
                            showNewPassword ? t('ui.hidePassword') : t('ui.showPassword')
                          }
                        >
                          {showNewPassword ? (
                            <EyeOff className="w-4 h-4" />
                          ) : (
                            <Eye className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                      <Input
                        type={showNewPassword ? "text" : "password"}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder={t('placeholders.confirmPassword')}
                        className="h-11"
                        maxLength={128}
                        autoComplete="new-password"
                        aria-label={t('labels.confirmPassword')}
                      />
                      {newPassword &&
                        confirmPassword &&
                        newPassword !== confirmPassword && (
                          <p
                            className="text-xs text-destructive flex items-center gap-1"
                            role="alert"
                          >
                            <XCircle className="w-3 h-3" /> {t('ui.passwordsDoNotMatch')}
                          </p>
                        )}
                      {newPassword && newPassword.length < 6 && (
                        <p
                          className="text-xs text-destructive flex items-center gap-1"
                          role="alert"
                        >
                          <XCircle className="w-3 h-3" /> {t('ui.passwordMinLength')}
                        </p>
                      )}
                      <Button
                        type="submit"
                        disabled={
                          changingPassword ||
                          !currentPassword ||
                          !newPassword ||
                          !confirmPassword ||
                          newPassword !== confirmPassword ||
                          newPassword.length < 6
                        }
                        className="gap-2"
                      >
                        {changingPassword ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Key className="w-4 h-4" />
                        )}
                        {changingPassword ? t('ui.changing') : t('changePassword')}
                      </Button>
                    </form>

                    <div className="max-w-2xl rounded-xl border border-border/70 bg-muted/35 p-4 text-sm">
                      <div className="space-y-2">
                        <div>
                          <p className="font-medium">{t('latest.recoveryCodes')}</p>
                          <p className="text-sm text-muted-foreground">{t('latest.recoveryCodesDescription')}</p>
                        </div>
                        {recoveryCodeStatus && (
                          <p className="text-xs text-muted-foreground">
                            {t('latest.recoveryCodesStatus', {
                              remaining: recoveryCodeStatus.remaining,
                              total: recoveryCodeStatus.total,
                            })}
                          </p>
                        )}
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => void handleGenerateRecoveryCodes()}
                          disabled={generatingRecoveryCodes}
                          className="gap-2"
                        >
                          {generatingRecoveryCodes ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Key className="h-4 w-4" />
                          )}
                          {generatingRecoveryCodes
                            ? t('latest.generatingRecoveryCodes')
                            : t('latest.generateRecoveryCodes')}
                        </Button>
                        {generatedRecoveryCodes.length > 0 && (
                          <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3">
                            <p className="text-xs font-medium text-warning">{t('latest.recoveryCodesSaveNow')}</p>
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                              {generatedRecoveryCodes.map((code) => (
                                <code key={code} className="rounded bg-background px-2 py-1 text-center text-xs">
                                  {code}
                                </code>
                              ))}
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="gap-2"
                              onClick={() => {
                                const blob = new Blob([generatedRecoveryCodes.join("\\n")], { type: "text/plain;charset=utf-8" });
                                const url = URL.createObjectURL(blob);
                                const link = document.createElement("a");
                                link.href = url;
                                link.download = "zomboid-panel-recovery-codes.txt";
                                link.click();
                                URL.revokeObjectURL(url);
                              }}
                            >
                              <Download className="h-4 w-4" />
                              {t('latest.downloadRecoveryCodes')}
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="max-w-2xl rounded-xl border border-border/70 bg-muted/35 p-4 text-sm text-muted-foreground">
                      <div className="flex items-start gap-3">
                        <Info className="mt-0.5 h-4 w-4 text-primary" />
                        <div className="space-y-1.5 leading-6">
                          <p className="font-medium text-foreground">
                            {t('ui.recoveryWhenPasswordLost')}
                          </p>
                          {localPasswordResetSupported ? (
                            <>
                              <p>
                                {t('ui.localPasswordRecoveryDescription')}
                              </p>
                              <div className="flex flex-col gap-2 pt-1 sm:flex-row">
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="sm:w-auto"
                                  onClick={() =>
                                    void handlePrepareLocalPasswordReset()
                                  }
                                  disabled={
                                    preparingLocalPasswordReset ||
                                    resettingLocalPassword
                                  }
                                >
                                  {preparingLocalPasswordReset ? (
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                  ) : (
                                    <Key className="mr-2 h-4 w-4" />
                                  )}
                                  {showLocalPasswordReset
                                    ? t('ui.refreshLocalRecovery')
                                    : t('ui.resetPasswordOnThisServer')}
                                </Button>
                                {showLocalPasswordReset && (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    className="sm:w-auto"
                                    onClick={() => {
                                      setShowLocalPasswordReset(false);
                                      setLocalPasswordResetToken("");
                                      setLocalPasswordResetPassword("");
                                      setLocalPasswordResetConfirm("");
                                    }}
                                    disabled={
                                      preparingLocalPasswordReset ||
                                      resettingLocalPassword
                                    }
                                  >
                                    {t('ui.hide')}
                                  </Button>
                                )}
                              </div>
                              {showLocalPasswordReset && (
                                <form
                                  className="max-w-sm space-y-3 pt-2"
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    if (resettingLocalPassword) return;
                                    void handleResetLostPassword();
                                  }}
                                >
                                  <div className="relative">
                                    <Input
                                      type={
                                        showLocalResetPassword
                                          ? "text"
                                          : "password"
                                      }
                                      value={localPasswordResetPassword}
                                      onChange={(e) =>
                                        setLocalPasswordResetPassword(
                                          e.target.value,
                                        )
                                      }
                                      placeholder={t('placeholders.newPassword')}
                                      className="h-11 pr-10"
                                      maxLength={128}
                                      autoComplete="new-password"
                                      aria-label={t('labels.newPasswordLocalReset')}
                                    />
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setShowLocalResetPassword(
                                          !showLocalResetPassword,
                                        )
                                      }
                                      className="absolute right-3 inset-y-0 flex items-center text-muted-foreground hover:text-foreground"
                                      aria-label={
                                        showLocalResetPassword
                                          ? t('ui.hidePassword')
                                          : t('ui.showPassword')
                                      }
                                    >
                                      {showLocalResetPassword ? (
                                        <EyeOff className="w-4 h-4" />
                                      ) : (
                                        <Eye className="w-4 h-4" />
                                      )}
                                    </button>
                                  </div>
                                  <Input
                                    type={
                                      showLocalResetPassword
                                        ? "text"
                                        : "password"
                                    }
                                    value={localPasswordResetConfirm}
                                    onChange={(e) =>
                                      setLocalPasswordResetConfirm(
                                        e.target.value,
                                      )
                                    }
                                    placeholder={t('placeholders.confirmPassword')}
                                    className="h-11"
                                    maxLength={128}
                                    autoComplete="new-password"
                                    aria-label={t('labels.confirmNewPasswordLocalReset')}
                                  />
                                  {localPasswordResetPassword &&
                                    localPasswordResetConfirm &&
                                    localPasswordResetPassword !==
                                      localPasswordResetConfirm && (
                                      <p
                                        className="text-xs text-destructive flex items-center gap-1"
                                        role="alert"
                                      >
                                        <XCircle className="w-3 h-3" />{" "}
                                        {t('ui.passwordsDoNotMatch')}
                                      </p>
                                    )}
                                  {localPasswordResetPassword &&
                                    localPasswordResetPassword.length < 6 && (
                                      <p
                                        className="text-xs text-destructive flex items-center gap-1"
                                        role="alert"
                                      >
                                        <XCircle className="w-3 h-3" /> {t('ui.passwordMinLength')}
                                      </p>
                                    )}
                                  <Button
                                    type="submit"
                                    className="gap-2"
                                    disabled={
                                      resettingLocalPassword ||
                                      preparingLocalPasswordReset ||
                                      !localPasswordResetPassword ||
                                      !localPasswordResetConfirm ||
                                      localPasswordResetPassword !==
                                        localPasswordResetConfirm ||
                                      localPasswordResetPassword.length < 6
                                    }
                                  >
                                    {resettingLocalPassword ? (
                                      <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : (
                                      <Key className="w-4 h-4" />
                                    )}
                                    {resettingLocalPassword
                                      ? t('ui.resetting')
                                      : t('ui.resetPasswordAndSignOut')}
                                  </Button>
                                </form>
                              )}
                            </>
                          ) : (
                            <>
                              <p>
                                {t('ui.passwordRecoveryUnavailable')}{" "}
                                <span className="font-mono text-foreground/85">
                                  data/reset-token.txt
                                </span>{" "}
                                {t('ui.passwordRecoveryOrStart')}{" "}
                                <span className="font-mono text-foreground/85">
                                  --reset-password
                                </span>
                                。
                              </p>
                              <p>
                                {t('ui.passwordRecoveryTokenDescription')}
                              </p>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Security Tips */}
                <div className="space-y-3 text-sm text-muted-foreground pt-2 border-t">
                  <p>
                    <strong className="text-foreground">{t('rconSecurity')}</strong>{" "}
                    {t('ui.rconSecurityDescription')}
                  </p>
                  <p>
                    <strong className="text-foreground">{t('adminCommands')}</strong>{" "}
                    {t('ui.adminCommandsDescription')}
                  </p>
                  {!authEnabled && (
                    <p>
                      <strong className="text-foreground">
                        {t('ui.authenticationLabel')}
                      </strong>{" "}
                      {t('ui.authenticationNotConfigured')}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="about" className="mt-0">
            {/* About */}
            <Card id="settings-about">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-2">
                  <Server className="w-4 h-4 text-primary" />
                  {t('about.title')}
                </CardTitle>
                <CardDescription>
                  {t('ui.aboutDescription')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                {/* Version row */}
                <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                        {t('ui.installedVersion')}
                      </p>
                      <p className="text-lg font-semibold tabular-nums">
                        v{panelUpdateStatus?.currentVersion || "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                        {t('ui.latestAvailable')}
                      </p>
                      <p className="text-lg font-semibold tabular-nums flex items-center gap-2">
                        {panelUpdateStatus?.latestVersion ? (
                          <>
                            v{panelUpdateStatus.latestVersion}
                            {panelUpdateStatus.updateAvailable && (
                              <span className="inline-flex items-center gap-1 rounded-full border border-warning/50 bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
                                {t('ui.updateAvailableStatus')}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground text-base font-normal">
                            {t('ui.notCheckedYet')}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Description */}
                <p className="text-sm text-muted-foreground">
                  {t('ui.aboutProductDescription')}
                </p>

                {/* Support */}
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="w-9 h-9 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
                      <Heart
                        className="w-4 h-4 text-primary"
                        aria-hidden="true"
                      />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{t('enjoyingThePanel')}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('ui.supportDescription')}
                      </p>
                    </div>
                  </div>
                  <a
                    href="https://ko-fi.com/fpsacha"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#FF5E5B] px-4 py-2 text-sm font-medium text-white hover:bg-[#FF4541] transition-colors shrink-0 shadow-sm"
                    aria-label={t('about.buyMeCoffee')}
                  >
                    <Coffee className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('about.buyMeCoffee')}
                  </a>
                </div>

                {/* Links */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                  <a
                    href="https://discord.gg/jHsWJDNmSg"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 rounded-lg border border-[#5865F2]/40 bg-[#5865F2]/10 px-3 py-2 text-sm text-[#5865F2] hover:bg-[#5865F2]/20 transition-colors"
                  >
                    <MessageCircle className="w-3.5 h-3.5" />
                    {t('ui.joinDiscord')}
                  </a>
                  <a
                    href="https://github.com/fpsacha/zomboid-control-panel"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                    {t('ui.githubRepository')}
                  </a>
                  <a
                    href="https://github.com/fpsacha/zomboid-control-panel/releases"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                    {t('ui.releasesChangelog')}
                  </a>
                  <a
                    href="https://github.com/fpsacha/zomboid-control-panel/issues"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                    {t('about.reportIssue')}
                  </a>
                </div>

                <div className="pt-4 border-t border-border/40 text-xs text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span>{t('builtWithReactNodejsAndSocketio')}</span>
                  <span aria-hidden="true">·</span>
                  <span>{t('mitLicensed')}</span>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </div>
      </Tabs>

      <AlertDialog
        open={pendingCorsLanDisable}
        onOpenChange={setPendingCorsLanDisable}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('lockYourselfOutOfThePanel')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('ui.corsLockoutDescription', {
                privateOrigins: t('allowPrivatelanOrigins'),
                allOrigins: t('allowAllOrigins'),
              })}
              <br />
              <br />
              {t('ui.corsLockoutRecovery')}
              <code className="mx-1">CORS_ORIGINS</code>{" "}
              {t('ui.corsLockoutRecoverySuffix')} ({t('ui.example')}{" "}
              <code>CORS_ORIGINS=https://panel.example.com</code>).
              <br />
              <br />
              {t('ui.corsLockoutOriginHint')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('keepLanAccessOn')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                updateSetting("corsAllowPrivateNetworks", false);
                setPendingCorsLanDisable(false);
              }}
            >
              {t('ui.disableAnyway')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Workshop Collection Sync card.
 *
 * Lets the admin keep a personal Steam Workshop collection mirrored against
 * the panel's tracked-mod list. Reading the collection is free (public Steam
 * API). Writing requires the user's `sessionid` + `steamLoginSecure` cookies
 * because Steam exposes no public OAuth for collection edits — same hack
 * used by every PZ collection-sync tool out there.
 *
 * The cookie pair is treated as a secret: it's masked in API responses
 * (server-side `SENSITIVE_KEYS`) and kept off-screen by default behind a
 * show/hide toggle here.
 */
function WorkshopCollectionSyncCard({
  settings,
  updateSetting,
}: {
  settings: AppSettings;
  updateSetting: (
    key: keyof AppSettings,
    value: AppSettings[keyof AppSettings],
  ) => void;
}) {
  const { t } = useTranslation('settings');
  const { toast } = useToast();
  const [diff, setDiff] = useState<Awaited<
    ReturnType<typeof modsApi.collectionDiff>
  > | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffCheckedAt, setDiffCheckedAt] = useState<Date | null>(null);
  const [browsers, setBrowsers] = useState<Awaited<
    ReturnType<typeof modsApi.collectionBrowsers>
  > | null>(null);
  const [extractingFrom, setExtractingFrom] = useState<string | null>(null);
  const [extensionInfoOpen, setExtensionInfoOpen] = useState(false);
  const [downloadingExt, setDownloadingExt] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [showCookies, setShowCookies] = useState(false);

  // Unified mod table state.
  // Filter defaults to "missing" so the page lands on actionable rows;
  // user can switch to "all" / "tracked" / "collection" to inspect.
  const [itemFilter, setItemFilter] = useState<
    | "all"
    | "missing"
    | "not-on-server"
    | "tracked-only"
    | "synced"
    | "tracked"
    | "collection"
  >("missing");
  const [itemSearch, setItemSearch] = useState("");
  // Per-row busy flag: { [workshopId]: 'add' | 'remove' | 'track' | 'untrack' | 'purge' | null }
  const [rowBusy, setRowBusy] = useState<Record<string, string | null>>({});
  const [purgeTarget, setPurgeTarget] = useState<{
    workshopId: string;
    name: string | null;
  } | null>(null);

  // Trust the server's credential check over a brittle bullet-prefix sniff:
  // the diff endpoint reports `hasCredentials` based on the actual stored
  // values (post-mask). Until the first diff loads, fall back to a heuristic
  // so the UI doesn't flicker "Not configured" on page load.
  const credsConfigured = (() => {
    if (diff && typeof diff.hasCredentials === "boolean")
      return diff.hasCredentials;
    const a = settings.steamSessionId || "";
    const b = settings.steamLoginSecure || "";
    return (
      (a.startsWith("•") || a.length >= 8) &&
      (b.startsWith("•") || b.length >= 16)
    );
  })();

  const collectionId = (settings.workshopCollectionId || "").trim();
  const collectionIdValid = /^\d{1,15}$/.test(collectionId);
  const autoSyncOn = !!settings.workshopCollectionAutoSync;

  // ── Paste helper for Steam cookies ──────────────────────────────────────
  // `steamLoginSecure` is HttpOnly, so a bookmarklet on steamcommunity.com
  // cannot read it (Steam set it that way on purpose). The least-painful
  // workaround is: user opens DevTools → Network → right-clicks any
  // request to steamcommunity.com → "Copy as cURL", and pastes the whole
  // blob here. We extract the two cookie values from the `Cookie:` header.
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);

  // navigator.clipboard.readText() requires a secure context. The panel
  // commonly runs over plain HTTP on LAN, where the API is undefined.
  // Detect once at mount so we can hide the button instead of showing a
  // confusing failure when the user clicks it.
  const clipboardReadAvailable =
    typeof navigator !== "undefined" &&
    !!navigator.clipboard &&
    typeof navigator.clipboard.readText === "function" &&
    (window.isSecureContext ||
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1");

  const safeDecode = (v: string): string => {
    // decodeURIComponent throws on stray `%` (e.g. paste contained a
    // mid-rotation cookie). Fall back to the raw value rather than
    // crashing the parse.
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };

  const parseCookieBlob = (
    raw: string,
  ): { sessionId?: string; loginSecure?: string; error?: string } => {
    if (!raw || !raw.trim()) return { error: t('collection.nothingToParse') };
    const text = raw.replace(/\r/g, "");
    // Accept any of: full cURL command, raw `Cookie:` header line,
    // a `sessionid=...; steamLoginSecure=...` snippet, DevTools
    // "Copy → Response Cookies" tab-separated values, or a Netscape
    // cookies.txt export (name and value separated by a tab).
    const sessionMatch = text.match(
      /(?:^|[;\s'"])sessionid\s*[=:\t]\s*([A-Za-z0-9_%-]+)/i,
    );
    const loginMatch = text.match(
      /(?:^|[;\s'"])steamLoginSecure\s*[=:\t]\s*([A-Za-z0-9_%|+/=.-]+)/i,
    );
    if (!sessionMatch && !loginMatch) {
      return { error: t('collection.cookiesNotFoundInText') };
    }
    const result: { sessionId?: string; loginSecure?: string } = {};
    if (sessionMatch) result.sessionId = safeDecode(sessionMatch[1]);
    if (loginMatch) result.loginSecure = safeDecode(loginMatch[1]);
    return result;
  };

  const handlePasteApply = () => {
    setPasteError(null);
    const parsed = parseCookieBlob(pasteText);
    if (parsed.error) {
      setPasteError(parsed.error);
      return;
    }
    if (!parsed.sessionId && !parsed.loginSecure) {
      setPasteError(t('collection.nothingUsable'));
      return;
    }
    if (parsed.sessionId) updateSetting("steamSessionId", parsed.sessionId);
    if (parsed.loginSecure)
      updateSetting("steamLoginSecure", parsed.loginSecure);
    const both = parsed.sessionId && parsed.loginSecure;
    toast({
      title: both ? t('collection.cookiesExtracted') : t('collection.partialExtraction'),
      description: both
        ? t('collection.cookiesExtractedDescription')
        : t('collection.partialExtractionDescription', { cookie: parsed.sessionId ? 'sessionid' : 'steamLoginSecure' }),
      variant: both ? "default" : "destructive",
    });
    setPasteText("");
    setPasteOpen(false);
  };

  const handlePasteFromClipboard = async () => {
    setPasteError(null);
    if (!clipboardReadAvailable) {
      setPasteOpen(true);
      setPasteError(
        t('collection.clipboardNeedsSecureContext'),
      );
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        setPasteOpen(true);
        setPasteError(t('collection.clipboardEmpty'));
        return;
      }
      const parsed = parseCookieBlob(text);
      if (parsed.sessionId && parsed.loginSecure) {
        updateSetting("steamSessionId", parsed.sessionId);
        updateSetting("steamLoginSecure", parsed.loginSecure);
        toast({
          title: t('collection.cookiesExtractedFromClipboard'),
          description: t('collection.saveSettingsReminder'),
        });
        setPasteText("");
        setPasteOpen(false);
        return;
      }
      // Partial / no match: surface the textarea so the user can see what
      // was pasted and either fix it or grab the missing piece manually.
      setPasteText(text);
      setPasteOpen(true);
      setPasteError(
        parsed.error || t('collection.cookiesNotFoundInClipboard'),
      );
    } catch (err: any) {
      setPasteOpen(true);
      setPasteError(
        err?.message || t('collection.clipboardReadFailed'),
      );
    }
  };

  const refreshDiffSeqRef = useRef(0);
  const refreshDiff = useCallback(async () => {
    if (!collectionIdValid) return;
    const seq = ++refreshDiffSeqRef.current;
    setDiffLoading(true);
    setDiffError(null);
    try {
      const r = await modsApi.collectionDiff();
      // A newer call started after us — drop this stale result.
      if (seq !== refreshDiffSeqRef.current) return;
      setDiff(r);
      setDiffCheckedAt(new Date());
      if (!r.ok && r.error) setDiffError(r.error);
    } catch (err: any) {
      if (seq !== refreshDiffSeqRef.current) return;
      setDiffError(err?.message || t('collection.readFailed'));
    } finally {
      if (seq === refreshDiffSeqRef.current) setDiffLoading(false);
    }
  }, [collectionIdValid, t]);

  // Auto-load the diff once when the card mounts with a valid collection ID.
  // Cheap public API, gives the user immediate context without clicking.
  useEffect(() => {
    if (collectionIdValid && !diff && !diffLoading && !diffError) {
      refreshDiff();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionIdValid]);

  // Probe which local browsers we can read cookies from. Cheap, just a
  // filesystem check on the panel host. Runs once on mount.
  useEffect(() => {
    let cancelled = false;
    modsApi
      .collectionBrowsers()
      .then((r) => {
        if (!cancelled) setBrowsers(r);
      })
      .catch(() => {
        /* not fatal — the section just won't appear */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAutoExtract = async (browserId: string, label: string) => {
    if (extractingFrom) return;
    setExtractingFrom(browserId);
    try {
      const r = await modsApi.collectionExtractCookies(browserId);
      if (r.ok && r.sessionid && r.steamLoginSecure) {
        updateSetting("steamSessionId", r.sessionid);
        updateSetting("steamLoginSecure", r.steamLoginSecure);
        toast({
          title: t('collection.cookiesExtractedFromBrowser', { browser: label }),
          description:
            r.notes && r.notes.length > 0
              ? r.notes[0]
              : t('collection.saveSettingsReminder'),
        });
      } else {
        toast({
          variant: "destructive",
          title: t('collection.browserExtractionFailed', { browser: label }),
          description: r.error || t('collection.unknownFailure'),
        });
      }
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: t('collection.browserExtractionFailed', { browser: label }),
        description: err?.message || t('collection.requestFailed'),
      });
    } finally {
      setExtractingFrom(null);
    }
  };

  // Browser detection from User-Agent — used to tailor the extension
  // install instructions to whatever the admin is using right now.
  // Order matters: Edge/Brave/Opera UA also contain "Chrome".
  const detectedBrowser:
    | "firefox"
    | "edge"
    | "brave"
    | "opera"
    | "chrome"
    | "safari"
    | "other" = (() => {
    if (typeof navigator === "undefined") return "other";
    const ua = navigator.userAgent;
    if (/Firefox\//i.test(ua)) return "firefox";
    // Brave only differentiates via navigator.brave at runtime — UA mimics Chrome.
    const nav: any = navigator;
    if (nav?.brave?.isBrave) return "brave";
    if (/Edg\//i.test(ua)) return "edge";
    if (/OPR\/|Opera/i.test(ua)) return "opera";
    if (/Chrome\//i.test(ua)) return "chrome";
    if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return "safari";
    return "other";
  })();

  const extensionsUrl = ((): string => {
    switch (detectedBrowser) {
      case "firefox":
        return "about:debugging#/runtime/this-firefox";
      case "edge":
        return "edge://extensions";
      case "brave":
        return "brave://extensions";
      case "opera":
        return "opera://extensions";
      case "chrome":
        return "chrome://extensions";
      default:
        return "chrome://extensions";
    }
  })();

  const extensionsUrlLabel = ((): string => {
    switch (detectedBrowser) {
      case "firefox":
        return "about:debugging";
      case "edge":
        return "edge://extensions";
      case "brave":
        return "brave://extensions";
      case "opera":
        return "opera://extensions";
      case "chrome":
        return "chrome://extensions";
      default:
        return "chrome://extensions";
    }
  })();

  const browserLabel = ((): string => {
    switch (detectedBrowser) {
      case "firefox":
        return "Firefox";
      case "edge":
        return "Edge";
      case "brave":
        return "Brave";
      case "opera":
        return "Opera";
      case "chrome":
        return "Chrome";
      case "safari":
        return "Safari";
      default:
        return "your browser";
    }
  })();

  const copyToClipboard = async (text: string, label: string) => {
    try {
      let copiedToClipboard = false;
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          copiedToClipboard = true;
        } catch {
          // Firefox on an HTTP panel exposes this API but rejects the write.
          // Fall through to the user-gesture-compatible legacy command.
        }
      }
      if (!copiedToClipboard) {
        const input = document.createElement("textarea");
        input.value = text;
        input.setAttribute("readonly", "");
        input.style.cssText = "position:fixed;opacity:0;pointer-events:none";
        document.body.appendChild(input);
        input.select();
        const copied = document.execCommand("copy");
        input.remove();
        if (!copied) throw new Error(t('collection.clipboardAccessDenied'));
      }
      setCopied(label);
      window.setTimeout(() => setCopied((c) => (c === label ? null : c)), 1800);
    } catch {
      toast({
        variant: "destructive",
        title: t('collection.copyFailed'),
        description: t('collection.copyFailedDescription'),
      });
    }
  };

  // Pulls the bundled extension .zip from the panel itself so the user can
  // install it without going to GitHub. Auth'd via the same bearer token as
  // every other API call.
  const handleDownloadExtension = async () => {
    if (downloadingExt) return;
    setDownloadingExt(true);
    try {
      const token = getAccessToken();
      const res = await fetch("/api/mods/collection/extension-bundle", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        let detail = "";
        try {
          detail = ((await res.json()) as any)?.error || "";
        } catch {
          /* ignore */
        }
        throw new Error(
          detail || t('collection.downloadFailedWithStatus', { status: res.status }),
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "zomboid-panel-extension.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      toast({
        title: t('collection.extensionDownloaded'),
        description: t('collection.extensionDownloadedDescription', { browser: browserLabel }),
      });
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: t('collection.downloadFailed'),
        description: err?.message || t('collection.unknownError'),
      });
    } finally {
      setDownloadingExt(false);
    }
  };

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const r = await modsApi.collectionSync();
      if (r.success) {
        toast({ title: t('collection.collectionSynced'), description: r.message });
      } else {
        const failedItems = Array.isArray(r.errors)
          ? r.errors.map((entry: { title?: string | null; id?: string }) => entry.title || entry.id).filter(Boolean)
          : [];
        toast({
          variant: "destructive",
          title: t('collection.steamRejectedItems'),
          description: failedItems.length > 0 ? `${r.message}: ${failedItems.join(", ")}` : r.message,
        });
      }
      await refreshDiff();
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: t('collection.syncFailed'),
        description: err?.message || t('collection.unknownError'),
      });
    } finally {
      setSyncing(false);
    }
  };
  const handleTest = async () => {
    if (testing) return;
    setTesting(true);
    try {
      const r = await modsApi.collectionTest();
      toast({ title: t('collection.connectionOk'), description: r.message });
      await refreshDiff();
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: t('collection.testFailed'),
        description: err?.message || t('collection.couldNotReach'),
      });
    } finally {
      setTesting(false);
    }
  };

  // ── Unified item table derivation ───────────────────────────────────────
  const allItems = diff?.ok && Array.isArray(diff.items) ? diff.items : [];
  const missingCount = allItems.filter((it) => it.status === "to-add").length;
  const notOnServerCount = allItems.filter(
    (it) => it.status === "collection-only",
  ).length;
  const trackedOnlyCount = allItems.filter(
    (it) => it.status === "tracked-only",
  ).length;
  const syncedCount = allItems.filter((it) => it.status === "synced").length;
  const driftCount = missingCount + notOnServerCount + trackedOnlyCount;
  const inSync = !!diff?.ok && driftCount === 0;
  const filteredItems = allItems.filter((it) => {
    if (itemFilter === "missing" && it.status !== "to-add") return false;
    if (itemFilter === "not-on-server" && it.status !== "collection-only")
      return false;
    if (itemFilter === "tracked-only" && it.status !== "tracked-only")
      return false;
    if (itemFilter === "synced" && it.status !== "synced") return false;
    if (itemFilter === "tracked" && !it.inTracked) return false;
    if (itemFilter === "collection" && !it.inCollection) return false;
    if (itemSearch.trim()) {
      const q = itemSearch.trim().toLowerCase();
      if (
        !it.workshopId.includes(q) &&
        !(it.name || "").toLowerCase().includes(q)
      )
        return false;
    }
    return true;
  });

  // Row-level actions. Optimistic feel: spinner on the clicked button,
  // then re-fetch the diff. Errors surface as toasts and the row remains
  // unchanged because refreshDiff re-reads ground truth from Steam.
  const runRowAction = async (
    workshopId: string,
    action:
      | "add"
      | "remove"
      | "track"
      | "untrack"
      | "add-server"
      | "remove-server"
      | "purge",
    name?: string | null,
  ) => {
    setRowBusy((prev) => ({ ...prev, [workshopId]: action }));
    try {
      if (action === "add") {
        if (!credsConfigured)
          throw new Error(
            t('collection.addCookiesFirst'),
          );
        await modsApi.collectionAddItem(workshopId);
      } else if (action === "remove") {
        if (!credsConfigured)
          throw new Error(
            t('collection.addCookiesFirst'),
          );
        await modsApi.collectionRemoveItem(workshopId);
      } else if (action === "track") {
        await modsApi.trackMod(workshopId);
      } else if (action === "untrack") {
        await modsApi.untrackMod(workshopId);
      } else if (action === "add-server") {
        await modsApi.addToIni(workshopId);
        // Tracking is what drives update checks, so a mod the server now
        // loads should be watched too.
        if (!allItems.find((it) => it.workshopId === workshopId)?.inTracked) {
          await modsApi.trackMod(workshopId);
        }
        toast({
          title: "Added to the server",
          description:
            "Project Zomboid will download and load this mod on the next server restart.",
        });
      } else if (action === "remove-server") {
        await modsApi.batchRemove([workshopId]);
        toast({
          title: "Removed from the server",
          description: diff?.autoSync
            ? "It will also be removed from the Steam collection."
            : "The Steam collection was left unchanged because auto-sync is off.",
        });
      } else if (action === "purge") {
        const r = await modsApi.purgeMod(workshopId, name);
        const done = [
          r.collection.attempted
            ? r.collection.ok
              ? "removed from the collection"
              : `collection not updated (${r.collection.error || "Steam rejected the change"})`
            : null,
          "removed from the server config",
          r.deletedFromDisk ? "deleted from disk" : "no files on disk",
          "untracked and ignored",
        ].filter(Boolean);
        toast({
          title: `Removed ${r.name || workshopId} everywhere`,
          description: `${done.join(", ")}.`,
        });
      }
      await refreshDiff();
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: t('collection.actionFailed'),
        description: err?.message || t('collection.steamRejectedChange'),
      });
    } finally {
      setRowBusy((prev) => {
        const next = { ...prev };
        delete next[workshopId];
        return next;
      });
    }
  };

  return (
    <Card id="settings-workshop-collection">
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <RefreshCw className="w-4 h-4 text-primary" />
          {t('collection.title')}
        </CardTitle>
        <CardDescription>
          {t('collection.description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Collection ID */}
        <div className="space-y-2">
          <Label htmlFor="ws-collection-id" className="text-base">
            {t('collection.collectionId')}
          </Label>
          <Input
            id="ws-collection-id"
            value={settings.workshopCollectionId}
            onChange={(e) =>
              updateSetting("workshopCollectionId", e.target.value.trim())
            }
            placeholder={t('placeholders.phoneExample')}
            className="h-11 max-w-md font-mono"
            maxLength={20}
          />
          <p className="text-sm text-muted-foreground">
            {t('collection.collectionIdDescription')}
          </p>
        </div>

        {/* Auto-sync toggle */}
        <div
          className={`flex items-start justify-between gap-4 rounded-lg border p-4 transition-colors ${
            autoSyncOn && !credsConfigured
              ? "border-warning/40 bg-warning/5"
              : ""
          }`}
        >
          <div className="space-y-1">
            <Label className="text-base">{t('autosyncOnAddRemove')}</Label>
            <p className="text-sm text-muted-foreground">
              {t('collection.autoSyncDescription')}
            </p>
            {autoSyncOn && !credsConfigured && (
              <p className="text-xs text-warning flex items-center gap-1 pt-1">
                <AlertTriangle className="w-3 h-3" />
                {t('collection.autoSyncCookiesRequired')}
              </p>
            )}
            {autoSyncOn && !collectionIdValid && (
              <p className="text-xs text-warning flex items-center gap-1 pt-1">
                <AlertTriangle className="w-3 h-3" />
                {t('collection.collectionIdRequired')}
              </p>
            )}
          </div>
          <Switch
            checked={autoSyncOn}
            onCheckedChange={(v) =>
              updateSetting("workshopCollectionAutoSync", v)
            }
          />
        </div>

        {/* Steam session cookies */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Label className="text-base">{t('steamSessionCookies')}</Label>
            {credsConfigured ? (
              <span className="inline-flex items-center gap-1 rounded border border-success/40 bg-success/10 px-1.5 py-0.5 text-[11px] font-medium text-success">
                <Check className="w-3 h-3" /> {t('ui.configured')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded border border-muted-foreground/30 bg-muted/40 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                {t('ui.notConfigured')}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {t('collection.cookiesRequiredDescription')}
          </p>
          <div className="grid gap-3 sm:grid-cols-2 max-w-3xl">
            <div className="space-y-1">
              <Label
                htmlFor="ws-sessionid"
                className="text-xs text-muted-foreground"
              >
                sessionid
              </Label>
              <Input
                id="ws-sessionid"
                type={showCookies ? "text" : "password"}
                value={settings.steamSessionId}
                onChange={(e) =>
                  updateSetting("steamSessionId", e.target.value.trim())
                }
                placeholder={t('placeholders.cookieHex')}
                className="h-10 font-mono"
                maxLength={64}
              />
            </div>
            <div className="space-y-1">
              <Label
                htmlFor="ws-loginsecure"
                className="text-xs text-muted-foreground"
              >
                steamLoginSecure
              </Label>
              <Input
                id="ws-loginsecure"
                type={showCookies ? "text" : "password"}
                value={settings.steamLoginSecure}
                onChange={(e) =>
                  updateSetting("steamLoginSecure", e.target.value.trim())
                }
                placeholder={t('placeholders.longToken')}
                className="h-10 font-mono"
                maxLength={512}
              />
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowCookies((v) => !v)}
            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            {showCookies ? (
              <EyeOff className="w-3.5 h-3.5" />
            ) : (
              <Eye className="w-3.5 h-3.5" />
            )}
            {showCookies ? t('collection.hideCookies') : t('collection.showCookies')}
          </button>

          {/* Auto-detect from local browser — fastest path when Steam is
              logged in on the same machine the panel runs on. */}
          {browsers &&
            browsers.supported &&
            browsers.browsers.some((b) => b.detected) && (
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 mt-3 space-y-3">
                <div className="flex items-start gap-3">
                  <Zap className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1 space-y-1">
                    <p className="font-medium text-sm">
                      {t('collection.autoDetectBrowser')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('collection.autoDetectBrowserDescription')}{" "}
                      <strong>{t('thisMachine')}</strong>{t('collection.autoDetectBrowserCloseHint')}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {browsers.browsers
                    .filter((b) => b.detected)
                    .map((b) => (
                      <Button
                        key={b.id}
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!!extractingFrom}
                        onClick={() => handleAutoExtract(b.id, b.label)}
                      >
                        {extractingFrom === b.id ? (
                          <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                        ) : (
                          <Check className="w-3.5 h-3.5 mr-1.5" />
                        )}
                        {b.label}
                      </Button>
                    ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {t('collection.browserExtractionNote')}
                </p>
              </div>
            )}

          {/* Browser extension — works regardless of platform or which
              machine Steam is logged in on. Guided install with one-button
              download and copy-to-clipboard helpers for the bits browsers
              won't let us automate (chrome:// nav, extension load). */}
          <div className="rounded-lg border border-primary/40 bg-primary/5 p-4 mt-3 space-y-3">
            <div className="flex items-start gap-3">
              <ExternalLink className="w-4 h-4 text-primary mt-0.5 shrink-0" />
              <div className="flex-1 space-y-1">
                <p className="font-medium text-sm">
                  {t('collection.installExtensionRecommended')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('collection.extensionDescription', { browser: browserLabel })}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="default"
                onClick={handleDownloadExtension}
                disabled={downloadingExt}
              >
                {downloadingExt ? (
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5 mr-1.5" />
                )}
                {t('collection.downloadExtension')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => copyToClipboard(extensionsUrl, "ext-url")}
                title={t('collection.copyExtensionUrlTooltip', { url: extensionsUrlLabel })}
              >
                {copied === "ext-url" ? (
                  <Check className="w-3.5 h-3.5 mr-1.5 text-green-500" />
                ) : (
                  <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                )}
                {t('collection.copyExtensionUrl', { url: extensionsUrlLabel })}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  copyToClipboard(
                    typeof window !== "undefined" ? window.location.origin : "",
                    "panel-url",
                  )
                }
                title={t('browserExtension.copyUrlTooltip')}
              >
                {copied === "panel-url" ? (
                  <Check className="w-3.5 h-3.5 mr-1.5 text-green-500" />
                ) : (
                  <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                )}
                {t('collection.copyPanelUrl')}
              </Button>
            </div>

            {/* Browser-specific load steps. Kept terse — long walls of text
                kill momentum at the "I almost have this working" phase. */}
            <div className="rounded-md border border-border/40 bg-background/40 p-3 text-xs text-muted-foreground space-y-2">
              {detectedBrowser === "firefox" ? (
                <>
                  <p className="font-medium text-foreground">
                    {t('collection.loadIntoFirefox')}
                  </p>
                  <ol className="list-decimal list-inside space-y-1 pl-1">
                    <li>
                      {t('collection.unzipExtension')}
                    </li>
                    <li>
                      {t('collection.pasteFirefoxUrl')}
                    </li>
                    <li>
                      {t('collection.selectManifest', { action: t('loadTemporaryAddon') })}
                    </li>
                    <li>
                      {t('collection.pinExtension')}
                    </li>
                  </ol>
                  <p className="text-[11px]">
                    {t('collection.firefoxNote')}{" "}
                    <a
                      className="underline"
                      href="https://addons.mozilla.org/developers/"
                      target="_blank"
                      rel="noopener"
                    >
                      addons.mozilla.org
                    </a>{" "}
                    {t('collection.firefoxDeveloperNote')}{" "}
                    <code>xpinstall.signatures.required = false</code>.
                  </p>
                </>
              ) : detectedBrowser === "safari" ? (
                <>
                  <p className="font-medium text-foreground">
                    {t('collection.safariUnsupported')}
                  </p>
                  <p>
                    {t('collection.safariDescription')}
                  </p>
                </>
              ) : (
                <>
                  <p className="font-medium text-foreground">
                    {t('collection.loadIntoBrowser', { browser: browserLabel })}
                  </p>
                  <ol className="list-decimal list-inside space-y-1 pl-1">
                    <li>
                      {t('collection.unzipExtension')}
                    </li>
                    <li>
                      {t('collection.pasteBrowserUrl', { url: extensionsUrlLabel })}
                    </li>
                    <li>
                      {t('collection.toggleDeveloperMode', { mode: t('developerMode') })}
                    </li>
                    <li>
                      {t('collection.loadUnpackedFolder', { action: t('loadUnpacked') })}
                    </li>
                    <li>
                      {t('collection.pinExtension')}
                    </li>
                  </ol>
                </>
              )}
              <div className="pt-1 border-t border-border/30 mt-2">
                <p className="font-medium text-foreground mb-1">
                  {t('collection.extensionPopup')}
                </p>
                <ol className="list-decimal list-inside space-y-1 pl-1">
                  <li>
                    {t('collection.pastePanelUrl')}
                  </li>
                  <li>
                    {t('collection.testSteamLogin', { action: t('steamExtension.testLogin') })}
                  </li>
                  <li>
                    {t('collection.sendCookies', { action: t('steamExtension.sendCookies') })}
                  </li>
                </ol>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setExtensionInfoOpen((v) => !v)}
              className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
            >
              {extensionInfoOpen
                ? t('collection.hidePrivacy')
                : t('collection.privacyPermissions')}
            </button>
            {extensionInfoOpen && (
              <p className="text-[11px] text-muted-foreground">
                {t('collection.privacyDescription', { not: t('not') })}
              </p>
            )}
          </div>

          {/* Paste helper — much faster than copying two cookies by hand */}
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 mt-3 space-y-3">
            <div className="flex items-start gap-3">
              <Zap className="w-4 h-4 text-primary mt-0.5 shrink-0" />
              <div className="flex-1 space-y-1">
                <p className="font-medium text-sm">
                  {t('collection.quickSetup')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('collection.httpOnlyDescription')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('collection.preferCookieExporter')}{" "}
                  <a
                    href="https://github.com/kairi003/Get-cookies.txt-LOCALLY"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    {t('collection.cookieExporterName')}
                    <ExternalLink className="w-3 h-3" />
                  </a>{" "}
                  {t('collection.cookieExporterDescription', {
                    netscape: t('steamExtension.netscapeFormat'),
                    header: t('steamExtension.headerStringFormat'),
                  })}
                </p>
              </div>
            </div>

            {!pasteOpen ? (
              <div className="flex flex-wrap gap-2">
                {clipboardReadAvailable && (
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
                    onClick={handlePasteFromClipboard}
                  >
                    <Cloud className="w-3.5 h-3.5 mr-1.5" />
                    {t('collection.pasteFromClipboard')}
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant={clipboardReadAvailable ? "outline" : "default"}
                  onClick={() => {
                    setPasteOpen(true);
                    setPasteError(null);
                  }}
                >
                  {clipboardReadAvailable
                    ? t('collection.pasteManually')
                    : t('collection.pasteCookies')}
                </Button>
                <a
                  href="https://steamcommunity.com/my/myworkshopfiles/?section=collections"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline self-center"
                >
                  {t('collection.openSteamCollections')} <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            ) : (
              <div className="space-y-2">
                <Textarea
                  value={pasteText}
                  onChange={(e) => {
                    setPasteText(e.target.value);
                    setPasteError(null);
                  }}
                  placeholder={t('collection.pastePlaceholder')}
                  rows={4}
                  className="font-mono text-xs"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={handlePasteApply}
                    disabled={!pasteText.trim()}
                  >
                    <Check className="w-3.5 h-3.5 mr-1.5" />
                    {t('collection.extractCookies')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setPasteOpen(false);
                      setPasteText("");
                      setPasteError(null);
                    }}
                  >
                    {t('cancel')}
                  </Button>
                </div>
                {pasteError && (
                  <p className="text-xs text-destructive flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> {pasteError}
                  </p>
                )}
              </div>
            )}

            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                {t('collection.howToGetSteamRequest')}
              </summary>
              <ol className="list-decimal list-inside mt-2 space-y-1 text-muted-foreground pl-1">
                <li>
                  {t('open')}{" "}
                  <a
                    href="https://steamcommunity.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    steamcommunity.com
                  </a>{" "}
                  {t('collection.openSteamLoggedIn')}
                </li>
                <li>
                  {t('press')}{" "}
                  <kbd className="px-1 py-0.5 rounded border bg-muted text-[10px]">
                    F12
                  </kbd>{" "}
                  → <strong>{t('network')}</strong> {t('tab')}.
                </li>
                <li>{t('reloadThePageSoRequestsShowUp')}</li>
                <li>
                  {t('rightClick')} <em>{t('any')}</em> {t('request')} → <strong>{t('copy')}</strong> →{" "}
                  <strong>{t('copyAsCurl')}</strong>.
                </li>
                <li>
                  {t('collection.comeBackAndClick')} <strong>{t('pasteFromClipboard')}</strong>.
                </li>
              </ol>
              <p className="mt-2 text-muted-foreground">
                {t('or')}, {t('manualRoute')}: F12 →{" "}
                <strong>{t('application')}</strong> → <strong>{t('cookies')}</strong> →
                <code className="mx-1">https://steamcommunity.com</code>, {t('copy').toLowerCase()}{" "}
                <code>sessionid</code> {t('and')} <code>steamLoginSecure</code>
                {" "}{t('intoFieldsDirectly')}.
              </p>
            </details>

            <p className="text-[11px] text-warning/90 flex items-start gap-1 pt-1 border-t border-border/30">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              <span>
                {t('collection.cookiesWarning')}
              </span>
            </p>
          </div>
        </div>

        {/* Status / actions */}
        <div className="space-y-2 pt-2 border-t border-border/40">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleTest}
              disabled={!collectionIdValid || !credsConfigured || testing}
              title={
                !credsConfigured
                  ? t('collection.addCookiesFirst')
                  : t('collection.verifyCollection')
              }
            >
              {testing ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
              )}
              {t('collection.testConnection')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={refreshDiff}
              disabled={!collectionIdValid || diffLoading}
            >
              {diffLoading ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              )}
              {t('collection.checkDrift')}
            </Button>
            <Button
              variant={driftCount > 0 ? "default" : "outline"}
              size="sm"
              onClick={handleSync}
              disabled={
                !collectionIdValid ||
                !credsConfigured ||
                syncing ||
                !diff?.ok ||
                driftCount === 0
              }
              title={
                !credsConfigured
                  ? t('collection.addCookiesToWrite')
                  : t('collection.pushChanges', { count: driftCount })
              }
            >
              {syncing ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <Cloud className="w-3.5 h-3.5 mr-1.5" />
              )}
              {t('collection.syncNow')} {driftCount > 0 && `(${driftCount})`}
            </Button>

            <div className="ml-auto text-xs text-muted-foreground">
              {diffError ? (
                <span className="text-destructive flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> {diffError}
                </span>
              ) : !collectionIdValid ? (
                <span>{t('enterACollectionIdToBegin')}</span>
              ) : !diff ? (
                <span>
                  {diffLoading
                    ? t('collection.readingCollection')
                    : t('collection.clickCheckDrift')}
                </span>
              ) : !diff.ok ? (
                <span>{t('couldNotReadCollection')}</span>
              ) : inSync ? (
                <span className="text-success flex items-center gap-1">
                  <Check className="w-3 h-3" /> {t('collection.inSync', { count: diff.inCollection.length })}
                </span>
              ) : (
                <span className="text-warning flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  {t('collection.driftSummary', {
                    add: diff.toAdd.length,
                    remove: diff.toRemove.length,
                  })}
                </span>
              )}
            </div>
          </div>
          {diffCheckedAt && (
            <p className="text-[11px] text-muted-foreground/70">
              {t('collection.lastChecked')} {diffCheckedAt.toLocaleTimeString()}
              {diff?.title && (
                <>
                  {" "}
                  ·{" "}
                  <a
                    href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${collectionId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-foreground underline-offset-2 hover:underline"
                  >
                    {diff.title}
                  </a>
                </>
              )}
              {" · "}
              <span>{t('collection.trackedLocally', { count: diff?.trackedCount ?? 0 })}</span>
            </p>
          )}
        </div>

        {/* Unified mod table — every server + collection mod in one place,
            filterable, with per-row actions applied one at a time. */}
        {diff?.ok && allItems.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-border/40">
            <div className="flex flex-wrap items-center gap-2">
              {/* Filter pills */}
              <div className="flex items-center gap-1 rounded-md border border-border/60 bg-muted/30 p-0.5 text-xs">
                {(
                  [
                    ["missing", t('collection.missingInCollection'), missingCount],
                    ["not-on-server", t('collection.notOnServer'), notOnServerCount],
                    ["tracked-only", t('collection.trackedOnly'), trackedOnlyCount],
                    ["synced", t('collection.inSyncLabel'), syncedCount],
                    ["all", t('collection.all'), allItems.length],
                  ] as const
                )
                  .filter(
                    ([key, , count]) => key !== "tracked-only" || count > 0,
                  )
                  .map(([key, label, count]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setItemFilter(key)}
                      className={cn(
                        "px-2 py-1 rounded-sm transition-colors",
                        itemFilter === key
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                      )}
                    >
                      {label} <span className="opacity-70">({count})</span>
                    </button>
                  ))}
              </div>

              {/* Search */}
              <div className="relative ml-auto">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  value={itemSearch}
                  onChange={(e) => setItemSearch(e.target.value)}
                  placeholder={t('placeholders.filterByName')}
                  className="h-8 pl-7 pr-7 text-xs w-56"
                />
                {itemSearch && (
                  <button
                    type="button"
                    onClick={() => setItemSearch("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={t('labels.clearSearch')}
                  >
                    <XCircle className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Table */}
            <div className="rounded-md border border-border/60 overflow-hidden">
              <div className="max-h-[420px] overflow-auto">
                {filteredItems.length === 0 ? (
                  <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                    {itemSearch
                      ? t('collection.noModsMatch')
                      : t('collection.nothingInFilter')}
                  </div>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted/80 backdrop-blur z-10">
                      <tr className="text-left text-muted-foreground border-b border-border/50">
                        <th className="font-medium px-3 py-2 w-[120px]">
                          {t('collection.status')}
                        </th>
                        <th className="font-medium px-3 py-2">{t('mod')}</th>
                        <th className="font-medium px-3 py-2 w-[540px] text-right">
                          {t('collection.actions')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredItems.map((it) => {
                        const busy = rowBusy[it.workshopId];
                        const statusMeta =
                          it.status === "synced"
                            ? {
                                label: t('collection.inSyncLabel'),
                                cls: "text-success border-success/40 bg-success/10",
                                icon: <Check className="w-3 h-3" />,
                              }
                            : it.status === "to-add"
                              ? {
                                  label: t('collection.missingInCollection'),
                                  cls: "text-warning border-warning/40 bg-warning/10",
                                  icon: <Plus className="w-3 h-3" />,
                                }
                              : it.status === "collection-only"
                                ? {
                                    label: t('collection.notOnServer'),
                                    cls: "text-primary border-primary/40 bg-primary/10",
                                    icon: <Library className="w-3 h-3" />,
                                  }
                                : {
                                    label: t('collection.trackedOnly'),
                                    cls: "text-muted-foreground border-border bg-muted/40",
                                    icon: (
                                      <AlertTriangle className="w-3 h-3" />
                                    ),
                                  };
                        return (
                          <tr
                            key={it.workshopId}
                            className="border-b border-border/30 last:border-b-0 hover:bg-muted/30"
                          >
                            <td className="px-3 py-2 align-top">
                              <span
                                className={cn(
                                  "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium",
                                  statusMeta.cls,
                                )}
                              >
                                {statusMeta.icon}
                                {statusMeta.label}
                              </span>
                            </td>
                            <td className="px-3 py-2 align-top">
                              <div className="flex flex-col min-w-0">
                                <a
                                  href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${it.workshopId}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="truncate text-foreground hover:text-primary hover:underline underline-offset-2 font-medium"
                                  title={it.name || it.workshopId}
                                >
                                  {it.name || (
                                    <span className="font-mono text-muted-foreground">
                                      {it.workshopId}
                                    </span>
                                  )}
                                </a>
                                <div className="flex items-center gap-2 text-[10px] text-muted-foreground/80 font-mono">
                                  <span>{it.workshopId}</span>
                                  <span>·</span>
                                  <span>
                                    {it.inTracked ? t('collection.trackedLower') : t('collection.notTrackedLower')}
                                  </span>
                                  <span>·</span>
                                  <span>
                                    {it.inCollection
                                      ? t('collection.inCollectionLower')
                                      : t('collection.notInCollectionLower')}
                                  </span>
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-2 align-top">
                              <div className="flex items-center justify-end gap-1">
                                {/* Ordered by consequence: what the server
                                    loads, then the collection, then local
                                    tracking, then the destructive one. */}
                                {it.inServer ? (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-[11px] text-destructive hover:text-destructive hover:bg-destructive/10"
                                    onClick={() =>
                                      runRowAction(
                                        it.workshopId,
                                        "remove-server",
                                      )
                                    }
                                    disabled={!!busy}
                                    title={t('collection.removeFromServerTitle')}
                                  >
                                    {busy === "remove-server" ? (
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                      <Server className="w-3 h-3" />
                                    )}
                                    <span className="ml-1">{t('collection.fromServer')}</span>
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-[11px] text-success hover:text-success hover:bg-success/10"
                                    onClick={() =>
                                      runRowAction(it.workshopId, "add-server")
                                    }
                                    disabled={!!busy}
                                    title={t('collection.addToServerTitle')}
                                  >
                                    {busy === "add-server" ? (
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                      <Server className="w-3 h-3" />
                                    )}
                                    <span className="ml-1">{t('collection.toServer')}</span>
                                  </Button>
                                )}
                                {/* Collection side */}
                                {it.inCollection ? (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-[11px] text-destructive hover:text-destructive hover:bg-destructive/10"
                                    onClick={() =>
                                      runRowAction(it.workshopId, "remove")
                                    }
                                    disabled={!!busy || !credsConfigured}
                                    title={
                                      !credsConfigured
                                        ? t('collection.needSteamCookies')
                                        : t('collection.removeFromCollection')
                                    }
                                  >
                                    {busy === "remove" ? (
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                      <Minus className="w-3 h-3" />
                                    )}
                                    <span className="ml-1">
                                      {t('collection.fromCollection')}
                                    </span>
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-[11px] text-success hover:text-success hover:bg-success/10"
                                    onClick={() =>
                                      runRowAction(it.workshopId, "add")
                                    }
                                    disabled={!!busy || !credsConfigured}
                                    title={
                                      !credsConfigured
                                        ? t('collection.needSteamCookies')
                                        : t('collection.addToCollection')
                                    }
                                  >
                                    {busy === "add" ? (
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                      <Plus className="w-3 h-3" />
                                    )}
                                    <span className="ml-1">{t('toCollection')}</span>
                                  </Button>
                                )}
                                {/* Tracked side */}
                                {it.inTracked ? (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                    onClick={() =>
                                      runRowAction(it.workshopId, "untrack")
                                    }
                                    disabled={!!busy}
                                    title={t('modsTracking.untrackTooltip')}
                                  >
                                    {busy === "untrack" ? (
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                      <Bookmark className="w-3 h-3" />
                                    )}
                                    <span className="ml-1">{t('untrack')}</span>
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-[11px] text-muted-foreground hover:text-primary hover:bg-primary/10"
                                    onClick={() =>
                                      runRowAction(it.workshopId, "track")
                                    }
                                    disabled={!!busy}
                                    title={t('modsTracking.trackTooltip')}
                                  >
                                    {busy === "track" ? (
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                      <BookmarkPlus className="w-3 h-3" />
                                    )}
                                    <span className="ml-1">{t('track')}</span>
                                  </Button>
                                )}
                                <span
                                  aria-hidden
                                  className="mx-1 h-4 w-px bg-border"
                                />
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                  onClick={() =>
                                    setPurgeTarget({
                                      workshopId: it.workshopId,
                                      name: it.name,
                                    })
                                  }
                                  disabled={!!busy}
                                  title="Remove from the collection, the server, and disk, then ignore it so it can't come back"
                                >
                                  {busy === "purge" ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <Trash2 className="w-3 h-3" />
                                  )}
                                  <span className="ml-1">Everywhere</span>
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="flex items-center justify-between px-3 py-1.5 border-t border-border/40 bg-muted/20 text-[10px] text-muted-foreground">
                <span>
                  {t('collection.shownOf', { shown: filteredItems.length, total: allItems.length })}
                </span>
                <span className="hidden sm:inline">
                  {t('collection.perRowActions')}
                </span>
              </div>
            </div>
          </div>
        )}
        <AlertDialog
          open={!!purgeTarget}
          onOpenChange={(open) => !open && setPurgeTarget(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('collection.removeEverywhereTitle', { name: purgeTarget?.name || purgeTarget?.workshopId })}
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2">
                  <p>{t('collection.removeEverywhereSummary')}</p>
                  <ul className="list-disc pl-5 space-y-0.5">
                    <li>{t('collection.removeEverywhereSteam')}</li>
                    <li>
                      {t('collection.removeEverywhereServer')} (<code>WorkshopItems</code>, <code>Mods</code>, <code>Map</code>)
                    </li>
                    <li>{t('collection.removeEverywhereDisk')}</li>
                    <li>{t('collection.removeEverywhereTracked')}</li>
                  </ul>
                  <p>{t('collection.removeEverywhereIgnore')}</p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => {
                  const t = purgeTarget;
                  setPurgeTarget(null);
                  if (t) runRowAction(t.workshopId, "purge");
                }}
              >
                {t('collection.removeEverywhere')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

import { useEffect, useState, useCallback, useRef } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useSearchParams, Link as RouterLink } from "react-router-dom";
import {
  Server,
  Link,
  Clock,
  Package,
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
  LogOut,
  Archive,
  Info,
  Trash2,
  Settings2,
  Globe,
  RotateCw,
  Lock,
  User,
  Users as UsersIcon,
  ShieldCheck,
  KeyRound,
  ExternalLink,
  FolderOpen,
  Palette,
  SlidersHorizontal,
  Check,
  Heart,
  Coffee,
  MessageCircle,
  Plus,
  Minus,
  Search,
  Bookmark,
  BookmarkPlus,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { KOFI_URL } from "@/lib/supportLinks";
import { reportClientError } from "@/lib/client-errors";
import { PageHeader } from "@/components/PageHeader";
import { PageSkeleton } from "@/components/PageSkeleton";
import Users from "@/pages/Users";
import RolesPermissions from "@/pages/RolesPermissions";
import OidcSettings from "@/pages/OidcSettings";
import { PasswordInput } from "@/components/PasswordInput";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/NumberInput";
import { Label } from "@/components/ui/label";
import { HelpTip } from "@/components/HelpTip";
import { AutoUpdateResultBanner } from "@/components/AutoUpdateResultBanner";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { SectionCard } from "@/components/ui/section-card";
import { SubNav, SubNavLayout } from "@/components/ui/sub-nav";
import { StatusPill } from "@/components/ui/status-pill";
import { PageAlerts, type PageAlert } from "@/components/PageAlerts";
import { SaveBar } from "@/components/SaveBar";
import { useGuardedNavigate, useUnsavedChangesGuard } from "@/contexts/UnsavedChangesContext";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogBody,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/components/ui/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { DisabledReason } from "@/components/DisabledReason";
import {
  apiFetch,
  handleResponse,
  configApi,
  panelBridgeApi,
  authApi,
  serversApi,
  serverApi,
  panelUpdateApi,
  modsApi,
  ApiError,
  PanelUpdateStatus,
  PanelUpdatePreflight,
  PanelUpdateMessage,
  ServerInstance,
  type SftpHostKeyRefusal,
} from "@/lib/api";
import { getUserErrorMessage } from "@/lib/errorMessage";
import { rememberTrustedDeviceFrom } from "@/lib/trustedDevice";
import { classifyPanelUpdateFailure } from "@/lib/panelUpdateFailure";
import { readRunningPanelPort, resolveRestartOrigin } from "@/lib/panelRestartTarget";
import { extractSaveWarnings } from "@/lib/saveWarnings";
import { resolveRegisteredTranslation } from "@/lib/paramTranslation";
import { autoStartServerIds, withAutoStartServer } from "@/lib/autoStartServers";
import { BYTES_PER_GB, heapOfServers, portConflicts } from "@/lib/serversTogether";
import {
  getAllowOutOfRangeSandboxValues,
  setAllowOutOfRangeSandboxValues,
} from "@/lib/serverConfigSchema";
import {
  detectBridgeStaleness,
  getBridgeStalenessActionLabel,
  getBridgeStalenessBody,
  getBridgeStalenessTitle,
} from "@/lib/bridgeVersionStaleness";
import { useSocket } from "@/contexts/SocketContext";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme, type ThemeName } from "@/contexts/ThemeContext";
import { DateFormatSelect } from "@/components/DateFormatSelect";
import { useDateFormat } from "@/lib/dateFormat";
import { platformTranslationKey, useRuntimeInfo } from "@/hooks/useRuntimeInfo";
import { useRequestGuard } from "@/hooks/useRequestGuard";
import { BridgeStatusBadge } from "@/components/BridgeStatusBadge";
import { bridgeDiagnosticParams, type BridgeDiagnostic } from "@/lib/bridgeDiagnostics";
import { BridgeDeliveryPanel } from "@/components/bridge/BridgeDeliveryPanel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { exceedsPasswordMaxBytes, meetsPasswordMinLength } from "@/lib/passwordPolicy";
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
  panelBridgeSftpConfigPath: string;

  // Server automation
  autoStartServer: boolean;
  autoExportOnLogin: boolean;
  autoExportMaxPerPlayer: string;

  // Mod Checker Settings
  modCheckInterval: string;
  modAutoRestart: boolean;
  modRestartDelay: string;
  serverAutoUpdate: boolean;
  serverAutoUpdateWarningMinutes: string;
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

// The tab each shared setting is edited on, so the section rail can mark the
// tabs that hold unsaved edits (one save bar saves them all).
const SETTING_TAB: Record<keyof AppSettings, string> = {
  panelBridgeAutoUpdate: "bridge",
  panelBridgeSftpEnabled: "bridge",
  panelBridgeSftpHost: "bridge",
  panelBridgeSftpPort: "bridge",
  panelBridgeSftpUsername: "bridge",
  panelBridgeSftpPassword: "bridge",
  panelBridgeSftpBridgePath: "bridge",
  panelBridgeSftpPollIntervalSeconds: "bridge",
  panelBridgeSftpLogPath: "bridge",
  panelBridgeSftpConfigPath: "bridge",
  autoStartServer: "connection",
  autoExportOnLogin: "backups",
  autoExportMaxPerPlayer: "backups",
  modCheckInterval: "mods",
  modAutoRestart: "mods",
  modRestartDelay: "mods",
  serverAutoUpdate: "mods",
  serverAutoUpdateWarningMinutes: "mods",
  steamUpdateAccount: "mods",
  steamApiKey: "mods",
  workshopCollectionId: "mods",
  workshopCollectionAutoSync: "mods",
  steamSessionId: "mods",
  steamLoginSecure: "mods",
  darkMode: "general",
  autoReconnect: "connection",
  reconnectInterval: "connection",
  panelPort: "general",
  httpsEnabled: "https",
  httpsPort: "https",
  httpsKeyPath: "https",
  httpsCertPath: "https",
  corsAllowedOrigins: "access",
  corsAllowAll: "access",
  corsAllowPrivateNetworks: "access",
  corsDebug: "access",
  enablePublicIpLookup: "access",
  lanIpAddress: "access",
};

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

// How long to keep polling for the panel to come back after a restart before
// giving up and saying so. Matches this codebase's STALL_MS convention for
// "may still be running" watchdogs elsewhere (Servers.tsx/uploadBackup)
// rather than inventing a new number -- a Windows binary swap can
// legitimately take a while (AV scanning the new .exe, see index.js's own
// comments on that), so this must read as "hasn't come back yet," not
// "failed," until it genuinely gives up.
const RESTART_RECONNECT_TIMEOUT_MS = 3 * 60 * 1000;
const RESTART_RECONNECT_POLL_INTERVAL_MS = 2000;
// Give the OLD process a moment to actually exit before the first poll --
// otherwise the first request or two just race a socket that's mid-close.
const RESTART_RECONNECT_INITIAL_DELAY_MS = 3000;

// Settings written by other pages are persisted as raw strings, so a stored
// "false" would otherwise read as truthy here.
function toSettingBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

// Same no-locale-file-required pattern as serverConfigSchema.ts's
// translatedOrFallback (see getUnrecognizedSandboxOptionWarning's comment
// there): translates once a future locale change adds this key under
// settings.json, plain English until then, rather than a bare
// useTranslation() key needing a same-day addition to every locale file
// this session isn't authorized to touch.
function settingsFallback(key: string, fallback: string): string {
  return resolveRegisteredTranslation("settings", key, undefined) ?? fallback;
}

// Mirrors server/routes/config.js's own httpsPort range check so the client
// can reject an out-of-range port before submitting -- panelPort has no such
// check on the server at all (unlike its httpsPort sibling), so an
// out-of-range panelPort would otherwise save silently and only surface
// later, on the next restart, as a redirect to a port nothing is listening on.
export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

// Human-friendly age string for bridge diagnostics. Avoids showing the user
// raw seconds counts like "3344627s" which read as gibberish.
function formatBridgeAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

// The SFTP transport's ongoing status (not a caught request failure, so
// getUserErrorMessage's ApiError-shaped input doesn't fit) carries its own
// lastErrorCode alongside the pre-existing English lastError/
// lastErrorGuidance pair -- look up the translated "{{detail}} Fix: ..."
// sentence directly when a code is present, matching the exact classification
// server/services/panelBridgeSftp.js's formatSftpError() already computed for
// the English fallback so the two never disagree about what went wrong. A
// server that hasn't restarted with the 2026-08-26 SFTP error-code work yet
// (lastErrorCode absent from an old cached status) falls back to the
// original two-piece English rendering.
function getSftpStatusMessage(transport: {
  lastError?: string | null;
  lastErrorGuidance?: string | null;
  lastErrorCode?: string | null;
}): string {
  const detail = transport.lastError || "";
  const translated = transport.lastErrorCode
    ? resolveRegisteredTranslation("errors", transport.lastErrorCode, { detail })
    : null;
  return translated ?? `${detail} Fix: ${transport.lastErrorGuidance || ""}`.trim();
}

function ThemeSelect() {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation("settings");
  return (
    <Select value={theme} onValueChange={(v) => setTheme(v as ThemeName)}>
      <SelectTrigger className="w-[160px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="survival">{t("themeSelect.survival")}</SelectItem>
        <SelectItem value="light">{t("themeSelect.light")}</SelectItem>
      </SelectContent>
    </Select>
  );
}

export default function Settings() {
  const { t } = useTranslation("settings");
  const { formatDateTime, formatTime } = useDateFormat();
  const runtimeInfo = useRuntimeInfo();
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
    panelBridgeSftpConfigPath: "",
    autoStartServer: false,
    autoExportOnLogin: false,
    autoExportMaxPerPlayer: "3",
    modCheckInterval: "5",
    modAutoRestart: true,
    modRestartDelay: "5",
    serverAutoUpdate: false,
    serverAutoUpdateWarningMinutes: "15",
    steamUpdateAccount: "",
    steamApiKey: "",
    workshopCollectionId: "",
    workshopCollectionAutoSync: false,
    steamSessionId: "",
    steamLoginSecure: "",
    darkMode: true,
    autoReconnect: true,
    // The loop retried every 60 s before the setting existed (the RCON
    // service's own default), so an install that never saved it stays there.
    reconnectInterval: "60",
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
  // True from the first render: the skeleton shows until the settings are
  // in. Starting false rendered every tab once with the defaults, then
  // unmounted it behind the skeleton, so an embedded tab (Users) mounted
  // twice and lost what its first mount had read (the SSO link result).
  const [loading, setLoading] = useState(true);
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);
  // Escape hatch for the Server Settings and Sandbox tabs' range validation
  // (ServerConfig.tsx), per bernanas' request via the 2026-09-09 dispatch;
  // widened from Sandbox-only to the INI tab too for GH#182. Plain localStorage,
  // not the AppSettings blob above: PUT /app-settings validates against a
  // fixed key whitelist (server/routes/config.js) this change doesn't touch,
  // and this is a client-only UI preference like ThemeContext's, not
  // something that needs server persistence or cross-device sync.
  const [allowOutOfRangeSandbox, setAllowOutOfRangeSandboxState] = useState(
    () => getAllowOutOfRangeSandboxValues(),
  );
  const handleAllowOutOfRangeSandboxChange = useCallback((value: boolean) => {
    setAllowOutOfRangeSandboxState(value);
    setAllowOutOfRangeSandboxValues(value);
  }, []);
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
  // pz-bughunt round 20 (UX sense check): the RCON test's result was only
  // ever shown as a transient toast -- once it faded, there was no way to
  // tell whether the last test passed without clicking it again. Keep the
  // last outcome visible next to the button.
  const [rconTestResult, setRconTestResult] = useState<{ ok: boolean; at: number } | null>(null);
  const [restarting, setRestarting] = useState(false);
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const restartOriginRef = useRef<string | null>(null);
  // The bootId of the process asked to restart (its answer to the restart
  // request). The reconnect poll waits for a different one: the version
  // alone can't tell the old process from the new.
  const restartBootIdRef = useRef<string | null>(null);
  // bug-hunt-2026-09-07 (client silent-failure lane, update-failure-states
  // pass): set only when the reconnect poll below gives up -- distinct from
  // `restarting` (which just drives the button spinner) so the page can show
  // a persistent, actionable message instead of leaving the user staring at
  // a spinner tied to a navigation that already silently gave up.
  const [restartWaitFailed, setRestartWaitFailed] = useState(false);
  // A restart-and-apply that came back on another version than the one
  // being applied: the update was rolled back.
  const [restartRolledBack, setRestartRolledBack] = useState<
    { running: string; expected: string } | null
  >(null);
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
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  const [restartRiskConfirmed, setRestartRiskConfirmed] = useState(false);
  const [applyConfirmOpen, setApplyConfirmOpen] = useState(false);
  const [applyRiskConfirmed, setApplyRiskConfirmed] = useState(false);
  const { toast } = useToast();
  const { user, authEnabled, logout, can } = useAuth();
  // pz-bughunt round 19 (client-vs-server permission gate sweep): this
  // whole page had almost no client-side capability check at all -- every
  // one of these controls' server routes were already gated (confirmed by
  // reading each route's own requirePermission()/requireRole() call), but
  // the client showed every control fully enabled to any authenticated
  // user regardless of role, so a role missing the capability only found
  // out via a 403 after clicking. Same fix idiom as Console.tsx's Recheck
  // button this same round: const declared once, checked in the handler
  // (the real gate) AND passed to DisabledReason + disabled= (the
  // affordance). Grouped here since several controls below share a
  // capability.
  const canSavePanelSettings = can("panel.settings"); // General Save, and WorkshopCollectionSyncCard's cookie persistCookies (same route, PUT /config/app-settings)
  const canManageDiagnostics = can("diagnostics.manage"); // Access tab: Reload CORS Rules, Clear Blocked Log
  const canConfigureServerSettings = can("server.configure"); // Connection tab: Test (RCON recheck)
  const canSetupBridge = can("bridge.setup"); // Bridge tab: every write action on it
  // GET /config/app-settings leaves host paths and account names out for a
  // role without panel.settings, unless it holds the capability that edits
  // them (server/routes/config.js, appSettingsViewFor()), so these fields
  // would read as empty. They stay disabled, saying why, instead.
  const hiddenSettingReason = (capability: string) =>
    canSavePanelSettings || (capability !== "panel.settings" && can(capability))
      ? null
      : t("hiddenByRole.reason", { permission: capability });
  const panelOnlyValueHidden = hiddenSettingReason("panel.settings"); // HTTPS certificate/key paths, extra CORS origins
  const sftpValueHidden = hiddenSettingReason("bridge.setup"); // SFTP host, account and remote folders
  const steamAccountHidden = hiddenSettingReason("server.install"); // Steam account for game updates

  // Change password state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [regenerateJwtDialogOpen, setRegenerateJwtDialogOpen] = useState(false);
  const [regeneratingJwtSecret, setRegeneratingJwtSecret] = useState(false);
  const [signOutEverywhereDialogOpen, setSignOutEverywhereDialogOpen] = useState(false);
  const [signingOutEverywhere, setSigningOutEverywhere] = useState(false);
  const [recoveryCodeStatus, setRecoveryCodeStatus] = useState<{
    configured: boolean;
    remaining: number;
    total: number;
  } | null>(null);
  const [generatedRecoveryCodes, setGeneratedRecoveryCodes] = useState<string[]>([]);
  const [generatingRecoveryCodes, setGeneratingRecoveryCodes] = useState(false);
  const [recoveryCodesPassword, setRecoveryCodesPassword] = useState("");
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
      lastErrorGuidance?: string | null;
      lastErrorCode?: string | null;
    };
    config?: {
      statusStaleMs: number;
      pollIntervalMs: number;
      statusCheckMs: number;
    };
    connection?: {
      healthy: boolean;
      canSendCommands: boolean;
      // {key, params, text} -- resolveBridgeDiagText() below translates via
      // t(`bridge.diagnostics.${key}`, {...params, defaultValue: text}),
      // same key+defaultValue convention as capabilities.<key>.label.
      summary: BridgeDiagnostic;
      issues: BridgeDiagnostic[];
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
      protocolVersionMismatch?: { expected: string; actual: string };
    } | null;
    detectedPaths?: {
      serverName: string;
      installPath: string;
      zomboidDataPath: string;
    } | null;
    localInstall?: {
      canAutoInstall: boolean;
      installed: boolean;
      version: string | null;
      needsUpdate: boolean;
      sourcePath: string | null;
      targetPath: string | null;
    } | null;
    remoteBridgeVersionCheck?: {
      bundledVersion: string | null;
      liveVersion: string | null;
      behind: boolean | null;
    } | null;
    deliveryMethod?: "local" | "workshop";
    hostKeyRefusals?: SftpHostKeyRefusal[];
  } | null>(null);
  const [bridgeLoading, setBridgeLoading] = useState(false);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  // Resolves a getConnectionDiagnostics() summary/issue entry through its
  // key+params via i18next, falling back to the server's own English text
  // when no translation entry exists for that key yet -- same
  // key+defaultValue convention as capabilities.<key>.label. Ages in the
  // params are worded in the UI language's units (bridgeDiagnosticParams).
  const resolveBridgeDiagText = (
    entry: BridgeDiagnostic | undefined,
  ): string | undefined =>
    entry ? t(`bridge.diagnostics.${entry.key}`, { ...bridgeDiagnosticParams(entry.params), defaultValue: entry.text }) : undefined;
  const [pinging, setPinging] = useState(false);
  const [manualBridgePath, setManualBridgePath] = useState("");
  const [testingSftp, setTestingSftp] = useState(false);
  // The refusal (both fingerprints) from the last Verify/Start that failed
  // with SFTP_HOST_KEY_MISMATCH. /panel-bridge/status lists every refused
  // host as well (hostKeyRefusals), whoever connected; this one covers a
  // host typed into the form that the status poll has not picked up yet.
  const [sftpHostKeyRefusal, setSftpHostKeyRefusal] = useState<SftpHostKeyRefusal | null>(null);
  // host:port of the refusal being trusted right now.
  const [trustingHostKey, setTrustingHostKey] = useState<string | null>(null);
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
  const [remoteConfigFiles, setRemoteConfigFiles] = useState<
    Array<{ name: string; size: number; modifiedAt: string | null }>
  >([]);
  const [loadingRemoteConfig, setLoadingRemoteConfig] = useState(false);
  const [remoteConfigError, setRemoteConfigError] = useState<string | null>(
    null,
  );

  // Server list for install dropdown
  const [servers, setServers] = useState<ServerInstance[]>([]);
  // The stored autoStartServerIds, as loaded (no list at all for a setting
  // saved before servers could be chosen -- see lib/autoStartServers.ts).
  // Kept out of `settings`: each checkbox saves it on its own, and the
  // General tab's Save, which resends `settings` whole, must not put back a
  // list changed elsewhere since this page loaded (the Dashboard's checkbox).
  const [storedAutoStartServerIds, setStoredAutoStartServerIds] =
    useState<unknown>(undefined);
  // The wait between two auto-started servers' launches, saved on its own
  // like the list above (and kept out of `settings` for the same reason).
  // `autoStartDelayDraft` is what the field shows while it is being typed.
  const [storedAutoStartDelay, setStoredAutoStartDelay] = useState(0);
  const [autoStartDelayDraft, setAutoStartDelayDraft] = useState(0);
  // What this host can give the servers (GET /servers/status), to weigh the
  // chosen servers' heap against.
  const [hostMemoryBytes, setHostMemoryBytes] = useState<number | null>(null);
  const [serversLoadError, setServersLoadError] = useState(false);
  const [selectedInstallServerId, setSelectedInstallServerId] =
    useState<string>("");
  const [installingMod, setInstallingMod] = useState(false);

  // Track if there are unsaved changes
  const isDirty =
    originalSettings !== null &&
    JSON.stringify(settings) !== JSON.stringify(originalSettings);
  // Which settings differ from what was loaded: the rail marks their tabs
  // and the save bar counts them.
  const changedSettingKeys = originalSettings
    ? (Object.keys(SETTING_TAB) as (keyof AppSettings)[]).filter(
        (key) => JSON.stringify(settings[key]) !== JSON.stringify(originalSettings[key]),
      )
    : [];
  const dirtyTabs = new Set(changedSettingKeys.map((key) => SETTING_TAB[key]));
  // Single Sign-On saves on its own (OidcSettings' save bar). While it holds
  // edits, its tab stays mounted (hidden) when another tab opens: an
  // unmounted tab would reload from the server and drop them, and a tab
  // switch doesn't ask.
  const [ssoDirty, setSsoDirty] = useState(false);
  if (ssoDirty) dirtyTabs.add("sso");

  // Section navigation via tabs, in the rail's groups. Each tab's
  // description becomes the page header's description when it is open.
  const settingsSections = [
    { id: "general", label: t("tabs.general.label"), icon: Settings2, group: "panel", description: t("tabs.general.description") },
    { id: "updates", label: t("tabs.updates.label"), icon: Download, group: "panel", description: t("tabs.updates.description") },
    { id: "https", label: t("tabs.https.label"), icon: Lock, group: "panel", description: t("tabs.https.description") },
    { id: "access", label: t("tabs.access.label"), icon: Globe, group: "panel", description: t("tabs.access.description") },
    { id: "security", label: t("tabs.security.label"), icon: Shield, group: "panel", description: t("tabs.security.description") },
    { id: "users", label: t("tabs.users.label"), icon: UsersIcon, group: "accessControl", description: t("tabs.users.description") },
    { id: "roles", label: t("tabs.roles.label"), icon: ShieldCheck, group: "accessControl", description: t("tabs.roles.description") },
    { id: "sso", label: t("tabs.sso.label"), icon: KeyRound, group: "accessControl", description: t("tabs.sso.description") },
    { id: "connection", label: t("tabs.connection.label"), icon: Link, group: "gameServer", description: t("tabs.connection.description") },
    { id: "bridge", label: t("tabs.bridge.label"), icon: Zap, group: "gameServer", description: t("tabs.bridge.description") },
    { id: "mods", label: t("tabs.mods.label"), icon: Package, group: "automation", description: t("tabs.mods.description") },
    { id: "backups", label: t("tabs.backups.label"), icon: Archive, group: "automation", description: t("tabs.backups.description") },
    { id: "about", label: t("tabs.about.label"), icon: Info, group: "system", description: t("tabs.about.description") },
  ].filter((section) => {
    // UX only -- see AuthContext's `can()` doc comment. Hiding these two
    // tabs from a role that can't use them is purely cosmetic tidiness;
    // requirePermission("users.manage"/"roles.manage") on the actual
    // /api/users and /api/roles routes is what actually protects anything,
    // and stays untouched. can() fails OPEN (true) when capabilities are
    // unknown, so this never hides a tab from someone it can't confirm
    // lacks access -- it only ever hides it when the answer is a known no.
    if (section.id === "users") return can("users.manage");
    if (section.id === "roles") return can("roles.manage");
    if (section.id === "sso") return can("panel.settings");
    return true;
  });
  const settingsGroups = settingsSections.reduce<
    { id: string; sections: typeof settingsSections }[]
  >((groups, section) => {
    const existing = groups.find((group) => group.id === section.group);
    if (existing) existing.sections.push(section);
    else groups.push({ id: section.group, sections: [section] });
    return groups;
  }, []);
  // Keeps older ?tab= links and in-app deep links working after the rename.
  const legacyTabAliases: Record<string, string> = {
    panel: "general",
    rcon: "connection",
    "api-keys": "mods",
  };
  const validTabs = settingsSections.map((s) => s.id);
  const resolveTabId = (tab: string | null) => {
    if (!tab) return null;
    const resolved = legacyTabAliases[tab] ?? tab;
    return validTabs.includes(resolved) ? resolved : null;
  };
  const [searchParams, setSearchParams] = useSearchParams();
  // Asks first while a tab holds unsaved edits (the update toast's "Open
  // Dashboard" leaves the page).
  const navigate = useGuardedNavigate();
  // The selected tab lives in ?tab=: a reload, a link from another page
  // (Diagnostics' fixes, the command palette) or an in-page
  // <Link to="/settings?tab=roles"> opens it. An unknown tab, or one this
  // role can't see, reads as General.
  const activeSection = resolveTabId(searchParams.get("tab")) ?? "general";

  // Writes ?tab= in place (switching tabs is not a step Back should walk
  // through) and keeps every other parameter.
  const handleTabChange = useCallback(
    (value: string) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.set("tab", value);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // Leaving with unsaved edits asks first (sidebar, links, palette,
  // shortcuts, reload). The save bar registers the same guard on the tabs
  // that show it; this covers the embedded tabs too, where an edit made on
  // General would otherwise be dropped silently.
  useUnsavedChangesGuard(isDirty || ssoDirty);

  // Clean up restart redirect timer/poll on unmount
  useEffect(
    () => () => {
      if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
      if (restartPollRef.current) clearInterval(restartPollRef.current);
    },
    [],
  );

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const data = await configApi.getAppSettings();
      setSettingsLoadError(null);
      if (data.settings) {
        // restartOnCrashServerIds is the Dashboard's alone, and stays out of
        // `settings` for the same reason (Save would put back a stale list).
        const {
          autoStartServerIds: loadedAutoStartServerIds,
          restartOnCrashServerIds: _restartOnCrashServerIds,
          autoStartDelaySeconds: loadedAutoStartDelay,
          ...incoming
        } = data.settings as Partial<AppSettings> & {
          autoStartServerIds?: unknown;
          restartOnCrashServerIds?: unknown;
          autoStartDelaySeconds?: unknown;
        };
        setStoredAutoStartServerIds(loadedAutoStartServerIds);
        const delay = Number(loadedAutoStartDelay);
        const savedDelay = Number.isInteger(delay) && delay >= 0 && delay <= 600 ? delay : 0;
        setStoredAutoStartDelay(savedDelay);
        setAutoStartDelayDraft(savedDelay);
        // Use functional update to get current state and merge with loaded settings
        setSettings((prevSettings) => {
          const loadedSettings: AppSettings = {
            ...prevSettings,
            ...incoming,
            autoStartServer: toSettingBoolean(incoming.autoStartServer, false),
            autoExportOnLogin: toSettingBoolean(
              incoming.autoExportOnLogin,
              false,
            ),
            autoExportMaxPerPlayer: String(
              incoming.autoExportMaxPerPlayer ??
                prevSettings.autoExportMaxPerPlayer,
            ),
          };
          setOriginalSettings(loadedSettings);
          return loadedSettings;
        });
      }
    } catch (error) {
      reportClientError("Failed to fetch settings.", error);
      const message =
        getUserErrorMessage(error, t("pageHeader.loadFailedFallback"));
      setSettingsLoadError(message);
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
      toast({
        title: t("access.diagnosticsRefreshFailedTitle"),
        description: t("access.diagnosticsRefreshFailedDesc"),
        variant: "destructive",
      });
    } finally {
      setCorsLoading(false);
    }
  }, [toast, t]);

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

  const fetchPanelUpdateStatus = useCallback(async () => {
    try {
      const status = await panelUpdateApi.getStatus();
      setPanelUpdateStatus(status);
      setPanelUpdateStatusError(null);
      // "Ready to apply" reflects whether a binary is staged on disk, not just
      // whether the last click finished. Survives page reloads.
      //
      // GH#141: once a failed apply reports canRetryApply:false, the staged
      // binary is gone and NOTHING re-stages it -- clicking Restart again is
      // guaranteed to fail identically (server/services/panelUpdateChecker.js's
      // reconcilePendingUpdate() leaves pendingPanelUpdate set on purpose so a
      // fresh download can still retry, but that means status.updateAvailable
      // stays true with status.stagedUpdate now null, and neither branch below
      // would otherwise touch panelUpdateReady -- leaving it stuck at whatever
      // it was before the apply failed. Checked explicitly so a stuck-true
      // "ready" from before the failure can't survive it.
      //
      // A staged bundle is checked BEFORE that failure: it can only be the
      // re-download the failure banner asks for (canRetryApply:false means
      // the old one was gone), and testing the failure first kept "Restart
      // and Apply" disabled after that re-download.
      if (status.stagedUpdate) {
        setPanelUpdateReady(true);
      } else if (
        status.lastApplyResult?.status === "failed" &&
        status.lastApplyResult.canRetryApply === false
      ) {
        setPanelUpdateReady(false);
      } else if (!status.updateAvailable) {
        setPanelUpdateReady(false);
      }
      // If a previous apply failed, surface the helper log right away so the
      // user can see what happened without clicking anything. The log is
      // panel.settings content (#193): other roles get the status without it
      // and must not be sent to the gated log route.
      if (status.lastApplyResult?.status === "failed" && canSavePanelSettings) {
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
        getUserErrorMessage(error, t("updates.couldNotLoadUpdaterStatus"));
      setPanelUpdateStatusError(message);
      reportClientError("Failed to fetch panel update status.", error);
    }
  }, [t, canSavePanelSettings]);

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
  const panelRestartAssessment = runtimeInfo?.restartAssessment;
  const updateRestartAssessment =
    panelUpdatePreflight?.info.restartAssessment ?? panelRestartAssessment;
  const panelRestartIsRisky =
    panelRestartAssessment?.gameServers !== "preserved" ||
    Boolean(panelRestartAssessment?.requiresConfirmation);
  const updateRestartIsRisky =
    updateRestartAssessment?.gameServers !== "preserved" ||
    Boolean(updateRestartAssessment?.requiresConfirmation);
  const restartAssessmentMessage = (
    assessment: typeof panelRestartAssessment,
    scope: "general" | "updates",
  ) => {
    if (assessment?.gameServers === "preserved") {
      return t(`${scope}.${scope === "general" ? "restartGameServerPreserved" : "gameServerPreserved"}`);
    }
    if (assessment?.gameServers === "at-risk") {
      return t(`${scope}.${scope === "general" ? "restartGameServerRisk" : "gameServerRisk"}`);
    }
    return t(`${scope}.${scope === "general" ? "restartGameServerUnknown" : "gameServerUnknown"}`);
  };

  const translatePanelUpdateMessages = (
    messages: string[],
    details?: PanelUpdateMessage[],
  ) =>
    messages.map((message, index) => {
      const detail = details?.[index];
      return detail
        ? t(detail.key, { ...detail.params, defaultValue: message })
        : message;
    });

  // Run preflight once status tells us we're in a packaged build and there is
  // anything actionable (either an available update or a staged file on disk).
  // update-preflight needs panel.settings (#193), like Check for Updates.
  useEffect(() => {
    if (!hasActionablePanelUpdate || !canSavePanelSettings) return;
    fetchPanelUpdatePreflight();
  }, [
    hasActionablePanelUpdate,
    stagedPanelUpdatePath,
    fetchPanelUpdatePreflight,
    canSavePanelSettings,
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
        return t("access.originsError.tooMany", { max: MAX_CORS_ALLOWED_ORIGINS });
      }

      for (const origin of origins) {
        if (origin.length > MAX_CORS_ORIGIN_LENGTH) {
          return t("access.originsError.tooLong", { length: origin.length, max: MAX_CORS_ORIGIN_LENGTH });
        }

        // A browser extension let in while panel logins are off, named the
        // way the panel's refusal names it (server/utils/extensionOrigin.js).
        if (/^(chrome-extension|moz-extension|safari-web-extension):/i.test(origin)) {
          if (!/^(chrome-extension|moz-extension|safari-web-extension):\/\/[a-z0-9-]{1,128}\/?$/i.test(origin)) {
            return t("access.originsError.invalidFormat", { origin });
          }
          continue;
        }

        try {
          const parsed = new URL(origin);
          if (!["http:", "https:"].includes(parsed.protocol)) {
            return t("access.originsError.protocolNotAllowed", { origin });
          }
        } catch {
          return t("access.originsError.invalidFormat", { origin });
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
    try {
      const status = await authApi.getRecoveryCodes();
      setRecoveryCodeStatus(status);
    } catch {
      setRecoveryCodeStatus(null);
    }
  }, []);

  useEffect(() => {
    void fetchRecoveryCodeStatus();
  }, [fetchRecoveryCodeStatus]);

  const handleGenerateRecoveryCodes = async () => {
    if (!recoveryCodesPassword) return;
    setGeneratingRecoveryCodes(true);
    try {
      // The codes reset this account's password without the old one, so the
      // server asks for the current password first.
      const result = await handleResponse<{ codes?: string[] }>(
        await apiFetch("/auth/recovery-codes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentPassword: recoveryCodesPassword }),
        }),
      );
      setRecoveryCodesPassword("");
      setGeneratedRecoveryCodes(result.codes || []);
      await fetchRecoveryCodeStatus();
      toast({
        title: t("toasts.recoveryCodesGenerated.title"),
        description: t("toasts.recoveryCodesGenerated.description"),
        variant: "success" as const,
      });
    } catch (error) {
      toast({
        title: t("toasts.recoveryCodesFailed.title"),
        description:
          getUserErrorMessage(error, t("toasts.recoveryCodesFailed.fallback")),
        variant: "destructive",
      });
    } finally {
      setGeneratingRecoveryCodes(false);
    }
  };

  const handleSave = async () => {
    if (!canSavePanelSettings) return;
    if (!isValidPort(Number(settings.panelPort))) {
      toast({
        title: t("toasts.invalidPanelPort.title"),
        description: t("toasts.invalidPanelPort.description"),
        variant: "destructive",
      });
      return;
    }
    if (settings.httpsEnabled && !isValidPort(Number(settings.httpsPort))) {
      toast({
        title: t("toasts.invalidHttpsPort.title"),
        description: t("toasts.invalidHttpsPort.description"),
        variant: "destructive",
      });
      return;
    }

    const validationError = validateCorsOriginsInput(
      settings.corsAllowedOrigins,
    );
    if (validationError) {
      setCorsOriginValidationError(validationError);
      toast({
        title: t("toasts.invalidCorsOrigins.title"),
        description: validationError,
        variant: "destructive",
      });
      return;
    }

    setSaving(true);
    try {
      const result = await configApi.updateAppSettings(
        settings as unknown as Record<string, unknown>,
      );
      setOriginalSettings(settings); // Reset dirty state after save
      try {
        await fetchCorsDiagnostics();
      } catch {
        // Settings are already saved; diagnostics refresh is best-effort.
      }
      // The save succeeded, but the server may have failed to apply some of it
      // live (server manager / RCON / CORS reload): it says so in `warnings`.
      // A plain green "saved" would hide that a restart is needed.
      const warnings = extractSaveWarnings(result);
      if (warnings.length > 0) {
        toast({
          title: t("toasts.settingsSavedWithWarnings.title"),
          description: t("toasts.settingsSavedWithWarnings.description", {
            warnings: warnings.join("; "),
          }),
          variant: "warning" as const,
        });
      } else {
        toast({
          title: t("toasts.settingsSaved.title"),
          description: t("toasts.settingsSaved.description"),
          variant: "success" as const,
        });
      }
    } catch (error) {
      toast({
        title: t("toasts.settingsSaveFailed.title"),
        description:
          getUserErrorMessage(error, t("toasts.settingsSaveFailed.fallback")),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleReloadCorsRules = async () => {
    if (!canManageDiagnostics) return;
    setCorsUpdating(true);
    try {
      const data = await configApi.reloadCorsDiagnostics();
      setCorsDiagnostics(data.diagnostics);
      toast({
        title: t("toasts.corsReloaded.title"),
        description: t("toasts.corsReloaded.description"),
        variant: "success" as const,
      });
    } catch (error) {
      toast({
        title: t("toasts.corsReloadFailed.title"),
        description:
          getUserErrorMessage(error, t("toasts.corsReloadFailed.fallback")),
        variant: "destructive",
      });
    } finally {
      setCorsUpdating(false);
    }
  };

  const handleClearCorsBlocked = async () => {
    if (!canManageDiagnostics) return;
    setCorsUpdating(true);
    try {
      const data = await configApi.clearCorsBlockedOrigins();
      setCorsDiagnostics(data.diagnostics);
      toast({
        title: t("toasts.corsLogCleared.title"),
        description: t("toasts.corsLogCleared.description"),
        variant: "success" as const,
      });
    } catch (error) {
      toast({
        title: t("toasts.corsLogClearFailed.title"),
        description:
          getUserErrorMessage(error, t("toasts.corsLogClearFailed.fallback")),
        variant: "destructive",
      });
    } finally {
      setCorsUpdating(false);
    }
  };

  // Shared by the initial post-restart wait and the manual "Check again"
  // retry below -- kept as one implementation so the two can't drift the way
  // a second hand-copied poll loop always eventually does.
  //
  // bug-hunt-2026-09-07 (client silent-failure lane, update-failure-states
  // pass -- this is the exact incident this was written for, Charon/Discord,
  // v1.2.16, invalid_bundle/exit 76): triggering the restart only confirms
  // the OLD process accepted the request -- server/index.js sends that
  // response and THEN exits (Windows: exit 75 for the Start.bat v2
  // supervisor; Linux: overwrite-in-place then respawn). Whether the NEW
  // process actually comes back up, as opposed to crash-looping on a bad
  // bundle, used to be unknown to this code: it just navigated after a flat
  // 3s delay regardless. When the new process never came back, that sent the
  // browser straight into a connection-refused wall with zero indication
  // anything was wrong -- the panel's own UI was gone, replaced by the
  // browser's native error page, at the exact moment the user most needed to
  // know what happened. Polling first means "it didn't come back" is
  // something this page can tell the user, in-app, instead of something
  // they're left to discover by staring at a dead tab.
  const pollForPanelReconnect = useCallback(
    // The process is back when /api/health answers with a bootId other than
    // the one the restart request answered with (restartBootIdRef): the old
    // process keeps answering while it hands off, and in the all-in-one
    // container while it saves and stops the game servers first.
    //
    // expectedVersion: only meaningful for the update-apply caller. A new
    // process on another version means the update was rolled back (Start.bat
    // or the startup check restored the previous build), which is reported
    // instead of waiting for a version that will never come. Without a
    // bootId to compare (none in the restart answer), the version is the
    // only signal and any other answer is waited out, as before.
    (expectedVersion?: string | null) => {
      // Fixed by restartPanelWithReconnect before the restart (see there):
      // the origin this page is already on, or the new one only when the
      // panel's port really changes.
      const pageOrigin = `${window.location.protocol}//${window.location.host}`;
      const origin = restartOriginRef.current ?? pageOrigin;
      const newUrl = `${origin}${window.location.pathname}${window.location.search}${window.location.hash}`;
      const deadline = Date.now() + RESTART_RECONNECT_TIMEOUT_MS;
      const previousBootId = restartBootIdRef.current;

      if (restartPollRef.current) clearInterval(restartPollRef.current);
      const poll = async () => {
        if (Date.now() > deadline) {
          if (restartPollRef.current) clearInterval(restartPollRef.current);
          restartPollRef.current = null;
          setRestarting(false);
          setRestartWaitFailed(true);
          return;
        }
        try {
          const res = await fetch(`${origin}/api/health`, { cache: "no-store" });
          if (!res.ok) return;
          const data = (await res.json().catch(() => null)) as
            | { version?: unknown; bootId?: unknown }
            | null;
          const version = typeof data?.version === "string" ? data.version : null;
          if (previousBootId) {
            // Still the process that was asked to restart. (A build too old
            // to report a bootId is a different process by definition.)
            if (data?.bootId === previousBootId) return;
          } else if (expectedVersion && version !== expectedVersion) {
            return;
          }
          if (restartPollRef.current) clearInterval(restartPollRef.current);
          restartPollRef.current = null;
          // Rolled back, on this same address: say so here and show why
          // (the Updates card's failed-apply details). Another address can't
          // be read from here; that page shows the failure on its Updates
          // card.
          if (
            expectedVersion &&
            version &&
            version !== expectedVersion &&
            origin === pageOrigin
          ) {
            setRestarting(false);
            setRestartRolledBack({ running: version, expected: expectedVersion });
            void fetchPanelUpdateStatus();
            return;
          }
          window.location.href = newUrl;
        } catch {
          // Not up yet (or, if the panel port genuinely changed, possibly
          // blocked by CORS from the old origin) -- keep polling either way.
          // Worst case this degrades to the same honest "hasn't come back"
          // message at the deadline; it never regresses to the old
          // blind-navigate behavior.
        }
      };
      restartPollRef.current = setInterval(poll, RESTART_RECONNECT_POLL_INTERVAL_MS);
      poll();
    },
    [fetchPanelUpdateStatus],
  );

  const restartPanelWithReconnect = useCallback(
    async (description: string, expectedVersion?: string | null) => {
      // pz-bughunt round 19: POST /api/panel/restart is requireRole("admin")
      // server-side -- guarded once here since this function has 3 call
      // sites (General tab's own restart button, and both Updates-tab
      // apply-update flows), catching all of them (and any future one)
      // instead of relying on each call site to remember its own check.
      if (user?.role !== "admin") return;
      setRestarting(true);
      setRestartWaitFailed(false);
      setRestartRolledBack(null);
      restartBootIdRef.current = null;
      try {
        // Where the restarted panel will answer. Behind a reverse proxy, with
        // a remapped Docker port or on the HTTPS port it is this page's own
        // origin, not `hostname:<saved port>` (which never answers there and
        // left this page waiting three minutes). Read the running port first:
        // after the restart request only the new process is left to ask.
        restartOriginRef.current = resolveRestartOrigin(
          window.location,
          settings.panelPort,
          await readRunningPanelPort(serverApi.getPanelInfo),
        );
        const restartResult = (await serverApi.restartPanel()) as
          | { bootId?: unknown }
          | undefined;
        restartBootIdRef.current =
          typeof restartResult?.bootId === "string" ? restartResult.bootId : null;
        toast({
          title: t("toasts.restartingPanel.title"),
          description,
        });

        if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
        restartTimeoutRef.current = setTimeout(
          () => pollForPanelReconnect(expectedVersion),
          RESTART_RECONNECT_INITIAL_DELAY_MS,
        );
      } catch (err) {
        setRestarting(false);
        // Apply-in-progress (409): another tab/client already triggered the
        // apply. Show a tailored message instead of the generic restart-fail.
        const apiErr = err as { code?: string; message?: string };
        if (apiErr?.code === "apply_in_progress") {
          toast({
            title: t("toasts.updateInProgress.title"),
            description: getUserErrorMessage(err, t("toasts.updateInProgress.fallback")),
          });
          return;
        }
        toast({
          title: t("toasts.restartFailed.title"),
          description: t("toasts.restartFailed.description"),
          variant: "destructive",
        });
      }
    },
    [toast, t, pollForPanelReconnect, user, settings.panelPort],
  );

  // "Check again" on the hasn't-come-back message: does NOT re-POST
  // /api/panel/restart (that would trigger a second, redundant restart) --
  // it just resumes waiting with a fresh deadline. `expectedVersion` is
  // intentionally not re-threaded here (there is no staged-update state left
  // to compare against once the message is showing -- the page doesn't know
  // which flow led here); "a process other than the one asked to restart
  // answers" (restartBootIdRef, kept) is the right relaxation for a manual,
  // user-initiated retry.
  const retryRestartReconnectWait = useCallback(() => {
    setRestartWaitFailed(false);
    setRestarting(true);
    pollForPanelReconnect();
  }, [pollForPanelReconnect]);

  const handleCheckPanelUpdate = async () => {
    // GET /panel/update-check needs panel.settings (#193).
    if (!canSavePanelSettings) return;
    setCheckingPanelUpdate(true);
    setPanelUpdateStatusError(null);
    try {
      const status = await panelUpdateApi.check();
      setPanelUpdateStatus(status);

      // Preflight only auto-refreshes when hasActionablePanelUpdate/
      // stagedPanelUpdatePath actually CHANGE (see the effect a few lines
      // up) -- if an update was already available before this check and
      // still is after it, those deps are unchanged and the effect won't
      // refire. Without this, a preflight block (disk full, no write
      // permission) that gets resolved outside the panel has no way back:
      // Download/Restart-and-Apply are themselves disabled by the stale
      // `preflight.ok === false`, so the only buttons left that could
      // trigger a fresh preflight check are the ones the stale check is
      // blocking. "Check for Updates" is never preflight-gated, so it's the
      // one button a blocked user can still press -- make it also clear the
      // block once the real-world condition is fixed.
      if (status.updateAvailable || status.stagedUpdate) {
        fetchPanelUpdatePreflight();
      }

      if (status.updateAvailable) {
        toast({
          title: t("toasts.updateAvailable.title"),
          description: t("toasts.updateAvailable.description", { latest: status.latestVersion, current: status.currentVersion }),
        });
      } else {
        setPanelUpdateReady(false);
        toast({
          title: t("toasts.upToDate.title"),
          description: t("toasts.upToDate.description", { current: status.currentVersion }),
          variant: "success" as const,
        });
      }
    } catch (error) {
      toast({
        title: t("toasts.updateCheckFailed.title"),
        description:
          getUserErrorMessage(error, t("toasts.updateCheckFailed.fallback")),
        variant: "destructive",
      });
    } finally {
      setCheckingPanelUpdate(false);
    }
  };

  const handleDownloadPanelUpdate = async () => {
    // pz-bughunt round 19: POST /api/panel/update-download is gated
    // requireRole("admin") server-side, not a named capability -- no
    // can('...') equivalent exists for a role check, so this follows the
    // same role === "admin" convention this file already uses for its
    // Security tab's own admin-only card (regenerateJwt), rather than
    // inventing a new mechanism.
    if (user?.role !== "admin") return;
    if (!panelUpdateStatus?.updateAvailable) {
      toast({
        title: t("toasts.noUpdateAvailable.title"),
        description: t("toasts.noUpdateAvailable.description"),
      });
      return;
    }

    setDownloadingPanelUpdate(true);
    setPanelUpdateStatusError(null);
    try {
      // Pre-flight before touching disk — refuse early if we know apply will
      // fail, and refuse just as hard if the pre-flight check itself
      // couldn't be reached (a failed check is not a passed check).
      const pre = await fetchPanelUpdatePreflight();
      if (!pre || !pre.ok) {
        // The blocker in the reader's language (blockerDetails carries its
        // key), like the blocked-update card, not the server's English.
        throw new Error(
          (pre
            ? translatePanelUpdateMessages(pre.blockers, pre.blockerDetails)[0]
            : undefined) || t("errors.updateBlockedByPreflight"),
        );
      }

      // POST /panel/update-download always responds non-2xx on failure, so
      // handleResponse() throws into the catch below -- this never sees
      // result.success === false.
      await panelUpdateApi.download(isDockerPanelUpdate);

      if (!isDockerPanelUpdate) setPanelUpdateReady(true);
      // Translated text only: the server's result.message is English.
      toast({
        title: isDockerPanelUpdate ? t("toasts.dockerUpdateStarted.title") : t("toasts.updateDownloaded.title"),
        description: isDockerPanelUpdate
          ? t("toasts.updateDownloadedDescDocker")
          : t("toasts.updateDownloadedDescBinary"),
        variant: "success" as const,
      });
      await fetchPanelUpdateStatus();
    } catch (error) {
      // The route can fail with a body carrying `preflight` blockers
      // (ApiError.data holds the full payload -- see lib/api.ts) so the
      // preflight UI still updates on a real failure, not just on the
      // pre-flight check above.
      const data = error instanceof ApiError ? (error.data as { preflight?: PanelUpdatePreflight } | undefined) : undefined;
      if (data?.preflight) setPanelUpdatePreflight(data.preflight);
      // A Docker update that couldn't save and stop the game server first
      // downloaded nothing -- titled as what it is, and, when a stuck
      // server is the likely cause, with a way to the Dashboard's Force
      // stop (the message says what that costs). Never force-stopped here.
      const failure = classifyPanelUpdateFailure(error);
      toast({
        title: failure === "downloadFailed"
          ? t("toasts.downloadFailed.title")
          : t("toasts.updateNotApplied.title"),
        description:
          getUserErrorMessage(error, t("toasts.downloadFailed.fallback")),
        variant: "destructive",
        action: failure === "serverNotStopped" ? (
          <ToastAction altText={t("toasts.updateNotApplied.openDashboardAlt")} onClick={() => void navigate("/")}>
            {t("toasts.updateNotApplied.openDashboard")}
          </ToastAction>
        ) : undefined,
        // The message runs 300-460 characters; a button beside it leaves
        // the text a column too narrow to read in the toast's 15 s.
        layout: failure === "serverNotStopped" ? "stacked" : undefined,
      });
      // The card's "Downloading" state came from the progress events; read
      // the real state back instead of leaving it there after a failure.
      void fetchPanelUpdateStatus();
    } finally {
      setDownloadingPanelUpdate(false);
    }
  };

  const formatTimestamp = (value: string | null): string => {
    if (!value) return t("errors.never");
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t("errors.unknown");
    return formatDateTime(date, { style: "medium" });
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
      // A failed download (any tab's) ends with this; fetch its error.
      if (data.status === "failed") fetchPanelUpdateStatus();
    };

    const handlePanelUpdateReady = (data: { version?: string }) => {
      setPanelUpdateReady(true);
      toast({
        title: t("toasts.updateReady.title"),
        description: data.version
          ? t("toasts.updateReady.withVersion", { version: data.version })
          : t("toasts.updateReady.noVersion"),
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
        title: t("toasts.updateApplied.title"),
        description: data.version
          ? t("toasts.updateApplied.withVersion", { version: data.version })
          : t("toasts.updateApplied.noVersion"),
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
        title: t("toasts.updateApplyFailed.title"),
        description: data?.pendingVersion
          ? t("toasts.updateApplyFailed.withVersion", { version: data.pendingVersion })
          : t("toasts.updateApplyFailed.noVersion"),
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
    if (!canConfigureServerSettings) return;
    setTestingRcon(true);
    try {
      await configApi.testRcon();
      setRconTestResult({ ok: true, at: Date.now() });
      toast({
        title: t("toasts.rconConnected.title"),
        description: t("toasts.rconConnected.description"),
        variant: "success" as const,
      });
    } catch (error) {
      setRconTestResult({ ok: false, at: Date.now() });
      toast({
        title: t("toasts.rconFailed.title"),
        description:
          getUserErrorMessage(error, t("toasts.rconFailed.fallback")),
        variant: "destructive",
      });
    } finally {
      setTestingRcon(false);
    }
  };

  // Panel Bridge functions
  // sweep-round5 (2026-09-07): GET /panel-bridge/status now requires
  // bridge.setup OR bridge.diagnostics (it returns bridgePath and
  // statusFile.path, both genuinely rendered further down this file) --
  // skip the fetch (and its recursive polling below) entirely for a role
  // holding neither, rather than let it 3s/10s-poll into a guaranteed 403
  // forever. can() fails OPEN while capabilities are still loading, same
  // as every other capability check in this file (see the users/roles/sso
  // tab-hiding above) -- so this only stops polling once we genuinely know
  // the answer is no, never on a transient "haven't loaded yet."
  const canViewBridgeStatus = can("bridge.setup") || can("bridge.diagnostics");
  const fetchBridgeStatus = useCallback(async () => {
    if (!canViewBridgeStatus) return;
    try {
      const status = await panelBridgeApi.getStatus();
      setBridgeStatus(status);
      setBridgeError(null);
    } catch (error) {
      reportClientError("Failed to fetch bridge status.", error);
      setBridgeError(
        getUserErrorMessage(error, t("bridge.statusFetchFailedFallback")),
      );
    }
  }, [t, canViewBridgeStatus]);

  // Fetch servers list for install dropdown
  // bug-hunt-2026-09-18 (round 9, activeServerChanged race sweep): called
  // both on mount and on every activeServerChanged event, with no guard
  // against the two (or two activeServerChanged calls back to back)
  // overlapping -- an older call resolving after a newer one would
  // overwrite the current server list with a stale isActive snapshot.
  // serversGuard drops a response once a newer call has already started.
  const serversGuard = useRequestGuard();
  const fetchServers = useCallback(async () => {
    const requestId = serversGuard.next();
    try {
      const data = await serversApi.getAll();
      if (serversGuard.isStale(requestId)) return;
      setServers(data.servers || []);
      setServersLoadError(false);
      // Auto-select active server, first load only. bug-hunt-2026-09-18
      // (round 10): this used to read `selectedInstallServerId` from this
      // async function's OWN closure instead of current state -- the guard
      // above only orders overlapping fetchServers CALLS against each
      // other, it says nothing about a manual selection the user made
      // while THIS (not-superseded, not "stale" by that guard) call was
      // still in flight. A call issued while nothing was selected yet, then
      // left in flight across a manual pick, would still see its own
      // captured `!selectedInstallServerId === true` on resolution and
      // silently overwrite the user's pick. The functional setState
      // updater always reads live state at apply time instead, so a
      // manual selection made at any point before this resolves wins.
      const activeServer = data.servers?.find((s) => s.isActive);
      if (activeServer) {
        setSelectedInstallServerId((prev) => prev || String(activeServer.id));
      }
    } catch (error) {
      if (serversGuard.isStale(requestId)) return;
      reportClientError("Failed to fetch servers.", error);
      setServersLoadError(true);
    }
  }, [serversGuard]);

  // bug-hunt-2026-09-04: this listener used to reload the wrong state and
  // never reload the right one. configApi.getAppSettings()/PUT app-settings
  // (server/routes/config.js) is a flat GLOBAL key/value store with no
  // server-id resolution anywhere -- switching servers can never make it
  // stale, so refetching it unconditionally only risked discarding a user's
  // in-progress typing (isDirty, tracked above) for no reason. What DOES go
  // stale on a switch -- activeServer's rconHost/rconPort/name, shown in the
  // PanelBridge card below -- was never refreshed at all; fetchServers() has
  // no dirty-tracking of its own (read-only display), so it's safe to
  // reload unconditionally, same as the other four pages' own
  // activeServerChanged handlers.
  useEffect(() => {
    if (!socket) return;

    const handleActiveServerChanged = () => {
      fetchServers();
      if (!isDirty) fetchSettings();
    };

    socket.on("activeServerChanged", handleActiveServerChanged);
    return () => {
      socket.off("activeServerChanged", handleActiveServerChanged);
    };
  }, [socket, fetchSettings, fetchServers, isDirty]);

  // Install PanelBridge mod to selected server
  const handleInstallMod = async () => {
    if (!canSetupBridge) return;
    if (!selectedInstallServerId) {
      toast({
        title: t("toasts.selectServer.title"),
        description: t("toasts.selectServer.description"),
        variant: "destructive",
      });
      return;
    }

    if (selectedInstallServer?.isRemote) {
      toast({
        title: t("toasts.manualInstallRequired.title"),
        description: t("toasts.manualInstallRequired.description"),
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
        title: t("toasts.bridgeInstalled.title"),
        description: t("toasts.bridgeInstalled.description", { server: result.serverName || t("toasts.bridgeInstalled.fallbackServer") }),
        variant: "success" as const,
      });
    } catch (error) {
      // 504 PANELBRIDGE_INSTALL_STILL_RUNNING isn't a failure: the server
      // stopped waiting on the install (usually queued behind another
      // reconcile of the same folder), which finishes in the background.
      const stillRunning =
        error instanceof ApiError && error.code === "PANELBRIDGE_INSTALL_STILL_RUNNING";
      toast({
        title: stillRunning
          ? t("toasts.bridgeInstallStillRunning.title")
          : t("toasts.installFailed.title"),
        description:
          getUserErrorMessage(error, t("toasts.installFailed.fallback")),
        ...(stillRunning ? {} : { variant: "destructive" as const }),
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
          // The live player list arrives as its own event
          // (panelBridge:players, gated players.view) — keep the current
          // list here so the separate event can update it without flicker.
          players: prevModStatus?.players || [],
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

    // security audit M1: the live player list is no longer part of
    // panelBridge:modStatus (which every role receives); it arrives as a
    // separate event, sent only to sockets holding players.view.
    const handleBridgePlayers = (players: string[] | Record<string, unknown>) => {
      setBridgeStatus((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          modStatus: {
            ...prev.modStatus,
            alive: prev.modStatus?.alive ?? true,
            version: prev.modStatus?.version || "",
            serverName: prev.modStatus?.serverName || "",
            path: prev.modStatus?.path || "",
            timestamp: prev.modStatus?.timestamp || Date.now(),
            players: Array.isArray(players)
              ? players
              : Object.keys(players || {}),
          } as NonNullable<typeof prev.modStatus>,
        };
      });
    };

    socket.on("panelBridge:status", handleBridgeStatus);
    socket.on("panelBridge:modStatus", handleModStatus);
    socket.on("panelBridge:players", handleBridgePlayers);
    socket.on("panelBridge:configured", handleBridgeConfigured);

    return () => {
      socket.off("panelBridge:status", handleBridgeStatus);
      socket.off("panelBridge:modStatus", handleModStatus);
      socket.off("panelBridge:players", handleBridgePlayers);
      socket.off("panelBridge:configured", handleBridgeConfigured);
    };
  }, [socket]); // Only depend on socket, use ref for fetchBridgeStatus

  // Auto-configure from active server settings (one-click setup)
  const handleAutoConfigure = async () => {
    if (!canSetupBridge) return;
    setBridgeLoading(true);
    setBridgeError(null);
    try {
      // handleResponse() throws on a non-2xx status or an HTTP 200 body
      // with success: false, so this route's failures (always non-2xx --
      // see panelBridge.js's /auto-configure) never reach a
      // result.success === false branch here, only the catch below.
      const result = await panelBridgeApi.autoConfigure();
      toast({
        title: t("toasts.bridgeAutoConfigured.title"),
        description: t("toasts.bridgeAutoConfigured.description", { server: result.serverName }),
        variant: "success" as const,
      });
      await fetchBridgeStatus();
    } catch (error) {
      setBridgeError(
        getUserErrorMessage(error, t("errors.couldNotAutoConfigure")),
      );
    } finally {
      setBridgeLoading(false);
    }
  };

  const handleStopBridge = async () => {
    if (!canSetupBridge) return;
    setBridgeLoading(true);
    try {
      await panelBridgeApi.stop();
      toast({
        title: t("toasts.bridgeStopped.title"),
        description: t("toasts.bridgeStopped.description"),
        variant: "success" as const,
      });
      await fetchBridgeStatus();
    } catch (error) {
      toast({
        title: t("toasts.bridgeStopFailed.title"),
        description:
          getUserErrorMessage(error, t("toasts.bridgeStopFailed.fallback")),
        variant: "destructive",
      });
    } finally {
      setBridgeLoading(false);
    }
  };

  const handleManualConfigure = async () => {
    if (!canSetupBridge) return;
    const trimmed = manualBridgePath.trim();
    if (!trimmed) return;
    setBridgeLoading(true);
    setBridgeError(null);
    try {
      // Same shape as handleAutoConfigure above: /configure-direct's
      // failures are always non-2xx, so they throw into the catch below,
      // never into a result.success === false branch here.
      const result = await panelBridgeApi.configureDirect(trimmed);
      toast({
        title: t("toasts.bridgeConfigured.title"),
        description: t("toasts.bridgeConfigured.description", { path: result.bridgePath }),
        variant: "success" as const,
      });
      setManualBridgePath("");
      await fetchBridgeStatus();
    } catch (error) {
      setBridgeError(
        getUserErrorMessage(error, t("errors.couldNotConfigureBridge")),
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

  const handleListRemoteLogs = async () => {
    if (!canSetupBridge) return;
    setLoadingRemoteLogs(true);
    setRemoteLogError(null);
    try {
      const result = await panelBridgeApi.listSftpLogs({
        ...sftpConfig(),
        logPath: settings.panelBridgeSftpLogPath,
      });
      setRemoteLogs(result.files || []);
      if (!result.files?.length) {
        setRemoteLogError(t("errors.noRemoteLogFiles"));
      }
    } catch (error) {
      setRemoteLogs([]);
      setRemoteLogError(
        getUserErrorMessage(error, t("errors.couldNotListRemoteLogs")),
      );
    } finally {
      setLoadingRemoteLogs(false);
    }
  };

  const handleCheckRemoteConfig = async () => {
    if (!canSetupBridge) return;
    setLoadingRemoteConfig(true);
    setRemoteConfigError(null);
    try {
      const result = await panelBridgeApi.listSftpConfigFiles({
        ...sftpConfig(),
        configPath: settings.panelBridgeSftpConfigPath,
      });
      setRemoteConfigFiles(result.files || []);
      if (!result.files?.length) {
        setRemoteConfigError(t("errors.noRemoteConfigFiles"));
      }
    } catch (error) {
      setRemoteConfigFiles([]);
      setRemoteConfigError(
        getUserErrorMessage(error, t("errors.couldNotReadRemoteConfig")),
      );
    } finally {
      setLoadingRemoteConfig(false);
    }
  };

  const handleTailRemoteLog = async (name: string) => {
    if (!canSetupBridge) return;
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
        getUserErrorMessage(error, t("errors.couldNotReadLogFile")),
      );
    } finally {
      setLoadingRemoteLogs(false);
    }
  };

  // The refusal a failed SFTP call reported, if its host key was refused.
  const hostKeyRefusalFrom = (error: unknown): SftpHostKeyRefusal | null => {
    if (!(error instanceof ApiError) || error.code !== "SFTP_HOST_KEY_MISMATCH") return null;
    const data = error.data as { hostKey?: SftpHostKeyRefusal } | undefined;
    return data?.hostKey ?? null;
  };
  const noteHostKeyRefusal = (error: unknown) => {
    const refusal = hostKeyRefusalFrom(error);
    if (!refusal) return;
    setSftpHostKeyRefusal(refusal);
    fetchBridgeStatus();
  };

  const handleTestSftp = async () => {
    if (!canSetupBridge) return;
    setTestingSftp(true);
    try {
      const result = await panelBridgeApi.testSftp(sftpConfig());
      setSftpHostKeyRefusal(null);
      toast({
        title: result.statusExists ? t("toasts.sftpBridgeReady.title") : t("toasts.sftpFoldersReady.title"),
        description: `${result.nextStep} (${result.latencyMs} ms)`,
        variant: "success" as const,
      });
    } catch (error) {
      noteHostKeyRefusal(error);
      toast({ title: t("toasts.sftpTestFailed.title"), description: getUserErrorMessage(error, t("toasts.sftpTestFailed.fallback")), variant: "destructive" });
    } finally {
      setTestingSftp(false);
    }
  };

  // Explicit operator decision after a refused host key: pin exactly the
  // key shown (the one the server presents), never "whatever key the next
  // connection sees". The server refuses if the host presents another key
  // by now. The bridge and Files reconnect on their own afterwards.
  const handleTrustHostKey = async (refusal: SftpHostKeyRefusal) => {
    if (!canSetupBridge) return;
    setTrustingHostKey(`${refusal.host}:${refusal.port}`);
    try {
      const result = await panelBridgeApi.trustSftpHostKey({
        host: refusal.host,
        port: refusal.port,
        fingerprint: refusal.presented,
      });
      setSftpHostKeyRefusal((current) =>
        current && current.host === refusal.host && current.port === refusal.port ? null : current,
      );
      toast({
        title: t("toasts.sftpHostKeyTrusted.title"),
        description: t("toasts.sftpHostKeyTrusted.description", {
          host: `${result.host}:${result.port}`,
          fingerprint: result.fingerprint,
        }),
        variant: "success" as const,
      });
    } catch (error) {
      // The host no longer presents that key (or the panel restarted since
      // the refusal): the status poll shows whatever is refused now, so the
      // copy kept from the last Verify is out of date.
      if (error instanceof ApiError && error.code === "SFTP_HOST_KEY_NOT_PRESENTED") {
        setSftpHostKeyRefusal((current) =>
          current && current.host === refusal.host && current.port === refusal.port ? null : current,
        );
      }
      toast({ title: t("toasts.sftpHostKeyTrustFailed.title"), description: getUserErrorMessage(error, t("toasts.sftpHostKeyTrustFailed.fallback")), variant: "destructive" });
    } finally {
      setTrustingHostKey(null);
      fetchBridgeStatus();
    }
  };

  // Every refused host: the status poll's list, plus the last Verify/Start
  // refusal if the poll has not caught up with it yet.
  const hostKeyRefusals: SftpHostKeyRefusal[] = [...(bridgeStatus?.hostKeyRefusals ?? [])];
  if (
    sftpHostKeyRefusal &&
    !hostKeyRefusals.some((r) => r.host === sftpHostKeyRefusal.host && r.port === sftpHostKeyRefusal.port)
  ) {
    hostKeyRefusals.push(sftpHostKeyRefusal);
  }

  const handleConfigureSftp = async () => {
    if (!canSetupBridge) return;
    setBridgeLoading(true);
    setBridgeError(null);
    try {
      await panelBridgeApi.configureSftp(sftpConfig());
      updateSetting("panelBridgeSftpEnabled", true);
      setOriginalSettings((previous) => previous ? {
        ...previous,
        panelBridgeSftpEnabled: true,
        panelBridgeSftpHost: settings.panelBridgeSftpHost,
        panelBridgeSftpPort: settings.panelBridgeSftpPort,
        panelBridgeSftpUsername: settings.panelBridgeSftpUsername,
        panelBridgeSftpPassword: settings.panelBridgeSftpPassword,
        panelBridgeSftpBridgePath: settings.panelBridgeSftpBridgePath,
        panelBridgeSftpPollIntervalSeconds: settings.panelBridgeSftpPollIntervalSeconds,
      } : previous);
      toast({ title: t("toasts.sftpBridgeStarted.title"), description: t("toasts.sftpBridgeStarted.description"), variant: "success" as const });
      await fetchBridgeStatus();
    } catch (error) {
      if (originalSettings) {
        setSettings((previous) => ({
          ...previous,
          panelBridgeSftpEnabled: originalSettings.panelBridgeSftpEnabled,
          panelBridgeSftpHost: originalSettings.panelBridgeSftpHost,
          panelBridgeSftpPort: originalSettings.panelBridgeSftpPort,
          panelBridgeSftpUsername: originalSettings.panelBridgeSftpUsername,
          panelBridgeSftpPassword: originalSettings.panelBridgeSftpPassword,
          panelBridgeSftpBridgePath: originalSettings.panelBridgeSftpBridgePath,
          panelBridgeSftpPollIntervalSeconds: originalSettings.panelBridgeSftpPollIntervalSeconds,
        }));
      }
      noteHostKeyRefusal(error);
      setBridgeError(getUserErrorMessage(error, t("errors.couldNotStartSftpBridge")));
    } finally {
      setBridgeLoading(false);
    }
  };

  const handlePingMod = async () => {
    setPinging(true);
    try {
      const result = await panelBridgeApi.ping();
      // apiGet's shared handleResponse() throws on an HTTP 200 body with
      // `success: false` (this codebase's other way of saying "this
      // failed" -- see lib/api.ts) rather than resolving with it. The
      // bridge service's ping() returns exactly that shape for "bridge not
      // running" and "mod not connected" -- its two most common failure
      // modes -- so those always land in the catch below, never in a
      // `result.success === false` branch here.
      toast({
        title: t("toasts.modConnected.title"),
        description: t("toasts.modConnected.description", { server: result.modStatus?.serverName || t("toasts.modConnected.fallbackServer") }),
        variant: "success" as const,
      });
    } catch (error) {
      toast({
        title: t("toasts.modNoResponse.title"),
        description:
          getUserErrorMessage(error, t("toasts.modNoResponse.fallback")),
        variant: "destructive",
        action: (
          <ToastAction altText={t("toasts.modNoResponse.openBridgeAlt")} onClick={() => handleTabChange("bridge")}>
            {t("toasts.modNoResponse.openBridge")}
          </ToastAction>
        ),
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
        "panelBridgeSftpPort",
        "panelBridgeSftpPollIntervalSeconds",
      ].includes(key)
    ) {
      // Allow empty string but reject non-numeric values
      if (value !== "" && isNaN(parseInt(value))) {
        return; // Don't update with invalid value
      }
    }
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  // pz-bughunt round 21 (UX sense check, part 2): this used to update local
  // state only, requiring the General tab's own Save button to persist it
  // -- a split-persistence trap next to Dashboard.tsx's matching checkbox,
  // which saves immediately (see its own handleAutoStartChange). Made this
  // one behave the same way: optimistic update, a scoped PUT (not the
  // whole settings object), revert both settings AND originalSettings on
  // failure so isDirty doesn't go stale, revert on error.
  const handleAutoStartToggle = async (checked: boolean) => {
    if (!canSavePanelSettings) return;
    const previous = settings.autoStartServer;
    setSettings((prev) => ({ ...prev, autoStartServer: checked }));
    setOriginalSettings((prev) =>
      prev ? { ...prev, autoStartServer: checked } : prev,
    );
    try {
      await configApi.updateAppSettings({ autoStartServer: checked });
      toast({
        title: checked
          ? t("toasts.autoStartEnabled.title")
          : t("toasts.autoStartDisabled.title"),
        description: checked
          ? t("toasts.autoStartEnabled.description")
          : t("toasts.autoStartDisabled.description"),
        variant: "success" as const,
      });
    } catch (error) {
      setSettings((prev) => ({ ...prev, autoStartServer: previous }));
      setOriginalSettings((prev) =>
        prev ? { ...prev, autoStartServer: previous } : prev,
      );
      toast({
        title: t("toasts.autoStartSaveFailed.title"),
        description: getUserErrorMessage(
          error,
          t("toasts.autoStartSaveFailed.fallback"),
        ),
        variant: "destructive",
      });
    }
  };

  // Which servers the switch above starts, one checkbox each, saved the
  // same way: at once, on its own. Remote servers aren't listed -- their
  // host starts them.
  const activeServerIdForAutoStart =
    servers.find((server) => server.isActive)?.id ?? servers[0]?.id ?? null;
  const chosenAutoStartServerIds = autoStartServerIds(
    {
      autoStartServer: settings.autoStartServer,
      autoStartServerIds: storedAutoStartServerIds,
    },
    activeServerIdForAutoStart,
  );
  const autoStartCandidates = servers.filter((server) => !server.isRemote);
  const chosenAutoStartServers = autoStartCandidates.filter((server) =>
    chosenAutoStartServerIds.includes(String(server.id)),
  );
  const chosenAutoStartHeapGb = heapOfServers(chosenAutoStartServers);
  const hostMemoryGb = hostMemoryBytes ? hostMemoryBytes / BYTES_PER_GB : null;
  const chosenAutoStartConflicts = portConflicts(chosenAutoStartServers);
  const severalAutoStartCandidates = autoStartCandidates.length > 1;
  // With one local server the switch says it all, as before servers could be
  // chosen -- unless a saved list leaves that server out, which the switch
  // alone would hide.
  const showAutoStartList =
    autoStartCandidates.length !== 1 ||
    (Array.isArray(storedAutoStartServerIds) &&
      !chosenAutoStartServerIds.includes(String(autoStartCandidates[0].id)));
  useEffect(() => {
    if (!severalAutoStartCandidates) return;
    let cancelled = false;
    serversApi
      .getStatus()
      .then((data) => {
        if (!cancelled && typeof data?.hostMemoryBytes === "number") {
          setHostMemoryBytes(data.hostMemoryBytes);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [severalAutoStartCandidates]);
  const handleAutoStartDelayCommit = async (value: number) => {
    const seconds = Math.min(600, Math.max(0, Math.round(Number(value) || 0)));
    setAutoStartDelayDraft(seconds);
    if (!canSavePanelSettings || seconds === storedAutoStartDelay) return;
    const previous = storedAutoStartDelay;
    setStoredAutoStartDelay(seconds);
    try {
      await configApi.updateAppSettings({ autoStartDelaySeconds: seconds });
      toast({
        title: t("toasts.autoStartDelaySaved.title"),
        description: t("toasts.autoStartDelaySaved.description", { seconds }),
        variant: "success" as const,
      });
    } catch (error) {
      setStoredAutoStartDelay(previous);
      setAutoStartDelayDraft(previous);
      toast({
        title: t("toasts.autoStartSaveFailed.title"),
        description: getUserErrorMessage(
          error,
          t("toasts.autoStartSaveFailed.fallback"),
        ),
        variant: "destructive",
      });
    }
  };
  const handleAutoStartServerToggle = async (
    server: ServerInstance,
    chosen: boolean,
  ) => {
    if (!canSavePanelSettings) return;
    const previous = storedAutoStartServerIds;
    const next = withAutoStartServer(chosenAutoStartServerIds, server.id, chosen);
    setStoredAutoStartServerIds(next);
    try {
      await configApi.updateAppSettings({ autoStartServerIds: next });
      toast({
        title: t(
          chosen
            ? "toasts.autoStartServerChosen.title"
            : "toasts.autoStartServerRemoved.title",
        ),
        description: t(
          chosen
            ? "toasts.autoStartServerChosen.description"
            : "toasts.autoStartServerRemoved.description",
          { name: server.name || server.serverName },
        ),
        variant: "success" as const,
      });
    } catch (error) {
      setStoredAutoStartServerIds(previous);
      toast({
        title: t("toasts.autoStartSaveFailed.title"),
        description: getUserErrorMessage(
          error,
          t("toasts.autoStartSaveFailed.fallback"),
        ),
        variant: "destructive",
      });
    }
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
  const activeServer = servers.find((server) => server.isActive) || null;
  const isRemoteServer = Boolean(activeServer?.isRemote);
  const bridgeUsesWorkshop = bridgeStatus?.deliveryMethod === "workshop";
  const trimmedHttpsKeyPath = settings.httpsKeyPath.trim();
  const trimmedHttpsCertPath = settings.httpsCertPath.trim();
  const hasPartialHttpsCertPath =
    Boolean(trimmedHttpsKeyPath) !== Boolean(trimmedHttpsCertPath);
  // Paths this role can't see aren't "none set" (hiddenSettingReason()).
  const usingAutoGeneratedHttpsCert =
    settings.httpsEnabled &&
    !panelOnlyValueHidden &&
    !trimmedHttpsKeyPath &&
    !trimmedHttpsCertPath;
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
      toast({ title: t("toasts.passwordsDontMatch.title"), variant: "destructive" });
      return;
    }
    if (!meetsPasswordMinLength(newPassword)) {
      toast({
        title: t("toasts.passwordTooShort.title"),
        variant: "destructive",
      });
      return;
    }
    if (exceedsPasswordMaxBytes(newPassword)) {
      toast({ title: t("PASSWORD_TOO_LONG_BYTES", { ns: "errors" }), variant: "destructive" });
      return;
    }
    setChangingPassword(true);
    try {
      await authApi.changePassword(currentPassword, newPassword);
      toast({
        title: t("toasts.passwordChanged.title"),
        description: t("toasts.passwordChanged.description"),
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error) {
      toast({
        title: t("toasts.passwordChangeFailed.title"),
        description:
          getUserErrorMessage(error, t("toasts.passwordChangeFailed.fallback")),
        variant: "destructive",
      });
    } finally {
      setChangingPassword(false);
    }
  };

  const handleRegenerateJwtSecret = async () => {
    setRegeneratingJwtSecret(true);
    try {
      await authApi.regenerateJwtSecret();
      setRegenerateJwtDialogOpen(false);
      toast({
        title: t("security.regenerateJwt.resultTitle"),
        description: t("security.regenerateJwt.resultDescription"),
      });
      await logout();
    } catch (error) {
      toast({
        title: t("security.regenerateJwt.failedTitle"),
        description:
          getUserErrorMessage(error, t("security.regenerateJwt.failedFallback")),
        variant: "destructive",
      });
    } finally {
      setRegeneratingJwtSecret(false);
    }
  };

  // Ends every session of this account, this browser included (a lost
  // device, a sign-in someone else may have), then signs out here.
  const handleSignOutEverywhere = async () => {
    setSigningOutEverywhere(true);
    try {
      await authApi.revokeAllSessions();
      setSignOutEverywhereDialogOpen(false);
      toast({
        title: t("security.signOutEverywhere.resultTitle"),
        description: t("security.signOutEverywhere.resultDescription"),
      });
      await logout();
    } catch (error) {
      toast({
        title: t("security.signOutEverywhere.failedTitle"),
        description:
          getUserErrorMessage(error, t("security.signOutEverywhere.failedFallback")),
        variant: "destructive",
      });
    } finally {
      setSigningOutEverywhere(false);
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
          data.error || t("errors.couldNotPrepareRecovery"),
        );
      }

      setLocalPasswordResetSupported(true);
      setShowLocalPasswordReset(true);
      setLocalPasswordResetToken("");
      toast({
        title: t("toasts.recoveryReady.title"),
        description:
          typeof data.message === "string"
            ? data.message
            : t("toasts.recoveryReady.fallback"),
      });
    } catch (error) {
      toast({
        title: t("toasts.recoveryUnavailable.title"),
        description:
          getUserErrorMessage(error, t("toasts.recoveryUnavailable.fallback")),
        variant: "destructive",
      });
    } finally {
      setPreparingLocalPasswordReset(false);
    }
  };

  const handleResetLostPassword = async () => {
    if (!localPasswordResetToken) {
      toast({ title: t("toasts.recoveryTokenMissing.title"), variant: "destructive" });
      return;
    }
    if (!localPasswordResetPassword || !localPasswordResetConfirm) return;
    if (localPasswordResetPassword !== localPasswordResetConfirm) {
      toast({ title: t("toasts.passwordsDontMatch.title"), variant: "destructive" });
      return;
    }
    if (!meetsPasswordMinLength(localPasswordResetPassword)) {
      toast({
        title: t("toasts.passwordTooShort.title"),
        variant: "destructive",
      });
      return;
    }
    if (exceedsPasswordMaxBytes(localPasswordResetPassword)) {
      toast({ title: t("PASSWORD_TOO_LONG_BYTES", { ns: "errors" }), variant: "destructive" });
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
          data.error || t("errors.couldNotResetPassword"),
        );
      }

      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setShowLocalPasswordReset(false);
      setLocalPasswordResetToken("");
      setLocalPasswordResetPassword("");
      setLocalPasswordResetConfirm("");
      // SECURITY (2026-10-05, A1): see lib/trustedDevice.ts's
      // rememberTrustedDeviceFrom().
      rememberTrustedDeviceFrom(data);
      toast({
        title: t("toasts.passwordReset.title"),
        description: t("toasts.passwordReset.description"),
      });
      await logout();
    } catch (error) {
      toast({
        title: t("toasts.passwordResetFailed.title"),
        description:
          getUserErrorMessage(error, t("toasts.passwordResetFailed.fallback")),
        variant: "destructive",
      });
    } finally {
      setResettingLocalPassword(false);
    }
  };

  // Bridge tab header: what the bridge is doing right now, and how it works.
  const bridgeHeaderStatus = bridgeStatus ? (
    <BridgeStatusBadge
      // modConnected alone is whether the mod is alive
      // (debounced -- stays true through a brief poll
      // miss). canSendCommands is a live, undebounced
      // check of whether the panel can actually write to
      // the bridge (dir writable, status file fresh) --
      // it can go false while modConnected is still true.
      // Badge must reflect both, or it reads "Connected"
      // right next to a Ping button that's about to throw.
      connected={bridgeStatus.modConnected && bridgeStatus.connection?.canSendCommands === true}
      running={bridgeStatus.isRunning}
      loading={bridgeLoading}
      bridgePath={bridgeStatus.bridgePath}
      summary={resolveBridgeDiagText(bridgeStatus.connection?.summary)}
      interactive={false}
    />
  ) : undefined;
  const bridgeHowItWorksDialog = (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          aria-label={t("bridge.howItWorksButton")}
        >
          <Info className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">{t("bridge.howItWorksButton")}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" />
            {t("bridge.dialogTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("bridge.dialogDesc")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5 text-sm">
          {/* What it unlocks */}
          <div>
            <p className="label-micro mb-2">
              {t("bridge.unlocksTitle")}
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                <p className="font-medium text-foreground">
                  {t("bridge.unlockWeatherTitle")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("bridge.unlockWeatherDesc")}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                <p className="font-medium text-foreground">
                  {t("bridge.unlockPlayerTitle")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("bridge.unlockPlayerDesc")}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                <p className="font-medium text-foreground">
                  {t("bridge.unlockWorldTitle")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("bridge.unlockWorldDesc")}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                <p className="font-medium text-foreground">
                  {t("bridge.unlockChatTitle")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("bridge.unlockChatDesc")}
                </p>
              </div>
            </div>
          </div>

          {/* How it works */}
          <div>
            <p className="label-micro mb-2">
              {t("bridge.howItWorksTitle")}
            </p>
            <p className="text-muted-foreground mb-3">
              <Trans t={t} i18nKey="bridge.howItWorksDesc" components={{ b: <strong className="text-foreground" /> }} />
            </p>
          </div>

          {/* Setup steps */}
          <div>
            <p className="label-micro mb-2">
              {t("bridge.setupTitle")}
            </p>
            <ol className="space-y-2">
              <li className="flex gap-3 items-start">
                <span className="flex-none w-5 h-5 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center mt-0.5">
                  1
                </span>
                <div>
                  <p className="font-medium">
                    {t("bridge.setupStep1Title")}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {t("bridge.setupStep1Desc")}
                  </p>
                </div>
              </li>
              <li className="flex gap-3 items-start">
                <span className="flex-none w-5 h-5 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center mt-0.5">
                  2
                </span>
                <div>
                  <p className="font-medium">
                    {t("bridge.setupStep2Title")}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {t("bridge.setupStep2Desc")}
                  </p>
                </div>
              </li>
              <li className="flex gap-3 items-start">
                <span className="flex-none w-5 h-5 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center mt-0.5">
                  3
                </span>
                <div>
                  <p className="font-medium">
                    {t("bridge.setupStep3Title")}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    <Trans t={t} i18nKey="bridge.setupStep3Desc" components={{ b1: <strong className="text-warning" />, b: <strong className="text-primary" /> }} />
                  </p>
                </div>
              </li>
            </ol>
          </div>

          {/* Requirement */}
          <div className="rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-xs">
            <p>
              <Trans t={t} i18nKey="bridge.requiresLuaChecksum" components={{ b: <strong /> }} />
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );

  const activeSectionMeta = settingsSections.find((s) => s.id === activeSection);
  // pz-pam-r28: the header follows the active tab ("Settings › Roles &
  // Permissions"), so landing on ?tab=roles from a link names the screen.
  // Falls back to the generic title for any unknown/legacy tab id.
  const pageTitle = activeSectionMeta?.label ?? t("pageHeader.title");
  const pageDescription =
    activeSectionMeta?.description ?? t("pageHeader.defaultDescription");
  // Users, Roles & Permissions and Single Sign-On are embedded pages with
  // their own saving; every other tab edits the shared app-settings object,
  // which the save bar saves.
  const editsSharedSettings =
    activeSection !== "users" && activeSection !== "roles" && activeSection !== "sso";
  const saveDisabledReason = !canSavePanelSettings
    ? t("permissions.noPanelSettings")
    : corsOriginValidationError ?? undefined;

  if (loading && !originalSettings) {
    return (
      <PageSkeleton
        variant="form"
        title={pageTitle}
        description={pageDescription}
      />
    );
  }

  if (settingsLoadError && !originalSettings) {
    return (
      <div className="page-transition space-y-6">
        <PageHeader
          title={t("pageHeader.title")}
          description={t("pageHeader.defaultDescription")}
        />
        <PageAlerts
          alerts={[
            {
              id: "settings-load-failed",
              tone: "error",
              title: t("pageHeader.loadFailedTitle"),
              description: t("pageHeader.loadFailedDesc", { error: settingsLoadError }),
              action: { label: t("pageHeader.retry"), onClick: fetchSettings },
            },
          ]}
        />
      </div>
    );
  }

  // bug-hunt-2026-09-07 (client silent-failure lane, update-failure-states
  // pass): the one thing this whole lane exists to prevent -- restarting the
  // panel and it never coming back, with nothing in-app to show for it.
  // Page-level, independent of which tab is active, since a dead-panel wait
  // isn't scoped to the Updates card -- the plain "Restart Panel" button in
  // General can trigger this exact state too.
  const pageAlerts: PageAlert[] = [];
  if (restartWaitFailed) {
    pageAlerts.push({
      id: "restart-wait-failed",
      tone: "error",
      title: t("restartWait.failedTitle"),
      description: <span className="break-words">{t("restartWait.failedDescription")}</span>,
      action: { label: t("restartWait.checkAgain"), onClick: retryRestartReconnectWait },
    });
  }
  if (restartRolledBack) {
    pageAlerts.push({
      id: "restart-rolled-back",
      tone: "error",
      title: t("restartWait.rolledBackTitle"),
      description: (
        <span className="break-words">
          {t("restartWait.rolledBackDescription", {
            running: restartRolledBack.running,
            expected: restartRolledBack.expected,
          })}
        </span>
      ),
      action:
        activeSection === "updates"
          ? undefined
          : { label: t("tabs.updates.label"), onClick: () => handleTabChange("updates") },
    });
  }

  return (
    <div className="page-transition space-y-6">
      <PageHeader
        breadcrumb={[{ label: t("pageHeader.title") }]}
        title={pageTitle}
        description={pageDescription}
        status={activeSection === "bridge" ? bridgeHeaderStatus : undefined}
        actions={activeSection === "bridge" ? bridgeHowItWorksDialog : undefined}
      />
      <AutoUpdateResultBanner />
      <PageAlerts alerts={pageAlerts} />

      <Tabs
        value={activeSection}
        onValueChange={handleTabChange}
        orientation="vertical"
      >
        <SubNavLayout
          nav={
            <SubNav
              kind="tabs"
              ariaLabel={t("ariaLabel")}
              value={activeSection}
              onValueChange={handleTabChange}
              groups={settingsGroups.map((group) => ({
                id: group.id,
                label: t(`tabs.groups.${group.id}`),
                items: group.sections.map((section) => ({
                  id: section.id,
                  label: section.label,
                  icon: section.icon,
                  dirty: dirtyTabs.has(section.id),
                })),
              }))}
            />
          }
        >
          <TabsContent value="general" className="mt-0 space-y-6">
            <SectionCard
              id="settings-general"
              icon={Server}
              title={t("general.cardTitle")}
              description={t("general.cardDescription")}
            >
                <div className="max-w-xs">
                  <Label htmlFor="panel-port">{t("general.portLabel")}</Label>
                  <Input
                    id="panel-port"
                    type="number"
                    value={settings.panelPort}
                    onChange={(e) => updateSetting("panelPort", e.target.value)}
                    onWheel={(e) => e.currentTarget.blur()}
                    min="1024"
                    max="65535"
                    placeholder="3001"
                    inputMode="numeric"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    {t("general.portHelp")}
                  </p>
                </div>
                {originalSettings &&
                  settings.panelPort !== originalSettings.panelPort && (
                    <Alert className="border-warning/40 bg-warning/10">
                      <AlertTriangle className="h-4 w-4 text-warning" />
                      <AlertTitle className="text-warning">
                        {t("general.restartRequiredTitle")}
                      </AlertTitle>
                      <AlertDescription>
                        {t("general.restartRequiredDesc")}
                      </AlertDescription>
                    </Alert>
                  )}
                <div className="flex items-center gap-3">
                  <AlertDialog
                    open={restartConfirmOpen}
                    onOpenChange={(open) => {
                      setRestartConfirmOpen(open);
                      if (!open) setRestartRiskConfirmed(false);
                    }}
                  >
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="outline"
                        disabled={restarting || isDirty || user?.role !== "admin"}
                        // pz-bughunt round 19: same requireRole("admin")
                        // route as the Updates tab's own restart action --
                        // not wrapped in DisabledReason for the same
                        // AlertDialogTrigger-asChild ref-forwarding reason.
                        title={user?.role !== "admin" ? t("permissions.adminOnly") : undefined}
                        className="gap-2"
                      >
                        {restarting ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <RotateCw className="w-4 h-4" />
                        )}
                        {restarting ? t("general.restartingButton") : t("general.restartButton")}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t("general.confirmRestartTitle")}</AlertDialogTitle>
                        <AlertDialogDescription>
                          {restartAssessmentMessage(panelRestartAssessment, "general")}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      {panelRestartIsRisky && (
                        <label className="flex items-start gap-2 text-sm">
                          <Checkbox
                            checked={restartRiskConfirmed}
                            onCheckedChange={(checked) => setRestartRiskConfirmed(checked === true)}
                          />
                          <span>{t("general.confirmRestartRisk")}</span>
                        </label>
                      )}
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t("updates.cancel")}</AlertDialogCancel>
                        <AlertDialogAction
                          disabled={panelRestartIsRisky && !restartRiskConfirmed}
                          onClick={() => restartPanelWithReconnect(
                            t("general.restartToastDesc", { port: settings.panelPort }),
                          )}
                        >
                          {t("general.restartButton")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                  {isDirty && (
                    <p className="text-xs text-muted-foreground">
                      {t("general.saveBeforeRestart")}
                    </p>
                  )}
                </div>
            </SectionCard>

            <SectionCard
              id="settings-appearance"
              icon={Palette}
              title={t("general.appearanceTitle")}
              description={t("general.appearanceDesc")}
            >
                  <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/25 p-3">
                    <div>
                      <Label className="text-sm font-medium">{t("general.themeLabel")}</Label>
                      <p className="text-xs text-muted-foreground">
                        {t("general.themeDesc")}
                      </p>
                    </div>
                    <ThemeSelect />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/25 p-3">
                    <div className="min-w-0 flex-1 basis-60">
                      <Label htmlFor="settings-date-format" className="text-sm font-medium">{t("general.dateFormatLabel")}</Label>
                      <p className="text-xs text-muted-foreground">
                        {t("general.dateFormatDesc")}
                      </p>
                    </div>
                    <DateFormatSelect id="settings-date-format" />
                  </div>
            </SectionCard>

            <SectionCard
              id="settings-value-ranges"
              icon={SlidersHorizontal}
              title={settingsFallback("general.sandboxRangeOverrideTitle", "Setting Value Ranges")}
              description={settingsFallback(
                "general.sandboxRangeOverrideDesc",
                "Controls whether the Server Settings and Sandbox tabs' Save buttons block a value outside its known minimum/maximum.",
              )}
            >
                  <div className="flex items-center justify-between gap-4 rounded-lg border border-warning/40 bg-warning/10 p-3">
                    <div>
                      <Label className="text-sm font-medium text-warning">
                        {settingsFallback("general.sandboxRangeOverrideLabel", "Allow values outside the known range")}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {settingsFallback(
                          "general.sandboxRangeOverrideHint",
                          "Off by default. The Server Settings and Sandbox tabs still show when a value is outside its known range, but with this on, Save no longer blocks it -- useful when this panel's range table is out of date for your game version.",
                        )}
                      </p>
                    </div>
                    <Switch
                      checked={allowOutOfRangeSandbox}
                      onCheckedChange={handleAllowOutOfRangeSandboxChange}
                      aria-label={settingsFallback("ariaLabels.sandboxRangeOverride", "Allow values outside the known range")}
                    />
                  </div>
            </SectionCard>
          </TabsContent>

          <TabsContent value="access" className="mt-0">
            <SectionCard
              id="settings-access"
              icon={Globe}
              title={t("access.cardTitle")}
              description={t("access.cardDesc")}
            >

                  <Alert className="border-border/60 bg-muted/40">
                    <Globe className="h-4 w-4 text-primary" />
                    <AlertTitle>{t("access.quickStartTitle")}</AlertTitle>
                    <AlertDescription className="space-y-1 text-sm text-muted-foreground">
                      <p><Trans t={t} i18nKey="access.quickStart1" components={{ b: <strong className="text-foreground" /> }} /></p>
                      <p><Trans t={t} i18nKey="access.quickStart2" components={{ code: <code /> }} /></p>
                      <p><Trans t={t} i18nKey="access.quickStart3" components={{ b: <strong className="text-foreground" /> }} /></p>
                    </AlertDescription>
                  </Alert>

                  <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/25 p-3">
                    <div>
                      <Label className="text-sm font-medium">
                        {t("access.allowLanLabel")}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {t("access.allowLanDesc")}
                      </p>
                    </div>
                    <Switch
                      checked={settings.corsAllowPrivateNetworks}
                      onCheckedChange={handleCorsLanToggle}
                      aria-label={t("ariaLabels.allowPrivateLan")}
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/25 p-3">
                    <div>
                      <Label className="text-sm font-medium">
                        {t("access.publicIpLabel")}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {t("access.publicIpDesc")}
                      </p>
                    </div>
                    <Switch
                      checked={settings.enablePublicIpLookup}
                      onCheckedChange={(value) =>
                        updateSetting("enablePublicIpLookup", value)
                      }
                      aria-label={t("ariaLabels.enablePublicIp")}
                    />
                  </div>

                  <div className="space-y-2 rounded-lg border border-border/60 bg-muted/25 p-3">
                    <div>
                      <Label className="text-sm font-medium">
                        {t("access.lanAddressLabel")}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {t("access.lanAddressDesc")}
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
                      <SelectTrigger aria-label={t("ariaLabels.dashboardLanAddress")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">
                          {t("access.autoDetect")}
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
                    <div className="flex items-center gap-1.5">
                      <Label htmlFor="cors-origins">
                        {t("access.additionalOriginsLabel")}
                      </Label>
                      <HelpTip label={t("access.additionalOriginsLabel")}>
                        {t("access.additionalOriginsTip")}
                      </HelpTip>
                    </div>
                    <DisabledReason reason={panelOnlyValueHidden} className="w-full">
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
                        disabled={Boolean(panelOnlyValueHidden)}
                      />
                    </DisabledReason>
                    <p className="text-xs text-muted-foreground">
                      {t("access.additionalOriginsHelp")}
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
                        {t("access.allowAllLabel")}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {t("access.allowAllDesc")}
                      </p>
                    </div>
                    <Switch
                      checked={settings.corsAllowAll}
                      onCheckedChange={(value) =>
                        updateSetting("corsAllowAll", value)
                      }
                      aria-label={t("ariaLabels.allowAllOrigins")}
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/25 p-3">
                    <div>
                      <Label className="text-sm font-medium">
                        {t("access.debugLoggingLabel")}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {t("access.debugLoggingDesc")}
                      </p>
                    </div>
                    <Switch
                      checked={settings.corsDebug}
                      onCheckedChange={(value) =>
                        updateSetting("corsDebug", value)
                      }
                      aria-label={t("ariaLabels.corsDebugLogging")}
                    />
                  </div>

                  {settings.corsAllowAll && (
                    <Alert className="border-warning/40 bg-warning/10">
                      <AlertTriangle className="h-4 w-4 text-warning" />
                      <AlertTitle className="text-warning">
                        {t("access.securityWarningTitle")}
                      </AlertTitle>
                      <AlertDescription>
                        {t("access.securityWarningDesc")}
                      </AlertDescription>
                    </Alert>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <DisabledReason reason={!canManageDiagnostics ? t("permissions.noDiagnosticsManage") : null}>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleReloadCorsRules}
                        disabled={
                          corsUpdating ||
                          saving ||
                          Boolean(corsOriginValidationError) ||
                          !canManageDiagnostics
                        }
                        className="gap-2"
                      >
                        {corsUpdating ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <RefreshCw className="w-4 h-4" />
                        )}
                        {t("access.reloadRulesButton")}
                      </Button>
                    </DisabledReason>
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
                      {t("access.refreshDiagnosticsButton")}
                    </Button>
                    <DisabledReason reason={!canManageDiagnostics ? t("permissions.noDiagnosticsManage") : null}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={handleClearCorsBlocked}
                        disabled={corsUpdating || !corsDiagnostics?.blockedCount || !canManageDiagnostics}
                        className="gap-2 text-muted-foreground"
                      >
                        <Trash2 className="w-4 h-4" />
                        {t("access.clearBlockedLogButton")}
                      </Button>
                    </DisabledReason>
                  </div>

                  <div className="grid gap-3 text-xs sm:grid-cols-3">
                    <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                      <p className="text-muted-foreground">{t("access.blockedOriginsLabel")}</p>
                      <p className="mt-1 font-medium text-foreground">
                        {corsDiagnostics?.blockedCount ?? 0}
                      </p>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                      <p className="text-muted-foreground">
                        {t("access.effectiveAllowlistLabel")}
                      </p>
                      <p className="mt-1 font-medium text-foreground">
                        {corsDiagnostics?.effectiveAllowedOrigins.length ?? 0}
                      </p>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                      <p className="text-muted-foreground">{t("access.lastReloadLabel")}</p>
                      <p className="mt-1 font-medium text-foreground">
                        {formatTimestamp(corsDiagnostics?.lastLoadedAt || null)}
                      </p>
                    </div>
                  </div>

                  {!!corsDiagnostics?.blocked.length && (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-foreground">
                        {t("access.recentBlockedLabel")}
                      </p>
                      <ScrollArea className="h-[150px] rounded-lg border border-border/60 bg-muted/20 p-2">
                        <div className="space-y-2 pe-2">
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
            </SectionCard>
          </TabsContent>

          <TabsContent value="updates" className="mt-0">
            <SectionCard
              id="settings-updates"
              icon={Download}
              title={t("updates.autoUpdateTitle")}
              description={t("updates.autoUpdateDesc")}
              status={
                checkingPanelUpdate || panelUpdateStatus?.isChecking ? (
                  <StatusPill size="sm" tone="busy" label={t("updates.statusChecking")} />
                ) : downloadingPanelUpdate || panelUpdateStatus?.isDownloading ? (
                  <StatusPill size="sm" tone="busy" label={t("updates.statusDownloading")} />
                ) : panelUpdateStatus?.updateAvailable ? (
                  <StatusPill size="sm" tone="warn" label={t("updates.statusUpdateAvailable")} />
                ) : panelUpdateStatusError ? (
                  <StatusPill size="sm" tone="error" label={t("updates.statusCannotReach")} />
                ) : !panelUpdateStatus?.latestVersion ? (
                  // impeccable-2026-08-31: this used to be !panelUpdateStatus,
                  // which only guards a null response -- a real-but-never-
                  // checked status object (currentVersion set, latestVersion
                  // still unset -- see the "Latest: Not checked yet" /
                  // "Last Check: Never" fields a few lines below) is truthy,
                  // so it fell through to the "Up to date" branch and showed
                  // that badge next to a card plainly saying it was never
                  // checked. latestVersion is the same field the two detail
                  // cells below already gate on.
                  <StatusPill size="sm" tone="idle" label={t("updates.statusNotChecked")} />
                ) : (
                  <StatusPill size="sm" tone="ok" label={t("updates.statusUpToDate")} />
                )
              }
            >

                  {panelUpdateStatusError && (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>{t("updates.updaterErrorTitle")}</AlertTitle>
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
                          {t("updates.retry")}
                        </Button>
                      </AlertDescription>
                    </Alert>
                  )}

                  <div className="grid gap-3 text-xs sm:grid-cols-2">
                    <div className="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
                      <p className="text-muted-foreground">{t("updates.installedLabel")}</p>
                      <p className="mt-1 font-medium text-foreground">
                        v{panelUpdateStatus?.currentVersion || t("errors.unknown")}
                      </p>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
                      <p className="text-muted-foreground">{t("updates.latestLabel")}</p>
                      <p className="mt-1 font-medium text-foreground">
                        {panelUpdateStatus?.latestVersion
                          ? `v${panelUpdateStatus.latestVersion}`
                          : t("updates.latestNotChecked")}
                      </p>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
                      <p className="text-muted-foreground">{t("updates.lastCheckLabel")}</p>
                      <p className="mt-1 font-medium text-foreground">
                        {formatTimestamp(panelUpdateStatus?.lastCheck || null)}
                      </p>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
                      <p className="text-muted-foreground">{t("updates.releasePublishedLabel")}</p>
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
                        <span>{t("updates.downloadingLabel")}</span>
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
                      <AlertTitle>{t("updates.lastUpdateErrorTitle")}</AlertTitle>
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
                          <AlertTitle>{t("updates.updateAppliedTitle")}</AlertTitle>
                          <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                            <span>
                              {t("updates.updateAppliedDesc", {
                                version: panelUpdateStatus.lastApplyResult.appliedVersion || panelUpdateStatus.currentVersion,
                                appliedAt: panelUpdateStatus.lastApplyResult.at
                                  ? t("updates.appliedAtSuffix", { time: formatTimestamp(panelUpdateStatus.lastApplyResult.at) })
                                  : "",
                              })}
                            </span>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setPanelApplyResultDismissed(true)}
                              className="self-start"
                            >
                              {t("updates.dismiss")}
                            </Button>
                          </AlertDescription>
                        </Alert>
                      )
                    ) : (
                      <Alert variant="destructive">
                        <AlertTriangle className="h-4 w-4" />
                        <AlertTitle>{t("updates.updateFailedToApplyTitle")}</AlertTitle>
                        <AlertDescription className="flex flex-col gap-2">
                          <span className="break-words">
                            {t("updates.stillRunningVersion", { version: panelUpdateStatus.lastApplyResult.currentVersion || panelUpdateStatus.currentVersion })}
                            {panelUpdateStatus.lastApplyResult.pendingVersion
                              ? t("updates.expectedVersion", { version: panelUpdateStatus.lastApplyResult.pendingVersion })
                              : ""}
                            {panelUpdateStatus.lastApplyResult
                              .stagedStillPresent
                              ? t("updates.stagedStillPresent")
                              : panelUpdateStatus.lastApplyResult
                                    .likelyCause === "startup_handshake_failed"
                                ? t("updates.stagedGoneAfterHandshakeFailure")
                                : t("updates.stagedGone")}
                          </span>
                          {panelUpdateStatus.lastApplyResult.likelyCause ===
                            "av_quarantine" && runtimeInfo?.family === "windows" && (
                            <div className="rounded-md border border-destructive/40 bg-background/50 p-2 text-xs leading-relaxed">
                              <strong className="text-destructive-foreground">
                                {t("updates.likelyCauseLabel")}
                              </strong>{" "}
                              {t("updates.avQuarantine")}
                              {panelUpdateStatus.lastApplyResult
                                .panelFolder && (
                                <div className="mt-1">
                                  {t("updates.avExclusionHint")}
                                  <pre className="mt-1 rounded bg-background/70 p-1 text-[11px]">
                                    {
                                      panelUpdateStatus.lastApplyResult
                                        .panelFolder
                                    }
                                  </pre>
                                  <div className="mt-1 text-[11px] opacity-80">
                                    {t("updates.windowsDefenderLabel")}{" "}
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
                                {t("updates.likelyCauseLabel")}
                              </strong>{" "}
                              {t("updates.renameLocked")}
                            </div>
                          )}
                          {panelUpdateStatus.lastApplyResult.likelyCause ===
                            "permission" && (
                            <div className="rounded-md border border-destructive/40 bg-background/50 p-2 text-xs leading-relaxed">
                              <strong className="text-destructive-foreground">
                                {t("updates.likelyCauseLabel")}
                              </strong>{" "}
                              {t(platformTranslationKey("updates.permissionDenied", runtimeInfo?.family))}
                            </div>
                          )}
                          {panelUpdateStatus.lastApplyResult.likelyCause ===
                            "powershell_unavailable" && (
                            <div className="rounded-md border border-destructive/40 bg-background/50 p-2 text-xs leading-relaxed">
                              <strong className="text-destructive-foreground">
                                {t("updates.likelyCauseLabel")}
                              </strong>{" "}
                              {t("updates.powershellUnavailable")}
                            </div>
                          )}
                          {panelUpdateStatus.lastApplyResult.likelyCause ===
                            "helper_blocked" && runtimeInfo?.family === "windows" && (
                            <div className="rounded-md border border-destructive/40 bg-background/50 p-2 text-xs leading-relaxed">
                              <strong className="text-destructive-foreground">
                                {t("updates.likelyCauseLabel")}
                              </strong>{" "}
                              {t("updates.helperBlocked")}
                              {panelUpdateStatus.lastApplyResult
                                .panelFolder && (
                                <div className="mt-1">
                                  <strong>{t("updates.helperBlockedRecoveryLabel")}</strong>{" "}
                                  <Trans t={t} i18nKey="updates.helperBlockedRecovery" components={{ code: <code /> }} />
                                  <pre className="mt-1 rounded bg-background/70 p-1 text-[11px]">
                                    {
                                      panelUpdateStatus.lastApplyResult
                                        .panelFolder
                                    }
                                  </pre>
                                  <div className="mt-1 text-[11px] opacity-80">
                                    {t("updates.helperBlockedRecoveryNote")}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                          {panelUpdateStatus.lastApplyResult.likelyCause ===
                            "no_helper_log" && runtimeInfo?.family === "windows" && (
                            <div className="rounded-md border border-destructive/40 bg-background/50 p-2 text-xs leading-relaxed">
                              <strong className="text-destructive-foreground">
                                {t("updates.noHelperLogTitle")}
                              </strong>{" "}
                              {t("updates.noHelperLogDesc")}
                            </div>
                          )}
                          {panelUpdateStatus.lastApplyResult.likelyCause ===
                            "rollback_failed" && runtimeInfo?.family === "windows" && (
                            <div className="rounded-md border border-destructive/40 bg-background/50 p-2 text-xs leading-relaxed">
                              <strong className="text-destructive-foreground">
                                {t("updates.likelyCauseLabel")}
                              </strong>{" "}
                              {panelUpdateStatus.lastApplyResult
                                .rollbackRetryLikely
                                ? t("updates.rollbackFailedRetryWarning")
                                : t("updates.rollbackFailedCosmetic")}
                              {panelUpdateStatus.lastApplyResult
                                .panelFolder && (
                                <div className="mt-1">
                                  <strong>
                                    {t("updates.rollbackFailedRecoveryLabel")}
                                  </strong>{" "}
                                  {panelUpdateStatus.lastApplyResult
                                    .rollbackRetryLikely
                                    ? t("updates.rollbackFailedRecoveryNote")
                                    : t("updates.rollbackFailedRecoveryNoteCosmetic")}
                                  <pre className="mt-1 rounded bg-background/70 p-1 text-[11px]">
                                    {panelUpdateStatus.lastApplyResult
                                      .rollbackRetryLikely
                                      ? ".update-pending\n.update-applying\nupdate-bundle.json"
                                      : "update-bundle.json"}
                                  </pre>
                                  <div className="mt-1 text-[11px] opacity-80">
                                    {panelUpdateStatus.lastApplyResult
                                      .panelFolder}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                          {panelUpdateStatus.lastApplyResult.likelyCause ===
                            "startup_handshake_failed" && runtimeInfo?.family === "windows" && (
                            <div className="rounded-md border border-destructive/40 bg-background/50 p-2 text-xs leading-relaxed">
                              <strong className="text-destructive-foreground">
                                {t("updates.likelyCauseLabel")}
                              </strong>{" "}
                              {t("updates.startupHandshakeFailed")}
                            </div>
                          )}
                          {panelUpdateStatus.lastApplyResult.likelyCause ===
                            "unknown" && (
                            <div className="rounded-md border border-destructive/40 bg-background/50 p-2 text-xs leading-relaxed">
                              <strong className="text-destructive-foreground">
                                {t("updates.unknownCauseTitle")}
                              </strong>{" "}
                              {t("updates.unknownCauseDesc")}
                            </div>
                          )}
                          {panelApplyLog && (
                            <details className="mt-1 text-xs">
                              <summary className="cursor-pointer font-medium">
                                {t("updates.showHelperLog")}
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
                              {t("updates.dismiss")}
                            </Button>
                            <DisabledReason reason={!canSavePanelSettings ? t("permissions.noPanelSettings") : null}>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={!canSavePanelSettings}
                                onClick={async () => {
                                  if (!canSavePanelSettings) return;
                                  try {
                                    const { log: helperLog } =
                                      await panelUpdateApi.getApplyLog();
                                    setPanelApplyLog(
                                      helperLog || "No helper log found.",
                                    );
                                  } catch (error) {
                                    toast({
                                      title: t("updates.couldNotReadLog.title"),
                                      description:
                                        getUserErrorMessage(error, t("updates.couldNotReadLog.fallback")),
                                      variant: "destructive",
                                    });
                                  }
                                }}
                              >
                                {t("updates.refreshLog")}
                              </Button>
                            </DisabledReason>
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
                        <AlertTitle>{t("updates.updateBlockedTitle")}</AlertTitle>
                        <AlertDescription>
                          <ul className="mt-1 list-disc space-y-1 ps-5 text-sm">
                            {translatePanelUpdateMessages(
                              panelUpdatePreflight.blockers,
                              panelUpdatePreflight.blockerDetails,
                            ).map((b, i) => (
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
                        <AlertTitle>{t("updates.beforeYouRestartTitle")}</AlertTitle>
                        <AlertDescription>
                          <ul className="mt-1 list-disc space-y-1 ps-5 text-sm">
                            {translatePanelUpdateMessages(
                              panelUpdatePreflight.warnings,
                              panelUpdatePreflight.warningDetails,
                            ).map((w, i) => (
                              <li key={`wrn-${i}`} className="break-words">
                                {w}
                              </li>
                            ))}
                          </ul>
                        </AlertDescription>
                      </Alert>
                    )}

                  <div className="flex flex-wrap gap-2">
                    <DisabledReason reason={!canSavePanelSettings ? t("permissions.noPanelSettings") : null}>
                      <Button
                        variant="outline"
                        onClick={handleCheckPanelUpdate}
                        disabled={
                          checkingPanelUpdate ||
                          downloadingPanelUpdate ||
                          restarting ||
                          !canSavePanelSettings
                        }
                        className="gap-2"
                      >
                        {checkingPanelUpdate ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <RefreshCw className="w-4 h-4" />
                        )}
                        {checkingPanelUpdate
                          ? t("updates.statusChecking")
                          : t("updates.checkForUpdates")}
                      </Button>
                    </DisabledReason>

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
                              panelUpdatePreflight?.ok === false ||
                              user?.role !== "admin"
                            }
                            // Not wrapped in DisabledReason here -- it renders a
                            // Tooltip, and nesting that between
                            // AlertDialogTrigger's own asChild and this Button
                            // breaks the ref Radix needs to forward (same
                            // conflict the round-19 Console.tsx/Events.tsx fix
                            // already worked around for a shared Tooltip
                            // trigger). A plain title carries the reason
                            // instead.
                            title={user?.role !== "admin" ? t("permissions.adminOnly") : undefined}
                            className="gap-2"
                          >
                            {downloadingPanelUpdate ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Download className="w-4 h-4" />
                            )}
                            {downloadingPanelUpdate
                              ? t("updates.applyingDockerUpdate")
                              : t("updates.applyDockerUpdate")}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              {t("updates.confirmDockerTitle")}
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              {t("updates.confirmDockerDesc")}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t("updates.cancel")}</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => {
                                setDockerUpdateConfirmOpen(false);
                                handleDownloadPanelUpdate();
                              }}
                            >
                              {t("updates.stopServerAndUpdate")}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    ) : (
                      <DisabledReason reason={user?.role !== "admin" ? t("permissions.adminOnly") : null}>
                        <Button
                          onClick={handleDownloadPanelUpdate}
                          disabled={
                            !panelUpdateStatus?.updateAvailable ||
                            checkingPanelUpdate ||
                            downloadingPanelUpdate ||
                            restarting ||
                            panelUpdatePreflight?.ok === false ||
                            user?.role !== "admin"
                          }
                          className="gap-2"
                        >
                          {downloadingPanelUpdate ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Download className="w-4 h-4" />
                          )}
                          {downloadingPanelUpdate ? t("updates.downloadingButton") : t("updates.downloadUpdateButton")}
                        </Button>
                      </DisabledReason>
                    )}

                    {!isDockerPanelUpdate && <AlertDialog
                      open={applyConfirmOpen}
                      onOpenChange={(open) => {
                        setApplyConfirmOpen(open);
                        if (!open) setApplyRiskConfirmed(false);
                      }}
                    >
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="warning"
                          disabled={
                            !panelUpdateReady ||
                            restarting ||
                            isDirty ||
                            downloadingPanelUpdate ||
                            Boolean(panelUpdateStatus?.isDownloading) ||
                            panelUpdatePreflight?.ok === false ||
                            user?.role !== "admin"
                          }
                          // pz-bughunt round 19: POST /api/panel/restart is
                          // also requireRole("admin") server-side -- not
                          // wrapped in DisabledReason for the same
                          // AlertDialogTrigger-asChild ref-forwarding reason
                          // as the Download/Apply button above.
                          title={user?.role !== "admin" ? t("permissions.adminOnly") : undefined}
                          className="gap-2"
                        >
                          {restarting ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <RotateCw className="w-4 h-4" />
                          )}
                          {t("updates.restartAndApplyButton")}
                        </Button>
                      </AlertDialogTrigger>
                      {/* 2026-09 dialog sweep: the preflight warnings plus the
                          helper-log path pushed Restart/Cancel below the fold
                          on a landscape phone, with the warnings list a second
                          scroller inside; and the log path (a Desktop install
                          has a long unbroken run) widened the confirm past a
                          phone screen, cutting the risk checkbox's label. The
                          description scrolls in one AlertDialogBody now, under
                          the pinned title and buttons, and the path breaks. */}
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            {t("updates.confirmApplyTitle")}
                          </AlertDialogTitle>
                        </AlertDialogHeader>
                        <AlertDialogBody className="text-center sm:text-start">
                          <AlertDialogDescription asChild>
                            <div className="space-y-3 text-sm">
                              <p>
                                {t("updates.confirmApplyIntro")}
                                {panelUpdateStatus?.stagedUpdate?.version
                                  ? t("updates.confirmApplyVersionSuffix", { version: panelUpdateStatus.stagedUpdate.version })
                                  : ""}
                              </p>
                              <p className={updateRestartIsRisky ? "font-medium text-destructive" : "text-foreground"}>
                                {restartAssessmentMessage(updateRestartAssessment, "updates")}
                              </p>
                              {panelUpdatePreflight?.warnings.length ? (
                                <div>
                                  <p className="font-medium text-foreground">
                                    {t("updates.confirmBeforeContinuing")}
                                  </p>
                                  <ul className="mt-1 list-disc space-y-1 ps-5 text-start">
                                    {translatePanelUpdateMessages(
                                      panelUpdatePreflight.warnings,
                                      panelUpdatePreflight.warningDetails,
                                    ).map(
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
                                <Trans
                                  t={t}
                                  i18nKey={platformTranslationKey("updates.helperLogHint", runtimeInfo?.family)}
                                  values={{
                                    path: panelUpdatePreflight?.info.applyLogPath
                                      || runtimeInfo?.temporaryDirectory
                                      || t("updates.logPathUnavailable"),
                                  }}
                                  components={{ code: <code className="break-all" /> }}
                                />
                              </p>
                              {updateRestartIsRisky && (
                                <label className="flex items-start gap-2 text-sm text-foreground text-start">
                                  <Checkbox
                                    checked={applyRiskConfirmed}
                                    onCheckedChange={(checked) => setApplyRiskConfirmed(checked === true)}
                                  />
                                  <span>{t("updates.confirmGameServerRisk")}</span>
                                </label>
                              )}
                            </div>
                          </AlertDialogDescription>
                        </AlertDialogBody>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t("updates.cancel")}</AlertDialogCancel>
                          <AlertDialogAction
                            disabled={(updateRestartIsRisky && !applyRiskConfirmed) || user?.role !== "admin"}
                            onClick={() => {
                              if (user?.role !== "admin") return;
                              restartPanelWithReconnect(
                                t("updates.applyingDownloadedToast"),
                                panelUpdateStatus?.stagedUpdate?.version,
                              );
                            }}
                          >
                            {t("updates.restartAndApply")}
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
                          {t("updates.viewReleaseNotes")}{" "}
                          <span className="sr-only">{t("updates.opensInNewTab")}</span>
                        </a>
                      </Button>
                    )}
                  </div>

                  <p className="text-xs text-muted-foreground">
                    {isDirty
                      ? t("updates.footerSaveFirst")
                      : panelUpdateReady
                        ? t("updates.footerReady")
                        : panelUpdateStatus?.updateAvailable
                          ? isDockerPanelUpdate
                            ? t("updates.footerDocker")
                            : t("updates.footerDownloadThenRestart")
                          : t("updates.footerNoUpdate")}
                  </p>

                  <p className="text-xs text-muted-foreground">
                    {isDockerPanelUpdate
                      ? t("updates.footerDockerHandled")
                      : t("updates.footerAutoUpdateDevMode")}
                  </p>
            </SectionCard>
          </TabsContent>

          <TabsContent value="https" className="mt-0">
            {/* HTTPS Settings */}
            <SectionCard
              id="settings-https"
              icon={Lock}
              title={t("https.cardTitle")}
              description={t("https.cardDesc")}
            >
                <Alert className="border-border/60 bg-muted/40">
                  <Lock className="h-4 w-4 text-primary" />
                  <AlertTitle>{t("https.recommendedTitle")}</AlertTitle>
                  <AlertDescription className="space-y-2 text-sm text-muted-foreground">
                    <p>
                      {t("https.recommended1")}
                    </p>
                    <p>
                      {t("https.recommended2")}
                    </p>
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={applyRecommendedHttpsDefaults}
                      >
                        {t("https.useRecommendedDefaults")}
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
                    aria-label={t("ariaLabels.enableHttps")}
                  />
                  <div>
                    <Label className="text-base">{t("https.enableLabel")}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t("https.enableDesc")}
                    </p>
                  </div>
                </div>

                <div className="rounded-xl border border-border/60 bg-background/50 p-3 text-xs text-muted-foreground space-y-1">
                  <p>
                    <strong className="text-foreground">{t("https.httpUrlLabel")}</strong>{" "}
                    <code className="break-all">{httpPreviewUrl}</code>
                  </p>
                  <p>
                    <strong className="text-foreground">{t("https.httpsUrlLabel")}</strong>{" "}
                    <code className="break-all">{httpsPreviewUrl}</code>
                  </p>
                </div>

                {settings.httpsEnabled && (
                  <div className="ms-2 space-y-4 border-s-2 border-primary/20 ps-2">
                    <div className="max-w-xs">
                      <Label htmlFor="https-port">{t("https.portLabel")}</Label>
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
                        placeholder="3443"
                        inputMode="numeric"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        {t("https.portHelp")}
                      </p>
                    </div>
                    <div className="max-w-md">
                      <Label htmlFor="https-cert-path">
                        {t("https.certPathLabel")}{" "}
                        <span className="text-muted-foreground font-normal">
                          {t("https.optional")}
                        </span>
                      </Label>
                      <DisabledReason reason={panelOnlyValueHidden} className="w-full">
                        <Input
                          id="https-cert-path"
                          value={settings.httpsCertPath}
                          onChange={(e) =>
                            updateSetting("httpsCertPath", e.target.value)
                          }
                          placeholder={t(platformTranslationKey("https.certPathPlaceholder", runtimeInfo?.family))}
                          maxLength={260}
                          disabled={Boolean(panelOnlyValueHidden)}
                        />
                      </DisabledReason>
                      <p className="text-xs text-muted-foreground mt-1">
                        {t("https.certPathHelp")}
                      </p>
                    </div>
                    <div className="max-w-md">
                      <Label htmlFor="https-key-path">
                        {t("https.keyPathLabel")}{" "}
                        <span className="text-muted-foreground font-normal">
                          {t("https.optional")}
                        </span>
                      </Label>
                      <DisabledReason reason={panelOnlyValueHidden} className="w-full">
                        <Input
                          id="https-key-path"
                          value={settings.httpsKeyPath}
                          onChange={(e) =>
                            updateSetting("httpsKeyPath", e.target.value)
                          }
                          placeholder={t(platformTranslationKey("https.keyPathPlaceholder", runtimeInfo?.family))}
                          maxLength={260}
                          disabled={Boolean(panelOnlyValueHidden)}
                        />
                      </DisabledReason>
                      <p className="text-xs text-muted-foreground mt-1">
                        {t("https.keyPathHelp")}
                      </p>
                    </div>

                    {hasPartialHttpsCertPath && (
                      <Alert className="border-warning/40 bg-warning/10">
                        <AlertTriangle className="h-4 w-4 text-warning" />
                        <AlertTitle className="text-warning">
                          {t("https.provideBothTitle")}
                        </AlertTitle>
                        <AlertDescription>
                          {t("https.provideBothDesc")}
                        </AlertDescription>
                      </Alert>
                    )}

                    {usingAutoGeneratedHttpsCert && (
                      <Alert className="border-primary/30 bg-primary/10">
                        <Lock className="h-4 w-4 text-primary" />
                        <AlertTitle className="text-primary">
                          {t("https.autoGeneratedTitle")}
                        </AlertTitle>
                        <AlertDescription>
                          {t("https.autoGeneratedDesc")}
                        </AlertDescription>
                      </Alert>
                    )}

                    <Alert className="border-border/60 bg-muted/35">
                      <Lock className="h-4 w-4 text-muted-foreground" />
                      <AlertTitle>{t("https.reverseProxyTitle")}</AlertTitle>
                      <AlertDescription>
                        {t("https.reverseProxyDesc")}
                      </AlertDescription>
                    </Alert>

                    {originalSettings &&
                      settings.httpsEnabled !==
                        originalSettings.httpsEnabled && (
                        <Alert className="border-warning/40 bg-warning/10">
                          <AlertTriangle className="h-4 w-4 text-warning" />
                          <AlertTitle className="text-warning">
                            {t("https.restartRequiredTitle")}
                          </AlertTitle>
                          <AlertDescription>
                            {t("https.restartRequiredDesc")}
                          </AlertDescription>
                        </Alert>
                      )}
                  </div>
                )}
            </SectionCard>
          </TabsContent>

          <TabsContent value="connection" className="mt-0 space-y-6">
            {/* RCON Settings */}
            <SectionCard
              id="settings-rcon"
              icon={Link}
              title={t("connection.cardTitle")}
              description={t("connection.cardDesc")}
            >
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                  <DisabledReason reason={!canConfigureServerSettings ? t("permissions.noServerConfigure") : null}>
                    <Button
                      variant="outline"
                      onClick={handleTestRcon}
                      disabled={testingRcon || !canConfigureServerSettings}
                      className="w-full sm:w-auto"
                    >
                      {testingRcon ? (
                        <Loader2 className="w-4 h-4 me-2 animate-spin" />
                      ) : null}
                      {t("connection.testButton")}
                    </Button>
                  </DisabledReason>
                  {!testingRcon && rconTestResult && (
                    <span
                      className={cn(
                        "flex items-center gap-1.5 text-xs",
                        rconTestResult.ok ? "text-success" : "text-destructive",
                      )}
                    >
                      {rconTestResult.ok ? (
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      ) : (
                        <XCircle className="w-3.5 h-3.5" />
                      )}
                      {rconTestResult.ok
                        ? t("connection.testResultOk")
                        : t("connection.testResultFailed")}{" "}
                      {formatTime(rconTestResult.at, { seconds: true })}
                    </span>
                  )}
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={settings.autoReconnect}
                      onCheckedChange={(value) =>
                        updateSetting("autoReconnect", value)
                      }
                      aria-label={t("ariaLabels.autoReconnectRcon")}
                    />
                    <Label>{t("connection.autoReconnectLabel")}</Label>
                  </div>
                </div>
                {settings.autoReconnect && (
                  <div className="max-w-xs">
                    <Label htmlFor="reconnect-interval">
                      {t("connection.reconnectIntervalLabel")}
                    </Label>
                    <Input
                      id="reconnect-interval"
                      type="number"
                      value={settings.reconnectInterval}
                      onChange={(e) =>
                        updateSetting("reconnectInterval", e.target.value)
                      }
                      onWheel={(e) => e.currentTarget.blur()}
                      min="5"
                      max="600"
                      inputMode="numeric"
                    />
                  </div>
                )}
                <div className="p-4 bg-muted rounded-xl text-sm">
                  <p className="font-medium mb-2">
                    {t("connection.perServerNote")}
                  </p>
                  <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                    <li>
                      <Trans t={t} i18nKey="connection.step1" components={{ b: <strong /> }} />
                    </li>
                    <li>
                      <Trans t={t} i18nKey="connection.step2" components={{ b: <strong /> }} />
                    </li>
                    <li>{t("connection.step3")}</li>
                  </ol>
                </div>
            </SectionCard>

            <SectionCard
              id="settings-server-startup"
              icon={Server}
              title={t("connection.startupCardTitle")}
              description={t("connection.startupCardDesc")}
            >
                <div className="flex items-start justify-between gap-4 rounded-lg border border-border/60 bg-muted/25 p-3">
                  <div className="space-y-1">
                    <Label
                      htmlFor="auto-start-server"
                      className="text-sm font-medium"
                    >
                      {t("connection.autoStartLabel")}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t("connection.autoStartDesc")}
                    </p>
                  </div>
                  <DisabledReason reason={!canSavePanelSettings ? t("permissions.noPanelSettings") : null}>
                    <Switch
                      id="auto-start-server"
                      checked={settings.autoStartServer}
                      disabled={!canSavePanelSettings}
                      onCheckedChange={(value) => handleAutoStartToggle(value)}
                      aria-label={t("ariaLabels.startServerOnPanelStart")}
                    />
                  </DisabledReason>
                </div>
                {showAutoStartList && (
                <div
                  className={cn(
                    "mt-4 space-y-2",
                    !settings.autoStartServer && "opacity-60",
                  )}
                >
                  <div className="space-y-1">
                    <p className="text-sm font-medium">
                      {t("connection.autoStartServersLabel")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("connection.autoStartServersDesc")}
                    </p>
                  </div>
                  {autoStartCandidates.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t("connection.autoStartNoServers")}
                    </p>
                  ) : (
                    <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
                      {autoStartCandidates.map((server) => {
                        const checkboxId = `auto-start-server-${server.id}`;
                        return (
                          <li key={server.id} className="flex items-center gap-3 px-3 py-2">
                            <DisabledReason reason={!canSavePanelSettings ? t("permissions.noPanelSettings") : null}>
                              <Checkbox
                                id={checkboxId}
                                checked={chosenAutoStartServerIds.includes(String(server.id))}
                                disabled={!canSavePanelSettings || !settings.autoStartServer}
                                onCheckedChange={(checked) =>
                                  handleAutoStartServerToggle(server, checked === true)
                                }
                              />
                            </DisabledReason>
                            <Label
                              htmlFor={checkboxId}
                              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm"
                            >
                              <span className="truncate">{server.name || server.serverName}</span>
                              {server.isActive && (
                                <span className="inline-flex shrink-0 items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                                  {t("connection.autoStartActiveBadge")}
                                </span>
                              )}
                            </Label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {settings.autoStartServer &&
                    autoStartCandidates.length > 0 &&
                    !autoStartCandidates.some((server) =>
                      chosenAutoStartServerIds.includes(String(server.id)),
                    ) && (
                      <p className="text-xs text-warning">
                        {t("connection.autoStartNoneChosen")}
                      </p>
                    )}
                  {/* What the chosen servers share while they run together:
                      the machine's memory and its ports. */}
                  {settings.autoStartServer &&
                    chosenAutoStartServers.length > 1 &&
                    hostMemoryGb !== null && (
                      <p
                        className={cn(
                          "text-xs",
                          chosenAutoStartHeapGb > hostMemoryGb
                            ? "text-warning"
                            : "text-muted-foreground",
                        )}
                      >
                        {t(
                          chosenAutoStartHeapGb > hostMemoryGb
                            ? "connection.autoStartHeapOver"
                            : "connection.autoStartHeap",
                          { heap: chosenAutoStartHeapGb, host: hostMemoryGb.toFixed(1) },
                        )}
                      </p>
                    )}
                  {settings.autoStartServer &&
                    chosenAutoStartConflicts.map((conflict) => (
                      <p
                        key={`${conflict.kind}-${conflict.first.id}-${conflict.second.id}`}
                        className="text-xs text-warning"
                      >
                        {conflict.kind === "game"
                          ? t("connection.autoStartGamePortConflict", {
                              first: conflict.first.name || conflict.first.serverName,
                              second: conflict.second.name || conflict.second.serverName,
                              firstPort: conflict.first.serverPort,
                              secondPort: conflict.second.serverPort,
                            })
                          : t("connection.autoStartRconPortConflict", {
                              first: conflict.first.name || conflict.first.serverName,
                              second: conflict.second.name || conflict.second.serverName,
                              port: conflict.first.rconPort,
                            })}
                      </p>
                    ))}
                  {severalAutoStartCandidates && (
                    <div className="space-y-1 pt-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Label htmlFor="auto-start-delay" className="text-sm font-medium">
                          {t("connection.autoStartDelayLabel")}
                        </Label>
                        <DisabledReason reason={!canSavePanelSettings ? t("permissions.noPanelSettings") : null}>
                          <NumberInput
                            id="auto-start-delay"
                            className="h-8 w-24"
                            value={autoStartDelayDraft}
                            min={0}
                            max={600}
                            clamp={(value) => Math.min(600, Math.max(0, value))}
                            onChange={setAutoStartDelayDraft}
                            onBlur={() => handleAutoStartDelayCommit(autoStartDelayDraft)}
                            disabled={!canSavePanelSettings || !settings.autoStartServer}
                          />
                        </DisabledReason>
                        <span className="text-xs text-muted-foreground">
                          {t("connection.autoStartDelayUnit")}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t("connection.autoStartDelayDesc")}
                      </p>
                    </div>
                  )}
                </div>
                )}
            </SectionCard>
          </TabsContent>

          <TabsContent value="bridge" className="mt-0 space-y-6">
            {/* pz-bughunt round 21 (UX sense check, part 1): this tab
                used to be one flat ~860-line stack -- the operator's named
                worst scroll offender. Four collapsible sections (status and
                setup open by default; remote RCON and SFTP; remote config
                and logs; install and updates), each its own card. The
                bridge's live checks have a full view in Diagnostics. */}
            <SectionCard
              id="settings-bridge"
              collapsible
              defaultOpen
              icon={Zap}
              title={t("bridge.sectionStatusSetup")}
              actions={
                <Button asChild variant="ghost" size="sm" className="gap-1.5">
                  <RouterLink to="/debug?tab=bridge">
                    {t("bridge.openInDiagnostics")}
                    <ChevronRight className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
                  </RouterLink>
                </Button>
              }
            >
                {/* Status Display - when connected */}
                {bridgeStatus?.modConnected && bridgeStatus.modStatus && (
                  <Alert
                    className="border-primary/30 bg-primary/10"
                    aria-live="polite"
                  >
                    <div className="flex items-center gap-3 mb-3">
                      <CheckCircle2 className="w-5 h-5 text-primary" />
                      <span className="font-semibold text-primary">
                        {t("bridge.connectedTo", { server: bridgeStatus.modStatus.serverName || t("bridge.connectedFallback") })}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-muted-foreground">
                          {t("bridge.modVersionLabel")}
                        </span>{" "}
                        <span className="font-medium">
                          {bridgeStatus.modStatus.version || t("errors.unknown")}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">
                          {t("bridge.playersOnlineLabel")}
                        </span>{" "}
                        <span className="font-medium">
                          {bridgeStatus.modStatus.alive
                            ? (bridgeStatus.modStatus.playerCount ?? 0)
                            : t("bridge.offline")}
                        </span>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">
                      {t("bridge.advancedFeaturesNote")}
                    </p>
                  </Alert>
                )}

                {/* Bridge version staleness -- WARNING only, never blocks
                    anything (matches the server side, which never rejects a
                    command over either signal). Reads GET /panel-bridge/
                    status's remoteBridgeVersionCheck/localInstall.needsUpdate
                    (computed, never read anywhere before this card) and
                    modStatus.protocolVersionMismatch (Kevin's 71e45705) as
                    ONE prioritized signal, not two banners -- see
                    detectBridgeStaleness's own comment for why. */}
                {(() => {
                  const staleness = detectBridgeStaleness(bridgeStatus);
                  if (!staleness) return null;
                  const actionLabel = getBridgeStalenessActionLabel(staleness);
                  return (
                    <Alert
                      className="border-warning/40 bg-warning/10"
                      aria-live="polite"
                    >
                      <AlertTriangle className="h-4 w-4 text-warning" />
                      <AlertTitle className="text-warning">
                        {getBridgeStalenessTitle(staleness)}
                      </AlertTitle>
                      <AlertDescription className="space-y-3">
                        <p>{getBridgeStalenessBody(staleness)}</p>
                        {actionLabel && (
                          <DisabledReason reason={!canSetupBridge ? t("permissions.noBridgeSetup") : null}>
                            <Button
                              onClick={() => handleAutoConfigure()}
                              disabled={bridgeLoading || !canSetupBridge}
                              size="sm"
                              variant="outline"
                              className="gap-2"
                            >
                              {bridgeLoading ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <RefreshCw className="w-3.5 h-3.5" />
                              )}
                              {actionLabel}
                            </Button>
                          </DisabledReason>
                        )}
                      </AlertDescription>
                    </Alert>
                  );
                })()}

                {/* How PanelBridge reaches the active server: panel-installed
                    (default) or Steam Workshop. Everything it shows is
                    computed by GET /panel-bridge/delivery. Only with an
                    active server: without one that call answers 400
                    PANELBRIDGE_NO_ACTIVE_SERVER, and a first-run operator
                    would get a "couldn't load" warning whose Try again
                    can't help. */}
                {activeServer && (
                  <BridgeDeliveryPanel
                    activeServerId={activeServer.id}
                    iniFileName={activeServer.serverName ? `${activeServer.serverName}.ini` : null}
                    playerCount={bridgeStatus?.modStatus?.alive ? (bridgeStatus.modStatus.playerCount ?? 0) : null}
                  />
                )}

                {/* Not running - setup flow. With Steam Workshop delivery
                    there is no PanelBridge.lua to upload, and
                    "Set DoLuaChecksum=false" is no longer a standing
                    requirement: it only has to stay off until the block
                    confirms the switch, after which the block itself offers
                    to turn it back on. An unconditional step here would tell
                    the operator of a confirmed server to undo that. So both
                    steps give way to setupNote.workshop, which points at the
                    block and carries the until-confirmed rule (§4.6); the
                    watcher/SFTP steps stay, since the panel reads the
                    bridge's files either way. */}
                {!bridgeStatus?.isRunning && (
                  <div className="p-4 bg-muted rounded-xl space-y-3">
                    {isRemoteServer ? (
                      <>
                        <p className="text-sm font-medium">{t("bridge.remoteSetupTitle")}</p>
                        <p className="text-sm text-muted-foreground">
                          {t("bridge.remoteSetupDesc")}
                        </p>
                        {bridgeUsesWorkshop && (
                          <p className="text-sm text-muted-foreground">{t("bridgeDelivery:setupNote.workshop")}</p>
                        )}
                        <ol className="space-y-1.5 text-sm text-muted-foreground list-decimal list-inside">
                          {!bridgeUsesWorkshop && (
                            <>
                              <li><Trans t={t} i18nKey="bridge.remoteStep1" components={{ b: <strong className="text-foreground" /> }} /></li>
                              <li><Trans t={t} i18nKey="bridge.remoteStep2" components={{ b: <strong className="text-foreground" /> }} /></li>
                            </>
                          )}
                          <li><Trans t={t} i18nKey="bridge.remoteStep3" components={{ b: <strong className="text-foreground" /> }} /></li>
                          <li><Trans t={t} i18nKey="bridge.remoteStep4" components={{ b: <strong className="text-foreground" /> }} /></li>
                          <li>{t("bridge.remoteStep5")}</li>
                        </ol>
                        <p className="text-xs text-muted-foreground">
                          {t("bridge.remoteSetupNote")}
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm font-medium">{t("bridge.getStartedTitle")}</p>
                        {bridgeUsesWorkshop && (
                          <p className="text-sm text-muted-foreground">{t("bridgeDelivery:setupNote.workshop")}</p>
                        )}
                        <ol className="space-y-1.5 text-sm text-muted-foreground list-decimal list-inside">
                          {!bridgeUsesWorkshop && (
                            <>
                              <li><Trans t={t} i18nKey="bridge.localStep1" components={{ b: <strong className="text-foreground" /> }} /></li>
                              <li><Trans t={t} i18nKey="bridge.localStep2" components={{ b: <strong className="text-foreground" /> }} /></li>
                            </>
                          )}
                          <li><Trans t={t} i18nKey="bridge.localStep3" components={{ b: <strong className="text-foreground" /> }} /></li>
                          <li>{t("bridge.localStep4")}</li>
                        </ol>
                        <DisabledReason reason={!canSetupBridge ? t("permissions.noBridgeSetup") : null}>
                          <Button
                            onClick={() => handleAutoConfigure()}
                            disabled={bridgeLoading || !canSetupBridge}
                            className="gap-2"
                          >
                            {bridgeLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                            {t("bridge.autoSetupButton")}
                          </Button>
                        </DisabledReason>

                        <div className="border-t border-border/50 pt-3 mt-1 space-y-2">
                          <p className="text-xs text-muted-foreground">
                            {t("bridge.manualPathHint")}
                          </p>
                          <div className="flex gap-2">
                            <Input
                              value={manualBridgePath}
                              onChange={(e) => setManualBridgePath(e.target.value)}
                              placeholder="/home/pzuser/Zomboid/Lua/panelbridge/MyServer"
                              className="text-xs h-9"
                            />
                            <DisabledReason reason={!canSetupBridge ? t("permissions.noBridgeSetup") : null}>
                              <Button
                                onClick={handleManualConfigure}
                                disabled={bridgeLoading || !manualBridgePath.trim() || !canSetupBridge}
                                variant="secondary"
                                size="sm"
                                className="shrink-0 gap-1.5"
                              >
                                {bridgeLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderOpen className="w-3.5 h-3.5" />}
                                {t("bridge.connectButton")}
                              </Button>
                            </DisabledReason>
                          </div>
                        </div>
                      </>
                    )}

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
                      {t("bridge.waitingForModTitle")}
                    </AlertTitle>
                    <AlertDescription className="space-y-2">
                      <p>
                        {/* waitingLocal asks for PanelBridge.lua and
                            DoLuaChecksum=false, neither of which applies to
                            a Workshop server -- and this is exactly the
                            restart-needed/waiting window after a switch. */}
                        {isRemoteServer && bridgeStatus.transport?.type === "sftp"
                          ? t("bridge.waitingSftp")
                          : bridgeUsesWorkshop
                            ? t("bridgeDelivery:setupNote.waitingWorkshop")
                            : t("bridge.waitingLocal")}
                      </p>
                      {isRemoteServer && bridgeStatus.transport?.type === "sftp" ? (
                        <>
                          <p className="text-xs text-muted-foreground break-words">
                            {t("bridge.remoteFolderLabel")} <code className="rounded bg-background px-1 break-all">{settings.panelBridgeSftpBridgePath}</code>
                          </p>
                          {bridgeStatus?.bridgePath && (
                            <p className="text-xs text-muted-foreground break-words">
                              {t("bridge.localSftpCacheLabel")} <code className="rounded bg-background px-1 break-all">{bridgeStatus.bridgePath}</code>
                            </p>
                          )}
                        </>
                      ) : bridgeStatus?.bridgePath ? (
                        <p className="text-xs text-muted-foreground break-words">
                          {t("bridge.watchingLabel")}{" "}
                          <code className="rounded bg-background px-1 break-all">
                            {bridgeStatus.bridgePath}
                          </code>
                        </p>
                      ) : null}
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
                          {t("bridge.diagnosticsTitle")}
                        </span>
                        {bridgeStatus.consecutiveFailures != null &&
                          bridgeStatus.consecutiveFailures > 0 && (
                            <span className="ms-auto text-[10px] tabular-nums text-warning">
                              {t("bridge.consecutiveFailures", { count: bridgeStatus.consecutiveFailures })}
                            </span>
                          )}
                      </div>
                      <div className="p-3 space-y-3">
                        {/* Summary */}
                        <p className="text-xs text-muted-foreground">
                          {resolveBridgeDiagText(bridgeStatus.connection.summary)}
                        </p>

                        {/* Issues list */}
                        {bridgeStatus.connection.issues &&
                          bridgeStatus.connection.issues.length > 0 && (
                            <div className="space-y-1">
                              {bridgeStatus.connection.issues.map(
                                (issue, i: number) => (
                                  <div
                                    key={i}
                                    className="flex items-start gap-1.5 text-xs text-destructive"
                                  >
                                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                                    <span>{resolveBridgeDiagText(issue)}</span>
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
                                // pz-bughunt round 20 (UX sense check): this
                                // used to render the raw camelCase key
                                // (humanized via regex only) with no i18n at
                                // all, so non-English operators saw English
                                // fragments mid-page. t() with the old
                                // humanized text as defaultValue keeps this
                                // safe for any future check key the server
                                // adds before a translation exists for it.
                                const label = t(`bridge.checksLabels.${key}`, {
                                  defaultValue: key
                                    .replace(/([A-Z])/g, " $1")
                                    .replace(/^./, (s) => s.toUpperCase())
                                    .trim(),
                                });
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
                              <span className="opacity-60">{t("bridge.statusFileLabel")}</span>
                              <span
                                className={
                                  bridgeStatus.statusFile.exists
                                    ? "text-foreground"
                                    : "text-destructive/70"
                                }
                              >
                                {bridgeStatus.statusFile.exists
                                  ? t("bridge.statusFilePresent")
                                  : t("bridge.statusFileNotFound")}
                              </span>
                              {bridgeStatus.statusFile.ageSeconds != null && (
                                <span className="opacity-50">
                                  {t("bridge.agoSuffix", { age: formatBridgeAge(bridgeStatus.statusFile.ageSeconds) })}
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
                            {t("bridge.fileWatcherLabel")}{" "}
                            {bridgeStatus.hasFileWatcher ? (
                              <span className="text-primary">{t("bridge.fileWatcherActive")}</span>
                            ) : (
                              <span className="text-warning">{t("bridge.fileWatcherPollingOnly")}</span>
                            )}
                          </span>
                          {bridgeStatus.pendingCommands > 0 && (
                            <span>
                              {t("bridge.pendingLabel")}{" "}
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
                    <AlertTitle>{t("bridge.errorTitle")}</AlertTitle>
                    <AlertDescription>{bridgeError}</AlertDescription>
                  </Alert>
                )}

                {/* Control buttons when running */}
                {bridgeStatus?.isRunning && (
                  <div className="flex flex-wrap gap-3">
                    <DisabledReason reason={!canSetupBridge ? t("permissions.noBridgeSetup") : null}>
                      <Button
                        onClick={handleStopBridge}
                        disabled={bridgeLoading || !canSetupBridge}
                        variant="outline"
                        size="sm"
                        className="gap-2"
                      >
                        {bridgeLoading ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <XCircle className="w-4 h-4" />
                        )}
                        {t("bridge.stopBridge")}
                      </Button>
                    </DisabledReason>
                    <Button
                      onClick={handlePingMod}
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      // Server's sendCommand() throws "Bridge file connection
                      // is unhealthy" whenever !canSendCommands, regardless of
                      // modConnected -- gating on modConnected alone leaves
                      // this clickable while it's guaranteed to throw.
                      disabled={!bridgeStatus?.modConnected || bridgeStatus?.connection?.canSendCommands !== true || pinging}
                    >
                      {pinging ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4" />
                      )}
                      {pinging ? t("bridge.pinging") : t("bridge.pingMod")}
                    </Button>
                    <Button
                      onClick={fetchBridgeStatus}
                      variant="ghost"
                      size="sm"
                      className="gap-2"
                    >
                      <RefreshCw className="w-4 h-4" />
                      {t("bridge.refreshStatus")}
                    </Button>
                  </div>
                )}
            </SectionCard>

                {/* A refused SFTP host key, from any caller (bridge, Files,
                    log viewer, config mirror). Outside the collapsed
                    "Remote connection" section so it is seen; both
                    fingerprints are shown so the operator trusts the key
                    they compared, not whatever comes next. */}
                {hostKeyRefusals.length > 0 && (
                  <div id="sftp-host-key" role="alert" className="space-y-3 rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-xs">
                    <p className="flex items-start gap-2 text-sm font-medium text-foreground"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />{t("bridge.hostKeyMismatchWarning")}</p>
                    {hostKeyRefusals.map((refusal) => {
                      const id = `${refusal.host}:${refusal.port}`;
                      return (
                        <div key={id} className="space-y-2 rounded-md border border-border/50 bg-background/60 p-3">
                          <p className="font-mono text-sm text-foreground">{id}</p>
                          <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[auto_1fr]">
                            {refusal.pinned && (
                              <>
                                <dt className="text-muted-foreground">{t("bridge.hostKeySaved")}</dt>
                                <dd className="font-mono break-all">{refusal.pinned}</dd>
                              </>
                            )}
                            <dt className="text-muted-foreground">{t("bridge.hostKeyPresented")}</dt>
                            <dd className="font-mono break-all text-foreground">{refusal.presented}</dd>
                          </dl>
                          <DisabledReason reason={!canSetupBridge ? t("permissions.noBridgeSetup") : null}>
                            <Button type="button" variant="destructive" size="sm" onClick={() => handleTrustHostKey(refusal)} disabled={trustingHostKey !== null || !canSetupBridge}>
                              {trustingHostKey === id ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : null}
                              {t("bridge.trustNewHostKey")}
                            </Button>
                          </DisabledReason>
                        </div>
                      );
                    })}
                    <p className="text-muted-foreground"><Trans t={t} i18nKey="bridge.hostKeyCheckHint" components={{ code: <code className="font-mono text-foreground" /> }} /></p>
                  </div>
                )}

            <SectionCard
              collapsible
              defaultOpen={false}
              icon={Link}
              title={t("bridge.remoteConnectionTitle")}
            >
                  <p className="text-xs text-muted-foreground">
                    {t("bridge.remoteConnectionDesc")}
                  </p>

                  {/* impeccable-2026-08-31: lg:items-start left the RCON card
                      (much shorter content -- name, host:port, one link) at
                      its own natural height inside a row sized to the SFTP
                      card (host/port/user/password/folder/interval/buttons),
                      so the RCON card's border ended with a large empty gap
                      beneath it instead of lining up with its neighbor.
                      Default grid stretch instead: both cards' borders now
                      match the row height, same fix shape as any two cards
                      meant to sit level in one row. */}
                  <div className="grid gap-4 lg:grid-cols-2 lg:items-stretch">
                    <div id="rcon-command-connection" className="rounded-md border border-border/60 p-4 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium">{t("bridge.rconCommandTitle")}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {t("bridge.rconCommandDesc")}
                          </p>
                        </div>
                        <Link className="h-4 w-4 shrink-0 text-primary" />
                      </div>
                      {activeServer ? (
                        <div className="rounded border border-border/50 bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
                          <p className="font-medium text-foreground">{activeServer.name}</p>
                          <p className="mt-1 font-mono">{activeServer.rconHost || t("bridge.hostNotConfigured")}:{activeServer.rconPort || t("bridge.portNotConfigured")}</p>
                        </div>
                      ) : (
                        <p className="text-xs text-warning">{t("bridge.noActiveServerProfile")}</p>
                      )}
                      <RouterLink
                        to="/servers"
                        className="inline-flex text-xs font-medium text-primary hover:underline underline-offset-2"
                      >
                        {t("bridge.editRconLink")}
                      </RouterLink>
                    </div>

                    <div id="sftp-panelbridge" className="rounded-md border border-border/60 p-4 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium">{t("bridge.sftpFilesTitle")}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {isRemoteServer
                              ? t("bridge.sftpFilesDescRemote")
                              : t("bridge.sftpFilesDescLocal")}
                          </p>
                        </div>
                        <Cloud className="h-4 w-4 shrink-0 text-primary" />
                      </div>
                      <div className="rounded border border-border/50 bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
                        <strong className="text-foreground">{t("bridge.setupOrderLabel")}</strong> <Trans t={t} i18nKey="bridge.setupOrderText" components={{ b: <strong className="text-foreground" /> }} />
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5"><div className="flex items-center gap-1.5"><Label htmlFor="sftp-host">{t("bridge.sftpHostLabel")}</Label><HelpTip label={t("bridge.sftpHostLabel")}>{t("bridge.sftpBridgeTip")}</HelpTip></div><DisabledReason reason={sftpValueHidden} className="w-full"><Input id="sftp-host" value={settings.panelBridgeSftpHost} onChange={(event) => updateSetting("panelBridgeSftpHost", event.target.value)} placeholder="pz.example.net" disabled={Boolean(sftpValueHidden)} /></DisabledReason></div>
                        <div className="space-y-1.5"><Label htmlFor="sftp-port">{t("bridge.sftpPortLabel")}</Label><Input id="sftp-port" inputMode="numeric" value={settings.panelBridgeSftpPort} onChange={(event) => updateSetting("panelBridgeSftpPort", event.target.value)} /></div>
                        <div className="space-y-1.5"><Label htmlFor="sftp-user">{t("bridge.sftpUsernameLabel")}</Label><DisabledReason reason={sftpValueHidden} className="w-full"><Input id="sftp-user" autoComplete="username" value={settings.panelBridgeSftpUsername} onChange={(event) => updateSetting("panelBridgeSftpUsername", event.target.value)} disabled={Boolean(sftpValueHidden)} /></DisabledReason></div>
                        <div className="space-y-1.5"><Label htmlFor="sftp-password">{t("bridge.sftpPasswordLabel")}</Label><PasswordInput id="sftp-password" autoComplete="current-password" value={settings.panelBridgeSftpPassword} onChange={(value) => updateSetting("panelBridgeSftpPassword", value)} placeholder={t("bridge.sftpPasswordPlaceholder")} label={t("bridge.sftpPasswordAria")} /></div>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="sftp-bridge-path">{t("bridge.remoteBridgeFolderLabel")}</Label>
                        <DisabledReason reason={sftpValueHidden} className="w-full"><Input id="sftp-bridge-path" value={settings.panelBridgeSftpBridgePath} onChange={(event) => updateSetting("panelBridgeSftpBridgePath", event.target.value)} placeholder="/home/pzuser/Zomboid/Lua/panelbridge/MyServer" disabled={Boolean(sftpValueHidden)} /></DisabledReason>
                        <p className="text-[11px] text-muted-foreground">{t("bridge.remoteBridgeFolderHelp")}</p>
                      </div>
                      <div className="flex flex-wrap items-end gap-3">
                        <div className="w-36 space-y-1.5"><Label htmlFor="sftp-poll">{t("bridge.syncIntervalLabel")}</Label><Input id="sftp-poll" inputMode="numeric" value={settings.panelBridgeSftpPollIntervalSeconds} onChange={(event) => updateSetting("panelBridgeSftpPollIntervalSeconds", event.target.value)} /></div>
                        <DisabledReason reason={!canSetupBridge ? t("permissions.noBridgeSetup") : null}><Button type="button" variant="outline" onClick={handleTestSftp} disabled={testingSftp || bridgeLoading || !canSetupBridge}>{testingSftp ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Link className="me-2 h-4 w-4" />}{t("bridge.verifyAndPrepare")}</Button></DisabledReason>
                        <DisabledReason reason={!canSetupBridge ? t("permissions.noBridgeSetup") : null}><Button type="button" onClick={handleConfigureSftp} disabled={bridgeLoading || !canSetupBridge}>{bridgeLoading ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Cloud className="me-2 h-4 w-4" />}{t("bridge.startSftpBridge")}</Button></DisabledReason>
                      </div>
                      {bridgeStatus?.transport?.type === "sftp" && <div className="space-y-1 text-xs text-muted-foreground"><p>SFTP {bridgeStatus.transport.running ? t("bridge.sftpRunning") : t("bridge.sftpStopped")}{bridgeStatus.transport.lastLatencyMs != null ? t("bridge.lastSyncSuffix", { ms: bridgeStatus.transport.lastLatencyMs }) : ""}</p>{bridgeStatus.transport.lastError && <p className="text-warning">{getSftpStatusMessage(bridgeStatus.transport)}</p>}</div>}
                    </div>
                  </div>
            </SectionCard>

            <SectionCard
              collapsible
              defaultOpen={false}
              icon={FolderOpen}
              title={t("bridge.sectionRemoteConfigLogs")}
            >

                  <p className="text-xs text-muted-foreground">
                    <Trans t={t} i18nKey="bridge.serverLogsNote" components={{ b: <strong className="text-foreground" /> }} />
                  </p>

                  <div className="rounded-md border border-border/60 p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">{t("bridge.remoteConfigTitle")}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          <Trans t={t} i18nKey="bridge.remoteConfigDesc" components={{ code: <code /> }} />
                        </p>
                      </div>
                      <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
                    </div>
                    {/* impeccable-2026-08-31: below sm:, this used to stay a
                        row (flex-wrap alone doesn't force a break while
                        flex-1 can still shrink) -- the path input compressed
                        down to ~11 characters next to the button and clipped
                        the rest with no ellipsis. Stack on mobile, row from
                        sm: up, matching the same breakpoint the input's own
                        sm:min-w-[18rem] already used. */}
                    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
                      <div className="min-w-0 flex-1 space-y-1.5 sm:min-w-[18rem]">
                        <Label htmlFor="sftp-config-path">{t("bridge.remoteServerFolderLabel")}</Label>
                        <DisabledReason reason={sftpValueHidden} className="w-full">
                          <Input
                            id="sftp-config-path"
                            value={settings.panelBridgeSftpConfigPath}
                            onChange={(event) => updateSetting("panelBridgeSftpConfigPath", event.target.value)}
                            placeholder="/home/pz/Zomboid/Server"
                            disabled={Boolean(sftpValueHidden)}
                          />
                        </DisabledReason>
                      </div>
                      <DisabledReason reason={!canSetupBridge ? t("permissions.noBridgeSetup") : null}>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleCheckRemoteConfig}
                          disabled={loadingRemoteConfig || !settings.panelBridgeSftpConfigPath.trim() || !canSetupBridge}
                        >
                          {loadingRemoteConfig ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <FolderOpen className="me-2 h-4 w-4" />}
                          {t("bridge.checkFolder")}
                        </Button>
                      </DisabledReason>
                    </div>

                    {remoteConfigError && (
                      <p className="text-xs text-destructive">{remoteConfigError}</p>
                    )}

                    {remoteConfigFiles.length > 0 && (
                      <ul className="max-h-40 divide-y divide-border/40 overflow-auto rounded border border-border/50">
                        {remoteConfigFiles.map((file) => (
                          <li key={file.name} className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                            <span className="font-mono">{file.name}</span>
                            <span className="tabular-nums text-muted-foreground">{file.size} B</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="rounded-md border border-border/60 p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">{t("bridge.remoteLogsTitle")}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          <Trans t={t} i18nKey="bridge.remoteLogsDesc" components={{ code: <code /> }} />
                        </p>
                      </div>
                      <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
                    </div>
                    {/* impeccable-2026-08-31: same mobile truncation fix as
                        the Remote server folder row above. */}
                    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
                      <div className="min-w-0 flex-1 space-y-1.5 sm:min-w-[18rem]">
                        <Label htmlFor="sftp-log-path">{t("bridge.remoteLogFolderLabel")}</Label>
                        <DisabledReason reason={sftpValueHidden} className="w-full">
                          <Input
                            id="sftp-log-path"
                            value={settings.panelBridgeSftpLogPath}
                            onChange={(event) => updateSetting("panelBridgeSftpLogPath", event.target.value)}
                            placeholder="/home/pz/Zomboid/Logs"
                            disabled={Boolean(sftpValueHidden)}
                          />
                        </DisabledReason>
                      </div>
                      <DisabledReason reason={!canSetupBridge ? t("permissions.noBridgeSetup") : null}>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleListRemoteLogs}
                          disabled={loadingRemoteLogs || !settings.panelBridgeSftpLogPath.trim() || !canSetupBridge}
                        >
                          {loadingRemoteLogs ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <FolderOpen className="me-2 h-4 w-4" />}
                          {t("bridge.listLogs")}
                        </Button>
                      </DisabledReason>
                    </div>

                    {remoteLogError && (
                      <p className="text-xs text-destructive">{remoteLogError}</p>
                    )}

                    {remoteLogs.length > 0 && (
                      <div className="space-y-2">
                        <div className="max-h-48 overflow-auto rounded border border-border/50">
                          <ul className="divide-y divide-border/40">
                            {remoteLogs.map((file) => (
                              <li key={file.name} className="flex items-center justify-between gap-3 px-3 py-2">
                                <button
                                  type="button"
                                  onClick={() => handleTailRemoteLog(file.name)}
                                  disabled={!canSetupBridge}
                                  title={!canSetupBridge ? t("permissions.noBridgeSetup") : undefined}
                                  className="min-w-0 flex-1 truncate text-start text-xs font-mono text-primary hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
                                >
                                  {file.name}
                                </button>
                                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                                  {(file.size / 1024).toFixed(0)} KB
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          {t("bridge.selectFileHint")}
                        </p>
                      </div>
                    )}

                    {remoteLogContent && (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-medium">{remoteLogContent.name}</p>
                          <span className="text-[11px] text-muted-foreground">
                            {remoteLogContent.truncated ? t("bridge.tailOfPrefix") : ""}
                            {(remoteLogContent.bytesReturned / 1024).toFixed(0)} KB
                          </span>
                        </div>
                        <pre className="max-h-72 overflow-auto rounded border border-border/50 bg-background/60 p-3 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-words">
                          {remoteLogContent.content}
                        </pre>
                      </div>
                    )}
                  </div>
            </SectionCard>

            <SectionCard
              collapsible
              defaultOpen={false}
              icon={Download}
              title={t("bridge.sectionInstallUpdates")}
            >

                {/* Auto-update toggle */}
                <div className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/25 p-4">
                  <div>
                    <Label className="text-sm font-medium">
                      {t("bridge.autoUpdateLabel")}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t("bridge.autoUpdateDesc")}
                    </p>
                  </div>
                  <Switch
                    checked={settings.panelBridgeAutoUpdate}
                    onCheckedChange={(value) =>
                      updateSetting("panelBridgeAutoUpdate", value)
                    }
                    aria-label={t("ariaLabels.autoUpdateBridgeMod")}
                  />
                </div>

                {/* Install Mod */}
                <div className="p-4 bg-muted rounded-xl space-y-3">
                  <p className="text-sm font-medium">{t("bridge.installTitle")}</p>
                  <div className="flex flex-wrap gap-3 items-center">
                    <Select
                      value={selectedInstallServerId}
                      onValueChange={setSelectedInstallServerId}
                    >
                      <SelectTrigger className="w-[200px]">
                        <SelectValue placeholder={t("bridge.selectServerPlaceholder")} />
                      </SelectTrigger>
                      <SelectContent>
                        {servers.length === 0 ? (
                          <div className="px-2 py-1.5 text-sm text-muted-foreground">
                            {serversLoadError
                              ? t("bridge.serversLoadFailed")
                              : t("bridge.noServersConfigured")}
                          </div>
                        ) : (
                          servers.map((server) => (
                            <SelectItem
                              key={String(server.id)}
                              value={String(server.id)}
                            >
                              {server.name} {server.isActive ? t("bridge.activeSuffix") : ""}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                    <DisabledReason reason={!canSetupBridge ? t("permissions.noBridgeSetup") : null}>
                      <Button
                        onClick={handleInstallMod}
                        disabled={installingMod || !selectedInstallServerId || selectedInstallServer?.isRemote || !canSetupBridge}
                        className="gap-2"
                        variant="outline"
                      >
                        {installingMod ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Download className="w-4 h-4" />
                        )}
                        {t("bridge.installButton")}
                      </Button>
                    </DisabledReason>
                  </div>
                  {selectedInstallServer?.isRemote && (
                    <p className="text-xs text-warning">
                      {t("bridge.remoteInstallWarning")}
                    </p>
                  )}
                  {selectedInstallTarget && (
                    <p className="text-xs text-muted-foreground break-all">
                      {t("bridge.destinationLabel")}{" "}
                      <code className="bg-background px-1 rounded">
                        {selectedInstallTarget}
                      </code>
                    </p>
                  )}
                </div>
            </SectionCard>
          </TabsContent>

          <TabsContent value="mods" className="mt-0 space-y-6">
            {/* Mod Update Settings */}
            <SectionCard
              id="settings-mods"
              icon={Clock}
              title={t("mods.cardTitle")}
              description={t("mods.cardDesc")}
            >
                <div className="max-w-xs space-y-2">
                  <Label htmlFor="mod-check-interval" className="text-base">
                    {t("mods.checkIntervalLabel")}
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
                    {t("mods.checkIntervalHelp")}
                  </p>
                </div>
                <div className="flex items-center gap-3 p-4 rounded-xl bg-muted/50">
                  <Switch
                    checked={settings.modAutoRestart}
                    onCheckedChange={(value) =>
                      updateSetting("modAutoRestart", value)
                    }
                    aria-label={t("ariaLabels.autoRestartOnModUpdate")}
                  />
                  <div>
                    <Label className="text-base">
                      {t("mods.autoRestartLabel")}
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {t("mods.autoRestartDesc")}
                    </p>
                  </div>
                </div>
                {settings.modAutoRestart && (
                  <div className="max-w-xs space-y-2 ps-4 border-s-2 border-primary/30">
                    <Label htmlFor="mod-restart-delay" className="text-base">
                      {t("mods.restartDelayLabel")}
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
                      {t("mods.restartDelayHelp")}
                    </p>
                  </div>
                )}
                <div className="border-t border-border/60 pt-6">
                  <div className="flex items-center gap-3 p-4 rounded-xl bg-muted/50">
                    <Switch
                      checked={settings.serverAutoUpdate}
                      onCheckedChange={(value) =>
                        updateSetting("serverAutoUpdate", value)
                      }
                      aria-label={t("ariaLabels.autoUpdateGameServer")}
                    />
                    <div>
                      <Label className="text-base">
                        {t("mods.serverAutoUpdateLabel")}
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        {t("mods.serverAutoUpdateDesc")}
                      </p>
                    </div>
                  </div>
                  <div className="max-w-md space-y-2 ps-4 pt-4 border-s-2 border-primary/30">
                    <Label htmlFor="steam-update-account" className="text-base">
                      {t("mods.steamAccountLabel")}
                    </Label>
                    <DisabledReason reason={steamAccountHidden} className="w-full">
                      <Input
                        id="steam-update-account"
                        value={settings.steamUpdateAccount}
                        onChange={(e) => updateSetting("steamUpdateAccount", e.target.value)}
                        placeholder={t("mods.steamAccountPlaceholder")}
                        autoComplete="username"
                        className="h-11"
                        disabled={Boolean(steamAccountHidden)}
                      />
                    </DisabledReason>
                    <p className="text-sm text-muted-foreground">
                      {t("mods.steamAccountHelp")}
                    </p>
                  </div>
                  {settings.serverAutoUpdate && (
                    <div className="max-w-md space-y-2 ps-4 pt-4 border-s-2 border-primary/30">
                      <Label htmlFor="server-update-warning-minutes" className="text-base">
                        {t("mods.warningMinutesLabel")}
                      </Label>
                      <Input
                        id="server-update-warning-minutes"
                        type="number"
                        value={settings.serverAutoUpdateWarningMinutes}
                        onChange={(e) =>
                          updateSetting("serverAutoUpdateWarningMinutes", e.target.value)
                        }
                        onWheel={(e) => e.currentTarget.blur()}
                        min="0"
                        max="60"
                        className="h-11"
                        inputMode="numeric"
                      />
                      <p className="text-sm text-muted-foreground">
                        {t("mods.warningMinutesHelp")}
                      </p>
                    </div>
                  )}
                </div>
            </SectionCard>

            {/* Workshop Collection Sync ──────────────────────────────────────── */}
            <WorkshopCollectionSyncCard
              settings={settings}
              updateSetting={updateSetting}
              persistCookies={async (cookies) => {
                await configApi.updateAppSettings(cookies);
                setSettings((current) => ({ ...current, ...cookies }));
                setOriginalSettings((current) =>
                  current ? { ...current, ...cookies } : current,
                );
              }}
            />

            {/* API Keys */}
            <SectionCard
              id="settings-api-keys"
              icon={Key}
              title={t("mods.apiKeysCardTitle")}
              description={t("mods.apiKeysCardDesc")}
            >
                <div className="space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Label htmlFor="steam-api-key" className="text-base">
                      {t("mods.steamApiKeyLabel")}
                    </Label>
                    {/* Configured indicator — the API masks the value as "••••••••"
                  when set, so the presence of the bullets is a reliable signal
                  that a key is stored on the server. */}
                    {settings.steamApiKey &&
                    settings.steamApiKey.startsWith("•") ? (
                      <StatusPill size="sm" tone="ok" label={t("mods.configured")} />
                    ) : settings.steamApiKey ? (
                      <StatusPill size="sm" tone="warn" label={t("mods.pendingSave")} />
                    ) : (
                      <StatusPill size="sm" tone="idle" label={t("mods.notConfigured")} />
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
                      placeholder={t("mods.steamApiKeyPlaceholder")}
                      className="h-11 pe-10"
                      maxLength={128}
                    />
                    <button
                      type="button"
                      onClick={() => setShowSteamApiKey(!showSteamApiKey)}
                      className="absolute end-3 inset-y-0 flex items-center text-muted-foreground hover:text-foreground"
                      aria-label={
                        showSteamApiKey ? t("mods.hideApiKey") : t("mods.showApiKey")
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
                    {t("mods.steamApiKeyHelp")}
                  </p>
                  <div className="p-4 bg-muted rounded-xl text-sm mt-3">
                    <p className="font-medium mb-2">
                      {t("mods.howToGetKeyTitle")}
                    </p>
                    <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                      <li>
                        {t("mods.howToGetKeyStep1")}{" "}
                        <a
                          href="https://steamcommunity.com/dev/apikey"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          {t("mods.steamApiRegistration")}{" "}
                          <span className="sr-only">{t("mods.opensInNewTab")}</span>
                        </a>
                      </li>
                      <li>{t("mods.howToGetKeyStep2")}</li>
                      <li>
                        {t("mods.howToGetKeyStep3")}
                      </li>
                      <li>{t("mods.howToGetKeyStep4")}</li>
                    </ol>
                  </div>
                </div>
            </SectionCard>
          </TabsContent>

          <TabsContent value="backups" className="mt-0 space-y-6">
            <SectionCard
              id="settings-character-exports"
              icon={User}
              title={t("backups.characterExportsCardTitle")}
              description={t("backups.characterExportsCardDesc")}
            >
              <div className="flex items-start justify-between gap-4 rounded-lg border border-border/60 bg-muted/25 p-3">
                <div className="space-y-1">
                  <Label
                    htmlFor="auto-export-on-login"
                    className="text-sm font-medium"
                  >
                    {t("backups.autoExportLabel")}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t("backups.autoExportDesc")}
                  </p>
                </div>
                <Switch
                  id="auto-export-on-login"
                  checked={settings.autoExportOnLogin}
                  onCheckedChange={(value) =>
                    updateSetting("autoExportOnLogin", value)
                  }
                  aria-label={t("ariaLabels.exportCharacterOnJoin")}
                />
              </div>
              {settings.autoExportOnLogin && (
                <div className="max-w-xs space-y-1.5">
                  <Label htmlFor="auto-export-max">
                    {t("backups.copiesKeptLabel")}
                  </Label>
                  <Input
                    id="auto-export-max"
                    type="number"
                    min="1"
                    max="50"
                    inputMode="numeric"
                    value={settings.autoExportMaxPerPlayer}
                    onChange={(e) =>
                      updateSetting("autoExportMaxPerPlayer", e.target.value)
                    }
                    onWheel={(e) => e.currentTarget.blur()}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("backups.copiesKeptHelp")}
                  </p>
                </div>
              )}
            </SectionCard>

            {/* World backups, their schedule and how many are kept have one
                home: the World Backups page. This tab used to carry a second,
                smaller copy of that screen (its own list, restore, delete
                and schedule editor) that could disagree with it. */}
            <SectionCard
              id="settings-world-backups"
              icon={Archive}
              title={t("backups.worldBackupsLinkTitle")}
              description={t("backups.worldBackupsLinkDesc")}
              actions={
                <Button asChild variant="outline" size="sm" className="gap-2">
                  <RouterLink to="/backups?panel=schedule">
                    {t("backups.openWorldBackups")}
                    <ChevronRight className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
                  </RouterLink>
                </Button>
              }
            />
          </TabsContent>

          <TabsContent value="security" className="mt-0">
            {/* Security & Authentication */}
            <SectionCard
              id="settings-security"
              icon={Shield}
              title={t("security.cardTitle")}
              description={t("security.cardDesc")}
            >
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
                    <p className="text-base font-medium">{t("security.changePasswordTitle")}</p>
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
                        if (!meetsPasswordMinLength(newPassword)) return;
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
                          placeholder={t("security.currentPasswordPlaceholder")}
                          className="h-11 pe-10"
                          maxLength={128}
                          autoComplete="current-password"
                          aria-label={t("ariaLabels.currentPassword")}
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setShowCurrentPassword(!showCurrentPassword)
                          }
                          className="absolute end-3 inset-y-0 flex items-center text-muted-foreground hover:text-foreground"
                          aria-label={
                            showCurrentPassword
                              ? t("security.hidePassword")
                              : t("security.showPassword")
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
                          placeholder={t("security.newPasswordPlaceholder")}
                          className="h-11 pe-10"
                          maxLength={128}
                          autoComplete="new-password"
                          aria-label={t("ariaLabels.newPassword")}
                        />
                        <button
                          type="button"
                          onClick={() => setShowNewPassword(!showNewPassword)}
                          className="absolute end-3 inset-y-0 flex items-center text-muted-foreground hover:text-foreground"
                          aria-label={
                            showNewPassword ? t("security.hidePassword") : t("security.showPassword")
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
                        placeholder={t("security.confirmPasswordPlaceholder")}
                        className="h-11"
                        maxLength={128}
                        autoComplete="new-password"
                        aria-label={t("ariaLabels.confirmNewPassword")}
                      />
                      {newPassword &&
                        confirmPassword &&
                        newPassword !== confirmPassword && (
                          <p
                            className="text-xs text-destructive flex items-center gap-1"
                            role="alert"
                          >
                            <XCircle className="w-3 h-3" /> {t("security.passwordsDontMatch")}
                          </p>
                        )}
                      {newPassword && !meetsPasswordMinLength(newPassword) && (
                        <p
                          className="text-xs text-destructive flex items-center gap-1"
                          role="alert"
                        >
                          <XCircle className="w-3 h-3" /> {t("security.passwordTooShort")}
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
                          !meetsPasswordMinLength(newPassword)
                        }
                        className="gap-2"
                      >
                        {changingPassword ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Key className="w-4 h-4" />
                        )}
                        {changingPassword ? t("security.changingButton") : t("security.changeButton")}
                      </Button>
                    </form>

                    <div className="max-w-2xl rounded-xl border border-border/70 p-4 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-foreground">
                            {t("security.recoveryCodesTitle")}
                          </p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {t("security.recoveryCodesDesc")}
                          </p>
                        </div>
                        <Key className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      </div>

                      <form
                        className="flex flex-wrap items-center gap-3"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (!generatingRecoveryCodes) void handleGenerateRecoveryCodes();
                        }}
                      >
                        <Input
                          type="password"
                          value={recoveryCodesPassword}
                          onChange={(e) => setRecoveryCodesPassword(e.target.value)}
                          placeholder={t("security.currentPasswordPlaceholder")}
                          className="h-10 w-full sm:w-56"
                          maxLength={128}
                          autoComplete="current-password"
                          aria-label={t("ariaLabels.currentPassword")}
                        />
                        <Button
                          type="submit"
                          variant="outline"
                          disabled={generatingRecoveryCodes || !recoveryCodesPassword}
                        >
                          {generatingRecoveryCodes ? (
                            <Loader2 className="me-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Key className="me-2 h-4 w-4" />
                          )}
                          {recoveryCodeStatus?.configured
                            ? t("security.generateNewCodes")
                            : t("security.generateCodes")}
                        </Button>
                        {recoveryCodeStatus && (
                          <span className="text-xs text-muted-foreground">
                            {recoveryCodeStatus.configured
                              ? t("security.codesUnusedStatus", { remaining: recoveryCodeStatus.remaining, total: recoveryCodeStatus.total })
                              : t("security.noCodesYet")}
                          </span>
                        )}
                      </form>

                      {recoveryCodeStatus?.configured && (
                        <p className="text-xs text-muted-foreground">
                          {t("security.regenerateReplacesNote")}
                        </p>
                      )}

                      {generatedRecoveryCodes.length > 0 && (
                        <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3">
                          <p className="text-xs font-medium text-warning">
                            {t("security.copyCodesNowWarning")}
                          </p>
                          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                            {generatedRecoveryCodes.map((code) => (
                              <code
                                key={code}
                                className="rounded bg-background/70 px-2 py-1 font-mono text-xs tracking-wider"
                              >
                                {code}
                              </code>
                            ))}
                          </div>
                          <div className="flex flex-wrap gap-2 pt-1">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                const blob = new Blob(
                                  [
                                    `Zomboid Control Panel recovery codes\nGenerated: ${new Date().toISOString()}\nEach code works once.\n\n${generatedRecoveryCodes.join("\n")}\n`,
                                  ],
                                  { type: "text/plain" },
                                );
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement("a");
                                a.href = url;
                                a.download = "zomboid-panel-recovery-codes.txt";
                                document.body.appendChild(a);
                                a.click();
                                a.remove();
                                window.setTimeout(() => URL.revokeObjectURL(url), 1500);
                              }}
                            >
                              <Download className="me-1.5 h-3.5 w-3.5" />
                              {t("security.downloadButton")}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setGeneratedRecoveryCodes([])}
                            >
                              {t("security.doneButton")}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="max-w-2xl rounded-xl border border-border/70 bg-muted/35 p-4 text-sm text-muted-foreground">
                      <div className="flex items-start gap-3">
                        <Info className="mt-0.5 h-4 w-4 text-primary" />
                        <div className="space-y-1.5 leading-6">
                          <p className="font-medium text-foreground">
                            {t("security.recoveryTitle")}
                          </p>
                          {localPasswordResetSupported ? (
                            <>
                              <p>
                                {t("security.recoveryLocalIntro")}
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
                                    <Loader2 className="me-2 h-4 w-4 animate-spin" />
                                  ) : (
                                    <Key className="me-2 h-4 w-4" />
                                  )}
                                  {showLocalPasswordReset
                                    ? t("security.refreshLocalRecovery")
                                    : t("security.resetPasswordOnServer")}
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
                                    {t("security.hideButton")}
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
                                  <Input
                                    type="text"
                                    value={localPasswordResetToken}
                                    onChange={(e) =>
                                      setLocalPasswordResetToken(
                                        e.target.value,
                                      )
                                    }
                                    placeholder={t(
                                      "security.recoveryTokenPlaceholder",
                                    )}
                                    className="h-11"
                                    autoComplete="off"
                                    aria-label={t(
                                      "ariaLabels.recoveryTokenLocalReset",
                                    )}
                                  />
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
                                      placeholder={t("security.newPasswordForResetLabel")}
                                      className="h-11 pe-10"
                                      maxLength={128}
                                      autoComplete="new-password"
                                      aria-label={t("ariaLabels.newPasswordLocalReset")}
                                    />
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setShowLocalResetPassword(
                                          !showLocalResetPassword,
                                        )
                                      }
                                      className="absolute end-3 inset-y-0 flex items-center text-muted-foreground hover:text-foreground"
                                      aria-label={
                                        showLocalResetPassword
                                          ? t("security.hidePassword")
                                          : t("security.showPassword")
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
                                    placeholder={t("security.confirmNewPasswordLabel")}
                                    className="h-11"
                                    maxLength={128}
                                    autoComplete="new-password"
                                    aria-label={t("ariaLabels.confirmNewPasswordLocalReset")}
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
                                        {t("security.passwordsDontMatch")}
                                      </p>
                                    )}
                                  {localPasswordResetPassword &&
                                    !meetsPasswordMinLength(localPasswordResetPassword) && (
                                      <p
                                        className="text-xs text-destructive flex items-center gap-1"
                                        role="alert"
                                      >
                                        <XCircle className="w-3 h-3" /> {t("security.passwordTooShort")}
                                      </p>
                                    )}
                                  <Button
                                    type="submit"
                                    className="gap-2"
                                    disabled={
                                      resettingLocalPassword ||
                                      preparingLocalPasswordReset ||
                                      !localPasswordResetToken ||
                                      !localPasswordResetPassword ||
                                      !localPasswordResetConfirm ||
                                      localPasswordResetPassword !==
                                        localPasswordResetConfirm ||
                                      !meetsPasswordMinLength(localPasswordResetPassword)
                                    }
                                  >
                                    {resettingLocalPassword ? (
                                      <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : (
                                      <Key className="w-4 h-4" />
                                    )}
                                    {resettingLocalPassword
                                      ? t("security.resettingButton")
                                      : t("security.resetAndSignOutButton")}
                                  </Button>
                                </form>
                              )}
                            </>
                          ) : (
                            <>
                              <p>
                                <Trans t={t} i18nKey="security.recoveryRemoteIntro1" components={{ code: <span className="font-mono text-foreground/85" /> }} />
                              </p>
                              <p>
                                {t("security.recoveryRemoteIntro2")}
                              </p>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {user && (
                      <div className="max-w-2xl rounded-xl border border-border/70 bg-background/40 p-4 space-y-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium text-foreground">
                              {t("security.signOutEverywhere.cardTitle")}
                            </p>
                            <p className="mt-1 text-sm text-muted-foreground">
                              {t("security.signOutEverywhere.cardDesc")}
                            </p>
                          </div>
                          <LogOut className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground rtl:-scale-x-100" />
                        </div>
                        <AlertDialog open={signOutEverywhereDialogOpen} onOpenChange={setSignOutEverywhereDialogOpen}>
                          <AlertDialogTrigger asChild>
                            <Button type="button" variant="outline">
                              <LogOut className="me-2 h-4 w-4 rtl:-scale-x-100" />
                              {t("security.signOutEverywhere.button")}
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>{t("security.signOutEverywhere.confirmTitle")}</AlertDialogTitle>
                              <AlertDialogDescription>
                                {t("security.signOutEverywhere.confirmDesc")}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel disabled={signingOutEverywhere}>{t("security.signOutEverywhere.cancel")}</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={(e) => {
                                  e.preventDefault();
                                  void handleSignOutEverywhere();
                                }}
                                disabled={signingOutEverywhere}
                              >
                                {signingOutEverywhere && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                                {t("security.signOutEverywhere.confirm")}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    )}

                    {user?.role === "admin" && (
                      <div className="max-w-2xl rounded-xl border border-destructive/40 bg-destructive/5 p-4 space-y-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium text-foreground">
                              {t("security.regenerateJwt.cardTitle")}
                            </p>
                            <p className="mt-1 text-sm text-muted-foreground">
                              {t("security.regenerateJwt.cardDesc")}
                            </p>
                          </div>
                          <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                        </div>
                        <AlertDialog open={regenerateJwtDialogOpen} onOpenChange={setRegenerateJwtDialogOpen}>
                          <AlertDialogTrigger asChild>
                            <Button type="button" variant="destructive">
                              <RefreshCw className="me-2 h-4 w-4" />
                              {t("security.regenerateJwt.button")}
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle className="flex items-center gap-2">
                                <AlertTriangle className="h-5 w-5 text-destructive" />
                                {t("security.regenerateJwt.confirmTitle")}
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                {t("security.regenerateJwt.confirmDesc")}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel disabled={regeneratingJwtSecret}>{t("security.regenerateJwt.cancel")}</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={(e) => {
                                  e.preventDefault();
                                  void handleRegenerateJwtSecret();
                                }}
                                disabled={regeneratingJwtSecret}
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              >
                                {regeneratingJwtSecret ? (
                                  <Loader2 className="me-2 h-4 w-4 animate-spin" />
                                ) : null}
                                {t("security.regenerateJwt.confirm")}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    )}
                  </div>
                )}

                {/* Security Tips */}
                <div className="space-y-3 text-sm text-muted-foreground pt-2 border-t">
                  <p>
                    <strong className="text-foreground">{t("security.tipsRconTitle")}</strong>{" "}
                    {t("security.tipsRconDesc")}
                  </p>
                  <p>
                    <strong className="text-foreground">{t("security.tipsAdminTitle")}</strong>{" "}
                    {t("security.tipsAdminDesc")}
                  </p>
                  {!authEnabled && (
                    <p>
                      <strong className="text-foreground">
                        {t("security.tipsAuthTitle")}
                      </strong>{" "}
                      {t("security.tipsAuthDesc")}
                    </p>
                  )}
                </div>
            </SectionCard>
          </TabsContent>

          <TabsContent value="users" className="mt-0">
            <Users embedded />
          </TabsContent>

          <TabsContent value="roles" className="mt-0">
            <RolesPermissions embedded />
          </TabsContent>

          <TabsContent
            value="sso"
            forceMount={ssoDirty || undefined}
            className="mt-0 data-[state=inactive]:hidden"
          >
            <OidcSettings
              embedded
              active={activeSection === "sso"}
              onDirtyChange={setSsoDirty}
            />
          </TabsContent>

          <TabsContent value="about" className="mt-0 space-y-6">
            <SectionCard
              id="settings-elsewhere"
              icon={ExternalLink}
              title={t("about.elsewhereCardTitle")}
              description={t("about.elsewhereCardDesc")}
            >
                <ul className="divide-y divide-border/50">
                  {[
                    {
                      href: "/servers",
                      label: t("about.elsewhereServers.label"),
                      detail: t("about.elsewhereServers.detail"),
                    },
                    {
                      href: "/discord",
                      label: t("about.elsewhereDiscord.label"),
                      detail: t("about.elsewhereDiscord.detail"),
                    },
                    {
                      href: "/scheduler",
                      label: t("about.elsewhereScheduler.label"),
                      detail: t("about.elsewhereScheduler.detail"),
                    },
                    {
                      href: "/backups?panel=schedule",
                      label: t("about.elsewhereBackups.label"),
                      detail: t("about.elsewhereBackups.detail"),
                    },
                    {
                      href: "/server-config",
                      label: t("about.elsewhereServerConfig.label"),
                      detail: t("about.elsewhereServerConfig.detail"),
                    },
                    {
                      href: "/chat",
                      label: t("about.elsewhereChat.label"),
                      detail: t("about.elsewhereChat.detail"),
                    },
                  ].map((item) => (
                    <li key={item.href}>
                      <RouterLink
                        to={item.href}
                        className="flex items-center justify-between gap-4 py-2.5 group"
                      >
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-foreground group-hover:text-primary">
                            {item.label}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {item.detail}
                          </span>
                        </span>
                        {/* An in-app link: a chevron, not the new-tab icon. */}
                        <ChevronRight
                          className="w-4 h-4 shrink-0 text-muted-foreground/60 group-hover:text-primary rtl:-scale-x-100"
                          aria-hidden="true"
                        />
                      </RouterLink>
                    </li>
                  ))}
                </ul>
            </SectionCard>

            {/* About */}
            <SectionCard
              id="settings-about"
              icon={Server}
              title={t("about.aboutCardTitle")}
              description={t("about.aboutCardDesc")}
            >
                {/* Version row */}
                <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <p className="label-micro mb-1">
                        {t("about.installedVersionLabel")}
                      </p>
                      <p className="text-lg font-semibold tabular-nums">
                        v{panelUpdateStatus?.currentVersion || "—"}
                      </p>
                    </div>
                    <div>
                      <p className="label-micro mb-1">
                        {t("about.latestAvailableLabel")}
                      </p>
                      <p className="text-lg font-semibold tabular-nums flex items-center gap-2">
                        {panelUpdateStatus?.latestVersion ? (
                          <>
                            v{panelUpdateStatus.latestVersion}
                            {panelUpdateStatus.updateAvailable ? (
                              <StatusPill size="sm" tone="warn" label={t("about.updateAvailableBadge")} />
                            ) : (
                              /* impeccable-2026-08-31: installed/latest matching used to render as
                                 two bare numbers with no affirmative status -- the operator has to
                                 compare them manually. The Updates tab already shows this same fact
                                 with a status pill (statusUpToDate); this reuses that pattern instead
                                 of leaving the "everything's fine" case silent next to the "update
                                 available" case, which does get a badge. */
                              <StatusPill size="sm" tone="ok" label={t("about.upToDateBadge")} />
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground text-base font-normal">
                            {t("about.notCheckedYet")}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Description */}
                <p className="text-sm text-muted-foreground">
                  {t("about.description")}
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
                      <p className="text-sm font-medium">{t("about.supportTitle")}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("about.supportDesc")}
                      </p>
                    </div>
                  </div>
                  <a
                    href={KOFI_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#FF5E5B] px-4 py-2 text-sm font-medium text-white hover:bg-[#FF4541] transition-colors shrink-0 shadow-sm"
                    aria-label={t("ariaLabels.buyMeCoffeeKofi")}
                  >
                    <Coffee className="w-3.5 h-3.5" aria-hidden="true" />
                    {t("about.buyMeCoffee")}
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
                    {t("about.joinDiscord")}
                  </a>
                  <a
                    href="https://github.com/fpsacha/zomboid-control-panel"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                    {t("about.githubRepo")}
                  </a>
                  <a
                    href="https://github.com/fpsacha/zomboid-control-panel/releases"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                    {t("about.releasesChangelog")}
                  </a>
                  <a
                    href="https://github.com/fpsacha/zomboid-control-panel/issues"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                    {t("about.reportIssue")}
                  </a>
                </div>

                <div className="pt-4 border-t border-border/40 text-xs text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span>{t("about.builtWith")}</span>
                  <span aria-hidden="true">·</span>
                  <span>{t("about.mitLicensed")}</span>
                </div>
            </SectionCard>
          </TabsContent>
        </SubNavLayout>
      </Tabs>

      <AlertDialog
        open={pendingCorsLanDisable}
        onOpenChange={setPendingCorsLanDisable}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("corsLockoutDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              <Trans t={t} i18nKey="corsLockoutDialog.description" components={{ b: <strong /> }} />
              <br />
              <br />
              <Trans t={t} i18nKey="corsLockoutDialog.recoveryHint" components={{ code: <code className="mx-1" /> }} />
              <br />
              <br />
              {t("corsLockoutDialog.addOriginFirst")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("corsLockoutDialog.keepLanOn")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                updateSetting("corsAllowPrivateNetworks", false);
                setPendingCorsLanDisable(false);
              }}
            >
              {t("corsLockoutDialog.disableAnyway")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* The one save for the shared settings: it shows while any tab
          holds an edit (the rail marks which), saves all of them, and says
          why Save is off. Users, Roles & Permissions and Single Sign-On
          save on their own, so it stays out of their way there. */}
      {editsSharedSettings && (
        <SaveBar
          dirty={isDirty}
          saving={saving}
          onSave={handleSave}
          onDiscard={() => {
            if (originalSettings) setSettings(originalSettings);
          }}
          changeCount={changedSettingKeys.length}
          disabledReason={saveDisabledReason}
          saveLabel={t("unsavedBanner.saveButton")}
        />
      )}
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
  persistCookies,
}: {
  settings: AppSettings;
  updateSetting: (
    key: keyof AppSettings,
    value: AppSettings[keyof AppSettings],
  ) => void;
  persistCookies: (cookies: Pick<AppSettings, "steamSessionId" | "steamLoginSecure">) => Promise<void>;
}) {
  // pz-pam-r26: also need the 'mods' namespace loaded here, to reuse its
  // existing permissions.noModsManage string for handleAutoExtract below
  // (POST /mods/collection/extract-cookies is gated mods.manage, not
  // panel.settings like the rest of this card) rather than duplicating
  // the same English sentence into settings.json's own permissions section.
  const { t } = useTranslation(["settings", "mods"]);
  const { formatTime } = useDateFormat();
  const { toast } = useToast();
  // pz-pam-r23 (remaining client-side capability gates): persistCookies
  // (below) is a thin wrapper around configApi.updateAppSettings(), same
  // PUT /config/app-settings route as the General Save button -- gated
  // requirePermission("panel.settings") server-side, confirmed via
  // server/routes/config.js. This card is a separate function component
  // (not sharing Settings.tsx's own canSavePanelSettings const), so it
  // needs its own useAuth() call.
  const { can } = useAuth();
  const canPersistCookies = can("panel.settings");
  // pz-pam-r26: handleAutoExtract below (local-browser cookie extraction,
  // POST /mods/collection/extract-cookies) is a DIFFERENT route than the
  // rest of this card -- server/routes/mods.js gates its whole router
  // behind requirePermission("mods.manage") (confirmed by reading the
  // router.use() middleware directly, not inferred), not panel.settings.
  const canManageMods = can("mods.manage");
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
  const [savingCookies, setSavingCookies] = useState(false);
  const [testing, setTesting] = useState(false);
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
  // Mods.tsx confirms this exact modsApi.batchRemove operation on both its
  // row and bulk paths; this row here reached the same server mutation with
  // no confirm at all.
  const [removeServerTarget, setRemoveServerTarget] = useState<{
    workshopId: string;
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
  // diff already carries this -- WorkshopCollectionPanel.tsx (the other,
  // independent implementation of these same row actions) reads it to
  // refuse add/remove early with a clear reason; this page fetches the
  // identical collectionDiff() response but never read the field.
  const tokenExpired = !!diff?.tokenExpired;

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
    if (!raw || !raw.trim()) return { error: t("workshopSync.toasts.nothingToParse") };
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
      return { error: t("workshopSync.toasts.noCookiesFound") };
    }
    const result: { sessionId?: string; loginSecure?: string } = {};
    if (sessionMatch) result.sessionId = safeDecode(sessionMatch[1]);
    if (loginMatch) result.loginSecure = safeDecode(loginMatch[1]);
    return result;
  };

  const saveExtractedCookies = async (
    sessionId: string,
    loginSecure: string,
  ) => {
    if (!canPersistCookies) return false;
    setSavingCookies(true);
    try {
      await persistCookies({
        steamSessionId: sessionId,
        steamLoginSecure: loginSecure,
      });
      toast({
        title: t("workshopSync.toasts.cookiesSaved.title"),
        description: t("workshopSync.toasts.cookiesSaved.description"),
        variant: "success" as const,
      });
      return true;
    } catch (error) {
      setPasteError(
        getUserErrorMessage(error, t("workshopSync.toasts.couldNotSaveCookies")),
      );
      return false;
    } finally {
      setSavingCookies(false);
    }
  };

  const handlePasteApply = async () => {
    setPasteError(null);
    const parsed = parseCookieBlob(pasteText);
    if (parsed.error) {
      setPasteError(parsed.error);
      return;
    }
    if (!parsed.sessionId && !parsed.loginSecure) {
      setPasteError(t("workshopSync.toasts.nothingUsableFound"));
      return;
    }
    const { sessionId, loginSecure } = parsed;
    if (sessionId && loginSecure) {
      if (await saveExtractedCookies(sessionId, loginSecure)) {
        setPasteText("");
        setPasteOpen(false);
      }
      return;
    }
    if (parsed.sessionId) updateSetting("steamSessionId", parsed.sessionId);
    if (parsed.loginSecure) updateSetting("steamLoginSecure", parsed.loginSecure);
    toast({
      title: t("workshopSync.toasts.partialExtraction.title"),
      description: t("workshopSync.toasts.partialExtraction.description", { field: parsed.sessionId ? "sessionid" : "steamLoginSecure" }),
      variant: "destructive",
    });
    setPasteText("");
    setPasteOpen(false);
  };

  const handlePasteFromClipboard = async () => {
    setPasteError(null);
    if (!clipboardReadAvailable) {
      setPasteOpen(true);
      setPasteError(
        t("workshopSync.toasts.clipboardNeedsHttps"),
      );
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        setPasteOpen(true);
        setPasteError(t("workshopSync.toasts.clipboardEmpty"));
        return;
      }
      const parsed = parseCookieBlob(text);
      const { sessionId, loginSecure } = parsed;
      if (sessionId && loginSecure) {
        if (await saveExtractedCookies(sessionId, loginSecure)) {
          setPasteText("");
          setPasteOpen(false);
        }
        return;
      }
      // Partial / no match: surface the textarea so the user can see what
      // was pasted and either fix it or grab the missing piece manually.
      setPasteText(text);
      setPasteOpen(true);
      setPasteError(
        parsed.error || t("workshopSync.toasts.clipboardNoMatch"),
      );
    } catch (err: any) {
      setPasteOpen(true);
      setPasteError(
        getUserErrorMessage(err, t("workshopSync.toasts.clipboardReadFailed")),
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
      setDiffError(getUserErrorMessage(err, t("workshopSync.toasts.failedToReadCollection")));
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
    if (extractingFrom || !canManageMods) return;
    setExtractingFrom(browserId);
    try {
      const r = await modsApi.collectionExtractCookies(browserId);
      if (r.ok && r.saved) {
        // The server already saved these -- it never sends the raw values
        // back (2026-08-26 bug hunt). Refresh the same way every other
        // credential-changing action on this card does, rather than
        // reconstructing a local mask we don't have the real value for.
        toast({
          title: t("workshopSync.toasts.cookiesSaved.title"),
          description: t("workshopSync.toasts.cookiesSaved.description"),
          variant: "success" as const,
        });
        if (r.notes && r.notes.length > 0) {
          toast({ title: t("workshopSync.toasts.extractedFrom.title", { browser: label }), description: r.notes[0] });
        }
        await refreshDiff();
      } else {
        toast({
          variant: "destructive",
          title: t("workshopSync.toasts.extractFailed.title", { browser: label }),
          description: r.error || t("workshopSync.toasts.extractFailed.unknownError"),
        });
      }
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: t("workshopSync.toasts.extractFailed.title", { browser: label }),
        description: getUserErrorMessage(err, t("workshopSync.toasts.extractFailed.requestFailed")),
      });
    } finally {
      setExtractingFrom(null);
    }
  };

  const handleTest = async () => {
    if (testing) return;
    setTesting(true);
    try {
      const r = await modsApi.collectionTest();
      toast({ title: t("workshopSync.toasts.connectionOk.title"), description: r.message });
      await refreshDiff();
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: t("workshopSync.toasts.testFailed.title"),
        description: getUserErrorMessage(err, t("workshopSync.toasts.testFailed.fallback")),
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
            t("workshopSync.toasts.cookiesFirstError"),
          );
        if (tokenExpired)
          throw new Error(t("workshopSync.toasts.sessionExpiredError"));
        await modsApi.collectionAddItem(workshopId);
      } else if (action === "remove") {
        if (!credsConfigured)
          throw new Error(
            t("workshopSync.toasts.cookiesFirstError"),
          );
        if (tokenExpired)
          throw new Error(t("workshopSync.toasts.sessionExpiredError"));
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
          title: t("workshopSync.toasts.addedToServer.title"),
          description: t("workshopSync.toasts.addedToServer.description"),
        });
      } else if (action === "remove-server") {
        await modsApi.batchRemove([workshopId]);
        toast({
          title: t("workshopSync.toasts.removedFromServer.title"),
          description: diff?.autoSync
            ? t("workshopSync.toasts.removedFromServer.descAutoSync")
            : t("workshopSync.toasts.removedFromServer.descNoAutoSync"),
        });
      } else if (action === "purge") {
        const r = await modsApi.purgeMod(workshopId, name);
        const done = [
          r.collection.attempted
            ? r.collection.ok
              ? t("workshopSync.toasts.purgeCollectionRemoved")
              : t("workshopSync.toasts.purgeCollectionNotUpdated", { reason: r.collection.error || t("workshopSync.toasts.purgeCollectionRejected") })
            : null,
          t("workshopSync.toasts.purgeServerRemoved"),
          r.deletedFromDisk ? t("workshopSync.toasts.purgeDiskDeleted") : t("workshopSync.toasts.purgeDiskNoFiles"),
          t("workshopSync.toasts.purgeUntracked"),
        ].filter(Boolean);
        toast({
          title: t("workshopSync.toasts.removedEverywhere.title", { name: r.name || workshopId }),
          description: `${done.join(", ")}.`,
        });
      }
      await refreshDiff();
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: t("workshopSync.toasts.actionFailed.title"),
        description: getUserErrorMessage(err, t("workshopSync.toasts.actionFailed.fallback")),
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
    <SectionCard
      id="settings-workshop-collection"
      icon={RefreshCw}
      title={t("workshopSync.cardTitle")}
      description={t("workshopSync.cardDesc")}
    >
        <div className="grid gap-6 border-b border-border/40 pb-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,.8fr)]">
        {/* Collection ID */}
        <div className="space-y-2 lg:order-1">
          <Label htmlFor="ws-collection-id" className="text-base">
            {t("workshopSync.collectionIdLabel")}
          </Label>
          <Input
            id="ws-collection-id"
            value={settings.workshopCollectionId}
            onChange={(e) =>
              updateSetting("workshopCollectionId", e.target.value.trim())
            }
            placeholder={t("workshopSync.collectionIdPlaceholder")}
            className="h-11 max-w-md font-mono"
            maxLength={20}
          />
          <p className="text-sm text-muted-foreground">
            <Trans t={t} i18nKey="workshopSync.collectionIdHelp" components={{ code: <code /> }} />
          </p>
        </div>

        {/* Auto-sync toggle */}
        <div
          className={`flex items-start justify-between gap-4 lg:order-2 lg:border-s lg:border-border/40 lg:ps-6 ${
            autoSyncOn && !credsConfigured
              ? "text-warning"
              : ""
          }`}
        >
          <div className="space-y-1">
            <Label className="text-base">{t("workshopSync.autoSyncLabel")}</Label>
            <p className="text-sm text-muted-foreground">
              {t("workshopSync.autoSyncDesc")}
            </p>
            {autoSyncOn && !credsConfigured && (
              <p className="text-xs text-warning flex items-center gap-1 pt-1">
                <AlertTriangle className="w-3 h-3" />
                {t("workshopSync.autoSyncNeedsCookies")}
              </p>
            )}
            {autoSyncOn && !collectionIdValid && (
              <p className="text-xs text-warning flex items-center gap-1 pt-1">
                <AlertTriangle className="w-3 h-3" />
                {t("workshopSync.autoSyncNeedsCollectionId")}
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
        </div>

        {/* Steam session cookies */}
        {/* impeccable-2026-08-31: this whole section -- auto-detect from
            browser, paste-a-request, manual cookie fields -- used to render
            fully expanded even though none of it does anything until a
            Collection ID is set (Test Connection and Check Drift below are
            already disabled on !collectionIdValid). The one hint that said
            so was a small corner label, easy to miss. Gate the section
            itself instead: shorter page by default, and the placeholder
            names the actual next step instead of leaving it implicit. */}
        {collectionIdValid ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Label className="text-base">{t("workshopSync.cookiesLabel")}</Label>
            {credsConfigured ? (
              <StatusPill size="sm" tone="ok" label={t("workshopSync.configured")} />
            ) : (
              <StatusPill size="sm" tone="idle" label={t("workshopSync.notConfigured")} />
            )}
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
              {showCookies ? t("workshopSync.hide") : t("workshopSync.show")}
            </button>
          </div>
          <p className="text-sm text-muted-foreground">
            <Trans t={t} i18nKey="workshopSync.cookiesHelp" components={{ b: <strong /> }} />
          </p>
          <div className="grid gap-3 sm:grid-cols-2 max-w-3xl">
            <div className="space-y-1">
              <Label
                htmlFor="ws-sessionid"
                className="text-xs text-muted-foreground"
              >
                {t("workshopSync.sessionIdLabel")}
              </Label>
              <Input
                id="ws-sessionid"
                type={showCookies ? "text" : "password"}
                value={settings.steamSessionId}
                onChange={(e) =>
                  updateSetting("steamSessionId", e.target.value.trim())
                }
                placeholder={t("workshopSync.sessionIdPlaceholder")}
                className="h-10 font-mono"
                maxLength={64}
              />
            </div>
            <div className="space-y-1">
              <Label
                htmlFor="ws-loginsecure"
                className="text-xs text-muted-foreground"
              >
                {t("workshopSync.loginSecureLabel")}
              </Label>
              <Input
                id="ws-loginsecure"
                type={showCookies ? "text" : "password"}
                value={settings.steamLoginSecure}
                onChange={(e) =>
                  updateSetting("steamLoginSecure", e.target.value.trim())
                }
                placeholder={t("workshopSync.loginSecurePlaceholder")}
                className="h-10 font-mono"
                maxLength={512}
              />
            </div>
          </div>
          {/* Auto-detect from local browser — fastest path when Steam is
              logged in on the same machine the panel runs on. */}
          {browsers &&
            browsers.supported &&
            browsers.browsers.some((b) => b.detected) && (
              <div className="border-t border-border/40 pt-4 space-y-3">
                <div className="flex items-start gap-3">
                  <Zap className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1 space-y-1">
                    <p className="font-medium text-sm">
                      {t("workshopSync.autoDetectTitle")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      <Trans t={t} i18nKey="workshopSync.autoDetectDesc" components={{ b: <strong /> }} />
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {browsers.browsers
                    .filter((b) => b.detected)
                    .map((b) => (
                      <DisabledReason key={b.id} reason={!canManageMods ? t("mods:permissions.noModsManage") : null}>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={!!extractingFrom || !canManageMods}
                          onClick={() => handleAutoExtract(b.id, b.label)}
                        >
                          {extractingFrom === b.id ? (
                            <RefreshCw className="w-3.5 h-3.5 me-1.5 animate-spin" />
                          ) : (
                            <Check className="w-3.5 h-3.5 me-1.5" />
                          )}
                          {b.label}
                        </Button>
                      </DisabledReason>
                    ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  <Trans t={t} i18nKey="workshopSync.chromeSealNote" components={{ code: <code /> }} />
                </p>
              </div>
            )}

          {/* Paste helper — much faster than copying two cookies by hand */}
          <div className="border-t border-border/40 pt-4 space-y-3">
            <div className="flex items-start gap-3">
              <Zap className="w-4 h-4 text-primary mt-0.5 shrink-0" />
              <div className="flex-1 space-y-1">
                <p className="font-medium text-sm">
                  {t("workshopSync.quickSetupTitle")}
                </p>
                <p className="text-xs text-muted-foreground">
                  <Trans t={t} i18nKey="workshopSync.quickSetupDesc" components={{ code: <code /> }} />
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("workshopSync.cookieExporterPrefix")}{" "}
                  <a
                    href="https://github.com/kairi003/Get-cookies.txt-LOCALLY"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    {t("workshopSync.cookieExporterLink")}
                    <ExternalLink className="w-3 h-3" />
                  </a>{" "}
                  <Trans t={t} i18nKey="workshopSync.cookieExporterSuffix" components={{ code: <code />, em: <em /> }} />
                </p>
              </div>
            </div>

            {!pasteOpen ? (
              <div className="flex flex-wrap gap-2">
                {clipboardReadAvailable && (
                  <DisabledReason reason={!canPersistCookies ? t("permissions.noPanelSettings") : null}>
                    <Button
                      type="button"
                      size="sm"
                      variant="default"
                      onClick={handlePasteFromClipboard}
                      disabled={savingCookies || !canPersistCookies}
                    >
                      <Cloud className="w-3.5 h-3.5 me-1.5" />
                      {t("workshopSync.pasteFromClipboard")}
                    </Button>
                  </DisabledReason>
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
                    ? t("workshopSync.pasteManually")
                    : t("workshopSync.pasteCookies")}
                </Button>
                <a
                  href="https://steamcommunity.com/my/myworkshopfiles/?section=collections"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline self-center"
                >
                  {t("workshopSync.openSteamCollections")} <ExternalLink className="w-3 h-3" />
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
                  placeholder={t("workshopSync.pastePlaceholder")}
                  rows={4}
                  className="font-mono text-xs"
                />
                <div className="flex flex-wrap gap-2">
                  <DisabledReason reason={!canPersistCookies ? t("permissions.noPanelSettings") : null}>
                    <Button
                      type="button"
                      size="sm"
                      onClick={handlePasteApply}
                      disabled={!pasteText.trim() || savingCookies || !canPersistCookies}
                    >
                      {savingCookies ? (
                        <Loader2 className="w-3.5 h-3.5 me-1.5 animate-spin" />
                      ) : (
                        <Check className="w-3.5 h-3.5 me-1.5" />
                      )}
                      {savingCookies ? t("workshopSync.saving") : t("workshopSync.extractAndSave")}
                    </Button>
                  </DisabledReason>
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
                    {t("workshopSync.cancel")}
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
                {t("workshopSync.howToGetRequestSummary")}
              </summary>
              <ol className="list-decimal list-inside mt-2 space-y-1 text-muted-foreground ps-1">
                <li>
                  {t("workshopSync.howToStep1")}
                </li>
                <li>
                  {t("workshopSync.howToStep2Prefix")}{" "}
                  <kbd className="px-1 py-0.5 rounded border bg-muted text-[10px]">
                    F12
                  </kbd>{" "}
                  <Trans t={t} i18nKey="workshopSync.howToStep2Suffix" components={{ b: <strong /> }} />
                </li>
                <li>{t("workshopSync.howToStep3")}</li>
                <li>
                  <Trans t={t} i18nKey="workshopSync.howToStep4" components={{ b: <strong />, em: <em /> }} />
                </li>
                <li>
                  <Trans t={t} i18nKey="workshopSync.howToStep5" components={{ b: <strong /> }} />
                </li>
              </ol>
              <p className="mt-2 text-muted-foreground">
                <Trans t={t} i18nKey="workshopSync.howToManualAlt" components={{ b: <strong />, code: <code className="mx-1" /> }} />
              </p>
            </details>

            <p className="text-[11px] text-warning/90 flex items-start gap-1 pt-1 border-t border-border/30">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              <span>
                {t("workshopSync.cookieWarning")}
              </span>
            </p>
          </div>
        </div>
        ) : (
          <div className="flex items-start gap-3 rounded-xl border border-border/70 bg-background/40 p-4 text-sm text-muted-foreground">
            <KeyRound className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
            <p>{t("workshopSync.cookiesNeedCollectionId")}</p>
          </div>
        )}

        {/* Status / actions */}
        <div className="space-y-2 pt-2 border-t border-border/40">
          <div className="flex flex-wrap items-center gap-2">
            <DisabledReason reason={!credsConfigured ? t("workshopSync.testConnectionTitleNeedsCookies") : null}>
              <Button
                variant="outline"
                size="sm"
                onClick={handleTest}
                disabled={!collectionIdValid || !credsConfigured || testing}
                // eslint-disable-next-line local/no-dead-disabled-title -- split 2026-08-27: the disabled-reason branch (needs cookies) now lives in the DisabledReason wrapper above; this title carries only the enabled-state hint.
                title={!credsConfigured ? undefined : t("workshopSync.testConnectionTitleReady")}
              >
                {testing ? (
                  <Loader2 className="w-3.5 h-3.5 me-1.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5 me-1.5" />
                )}
                {t("workshopSync.testConnection")}
              </Button>
            </DisabledReason>
            <Button
              variant="outline"
              size="sm"
              onClick={refreshDiff}
              disabled={!collectionIdValid || diffLoading}
            >
              {diffLoading ? (
                <Loader2 className="w-3.5 h-3.5 me-1.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5 me-1.5" />
              )}
              {t("workshopSync.checkDrift")}
            </Button>

            <div className="ms-auto text-xs text-muted-foreground">
              {diffError ? (
                <span className="text-destructive flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> {diffError}
                </span>
              ) : !collectionIdValid ? (
                <span>{t("workshopSync.enterCollectionId")}</span>
              ) : !diff ? (
                <span>
                  {diffLoading
                    ? t("workshopSync.readingCollection")
                    : t("workshopSync.clickCheckDrift")}
                </span>
              ) : !diff.ok ? (
                <span>{t("workshopSync.couldNotRead")}</span>
              ) : inSync ? (
                <span className="text-success flex items-center gap-1">
                  <Check className="w-3 h-3" /> {t("workshopSync.inSync", { count: diff.inCollection.length })}
                </span>
              ) : (
                <span className="text-warning flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  {t("workshopSync.toReview", { count: driftCount })}
                </span>
              )}
            </div>
          </div>
          {diffCheckedAt && (
            <p className="text-[11px] text-muted-foreground/70">
              {t("workshopSync.lastChecked", { time: formatTime(diffCheckedAt, { seconds: true }) })}
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
              <span>{t("workshopSync.trackedLocally", { count: diff?.trackedCount ?? 0 })}</span>
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
                    ["missing", t("workshopSync.filterMissing"), missingCount],
                    ["not-on-server", t("workshopSync.filterNotOnServer"), notOnServerCount],
                    ["tracked-only", t("workshopSync.filterTrackedOnly"), trackedOnlyCount],
                    ["synced", t("workshopSync.filterSynced"), syncedCount],
                    ["all", t("workshopSync.filterAll"), allItems.length],
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
              <div className="relative ms-auto">
                <Search className="absolute start-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  value={itemSearch}
                  onChange={(e) => setItemSearch(e.target.value)}
                  placeholder={t("workshopSync.searchPlaceholder")}
                  className="h-8 ps-7 pe-7 text-xs w-56"
                />
                {itemSearch && (
                  <button
                    type="button"
                    onClick={() => setItemSearch("")}
                    className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={t("workshopSync.clearSearch")}
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
                      ? t("workshopSync.noMatchesSearch")
                      : t("workshopSync.noMatchesFilter")}
                  </div>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted/80 backdrop-blur z-10">
                      <tr className="text-start text-muted-foreground border-b border-border/50">
                        <th className="font-medium px-3 py-2 sm:w-[120px]">
                          {t("workshopSync.columnStatus")}
                        </th>
                        <th className="font-medium px-3 py-2">{t("workshopSync.columnMod")}</th>
                        <th className="font-medium px-3 py-2 sm:w-[540px] text-end">
                          {t("workshopSync.columnActions")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredItems.map((it) => {
                        const busy = rowBusy[it.workshopId];
                        const statusMeta =
                          it.status === "synced"
                            ? {
                                label: t("workshopSync.statusSynced"),
                                cls: "text-success border-success/40 bg-success/10",
                                icon: <Check className="w-3 h-3" />,
                              }
                            : it.status === "to-add"
                              ? {
                                  label: t("workshopSync.statusMissing"),
                                  cls: "text-warning border-warning/40 bg-warning/10",
                                  icon: <Plus className="w-3 h-3" />,
                                }
                              : it.status === "collection-only"
                                ? {
                                    label: t("workshopSync.statusNotOnServer"),
                                    cls: "text-primary border-primary/40 bg-primary/10",
                                    icon: <Library className="w-3 h-3" />,
                                  }
                                : {
                                    label: t("workshopSync.statusTrackedOnly"),
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
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground/80 font-mono">
                                  <span>{it.workshopId}</span>
                                  <span className="hidden sm:inline">·</span>
                                  <span>
                                    {it.inTracked ? t("workshopSync.trackedTag") : t("workshopSync.notTrackedTag")}
                                  </span>
                                  <span className="hidden sm:inline">·</span>
                                  <span>
                                    {it.inCollection
                                      ? t("workshopSync.inCollectionTag")
                                      : t("workshopSync.notInCollectionTag")}
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
                                      setRemoveServerTarget({
                                        workshopId: it.workshopId,
                                      })
                                    }
                                    disabled={!!busy}
                                    // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, disables only transiently while an action is in flight (the spinner is the self-evident why). Triaged 2026-08-27.
                                    title={t("workshopSync.removeFromServerTitle")}
                                  >
                                    {busy === "remove-server" ? (
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                      <Server className="w-3 h-3" />
                                    )}
                                    <span className="ms-1 hidden sm:inline">{t("workshopSync.fromServer")}</span>
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
                                    // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, disables only transiently while an action is in flight (the spinner is the self-evident why). Triaged 2026-08-27.
                                    title={t("workshopSync.addToServerTitle")}
                                  >
                                    {busy === "add-server" ? (
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                      <Server className="w-3 h-3" />
                                    )}
                                    <span className="ms-1 hidden sm:inline">{t("workshopSync.toServer")}</span>
                                  </Button>
                                )}
                                {/* Collection side */}
                                {it.inCollection ? (
                                  <DisabledReason reason={tokenExpired ? t("workshopSync.sessionExpiredShort") : !credsConfigured ? t("workshopSync.removeFromCollectionNeedsCookies") : null}>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 px-2 text-[11px] text-destructive hover:text-destructive hover:bg-destructive/10"
                                      onClick={() =>
                                        runRowAction(it.workshopId, "remove")
                                      }
                                      disabled={!!busy || !credsConfigured || tokenExpired}
                                      // eslint-disable-next-line local/no-dead-disabled-title -- split 2026-08-27 (real bug: this ternary correctly selected "Steam session expired"/"Need Steam cookies" but a native title is never shown on a disabled element -- Chromium confirmed empirically). The disabled-reason now lives in the DisabledReason wrapper above; this title carries only the enabled-state hint.
                                      title={tokenExpired || !credsConfigured ? undefined : t("workshopSync.removeFromCollectionTitle")}
                                    >
                                      {busy === "remove" ? (
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                      ) : (
                                        <Minus className="w-3 h-3" />
                                      )}
                                      <span className="ms-1 hidden sm:inline">
                                        {t("workshopSync.fromCollection")}
                                      </span>
                                    </Button>
                                  </DisabledReason>
                                ) : (
                                  <DisabledReason reason={tokenExpired ? t("workshopSync.sessionExpiredShort") : !credsConfigured ? t("workshopSync.removeFromCollectionNeedsCookies") : null}>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 px-2 text-[11px] text-success hover:text-success hover:bg-success/10"
                                      onClick={() =>
                                        runRowAction(it.workshopId, "add")
                                      }
                                      disabled={!!busy || !credsConfigured || tokenExpired}
                                      // eslint-disable-next-line local/no-dead-disabled-title -- split 2026-08-27, same real bug and fix as the remove-from-collection button above.
                                      title={tokenExpired || !credsConfigured ? undefined : t("workshopSync.addToCollectionTitle")}
                                    >
                                      {busy === "add" ? (
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                      ) : (
                                        <Plus className="w-3 h-3" />
                                      )}
                                      <span className="ms-1 hidden sm:inline">{t("workshopSync.toCollection")}</span>
                                    </Button>
                                  </DisabledReason>
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
                                    // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, disables only transiently while an action is in flight (the spinner is the self-evident why). Triaged 2026-08-27.
                                    title={t("workshopSync.untrackTitle")}
                                  >
                                    {busy === "untrack" ? (
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                      <Bookmark className="w-3 h-3" />
                                    )}
                                    <span className="ms-1 hidden sm:inline">{t("workshopSync.untrack")}</span>
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
                                    // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, disables only transiently while an action is in flight (the spinner is the self-evident why). Triaged 2026-08-27.
                                    title={t("workshopSync.trackTitle")}
                                  >
                                    {busy === "track" ? (
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                      <BookmarkPlus className="w-3 h-3" />
                                    )}
                                    <span className="ms-1 hidden sm:inline">{t("workshopSync.track")}</span>
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
                                  // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, disables only transiently while an action is in flight (the spinner is the self-evident why). Triaged 2026-08-27.
                                  title={t("workshopSync.purgeTitle")}
                                >
                                  {busy === "purge" ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <Trash2 className="w-3 h-3" />
                                  )}
                                  <span className="ms-1 hidden sm:inline">{t("workshopSync.everywhere")}</span>
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
                  {t("workshopSync.shownCount", { shown: filteredItems.length, total: allItems.length })}
                </span>
                <span className="hidden sm:inline">
                  {t("workshopSync.perRowNote")}
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
                {t("workshopSync.purgeDialogTitle", { name: purgeTarget?.name || purgeTarget?.workshopId })}
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2">
                  <p>{t("workshopSync.purgeDialogIntro")}</p>
                  <ul className="list-disc ps-5 space-y-0.5">
                    <li>{t("workshopSync.purgePlace1")}</li>
                    <li>
                      <Trans t={t} i18nKey="workshopSync.purgePlace2" components={{ code: <code /> }} />
                    </li>
                    <li>{t("workshopSync.purgePlace3")}</li>
                    <li>{t("workshopSync.purgePlace4")}</li>
                  </ul>
                  <p>
                    {t("workshopSync.purgeDialogNote")}
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("workshopSync.cancelButton")}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => {
                  const target = purgeTarget;
                  setPurgeTarget(null);
                  if (target) runRowAction(target.workshopId, "purge", target.name);
                }}
              >
                {t("workshopSync.removeEverywhereButton")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog
          open={!!removeServerTarget}
          onOpenChange={(open) => !open && setRemoveServerTarget(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("workshopSync.removeServerDialogTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("workshopSync.removeServerDialogDesc")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("workshopSync.cancelButton")}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => {
                  const target = removeServerTarget;
                  setRemoveServerTarget(null);
                  if (target) runRowAction(target.workshopId, "remove-server");
                }}
              >
                {t("workshopSync.fromServer")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
    </SectionCard>
  );
}

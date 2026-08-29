import {
  lazy,
  Suspense,
  useState,
  useEffect,
  useContext,
  useRef,
  useMemo,
  useCallback,
} from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { getCurrentLanguage } from "@/i18n";
import {
  Bug,
  RefreshCw,
  Trash2,
  Download,
  Terminal,
  AlertCircle,
  Info,
  AlertTriangle,
  CheckCircle,
  Pause,
  Play,
  FolderOpen,
  Save,
  Loader2,
  Search,
  X,
  FileText,
  Activity,
  Clock,
  Copy,
  ChevronDown,
  ChevronRight,
  Wifi,
  WifiOff,
  Server,
  Database,
  Settings,
  Zap,
  TrendingUp,
  Map as MapIcon,
  Globe,
  ExternalLink,
  Users,
  Car,
  Home,
  Package,
  Volume2,
  PlayCircle,
  Archive,
  FileDown,
  ShieldAlert,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { reportClientError } from "@/lib/client-errors";
import { getUserErrorMessage } from "@/lib/errorMessage";
import { translateDiagnosticCheck } from "@/lib/diagnosticsTranslation";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/contexts/ConfirmContext";
import { useAuth } from "@/contexts/AuthContext";
import { SocketContext } from "@/contexts/SocketContext";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { DisabledReason } from "@/components/DisabledReason";
import { cn, copyText } from "@/lib/utils";
import {
  apiFetch,
  ApiError,
  modsApi,
  panelBridgeApi,
  serverApi,
  rconApi,
  backupApi,
  serverFilesApi,
} from "@/lib/api";

interface LogEntry {
  id: string;
  level: "info" | "warn" | "error" | "debug";
  message: string;
  timestamp: Date;
  source?: string;
}

interface SystemInfo {
  nodeVersion: string;
  platform: string;
  uptime: number;
  memoryUsage: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
  };
  dbPath: string;
  logsPath: string;
  dataDir: string;
  pathsConfigurable: boolean;
}

interface HealthStatus {
  status: "ok" | "error";
  timestamp: string;
  services: {
    rcon: { connected: boolean; host: string };
    server: { running: boolean };
    modChecker: { running: boolean; interval: number };
  };
  memory: {
    heapUsed: number;
    heapTotal: number;
    heapLimit?: number;
    rss: number;
    external: number;
  };
  uptime: number;
}

interface ActivityEntry {
  id: string;
  source: "rcon" | "bridge" | "player" | "server";
  action: string;
  args?: Record<string, unknown>;
  detail: string;
  success: boolean;
  duration_ms?: number;
  timestamp: string;
}

interface LogFile {
  name: string;
  size: number;
  modified: string;
}

interface PerformanceSnapshot {
  id: number;
  timestamp: string;
  memoryUsed: number;
  memoryTotal: number;
  cpuUsage: number;
  playerCount: number;
  serverRunning: boolean;
  // New host/PZ fields
  hostMemTotal?: number;
  hostMemUsed?: number;
  pzMemUsed?: number | null;
  panelMemHeap?: number;
  panelMemRss?: number;
  // Computed fields added by frontend
  memoryMB?: number;
  cpuLoad?: number;
  time?: string;
  hostMemGB?: number;
  hostMemUsedGB?: number;
  pzMemMB?: number | null;
}

interface CrashLog {
  name: string;
  path: string;
  size: number;
  modified: string;
}

interface DiagCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail" | "info" | "skip";
  severity: "critical" | "warning" | "info";
  message: string;
  hint?: string;
  category: string;
  meta?: Record<string, unknown>;
  params?: Record<string, string | number>;
  variant?: string;
}

interface DiagSummary {
  ok: number;
  warn: number;
  fail: number;
  info: number;
  skip: number;
}

interface DiagnosticsResult {
  timestamp: string;
  overall: "ok" | "warn" | "fail";
  summary: DiagSummary;
  categories: Record<string, { label: string; order: number }>;
  checks: DiagCheck[];
  durationMs: number;
}

interface TileProbe {
  url: string;
  reachable: boolean;
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
}

interface WorldMapDiagnostics {
  timestamp: string;
  overall: "ok" | "warn" | "fail";
  summary: DiagSummary;
  checks: DiagCheck[];
  durationMs: number;
  tileSources: { b42: TileProbe | null; b41: TileProbe | null };
  bridge: {
    configured: boolean;
    isRunning: boolean;
    modConnected: boolean;
    statusAgeMs: number | null;
    bridgePath: string | null;
    consecutiveFailures: number;
  } | null;
  handlers: string[];
  save: {
    zomboidDataPath: string | null;
    savesDir: string | null;
    activeSaveName: string | null;
    activeSavePath: string | null;
    saveCount: number;
    build: "b41" | "b42" | "unknown";
  };
  activeServer: { id: string; name: string; serverName: string } | null;
  proxy: { b42: string; b41: string };
}

type TimeFormat = "relative" | "time" | "datetime";

type DiagnosticsFixAction = {
  label: string;
  automated: boolean;
  manualRoute?: string;
  /** Present only when the user must confirm before this automated fix runs.
   *  destructive is required (not optional) inside this object on purpose:
   *  requiresConfirm/confirmMessage/destructive used to be three independent
   *  optional fields, so a fix could ask for confirmation without ever
   *  deciding destructive, and destructive:true with no requiresConfirm was
   *  silently inert (the only place destructive was read was gated behind
   *  requiresConfirm). Folding them into one object makes "confirms but
   *  never says whether it's destructive" a compile error instead of a trap
   *  for the next fix added to the switch below. */
  confirm?: {
    /** Confirmation text shown in the native confirm dialog. */
    message: string;
    /** Styles the confirm button red when true. Explicit per action rather than
     *  defaulting to red for every confirmed action -- a bounded, reversible
     *  INI toggle and an actual file deletion aren't the same severity, and
     *  rendering both the same color flattens that distinction for the operator. */
    destructive: boolean;
  };
  openServerConfig?: boolean;
  openMods?: boolean;
  /** Extra navigation buttons rendered next to the primary action. */
  links?: Array<{ to: string; label: string }>;
  note?: string;
};

// This whole file fetches with authFetch() (a raw fetch, not the JSON
// api.ts client that already parses `{ error, code }` bodies), so a
// non-ok response needs its own body read before the real server message
// -- "Log file not found", "No support logs found", "Invalid filename",
// etc. -- can reach a catch block instead of just an HTTP status number.
export async function parseDownloadError(res: Response, fallback: string): Promise<string> {
  try {
    const data: unknown = await res.json();
    if (data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string") {
      const message = (data as { error: string }).error;
      if (message) return message;
    }
  } catch {
    // Not a JSON body (e.g. an HTML error page from a proxy) -- fall through.
  }
  return fallback;
}

function getDiagMetaStringList(check: DiagCheck, key: string): string[] {
  const raw = check.meta?.[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is string =>
      typeof item === "string" && item.trim().length > 0,
  );
}

// MUST be called with the RAW check straight from the API response, never
// the output of translateDiagnosticCheck() -- `note` below falls back to
// the literal `check.hint` verbatim, which should stay the server's own
// English text, not a partially-translated mix. See translateDiagnosticCheck's
// own call site in this file: it deliberately keeps this function fed the
// untranslated `check`, only the three *displayed* text nodes use the
// translated copy.
export function getDiagnosticsFixAction(
  check: DiagCheck,
  t: TFunction,
): DiagnosticsFixAction | null {
  // Never show a fix button for passing or skipped checks.
  if (check.status === "ok" || check.status === "skip") return null;
  const L = (key: string) => t(`fixActions.links.${key}`);

  switch (check.id) {
    case "mods.numericInMods": {
      const count = getDiagMetaStringList(check, "numericInMods").length;
      return {
        label:
          count > 0
            ? t("fixActions.modsNumericInMods.labelWithCount", { count })
            : t("fixActions.modsNumericInMods.labelGeneric"),
        automated: true,
        confirm:
          count > 10
            ? {
                message: t("fixActions.modsNumericInMods.confirmMessage", { count }),
                // Disables INI entries, doesn't delete anything -- re-enabling is a
                // toggle, not a rebuild. Bounded/reversible, not red.
                destructive: false,
              }
            : undefined,
        openServerConfig: true,
        note:
          count > 0
            ? t("fixActions.modsNumericInMods.noteWithCount", { count })
            : t("fixActions.modsNumericInMods.noteGeneric"),
      };
    }
    case "mods.resolved": {
      // INTENTIONALLY manual: bulk-disabling unresolved Mods= entries is
      // destructive. The most common cause is "Workshop downloads still
      // pending" or "Mods= / WorkshopItems= drift" — not typos. Running
      // the orphanWorkshop fix first usually resolves many of these.
      const count = getDiagMetaStringList(check, "unresolvedMods").length;
      const reviewParams = new URLSearchParams({ tab: "ini", search: "Mods" });
      for (const modId of getDiagMetaStringList(check, "unresolvedMods")) {
        reviewParams.append("unresolved", modId);
      }
      return {
        label:
          count > 0
            ? t("fixActions.modsResolved.labelWithCount", { count })
            : t("fixActions.modsResolved.labelGeneric"),
        automated: false,
        manualRoute: `/server-config?${reviewParams.toString()}`,
        note: t("fixActions.modsResolved.note"),
      };
    }
    case "mods.orphanWorkshop": {
      const count = getDiagMetaStringList(check, "orphanWorkshop").length;
      return {
        label:
          count > 0
            ? t("fixActions.modsOrphanWorkshop.labelWithCount", { count })
            : t("fixActions.modsOrphanWorkshop.labelGeneric"),
        automated: true,
        confirm:
          count > 10
            ? {
                message: t("fixActions.modsOrphanWorkshop.confirmMessage", { count }),
                // Same class as numericInMods above -- an INI toggle, not a deletion.
                destructive: false,
              }
            : undefined,
        openServerConfig: true,
        openMods: true,
        note:
          count > 0
            ? t("fixActions.modsOrphanWorkshop.noteWithCount", { count })
            : t("fixActions.modsOrphanWorkshop.noteGeneric"),
      };
    }
    case "mods.maps":
      return {
        label: t("fixActions.modsMaps.label"),
        automated: true,
        openServerConfig: true,
        note: t("fixActions.modsMaps.note"),
      };
    case "mods.duplicates": {
      const dupCount =
        getDiagMetaStringList(check, "dupMods").length +
        getDiagMetaStringList(check, "dupWs").length;
      return {
        label:
          dupCount > 0
            ? t("fixActions.modsDuplicates.labelWithCount", { count: dupCount })
            : t("fixActions.modsDuplicates.labelGeneric"),
        automated: true,
        openServerConfig: true,
        note: t("fixActions.modsDuplicates.note"),
      };
    }
    case "mods.workshopCrash":
      return {
        label: t("fixActions.modsWorkshopCrash.label"),
        automated: false,
        openMods: true,
        note: t("fixActions.modsWorkshopCrash.note"),
      };

    // ─── Server / process ──────────────────────────────────────────────────
    case "server.process":
      return {
        label: t("fixActions.serverProcess.label"),
        automated: true,
        links: [{ to: "/", label: L("openDashboard") }],
        note: t("fixActions.serverProcess.note"),
      };
    case "server.active":
    case "server.installPath":
      return {
        label: t("fixActions.serverActiveOrInstallPath.label"),
        automated: false,
        links: [
          { to: "/servers", label: L("openServers") },
          { to: "/server-finder", label: L("autoDetect") },
        ],
        note: t("fixActions.serverActiveOrInstallPath.note"),
      };
    case "server.zomboidData":
      return {
        label: t("fixActions.serverZomboidData.label"),
        automated: false,
        links: [{ to: "/settings", label: L("openSettings") }],
        note: t("fixActions.serverZomboidData.note"),
      };
    case "server.startScript":
    case "server.jre":
    case "server.jreWorks":
      return {
        label: t("fixActions.serverStartScriptOrJre.label"),
        automated: false,
        links: [{ to: "/server-finder", label: L("openServerFinder") }],
        note: t("fixActions.serverStartScriptOrJre.note"),
      };
    case "server.ini":
    case "server.sandboxVars":
      return {
        label: t("fixActions.serverIniOrSandboxVars.label"),
        automated: false,
        openServerConfig: true,
        note: t("fixActions.serverIniOrSandboxVars.note"),
      };
    case "server.sandboxCorrupt":
      return {
        label: t("fixActions.serverSandboxCorrupt.label"),
        automated: true,
        note: t("fixActions.serverSandboxCorrupt.note"),
      };
    case "server.rconPassword":
      return {
        label: t("fixActions.serverRconPassword.label"),
        automated: false,
        openServerConfig: true,
        links: [{ to: "/settings", label: L("openSettings") }],
        note: t("fixActions.serverRconPassword.note"),
      };
    case "server.bridgeMod":
      return {
        label: t("fixActions.serverBridgeMod.label"),
        automated: false,
        links: [{ to: "/server-finder", label: L("openServerFinder") }],
        note: t("fixActions.serverBridgeMod.note"),
      };
    case "server.configDrift":
      return {
        label: t("fixActions.serverConfigDrift.label"),
        automated: false,
        openServerConfig: true,
        note: t("fixActions.serverConfigDrift.note"),
      };
    case "server.staleLocks":
      return {
        label: t("fixActions.serverStaleLocks.label"),
        automated: true,
        confirm: {
          message: t("fixActions.serverStaleLocks.confirmMessage"),
          // Actually deletes files in the save-adjacent lock directory, unlike
          // the two INI-toggle fixes above -- stays red deliberately.
          destructive: true,
        },
        links: [{ to: "/chunks", label: L("openChunkCleaner") }],
        note: t("fixActions.serverStaleLocks.note"),
      };
    case "server.recentCrash":
      return {
        label: t("fixActions.serverRecentCrash.label"),
        automated: true,
        note: t("fixActions.serverRecentCrash.note"),
      };

    // ─── Services ──────────────────────────────────────────────────────────
    case "rcon.connected":
      return {
        label: t("fixActions.rconConnected.label"),
        automated: true,
        openServerConfig: true,
        links: [{ to: "/settings", label: L("openSettings") }],
        note: t("fixActions.rconConnected.note"),
      };
    case "modChecker":
    case "scheduler":
    case "services.error":
      return {
        label: t("fixActions.servicesStuck.label"),
        automated: false,
        links: [{ to: "/settings", label: L("openSettings") }],
        note: t("fixActions.servicesStuck.note"),
      };
    case "discord.bot":
      return {
        label: t("fixActions.discordBot.label"),
        automated: false,
        links: [{ to: "/discord", label: L("openDiscord") }],
        note: t("fixActions.discordBot.note"),
      };

    // ─── Bridge ────────────────────────────────────────────────────────────
    case "bridge.configured":
    case "worldmap.bridge.configured":
      return {
        label: t("fixActions.bridgeConfigured.label"),
        automated: true,
        links: [{ to: "/settings?tab=bridge", label: L("openBridgeSettings") }],
        note: t("fixActions.bridgeConfigured.note"),
      };
    case "bridge.writable":
    case "bridge.heartbeat":
      return {
        label: t("fixActions.bridgeWritableOrHeartbeat.label"),
        automated: false,
        links: [{ to: "/server-finder", label: L("openServerFinder") }],
        note: t("fixActions.bridgeWritableOrHeartbeat.note"),
      };

    // ─── Database / storage ────────────────────────────────────────────────
    case "db.exists":
    case "db.writable":
      return {
        label: t("fixActions.dbExistsOrWritable.label"),
        automated: false,
        links: [{ to: "/settings", label: L("openSettings") }],
        note: t("fixActions.dbExistsOrWritable.note"),
      };
    case "db.backup":
      return {
        label: t("fixActions.dbBackup.label"),
        automated: true,
        links: [{ to: "/backups", label: L("openBackups") }],
        note: t("fixActions.dbBackup.note"),
      };
    case "logs.writable":
      return {
        label: t("fixActions.logsWritable.label"),
        automated: false,
        links: [{ to: "/settings", label: L("openSettings") }],
        note: t("fixActions.logsWritable.note"),
      };
    case "disk.free":
      return {
        label: t("fixActions.diskFree.label"),
        automated: false,
        links: [
          { to: "/backups", label: L("openBackups") },
          { to: "/chunks", label: L("openChunkCleaner") },
        ],
        note: t("fixActions.diskFree.note"),
      };
    case "storage.saveSize":
      return {
        label: t("fixActions.storageSaveSize.label"),
        automated: false,
        links: [{ to: "/chunks", label: L("openChunkCleaner") }],
        note: t("fixActions.storageSaveSize.note"),
      };

    // ─── Runtime ───────────────────────────────────────────────────────────
    case "runtime.heap":
    case "runtime.hostMem":
      return {
        label: t("fixActions.runtimeHeapOrHostMem.label"),
        automated: false,
        links: [{ to: "/settings", label: L("openSettings") }],
        note: t("fixActions.runtimeHeapOrHostMem.note"),
      };
    case "runtime.timeSkew":
      return {
        label: t("fixActions.runtimeTimeSkew.label"),
        automated: false,
        note: t("fixActions.runtimeTimeSkew.note"),
      };

    // ─── Updates ───────────────────────────────────────────────────────────
    case "update.panel":
    case "updates.error":
      return {
        label: t("fixActions.updatePanelOrError.label"),
        automated: false,
        links: [{ to: "/settings", label: L("openSettings") }],
        note: t("fixActions.updatePanelOrError.note"),
      };
    case "update.mods":
      return {
        label: t("fixActions.updateMods.label"),
        automated: false,
        openMods: true,
        note: t("fixActions.updateMods.note"),
      };
    case "update.steamApi":
      return {
        label: t("fixActions.updateSteamApi.label"),
        automated: false,
        note: t("fixActions.updateSteamApi.note"),
      };

    default: {
      // Fallback: only surface a button for warn/fail. Informational checks
      // (e.g. "panel uptime") have no actionable fix — don't show a button.
      if (check.status === "info") return null;
      const hint = (check.hint || "").toLowerCase();
      const category = check.category;
      const links: Array<{ to: string; label: string }> = [];
      if (
        category === "worldmap" &&
        !links.some((l) => l.to === "/world-map")
      ) {
        links.push({ to: "/world-map", label: L("openWorldMap") });
      }
      return {
        label: t("fixActions.fallback.label"),
        automated: false,
        // Only match literal tokens here, never English prose. SERVER.INI
        // and Mods= are on the do-not-translate list in every locale
        // glossary, so they still appear verbatim (just lowercased) inside
        // a translated hint -- safe to match regardless of UI language.
        // A prose phrase like "server config" is not: it used to also be
        // matched here, and every check whose English hint contains that
        // phrase already has an explicit case above that sets
        // openServerConfig directly, so removing it changes nothing today
        // -- but it would have silently dropped the Open Server Config
        // button for non-English users the day someone added a new
        // fallback-covered check with that phrase in its hint. Don't
        // re-add a prose match here; add an explicit switch case instead.
        openServerConfig: hint.includes("server.ini"),
        openMods: category === "mods" || hint.includes("mods="),
        links: links.length > 0 ? links : undefined,
        note: check.hint || t("fixActions.fallback.noteFallback"),
      };
    }
  }
}

// Each automated fix POSTs to its own route, and those routes are gated by
// SEVEN DIFFERENT capabilities, not one page-level concern -- read directly
// from server/routes/*.js rather than assumed from the page's own admin-only
// read endpoints:
//   mods.numericInMods / mods.orphanWorkshop / mods.maps / mods.duplicates
//     -> mods.manage (mods.js's router.use, whole router)
//   server.process -> server.control (server.js POST /start)
//   rcon.connected -> rcon.execute (rcon.js POST /connect)
//   db.backup -> backups.manage (backup.js POST /create)
//   server.staleLocks -> diagnostics.manage (debug.js POST /clear-stale-locks)
//   bridge.configured / worldmap.bridge.configured -> bridge.setup
//     (panelBridge.js POST /auto-configure)
//   server.sandboxCorrupt -> serverfiles.manage (serverFiles.js's router.use)
// server.recentCrash makes no API call at all (it only switches tabs), so it
// needs no capability. Every other check.id is either non-automated (manual
// fix: a toast or a navigation, never an API call) or falls to the `default`
// case in getDiagnosticsFixAction, which is also never automated -- neither
// needs a capability either.
export function getRequiredCapabilityForCheck(checkId: string): string | null {
  switch (checkId) {
    case "mods.numericInMods":
    case "mods.orphanWorkshop":
    case "mods.maps":
    case "mods.duplicates":
      return "mods.manage";
    case "server.process":
      return "server.control";
    case "rcon.connected":
      return "rcon.execute";
    case "db.backup":
      return "backups.manage";
    case "server.staleLocks":
      return "diagnostics.manage";
    case "bridge.configured":
    case "worldmap.bridge.configured":
      return "bridge.setup";
    case "server.sandboxCorrupt":
      return "serverfiles.manage";
    default:
      return null;
  }
}

const DebugPerformanceCharts = lazy(
  () => import("@/components/DebugPerformanceCharts"),
);

export default function Debug() {
  const { t, i18n } = useTranslation("debug");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [healthStatus, setHealthStatus] = useState<HealthStatus | null>(null);
  const [logFiles, setLogFiles] = useState<LogFile[]>([]);
  const [downloadingLogArchive, setDownloadingLogArchive] = useState(false);
  const [performanceHistory, setPerformanceHistory] = useState<
    PerformanceSnapshot[]
  >([]);
  const [perfRange, setPerfRange] = useState<"1h" | "6h" | "24h">("1h");
  const [refreshingPerformance, setRefreshingPerformance] = useState(false);
  const [crashLogs, setCrashLogs] = useState<CrashLog[]>([]);
  // The route caps the returned list at 20; totalCount is the real count
  // before that cap, so the badges below can say "showing 20 of 47" instead
  // of just "20" once there are more crash dumps than the cap.
  const [crashLogsTotalCount, setCrashLogsTotalCount] = useState(0);
  const [selectedCrashLog, setSelectedCrashLog] = useState<string | null>(null);
  const [crashLogContent, setCrashLogContent] = useState<string>("");
  const [loadingCrashLog, setLoadingCrashLog] = useState(false);
  const [refreshingLogs, setRefreshingLogs] = useState(false);
  const [refreshingCrashLogs, setRefreshingCrashLogs] = useState(false);
  const [refreshingHealth, setRefreshingHealth] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [activityEntries, setActivityEntries] = useState<ActivityEntry[]>([]);
  const [activitySource, setActivitySource] = useState<string>("all");
  const [activitySearch, setActivitySearch] = useState("");
  const [activityResultFilter, setActivityResultFilter] = useState<
    "all" | "success" | "failed"
  >("all");
  const [refreshingActivity, setRefreshingActivity] = useState(false);
  const [activityPaused, setActivityPaused] = useState(false);
  const [activityLastLoaded, setActivityLastLoaded] = useState<Date | null>(
    null,
  );
  const [expandedActivity, setExpandedActivity] = useState<Set<string>>(
    new Set(),
  );
  const [autoScroll, setAutoScroll] = useState(true);
  const [paused, setPaused] = useState(false);
  const [levelFilter, setLevelFilter] = useState<
    "all" | "info" | "warn" | "error" | "debug"
  >("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [timeFormat, setTimeFormat] = useState<TimeFormat>("time");
  const [activeTab, setActiveTab] = useState("diagnostics");
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResult | null>(
    null,
  );
  const [refreshingDiagnostics, setRefreshingDiagnostics] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  // Every read endpoint this page hits requires diagnostics.manage (server/
  // routes/debug.js's file-level comment says so explicitly) -- so a role
  // that lacks it doesn't get a partially-broken page, it gets a wall of
  // 403s across every tab. Answer that with one clean page-level state
  // instead of per-tab error banners, same precedent as Users.tsx/
  // RolesPermissions.tsx/OidcSettings.tsx (a real 403 from the mount-time
  // fetch, not a client-side can() guess).
  const [diagnosticsPermissionDenied, setDiagnosticsPermissionDenied] =
    useState(false);
  const [diagnosticsHideOk, setDiagnosticsHideOk] = useState(false);
  const [fixingDiagnosticsCheckId, setFixingDiagnosticsCheckId] = useState<
    string | null
  >(null);
  // Auto-fix failures otherwise only ever surfaced via a toast, which
  // auto-dismisses and leaves the failing check row with no indication
  // anything was attempted -- a user who steps away or switches tabs
  // mid-attempt has no way to tell the fix ran and failed vs. was never
  // tried. Persisted per check.id, same pattern as healthError/worldMapError.
  const [diagnosticsFixErrors, setDiagnosticsFixErrors] = useState<
    Record<string, string>
  >({});
  const [worldMapDiag, setWorldMapDiag] = useState<WorldMapDiagnostics | null>(
    null,
  );
  const [refreshingWorldMap, setRefreshingWorldMap] = useState(false);
  const [worldMapTilePreviewKey, setWorldMapTilePreviewKey] = useState(0);
  const [worldMapHideOk, setWorldMapHideOk] = useState(false);
  const [worldMapTileErrors, setWorldMapTileErrors] = useState<{
    b42: boolean;
    b41: boolean;
  }>({ b42: false, b41: false });
  const [worldMapTileMeta, setWorldMapTileMeta] = useState<{
    b42: { w: number; h: number } | null;
    b41: { w: number; h: number } | null;
  }>({ b42: null, b41: null });
  const [worldMapError, setWorldMapError] = useState<string | null>(null);
  const [worldMapNowTick, setWorldMapNowTick] = useState(() => Date.now());
  // Live probe + test-action state for the World Map tab.
  type ProbeResult = {
    ok: boolean;
    count: number | null;
    latencyMs: number;
    error?: string;
    sample?: unknown;
    at: number;
  };
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult>>(
    {},
  );
  const [probeLoading, setProbeLoading] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [airdropPreset, setAirdropPreset] = useState<
    "food" | "medical" | "military" | "building" | "weapons" | "tools"
  >("food");
  const [armedAction, setArmedAction] = useState<string | null>(null);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Generation counters so a slower response to an earlier filter selection
  // (activitySource / perfRange) can't land after a newer one and overwrite
  // it with stale data -- both are dropdowns a user can click through
  // quickly, and both fetches are also re-triggered by a poll interval.
  const activityFetchIdRef = useRef(0);
  const perfFetchIdRef = useRef(0);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const logsScrollAreaRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const confirm = useConfirm();
  const socket = useContext(SocketContext);
  const { can } = useAuth();

  const authFetch = useCallback((url: string, options: RequestInit = {}) => {
    const endpoint = url.startsWith("/api") ? url.slice(4) : url;
    return apiFetch(endpoint, options);
  }, []);

  // Path editing state
  const [editingPaths, setEditingPaths] = useState(false);
  const [newDataDir, setNewDataDir] = useState("");
  const [newLogsDir, setNewLogsDir] = useState("");
  const [moveFiles, setMoveFiles] = useState(true);
  const [savingPaths, setSavingPaths] = useState(false);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+F or Cmd+F to focus search
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      // Escape to clear search
      if (e.key === "Escape" && searchQuery) {
        setSearchQuery("");
        searchInputRef.current?.blur();
      }
      // Space to toggle pause (when not in input)
      if (e.key === " " && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        setPaused((p) => !p);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [searchQuery]);

  // Auto-scroll to bottom — scoped to the inner ScrollArea viewport so it
  // does NOT scroll the outer page (scrollIntoView walks ancestors and would
  // yank the whole window down on every new log line).
  useEffect(() => {
    if (!autoScroll || paused) return;
    const root = logsScrollAreaRef.current;
    if (!root) return;
    const viewport = root.querySelector<HTMLElement>(
      "[data-radix-scroll-area-viewport]",
    );
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [logs, autoScroll, paused]);

  // Fetch system info
  const fetchSystemInfo = async () => {
    try {
      const res = await authFetch("/api/debug/system");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data?.memoryUsage) {
        setSystemInfo(data);
      } else {
        setSystemInfo(null);
      }
    } catch (error) {
      reportClientError("Failed to fetch system info.", error);
    }
  };

  // Fetch health status
  const fetchHealthStatus = async () => {
    setRefreshingHealth(true);
    try {
      const res = await authFetch("/api/debug/health");
      if (!res.ok) throw new Error(await parseDownloadError(res, `HTTP ${res.status}`));
      const data = await res.json();
      if (data?.services) {
        setHealthStatus(data);
        setHealthError(null);
      } else {
        setHealthError(t("worldMapTab.unexpectedResponse"));
      }
    } catch (error) {
      const msg = getUserErrorMessage(error, t("worldMapTab.networkError"));
      setHealthError(msg);
      reportClientError("Failed to fetch health status.", error);
    } finally {
      setRefreshingHealth(false);
    }
  };

  // Fetch smart diagnostics
  const fetchDiagnostics = useCallback(async () => {
    setRefreshingDiagnostics(true);
    try {
      const res = await authFetch("/api/debug/diagnostics");
      if (res.status === 403) {
        setDiagnosticsPermissionDenied(true);
        return;
      }
      if (!res.ok) throw new Error(await parseDownloadError(res, `HTTP ${res.status}`));
      setDiagnosticsPermissionDenied(false);
      const data = await res.json();
      if (data?.checks) {
        setDiagnostics(data);
        setDiagnosticsError(null);
        // Drop persisted fix-errors for checks that no longer fail/warn --
        // the underlying issue resolved (via this fix or another path), so
        // the stale error banner shouldn't keep showing.
        const stillBad = new Set(
          (data.checks as DiagCheck[])
            .filter((c) => c.status === "fail" || c.status === "warn")
            .map((c) => c.id),
        );
        setDiagnosticsFixErrors((prev) => {
          const next: Record<string, string> = {};
          for (const [id, msg] of Object.entries(prev)) {
            if (stillBad.has(id)) next[id] = msg;
          }
          return next;
        });
      } else {
        setDiagnosticsError(t("worldMapTab.unexpectedResponse"));
      }
    } catch (error) {
      const msg = getUserErrorMessage(error, t("worldMapTab.networkError"));
      setDiagnosticsError(msg);
      reportClientError("Failed to fetch diagnostics.", error);
    } finally {
      setRefreshingDiagnostics(false);
    }
  }, [authFetch, t]);

  const handleDiagnosticsFix = useCallback(
    async (check: DiagCheck) => {
      const action = getDiagnosticsFixAction(check, t);
      if (!action) return;

      // The button's own disabled state (below, in the render) is an
      // affordance -- this is the actual gate, same two-layer pattern as
      // every other capability check tonight. Manual fixes (a toast or a
      // navigation) call no API and need no capability; only look this up
      // for the automated ones that actually reach a gated route.
      if (action.automated) {
        const requiredCapability = getRequiredCapabilityForCheck(check.id);
        if (requiredCapability && !can(requiredCapability)) return;
      }

      setFixingDiagnosticsCheckId(check.id);
      setDiagnosticsFixErrors((prev) => {
        if (!(check.id in prev)) return prev;
        const next = { ...prev };
        delete next[check.id];
        return next;
      });
      try {
        if (!action.automated) {
          if (check.id === "mods.resolved") {
            window.location.assign("/mods?review=unresolved");
            return;
          }
          toast({
            title: t("diagnostics.manualFixTitle"),
            description:
              action.note ||
              check.hint ||
              t("diagnostics.manualFixFallback"),
          });
          return;
        }

        if (action.confirm) {
          const message =
            action.confirm.message ||
            t("diagnostics.applyFixFallback", { label: action.label });
          const ok = await confirm({
            title: t("diagnostics.applyFixTitle"),
            description: message,
            confirmLabel: t("diagnostics.applyButton"),
            // No `!== false` fallback needed any more -- destructive is a
            // required field inside confirm, so this is always a real,
            // deliberately-set boolean, never an absent one defaulting to true.
            destructive: action.confirm.destructive,
          });
          if (!ok) {
            return;
          }
        }

        const restartHint = t("common.restartHint");

        if (check.id === "mods.numericInMods") {
          const numericIds = getDiagMetaStringList(check, "numericInMods");
          if (numericIds.length === 0) {
            throw new Error(t("diagnostics.noNumericIdsError"));
          }
          const result = await modsApi.batchToggleModIds(
            numericIds.map((modId) => ({ modId, enabled: false })),
          );
          toast({
            title: t("diagnostics.numericIdsRemovedTitle"),
            description: t("diagnostics.numericIdsRemovedDesc", {
              count: result.changed,
              restartHint,
            }),
          });
        } else if (check.id === "mods.orphanWorkshop") {
          const orphanWorkshop = getDiagMetaStringList(check, "orphanWorkshop");
          if (orphanWorkshop.length === 0) {
            throw new Error(t("diagnostics.noOrphanWorkshopError"));
          }

          const result = await modsApi.resolveOrphanWorkshop(orphanWorkshop);
          const { counts, modIdsAdded, wsDropped } = result;
          const droppedTotal =
            counts.droppedIgnored +
            counts.droppedMissing +
            counts.droppedNoModInfo;
          const parts: string[] = [];
          if (counts.enabled > 0)
            parts.push(
              t("diagnostics.workshopEnabled", {
                enabled: counts.enabled,
                count: modIdsAdded,
              }),
            );
          if (droppedTotal > 0) {
            const sub: string[] = [];
            if (counts.droppedIgnored)
              sub.push(
                t("diagnostics.workshopDroppedIgnored", {
                  count: counts.droppedIgnored,
                }),
              );
            if (counts.droppedMissing)
              sub.push(
                t("diagnostics.workshopDroppedMissing", {
                  count: counts.droppedMissing,
                }),
              );
            if (counts.droppedNoModInfo)
              sub.push(
                t("diagnostics.workshopDroppedNoInfo", {
                  count: counts.droppedNoModInfo,
                }),
              );
            parts.push(
              t("diagnostics.workshopDropped", {
                count: droppedTotal,
                sub: sub.join(", "),
              }),
            );
          }
          // Clause separator/terminator is a language property, not something
          // every locale's untranslated fragment can be assumed to want a
          // Latin "; "/"." for -- zh-CN's own fragments carry no punctuation
          // and expect full-width equivalents instead.
          const isZh = i18n.language === "zh-CN";
          const clauseSep = isZh ? "；" : "; ";
          const clauseEnd = isZh ? "。" : ".";
          toast({
            title: t("diagnostics.workshopResolvedTitle"),
            description:
              parts.length > 0
                ? `${parts.join(clauseSep)}${clauseEnd}${counts.enabled > 0 ? restartHint : ""}`
                : t("diagnostics.workshopNothingToChange", {
                    count: result.total,
                  }),
          });
          void wsDropped; // count already reflected in droppedTotal
        } else if (check.id === "mods.maps") {
          const result = await modsApi.repairMapEntries();
          toast({
            title: t("diagnostics.mapEntriesRepairedTitle"),
            description: `${result.message}${restartHint}`,
          });
        } else if (check.id === "mods.duplicates") {
          const result = await modsApi.deduplicateModIds();
          toast({
            title: t("diagnostics.duplicatesCleanedTitle"),
            description: `${result.message}${restartHint}`,
          });
        } else if (check.id === "server.process") {
          // /server/start always responds non-2xx on failure, so
          // handleResponse() throws into this handler's surrounding catch
          // -- this never sees result.success === false.
          const result = (await serverApi.start()) as {
            success?: boolean;
            message?: string;
            error?: string;
          };
          toast({
            title: t("diagnostics.serverStartingTitle"),
            description:
              result?.message || t("diagnostics.serverStartingFallback"),
          });
        } else if (check.id === "rcon.connected") {
          // /rcon/connect always responds non-2xx on failure, so
          // handleResponse() throws into this handler's surrounding catch
          // -- the connected check below is always true when reached.
          const result = (await rconApi.connect()) as {
            success?: boolean;
            connected?: boolean;
            message?: string;
            error?: string;
          };
          toast({
            title: t("diagnostics.rconReconnectedTitle"),
            description:
              result?.message || t("diagnostics.rconReconnectedFallback"),
          });
        } else if (check.id === "db.backup") {
          // /backup/create always responds non-2xx on failure, so
          // handleResponse() throws into this handler's surrounding catch
          // -- this never sees result.success === false.
          const result = await backupApi.createBackup({ includeDb: true });
          const backupName = result?.backup?.name
            ? ` (${result.backup.name})`
            : "";
          toast({
            title: t("diagnostics.dbBackupCreatedTitle"),
            description: t("diagnostics.dbBackupCreatedDesc", { backupName }),
          });
        } else if (check.id === "server.staleLocks") {
          const res = await authFetch("/api/debug/clear-stale-locks", {
            method: "POST",
          });
          const data = (await res.json().catch(() => null)) as {
            success?: boolean;
            deleted?: number;
            failed?: number;
            message?: string;
            error?: string;
            code?: string;
          } | null;
          if (!res.ok || data?.success === false) {
            // 2026-08-26: authFetch/apiFetch bypasses lib/api.ts's
            // handleResponse(), so this throw is the only place that ever
            // sees this response -- a plain Error here would discard
            // res.status and any code the server sent before the
            // getUserErrorMessage() call in this function's own catch
            // block (below) could ever use them.
            throw new ApiError(
              data?.error || data?.message || `HTTP ${res.status}`,
              { status: res.status, code: data?.code },
            );
          }
          toast({
            title: t("diagnostics.staleLocksRemovedTitle"),
            description:
              data?.message ||
              t("diagnostics.staleLocksRemovedFallback", {
                count: data?.deleted ?? 0,
              }),
          });
        } else if (
          check.id === "bridge.configured" ||
          check.id === "worldmap.bridge.configured"
        ) {
          // /panel-bridge/auto-configure always responds non-2xx on
          // failure, so handleResponse() throws into this function's
          // surrounding catch -- this never sees result.success === false.
          const result = await panelBridgeApi.autoConfigure();
          toast({
            title: t("diagnostics.bridgeConfiguredTitle"),
            description: t("diagnostics.bridgeConfiguredDesc", {
              serverName:
                result.serverName ||
                t("diagnostics.bridgeConfiguredServerFallback"),
            }),
          });
        } else if (check.id === "server.recentCrash") {
          setActiveTab("crashes");
          toast({
            title: t("diagnostics.crashLogsOpenedTitle"),
            description: t("diagnostics.crashLogsOpenedDesc"),
          });
        } else if (check.id === "server.sandboxCorrupt") {
          // /server-files/sandbox/repair always responds non-2xx on
          // failure (404/422/500), so handleResponse() throws into this
          // function's surrounding catch -- this never sees
          // result.success === false.
          const result = await serverFilesApi.repairSandbox();
          if (result.alreadyValid) {
            toast({
              title: t("diagnostics.alreadyValidTitle"),
              description:
                result.message || t("diagnostics.alreadyValidFallback"),
            });
          } else {
            // SandboxVars.lua has no live-reload path (PZ's own /reloadoptions
            // only re-reads ServerOptions.ini, never sandbox vars — see
            // handleSaveSandbox's comment in ServerConfig.tsx), so a repair
            // always needs a restart to reach the running game regardless of
            // whether the server happened to be running when it was repaired.
            toast({
              title: t("diagnostics.sandboxRepairedTitle"),
              description:
                (result.message
                  ? `${result.message}${restartHint}`
                  : t("diagnostics.sandboxRepairedFallback", {
                      count: result.changes?.length ?? 0,
                      restartHint,
                    })),
            });
          }
        }

        await fetchDiagnostics();
      } catch (error) {
        reportClientError("Diagnostics auto-fix failed.", error);
        const message = getUserErrorMessage(error, t("diagnostics.fixFailedFallback"));
        toast({
          title: t("diagnostics.fixFailedTitle"),
          description: message,
          variant: "destructive",
        });
        setDiagnosticsFixErrors((prev) => ({ ...prev, [check.id]: message }));
      } finally {
        setFixingDiagnosticsCheckId(null);
      }
    },
    [fetchDiagnostics, toast, authFetch, confirm, t, i18n.language, can],
  );

  // Fetch world-map specific diagnostics
  const fetchWorldMapDiag = useCallback(async () => {
    setRefreshingWorldMap(true);
    setWorldMapTileErrors({ b42: false, b41: false });
    setWorldMapTileMeta({ b42: null, b41: null });
    setWorldMapTilePreviewKey((k) => k + 1);
    setWorldMapError(null);
    try {
      const res = await authFetch("/api/debug/worldmap");
      if (!res.ok) throw new Error(await parseDownloadError(res, `HTTP ${res.status}`));
      const data = await res.json();
      if (data?.checks) {
        setWorldMapDiag(data);
      } else {
        setWorldMapError(t("worldMapTab.unexpectedResponse"));
      }
    } catch (error) {
      const msg = getUserErrorMessage(error, t("worldMapTab.networkError"));
      setWorldMapError(msg);
      reportClientError("Failed to fetch World Map diagnostics.", error);
    } finally {
      setRefreshingWorldMap(false);
    }
  }, [authFetch, t]);

  // Live probes — call PanelBridge endpoints the World Map relies on and
  // record latency/count/sample for the diagnostics UI.
  const runProbe = useCallback(
    async (
      id: string,
      fn: () => Promise<unknown>,
      extract: (r: unknown) => { count: number | null; sample?: unknown },
    ) => {
      setProbeLoading(id);
      const t0 = Date.now();
      try {
        const r = await fn();
        // Treat explicit success:false as a probe failure so the user sees
        // the underlying error message rather than a misleading green badge.
        // 2026-08-26: unreachable for every current probe (panelBridgeApi
        // .getServerInfo/.sendCommand, all resolved through apiGet/apiPost)
        // -- lib/api.ts's handleResponse() already throws on a 200 body with
        // success: false before this .then() branch could ever see it. Kept
        // and commented, not deleted: a future probe that bypasses apiPost
        // would hit a bare Error with no status/code instead of the caught,
        // fully-translatable ApiError the live path already produces, so
        // this check firing would be a regression signal, not a working
        // safety net.
        const res = r as {
          success?: boolean;
          error?: string;
          message?: string;
        };
        if (res && res.success === false) {
          const msg =
            res.error || res.message || "Bridge returned success=false";
          setProbeResults((prev) => ({
            ...prev,
            [id]: {
              ok: false,
              count: null,
              latencyMs: Date.now() - t0,
              error: msg,
              at: Date.now(),
            },
          }));
          return;
        }
        const { count, sample } = extract(r);
        setProbeResults((prev) => ({
          ...prev,
          [id]: {
            ok: true,
            count,
            latencyMs: Date.now() - t0,
            sample,
            at: Date.now(),
          },
        }));
      } catch (error) {
        const msg = getUserErrorMessage(error, t("worldMapTab.requestFailed"));
        setProbeResults((prev) => ({
          ...prev,
          [id]: {
            ok: false,
            count: null,
            latencyMs: Date.now() - t0,
            error: msg,
            at: Date.now(),
          },
        }));
      } finally {
        setProbeLoading(null);
      }
    },
    [t],
  );

  const probePlayers = useCallback(
    () =>
      runProbe(
        "players",
        () => panelBridgeApi.getServerInfo(),
        (r: unknown) => {
          const res = r as { success?: boolean; data?: { players?: unknown } };
          const raw = res?.data?.players;
          const list = Array.isArray(raw)
            ? raw
            : raw && typeof raw === "object"
              ? Object.values(raw as Record<string, unknown>)
              : [];
          return {
            count: list.length,
            sample: list.slice(0, 8).map((p: unknown) => {
              const pp = p as {
                name?: string;
                username?: string;
                x?: number;
                y?: number;
                isAlive?: boolean;
                accessLevel?: string;
              };
              return {
                name: pp.name || pp.username,
                x: pp.x,
                y: pp.y,
                alive: pp.isAlive !== false,
                access: pp.accessLevel,
              };
            }),
          };
        },
      ),
    [runProbe],
  );

  const probeVehicles = useCallback(
    () =>
      runProbe(
        "vehicles",
        () => panelBridgeApi.sendCommand("getVehiclesDetailed"),
        (r: unknown) => {
          const res = r as { success?: boolean; data?: unknown };
          const data = res?.data as
            | Record<string, unknown>
            | unknown[]
            | undefined;
          const list = Array.isArray(data)
            ? data
            : Array.isArray((data as Record<string, unknown>)?.vehicles)
              ? (data as { vehicles: unknown[] }).vehicles
              : [];
          return { count: list.length, sample: list.slice(0, 3) };
        },
      ),
    [runProbe],
  );

  const probeSafehouses = useCallback(
    () =>
      runProbe(
        "safehouses",
        () => panelBridgeApi.sendCommand("getSafehouses"),
        (r: unknown) => {
          const res = r as { success?: boolean; data?: unknown };
          const data = res?.data as
            | Record<string, unknown>
            | unknown[]
            | undefined;
          const list = Array.isArray(data)
            ? data
            : Array.isArray((data as Record<string, unknown>)?.safehouses)
              ? (data as { safehouses: unknown[] }).safehouses
              : [];
          return { count: list.length, sample: list.slice(0, 3) };
        },
      ),
    [runProbe],
  );

  const probeGameTime = useCallback(
    () =>
      runProbe(
        "gameTime",
        () => panelBridgeApi.getGameTime(),
        (r: unknown) => {
          const res = r as {
            success?: boolean;
            data?: {
              year?: number;
              month?: number;
              day?: number;
              hour?: number;
              minute?: number;
              worldAgeHours?: number;
            };
          };
          const d = res?.data;
          if (!d) return { count: null, sample: null };
          return {
            count: null,
            sample: {
              time: `Y${d.year} M${d.month} D${d.day} ${String(d.hour ?? 0).padStart(2, "0")}:${String(d.minute ?? 0).padStart(2, "0")}`,
              worldAgeHours: d.worldAgeHours,
            },
          };
        },
      ),
    [runProbe],
  );

  // Use the most recently probed player list to drive test actions.
  // Prefer the first *alive* player so a stale "dead" record doesn't
  // soak up the airdrop or lightning at coordinates the admin can't see.
  const firstPlayerCoords = useMemo(() => {
    const sample = probeResults["players"]?.sample as
      | Array<{ x?: number; y?: number; name?: string; alive?: boolean }>
      | undefined;
    if (!sample || !sample.length) return null;
    const p =
      sample.find(
        (pp) =>
          pp.alive !== false &&
          typeof pp.x === "number" &&
          typeof pp.y === "number",
      ) || sample[0];
    if (typeof p.x !== "number" || typeof p.y !== "number") return null;
    return {
      x: Math.round(p.x),
      y: Math.round(p.y),
      name: p.name,
      alive: p.alive !== false,
    };
  }, [probeResults]);

  // Run every probe sequentially so users get a single "refresh everything" button.
  const probeAll = useCallback(async () => {
    await probePlayers();
    await probeVehicles();
    await probeSafehouses();
    await probeGameTime();
  }, [probePlayers, probeVehicles, probeSafehouses, probeGameTime]);

  // Click-to-arm pattern for actions that are visible to all players
  // (airdrop, lightning, gunshot). First click arms the button for 4s,
  // second click within that window actually fires. Avoids accidental drops.
  const armOrFire = useCallback(
    (id: string, fire: () => void) => {
      if (armedAction === id) {
        if (armTimerRef.current) clearTimeout(armTimerRef.current);
        armTimerRef.current = null;
        setArmedAction(null);
        fire();
        return;
      }
      setArmedAction(id);
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
      armTimerRef.current = setTimeout(() => {
        setArmedAction((prev) => (prev === id ? null : prev));
        armTimerRef.current = null;
      }, 4000);
    },
    [armedAction],
  );

  // Cleanup arm timer on unmount.
  useEffect(
    () => () => {
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
    },
    [],
  );

  const runAction = useCallback(
    async (
      id: string,
      fn: () => Promise<unknown>,
      successTitle: string,
      successDesc?: string,
    ) => {
      setActionLoading(id);
      try {
        await fn();
        toast({ title: successTitle, description: successDesc });
      } catch (error) {
        const msg =
          getUserErrorMessage(error, t("common.actionFailedFallback"));
        toast({
          title: t("common.actionFailedTitle"),
          description: msg,
          variant: "destructive",
        });
      } finally {
        setActionLoading(null);
      }
    },
    [toast, t],
  );

  // Fetch log files list
  const fetchLogFiles = async () => {
    try {
      const res = await authFetch("/api/debug/logs/files");
      if (!res.ok) return;
      const data = await res.json();
      if (data.files) {
        setLogFiles(data.files);
      }
    } catch {
      // Endpoint may not exist yet
    }
  };

  const fetchPerformanceHistory = useCallback(async () => {
    const thisFetchId = ++perfFetchIdRef.current;
    setRefreshingPerformance(true);
    try {
      const limit = perfRange === "24h" ? 1440 : perfRange === "6h" ? 360 : 60;
      const res = await authFetch(
        `/api/debug/performance-history?limit=${limit}`,
      );
      if (thisFetchId !== perfFetchIdRef.current) return;
      if (!res.ok) return;
      const data = await res.json();
      if (thisFetchId !== perfFetchIdRef.current) return;
      if (data.history) {
        setPerformanceHistory(
          data.history.map((h: PerformanceSnapshot) => ({
            ...h,
            memoryMB: Math.round(h.memoryUsed / (1024 * 1024)),
            cpuLoad: h.cpuUsage,
            time: new Date(h.timestamp).toLocaleTimeString(i18n.language),
            hostMemGB: h.hostMemTotal
              ? +(h.hostMemTotal / (1024 * 1024 * 1024)).toFixed(1)
              : undefined,
            hostMemUsedGB: h.hostMemUsed
              ? +(h.hostMemUsed / (1024 * 1024 * 1024)).toFixed(1)
              : undefined,
            pzMemMB: h.pzMemUsed
              ? Math.round(h.pzMemUsed / (1024 * 1024))
              : null,
          })),
        );
      }
    } catch {
      // Endpoint may not exist yet
    } finally {
      if (thisFetchId === perfFetchIdRef.current) setRefreshingPerformance(false);
    }
  }, [authFetch, perfRange, i18n.language]);

  const fetchCrashLogs = async () => {
    setRefreshingCrashLogs(true);
    try {
      const res = await authFetch("/api/debug/crash-logs");
      if (!res.ok) return;
      const data = await res.json();
      if (data.crashLogs) {
        setCrashLogs(data.crashLogs);
        setCrashLogsTotalCount(
          typeof data.totalCount === "number" ? data.totalCount : data.crashLogs.length,
        );
      }
    } catch {
      // Endpoint may not exist yet
    } finally {
      setRefreshingCrashLogs(false);
    }
  };

  const loadCrashLogContent = async (filename: string) => {
    try {
      setLoadingCrashLog(true);
      setSelectedCrashLog(filename);
      const res = await authFetch(
        `/api/debug/crash-logs/${encodeURIComponent(filename)}`,
      );
      if (!res.ok) throw new Error(await parseDownloadError(res, `HTTP ${res.status}`));
      const data = await res.json();
      if (data.content !== undefined && data.content !== null) {
        setCrashLogContent(data.content || t("crashesTab.emptyFile"));
      } else {
        setCrashLogContent(t("crashesTab.loadFailed"));
      }
    } catch (error) {
      setCrashLogContent(getUserErrorMessage(error, t("crashesTab.loadFailed")));
    } finally {
      setLoadingCrashLog(false);
    }
  };

  // Fetch recent logs
  const fetchLogs = async () => {
    setRefreshingLogs(true);
    try {
      const res = await authFetch("/api/debug/logs");
      if (!res.ok) return;
      const data = await res.json();
      if (data.logs) {
        setLogs(
          data.logs.map((log: Omit<LogEntry, "id">, i: number) => ({
            ...log,
            id: `log-${i}-${Date.now()}`,
            timestamp: new Date(log.timestamp),
          })),
        );
      }
    } catch (error) {
      reportClientError("Failed to fetch logs.", error);
      toast({
        title: t("logsTab.logsFetchFailedTitle"),
        description: t("logsTab.logsFetchFailedDesc"),
        variant: "destructive",
      });
    } finally {
      setRefreshingLogs(false);
    }
  };

  // Fetch activity log
  const fetchActivity = useCallback(async () => {
    const thisFetchId = ++activityFetchIdRef.current;
    setRefreshingActivity(true);
    try {
      const res = await authFetch(
        `/api/debug/activity?limit=200&source=${activitySource}`,
      );
      if (thisFetchId !== activityFetchIdRef.current) return;
      if (!res.ok) return;
      const data = await res.json();
      if (thisFetchId !== activityFetchIdRef.current) return;
      if (data.entries) {
        setActivityEntries(data.entries);
        setActivityLastLoaded(new Date());
      }
    } catch {
      // Endpoint may not exist yet
    } finally {
      if (thisFetchId === activityFetchIdRef.current) setRefreshingActivity(false);
    }
  }, [authFetch, activitySource]);

  useEffect(() => {
    fetchSystemInfo();
    fetchHealthStatus();
    fetchLogFiles();
    fetchLogs();
    fetchCrashLogs();
    fetchDiagnostics();

    // Refresh system info every 30 seconds
    const interval = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      fetchSystemInfo();
      fetchHealthStatus();
      fetchDiagnostics();
    }, 30000);
    return () => clearInterval(interval);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- intentional mount-only init

  // Activity tab polling
  useEffect(() => {
    if (activeTab !== "activity") return;

    fetchActivity();
    const interval = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      if (activityPaused) return;
      fetchActivity();
    }, 15000);

    return () => clearInterval(interval);
  }, [activeTab, fetchActivity, activityPaused]);

  // World Map tab — fetch on entry, refresh every 30s while visible
  useEffect(() => {
    if (activeTab !== "worldmap") return;
    fetchWorldMapDiag();
    const interval = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      fetchWorldMapDiag();
    }, 30000);
    return () => clearInterval(interval);
  }, [activeTab, fetchWorldMapDiag]);

  // Auto-probe live players once when tab opens so test actions have a target.
  useEffect(() => {
    if (activeTab !== "worldmap") return;
    if (probeResults["players"]) return;
    probePlayers();
  }, [activeTab, probeResults, probePlayers]);

  // Keep the players probe fresh so the action target reflects reality.
  // Light interval (20s) — vehicles/safehouses/time stay manual to avoid
  // hammering the bridge.
  useEffect(() => {
    if (activeTab !== "worldmap") return;
    const interval = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      if (probeLoading) return;
      probePlayers();
    }, 20000);
    return () => clearInterval(interval);
  }, [activeTab, probePlayers, probeLoading]);

  // Live tick so heartbeat age and "checked Xs ago" stay accurate between fetches
  useEffect(() => {
    if (activeTab !== "worldmap") return;
    setWorldMapNowTick(Date.now());
    const id = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      setWorldMapNowTick(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== "performance") {
      return;
    }

    fetchPerformanceHistory();
    const interval = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      fetchPerformanceHistory();
    }, 30000);

    return () => clearInterval(interval);
  }, [activeTab, fetchPerformanceHistory]);

  // Listen for real-time logs via Socket.IO
  useEffect(() => {
    if (!socket || paused) return;

    const handleLog = (data: {
      level: string;
      message: string;
      timestamp: string;
      source?: string;
    }) => {
      setLogs((prev) => [
        ...prev.slice(-500),
        {
          id: `log-${Date.now()}-${Math.random()}`,
          level: data.level as LogEntry["level"],
          message: data.message,
          timestamp: new Date(data.timestamp),
          source: data.source,
        },
      ]);
    };

    socket.on("log:entry", handleLog);
    socket.emit("subscribe:logs");

    return () => {
      socket.off("log:entry", handleLog);
      socket.emit("unsubscribe:logs");
    };
  }, [socket, paused]);

  const clearLogs = () => {
    setLogs([]);
    toast({
      title: t("logsTab.logsClearedTitle"),
      description: t("logsTab.logsClearedDesc"),
    });
  };

  // Get unique sources for filter - defined before filteredLogs
  const availableSources = useMemo(() => {
    const sources = new Set<string>();
    logs.forEach((log) => {
      if (log.source) sources.add(log.source);
    });
    return Array.from(sources).sort();
  }, [logs]);

  // Memoize filtered logs
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      // Level filter
      if (levelFilter !== "all" && log.level !== levelFilter) return false;

      // Source filter
      if (sourceFilter !== "all" && log.source !== sourceFilter) return false;

      // Search query
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesMessage = log.message.toLowerCase().includes(query);
        const matchesSource = log.source?.toLowerCase().includes(query);
        if (!matchesMessage && !matchesSource) return false;
      }

      return true;
    });
  }, [logs, levelFilter, sourceFilter, searchQuery]);

  const downloadLogs = async (
    format: "txt" | "json" = "txt",
    filtered = false,
  ) => {
    let url: string | null = null;
    try {
      if (filtered) {
        // Download filtered logs from current view
        const dataToExport = filteredLogs.map((log) => ({
          timestamp: log.timestamp.toISOString(),
          level: log.level,
          source: log.source || "server",
          message: log.message,
        }));

        let content: string;
        let filename: string;
        let mimeType: string;

        if (format === "json") {
          content = JSON.stringify(dataToExport, null, 2);
          filename = `pz-logs-filtered-${new Date().toISOString().split("T")[0]}.json`;
          mimeType = "application/json";
        } else {
          content = dataToExport
            .map(
              (log) =>
                `[${log.timestamp}] [${log.level.toUpperCase()}] [${log.source}] ${log.message}`,
            )
            .join("\n");
          filename = `pz-logs-filtered-${new Date().toISOString().split("T")[0]}.txt`;
          mimeType = "text/plain";
        }

        const blob = new Blob([content], { type: mimeType });
        url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();

        toast({
          title: t("logsTab.exportedTitle"),
          description: t("logsTab.exportedDesc", {
            count: filteredLogs.length,
            format: format.toUpperCase(),
          }),
        });
      } else {
        // Download full log file from server
        const res = await authFetch("/api/debug/logs/download");
        if (!res.ok) throw new Error(await parseDownloadError(res, `HTTP ${res.status}`));
        const blob = await res.blob();
        url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `pz-manager-logs-${new Date().toISOString().split("T")[0]}.txt`;
        a.click();
      }
    } catch (error) {
      toast({
        title: t("logsTab.downloadFailedTitle"),
        description: getUserErrorMessage(error, t("logsTab.downloadFailedDesc")),
        variant: "destructive",
      });
    } finally {
      if (url) window.URL.revokeObjectURL(url);
    }
  };

  const downloadLogFile = useCallback(
    async (filename: string) => {
      let url: string | null = null;
      try {
        const res = await authFetch(
          `/api/debug/logs/download/${encodeURIComponent(filename)}`,
        );
        if (!res.ok) throw new Error(await parseDownloadError(res, `HTTP ${res.status}`));

        const blob = await res.blob();
        url = window.URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (error) {
        toast({
          title: t("logsTab.downloadFailedTitle"),
          description: getUserErrorMessage(error, t("logsTab.downloadFileFailedDesc", { name: filename })),
          variant: "destructive",
        });
      } finally {
        if (url) {
          const objectUrl = url;
          window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1000);
        }
      }
    },
    [authFetch, toast, t],
  );

  const downloadLogArchive = useCallback(async () => {
    let url: string | null = null;
    setDownloadingLogArchive(true);
    try {
      const res = await authFetch("/api/debug/logs/download-zip", {
        headers: { "X-UI-Language": getCurrentLanguage() },
      });
      if (!res.ok) throw new Error(await parseDownloadError(res, `HTTP ${res.status}`));

      const blob = await res.blob();
      url = window.URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = `pz-panel-logs-${new Date().toISOString().split("T")[0]}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (error) {
      toast({
        title: t("logsTab.downloadFailedTitle"),
        description: getUserErrorMessage(error, t("logsTab.downloadArchiveFailedDesc")),
        variant: "destructive",
      });
    } finally {
      setDownloadingLogArchive(false);
      if (url) {
        const objectUrl = url;
        window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1000);
      }
    }
  }, [authFetch, toast, t]);

  const copyLogEntry = (log: LogEntry) => {
    const text = `[${log.timestamp.toISOString()}] [${log.level.toUpperCase()}] ${log.source ? `[${log.source}] ` : ""}${log.message}`;
    copyText(text);
    toast({
      title: t("common.copied"),
      description: t("logsTab.logEntryCopiedDesc"),
    });
  };

  const formatMemory = (bytes: number) => {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const formatUptime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  };

  const formatTimestamp = useCallback(
    (date: Date): string => {
      switch (timeFormat) {
        case "relative": {
          const now = new Date();
          const diff = now.getTime() - date.getTime();
          if (diff < 1000) return t("common.justNow");
          if (diff < 60000) return t("common.secondsAgo", { count: Math.floor(diff / 1000) });
          if (diff < 3600000) return t("common.minutesAgo", { count: Math.floor(diff / 60000) });
          if (diff < 86400000) return t("common.hoursAgo", { count: Math.floor(diff / 3600000) });
          return t("common.daysAgo", { count: Math.floor(diff / 86400000) });
        }
        case "time":
          return date.toLocaleTimeString(i18n.language);
        case "datetime":
          return date.toLocaleString(i18n.language);
        default:
          return date.toLocaleTimeString(i18n.language);
      }
    },
    [timeFormat, t, i18n.language],
  );

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const handleEditPaths = () => {
    setNewDataDir(systemInfo?.dataDir || "");
    setNewLogsDir(systemInfo?.logsPath || "");
    setEditingPaths(true);
  };

  const handleSavePaths = async () => {
    if (!newDataDir && !newLogsDir) {
      toast({
        title: t("common.errorTitle"),
        description: t("systemTab.enterAtLeastOnePath"),
        variant: "destructive",
      });
      return;
    }

    setSavingPaths(true);
    try {
      const res = await authFetch("/api/debug/paths", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dataDir: newDataDir || undefined,
          logsDir: newLogsDir || undefined,
          moveFiles,
        }),
      });

      const data = await res.json();

      if (data.success) {
        toast({
          title: t("systemTab.pathsUpdatedTitle"),
          description: data.message,
          variant: "success" as const,
        });
        setEditingPaths(false);
        fetchSystemInfo();
      } else {
        toast({
          title: t("common.errorTitle"),
          description: data.error || t("systemTab.updatePathsFailedFallback"),
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: t("common.errorTitle"),
        description: getUserErrorMessage(error, t("systemTab.updatePathsFailedFallback")),
        variant: "destructive",
      });
    } finally {
      setSavingPaths(false);
    }
  };

  const toggleLogExpanded = (logId: string) => {
    setExpandedLogs((prev) => {
      const next = new Set(prev);
      if (next.has(logId)) {
        next.delete(logId);
      } else {
        next.add(logId);
      }
      return next;
    });
  };

  // Log stats
  const logStats = useMemo(
    () => ({
      total: logs.length,
      errors: logs.filter((l) => l.level === "error").length,
      warnings: logs.filter((l) => l.level === "warn").length,
      info: logs.filter((l) => l.level === "info").length,
      debug: logs.filter((l) => l.level === "debug").length,
    }),
    [logs],
  );

  // Activity stats — based on the server-filtered entries (already narrowed by Source select)
  const activityStats = useMemo(() => {
    const stats = {
      total: activityEntries.length,
      success: 0,
      failed: 0,
      rcon: 0,
      bridge: 0,
      player: 0,
      server: 0,
    };
    for (const e of activityEntries) {
      if (e.success) stats.success++;
      else stats.failed++;
      if (e.source === "rcon") stats.rcon++;
      else if (e.source === "bridge") stats.bridge++;
      else if (e.source === "player") stats.player++;
      else if (e.source === "server") stats.server++;
    }
    return stats;
  }, [activityEntries]);

  // Memoized + searched + result-filtered activity rows
  const filteredActivityEntries = useMemo(() => {
    const q = activitySearch.trim().toLowerCase();
    return activityEntries.filter((e) => {
      if (activityResultFilter === "success" && !e.success) return false;
      if (activityResultFilter === "failed" && e.success) return false;
      if (!q) return true;
      return (
        e.action.toLowerCase().includes(q) ||
        e.detail.toLowerCase().includes(q) ||
        e.source.toLowerCase().includes(q)
      );
    });
  }, [activityEntries, activitySearch, activityResultFilter]);

  const copyActivityEntry = useCallback(
    async (entry: ActivityEntry) => {
      const ts = new Date(entry.timestamp).toISOString();
      const argsStr =
        entry.args && Object.keys(entry.args).length > 0
          ? `\nargs: ${JSON.stringify(entry.args)}`
          : "";
      const durStr =
        entry.duration_ms != null ? ` (${entry.duration_ms}ms)` : "";
      const text = `[${ts}] [${entry.source}] ${entry.success ? "OK" : "FAIL"} ${entry.action}${durStr}\n${entry.detail}${argsStr}`;
      const ok = await copyText(text);
      toast({
        title: ok ? t("activityTab.copiedTitle") : t("activityTab.copyFailedTitle"),
        description: ok
          ? t("activityTab.copiedDesc")
          : t("activityTab.copyFailedDesc"),
        variant: ok ? ("success" as const) : "destructive",
      });
    },
    [toast, t],
  );

  // Performance stats — averages, peaks, span — derived from history
  const performanceStats = useMemo(() => {
    const collect = (
      sel: (p: PerformanceSnapshot) => number | null | undefined,
    ) => {
      const vals: number[] = [];
      for (const p of performanceHistory) {
        const v = sel(p);
        if (v != null && Number.isFinite(v)) vals.push(v);
      }
      if (vals.length === 0)
        return {
          avg: null as number | null,
          max: null as number | null,
          count: 0,
        };
      const sum = vals.reduce((a, b) => a + b, 0);
      return {
        avg: sum / vals.length,
        max: Math.max(...vals),
        count: vals.length,
      };
    };
    const cpu = collect((p) => p.cpuLoad);
    const hostGB = collect((p) => p.hostMemUsedGB);
    const pzMB = collect((p) => p.pzMemMB);
    const players = collect((p) => p.playerCount);

    let spanMs = 0;
    if (performanceHistory.length >= 2) {
      const first = new Date(performanceHistory[0].timestamp).getTime();
      const last = new Date(
        performanceHistory[performanceHistory.length - 1].timestamp,
      ).getTime();
      spanMs = Math.max(0, last - first);
    }
    return { cpu, hostGB, pzMB, players, spanMs };
  }, [performanceHistory]);

  const downloadPerformanceCsv = useCallback(() => {
    if (performanceHistory.length === 0) return;
    const header = [
      "timestamp",
      "cpu_pct",
      "host_mem_used_gb",
      "host_mem_total_gb",
      "pz_mem_mb",
      "panel_mem_mb",
      "player_count",
      "server_running",
    ];
    const rows = performanceHistory.map((p) => [
      new Date(p.timestamp).toISOString(),
      p.cpuLoad ?? "",
      p.hostMemUsedGB ?? "",
      p.hostMemGB ?? "",
      p.pzMemMB ?? "",
      p.memoryMB ?? "",
      p.playerCount ?? "",
      p.serverRunning ? "1" : "0",
    ]);
    const csv = [header, ...rows].map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `performance-${perfRange}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    toast({
      title: t("performanceTab.exportedTitle"),
      description: t("performanceTab.exportedDesc", {
        count: performanceHistory.length,
      }),
      variant: "success" as const,
    });
  }, [performanceHistory, perfRange, toast, t]);

  const getLevelIcon = (level: string) => {
    switch (level) {
      case "error":
        return <AlertCircle className="w-4 h-4 text-destructive" />;
      case "warn":
        return <AlertTriangle className="w-4 h-4 text-warning" />;
      case "info":
        return <Info className="w-4 h-4 text-primary" />;
      case "debug":
        return <Bug className="w-4 h-4 text-muted-foreground" />;
      default:
        return <CheckCircle className="w-4 h-4 text-primary" />;
    }
  };

  const getLevelLabel = (level: string) => {
    switch (level) {
      case "error":
        return t("common.levelError");
      case "warn":
        return t("common.levelWarn");
      case "info":
        return t("common.levelInfo");
      case "debug":
        return t("common.levelDebug");
      default:
        return level;
    }
  };

  const getSourceLabel = (source: string) => {
    switch (source) {
      case "rcon":
        return t("common.sourceRcon");
      case "bridge":
        return t("common.sourceBridge");
      case "player":
        return t("common.sourcePlayer");
      case "server":
        return t("common.sourceServer");
      default:
        return source;
    }
  };

  const getLevelColor = (level: string) => {
    switch (level) {
      case "error":
        return "text-destructive";
      case "warn":
        return "text-warning";
      case "info":
        return "text-primary";
      case "debug":
        return "text-muted-foreground";
      default:
        return "text-primary";
    }
  };

  return (
    <div className="space-y-6 page-transition">
      <PageHeader
        title={t("pageHeader.title")}
        description={t("pageHeader.description")}
        icon={<Bug className="w-5 h-5 text-primary" />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="command"
              size="lg"
              onClick={downloadLogArchive}
              disabled={downloadingLogArchive}
              className="gap-2"
            >
              {downloadingLogArchive ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Archive className="w-4 h-4" />
              )}
              {downloadingLogArchive
                ? t("headerActions.bundling")
                : t("headerActions.supportBundleZip")}
            </Button>
            <Button
              variant="outline"
              size="lg"
              onClick={() => downloadLogs("txt", false)}
              className="gap-2"
            >
              <FileDown className="w-4 h-4" />
              {t("headerActions.fullLogTxt")}
            </Button>
          </div>
        }
      />

      {diagnosticsPermissionDenied ? (
        <EmptyState
          icon={<ShieldAlert className="h-14 w-14 text-muted-foreground/40" />}
          title={t("permissionDenied.title")}
          description={t("permissionDenied.description")}
        />
      ) : (
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="space-y-4"
      >
        {/*
          Tab strip is organised into three operational zones, separated by
          thin vertical dividers so the eight tabs read as three clusters
          rather than a uniform row:
            • Now      — what's the server doing right this second
            • History  — what happened
            • System   — what this panel itself is made of
        */}
        <TabsList className="flex h-auto flex-wrap items-center gap-1 rounded-lg border border-border/60 bg-gradient-to-b from-muted/50 to-muted/25 p-1.5 w-full shadow-inner">
          {/* Zone: Now */}
          <TabsTrigger value="diagnostics" className="gap-2">
            <CheckCircle className="w-4 h-4" />
            {t("tabs.diagnostics")}
            {diagnostics &&
              (diagnostics.summary.fail > 0 ||
                diagnostics.summary.warn > 0) && (
                <Badge
                  variant={
                    diagnostics.summary.fail > 0 ? "destructive" : "outline"
                  }
                  className="ml-1 h-5 px-1.5 text-[10px]"
                >
                  {diagnostics.summary.fail + diagnostics.summary.warn}
                </Badge>
              )}
          </TabsTrigger>
          <TabsTrigger value="worldmap" className="gap-2">
            <MapIcon className="w-4 h-4" />
            {t("tabs.worldMap")}
            {worldMapDiag &&
              (worldMapDiag.summary.fail > 0 ||
                worldMapDiag.summary.warn > 0) && (
                <Badge
                  variant={
                    worldMapDiag.summary.fail > 0 ? "destructive" : "outline"
                  }
                  className="ml-1 h-5 px-1.5 text-[10px]"
                >
                  {worldMapDiag.summary.fail + worldMapDiag.summary.warn}
                </Badge>
              )}
          </TabsTrigger>
          <TabsTrigger value="performance" className="gap-2">
            <TrendingUp className="w-4 h-4" />
            {t("tabs.performance")}
          </TabsTrigger>

          {/* Zone divider: Now → History */}
          <span
            aria-hidden
            className="mx-1 h-5 w-px self-center bg-border/60"
          />

          {/* Zone: History */}
          <TabsTrigger value="activity" className="gap-2">
            <Zap className="w-4 h-4" />
            {t("tabs.activity")}
          </TabsTrigger>
          <TabsTrigger value="logs" className="gap-2">
            <Terminal className="w-4 h-4" />
            {t("tabs.logs")}
          </TabsTrigger>
          <TabsTrigger value="crashes" className="gap-2">
            <AlertCircle className="w-4 h-4" />
            {t("tabs.crashes")}
            {crashLogs.length > 0 && (
              <Badge variant="outline" className="ml-1 h-5 px-1.5 text-[10px]">
                {crashLogsTotalCount > crashLogs.length ? `${crashLogs.length}+` : crashLogs.length}
              </Badge>
            )}
          </TabsTrigger>

          {/* Zone divider: History → System */}
          <span
            aria-hidden
            className="mx-1 h-5 w-px self-center bg-border/60"
          />

          {/* Zone: System (panel self-introspection) */}
          <TabsTrigger value="health" className="gap-2">
            <Activity className="w-4 h-4" />
            {t("tabs.health")}
          </TabsTrigger>
          <TabsTrigger value="system" className="gap-2">
            <Database className="w-4 h-4" />
            {t("tabs.system")}
          </TabsTrigger>
        </TabsList>

        {/* Diagnostics Tab — Smart health checks with green/amber/red */}
        <TabsContent value="diagnostics" className="space-y-4">
          {diagnosticsError && (
            <Card className="border-2 border-destructive/50 bg-destructive/5">
              <CardContent className="pt-6">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-6 h-6 text-destructive shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <h3 className="text-base font-semibold">
                      {t("worldMapTab.couldNotReachTitle")}
                    </h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      {t("worldMapTab.couldNotReachDesc", { error: diagnosticsError })}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={fetchDiagnostics}
                    disabled={refreshingDiagnostics}
                  >
                    <RefreshCw
                      className={cn(
                        "w-4 h-4 mr-2",
                        refreshingDiagnostics && "animate-spin",
                      )}
                    />
                    {t("worldMapTab.retry")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
          {diagnosticsError && !diagnostics ? null : (
          <>
          {(() => {
            const overall = diagnostics?.overall;
            const summary = diagnostics?.summary;
            const overallTone =
              overall === "fail"
                ? "bg-destructive/10 border-destructive/40"
                : overall === "warn"
                  ? "bg-warning/10 border-warning/40"
                  : overall === "ok"
                    ? "bg-primary/10 border-primary/40"
                    : "bg-muted/30 border-border";
            const overallLabel =
              overall === "fail"
                ? t("diagnostics.overallFail")
                : overall === "warn"
                  ? t("diagnostics.overallWarn")
                  : overall === "ok"
                    ? t("diagnostics.overallOk")
                    : t("diagnostics.overallPending");
            const OverallIcon =
              overall === "fail"
                ? AlertCircle
                : overall === "warn"
                  ? AlertTriangle
                  : overall === "ok"
                    ? CheckCircle
                    : Loader2;

            return (
              <Card className={cn("border", overallTone)}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-3">
                      <OverallIcon
                        className={cn(
                          "w-7 h-7",
                          overall === "fail" && "text-destructive",
                          overall === "warn" && "text-warning",
                          overall === "ok" && "text-primary",
                          !overall && "text-muted-foreground animate-spin",
                        )}
                      />
                      <div>
                        <CardTitle className="text-xl">
                          {overallLabel}
                        </CardTitle>
                        <CardDescription>
                          {diagnostics ? (
                            t("diagnostics.lastChecked", {
                              time: formatTimestamp(new Date(diagnostics.timestamp)),
                              duration: diagnostics.durationMs,
                            })
                          ) : (
                            t("diagnostics.runningDescription")
                          )}
                        </CardDescription>
                      </div>
                    </div>
                    <div className="flex items-center flex-wrap gap-2">
                      {summary && (
                        <div className="flex items-center gap-1.5 text-xs">
                          <Badge
                            variant="outline"
                            className="gap-1 border-primary/40 text-primary"
                          >
                            <CheckCircle className="w-3 h-3" /> {summary.ok}
                          </Badge>
                          {summary.warn > 0 && (
                            <Badge
                              variant="outline"
                              className="gap-1 border-warning/40 text-warning"
                            >
                              <AlertTriangle className="w-3 h-3" />{" "}
                              {summary.warn}
                            </Badge>
                          )}
                          {summary.fail > 0 && (
                            <Badge variant="destructive" className="gap-1">
                              <AlertCircle className="w-3 h-3" /> {summary.fail}
                            </Badge>
                          )}
                          {summary.skip > 0 && (
                            <Badge
                              variant="outline"
                              className="gap-1 text-muted-foreground"
                            >
                              {t("diagnostics.skippedCount", { count: summary.skip })}
                            </Badge>
                          )}
                        </div>
                      )}
                      <div className="flex items-center gap-2 ml-2">
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
                          <Checkbox
                            checked={diagnosticsHideOk}
                            onCheckedChange={(v) => setDiagnosticsHideOk(!!v)}
                          />
                          {t("common.hidePassing")}
                        </label>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={fetchDiagnostics}
                          disabled={refreshingDiagnostics}
                        >
                          <RefreshCw
                            className={cn(
                              "w-4 h-4 mr-2",
                              refreshingDiagnostics && "animate-spin",
                            )}
                          />
                          {t("common.rerun")}
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            );
          })()}

          {!diagnostics && refreshingDiagnostics && (
            <Card>
              <CardContent className="py-12 flex items-center justify-center text-muted-foreground gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> {t("diagnostics.runningDiagnostics")}
              </CardContent>
            </Card>
          )}

          {diagnostics &&
            Object.entries(diagnostics.categories)
              .sort(([, a], [, b]) => a.order - b.order)
              .map(([catKey, catMeta]) => {
                const items = diagnostics.checks
                  .filter((c) => c.category === catKey)
                  .filter(
                    (c) =>
                      !diagnosticsHideOk ||
                      (c.status !== "ok" &&
                        c.status !== "skip" &&
                        c.status !== "info"),
                  );
                if (items.length === 0) return null;

                const catFails = items.filter(
                  (c) => c.status === "fail",
                ).length;
                const catWarns = items.filter(
                  (c) => c.status === "warn",
                ).length;
                const catTone =
                  catFails > 0
                    ? "destructive"
                    : catWarns > 0
                      ? "warning"
                      : "primary";

                return (
                  <Card key={catKey}>
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-base flex items-center gap-2">
                          <span
                            className={cn(
                              "inline-block w-2 h-2 rounded-full",
                              catTone === "destructive" && "bg-destructive",
                              catTone === "warning" && "bg-warning",
                              catTone === "primary" && "bg-primary",
                            )}
                          />
                          {catMeta.label}
                        </CardTitle>
                        <span className="text-xs text-muted-foreground">
                          {t("diagnostics.checkCount", { count: items.length })}
                        </span>
                      </div>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <ul className="divide-y divide-border/40">
                        {items.map((check) => {
                          const Icon =
                            check.status === "ok"
                              ? CheckCircle
                              : check.status === "fail"
                                ? AlertCircle
                                : check.status === "warn"
                                  ? AlertTriangle
                                  : check.status === "info"
                                    ? Info
                                    : Pause;
                          const iconClass =
                            check.status === "ok"
                              ? "text-primary"
                              : check.status === "fail"
                                ? "text-destructive"
                                : check.status === "warn"
                                  ? "text-warning"
                                  : check.status === "info"
                                    ? "text-primary/70"
                                    : "text-muted-foreground";
                          // Fix-action matching (below) keys off check.id and
                          // sniffs check.hint's ENGLISH text — must run
                          // against the raw, untranslated check, never the
                          // translated display copy.
                          const fixAction = getDiagnosticsFixAction(check, t);
                          const translated = translateDiagnosticCheck(check);
                          // Manual fixes call no API (a toast or a
                          // navigation) and need no capability -- only an
                          // automated fix can be blocked here.
                          const requiredCapability = fixAction?.automated
                            ? getRequiredCapabilityForCheck(check.id)
                            : null;
                          const canRunFix =
                            !requiredCapability || can(requiredCapability);
                          return (
                            <li
                              key={check.id}
                              className="py-2.5 flex items-start gap-3"
                            >
                              <Icon
                                className={cn(
                                  "w-4 h-4 mt-0.5 shrink-0",
                                  iconClass,
                                )}
                              />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-sm font-medium">
                                    {translated.label}
                                  </span>
                                  {check.status === "skip" && (
                                    <Badge
                                      variant="outline"
                                      className="h-4 px-1 text-[10px] text-muted-foreground"
                                    >
                                      {t("diagnostics.skippedBadge")}
                                    </Badge>
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground mt-0.5 break-words">
                                  {translated.message}
                                </p>
                                {translated.hint && (
                                  <p className="text-xs mt-1 text-foreground/70">
                                    <span className="font-medium text-foreground/90">
                                      {t("common.fixLabel")}
                                    </span>{" "}
                                    {translated.hint}
                                  </p>
                                )}
                                {diagnosticsFixErrors[check.id] && (
                                  <p className="text-xs mt-1 text-destructive">
                                    <span className="font-medium">
                                      {t("diagnostics.fixFailedTitle")}:
                                    </span>{" "}
                                    {diagnosticsFixErrors[check.id]}
                                  </p>
                                )}
                                {fixAction && (
                                  <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                                    <DisabledReason
                                      reason={
                                        !canRunFix
                                          ? t("diagnostics.noPermissionFix")
                                          : null
                                      }
                                    >
                                      <Button
                                        size="sm"
                                        className="h-7 px-2 text-[11px]"
                                        variant={
                                          fixAction.automated
                                            ? "default"
                                            : "outline"
                                        }
                                        onClick={() => {
                                          void handleDiagnosticsFix(check);
                                        }}
                                        disabled={
                                          (!!fixingDiagnosticsCheckId &&
                                            fixingDiagnosticsCheckId !==
                                              check.id) ||
                                          !canRunFix
                                        }
                                      >
                                        {fixingDiagnosticsCheckId ===
                                          check.id && (
                                          <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                        )}
                                        {fixAction.label}
                                      </Button>
                                    </DisabledReason>
                                    {fixAction.openServerConfig && (
                                      <Button
                                        asChild
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 px-2 text-[11px]"
                                      >
                                        <Link to="/server-config">
                                          {t("common.openServerConfig")}
                                        </Link>
                                      </Button>
                                    )}
                                    {fixAction.openMods && (
                                      <Button
                                        asChild
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 px-2 text-[11px]"
                                      >
                                        <Link to="/mods">{t("common.openMods")}</Link>
                                      </Button>
                                    )}
                                    {fixAction.links?.map((link) => (
                                      <Button
                                        key={link.to}
                                        asChild
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 px-2 text-[11px]"
                                      >
                                        <Link to={link.to}>{link.label}</Link>
                                      </Button>
                                    ))}
                                    {fixAction.note && (
                                      <span className="text-[11px] text-muted-foreground">
                                        {fixAction.note}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </CardContent>
                  </Card>
                );
              })}

          {diagnostics &&
            diagnosticsHideOk &&
            diagnostics.summary.fail === 0 &&
            diagnostics.summary.warn === 0 && (
              <Card>
                <CardContent className="py-10">
                  <EmptyState
                    icon={<CheckCircle className="w-14 h-14 text-primary/60" />}
                    title={t("diagnostics.allChecksPassTitle")}
                    description={t("diagnostics.allChecksPassDesc")}
                  />
                </CardContent>
              </Card>
            )}
          </>
          )}
        </TabsContent>

        {/* World Map Tab — dedicated diagnostics for the live map */}
        <TabsContent value="worldmap" className="space-y-4">
          {(() => {
            const wm = worldMapDiag;
            const overall = wm?.overall;
            const overallTone =
              overall === "fail"
                ? "bg-destructive/10 border-destructive/40"
                : overall === "warn"
                  ? "bg-warning/10 border-warning/40"
                  : overall === "ok"
                    ? "bg-primary/10 border-primary/40"
                    : "bg-muted/30 border-border";
            const overallLabel =
              overall === "fail"
                ? t("worldMapTab.overallFail")
                : overall === "warn"
                  ? t("worldMapTab.overallWarn")
                  : overall === "ok"
                    ? t("worldMapTab.overallOk")
                    : t("worldMapTab.overallPending");
            const OverallIcon =
              overall === "fail"
                ? AlertCircle
                : overall === "warn"
                  ? AlertTriangle
                  : overall === "ok"
                    ? CheckCircle
                    : Loader2;
            const fmtAge = (ms: number | null) => {
              if (ms === null || ms === undefined) return t("worldMapTab.ageNever");
              if (ms < 1000) return t("worldMapTab.ageJustNow");
              if (ms < 60_000) return t("worldMapTab.ageSecondsAgo", { s: Math.round(ms / 1000) });
              return t("worldMapTab.ageMinutesAgo", { m: Math.round(ms / 60_000) });
            };
            const lastRun = wm ? new Date(wm.timestamp) : null;
            const lastRunMs = lastRun ? lastRun.getTime() : null;
            // Compute live ages so values keep ticking between 30s fetches.
            const sinceFetchMs =
              lastRunMs !== null ? Math.max(0, worldMapNowTick - lastRunMs) : 0;
            const liveHeartbeatAge =
              wm?.bridge?.statusAgeMs !== null &&
              wm?.bridge?.statusAgeMs !== undefined
                ? wm.bridge.statusAgeMs + sinceFetchMs
                : null;
            // Most actionable items first so end users see what to fix.
            const STATUS_ORDER: Record<DiagCheck["status"], number> = {
              fail: 0,
              warn: 1,
              info: 2,
              skip: 3,
              ok: 4,
            };
            const sortedChecks = wm
              ? [...wm.checks].sort(
                  (a, b) =>
                    (STATUS_ORDER[a.status] ?? 9) -
                    (STATUS_ORDER[b.status] ?? 9),
                )
              : [];
            const visibleChecks = worldMapHideOk
              ? sortedChecks.filter(
                  (c) => c.status !== "ok" && c.status !== "skip",
                )
              : sortedChecks;
            const firstFix =
              sortedChecks.find((c) => c.status === "fail") ||
              sortedChecks.find((c) => c.status === "warn") ||
              null;
            const firstFixTranslated = firstFix
              ? translateDiagnosticCheck(firstFix)
              : null;
            const copyPath = async (label: string, value: string) => {
              const ok = await copyText(value);
              toast({
                title: ok ? t("worldMapTab.labelCopied", { label }) : t("common.copyFailed"),
                description: ok ? value : t("common.couldNotAccessClipboard"),
                variant: ok ? "default" : "destructive",
              });
            };
            const CopyablePath = ({
              label,
              value,
            }: {
              label: string;
              value: string;
            }) => (
              <button
                type="button"
                onClick={() => copyPath(label, value)}
                title={t("worldMapTab.copyPathTitle", { label: label.toLowerCase() })}
                className="group inline-flex items-center gap-1.5 max-w-full text-left"
              >
                <code className="font-mono text-[11px] break-all group-hover:text-primary transition-colors">
                  {value}
                </code>
                <Copy className="w-3 h-3 shrink-0 text-muted-foreground/60 group-hover:text-primary transition-colors" />
              </button>
            );
            const copyReport = async () => {
              if (!wm) return;
              const lines: string[] = [];
              lines.push(`World Map diagnostics — ${wm.timestamp}`);
              lines.push(
                `Overall: ${wm.overall.toUpperCase()} (${wm.summary.fail} fail / ${wm.summary.warn} warn / ${wm.summary.ok} ok)`,
              );
              lines.push("");
              lines.push("Tile sources:");
              for (const k of ["b42", "b41"] as const) {
                const p = wm.tileSources?.[k];
                lines.push(
                  `  ${k.toUpperCase()}: ${p ? (p.reachable ? `OK (${p.latencyMs}ms HTTP ${p.statusCode})` : `FAIL (${p.error || "HTTP " + p.statusCode})`) : "—"}`,
                );
              }
              if (wm.bridge) {
                lines.push("");
                lines.push("PanelBridge:");
                lines.push(
                  `  configured=${wm.bridge.configured} running=${wm.bridge.isRunning} mod=${wm.bridge.modConnected} heartbeatAge=${fmtAge(liveHeartbeatAge)}`,
                );
                if (wm.bridge.bridgePath)
                  lines.push(`  path=${wm.bridge.bridgePath}`);
              }
              lines.push("");
              lines.push(
                `Save: build=${wm.save.build} count=${wm.save.saveCount} active=${wm.save.activeSaveName || "—"}`,
              );
              if (wm.save.zomboidDataPath)
                lines.push(`  zomboidData=${wm.save.zomboidDataPath}`);
              lines.push("");
              lines.push("Checks:");
              for (const c of sortedChecks) {
                const translated = translateDiagnosticCheck(c);
                lines.push(
                  `  [${c.status.toUpperCase()}] ${translated.label} — ${translated.message}${translated.hint ? `  Fix: ${translated.hint}` : ""}`,
                );
              }
              const ok = await copyText(lines.join("\n"));
              toast({
                title: ok ? t("worldMapTab.reportCopiedTitle") : t("common.copyFailed"),
                description: ok
                  ? t("worldMapTab.reportCopiedDesc")
                  : t("common.couldNotAccessClipboard"),
                variant: ok ? "default" : "destructive",
              });
            };
            return (
              <>
                {worldMapError && (
                  <Card className="border-2 border-destructive/50 bg-destructive/5">
                    <CardContent className="pt-6">
                      <div className="flex items-start gap-3">
                        <AlertCircle className="w-6 h-6 text-destructive shrink-0 mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <h3 className="text-base font-semibold">
                            {t("worldMapTab.couldNotReachTitle")}
                          </h3>
                          <p className="text-sm text-muted-foreground mt-1">
                            {t("worldMapTab.couldNotReachDesc", { error: worldMapError })}
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={fetchWorldMapDiag}
                          disabled={refreshingWorldMap}
                        >
                          <RefreshCw
                            className={cn(
                              "w-4 h-4 mr-2",
                              refreshingWorldMap && "animate-spin",
                            )}
                          />
                          {t("worldMapTab.retry")}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                )}
                {worldMapError && !wm ? null : (
                  <>
                    <Card
                      className={cn("border-2 transition-colors", overallTone)}
                    >
                      <CardContent className="pt-6">
                        <div className="flex items-start justify-between gap-4 flex-wrap">
                          <div className="flex items-start gap-3">
                            <OverallIcon
                              className={cn(
                                "w-8 h-8 shrink-0",
                                overall === "fail"
                                  ? "text-destructive"
                                  : overall === "warn"
                                    ? "text-warning"
                                    : overall === "ok"
                                      ? "text-primary"
                                      : "text-muted-foreground animate-spin",
                              )}
                            />
                            <div>
                              <h3 className="text-lg font-semibold">
                                {overallLabel}
                              </h3>
                              <p className="text-sm text-muted-foreground">
                                {t("worldMapTab.liveDescription")}
                              </p>
                              {wm && (
                                <div className="flex items-center gap-2 mt-2 flex-wrap text-xs">
                                  <Badge
                                    variant="outline"
                                    className="bg-primary/10 border-primary/30 text-primary"
                                  >
                                    <CheckCircle className="w-3 h-3 mr-1" />{" "}
                                    {t("worldMapTab.okCount", { count: wm.summary.ok })}
                                  </Badge>
                                  {wm.summary.warn > 0 && (
                                    <Badge
                                      variant="outline"
                                      className="bg-warning/10 border-warning/30 text-warning"
                                    >
                                      <AlertTriangle className="w-3 h-3 mr-1" />{" "}
                                      {t("worldMapTab.warnCount", { count: wm.summary.warn })}
                                    </Badge>
                                  )}
                                  {wm.summary.fail > 0 && (
                                    <Badge variant="destructive">
                                      <AlertCircle className="w-3 h-3 mr-1" />{" "}
                                      {t("worldMapTab.failCount", { count: wm.summary.fail })}
                                    </Badge>
                                  )}
                                  {wm.summary.skip > 0 && (
                                    <Badge
                                      variant="outline"
                                      className="text-muted-foreground"
                                    >
                                      {t("worldMapTab.skippedCount", { count: wm.summary.skip })}
                                    </Badge>
                                  )}
                                  <span className="text-muted-foreground">
                                    {t("worldMapTab.durationMs", { duration: wm.durationMs })}
                                    {lastRun &&
                                      t("worldMapTab.checkedAgeSuffix", { age: fmtAge(sinceFetchMs) })}
                                  </span>
                                  {refreshingWorldMap && (
                                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                      {t("worldMapTab.refreshing")}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <Button variant="outline" size="sm" asChild>
                              <Link to="/world-map">
                                <ExternalLink className="w-4 h-4 mr-2" />
                                {t("worldMapTab.openWorldMap")}
                              </Link>
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={copyReport}
                              disabled={!wm}
                            >
                              <Copy className="w-4 h-4 mr-2" />
                              {t("worldMapTab.copyReport")}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={fetchWorldMapDiag}
                              disabled={refreshingWorldMap}
                            >
                              <RefreshCw
                                className={cn(
                                  "w-4 h-4 mr-2",
                                  refreshingWorldMap && "animate-spin",
                                )}
                              />
                              {t("common.rerun")}
                            </Button>
                          </div>
                        </div>
                        {firstFix && (
                          <div
                            className={cn(
                              "mt-4 p-3 rounded-md border flex items-start gap-3",
                              firstFix.status === "fail"
                                ? "border-destructive/40 bg-destructive/5"
                                : "border-warning/40 bg-warning/5",
                            )}
                          >
                            {firstFix.status === "fail" ? (
                              <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
                            ) : (
                              <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-semibold">
                                {firstFix.status === "fail"
                                  ? t("worldMapTab.actionNeeded")
                                  : t("worldMapTab.headsUp")}
                                : {firstFixTranslated?.label}
                              </div>
                              <div className="text-xs text-muted-foreground mt-0.5">
                                {firstFixTranslated?.message}
                              </div>
                              {firstFixTranslated?.hint && (
                                <div className="text-xs mt-1.5">
                                  <span className="font-semibold text-primary">
                                    {t("common.fixLabel")}
                                  </span>{" "}
                                  {firstFixTranslated.hint}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    {/* Tile sources */}
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                          <Globe className="w-4 h-4 text-primary" />
                          {t("worldMapTab.tileSourcesTitle")}
                        </CardTitle>
                        <CardDescription>
                          {t("worldMapTab.tileSourcesDesc")}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {(["b42", "b41"] as const).map((kind) => {
                          const probe = wm?.tileSources?.[kind];
                          const label =
                            kind === "b42"
                              ? t("worldMapTab.tileLabelB42")
                              : t("worldMapTab.tileLabelB41");
                          return (
                            <div
                              key={kind}
                              className="flex items-start justify-between gap-3 p-3 rounded-md border bg-card"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  {probe ? (
                                    probe.reachable ? (
                                      <CheckCircle className="w-4 h-4 text-primary shrink-0" />
                                    ) : (
                                      <AlertCircle
                                        className={cn(
                                          "w-4 h-4 shrink-0",
                                          kind === "b42"
                                            ? "text-destructive"
                                            : "text-warning",
                                        )}
                                      />
                                    )
                                  ) : (
                                    <Loader2 className="w-4 h-4 text-muted-foreground animate-spin shrink-0" />
                                  )}
                                  <span className="font-medium text-sm">
                                    {label}
                                  </span>
                                  {probe?.reachable && (
                                    <Badge
                                      variant="outline"
                                      className="text-[10px]"
                                    >
                                      {probe.latencyMs} ms
                                    </Badge>
                                  )}
                                  {probe && !probe.reachable && (
                                    <Badge
                                      variant="destructive"
                                      className="text-[10px]"
                                    >
                                      {probe.error ||
                                        `HTTP ${probe.statusCode}`}
                                    </Badge>
                                  )}
                                </div>
                                {probe && (
                                  <div className="mt-1 flex items-center gap-2 flex-wrap">
                                    <CopyablePath
                                      label={t("worldMapTab.probeUrlLabel")}
                                      value={probe.url}
                                    />
                                    <a
                                      href={probe.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary transition-colors"
                                      title={t("worldMapTab.openExternalTitle")}
                                    >
                                      <ExternalLink className="w-3 h-3" />
                                      {t("worldMapTab.openExternal")}
                                    </a>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}

                        {/* Live tile preview through our proxy */}
                        <div className="mt-3 pt-3 border-t">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-medium text-muted-foreground">
                              {t("worldMapTab.liveTileViaProxy")}
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-xs"
                              onClick={() => {
                                setWorldMapTileErrors({
                                  b42: false,
                                  b41: false,
                                });
                                setWorldMapTileMeta({ b42: null, b41: null });
                                setWorldMapTilePreviewKey((k) => k + 1);
                              }}
                            >
                              <RefreshCw className="w-3 h-3 mr-1" /> {t("common.refresh")}
                            </Button>
                          </div>
                          {(() => {
                            const tiles: Array<{
                              key: "b42" | "b41";
                              label: string;
                              src: string;
                              errTone: string;
                            }> = [
                              {
                                key: "b42",
                                label: t("worldMapTab.tileLabelB42Preview"),
                                src: `/api/map/tiles/0/0_0.jpg?floor=0&t=${worldMapTilePreviewKey}`,
                                errTone: "destructive",
                              },
                              {
                                key: "b41",
                                label: t("worldMapTab.tileLabelB41Preview"),
                                src: `/api/map/b41tiles/0/0_0.jpg?t=${worldMapTilePreviewKey}`,
                                errTone: "warning",
                              },
                            ];
                            return (
                              <div className="flex flex-wrap gap-3">
                                {tiles.map((tile) => {
                                  const failed = worldMapTileErrors[tile.key];
                                  const meta = worldMapTileMeta[tile.key];
                                  const loaded = !failed && meta !== null;
                                  return (
                                    <div
                                      key={tile.key}
                                      className="flex items-center gap-3 rounded-lg border border-border/55 bg-muted/20 p-2.5"
                                    >
                                      <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded border border-border/60 bg-muted/40">
                                        {failed ? (
                                          <div className="flex h-full w-full flex-col items-center justify-center p-1 text-center">
                                            <AlertCircle
                                              className={cn(
                                                "w-4 h-4 mb-0.5",
                                                tile.errTone === "destructive"
                                                  ? "text-destructive"
                                                  : "text-warning",
                                              )}
                                            />
                                            <div
                                              className={cn(
                                                "text-[9px] font-medium leading-tight",
                                                tile.errTone === "destructive"
                                                  ? "text-destructive"
                                                  : "text-warning",
                                              )}
                                            >
                                              {t("worldMapTab.tileFailedIcon")}
                                            </div>
                                          </div>
                                        ) : (
                                          <img
                                            key={`${tile.key}-${worldMapTilePreviewKey}`}
                                            src={tile.src}
                                            alt={`${tile.label} preview`}
                                            className="h-full w-full object-cover"
                                            onLoad={(e) => {
                                              const img = e.currentTarget;
                                              setWorldMapTileMeta((prev) => ({
                                                ...prev,
                                                [tile.key]: {
                                                  w: img.naturalWidth,
                                                  h: img.naturalHeight,
                                                },
                                              }));
                                            }}
                                            onError={() =>
                                              setWorldMapTileErrors((prev) => ({
                                                ...prev,
                                                [tile.key]: true,
                                              }))
                                            }
                                          />
                                        )}
                                      </div>
                                      <div className="min-w-0">
                                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                          {tile.label}
                                        </div>
                                        <div className="mt-1">
                                          {failed ? (
                                            <span
                                              className={cn(
                                                "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                                                tile.errTone === "destructive"
                                                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                                                  : "border-warning/40 bg-warning/10 text-warning",
                                              )}
                                            >
                                              <AlertCircle className="w-2.5 h-2.5" />{" "}
                                              {t("worldMapTab.tileFailedBadge")}
                                            </span>
                                          ) : loaded ? (
                                            <span className="inline-flex items-center gap-1 rounded-full border border-primary/35 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                              <CheckCircle className="w-2.5 h-2.5" />{" "}
                                              {t("worldMapTab.tileLoadedBadge")}
                                              <span className="font-mono tabular-nums text-primary/80">
                                                {meta!.w}×{meta!.h}
                                              </span>
                                            </span>
                                          ) : (
                                            <span className="inline-flex items-center gap-1 rounded-full border border-border/55 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                              <Loader2 className="w-2.5 h-2.5 animate-spin" />{" "}
                                              {t("worldMapTab.tileLoadingBadge")}
                                            </span>
                                          )}
                                        </div>
                                        <p className="mt-1 text-[10px] text-muted-foreground/70 leading-tight">
                                          {t("worldMapTab.tileCornerHint")}
                                        </p>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          })()}
                        </div>
                      </CardContent>
                    </Card>

                    {/* Live data feed */}
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                          <Wifi className="w-4 h-4 text-primary" />
                          {t("worldMapTab.liveDataFeedTitle")}
                        </CardTitle>
                        <CardDescription>
                          {t("worldMapTab.liveDataFeedDesc")}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        {wm?.bridge ? (
                          <div className="grid grid-cols-2 gap-2 text-sm">
                            <div className="p-2 rounded border bg-card">
                              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                {t("worldMapTab.configuredLabel")}
                              </div>
                              <div className="font-medium">
                                {wm.bridge.configured ? t("common.yes") : t("common.no")}
                              </div>
                            </div>
                            <div className="p-2 rounded border bg-card">
                              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                {t("worldMapTab.serviceRunningLabel")}
                              </div>
                              <div className="font-medium flex items-center gap-1">
                                {wm.bridge.isRunning ? (
                                  <>
                                    <Wifi className="w-3 h-3 text-primary" />{" "}
                                    {t("common.yes")}
                                  </>
                                ) : (
                                  <>
                                    <WifiOff className="w-3 h-3 text-muted-foreground" />{" "}
                                    {t("common.no")}
                                  </>
                                )}
                              </div>
                            </div>
                            <div className="p-2 rounded border bg-card">
                              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                {t("worldMapTab.modConnectedLabel")}
                              </div>
                              <div className="font-medium">
                                {wm.bridge.modConnected ? t("common.yes") : t("common.no")}
                              </div>
                            </div>
                            {(() => {
                              const age = liveHeartbeatAge;
                              const stale =
                                age !== null &&
                                age !== undefined &&
                                age > 30_000;
                              const slow =
                                age !== null &&
                                age !== undefined &&
                                age > 10_000;
                              const tone = stale
                                ? "border-destructive/40 bg-destructive/5"
                                : slow
                                  ? "border-warning/40 bg-warning/5"
                                  : "bg-card";
                              const label = stale
                                ? "text-destructive"
                                : slow
                                  ? "text-warning"
                                  : "text-muted-foreground";
                              return (
                                <div className={cn("p-2 rounded border", tone)}>
                                  <div
                                    className={cn(
                                      "text-[10px] uppercase tracking-wide",
                                      label,
                                    )}
                                  >
                                    {t("worldMapTab.lastHeartbeatLabel")}
                                  </div>
                                  <div className="font-medium">
                                    {fmtAge(age)}
                                    {stale && t("worldMapTab.staleSuffix")}
                                  </div>
                                </div>
                              );
                            })()}
                            {wm.bridge.consecutiveFailures > 0 && (
                              <div className="col-span-2 p-2 rounded border border-warning/30 bg-warning/5">
                                <div className="text-[10px] uppercase tracking-wide text-warning">
                                  {t("worldMapTab.consecutiveFailuresLabel")}
                                </div>
                                <div className="font-medium">
                                  {wm.bridge.consecutiveFailures}
                                </div>
                              </div>
                            )}
                            {wm.bridge.bridgePath && (
                              <div className="col-span-2 p-2 rounded border bg-card">
                                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
                                  {t("worldMapTab.bridgePathLabel")}
                                </div>
                                <CopyablePath
                                  label={t("worldMapTab.bridgePathLabel")}
                                  value={wm.bridge.bridgePath}
                                />
                              </div>
                            )}
                            <div className="col-span-2 p-2 rounded border bg-card">
                              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                {t("worldMapTab.requiredHandlersLabel")}
                              </div>
                              <div className="text-[11px] text-muted-foreground mb-1.5">
                                {t("worldMapTab.requiredHandlersDesc")}
                              </div>
                              <div className="flex gap-1 flex-wrap">
                                {wm.handlers.map((h) => (
                                  <Badge
                                    key={h}
                                    variant="outline"
                                    className="text-[10px] font-mono"
                                  >
                                    {h}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="text-sm text-muted-foreground">
                            {t("worldMapTab.noBridgeData")}
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    {/* Live data probes — actively call the bridge endpoints the World Map uses */}
                    <Card>
                      <CardHeader className="pb-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <CardTitle className="flex items-center gap-2 text-base">
                              <PlayCircle className="w-4 h-4 text-primary" />
                              {t("worldMapTab.liveProbesTitle")}
                            </CardTitle>
                            <CardDescription>
                              {t("worldMapTab.liveProbesDesc")}
                            </CardDescription>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={probeAll}
                            disabled={!!probeLoading}
                            className="shrink-0"
                          >
                            {probeLoading ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                            ) : (
                              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                            )}
                            {t("worldMapTab.probeAll")}
                          </Button>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {(
                          [
                            {
                              id: "players",
                              label: t("worldMapTab.probeLabelPlayers"),
                              Icon: Users,
                              run: probePlayers,
                            },
                            {
                              id: "vehicles",
                              label: t("worldMapTab.probeLabelVehicles"),
                              Icon: Car,
                              run: probeVehicles,
                            },
                            {
                              id: "safehouses",
                              label: t("worldMapTab.probeLabelSafehouses"),
                              Icon: Home,
                              run: probeSafehouses,
                            },
                            {
                              id: "gameTime",
                              label: t("worldMapTab.probeLabelGameTime"),
                              Icon: Clock,
                              run: probeGameTime,
                            },
                          ] as const
                        ).map(({ id, label, Icon, run }) => {
                          const r = probeResults[id];
                          const busy = probeLoading === id;
                          const ageMs = r ? worldMapNowTick - r.at : null;
                          const stale = ageMs !== null && ageMs > 60000;
                          return (
                            <div
                              key={id}
                              className="flex items-center gap-3 p-2.5 rounded-md border bg-card"
                            >
                              <Icon className="w-4 h-4 text-primary shrink-0" />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-sm font-medium">
                                    {label}
                                  </span>
                                  {r && r.ok && (
                                    <Badge
                                      variant="outline"
                                      className="text-[10px] bg-primary/10 border-primary/30 text-primary"
                                    >
                                      {id === "gameTime"
                                        ? (r.sample as { time?: string })
                                            ?.time || "OK"
                                        : t(
                                            id === "players"
                                              ? "worldMapTab.unitPlayer"
                                              : id === "vehicles"
                                                ? "worldMapTab.unitVehicle"
                                                : "worldMapTab.unitSafehouse",
                                            { count: r.count ?? 0 },
                                          )}
                                    </Badge>
                                  )}
                                  {r && !r.ok && (
                                    <Badge
                                      variant="destructive"
                                      className="text-[10px] max-w-[18rem] truncate"
                                      title={r.error}
                                    >
                                      {r.error || t("worldMapTab.probeFailedFallback")}
                                    </Badge>
                                  )}
                                  {r && (
                                    <span
                                      className={cn(
                                        "text-[10px]",
                                        stale
                                          ? "text-warning"
                                          : "text-muted-foreground",
                                      )}
                                    >
                                      {r.latencyMs} ms · {fmtAge(ageMs)}
                                    </span>
                                  )}
                                </div>
                                {id === "players" &&
                                  r?.ok &&
                                  Array.isArray(r.sample) &&
                                  r.sample.length > 0 && (
                                    <div className="text-[11px] text-muted-foreground mt-1 space-y-0.5">
                                      {(
                                        r.sample as Array<{
                                          name?: string;
                                          x?: number;
                                          y?: number;
                                          alive?: boolean;
                                          access?: string;
                                        }>
                                      ).map((p, i) => (
                                        <div key={i} className="font-mono">
                                          {p.name || "?"}{" "}
                                          <span className="opacity-60">
                                            @ {p.x}, {p.y}
                                          </span>
                                          {p.alive === false && (
                                            <span className="text-destructive ml-1">
                                              {t("worldMapTab.deadSuffix")}
                                            </span>
                                          )}
                                          {p.access && p.access !== "None" && (
                                            <span className="text-warning ml-1">
                                              · {p.access}
                                            </span>
                                          )}
                                        </div>
                                      ))}
                                      {r.count !== null &&
                                        r.count >
                                          (r.sample as unknown[]).length && (
                                          <div className="opacity-60">
                                            {t("worldMapTab.moreCount", {
                                              count:
                                                r.count -
                                                (r.sample as unknown[]).length,
                                            })}
                                          </div>
                                        )}
                                    </div>
                                  )}
                                {id === "players" && r?.ok && r.count === 0 && (
                                  <div className="text-[11px] text-muted-foreground mt-1 italic">
                                    {t("worldMapTab.noPlayersOnlineHint")}
                                  </div>
                                )}
                              </div>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={run}
                                disabled={busy}
                                className="shrink-0"
                              >
                                {busy ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <RefreshCw className="w-3.5 h-3.5" />
                                )}
                                <span className="ml-1.5">{t("worldMapTab.probeButton")}</span>
                              </Button>
                            </div>
                          );
                        })}
                      </CardContent>
                    </Card>

                    {/* Test live actions — exercise the same actions World Map can trigger */}
                    {(() => {
                      const bridgeReady = wm?.bridge?.modConnected === true;
                      const hasTarget = !!firstPlayerCoords;
                      const actionsDisabled = !bridgeReady || !hasTarget;
                      return (
                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="flex items-center gap-2 text-base">
                              <Zap className="w-4 h-4 text-warning" />
                              {t("worldMapTab.testActionsTitle")}
                            </CardTitle>
                            <CardDescription>
                              {t("worldMapTab.testActionsDescPrefix")}{" "}
                              <span className="font-semibold text-warning">
                                {t("worldMapTab.testActionsDescBold")}
                              </span>{" "}
                              {t("worldMapTab.testActionsDescSuffix")}
                            </CardDescription>
                          </CardHeader>
                          <CardContent className="space-y-3">
                            {!bridgeReady && (
                              <div className="p-2.5 rounded-md border border-destructive/40 bg-destructive/10 text-xs flex items-start gap-2">
                                <WifiOff className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
                                <div>
                                  <div className="font-medium text-destructive">
                                    {t("worldMapTab.bridgeNotConnectedTitle")}
                                  </div>
                                  <div className="text-muted-foreground">
                                    {t("worldMapTab.bridgeNotConnectedDesc")}
                                  </div>
                                </div>
                              </div>
                            )}
                            <div className="p-2 rounded border bg-card text-xs">
                              <span className="text-muted-foreground">
                                {t("worldMapTab.targetLabel")}
                              </span>{" "}
                              {firstPlayerCoords ? (
                                <>
                                  <span className="font-mono">
                                    {firstPlayerCoords.name}
                                  </span>{" "}
                                  <span className="text-muted-foreground">
                                    @ {firstPlayerCoords.x},{" "}
                                    {firstPlayerCoords.y}
                                  </span>
                                  {!firstPlayerCoords.alive && (
                                    <span className="text-destructive ml-1">
                                      {t("worldMapTab.deadSuffix")}
                                    </span>
                                  )}
                                </>
                              ) : probeResults["players"]?.ok &&
                                probeResults["players"]?.count === 0 ? (
                                <span className="text-muted-foreground italic">
                                  {t("worldMapTab.targetNoPlayersOnline")}
                                </span>
                              ) : (
                                <span className="text-muted-foreground italic">
                                  {t("worldMapTab.targetNoneProbedYet")}
                                </span>
                              )}
                            </div>

                            {/* Airdrop */}
                            <div className="p-2.5 rounded-md border bg-card space-y-2">
                              <div className="flex items-center gap-2">
                                <Package className="w-4 h-4 text-warning shrink-0" />
                                <span className="text-sm font-medium">
                                  {t("worldMapTab.airdropDropLabel")}
                                </span>
                              </div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <Select
                                  value={airdropPreset}
                                  onValueChange={(v) =>
                                    setAirdropPreset(v as typeof airdropPreset)
                                  }
                                >
                                  <SelectTrigger className="h-8 w-32 text-xs">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="food">{t("worldMapTab.airdropFoodOption")}</SelectItem>
                                    <SelectItem value="medical">
                                      {t("worldMapTab.airdropMedicalOption")}
                                    </SelectItem>
                                    <SelectItem value="military">
                                      Military
                                    </SelectItem>
                                    <SelectItem value="weapons">
                                      {t("worldMapTab.airdropWeaponsOption")}
                                    </SelectItem>
                                    <SelectItem value="building">
                                      {t("worldMapTab.airdropBuildingOption")}
                                    </SelectItem>
                                    <SelectItem value="tools">{t("worldMapTab.airdropToolsOption")}</SelectItem>
                                  </SelectContent>
                                </Select>
                                <Button
                                  variant={
                                    armedAction === "airdrop"
                                      ? "destructive"
                                      : "outline"
                                  }
                                  size="sm"
                                  disabled={
                                    actionsDisabled ||
                                    actionLoading === "airdrop"
                                  }
                                  onClick={() =>
                                    firstPlayerCoords &&
                                    armOrFire("airdrop", () =>
                                      runAction(
                                        "airdrop",
                                        () =>
                                          panelBridgeApi.triggerAirdrop({
                                            x: firstPlayerCoords.x,
                                            y: firstPlayerCoords.y,
                                            preset: airdropPreset,
                                            announce: true,
                                            attractZombies: true,
                                          }),
                                        t("worldMapTab.airdropDeployedTitle"),
                                        t("worldMapTab.airdropDeployedDesc", {
                                          preset: t(`worldMapTab.airdrop${airdropPreset.charAt(0).toUpperCase()}${airdropPreset.slice(1)}Option`),
                                          x: firstPlayerCoords.x,
                                          y: firstPlayerCoords.y,
                                        }),
                                      ),
                                    )
                                  }
                                >
                                  {actionLoading === "airdrop" ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                                  ) : (
                                    <Package className="w-3.5 h-3.5 mr-1.5" />
                                  )}
                                  {armedAction === "airdrop"
                                    ? t("worldMapTab.clickAgainToConfirm")
                                    : t("worldMapTab.dropNow")}
                                </Button>
                              </div>
                            </div>

                            {/* Test gunshot sound */}
                            <div className="p-2.5 rounded-md border bg-card flex items-center justify-between gap-2 flex-wrap">
                              <div className="flex items-center gap-2 min-w-0">
                                <Volume2 className="w-4 h-4 text-warning shrink-0" />
                                <div className="min-w-0">
                                  <div className="text-sm font-medium">
                                    {t("worldMapTab.gunshotLabel")}
                                  </div>
                                  <div className="text-[11px] text-muted-foreground">
                                    {t("worldMapTab.gunshotDesc")}
                                  </div>
                                </div>
                              </div>
                              <Button
                                variant={
                                  armedAction === "gunshot"
                                    ? "destructive"
                                    : "outline"
                                }
                                size="sm"
                                disabled={
                                  actionsDisabled || actionLoading === "gunshot"
                                }
                                onClick={() =>
                                  firstPlayerCoords &&
                                  armOrFire("gunshot", () =>
                                    runAction(
                                      "gunshot",
                                      () =>
                                        panelBridgeApi.triggerGunshotBridge({
                                          x: firstPlayerCoords.x,
                                          y: firstPlayerCoords.y,
                                        }),
                                      t("worldMapTab.gunshotTriggeredTitle"),
                                      t("worldMapTab.gunshotTriggeredDesc", {
                                        name: firstPlayerCoords.name,
                                      }),
                                    ),
                                  )
                                }
                              >
                                {actionLoading === "gunshot" ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                                ) : (
                                  <Volume2 className="w-3.5 h-3.5 mr-1.5" />
                                )}
                                {armedAction === "gunshot"
                                  ? t("worldMapTab.clickAgainToConfirm")
                                  : t("worldMapTab.trigger")}
                              </Button>
                            </div>

                            {/* Test lightning */}
                            <div className="p-2.5 rounded-md border bg-card flex items-center justify-between gap-2 flex-wrap">
                              <div className="flex items-center gap-2 min-w-0">
                                <Zap className="w-4 h-4 text-warning shrink-0" />
                                <div className="min-w-0">
                                  <div className="text-sm font-medium">
                                    {t("worldMapTab.lightningLabel")}
                                  </div>
                                  <div className="text-[11px] text-muted-foreground">
                                    {t("worldMapTab.lightningDesc")}
                                  </div>
                                </div>
                              </div>
                              <Button
                                variant={
                                  armedAction === "lightning"
                                    ? "destructive"
                                    : "outline"
                                }
                                size="sm"
                                disabled={
                                  actionsDisabled ||
                                  actionLoading === "lightning"
                                }
                                onClick={() =>
                                  firstPlayerCoords &&
                                  armOrFire("lightning", () =>
                                    runAction(
                                      "lightning",
                                      () =>
                                        panelBridgeApi.triggerLightning(
                                          firstPlayerCoords.x,
                                          firstPlayerCoords.y,
                                          true,
                                          true,
                                          true,
                                        ),
                                      t("worldMapTab.lightningTriggeredTitle"),
                                      t("worldMapTab.lightningTriggeredDesc", {
                                        x: firstPlayerCoords.x,
                                        y: firstPlayerCoords.y,
                                      }),
                                    ),
                                  )
                                }
                              >
                                {actionLoading === "lightning" ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                                ) : (
                                  <Zap className="w-3.5 h-3.5 mr-1.5" />
                                )}
                                {armedAction === "lightning"
                                  ? t("worldMapTab.clickAgainToConfirm")
                                  : t("worldMapTab.trigger")}
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      );
                    })()}

                    {/* Active save / build */}
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                          <FolderOpen className="w-4 h-4 text-primary" />
                          {t("worldMapTab.activeSaveTitle")}
                        </CardTitle>
                        <CardDescription>
                          {t("worldMapTab.activeSaveDesc")}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        {wm?.save ? (
                          <div className="space-y-2 text-sm">
                            <div className="flex items-center gap-2">
                              <span className="text-muted-foreground">
                                {t("worldMapTab.detectedBuildLabel")}
                              </span>
                              <Badge
                                variant={
                                  wm.save.build === "unknown"
                                    ? "outline"
                                    : "default"
                                }
                                className={cn(
                                  wm.save.build === "b42" &&
                                    "bg-primary/15 text-primary border-primary/30",
                                  wm.save.build === "b41" &&
                                    "bg-blue-500/15 text-blue-400 border-blue-500/30",
                                )}
                              >
                                {wm.save.build.toUpperCase()}
                              </Badge>
                              <span className="text-muted-foreground text-xs">
                                {t("worldMapTab.saveCount", { count: wm.save.saveCount })}
                              </span>
                            </div>
                            {wm.save.activeSaveName && (
                              <div className="text-xs">
                                <span className="text-muted-foreground">
                                  {t("worldMapTab.sampleSaveLabel")}
                                </span>{" "}
                                <code className="font-mono">
                                  {wm.save.activeSaveName}
                                </code>
                              </div>
                            )}
                            {wm.save.zomboidDataPath && (
                              <div className="text-xs">
                                <span className="text-muted-foreground">
                                  {t("worldMapTab.zomboidDataLabel")}
                                </span>{" "}
                                <CopyablePath
                                  label={t("worldMapTab.zomboidDataPathLabel")}
                                  value={wm.save.zomboidDataPath}
                                />
                              </div>
                            )}
                            {wm.save.activeSavePath && (
                              <div className="text-xs">
                                <span className="text-muted-foreground">
                                  {t("worldMapTab.savePathLabel")}
                                </span>{" "}
                                <CopyablePath
                                  label={t("worldMapTab.savePathCopyLabel")}
                                  value={wm.save.activeSavePath}
                                />
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="text-sm text-muted-foreground">
                            {t("worldMapTab.noSaveData")}
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    {/* Detailed checks */}
                    <Card>
                      <CardHeader className="pb-3">
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <CardTitle className="flex items-center gap-2 text-base">
                            <CheckCircle className="w-4 h-4 text-primary" />
                            {t("worldMapTab.checksTitle")}
                          </CardTitle>
                          {wm && wm.checks.length > 0 && (
                            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                              <Checkbox
                                checked={worldMapHideOk}
                                onCheckedChange={(v) =>
                                  setWorldMapHideOk(v === true)
                                }
                              />
                              {t("common.hidePassing")}
                            </label>
                          )}
                        </div>
                      </CardHeader>
                      <CardContent>
                        {!wm ? (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                            <Loader2 className="w-4 h-4 animate-spin" /> {t("worldMapTab.runningMapChecks")}
                          </div>
                        ) : wm.checks.length === 0 ? (
                          <div className="text-sm text-muted-foreground py-4">
                            {t("worldMapTab.noChecksRan")}
                          </div>
                        ) : visibleChecks.length === 0 ? (
                          <div className="flex items-center gap-2 text-sm text-primary py-4">
                            <CheckCircle className="w-4 h-4" /> {t("worldMapTab.allChecksPass")}
                          </div>
                        ) : (
                          <div className="space-y-1.5">
                            {visibleChecks.map((c) => {
                              const Icon =
                                c.status === "fail"
                                  ? AlertCircle
                                  : c.status === "warn"
                                    ? AlertTriangle
                                    : c.status === "ok"
                                      ? CheckCircle
                                      : c.status === "skip"
                                        ? Info
                                        : Info;
                              const tone =
                                c.status === "fail"
                                  ? "text-destructive"
                                  : c.status === "warn"
                                    ? "text-warning"
                                    : c.status === "ok"
                                      ? "text-primary"
                                      : "text-muted-foreground";
                              const translated = translateDiagnosticCheck(c);
                              return (
                                <div
                                  key={c.id}
                                  className="flex items-start gap-2 p-2 rounded hover:bg-muted/30 transition-colors"
                                >
                                  <Icon
                                    className={cn(
                                      "w-4 h-4 shrink-0 mt-0.5",
                                      tone,
                                    )}
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="text-sm font-medium">
                                      {translated.label}
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                      {translated.message}
                                    </div>
                                    {translated.hint && (
                                      <div className="text-xs mt-1 text-primary/80">
                                        <span className="font-semibold">
                                          {t("common.fixLabel")}
                                        </span>{" "}
                                        {translated.hint}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </>
                )}
              </>
            );
          })()}
        </TabsContent>

        {/* Activity Tab — Unified command/event timeline */}
        <TabsContent value="activity" className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Zap className="w-5 h-5 text-primary" />
                    {t("activityTab.title")}
                  </CardTitle>
                  <CardDescription>
                    {t("activityTab.description")}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Select
                    value={activitySource}
                    onValueChange={(v) => setActivitySource(v)}
                  >
                    <SelectTrigger
                      className="w-[130px] h-8"
                      aria-label={t("activityTab.filterBySourceAria")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">
                        {t("activityTab.allSources")}
                        {activityStats.total > 0
                          ? ` (${activityStats.total})`
                          : ""}
                      </SelectItem>
                      <SelectItem value="rcon">
                        {t("common.sourceRcon")}
                        {activityStats.rcon > 0
                          ? ` (${activityStats.rcon})`
                          : ""}
                      </SelectItem>
                      <SelectItem value="bridge">
                        {t("common.sourceBridge")}
                        {activityStats.bridge > 0
                          ? ` (${activityStats.bridge})`
                          : ""}
                      </SelectItem>
                      <SelectItem value="player">
                        {t("common.sourcePlayer")}
                        {activityStats.player > 0
                          ? ` (${activityStats.player})`
                          : ""}
                      </SelectItem>
                      <SelectItem value="server">
                        {t("common.sourceServer")}
                        {activityStats.server > 0
                          ? ` (${activityStats.server})`
                          : ""}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <Input
                      placeholder={t("activityTab.searchPlaceholder")}
                      value={activitySearch}
                      onChange={(e) => setActivitySearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          setActivitySearch("");
                          e.currentTarget.blur();
                        }
                      }}
                      className="w-[200px] h-8 pl-7 pr-7"
                      maxLength={200}
                      aria-label={t("activityTab.searchAria")}
                    />
                    {activitySearch && (
                      <button
                        type="button"
                        onClick={() => setActivitySearch("")}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                        aria-label={t("activityTab.clearSearchAria")}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={activityPaused ? "default" : "outline"}
                        size="sm"
                        onClick={() => setActivityPaused((p) => !p)}
                        className="gap-1.5"
                        aria-pressed={activityPaused}
                      >
                        {activityPaused ? (
                          <Play className="w-3.5 h-3.5" />
                        ) : (
                          <Pause className="w-3.5 h-3.5" />
                        )}
                        {activityPaused ? t("activityTab.resume") : t("activityTab.live")}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {activityPaused
                        ? t("activityTab.resumeTooltip")
                        : t("activityTab.pauseTooltip")}
                    </TooltipContent>
                  </Tooltip>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={fetchActivity}
                    disabled={refreshingActivity}
                    aria-label={t("activityTab.refreshNowAria")}
                  >
                    <RefreshCw
                      className={cn(
                        "w-4 h-4",
                        refreshingActivity && "animate-spin",
                      )}
                    />
                  </Button>
                </div>
              </div>

              {/* Stat row: counts + result filter pills + last-updated */}
              {activityEntries.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="secondary" className="gap-1">
                    <Activity className="w-3 h-3" />
                    {activitySearch || activityResultFilter !== "all"
                      ? t("activityTab.filteredEntriesCount", {
                          shown: filteredActivityEntries.length,
                          total: activityStats.total,
                        })
                      : t("activityTab.entriesCount", { count: activityStats.total })}
                  </Badge>
                  <button
                    type="button"
                    onClick={() => setActivityResultFilter("all")}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors",
                      activityResultFilter === "all"
                        ? "border-foreground/30 bg-muted text-foreground"
                        : "border-border/50 text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                    )}
                    aria-pressed={activityResultFilter === "all"}
                  >
                    {t("activityTab.allButton")}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setActivityResultFilter((r) =>
                        r === "success" ? "all" : "success",
                      )
                    }
                    disabled={activityStats.success === 0}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                      activityResultFilter === "success"
                        ? "border-success/50 bg-success/15 text-success"
                        : "border-border/50 text-muted-foreground hover:border-success/40 hover:text-success",
                    )}
                    aria-pressed={activityResultFilter === "success"}
                    title={t("activityTab.successButtonTitle")}
                  >
                    <CheckCircle className="w-3 h-3" />{" "}
                    {t("activityTab.successButton", { count: activityStats.success })}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setActivityResultFilter((r) =>
                        r === "failed" ? "all" : "failed",
                      )
                    }
                    disabled={activityStats.failed === 0}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                      activityResultFilter === "failed"
                        ? "border-destructive/50 bg-destructive/15 text-destructive"
                        : "border-border/50 text-muted-foreground hover:border-destructive/40 hover:text-destructive",
                    )}
                    aria-pressed={activityResultFilter === "failed"}
                    title={t("activityTab.failedButtonTitle")}
                  >
                    <AlertCircle className="w-3 h-3" />{" "}
                    {t("activityTab.failedButton", { count: activityStats.failed })}
                  </button>
                  {filteredActivityEntries.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-6 gap-1 px-2 text-xs"
                      onClick={() => {
                        const allExpanded = filteredActivityEntries.every((e) =>
                          expandedActivity.has(e.id),
                        );
                        if (allExpanded) {
                          setExpandedActivity(new Set());
                        } else {
                          setExpandedActivity(
                            new Set(filteredActivityEntries.map((e) => e.id)),
                          );
                        }
                      }}
                    >
                      {filteredActivityEntries.every((e) =>
                        expandedActivity.has(e.id),
                      ) ? (
                        <>
                          <ChevronDown className="w-3 h-3" /> {t("activityTab.collapseAll")}
                        </>
                      ) : (
                        <>
                          <ChevronRight className="w-3 h-3" /> {t("activityTab.expandAll")}
                        </>
                      )}
                    </Button>
                  )}
                  {activityLastLoaded && (
                    <span
                      className={cn(
                        "text-[11px]",
                        filteredActivityEntries.length > 0 ? "" : "ml-auto",
                        activityPaused
                          ? "text-warning"
                          : "text-muted-foreground/70",
                      )}
                    >
                      {activityPaused ? t("activityTab.pausedPrefix") : ""}
                      {t("activityTab.lastRefresh", {
                        time: activityLastLoaded.toLocaleTimeString(i18n.language),
                      })}
                    </span>
                  )}
                </div>
              )}
            </CardHeader>
            <CardContent>
              {activityEntries.length === 0 ? (
                <EmptyState
                  title={t("activityTab.noActivityTitle")}
                  description={t("activityTab.noActivityDesc")}
                  icon={<Zap className="w-6 h-6" />}
                />
              ) : filteredActivityEntries.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
                  <Search className="w-5 h-5 opacity-60" />
                  <p className="text-sm">
                    {t("activityTab.noMatchesDesc")}
                  </p>
                  <div className="flex gap-2">
                    {activitySearch && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setActivitySearch("")}
                        className="text-xs"
                      >
                        {t("activityTab.clearSearch")}
                      </Button>
                    )}
                    {activityResultFilter !== "all" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setActivityResultFilter("all")}
                        className="text-xs"
                      >
                        {t("activityTab.showAllResults")}
                      </Button>
                    )}
                  </div>
                </div>
              ) : (
                <ScrollArea className="h-[calc(100vh-440px)] min-h-[400px]">
                  <div className="space-y-1 font-mono text-xs">
                    {filteredActivityEntries.map((entry) => {
                      const isExpanded = expandedActivity.has(entry.id);
                      return (
                        <div
                          key={entry.id}
                          className={cn(
                            "group flex flex-col gap-0",
                            !entry.success && "bg-destructive/5 rounded",
                          )}
                        >
                          <div
                            className="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-muted/50 cursor-pointer"
                            onClick={() => {
                              setExpandedActivity((prev) => {
                                const next = new Set(prev);
                                if (next.has(entry.id)) next.delete(entry.id);
                                else next.add(entry.id);
                                return next;
                              });
                            }}
                          >
                            <span
                              className="text-muted-foreground shrink-0 w-[65px]"
                              title={new Date(entry.timestamp).toLocaleString(i18n.language)}
                            >
                              {new Date(entry.timestamp).toLocaleTimeString(i18n.language)}
                            </span>
                            <Badge
                              variant="outline"
                              className={cn(
                                "shrink-0 text-[10px] px-1.5 py-0 uppercase font-semibold",
                                entry.source === "rcon" &&
                                  "border-blue-500/50 text-blue-400",
                                entry.source === "bridge" &&
                                  "border-primary/50 text-primary",
                                entry.source === "player" &&
                                  "border-green-500/50 text-green-400",
                                entry.source === "server" &&
                                  "border-orange-500/50 text-orange-400",
                              )}
                            >
                              {getSourceLabel(entry.source)}
                            </Badge>
                            {entry.success ? (
                              <CheckCircle className="w-3.5 h-3.5 text-green-500 shrink-0 mt-0.5" />
                            ) : (
                              <AlertCircle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
                            )}
                            <span className="font-medium text-foreground shrink-0">
                              {entry.action}
                            </span>
                            {entry.duration_ms != null && (
                              <span
                                className={cn(
                                  "shrink-0",
                                  entry.duration_ms > 1000
                                    ? "text-warning"
                                    : "text-muted-foreground",
                                )}
                                title={
                                  entry.duration_ms > 1000
                                    ? t("activityTab.slowTitle")
                                    : undefined
                                }
                              >
                                {entry.duration_ms}ms
                              </span>
                            )}
                            <span
                              className="text-muted-foreground truncate flex-1"
                              title={entry.detail}
                            >
                              {entry.detail.length > 120
                                ? entry.detail.substring(0, 120) + "…"
                                : entry.detail}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                copyActivityEntry(entry);
                              }}
                              className="shrink-0 mt-0.5 text-muted-foreground/50 hover:text-foreground opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                              aria-label={t("activityTab.copyEntryAria")}
                              title={t("activityTab.copyEntryAria")}
                            >
                              <Copy className="w-3.5 h-3.5" />
                            </button>
                            {isExpanded ? (
                              <ChevronDown className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                            ) : (
                              <ChevronRight className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                            )}
                          </div>
                          {isExpanded && (
                            <div className="ml-[72px] px-3 py-2 bg-muted/30 rounded text-xs mb-1 break-all">
                              {entry.args &&
                                Object.keys(entry.args).length > 0 && (
                                  <div className="mb-1">
                                    <span className="text-muted-foreground">
                                      {t("activityTab.argsLabel")}
                                    </span>{" "}
                                    {JSON.stringify(entry.args)}
                                  </div>
                                )}
                              <div>
                                <span className="text-muted-foreground">
                                  {t("activityTab.detailLabel")}
                                </span>{" "}
                                {entry.detail}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Logs Tab */}
        <TabsContent value="logs" className="space-y-4">
          {/* Stats Bar — tactical filter chips */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
            {(() => {
              const tiles = [
                {
                  key: "all",
                  label: t("logsTab.statTotal"),
                  value: logStats.total,
                  tone: "muted",
                  Icon: Terminal,
                },
                {
                  key: "error",
                  label: t("logsTab.statErrors"),
                  value: logStats.errors,
                  tone: "destructive",
                  Icon: AlertCircle,
                },
                {
                  key: "warn",
                  label: t("logsTab.statWarnings"),
                  value: logStats.warnings,
                  tone: "warning",
                  Icon: AlertTriangle,
                },
                {
                  key: "info",
                  label: t("logsTab.statInfo"),
                  value: logStats.info,
                  tone: "primary",
                  Icon: Info,
                },
                {
                  key: "debug",
                  label: t("logsTab.statDebug"),
                  value: logStats.debug,
                  tone: "muted",
                  Icon: Bug,
                },
              ];
              const toneStyles: Record<
                string,
                { chip: string; value: string; ring: string; hover: string }
              > = {
                primary: {
                  chip: "border-primary/30 bg-primary/[0.06] text-primary",
                  value: "text-primary",
                  ring: "ring-primary/50",
                  hover: "hover:border-primary/30",
                },
                warning: {
                  chip: "border-warning/40 bg-warning/10 text-warning",
                  value: "text-warning",
                  ring: "ring-warning/50",
                  hover: "hover:border-warning/30",
                },
                destructive: {
                  chip: "border-destructive/40 bg-destructive/[0.08] text-destructive",
                  value: "text-destructive",
                  ring: "ring-destructive/50",
                  hover: "hover:border-destructive/30",
                },
                muted: {
                  chip: "border-border/55 bg-muted/30 text-muted-foreground",
                  value: "text-foreground",
                  ring: "ring-foreground/30",
                  hover: "hover:border-border",
                },
              };
              return tiles.map((tile) => {
                const s = toneStyles[tile.tone];
                const isActive = levelFilter === tile.key;
                return (
                  <Card
                    key={tile.key}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isActive}
                    aria-label={t("logsTab.filterAria", { label: tile.label })}
                    onClick={() => setLevelFilter(tile.key as typeof levelFilter)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setLevelFilter(tile.key as typeof levelFilter);
                      }
                    }}
                    className={cn(
                      "cursor-pointer transition-all border-border/60",
                      s.hover,
                      isActive && `ring-1 ${s.ring}`,
                    )}
                  >
                    <CardContent className="flex items-center gap-3 p-3.5">
                      <div
                        className={cn(
                          "grid h-10 w-10 shrink-0 place-items-center rounded-md border",
                          s.chip,
                        )}
                      >
                        <tile.Icon className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          {tile.label}
                        </p>
                        <p
                          className={cn(
                            "text-xl font-semibold leading-tight tabular-nums",
                            s.value,
                          )}
                        >
                          {tile.value.toLocaleString(i18n.language)}
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                );
              });
            })()}
          </div>

          {/* Logs Card */}
          <Card>
            <CardHeader className="pb-4">
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-y-2">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Terminal className="w-5 h-5" />
                      {t("logsTab.applicationLogsTitle")}
                      {paused && (
                        <Badge variant="secondary" className="ml-2">
                          {t("logsTab.pausedBadge")}
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription>
                      {t("logsTab.realtimeDescription", {
                        shown: filteredLogs.length,
                        total: logs.length,
                      })}
                      <span className="ml-2 text-xs">
                        {t("logsTab.keyboardHint")}
                      </span>
                    </CardDescription>
                  </div>

                  <div className="flex items-center gap-2">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant={paused ? "default" : "outline"}
                            size="sm"
                            onClick={() => setPaused(!paused)}
                          >
                            {paused ? (
                              <Play className="w-4 h-4" />
                            ) : (
                              <Pause className="w-4 h-4" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {paused ? t("logsTab.resumeLiveUpdates") : t("logsTab.pauseLiveUpdates")}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>

                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={fetchLogs}
                            disabled={refreshingLogs}
                          >
                            <RefreshCw
                              className={cn(
                                "w-4 h-4",
                                refreshingLogs && "animate-spin",
                              )}
                            />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("logsTab.refreshLogsTooltip")}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>

                    <Select
                      value="download"
                      onValueChange={(v) => {
                        if (v === "full-txt") downloadLogs("txt", false);
                        else if (v === "filtered-txt")
                          downloadLogs("txt", true);
                        else if (v === "filtered-json")
                          downloadLogs("json", true);
                      }}
                    >
                      <SelectTrigger className="w-full sm:w-[160px]">
                        <Download className="w-4 h-4 mr-2" />
                        {t("logsTab.exportTrigger")}
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="download" disabled>
                          {t("logsTab.exportPlaceholder")}
                        </SelectItem>
                        <SelectItem value="full-txt">
                          {t("logsTab.exportFullTxt")}
                        </SelectItem>
                        <SelectItem value="filtered-txt">
                          {t("logsTab.exportFilteredTxt")}
                        </SelectItem>
                        <SelectItem value="filtered-json">
                          {t("logsTab.exportFilteredJson")}
                        </SelectItem>
                      </SelectContent>
                    </Select>

                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={clearLogs}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("logsTab.clearDisplayTooltip")}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </div>

                {/* Filters Row */}
                <div className="flex flex-wrap items-center gap-3">
                  {/* Search */}
                  <div className="relative flex-1 min-w-0 w-full sm:max-w-md">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      ref={searchInputRef}
                      placeholder={t("logsTab.searchLogsPlaceholder")}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-9 pr-8"
                      aria-label={t("logsTab.searchLogsAria")}
                      maxLength={128}
                    />
                    {searchQuery && (
                      <button
                        onClick={() => setSearchQuery("")}
                        aria-label={t("logsTab.clearLogSearchAria")}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  {/* Level Filter */}
                  <Select
                    value={levelFilter}
                    onValueChange={(v) =>
                      setLevelFilter(v as typeof levelFilter)
                    }
                  >
                    <SelectTrigger className="w-full sm:w-[120px]">
                      <SelectValue placeholder={t("logsTab.levelPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t("logsTab.allLevels")}</SelectItem>
                      <SelectItem value="error">{t("logsTab.statErrors")}</SelectItem>
                      <SelectItem value="warn">{t("logsTab.statWarnings")}</SelectItem>
                      <SelectItem value="info">{t("logsTab.statInfo")}</SelectItem>
                      <SelectItem value="debug">{t("logsTab.statDebug")}</SelectItem>
                    </SelectContent>
                  </Select>

                  {/* Source Filter */}
                  <Select value={sourceFilter} onValueChange={setSourceFilter}>
                    <SelectTrigger className="w-full sm:w-[160px]">
                      <SelectValue placeholder={t("logsTab.sourcePlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t("activityTab.allSources")}</SelectItem>
                      {availableSources.map((source) => (
                        <SelectItem key={source} value={source}>
                          {source}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {/* Time Format */}
                  <Select
                    value={timeFormat}
                    onValueChange={(v) => setTimeFormat(v as TimeFormat)}
                  >
                    <SelectTrigger className="w-full sm:w-[140px]">
                      <Clock className="w-4 h-4 mr-2" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="time">{t("logsTab.timeOnly")}</SelectItem>
                      <SelectItem value="datetime">{t("logsTab.dateAndTime")}</SelectItem>
                      <SelectItem value="relative">{t("logsTab.relative")}</SelectItem>
                    </SelectContent>
                  </Select>

                  {/* Auto-scroll toggle */}
                  <div className="flex items-center gap-2">
                    <Switch
                      id="auto-scroll"
                      checked={autoScroll}
                      onCheckedChange={setAutoScroll}
                    />
                    <Label
                      htmlFor="auto-scroll"
                      className="text-sm cursor-pointer"
                    >
                      {t("logsTab.autoScroll")}
                    </Label>
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <ScrollArea
                ref={logsScrollAreaRef}
                className="h-[300px] sm:h-[500px] rounded-lg border border-border/50 bg-muted/20"
              >
                <div className="font-mono text-sm p-4">
                  {filteredLogs.length === 0 ? (
                    logs.length === 0 ? (
                      <EmptyState
                        compact
                        type="noData"
                        title={t("logsTab.noLogsTitle")}
                        description={t("logsTab.noLogsDesc")}
                      />
                    ) : (
                      <EmptyState
                        compact
                        type="noResults"
                        title={t("logsTab.noLogsMatchTitle")}
                        description={t("logsTab.noLogsMatchDesc")}
                      />
                    )
                  ) : (
                    filteredLogs.map((log) => {
                      const isLongMessage = log.message.length > 200;
                      const isExpanded = expandedLogs.has(log.id);
                      const displayMessage =
                        isLongMessage && !isExpanded
                          ? log.message.substring(0, 200) + "..."
                          : log.message;

                      return (
                        <div
                          key={log.id}
                          className="group flex cursor-pointer items-start gap-2 rounded px-2 py-1 hover:bg-muted/35"
                          onClick={() =>
                            isLongMessage && toggleLogExpanded(log.id)
                          }
                        >
                          {isLongMessage ? (
                            isExpanded ? (
                              <ChevronDown className="mt-0.5 w-4 h-4 shrink-0 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="mt-0.5 w-4 h-4 shrink-0 text-muted-foreground" />
                            )
                          ) : (
                            getLevelIcon(log.level)
                          )}
                          <span className="shrink-0 text-muted-foreground">
                            [{formatTimestamp(log.timestamp)}]
                          </span>
                          <Badge
                            variant="outline"
                            className={`text-xs shrink-0 ${getLevelColor(log.level)} border-current`}
                          >
                            {getLevelLabel(log.level).toUpperCase()}
                          </Badge>
                          {log.source && (
                            <Badge
                              variant="secondary"
                              className="text-xs shrink-0"
                            >
                              {log.source}
                            </Badge>
                          )}
                          <span
                            className={`${getLevelColor(log.level)} break-all`}
                          >
                            {displayMessage}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              copyLogEntry(log);
                            }}
                            className="ml-auto shrink-0 rounded p-1 opacity-0 transition-opacity hover:bg-muted/50 group-hover:opacity-100"
                          >
                            <Copy className="w-3 h-3 text-muted-foreground" />
                          </button>
                        </div>
                      );
                    })
                  )}
                  <div ref={logsEndRef} />
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Log Files */}
          {logFiles.length > 0 && (
            <Card className="relative overflow-hidden">
              <div
                className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-primary via-primary/70 to-primary/20"
                aria-hidden="true"
              />
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <FileText className="w-5 h-5 text-primary" />
                  {t("logsTab.logFilesTitle")}
                </CardTitle>
                <CardDescription>
                  {t("logsTab.logFilesDesc")}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Support bundle hero */}
                <div className="relative overflow-hidden rounded-lg border border-primary/35 bg-gradient-to-br from-primary/[0.09] via-primary/[0.04] to-transparent p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-start gap-3">
                      <div className="grid h-11 w-11 shrink-0 place-items-center rounded-md border border-primary/35 bg-primary/10 text-primary">
                        <Archive className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-primary">
                          {t("logsTab.recommendedEyebrow")}
                        </p>
                        <p className="mt-0.5 text-sm font-semibold text-foreground">
                          {t("logsTab.supportBundleTitle")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t("logsTab.supportBundleDesc")}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="command"
                      size="lg"
                      onClick={downloadLogArchive}
                      disabled={downloadingLogArchive}
                      className="gap-2 self-start sm:self-auto"
                    >
                      {downloadingLogArchive ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Download className="w-4 h-4" />
                      )}
                      {downloadingLogArchive ? t("headerActions.bundling") : t("logsTab.downloadZip")}
                    </Button>
                  </div>
                </div>

                {/* Individual files */}
                <div>
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t("logsTab.individualFiles")}{" "}
                    <span className="ml-1 font-mono tabular-nums normal-case tracking-normal text-muted-foreground/70">
                      · {logFiles.length}
                    </span>
                  </p>
                  <div className="space-y-1.5">
                    {logFiles.map((file) => (
                      <div
                        key={file.name}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border/55 bg-muted/30 p-3 transition-colors hover:border-primary/30 hover:bg-muted/50"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-border/55 bg-background/60 text-muted-foreground">
                            <FileText className="w-4 h-4" />
                          </div>
                          <div className="min-w-0">
                            <p className="truncate font-medium text-sm">
                              {file.name}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              <span className="font-mono tabular-nums">
                                {formatFileSize(file.size)}
                              </span>
                              <span className="mx-1.5 text-muted-foreground/50">
                                ·
                              </span>
                              {new Date(file.modified).toLocaleString(i18n.language)}
                            </p>
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => downloadLogFile(file.name)}
                          aria-label={t("logsTab.downloadFileAria", { name: file.name })}
                          className="gap-1.5 shrink-0"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">{t("logsTab.downloadButton")}</span>
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Crashes Tab */}
        <TabsContent value="crashes" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Crash Log List */}
            <Card className="lg:col-span-1">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <AlertCircle
                        className={cn(
                          "w-5 h-5",
                          crashLogs.length > 0
                            ? "text-destructive"
                            : "text-muted-foreground",
                        )}
                      />
                      {t("crashesTab.crashLogsTitle")}
                      {crashLogs.length > 0 && (
                        <Badge variant="destructive" className="ml-1">
                          {crashLogsTotalCount > crashLogs.length
                            ? t("crashesTab.crashLogsCountTruncated", {
                                shown: crashLogs.length,
                                total: crashLogsTotalCount,
                              })
                            : crashLogs.length}
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription>
                      {t("crashesTab.crashLogsDesc")}
                    </CardDescription>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={fetchCrashLogs}
                    disabled={refreshingCrashLogs}
                    aria-label={t("crashesTab.refreshCrashLogsAria")}
                  >
                    <RefreshCw
                      className={cn(
                        "w-4 h-4",
                        refreshingCrashLogs && "animate-spin",
                      )}
                    />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {crashLogs.length === 0 ? (
                  <EmptyState
                    compact
                    type="noData"
                    title={t("crashesTab.noCrashLogsTitle")}
                    description={t("crashesTab.noCrashLogsDesc")}
                  />
                ) : (
                  <ScrollArea className="h-[calc(100vh-360px)] min-h-[300px]">
                    <div className="space-y-2 pr-2">
                      {[...crashLogs]
                        .sort(
                          (a, b) =>
                            new Date(b.modified).getTime() -
                            new Date(a.modified).getTime(),
                        )
                        .map((log) => {
                          const ageMs =
                            Date.now() - new Date(log.modified).getTime();
                          const isRecent = ageMs < 24 * 60 * 60 * 1000;
                          return (
                            <button
                              type="button"
                              key={log.name}
                              className={cn(
                                "w-full text-left p-3 rounded-lg border transition-colors",
                                selectedCrashLog === log.name
                                  ? "bg-primary/10 border-primary"
                                  : "hover:bg-muted/50",
                              )}
                              onClick={() => loadCrashLogContent(log.name)}
                            >
                              <div className="flex items-center gap-2">
                                <p className="font-mono text-sm truncate flex-1">
                                  {log.name}
                                </p>
                                {isRecent && (
                                  <Badge
                                    variant="destructive"
                                    className="text-[10px] h-5 shrink-0"
                                  >
                                    {t("crashesTab.newBadge")}
                                  </Badge>
                                )}
                              </div>
                              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                                <span>{formatFileSize(log.size)}</span>
                                <span>•</span>
                                <span
                                  title={new Date(
                                    log.modified,
                                  ).toLocaleString(i18n.language)}
                                >
                                  {formatTimestamp(new Date(log.modified))}
                                </span>
                              </div>
                            </button>
                          );
                        })}
                    </div>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>

            {/* Crash Log Viewer */}
            <Card className="lg:col-span-2">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 min-w-0">
                    <FileText className="w-5 h-5 shrink-0" />
                    <span className="truncate">
                      {selectedCrashLog || t("crashesTab.viewerFallbackTitle")}
                    </span>
                  </CardTitle>
                  {selectedCrashLog && !loadingCrashLog && crashLogContent && (
                    <div className="flex items-center gap-1 shrink-0">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={async () => {
                              const ok = await copyText(crashLogContent);
                              toast({
                                title: ok ? t("common.copied") : t("common.copyFailed"),
                                description: ok
                                  ? t("crashesTab.copiedDesc", { name: selectedCrashLog })
                                  : t("crashesTab.couldNotAccessClipboard"),
                                variant: ok
                                  ? ("success" as const)
                                  : "destructive",
                              });
                            }}
                          >
                            <Copy className="w-4 h-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("crashesTab.copyContentsTooltip")}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const blob = new Blob([crashLogContent], {
                                type: "text/plain",
                              });
                              const url = window.URL.createObjectURL(blob);
                              const a = document.createElement("a");
                              a.href = url;
                              a.download = selectedCrashLog;
                              document.body.appendChild(a);
                              a.click();
                              a.remove();
                              window.setTimeout(
                                () => window.URL.revokeObjectURL(url),
                                1000,
                              );
                            }}
                          >
                            <Download className="w-4 h-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("crashesTab.downloadFileTooltip")}</TooltipContent>
                      </Tooltip>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {!selectedCrashLog ? (
                  <div className="h-[calc(100vh-360px)] min-h-[300px] flex items-center justify-center text-muted-foreground">
                    {t("crashesTab.selectToView")}
                  </div>
                ) : loadingCrashLog ? (
                  <div className="h-[calc(100vh-360px)] min-h-[300px] flex items-center justify-center">
                    <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <ScrollArea className="h-[calc(100vh-360px)] min-h-[300px]">
                    <pre className="text-xs font-mono whitespace-pre-wrap break-all p-2 bg-muted/30 rounded">
                      {crashLogContent}
                    </pre>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Performance Tab */}
        <TabsContent value="performance" className="space-y-4">
          {/* Toolbar */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Activity className="w-4 h-4" />
              {performanceStats.spanMs > 0 ? (
                <span>
                  {t("performanceTab.showingSnapshots", {
                    count: performanceHistory.length,
                    duration: formatUptime(Math.round(performanceStats.spanMs / 1000)),
                  })}
                </span>
              ) : (
                <span>
                  {t("performanceTab.recordedEvery60s")}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Select
                value={perfRange}
                onValueChange={(v) => setPerfRange(v as "1h" | "6h" | "24h")}
              >
                <SelectTrigger
                  className="w-[110px] h-8"
                  aria-label={t("performanceTab.timeRangeAria")}
                >
                  <Clock className="w-3.5 h-3.5 mr-1" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1h">{t("performanceTab.lastHour")}</SelectItem>
                  <SelectItem value="6h">{t("performanceTab.last6h")}</SelectItem>
                  <SelectItem value="24h">{t("performanceTab.last24h")}</SelectItem>
                </SelectContent>
              </Select>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={downloadPerformanceCsv}
                    disabled={performanceHistory.length === 0}
                  >
                    <Download className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("performanceTab.exportCsvTooltip")}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={fetchPerformanceHistory}
                    disabled={refreshingPerformance}
                    aria-label={t("common.refresh")}
                  >
                    <RefreshCw
                      className={cn(
                        "w-4 h-4",
                        refreshingPerformance && "animate-spin",
                      )}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("performanceTab.refreshNowTooltip")}</TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* Current Snapshot Cards */}
          {(() => {
            const latest =
              performanceHistory.length > 0
                ? performanceHistory[performanceHistory.length - 1]
                : null;
            const cpuTone =
              latest?.cpuLoad != null
                ? latest.cpuLoad >= 90
                  ? "destructive"
                  : latest.cpuLoad >= 75
                    ? "warning"
                    : null
                : null;
            const hostPct =
              latest?.hostMemUsedGB != null && latest.hostMemGB
                ? (latest.hostMemUsedGB / latest.hostMemGB) * 100
                : null;
            const hostTone =
              hostPct != null
                ? hostPct >= 90
                  ? "destructive"
                  : hostPct >= 75
                    ? "warning"
                    : null
                : null;
            const pzTone =
              latest?.pzMemMB != null
                ? latest.pzMemMB > 7600
                  ? "destructive"
                  : latest.pzMemMB > 6000
                    ? "warning"
                    : null
                : null;
            const fmtBool = (b: boolean) => (b ? t("common.running") : t("common.stopped"));
            return (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                <Card
                  className={cn(
                    hostTone === "destructive" && "border-destructive/50",
                    hostTone === "warning" && "border-warning/50",
                  )}
                >
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">
                      {t("performanceTab.hostRam")}
                    </p>
                    <p
                      className={cn(
                        "text-xl font-bold mt-1",
                        hostTone === "destructive" && "text-destructive",
                        hostTone === "warning" && "text-warning",
                      )}
                    >
                      {latest?.hostMemUsedGB != null
                        ? `${latest.hostMemUsedGB} / ${latest.hostMemGB} GB`
                        : t("common.notAvailable")}
                    </p>
                    {performanceStats.hostGB.avg != null && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {t("performanceTab.avgMaxGB", {
                          avg: performanceStats.hostGB.avg.toFixed(1),
                          max: performanceStats.hostGB.max!.toFixed(1),
                        })}
                      </p>
                    )}
                  </CardContent>
                </Card>
                <Card
                  className={cn(
                    cpuTone === "destructive" && "border-destructive/50",
                    cpuTone === "warning" && "border-warning/50",
                  )}
                >
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">
                      {t("performanceTab.hostCpu")}
                    </p>
                    <p
                      className={cn(
                        "text-xl font-bold mt-1",
                        cpuTone === "destructive" && "text-destructive",
                        cpuTone === "warning" && "text-warning",
                      )}
                    >
                      {latest?.cpuLoad != null ? `${latest.cpuLoad}%` : t("common.notAvailable")}
                    </p>
                    {performanceStats.cpu.avg != null && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {t("performanceTab.avgMaxPct", {
                          avg: performanceStats.cpu.avg.toFixed(1),
                          max: performanceStats.cpu.max!.toFixed(1),
                        })}
                      </p>
                    )}
                  </CardContent>
                </Card>
                <Card
                  className={cn(
                    pzTone === "destructive" && "border-destructive/50",
                    pzTone === "warning" && "border-warning/50",
                  )}
                >
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">
                      {t("performanceTab.pzServerRam")}
                    </p>
                    <p
                      className={cn(
                        "text-xl font-bold mt-1",
                        pzTone === "destructive" && "text-destructive",
                        pzTone === "warning" && "text-warning",
                      )}
                    >
                      {latest?.pzMemMB != null
                        ? `${(latest.pzMemMB / 1024).toFixed(1)} GB`
                        : t("common.notAvailable")}
                    </p>
                    {performanceStats.pzMB.avg != null && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {t("performanceTab.avgGB", {
                          avg: (performanceStats.pzMB.avg / 1024).toFixed(1),
                        })}
                      </p>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">
                      {t("performanceTab.pzPeak")}
                    </p>
                    <p className="text-xl font-bold mt-1">
                      {performanceStats.pzMB.max != null
                        ? `${(performanceStats.pzMB.max / 1024).toFixed(1)} GB`
                        : t("common.notAvailable")}
                    </p>
                    {performanceStats.pzMB.count > 0 && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {t("performanceTab.acrossSamples", { count: performanceStats.pzMB.count })}
                      </p>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">
                      {t("performanceTab.players")}
                    </p>
                    <p className="text-xl font-bold mt-1">
                      {latest?.playerCount ?? t("common.notAvailable")}
                    </p>
                    {performanceStats.players.max != null && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {t("performanceTab.peakAvg", {
                          peak: performanceStats.players.max,
                          avg: performanceStats.players.avg!.toFixed(1),
                        })}
                      </p>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">
                      {t("performanceTab.server")}
                    </p>
                    <p
                      className={cn(
                        "text-xl font-bold mt-1",
                        latest?.serverRunning
                          ? "text-success"
                          : "text-muted-foreground",
                      )}
                    >
                      {latest ? fmtBool(latest.serverRunning) : t("common.notAvailable")}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {t("performanceTab.sampleCount", { count: performanceHistory.length })}
                    </p>
                  </CardContent>
                </Card>
              </div>
            );
          })()}

          {/* Charts */}
          <Suspense
            fallback={
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {[0, 1].map((index) => (
                  <Card key={index}>
                    <CardHeader className="pb-3">
                      <div className="h-5 w-32 rounded bg-muted/60" />
                    </CardHeader>
                    <CardContent>
                      <div className="h-[250px] animate-pulse rounded-lg bg-muted/40" />
                    </CardContent>
                  </Card>
                ))}
              </div>
            }
          >
            {activeTab === "performance" && performanceHistory.length > 0 ? (
              <DebugPerformanceCharts performanceHistory={performanceHistory} />
            ) : null}
            {activeTab === "performance" && performanceHistory.length === 0 && (
              <EmptyState
                compact
                type="noData"
                title={t("performanceTab.collectingTitle")}
                description={t("performanceTab.collectingDesc")}
              />
            )}
          </Suspense>
        </TabsContent>

        {/* Health Tab */}
        <TabsContent value="health" className="space-y-4">
          {healthError && (
            <Card className="border-2 border-destructive/50 bg-destructive/5">
              <CardContent className="pt-6">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-6 h-6 text-destructive shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <h3 className="text-base font-semibold">
                      {t("healthTab.couldNotReachTitle")}
                    </h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      {t("worldMapTab.couldNotReachDesc", { error: healthError })}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={fetchHealthStatus}
                    disabled={refreshingHealth}
                  >
                    <RefreshCw
                      className={cn(
                        "w-4 h-4 mr-2",
                        refreshingHealth && "animate-spin",
                      )}
                    />
                    {t("worldMapTab.retry")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
          {healthError && !healthStatus ? null : (
          <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Overall Status */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2">
                  <Activity className="w-5 h-5" />
                  {t("healthTab.systemStatusTitle")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4">
                  <div
                    className={`w-16 h-16 rounded-full flex items-center justify-center ${
                      healthStatus?.status === "ok"
                        ? "bg-primary/10"
                        : "bg-destructive/10"
                    }`}
                  >
                    {healthStatus?.status === "ok" ? (
                      <CheckCircle className="w-8 h-8 text-primary" />
                    ) : (
                      <AlertCircle className="w-8 h-8 text-destructive" />
                    )}
                  </div>
                  <div>
                    <p className="text-2xl font-bold">
                      {healthStatus?.status === "ok"
                        ? t("healthTab.healthy")
                        : t("healthTab.issuesDetected")}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {healthStatus?.timestamp ? (
                        <span
                          title={new Date(
                            healthStatus.timestamp,
                          ).toLocaleString(i18n.language)}
                        >
                          {t("healthTab.lastChecked", {
                            time: formatTimestamp(new Date(healthStatus.timestamp)),
                          })}
                        </span>
                      ) : (
                        t("healthTab.neverChecked")
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground/70 mt-0.5">
                      {t("healthTab.autoRefreshes")}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Memory Usage */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2">
                  <Database className="w-5 h-5" />
                  {t("healthTab.memoryUsageTitle")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {healthStatus?.memory &&
                  (() => {
                    // heapTotal is just the currently-allocated V8 segment
                    // size, not a ceiling — it grows on demand, so
                    // heapUsed/heapTotal routinely sits at 80-95% under
                    // completely normal operation. The number that actually
                    // means something is heapUsed against heapLimit (the
                    // real V8 ceiling, what --max-old-space-size controls).
                    const heapLimit = healthStatus.memory.heapLimit;
                    const heapPct =
                      heapLimit && heapLimit > 0
                        ? (healthStatus.memory.heapUsed / heapLimit) * 100
                        : 0;
                    const tone =
                      heapPct >= 90
                        ? "destructive"
                        : heapPct >= 75
                          ? "warning"
                          : "primary";
                    return (
                      <>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">
                            {t("healthTab.heapUsed")}
                          </span>
                          <span className="font-mono">
                            {formatMemory(healthStatus.memory.heapUsed)}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">
                            {t("healthTab.heapAllocated")}
                          </span>
                          <span className="font-mono">
                            {formatMemory(healthStatus.memory.heapTotal)}
                          </span>
                        </div>
                        {heapLimit !== undefined && (
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">
                              {t("healthTab.heapLimit")}
                            </span>
                            <span className="font-mono">
                              {formatMemory(heapLimit)}
                            </span>
                          </div>
                        )}
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">{t("healthTab.rss")}</span>
                          <span className="font-mono">
                            {formatMemory(healthStatus.memory.rss)}
                          </span>
                        </div>
                        {heapLimit !== undefined && (
                          <>
                            <div className="flex justify-between text-xs">
                              <span className="text-muted-foreground">
                                {t("healthTab.heapUsageOfLimit")}
                              </span>
                              <span
                                className={cn(
                                  "font-mono",
                                  tone === "destructive" && "text-destructive",
                                  tone === "warning" && "text-warning",
                                )}
                              >
                                {heapPct.toFixed(1)}%
                              </span>
                            </div>
                            <div className="w-full bg-muted rounded-full h-2 mt-2 overflow-hidden">
                              <div
                                className={cn(
                                  "h-2 rounded-full transition-all",
                                  tone === "destructive" && "bg-destructive",
                                  tone === "warning" && "bg-warning",
                                  tone === "primary" && "bg-primary",
                                )}
                                style={{ width: `${Math.min(100, heapPct)}%` }}
                              />
                            </div>
                          </>
                        )}
                      </>
                    );
                  })()}
              </CardContent>
            </Card>
          </div>

          {/* Services Status */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Zap className="w-5 h-5" />
                  {t("healthTab.servicesTitle")}
                </CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={fetchHealthStatus}
                  disabled={refreshingHealth}
                >
                  <RefreshCw
                    className={cn(
                      "w-4 h-4 mr-2",
                      refreshingHealth && "animate-spin",
                    )}
                  />
                  {t("common.refresh")}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* RCON Service */}
                <div className="p-4 rounded-lg border bg-card">
                  <div className="flex items-center gap-3 mb-3">
                    {healthStatus?.services?.rcon?.connected ? (
                      <Wifi className="w-5 h-5 text-primary" />
                    ) : (
                      <WifiOff className="w-5 h-5 text-destructive" />
                    )}
                    <span className="font-medium">{t("healthTab.rconLabel")}</span>
                    <Badge
                      variant={
                        healthStatus?.services?.rcon?.connected
                          ? "default"
                          : "destructive"
                      }
                      className="ml-auto"
                    >
                      {healthStatus?.services?.rcon?.connected
                        ? t("common.connected")
                        : t("common.disconnected")}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t("healthTab.hostLabel", {
                      host: healthStatus?.services?.rcon?.host || t("healthTab.hostNotConfigured"),
                    })}
                  </p>
                </div>

                {/* Server Status */}
                <div className="p-4 rounded-lg border bg-card">
                  <div className="flex items-center gap-3 mb-3">
                    <Server
                      className={`w-5 h-5 ${healthStatus?.services?.server?.running ? "text-primary" : "text-muted-foreground"}`}
                    />
                    <span className="font-medium">{t("healthTab.gameServerLabel")}</span>
                    <Badge
                      variant={
                        healthStatus?.services?.server?.running
                          ? "default"
                          : "secondary"
                      }
                      className="ml-auto"
                    >
                      {healthStatus?.services?.server?.running
                        ? t("common.running")
                        : t("common.stopped")}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t("healthTab.gameServerDesc")}
                  </p>
                </div>

                {/* Mod Checker */}
                <div className="p-4 rounded-lg border bg-card">
                  <div className="flex items-center gap-3 mb-3">
                    <Settings
                      className={`w-5 h-5 ${healthStatus?.services?.modChecker?.running ? "text-primary" : "text-muted-foreground"}`}
                    />
                    <span className="font-medium">{t("healthTab.modCheckerLabel")}</span>
                    <Badge
                      variant={
                        healthStatus?.services?.modChecker?.running
                          ? "default"
                          : "secondary"
                      }
                      className="ml-auto"
                    >
                      {healthStatus?.services?.modChecker?.running
                        ? t("common.active")
                        : t("common.inactive")}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {healthStatus?.services?.modChecker?.interval
                      ? t("healthTab.intervalLabel", {
                          minutes: Math.floor((healthStatus.services?.modChecker?.interval || 0) / 60000),
                        })
                      : t("healthTab.intervalLabelNA")}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Uptime */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2">
                <Clock className="w-5 h-5" />
                {t("healthTab.uptimeTitle")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">
                {healthStatus ? formatUptime(healthStatus.uptime) : "-"}
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {healthStatus &&
                  t("healthTab.since", {
                    date: new Date(
                      Date.now() - healthStatus.uptime * 1000,
                    ).toLocaleString(i18n.language),
                  })}
                {!healthStatus && "-"}
              </p>
            </CardContent>
          </Card>
          </>
          )}
        </TabsContent>

        {/* System Tab */}
        <TabsContent value="system" className="space-y-4">
          {/* System Info Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">{t("systemTab.nodeJs")}</CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-bold">
                  {systemInfo?.nodeVersion || "-"}
                </span>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">{t("systemTab.platform")}</CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-bold">
                  {systemInfo?.platform || "-"}
                </span>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">{t("systemTab.uptime")}</CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-bold">
                  {systemInfo ? formatUptime(systemInfo.uptime) : "-"}
                </span>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">{t("systemTab.memory")}</CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-bold">
                  {systemInfo?.memoryUsage
                    ? formatMemory(systemInfo.memoryUsage.heapUsed)
                    : "-"}
                </span>
                <p className="text-xs text-muted-foreground mt-1">
                  {t("systemTab.ofHeap", {
                    total: systemInfo?.memoryUsage
                      ? formatMemory(systemInfo.memoryUsage.heapTotal)
                      : "-",
                  })}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* File Paths */}
          <Card>
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <FolderOpen className="w-4 h-4 text-warning" />
                    {t("systemTab.filePathsTitle")}
                  </CardTitle>
                  <CardDescription>
                    {t("systemTab.filePathsDesc")}
                  </CardDescription>
                </div>
                {!editingPaths && (
                  <Button variant="outline" size="sm" onClick={handleEditPaths}>
                    {t("systemTab.changePaths")}
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {editingPaths ? (
                <div className="space-y-4">
                  <div className="rounded-lg border border-warning/25 bg-warning/8 p-3 text-sm">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 w-4 h-4 shrink-0 text-warning" />
                      <div>
                        <p className="font-medium text-warning">
                          {t("systemTab.restartRequiredTitle")}
                        </p>
                        <p className="text-muted-foreground">
                          {t("systemTab.restartRequiredDesc")}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="dataDir">
                      {t("systemTab.dataDirLabel")}
                    </Label>
                    <Input
                      id="dataDir"
                      value={newDataDir}
                      onChange={(e) => setNewDataDir(e.target.value)}
                      placeholder="/opt/panel/data"
                      className="font-mono"
                      maxLength={260}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="logsDir">{t("systemTab.logsDirLabel")}</Label>
                    <Input
                      id="logsDir"
                      value={newLogsDir}
                      onChange={(e) => setNewLogsDir(e.target.value)}
                      placeholder="/opt/panel/logs"
                      className="font-mono"
                      maxLength={260}
                    />
                  </div>

                  <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                    <Checkbox
                      id="moveFiles"
                      checked={moveFiles}
                      onCheckedChange={(checked) =>
                        setMoveFiles(checked === true)
                      }
                    />
                    <div>
                      <Label htmlFor="moveFiles" className="cursor-pointer">
                        {t("systemTab.moveFilesLabel")}
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        {t("systemTab.moveFilesDesc")}
                      </p>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <Button
                      onClick={handleSavePaths}
                      disabled={savingPaths}
                      className="gap-2"
                    >
                      {savingPaths ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Save className="w-4 h-4" />
                      )}
                      {t("systemTab.savePaths")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setEditingPaths(false)}
                      disabled={savingPaths}
                    >
                      {t("systemTab.cancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3 font-mono text-sm">
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                    <span className="text-muted-foreground w-32 shrink-0">
                      {t("systemTab.databaseLabel")}
                    </span>
                    <span className="break-all flex-1">
                      {systemInfo?.dbPath || "-"}
                    </span>
                    {systemInfo?.dbPath && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 shrink-0"
                            aria-label={t("systemTab.copyDbPathAria")}
                            onClick={async () => {
                              const ok = await copyText(systemInfo.dbPath);
                              toast({
                                title: ok ? t("common.copied") : t("common.copyFailed"),
                                description: ok
                                  ? systemInfo.dbPath
                                  : t("crashesTab.couldNotAccessClipboard"),
                                variant: ok
                                  ? ("success" as const)
                                  : "destructive",
                              });
                            }}
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("systemTab.copyPathTooltip")}</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                    <span className="text-muted-foreground w-32 shrink-0">
                      {t("systemTab.logsFolderLabel")}
                    </span>
                    <span className="break-all flex-1">
                      {systemInfo?.logsPath || "-"}
                    </span>
                    {systemInfo?.logsPath && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 shrink-0"
                            aria-label={t("systemTab.copyLogsPathAria")}
                            onClick={async () => {
                              const ok = await copyText(systemInfo.logsPath);
                              toast({
                                title: ok ? t("common.copied") : t("common.copyFailed"),
                                description: ok
                                  ? systemInfo.logsPath
                                  : t("crashesTab.couldNotAccessClipboard"),
                                variant: ok
                                  ? ("success" as const)
                                  : "destructive",
                              });
                            }}
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("systemTab.copyPathTooltip")}</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      )}
    </div>
  );
}

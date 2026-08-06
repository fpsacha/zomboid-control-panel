import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
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
import { SocketContext } from "@/contexts/SocketContext";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { cn, copyText } from "@/lib/utils";
import {
  apiFetch,
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

const dt = (key: string, options?: Record<string, unknown>) =>
  i18n.t(`static.${key}`, { ns: 'debug', ...options });

type DiagnosticsFixAction = {
  label: string;
  automated: boolean;
  /** When true, ask the user before applying (used for bulk destructive operations). */
  requiresConfirm?: boolean;
  /** Confirmation text shown in the native confirm dialog. */
  confirmMessage?: string;
  openServerConfig?: boolean;
  openMods?: boolean;
  /** Extra navigation buttons rendered next to the primary action. */
  links?: Array<{ to: string; label: string }>;
  note?: string;
};

function getDiagMetaStringList(check: DiagCheck, key: string): string[] {
  const raw = check.meta?.[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is string =>
      typeof item === "string" && item.trim().length > 0,
  );
}

function getDiagnosticsFixAction(
  check: DiagCheck,
): DiagnosticsFixAction | null {
  // Never show a fix button for passing or skipped checks.
  if (check.status === "ok" || check.status === "skip") return null;

  switch (check.id) {
    case "mods.numericInMods": {
      const count = getDiagMetaStringList(check, "numericInMods").length;
      return {
        label:
          count > 0
            ? dt('fix.stripNumericCount', { count })
            : dt('fix.stripNumeric'),
        automated: true,
        requiresConfirm: count > 10,
        confirmMessage: dt('fix.stripNumericConfirm', { count }),
        openServerConfig: true,
        note:
          count > 0
            ? dt('fix.stripNumericNoteCount', { count })
            : dt('fix.stripNumericNote'),
      };
    }
    case "mods.resolved": {
      // INTENTIONALLY manual: bulk-disabling unresolved Mods= entries is
      // destructive. The most common cause is "Workshop downloads still
      // pending" or "Mods= / WorkshopItems= drift" — not typos. Running
      // the orphanWorkshop fix first usually resolves many of these.
      const count = getDiagMetaStringList(check, "unresolvedMods").length;
      return {
        label: count > 0 ? dt('fix.reviewUnresolvedCount', { count }) : dt('fix.reviewUnresolved'),
        automated: false,
        openServerConfig: true,
        openMods: true,
        note: dt('fix.reviewUnresolvedNote'),
      };
    }
    case "mods.orphanWorkshop": {
      const count = getDiagMetaStringList(check, "orphanWorkshop").length;
      return {
        label:
          count > 0
            ? dt('fix.autoFixWorkshopCount', { count })
            : dt('fix.autoFixWorkshop'),
        automated: true,
        requiresConfirm: count > 10,
        confirmMessage: dt('fix.autoFixWorkshopConfirm', { count }),
        openServerConfig: true,
        openMods: true,
        note:
          count > 0
            ? dt('fix.autoFixWorkshopNoteCount', { count })
            : dt('fix.autoFixWorkshopNote'),
      };
    }
    case "mods.maps":
      return {
        label: dt('fix.repairMap'),
        automated: true,
        openServerConfig: true,
        note: dt('fix.repairMapNote'),
      };
    case "mods.duplicates": {
      const dupCount =
        getDiagMetaStringList(check, "dupMods").length +
        getDiagMetaStringList(check, "dupWs").length;
      return {
        label: dupCount > 0 ? dt('fix.deduplicateCount', { count: dupCount }) : dt('fix.deduplicate'),
        automated: true,
        openServerConfig: true,
        note: dt('fix.deduplicateNote'),
      };
    }
    case "mods.workshopCrash":
      return {
        label: dt('fix.openMods'),
        automated: false,
        openMods: true,
        note: dt('fix.openModsNote'),
      };

    // ─── Server / process ──────────────────────────────────────────────────
    case "server.process":
      return {
        label: dt('fix.startServer'),
        automated: true,
        links: [{ to: "/", label: dt('fix.openDashboard') }],
        note: dt('fix.startServerNote'),
      };
    case "server.active":
    case "server.installPath":
      return {
        label: dt('fix.openServers'),
        automated: false,
        links: [
          { to: "/servers", label: dt('fix.openServers') },
          { to: "/server-finder", label: dt('fix.autoDetect') },
        ],
        note: dt('fix.activeServerNote'),
      };
    case "server.zomboidData":
      return {
        label: dt('fix.openSettings'),
        automated: false,
        links: [{ to: "/settings", label: dt('fix.openSettings') }],
        note: dt('fix.zomboidDataNote'),
      };
    case "server.startScript":
    case "server.jre":
    case "server.jreWorks":
      return {
        label: dt('fix.openServerFinder'),
        automated: false,
        links: [{ to: "/server-finder", label: dt('fix.openServerFinder') }],
        note: dt('fix.serverFinderNote'),
      };
    case "server.ini":
    case "server.sandboxVars":
      return {
        label: dt('fix.openServerConfig'),
        automated: false,
        openServerConfig: true,
        note: dt('fix.serverConfigNote'),
      };
    case "server.sandboxCorrupt":
      return {
        label: dt('fix.repairSandbox'),
        automated: true,
        note: dt('fix.repairSandboxNote'),
      };
    case "server.rconPassword":
      return {
        label: dt('fix.openServerConfig'),
        automated: false,
        openServerConfig: true,
        links: [{ to: "/settings", label: dt('fix.openSettings') }],
        note: dt('fix.rconPasswordNote'),
      };
    case "server.bridgeMod":
      return {
        label: dt('fix.openServerFinder'),
        automated: false,
        links: [{ to: "/server-finder", label: dt('fix.openServerFinder') }],
        note: dt('fix.bridgeModNote'),
      };
    case "server.configDrift":
      return {
        label: dt('fix.openServerConfig'),
        automated: false,
        openServerConfig: true,
        note: dt('fix.configDriftNote'),
      };
    case "server.staleLocks":
      return {
        label: dt('fix.deleteStaleLocks'),
        automated: true,
        requiresConfirm: true,
        confirmMessage:
          dt('fix.deleteStaleLocksConfirm'),
        links: [{ to: "/chunks", label: dt('fix.openChunkCleaner') }],
        note: dt('fix.deleteStaleLocksNote'),
      };
    case "server.recentCrash":
      return {
        label: dt('fix.viewCrashLogs'),
        automated: true,
        note: dt('fix.viewCrashLogsNote'),
      };

    // ─── Services ──────────────────────────────────────────────────────────
    case "rcon.connected":
      return {
        label: dt('fix.reconnectRcon'),
        automated: true,
        openServerConfig: true,
        links: [{ to: "/settings", label: dt('fix.openSettings') }],
        note: dt('fix.reconnectRconNote'),
      };
    case "modChecker":
    case "scheduler":
    case "services.error":
      return {
        label: dt('fix.openSettings'),
        automated: false,
        links: [{ to: "/settings", label: dt('fix.openSettings') }],
        note: dt('fix.servicesNote'),
      };
    case "discord.bot":
      return {
        label: dt('fix.openDiscord'),
        automated: false,
        links: [{ to: "/discord", label: dt('fix.openDiscord') }],
        note: dt('fix.discordNote'),
      };

    // ─── Bridge ────────────────────────────────────────────────────────────
    case "bridge.writable":
    case "bridge.heartbeat":
      return {
        label: dt('fix.openServerFinder'),
        automated: false,
        links: [{ to: "/server-finder", label: dt('fix.openServerFinder') }],
        note: dt('fix.bridgeNote'),
      };

    // ─── Database / storage ────────────────────────────────────────────────
    case "db.exists":
    case "db.writable":
      return {
        label: dt('fix.openSettings'),
        automated: false,
        links: [{ to: "/settings", label: dt('fix.openSettings') }],
        note: dt('fix.databaseNote'),
      };
    case "db.backup":
      return {
        label: dt('fix.createDatabaseBackup'),
        automated: true,
        links: [{ to: "/backups", label: dt('fix.openBackups') }],
        note: dt('fix.createDatabaseBackupNote'),
      };
    case "logs.writable":
      return {
        label: dt('fix.openSettings'),
        automated: false,
        links: [{ to: "/settings", label: dt('fix.openSettings') }],
        note: dt('fix.logsNote'),
      };
    case "disk.free":
      return {
        label: dt('fix.openBackups'),
        automated: false,
        links: [
          { to: "/backups", label: dt('fix.openBackups') },
          { to: "/chunks", label: dt('fix.openChunkCleaner') },
        ],
        note: dt('fix.diskNote'),
      };
    case "storage.saveSize":
      return {
        label: dt('fix.openChunkCleaner'),
        automated: false,
        links: [{ to: "/chunks", label: dt('fix.openChunkCleaner') }],
        note: dt('fix.storageNote'),
      };

    // ─── Runtime ───────────────────────────────────────────────────────────
    case "runtime.heap":
    case "runtime.hostMem":
      return {
        label: dt('fix.openSettings'),
        automated: false,
        links: [{ to: "/settings", label: dt('fix.openSettings') }],
        note: dt('fix.runtimeNote'),
      };
    case "runtime.timeSkew":
      return {
        label: dt('fix.recommended'),
        automated: false,
        note: dt('fix.timeSkewNote'),
      };

    // ─── Updates ───────────────────────────────────────────────────────────
    case "update.panel":
    case "updates.error":
      return {
        label: dt('fix.openSettings'),
        automated: false,
        links: [{ to: "/settings", label: dt('fix.openSettings') }],
        note: dt('fix.panelUpdatesNote'),
      };
    case "update.mods":
      return {
        label: dt('fix.openMods'),
        automated: false,
        openMods: true,
        note: dt('fix.modUpdatesNote'),
      };
    case "update.steamApi":
      return {
        label: dt('fix.recommended'),
        automated: false,
        note: dt('fix.steamApiNote'),
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
        links.push({ to: "/world-map", label: dt('fix.openWorldMap') });
      }
      return {
        label: dt('fix.recommended'),
        automated: false,
        openServerConfig:
          hint.includes("server config") || hint.includes("server.ini"),
        openMods: category === "mods" || hint.includes("mods="),
        links: links.length > 0 ? links : undefined,
        note: check.hint || "Manual fix \u2014 see hint above.",
      };
    }
  }
}

const DebugPerformanceCharts = lazy(
  () => import("@/components/DebugPerformanceCharts"),
);

export default function Debug() {
  const { t } = useTranslation('debug');
  
  
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
  const [selectedCrashLog, setSelectedCrashLog] = useState<string | null>(null);
  const [crashLogContent, setCrashLogContent] = useState<string>("");
  const [loadingCrashLog, setLoadingCrashLog] = useState(false);
  const [refreshingLogs, setRefreshingLogs] = useState(false);
  const [refreshingCrashLogs, setRefreshingCrashLogs] = useState(false);
  const [refreshingHealth, setRefreshingHealth] = useState(false);
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
  const [diagnosticsHideOk, setDiagnosticsHideOk] = useState(false);
  const [fixingDiagnosticsCheckId, setFixingDiagnosticsCheckId] = useState<
    string | null
  >(null);
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
  const logsEndRef = useRef<HTMLDivElement>(null);
  const logsScrollAreaRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const confirm = useConfirm();
  const socket = useContext(SocketContext);

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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data?.services) {
        setHealthStatus(data);
      } else {
        setHealthStatus(null);
      }
    } catch (error) {
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data?.checks) setDiagnostics(data);
    } catch (error) {
      reportClientError("Failed to fetch diagnostics.", error);
    } finally {
      setRefreshingDiagnostics(false);
    }
  }, [authFetch]);

  const handleDiagnosticsFix = useCallback(
    async (check: DiagCheck) => {
      const action = getDiagnosticsFixAction(check);
      if (!action) return;

      setFixingDiagnosticsCheckId(check.id);
      try {
        if (!action.automated) {
          toast({
            title: dt('fix.manualFixRecommended'),
            description:
              action.note ||
              check.hint ||
              dt('fix.openSuggestedFix'),
          });
          return;
        }

        if (action.requiresConfirm) {
          const message = action.confirmMessage || dt('fix.applyAction', { action: action.label });
          const ok = await confirm({
            title: dt('fix.applyFixQuestion'),
            description: message,
            confirmLabel: dt('fix.apply'),
          });
          if (!ok) {
            return;
          }
        }

        const restartHint = ` ${dt('fix.restartHint')}`;

        if (check.id === "mods.numericInMods") {
          const numericIds = getDiagMetaStringList(check, "numericInMods");
          if (numericIds.length === 0) {
            throw new Error(
              dt('fix.noNumericEntries'),
            );
          }
          const result = await modsApi.batchToggleModIds(
            numericIds.map((modId) => ({ modId, enabled: false })),
          );
          toast({
            title: dt('fix.numericIdsRemoved'),
            description: dt('fix.numericIdsRemovedDesc', { count: result.changed, restartHint }),
          });
        } else if (check.id === "mods.orphanWorkshop") {
          const orphanWorkshop = getDiagMetaStringList(check, "orphanWorkshop");
          if (orphanWorkshop.length === 0) {
            throw new Error(
              dt('fix.noOrphanIds'),
            );
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
              dt('fix.enabledMods', { count: counts.enabled, added: modIdsAdded }),
            );
          if (droppedTotal > 0) {
            const sub: string[] = [];
            if (counts.droppedIgnored)
              sub.push(dt('fix.ignoredCount', { count: counts.droppedIgnored }));
            if (counts.droppedMissing)
              sub.push(dt('fix.notOnDiskCount', { count: counts.droppedMissing }));
            if (counts.droppedNoModInfo)
              sub.push(dt('fix.noModInfoCount', { count: counts.droppedNoModInfo }));
            parts.push(
              dt('fix.droppedWorkshopItems', { count: droppedTotal, details: sub.join(', ') }),
            );
          }
          toast({
            title: dt('fix.workshopItemsResolved'),
            description:
              parts.length > 0
                ? `${parts.join("; ")}.${counts.enabled > 0 ? restartHint : ""}`
                : dt('fix.nothingToChange', { count: result.total }),
          });
          void wsDropped; // count already reflected in droppedTotal
        } else if (check.id === "mods.maps") {
          const result = await modsApi.repairMapEntries();
          toast({
            title: dt('fix.mapEntriesRepaired'),
            description: `${result.message}${restartHint}`,
          });
        } else if (check.id === "mods.duplicates") {
          const result = await modsApi.deduplicateModIds();
          toast({
            title: dt('fix.duplicatesCleaned'),
            description: `${result.message}${restartHint}`,
          });
        } else if (check.id === "server.process") {
          const result = (await serverApi.start()) as {
            success?: boolean;
            message?: string;
            error?: string;
          };
          if (result?.success === false) {
            throw new Error(
              result.error || result.message || dt('fix.serverStartFailed'),
            );
          }
          toast({
            title: dt('fix.serverStarting'),
            description:
              result?.message ||
              dt('fix.serverStartSent'),
          });
        } else if (check.id === "rcon.connected") {
          const result = (await rconApi.connect()) as {
            success?: boolean;
            connected?: boolean;
            message?: string;
            error?: string;
          };
          const connected =
            result?.connected === true || result?.success === true;
          if (!connected) {
            throw new Error(
              result?.error ||
                result?.message ||
                dt('fix.rconConnectFailed'),
            );
          }
          toast({
            title: dt('fix.rconReconnected'),
            description: result?.message || dt('fix.rconReconnectedDesc'),
          });
        } else if (check.id === "db.backup") {
          const result = await backupApi.createBackup({ includeDb: true });
          if (result?.success === false) {
            throw new Error(result?.message || dt('fix.backupFailed'));
          }
          const backupName = result?.backup?.name
            ? ` (${result.backup.name})`
            : "";
          toast({
            title: dt('fix.databaseBackupCreated'),
            description: dt('fix.databaseBackupCreatedDesc', { backupName }),
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
          } | null;
          if (!res.ok || data?.success === false) {
            throw new Error(
              data?.error || data?.message || `HTTP ${res.status}`,
            );
          }
          toast({
            title: dt('fix.staleLocksRemoved'),
            description: data?.message || dt('fix.staleLocksRemovedDesc', { count: data?.deleted ?? 0 }),
          });
        } else if (check.id === "server.recentCrash") {
          setActiveTab("crashes");
          toast({
            title: dt('fix.crashLogsOpened'),
            description: dt('fix.crashLogsOpenedDesc'),
          });
        } else if (check.id === "server.sandboxCorrupt") {
          const result = await serverFilesApi.repairSandbox();
          if (!result?.success) {
            throw new Error(result?.error || dt('fix.repairFailed'));
          }
          if (result.alreadyValid) {
            toast({
              title: dt('fix.alreadyValid'),
              description: result.message || dt('fix.noRepairNeeded'),
            });
          } else {
            toast({
              title: dt('fix.sandboxRepaired'),
              description:
                result.message ||
                dt('fix.sandboxRepairedDesc', { count: result.changes?.length ?? 0, restartHint }),
            });
          }
        }

        await fetchDiagnostics();
      } catch (error) {
        reportClientError("Diagnostics auto-fix failed.", error);
        const message =
          error instanceof Error ? error.message : dt('fix.couldNotApplyFix');
        toast({
          title: dt('fix.fixFailed'),
          description: message,
          variant: "destructive",
        });
      } finally {
        setFixingDiagnosticsCheckId(null);
      }
    },
    [fetchDiagnostics, toast, authFetch, confirm],
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data?.checks) {
        setWorldMapDiag(data);
      } else {
        setWorldMapError(t('static.ui.unexpectedDiagnosticsResponse'));
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : t('static.ui.networkError');
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
        const res = r as {
          success?: boolean;
          error?: string;
          message?: string;
        };
        if (res && res.success === false) {
          const msg =
            res.error || res.message || t('static.ui.bridgeReturnedFailure');
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
        const msg = error instanceof Error ? error.message : t('static.ui.requestFailed');
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
        const msg = error instanceof Error ? error.message : dt('ui.actionFailed');
        toast({
          title: dt('ui.actionFailed'),
          description: msg,
          variant: "destructive",
        });
      } finally {
        setActionLoading(null);
      }
    },
    [toast],
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
    setRefreshingPerformance(true);
    try {
      const limit = perfRange === "24h" ? 1440 : perfRange === "6h" ? 360 : 60;
      const res = await authFetch(
        `/api/debug/performance-history?limit=${limit}`,
      );
      if (!res.ok) return;
      const data = await res.json();
      if (data.history) {
        setPerformanceHistory(
          data.history.map((h: PerformanceSnapshot) => ({
            ...h,
            memoryMB: Math.round(h.memoryUsed / (1024 * 1024)),
            cpuLoad: h.cpuUsage,
            time: new Date(h.timestamp).toLocaleTimeString(),
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
      setRefreshingPerformance(false);
    }
  }, [authFetch, perfRange]);

  const fetchCrashLogs = async () => {
    setRefreshingCrashLogs(true);
    try {
      const res = await authFetch("/api/debug/crash-logs");
      if (!res.ok) return;
      const data = await res.json();
      if (data.crashLogs) {
        setCrashLogs(data.crashLogs);
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.content !== undefined && data.content !== null) {
        setCrashLogContent(data.content || t('static.ui.emptyFile'));
      } else {
        setCrashLogContent(t('static.ui.crashContentLoadFailed'));
      }
    } catch {
      setCrashLogContent(t('static.ui.crashContentLoadFailed'));
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
    } finally {
      setRefreshingLogs(false);
    }
  };

  // Fetch activity log
  const fetchActivity = useCallback(async () => {
    setRefreshingActivity(true);
    try {
      const res = await authFetch(
        `/api/debug/activity?limit=200&source=${activitySource}`,
      );
      if (!res.ok) return;
      const data = await res.json();
      if (data.entries) {
        setActivityEntries(data.entries);
        setActivityLastLoaded(new Date());
      }
    } catch {
      // Endpoint may not exist yet
    } finally {
      setRefreshingActivity(false);
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
      title: "Logs Cleared",
      description: "Display cleared. Server logs remain on disk.",
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
          title: t('static.ui.exported'),
          description: t('static.ui.logsExported', {
            count: filteredLogs.length,
            format: format.toUpperCase(),
          }),
        });
      } else {
        // Download full log file from server
        const res = await authFetch("/api/debug/logs/download");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `pz-manager-logs-${new Date().toISOString().split("T")[0]}.txt`;
        a.click();
      }
    } catch (error) {
      toast({
        title: t('static.ui.error'),
        description: t('static.ui.downloadLogsFailed'),
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
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

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
          title: t('static.ui.error'),
          description: t('static.ui.downloadFileFailed', { name: filename }),
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
      const res = await authFetch("/api/debug/logs/download-zip");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

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
        title: t('static.ui.error'),
        description: t('static.ui.downloadArchiveFailed'),
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
      title: t('static.ui.copied'),
      description: t('static.ui.logEntryCopied'),
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
          if (diff < 1000) return t('static.ui.justNow');
          if (diff < 60000)
            return t('static.ui.secondsAgo', {
              count: Math.floor(diff / 1000),
            });
          if (diff < 3600000)
            return t('static.ui.minutesAgo', {
              count: Math.floor(diff / 60000),
            });
          if (diff < 86400000)
            return t('static.ui.hoursAgo', {
              count: Math.floor(diff / 3600000),
            });
          return t('static.ui.daysAgo', {
            count: Math.floor(diff / 86400000),
          });
        }
        case "time":
          return date.toLocaleTimeString();
        case "datetime":
          return date.toLocaleString();
        default:
          return date.toLocaleTimeString();
      }
    },
    [timeFormat, t],
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
        title: t('static.ui.error'),
        description: t('static.ui.enterPath'),
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
          title: t('static.ui.pathsUpdated'),
          description: data.message,
          variant: "success" as const,
        });
        setEditingPaths(false);
        fetchSystemInfo();
      } else {
        toast({
          title: t('static.ui.error'),
          description: data.error || t('static.ui.updatePathsFailed'),
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: t('static.ui.error'),
        description:
          error instanceof Error ? error.message : t('static.ui.updatePathsFailed'),
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
        title: ok ? t('static.ui.copied') : t('static.ui.copyFailed'),
        description: ok
          ? t('static.ui.activityEntryCopied')
          : t('static.ui.activityCopyFailed'),
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
      title: t('static.ui.exported'),
      description: t('static.ui.snapshotsExported', {
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
        title={t("title")}
        description={t("description")}
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
              {downloadingLogArchive ? t('static.ui.bundling') : t('static.ui.supportBundle')}
            </Button>
            <Button
              variant="outline"
              size="lg"
              onClick={() => downloadLogs("txt", false)}
              className="gap-2"
            >
              <FileDown className="w-4 h-4" />
              {t('static.ui.fullLog')}
            </Button>
          </div>
        }
      />

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
            {t('static.ui.diagnostics')}
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
            {t('static.ui.worldMap')}
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
            {t('static.ui.performance')}
          </TabsTrigger>

          {/* Zone divider: Now → History */}
          <span
            aria-hidden
            className="mx-1 h-5 w-px self-center bg-border/60"
          />

          {/* Zone: History */}
          <TabsTrigger value="activity" className="gap-2">
            <Zap className="w-4 h-4" />
            {t('static.ui.activity')}
          </TabsTrigger>
          <TabsTrigger value="logs" className="gap-2">
            <Terminal className="w-4 h-4" />
            {t('static.ui.logs')}
          </TabsTrigger>
          <TabsTrigger value="crashes" className="gap-2">
            <AlertCircle className="w-4 h-4" />
            {t('static.ui.crashes')}
            {crashLogs.length > 0 && (
              <Badge variant="outline" className="ml-1 h-5 px-1.5 text-[10px]">
                {crashLogs.length}
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
            {t('static.ui.health')}
          </TabsTrigger>
          <TabsTrigger value="system" className="gap-2">
            <Database className="w-4 h-4" />
            {t('static.ui.environment')}
          </TabsTrigger>
        </TabsList>

        {/* Diagnostics Tab — Smart health checks with green/amber/red */}
        <TabsContent value="diagnostics" className="space-y-4">
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
                ? t('static.ui.issuesNeedAttention')
                : overall === "warn"
                  ? t('static.ui.minorWarnings')
                  : overall === "ok"
                    ? t('static.ui.allSystemsOperational')
                    : t('static.ui.runningChecks');
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
                            <>
                              {t('static.ui.lastChecked')} {" "}
                              {formatTimestamp(new Date(diagnostics.timestamp))}{" "}
                              · {diagnostics.durationMs}ms · {t('static.ui.autoRefreshes')}
                            </>
                          ) : (
                            t('static.ui.smartChecksRunning')
                          )}
                        </CardDescription>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
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
                              {summary.skip} {t('static.ui.skipped')}
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
                          {t('static.ui.hidePassing')}
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
                          {t('static.ui.rerun')}
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
                <Loader2 className="w-4 h-4 animate-spin" /> {t('static.ui.runningDiagnostics')}
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
                          {t('static.ui.checksCount', { count: items.length })}
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
                          const fixAction = getDiagnosticsFixAction(check);
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
                                    {check.label}
                                  </span>
                                  {check.status === "skip" && (
                                    <Badge
                                      variant="outline"
                                      className="h-4 px-1 text-[10px] text-muted-foreground"
                                    >
                                      {t('static.ui.skipped')}
                                    </Badge>
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground mt-0.5 break-words">
                                  {check.message}
                                </p>
                                {check.hint && (
                                  <p className="text-xs mt-1 text-foreground/70">
                                    <span className="font-medium text-foreground/90">
                                      {t('static.ui.fix')}
                                    </span>{" "}
                                    {check.hint}
                                  </p>
                                )}
                                {fixAction && (
                                  <div className="mt-2 flex items-center gap-1.5 flex-wrap">
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
                                        !!fixingDiagnosticsCheckId &&
                                        fixingDiagnosticsCheckId !== check.id
                                      }
                                    >
                                      {fixingDiagnosticsCheckId ===
                                        check.id && (
                                        <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                      )}
                                      {fixAction.label}
                                    </Button>
                                    {fixAction.openServerConfig && (
                                      <Button
                                        asChild
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 px-2 text-[11px]"
                                      >
                                        <Link to="/server-config">
                                          {dt('fix.openServerConfig')}
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
                                        <Link to="/mods">{t('openMods')}</Link>
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
                    title={t('checks.allPass')}
                    description={t('checks.nothingToShow')}
                  />
                </CardContent>
              </Card>
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
                ? t('static.ui.worldMapDegraded')
                : overall === "warn"
                  ? t('static.ui.worldMapWarnings')
                  : overall === "ok"
                    ? t('static.ui.worldMapOperational')
                    : t('static.ui.runningMapChecks');
            const OverallIcon =
              overall === "fail"
                ? AlertCircle
                : overall === "warn"
                  ? AlertTriangle
                  : overall === "ok"
                    ? CheckCircle
                    : Loader2;
            const fmtAge = (ms: number | null) => {
              if (ms === null || ms === undefined) return "—";
              if (ms < 1000) return t('static.ui.justNow');
              if (ms < 60_000) return t('static.ui.secondsAgo', { count: Math.round(ms / 1000) });
              return t('static.ui.minutesAgo', { count: Math.round(ms / 60_000) });
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
            const copyPath = async (label: string, value: string) => {
              const ok = await copyText(value);
              toast({
                title: ok ? `${label} ${t('static.ui.copied').toLowerCase()}` : t('static.ui.copyFailed'),
                description: ok ? value : t('static.ui.clipboardUnavailable'),
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
                title={`Copy ${label.toLowerCase()}`}
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
                lines.push(
                  `  [${c.status.toUpperCase()}] ${c.label} — ${c.message}${c.hint ? `  Fix: ${c.hint}` : ""}`,
                );
              }
              const ok = await copyText(lines.join("\n"));
              toast({
                title: ok ? t('static.ui.reportCopied') : t('static.ui.copyFailed'),
                description: ok
                  ? t('static.ui.reportCopiedDesc')
                  : t('static.ui.clipboardUnavailable'),
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
                            {t('static.ui.couldNotReachDiagnostics')}
                          </h3>
                          <p className="text-sm text-muted-foreground mt-1">
                            {worldMapError} — {t('static.ui.backendAuthHint')}
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
                          {t('static.ui.retry')}
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
                                {t('static.ui.liveTileSourcesDesc')}
                              </p>
                              {wm && (
                                <div className="flex items-center gap-2 mt-2 flex-wrap text-xs">
                                  <Badge
                                    variant="outline"
                                    className="bg-primary/10 border-primary/30 text-primary"
                                  >
                                    <CheckCircle className="w-3 h-3 mr-1" />{" "}
                                    {wm.summary.ok} {t('static.ui.ok')}
                                  </Badge>
                                  {wm.summary.warn > 0 && (
                                    <Badge
                                      variant="outline"
                                      className="bg-warning/10 border-warning/30 text-warning"
                                    >
                                      <AlertTriangle className="w-3 h-3 mr-1" />{" "}
                                      {wm.summary.warn} {t('static.ui.warn')}
                                    </Badge>
                                  )}
                                  {wm.summary.fail > 0 && (
                                    <Badge variant="destructive">
                                      <AlertCircle className="w-3 h-3 mr-1" />{" "}
                                      {wm.summary.fail} {t('static.ui.failedLower')}
                                    </Badge>
                                  )}
                                  {wm.summary.skip > 0 && (
                                    <Badge
                                      variant="outline"
                                      className="text-muted-foreground"
                                    >
                                      {wm.summary.skip} {t('static.ui.skipped')}
                                    </Badge>
                                  )}
                                  <span className="text-muted-foreground">
                                    · {wm.durationMs} ms
                                    {lastRun &&
                                      ` · ${t('static.ui.checked', { age: fmtAge(sinceFetchMs) })}`}
                                  </span>
                                  {refreshingWorldMap && (
                                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                      {t('static.ui.refreshing')}
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
                                {t('static.ui.openWorldMap')}
                              </Link>
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={copyReport}
                              disabled={!wm}
                            >
                              <Copy className="w-4 h-4 mr-2" />
                              {t('static.ui.copyReport')}
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
                              {t('static.ui.rerun')}
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
                                  ? t('static.ui.actionNeeded')
                                  : t('static.ui.headsUp')}
                                : {firstFix.label}
                              </div>
                              <div className="text-xs text-muted-foreground mt-0.5">
                                {firstFix.message}
                              </div>
                              {firstFix.hint && (
                                <div className="text-xs mt-1.5">
                                  <span className="font-semibold text-primary">
                                    {t('static.ui.fix')}
                                  </span>{" "}
                                  {firstFix.hint}
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
                          {t('static.ui.tileSources')}
                        </CardTitle>
                        <CardDescription>
                          {t('static.ui.tileSourcesDesc')}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {(["b42", "b41"] as const).map((kind) => {
                          const probe = wm?.tileSources?.[kind];
                          const label =
                            kind === "b42"
                              ? "B42 — b42map.com"
                              : "B41 — map.projectzomboid.com";
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
                                      label={t('actions.probeUrl')}
                                      value={probe.url}
                                    />
                                    <a
                                      href={probe.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary transition-colors"
                                      title={t('actions.openUrl')}
                                    >
                                      <ExternalLink className="w-3 h-3" />
                                      {t('static.ui.open')}
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
                              {t('static.ui.liveTileProxy')}
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
                              <RefreshCw className="w-3 h-3 mr-1" /> {t('static.ui.refresh')}
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
                                label: "B42 floor 0 / 0_0",
                                src: `/api/map/tiles/0/0_0.jpg?floor=0&t=${worldMapTilePreviewKey}`,
                                errTone: "destructive",
                              },
                              {
                                key: "b41",
                                label: "B41 / 0_0",
                                src: `/api/map/b41tiles/0/0_0.jpg?t=${worldMapTilePreviewKey}`,
                                errTone: "warning",
                              },
                            ];
                            return (
                              <div className="flex flex-wrap gap-3">
                                {tiles.map((t) => {
                                  const failed = worldMapTileErrors[t.key];
                                  const meta = worldMapTileMeta[t.key];
                                  const loaded = !failed && meta !== null;
                                  return (
                                    <div
                                      key={t.key}
                                      className="flex items-center gap-3 rounded-lg border border-border/55 bg-muted/20 p-2.5"
                                    >
                                      <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded border border-border/60 bg-muted/40">
                                        {failed ? (
                                          <div className="flex h-full w-full flex-col items-center justify-center p-1 text-center">
                                            <AlertCircle
                                              className={cn(
                                                "w-4 h-4 mb-0.5",
                                                t.errTone === "destructive"
                                                  ? "text-destructive"
                                                  : "text-warning",
                                              )}
                                            />
                                            <div
                                              className={cn(
                                                "text-[9px] font-medium leading-tight",
                                                t.errTone === "destructive"
                                                  ? "text-destructive"
                                                  : "text-warning",
                                              )}
                                            >
                                              {dt('ui.failed')}
                                            </div>
                                          </div>
                                        ) : (
                                          <img
                                            key={`${t.key}-${worldMapTilePreviewKey}`}
                                            src={t.src}
                                            alt={`${t.label} preview`}
                                            className="h-full w-full object-cover"
                                            onLoad={(e) => {
                                              const img = e.currentTarget;
                                              setWorldMapTileMeta((prev) => ({
                                                ...prev,
                                                [t.key]: {
                                                  w: img.naturalWidth,
                                                  h: img.naturalHeight,
                                                },
                                              }));
                                            }}
                                            onError={() =>
                                              setWorldMapTileErrors((prev) => ({
                                                ...prev,
                                                [t.key]: true,
                                              }))
                                            }
                                          />
                                        )}
                                      </div>
                                      <div className="min-w-0">
                                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                          {t.label}
                                        </div>
                                        <div className="mt-1">
                                          {failed ? (
                                            <span
                                              className={cn(
                                                "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                                                t.errTone === "destructive"
                                                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                                                  : "border-warning/40 bg-warning/10 text-warning",
                                              )}
                                            >
                                              <AlertCircle className="w-2.5 h-2.5" />{" "}
                                              {dt('ui.tileFailed')}
                                            </span>
                                          ) : loaded ? (
                                            <span className="inline-flex items-center gap-1 rounded-full border border-primary/35 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                              <CheckCircle className="w-2.5 h-2.5" />{" "}
                                              {dt('ui.loaded')}
                                              <span className="font-mono tabular-nums text-primary/80">
                                                {meta!.w}×{meta!.h}
                                              </span>
                                            </span>
                                          ) : (
                                            <span className="inline-flex items-center gap-1 rounded-full border border-border/55 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                              <Loader2 className="w-2.5 h-2.5 animate-spin" />{" "}
                                              {dt('ui.loading')}
                                            </span>
                                          )}
                                        </div>
                                        <p className="mt-1 text-[10px] text-muted-foreground/70 leading-tight">
                                          {dt('ui.tileHint')}
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
                          {t('static.ui.liveDataFeed')}
                        </CardTitle>
                        <CardDescription>
                          {t('static.ui.liveDataFeedDesc')}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        {wm?.bridge ? (
                          <div className="grid grid-cols-2 gap-2 text-sm">
                            <div className="p-2 rounded border bg-card">
                              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                {t('static.ui.configured')}
                              </div>
                              <div className="font-medium">
                                {wm.bridge.configured ? t('static.ui.yes') : t('static.ui.no')}
                              </div>
                            </div>
                            <div className="p-2 rounded border bg-card">
                              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                {t('static.ui.serviceRunning')}
                              </div>
                              <div className="font-medium flex items-center gap-1">
                                {wm.bridge.isRunning ? (
                                  <>
                                    <Wifi className="w-3 h-3 text-primary" />{" "}
                                    {t('static.ui.yes')}
                                  </>
                                ) : (
                                  <>
                                    <WifiOff className="w-3 h-3 text-muted-foreground" />{" "}
                                    {t('static.ui.no')}
                                  </>
                                )}
                              </div>
                            </div>
                            <div className="p-2 rounded border bg-card">
                              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                {t('static.ui.modConnected')}
                              </div>
                              <div className="font-medium">
                                {wm.bridge.modConnected ? t('static.ui.yes') : t('static.ui.no')}
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
                                    {t('static.ui.lastHeartbeat')}
                                  </div>
                                  <div className="font-medium">
                                    {fmtAge(age)}
                                    {stale && ` · ${t('static.ui.stale')}`}
                                  </div>
                                </div>
                              );
                            })()}
                            {wm.bridge.consecutiveFailures > 0 && (
                              <div className="col-span-2 p-2 rounded border border-warning/30 bg-warning/5">
                                <div className="text-[10px] uppercase tracking-wide text-warning">
                                  {t('static.ui.consecutiveFailures')}
                                </div>
                                <div className="font-medium">
                                  {wm.bridge.consecutiveFailures}
                                </div>
                              </div>
                            )}
                            {wm.bridge.bridgePath && (
                              <div className="col-span-2 p-2 rounded border bg-card">
                                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
                                  {t('static.ui.bridgePath')}
                                </div>
                                <CopyablePath
                                  label={t('paths.bridge')}
                                  value={wm.bridge.bridgePath}
                                />
                              </div>
                            )}
                            <div className="col-span-2 p-2 rounded border bg-card">
                              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                {t('static.ui.requiredHandlers')}
                              </div>
                              <div className="text-[11px] text-muted-foreground mb-1.5">
                                {t('static.ui.requiredHandlersDesc')}
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
                            {t('static.ui.noBridgeData')}
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
                              {t('static.ui.liveDataProbes')}
                            </CardTitle>
                            <CardDescription>
                              {t('static.ui.liveDataProbesDesc')}
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
                            {t('static.ui.probeAll')}
                          </Button>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {(
                          [
                            {
                              id: "players",
                              label: t('static.ui.playersOnline'),
                              Icon: Users,
                              run: probePlayers,
                              unit: "player",
                            },
                            {
                              id: "vehicles",
                              label: t('static.ui.vehicles'),
                              Icon: Car,
                              run: probeVehicles,
                              unit: "vehicle",
                            },
                            {
                              id: "safehouses",
                              label: t('static.ui.safehouses'),
                              Icon: Home,
                              run: probeSafehouses,
                              unit: "safehouse",
                            },
                            {
                              id: "gameTime",
                              label: t('static.ui.gameTime'),
                              Icon: Clock,
                              run: probeGameTime,
                              unit: "",
                            },
                          ] as const
                        ).map(({ id, label, Icon, run, unit }) => {
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
                                            ?.time || t('static.ui.ok')
                                        : `${r.count ?? 0} ${unit}${(r.count ?? 0) === 1 ? "" : "s"}`}
                                    </Badge>
                                  )}
                                  {r && !r.ok && (
                                    <Badge
                                      variant="destructive"
                                      className="text-[10px] max-w-[18rem] truncate"
                                      title={r.error}
                                    >
                                      {r.error || t('static.ui.failed')}
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
                                              · {t('static.ui.dead')}
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
                                            {t('static.ui.more', { count: r.count - (r.sample as unknown[]).length })}
                                          </div>
                                        )}
                                    </div>
                                  )}
                                {id === "players" && r?.ok && r.count === 0 && (
                                  <div className="text-[11px] text-muted-foreground mt-1 italic">
                                    {t('static.ui.noPlayersActions')}
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
                                <span className="ml-1.5">{t('probe')}</span>
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
                              {t('static.ui.testLiveActions')}
                            </CardTitle>
                            <CardDescription>
                              {t('static.ui.liveActionHint')}
                            </CardDescription>
                          </CardHeader>
                          <CardContent className="space-y-3">
                            {!bridgeReady && (
                              <div className="p-2.5 rounded-md border border-destructive/40 bg-destructive/10 text-xs flex items-start gap-2">
                                <WifiOff className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
                                <div>
                                  <div className="font-medium text-destructive">
                                    {t('static.ui.bridgeNotConnected')}
                                  </div>
                                  <div className="text-muted-foreground">
                                    {t('static.ui.bridgeRequiredForActions')}
                                  </div>
                                </div>
                              </div>
                            )}
                            <div className="p-2 rounded border bg-card text-xs">
                              <span className="text-muted-foreground">
                                {t('static.ui.target')}
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
                                      · {t('static.ui.dead')}
                                    </span>
                                  )}
                                </>
                              ) : probeResults["players"]?.ok &&
                                probeResults["players"]?.count === 0 ? (
                                <span className="text-muted-foreground italic">
                                  {t('static.ui.noPlayers')}
                                </span>
                              ) : (
                                <span className="text-muted-foreground italic">
                                  {t('static.ui.noPlayerProbed')}
                                </span>
                              )}
                            </div>

                            {/* Airdrop */}
                            <div className="p-2.5 rounded-md border bg-card space-y-2">
                              <div className="flex items-center gap-2">
                                <Package className="w-4 h-4 text-warning shrink-0" />
                                <span className="text-sm font-medium">
                                  {t('static.ui.dropAirdrop')}
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
                                    <SelectItem value="food">{t('food')}</SelectItem>
                                    <SelectItem value="medical">
                                      {t('static.ui.medical')}
                                    </SelectItem>
                                    <SelectItem value="military">
                                      {t('static.ui.military')}
                                    </SelectItem>
                                    <SelectItem value="weapons">
                                      {t('static.ui.weapons')}
                                    </SelectItem>
                                    <SelectItem value="building">
                                      {t('static.ui.building')}
                                    </SelectItem>
                                    <SelectItem value="tools">{t('tools')}</SelectItem>
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
                                        t('static.ui.airdropDeployed'),
                                        t('static.ui.airdropDropping', {
                                          preset: airdropPreset,
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
                                    ? t('static.ui.clickConfirm')
                                    : t('static.ui.dropNow')}
                                </Button>
                              </div>
                            </div>

                            {/* Test gunshot sound */}
                            <div className="p-2.5 rounded-md border bg-card flex items-center justify-between gap-2 flex-wrap">
                              <div className="flex items-center gap-2 min-w-0">
                                <Volume2 className="w-4 h-4 text-warning shrink-0" />
                                <div className="min-w-0">
                                  <div className="text-sm font-medium">
                                    {t('static.ui.gunshot')}
                                  </div>
                                  <div className="text-[11px] text-muted-foreground">
                                    {t('static.ui.gunshotDesc')}
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
                                      t('static.ui.trigger'),
                                      t('static.ui.playedNear', {
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
                                  ? t('static.ui.clickConfirm')
                                  : t('static.ui.trigger')}
                              </Button>
                            </div>

                            {/* Test lightning */}
                            <div className="p-2.5 rounded-md border bg-card flex items-center justify-between gap-2 flex-wrap">
                              <div className="flex items-center gap-2 min-w-0">
                                <Zap className="w-4 h-4 text-warning shrink-0" />
                                <div className="min-w-0">
                                  <div className="text-sm font-medium">
                                    {t('static.ui.lightning')}
                                  </div>
                                  <div className="text-[11px] text-muted-foreground">
                                    {t('static.ui.lightningDesc')}
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
                                      t('static.ui.trigger'),
                                      t('static.ui.strikeAt', {
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
                                  ? t('static.ui.clickConfirm')
                                  : t('static.ui.trigger')}
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
                          {t('static.ui.activeSaveBuild')}
                        </CardTitle>
                        <CardDescription>
                          {t('static.ui.activeSaveBuildDesc')}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        {wm?.save ? (
                          <div className="space-y-2 text-sm">
                            <div className="flex items-center gap-2">
                              <span className="text-muted-foreground">
                                {t('static.ui.detectedBuild')}
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
                                {t('static.ui.saves', { count: wm.save.saveCount })}
                              </span>
                            </div>
                            {wm.save.activeSaveName && (
                              <div className="text-xs">
                                <span className="text-muted-foreground">
                                  {t('static.ui.sampleSave')}
                                </span>{" "}
                                <code className="font-mono">
                                  {wm.save.activeSaveName}
                                </code>
                              </div>
                            )}
                            {wm.save.zomboidDataPath && (
                              <div className="text-xs">
                                <span className="text-muted-foreground">
                                  {t('static.ui.zomboidData')}
                                </span>{" "}
                                <CopyablePath
                                  label={t('paths.zomboidData')}
                                  value={wm.save.zomboidDataPath}
                                />
                              </div>
                            )}
                            {wm.save.activeSavePath && (
                              <div className="text-xs">
                                <span className="text-muted-foreground">
                                  {t('static.ui.savePath')}
                                </span>{" "}
                                <CopyablePath
                                  label={t('paths.savePath')}
                                  value={wm.save.activeSavePath}
                                />
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="text-sm text-muted-foreground">
                            {t('static.ui.noSaveData')}
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
                            {t('static.ui.checks')}
                          </CardTitle>
                          {wm && wm.checks.length > 0 && (
                            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                              <Checkbox
                                checked={worldMapHideOk}
                                onCheckedChange={(v) =>
                                  setWorldMapHideOk(v === true)
                                }
                              />
                              {t('static.ui.hidePassing')}
                            </label>
                          )}
                        </div>
                      </CardHeader>
                      <CardContent>
                        {!wm ? (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                            <Loader2 className="w-4 h-4 animate-spin" /> {t('static.ui.runningMapChecks')}
                          </div>
                        ) : wm.checks.length === 0 ? (
                          <div className="text-sm text-muted-foreground py-4">
                            {t('static.ui.noChecksRan')}
                          </div>
                        ) : visibleChecks.length === 0 ? (
                          <div className="flex items-center gap-2 text-sm text-primary py-4">
                            <CheckCircle className="w-4 h-4" /> {t('static.ui.allChecksPass')}
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
                                      {c.label}
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                      {c.message}
                                    </div>
                                    {c.hint && (
                                      <div className="text-xs mt-1 text-primary/80">
                                        <span className="font-semibold">
                                          {t('static.ui.fix')}
                                        </span>{" "}
                                        {c.hint}
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
                    {t('static.ui.activityLog')}
                  </CardTitle>
                  <CardDescription>
                    {t('static.ui.activityDescription')}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Select
                    value={activitySource}
                    onValueChange={(v) => setActivitySource(v)}
                  >
                    <SelectTrigger
                      className="w-[130px] h-8"
                      aria-label={t('activity.filterBySource')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">
                        {t('allSources')}
                        {activityStats.total > 0
                          ? ` (${activityStats.total})`
                          : ""}
                      </SelectItem>
                      <SelectItem value="rcon">
                        {t('static.ui.rconSource')}
                        {activityStats.rcon > 0
                          ? ` (${activityStats.rcon})`
                          : ""}
                      </SelectItem>
                      <SelectItem value="bridge">
                        {t('static.ui.bridgeSource')}
                        {activityStats.bridge > 0
                          ? ` (${activityStats.bridge})`
                          : ""}
                      </SelectItem>
                      <SelectItem value="player">
                        {t('static.ui.playerSource')}
                        {activityStats.player > 0
                          ? ` (${activityStats.player})`
                          : ""}
                      </SelectItem>
                      <SelectItem value="server">
                        {t('static.ui.serverSource')}
                        {activityStats.server > 0
                          ? ` (${activityStats.server})`
                          : ""}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <Input
                      placeholder={t('activity.searchPlaceholder')}
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
                      aria-label={t('activity.search')}
                    />
                    {activitySearch && (
                      <button
                        type="button"
                        onClick={() => setActivitySearch("")}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                        aria-label={t('activity.clearSearch')}
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
                        {activityPaused
                          ? t('static.ui.resume')
                          : t('static.ui.live')}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {activityPaused
                        ? t('static.ui.resumeAutoRefresh')
                        : t('static.ui.pauseAutoRefresh')}
                    </TooltipContent>
                  </Tooltip>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={fetchActivity}
                    disabled={refreshingActivity}
                    aria-label={t('activity.refresh')}
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
                      ? `${filteredActivityEntries.length} / ${activityStats.total}`
                      : activityStats.total}{" "}
                    {t('static.ui.entries')}
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
                    {t('static.ui.all')}
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
                    title={t('filters.showSuccessful')}
                  >
                    <CheckCircle className="w-3 h-3" /> {activityStats.success}{" "}
                    {t('static.ui.success')}
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
                    title={t('filters.showFailed')}
                  >
                    <AlertCircle className="w-3 h-3" /> {activityStats.failed}{" "}
                    {t('static.ui.failedLower')}
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
                          <ChevronDown className="w-3 h-3" />
                          {t('static.ui.collapseAll')}
                        </>
                      ) : (
                        <>
                          <ChevronRight className="w-3 h-3" />
                          {t('static.ui.expandAll')}
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
                      {activityPaused
                        ? `${t('static.ui.paused')} · `
                        : ""}
                      {t('static.ui.lastRefresh')}{" "}
                      {activityLastLoaded.toLocaleTimeString()}
                    </span>
                  )}
                </div>
              )}
            </CardHeader>
            <CardContent>
              {activityEntries.length === 0 ? (
                <EmptyState
                  title={t('activity.noActivity')}
                  description={t('activity.description')}
                  icon={<Zap className="w-6 h-6" />}
                />
              ) : filteredActivityEntries.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
                  <Search className="w-5 h-5 opacity-60" />
                  <p className="text-sm">
                    {t('static.ui.noEntriesMatch')}
                  </p>
                  <div className="flex gap-2">
                    {activitySearch && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setActivitySearch("")}
                        className="text-xs"
                      >
                        {t('static.ui.clearSearch')}
                      </Button>
                    )}
                    {activityResultFilter !== "all" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setActivityResultFilter("all")}
                        className="text-xs"
                      >
                        {t('static.ui.showAllResults')}
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
                              title={new Date(entry.timestamp).toLocaleString()}
                            >
                              {new Date(entry.timestamp).toLocaleTimeString()}
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
                              {entry.source}
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
                                    ? "Slow (over 1s)"
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
                              aria-label={t('actions.copyEntry')}
                              title={t('actions.copyEntry')}
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
                                      {t('static.ui.args')}:
                                    </span>{" "}
                                    {JSON.stringify(entry.args)}
                                  </div>
                                )}
                              <div>
                                <span className="text-muted-foreground">
                                  {t('static.ui.detail')}:
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
                  label: t('static.ui.total'),
                  value: logStats.total,
                  tone: "muted",
                  Icon: Terminal,
                },
                {
                  key: "error",
                  label: t('errors'),
                  value: logStats.errors,
                  tone: "destructive",
                  Icon: AlertCircle,
                },
                {
                  key: "warn",
                  label: t('warnings'),
                  value: logStats.warnings,
                  tone: "warning",
                  Icon: AlertTriangle,
                },
                {
                  key: "info",
                  label: t('info'),
                  value: logStats.info,
                  tone: "primary",
                  Icon: Info,
                },
                {
                  key: "debug",
                  label: t('debug'),
                  value: logStats.debug,
                  tone: "muted",
                  Icon: Bug,
                },
              ] as const;
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
              return tiles.map((t) => {
                const s = toneStyles[t.tone];
                const isActive = levelFilter === t.key;
                return (
                  <Card
                    key={t.key}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isActive}
                    aria-label={`${dt('ui.filter')}: ${t.label}`}
                    onClick={() => setLevelFilter(t.key as typeof levelFilter)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setLevelFilter(t.key as typeof levelFilter);
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
                        <t.Icon className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          {t.label}
                        </p>
                        <p
                          className={cn(
                            "text-xl font-semibold leading-tight tabular-nums",
                            s.value,
                          )}
                        >
                          {t.value.toLocaleString()}
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
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Terminal className="w-5 h-5" />
                      {t('static.ui.applicationLogs')}
                      {paused && (
                        <Badge variant="secondary" className="ml-2">
                          {t('static.ui.paused')}
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription>
                      {t('static.ui.realTimeLogs', {
                        shown: filteredLogs.length,
                        total: logs.length,
                      })}
                      <span className="ml-2 text-xs">
                        {t('static.ui.keyboardLogHint')}
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
                          {paused
                            ? t('static.ui.resumeLiveUpdates')
                            : t('static.ui.pauseLiveUpdates')}
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
                        <TooltipContent>{t('refreshLogs')}</TooltipContent>
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
                        {t('static.ui.export')}
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="download" disabled>
                          {t('static.ui.exportLogs')}
                        </SelectItem>
                        <SelectItem value="full-txt">
                          {t('static.ui.fullLogFile')}
                        </SelectItem>
                        <SelectItem value="filtered-txt">
                          {t('static.ui.filteredTxt')}
                        </SelectItem>
                        <SelectItem value="filtered-json">
                          {t('static.ui.filteredJson')}
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
                        <TooltipContent>{t('clearDisplay')}</TooltipContent>
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
                      placeholder={t('logs.searchPlaceholder')}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-9 pr-8"
                      aria-label={t('logs.search')}
                      maxLength={128}
                    />
                    {searchQuery && (
                      <button
                        onClick={() => setSearchQuery("")}
                        aria-label={t('logs.clearSearch')}
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
                      <SelectValue placeholder={t('logs.levelPlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('allLevels')}</SelectItem>
                      <SelectItem value="error">{t('errors')}</SelectItem>
                      <SelectItem value="warn">{t('warnings')}</SelectItem>
                      <SelectItem value="info">{t('info')}</SelectItem>
                      <SelectItem value="debug">{t('debug')}</SelectItem>
                    </SelectContent>
                  </Select>

                  {/* Source Filter */}
                  <Select value={sourceFilter} onValueChange={setSourceFilter}>
                    <SelectTrigger className="w-full sm:w-[160px]">
                      <SelectValue placeholder={t('logs.sourcePlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('allSources')}</SelectItem>
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
                      <SelectItem value="time">{t('timeOnly')}</SelectItem>
                      <SelectItem value="datetime">{t('dateTime')}</SelectItem>
                      <SelectItem value="relative">{t('relative')}</SelectItem>
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
                      {t('static.ui.autoScroll')}
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
                        title={t('logs.noLogs')}
                        description={t('logs.description')}
                      />
                    ) : (
                      <EmptyState
                        compact
                        type="noResults"
                        title={t('logs.noMatch')}
                        description={t('empty.tryAdjusting')}
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
                            {log.level.toUpperCase()}
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
                  {t('static.ui.logFilesOnDisk')}
                </CardTitle>
                <CardDescription>
                  {t('static.ui.logFilesDesc')}
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
                          {t('static.ui.recommended')}
                        </p>
                        <p className="mt-0.5 text-sm font-semibold text-foreground">
                          {t('static.ui.oneClickBundle')}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t('static.ui.bundleDescription')}
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
                      {downloadingLogArchive
                        ? t('static.ui.bundling')
                        : t('static.ui.downloadZip')}
                    </Button>
                  </div>
                </div>

                {/* Individual files */}
                <div>
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t('static.ui.individualFiles')}{" "}
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
                              {new Date(file.modified).toLocaleString()}
                            </p>
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => downloadLogFile(file.name)}
                          aria-label={t('static.ui.downloadFileAria', {
                            name: file.name,
                          })}
                          className="gap-1.5 shrink-0"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">{t('download')}</span>
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
                      {t('static.ui.crashLogs')}
                      {crashLogs.length > 0 && (
                        <Badge variant="destructive" className="ml-1">
                          {crashLogs.length}
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription>
                      {t('static.ui.crashDescription')}
                    </CardDescription>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={fetchCrashLogs}
                    disabled={refreshingCrashLogs}
                    aria-label={t('crashes.refresh')}
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
                    title={t('crashes.noCrashLogs')}
                    description={t('crashes.goodNews')}
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
                                    {t('static.ui.newBadge')}
                                  </Badge>
                                )}
                              </div>
                              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                                <span>{formatFileSize(log.size)}</span>
                                <span>•</span>
                                <span
                                  title={new Date(
                                    log.modified,
                                  ).toLocaleString()}
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
                      {selectedCrashLog || t('static.ui.crashLogViewer')}
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
                                title: ok
                                  ? t('static.ui.copied')
                                  : t('static.ui.copyFailed'),
                                description: ok
                                  ? t('static.ui.crashCopied', {
                                      name: selectedCrashLog,
                                    })
                                  : t('static.ui.clipboardUnavailable'),
                                variant: ok
                                  ? ("success" as const)
                                  : "destructive",
                              });
                            }}
                          >
                            <Copy className="w-4 h-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('copyContents')}</TooltipContent>
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
                        <TooltipContent>{t('downloadFile')}</TooltipContent>
                      </Tooltip>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {!selectedCrashLog ? (
                  <div className="h-[calc(100vh-360px)] min-h-[300px] flex items-center justify-center text-muted-foreground">
                    {t('static.ui.selectCrashLog')}
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
                  {t('static.ui.showingSnapshots', {
                    count: performanceHistory.length,
                    duration: formatUptime(
                      Math.round(performanceStats.spanMs / 1000),
                    ),
                  })}
                </span>
              ) : (
                <span>
                  {t('static.ui.snapshotRecording')}
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
                  aria-label={t('performance.timeRange')}
                >
                  <Clock className="w-3.5 h-3.5 mr-1" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1h">{t('lastHour')}</SelectItem>
                  <SelectItem value="6h">{t('last6h')}</SelectItem>
                  <SelectItem value="24h">{t('last24h')}</SelectItem>
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
                <TooltipContent>{t('exportAsCsv')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={fetchPerformanceHistory}
                    disabled={refreshingPerformance}
                    aria-label={t('performance.refresh')}
                  >
                    <RefreshCw
                      className={cn(
                        "w-4 h-4",
                        refreshingPerformance && "animate-spin",
                      )}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('refreshNow')}</TooltipContent>
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
            const fmtBool = (b: boolean) =>
              b ? t('static.ui.running') : t('static.ui.stopped');
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
                      {t('static.ui.hostRam')}
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
                        : t('static.ui.na')}
                    </p>
                    {performanceStats.hostGB.avg != null && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {t('static.ui.avgMaxGb', {
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
                      {t('static.ui.hostCpu')}
                    </p>
                    <p
                      className={cn(
                        "text-xl font-bold mt-1",
                        cpuTone === "destructive" && "text-destructive",
                        cpuTone === "warning" && "text-warning",
                      )}
                    >
                    {latest?.cpuLoad != null
                      ? `${latest.cpuLoad}%`
                      : t('static.ui.na')}
                    </p>
                    {performanceStats.cpu.avg != null && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {t('static.ui.avgMaxPercent', {
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
                      {t('static.ui.pzServerRam')}
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
                        : t('static.ui.na')}
                    </p>
                    {performanceStats.pzMB.avg != null && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {t('static.ui.avgGb', {
                          value: (performanceStats.pzMB.avg / 1024).toFixed(1),
                        })}
                      </p>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">
                      {t('static.ui.pzPeak')}
                    </p>
                    <p className="text-xl font-bold mt-1">
                      {performanceStats.pzMB.max != null
                        ? `${(performanceStats.pzMB.max / 1024).toFixed(1)} GB`
                        : t('static.ui.na')}
                    </p>
                    {performanceStats.pzMB.count > 0 && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {t('static.ui.acrossSamples', {
                          count: performanceStats.pzMB.count,
                        })}
                      </p>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">
                      {t('static.ui.players')}
                    </p>
                    <p className="text-xl font-bold mt-1">
                      {latest?.playerCount ?? t('static.ui.na')}
                    </p>
                    {performanceStats.players.max != null && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {t('static.ui.peakAvg', {
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
                      {t('static.ui.server')}
                    </p>
                    <p
                      className={cn(
                        "text-xl font-bold mt-1",
                        latest?.serverRunning
                          ? "text-success"
                          : "text-muted-foreground",
                      )}
                    >
                      {latest ? fmtBool(latest.serverRunning) : t('static.ui.na')}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {t('static.ui.samples', {
                        count: performanceHistory.length,
                      })}
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
                title={t('performance.collecting')}
                description={t('performance.description')}
              />
            )}
          </Suspense>
        </TabsContent>

        {/* Health Tab */}
        <TabsContent value="health" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Overall Status */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2">
                  <Activity className="w-5 h-5" />
                  {t('static.ui.systemStatus')}
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
                        ? t('static.ui.healthy')
                        : t('static.ui.issuesDetected')}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {healthStatus?.timestamp ? (
                        <span
                          title={new Date(
                            healthStatus.timestamp,
                          ).toLocaleString()}
                        >
                          {t('static.ui.lastChecked')}{" "}
                          {formatTimestamp(new Date(healthStatus.timestamp))}
                        </span>
                      ) : (
                        t('static.ui.neverChecked')
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground/70 mt-0.5">
                      {t('static.ui.autoRefresh30s')}
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
                  {t('static.ui.memoryUsage')}
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
                            {t('static.ui.heapUsed')}
                          </span>
                          <span className="font-mono">
                            {formatMemory(healthStatus.memory.heapUsed)}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">
                            {t('static.ui.heapAllocated')}
                          </span>
                          <span className="font-mono">
                            {formatMemory(healthStatus.memory.heapTotal)}
                          </span>
                        </div>
                        {heapLimit !== undefined && (
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">
                              {t('static.ui.heapLimit')}
                            </span>
                            <span className="font-mono">
                              {formatMemory(heapLimit)}
                            </span>
                          </div>
                        )}
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">{t('rss')}</span>
                          <span className="font-mono">
                            {formatMemory(healthStatus.memory.rss)}
                          </span>
                        </div>
                        {heapLimit !== undefined && (
                          <>
                            <div className="flex justify-between text-xs">
                              <span className="text-muted-foreground">
                                {t('static.ui.heapUsage')}
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
                  {t('static.ui.services')}
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
                  {t('static.ui.refresh')}
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
                    <span className="font-medium">{t('rcon')}</span>
                    <Badge
                      variant={
                        healthStatus?.services?.rcon?.connected
                          ? "default"
                          : "destructive"
                      }
                      className="ml-auto"
                    >
                      {healthStatus?.services?.rcon?.connected
                        ? t('static.ui.connected')
                        : t('static.ui.disconnected')}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t('static.ui.host')}: {healthStatus?.services?.rcon?.host || t('static.ui.notConfigured')}
                  </p>
                </div>

                {/* Server Status */}
                <div className="p-4 rounded-lg border bg-card">
                  <div className="flex items-center gap-3 mb-3">
                    <Server
                      className={`w-5 h-5 ${healthStatus?.services?.server?.running ? "text-primary" : "text-muted-foreground"}`}
                    />
                    <span className="font-medium">{t('gameServer')}</span>
                    <Badge
                      variant={
                        healthStatus?.services?.server?.running
                          ? "default"
                          : "secondary"
                      }
                      className="ml-auto"
                    >
                      {healthStatus?.services?.server?.running
                        ? t('static.ui.running')
                        : t('static.ui.stopped')}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t('static.ui.dedicatedServer')}
                  </p>
                </div>

                {/* Mod Checker */}
                <div className="p-4 rounded-lg border bg-card">
                  <div className="flex items-center gap-3 mb-3">
                    <Settings
                      className={`w-5 h-5 ${healthStatus?.services?.modChecker?.running ? "text-primary" : "text-muted-foreground"}`}
                    />
                    <span className="font-medium">{t('modChecker')}</span>
                    <Badge
                      variant={
                        healthStatus?.services?.modChecker?.running
                          ? "default"
                          : "secondary"
                      }
                      className="ml-auto"
                    >
                      {healthStatus?.services?.modChecker?.running
                        ? t('static.ui.active')
                        : t('static.ui.inactive')}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t('static.ui.interval')} {" "}
                    {healthStatus?.services?.modChecker?.interval
                      ? `${Math.floor((healthStatus.services?.modChecker?.interval || 0) / 60000)}m`
                      : t('static.ui.na')}
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
                {t('static.ui.uptime')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">
                {healthStatus ? formatUptime(healthStatus.uptime) : "-"}
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {t('static.ui.since')}{" "}
                {healthStatus
                  ? new Date(
                      Date.now() - healthStatus.uptime * 1000,
                    ).toLocaleString()
                  : "-"}
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* System Tab */}
        <TabsContent value="system" className="space-y-4">
          {/* System Info Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  {t('static.ui.nodeJs')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-bold">
                  {systemInfo?.nodeVersion || "-"}
                </span>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  {t('static.ui.platform')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-bold">
                  {systemInfo?.platform || "-"}
                </span>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  {t('static.ui.uptime')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-bold">
                  {systemInfo ? formatUptime(systemInfo.uptime) : "-"}
                </span>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  {t('static.ui.memory')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-bold">
                  {systemInfo?.memoryUsage
                    ? formatMemory(systemInfo.memoryUsage.heapUsed)
                    : "-"}
                </span>
                <p className="text-xs text-muted-foreground mt-1">
                  {t('static.ui.ofHeap', {
                    value: systemInfo?.memoryUsage
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
                    {t('static.ui.filePaths')}
                  </CardTitle>
                  <CardDescription>
                    {t('static.ui.filePathsDescription')}
                  </CardDescription>
                </div>
                {!editingPaths && (
                  <Button variant="outline" size="sm" onClick={handleEditPaths}>
                    {t('static.ui.changePaths')}
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
                          {t('static.ui.restartRequired')}
                        </p>
                        <p className="text-muted-foreground">
                          {t('static.ui.restartPathsDescription')}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="dataDir">
                      {t('static.ui.dataDirectory')}
                    </Label>
                    <Input
                      id="dataDir"
                      value={newDataDir}
                      onChange={(e) => setNewDataDir(e.target.value)}
                      placeholder={t('paths.dataPlaceholder')}
                      className="font-mono"
                      maxLength={260}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="logsDir">{t('logsDirectory')}</Label>
                    <Input
                      id="logsDir"
                      value={newLogsDir}
                      onChange={(e) => setNewLogsDir(e.target.value)}
                      placeholder={t('paths.logsPlaceholder')}
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
                        {t('static.ui.moveExistingFiles')}
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        {t('static.ui.copyDataAndLogs')}
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
                      {t('static.ui.savePaths')}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setEditingPaths(false)}
                      disabled={savingPaths}
                    >
                      {t('static.ui.cancel')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3 font-mono text-sm">
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                    <span className="text-muted-foreground w-32 shrink-0">
                      {t('static.ui.database')}:
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
                            onClick={async () => {
                              const ok = await copyText(systemInfo.dbPath);
                              toast({
                                title: ok
                                  ? t('static.ui.copied')
                                  : t('static.ui.copyFailed'),
                                description: ok
                                  ? systemInfo.dbPath
                                  : t('static.ui.clipboardUnavailable'),
                                variant: ok
                                  ? ("success" as const)
                                  : "destructive",
                              });
                            }}
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('copyPath')}</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                    <span className="text-muted-foreground w-32 shrink-0">
                      {t('static.ui.logsFolder')}:
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
                            onClick={async () => {
                              const ok = await copyText(systemInfo.logsPath);
                              toast({
                                title: ok
                                  ? t('static.ui.copied')
                                  : t('static.ui.copyFailed'),
                                description: ok
                                  ? systemInfo.logsPath
                                  : t('static.ui.clipboardUnavailable'),
                                variant: ok
                                  ? ("success" as const)
                                  : "destructive",
                              });
                            }}
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('copyPath')}</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

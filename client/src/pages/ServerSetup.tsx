import { useState, useEffect, useContext, useRef, useMemo } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  Download,
  Server,
  CheckCircle,
  Loader2,
  Terminal,
  ChevronRight,
  ChevronLeft,
  ExternalLink,
  Eye,
  EyeOff,
  Cpu,
  FolderOpen,
  Zap,
  Shield,
  Settings2,
  Plus,
  HardDrive,
  Play,
  Sparkles,
  RefreshCw,
  Copy,
  Check,
  Info,
  ArrowRight,
  AlertTriangle,
} from "lucide-react";
import { configApi, serverApi, serversApi, debugApi } from "@/lib/api";
import { platformTranslationKey, useRuntimeInfo } from "@/hooks/useRuntimeInfo";
import { HelpTip } from "@/components/HelpTip";
import { NumberInput } from "@/components/NumberInput";
import { DisabledReason } from "@/components/DisabledReason";
import { getInstallProgressMessage } from "@/lib/installProgressMessage";
import { useAuth } from "@/contexts/AuthContext";
import { useNavigate } from "react-router-dom";
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
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/components/ui/use-toast";
import { SocketContext } from "@/contexts/SocketContext";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { reportClientError } from "@/lib/client-errors";
import { getUserErrorMessage, rawErrorMessageIntentional } from "@/lib/errorMessage";
import { cn, copyText, formatUptime } from "@/lib/utils";
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
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { FolderBrowser } from "@/components/FolderBrowser";

interface InstallLog {
  type: "info" | "success" | "error" | "warning" | "command" | "stdout" | "stderr";
  message: string;
  timestamp: Date;
}

type SetupMode = "select" | "full" | "quick";

function handleCardKeyDown(
  event: React.KeyboardEvent<HTMLDivElement>,
  onActivate: () => void,
) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onActivate();
  }
}

// Generate a random password
// Game port 65535 is excluded because configure-network derives UDPPort as
// gamePort + 1; RCON ports may still use the full 1024-65535 range.
export function isValidInstallPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

export function isValidGamePort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65534;
}

// A port field can now genuinely be NaN mid-edit (see NumberInput) -- a
// summary/review screen must never render the literal text "NaN"; show the
// same "—" placeholder this app already uses elsewhere for an unset value.
function formatPort(port: number): string {
  return Number.isFinite(port) ? String(port) : "—";
}

// Same rationale as formatPort -- minMemory/maxMemory can now genuinely be
// NaN mid-edit too (NumberInput), and the summary screen must never render it.
function formatMemory(gb: number): string {
  return Number.isFinite(gb) ? String(gb) : "—";
}

// POST /install returns as soon as SteamCMD is *launched*, then the real
// outcome (success or failure) arrives minutes later over install:log /
// install:complete -- and this component is the ONLY listener for either
// event anywhere in the client (2026-08-26 install-failure hunt, finding
// #7). If the tab is closed or the page reloads before that arrives, the
// wizard forgets an install was ever attempted while SteamCMD keeps running
// server-side regardless. This marker is the client's only memory of that:
// written right after a real install request is accepted, cleared the
// instant a real outcome (either one) is heard.
export const INSTALL_INFLIGHT_KEY = "zcp-install-inflight";
// A real SteamCMD download finishes in minutes to a couple of hours even on
// a slow link; past this the marker is almost certainly stale (a crashed
// panel, an abandoned attempt) rather than something still genuinely running.
const INSTALL_INFLIGHT_STALE_MS = 6 * 60 * 60 * 1000;

export interface InstallInFlightMarker {
  installPath: string;
  serverName: string;
  startedAt: number;
}

export function readInstallInFlightMarker(): InstallInFlightMarker | null {
  try {
    const raw = localStorage.getItem(INSTALL_INFLIGHT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.installPath === "string" &&
      typeof parsed.serverName === "string" &&
      typeof parsed.startedAt === "number"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeInstallInFlightMarker(marker: InstallInFlightMarker): void {
  try {
    localStorage.setItem(INSTALL_INFLIGHT_KEY, JSON.stringify(marker));
  } catch {
    // Best-effort (private browsing / storage quota) -- the wizard still
    // works, it just can't warn about this specific install after a reload.
  }
}

export function clearInstallInFlightMarker(): void {
  try {
    localStorage.removeItem(INSTALL_INFLIGHT_KEY);
  } catch {
    // ignore
  }
}

function generatePassword(length = 12): string {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Format bytes to human readable size
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

const LINUX_SERVICE_INSTALL_PATH = "/opt/zomboid-panel/data/pzserver";

// rawMessage is used ONLY to pattern-match the server's literal English
// string and, when matched, to embed the exact unwritable path back into the
// guidance text -- the same "raw text for internal logic, not display"
// legitimate use errorMessage.ts's own getRecoveryUrl() has (see
// eslint-rules/no-raw-error-message.js). displayMessage is what actually
// reaches the user everywhere else: previously this function returned
// rawMessage unchanged for every installation error OTHER than the
// not-writable one, showing fully raw/untranslated text and discarding any
// registered error code's translation (2026-08-27 lint-rule blind-spot
// sweep finding -- the raw ternary that used to compute rawMessage was
// invisible to no-raw-error-message.js because it fed this function, not a
// toast()/set*() call, directly).
export function installationErrorGuidance(
  rawMessage: string,
  displayMessage: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
  platform: string | null,
) {
  if (!rawMessage.startsWith("Installation path is not writable:")) {
    return displayMessage;
  }
  // The suffix tells the user to edit zomboid-panel.service and restart it
  // via systemd -- meaningless (and unfollowable) advice on Windows/macOS,
  // where this app is also a first-class supported platform, not an edge
  // case. Server always returns the identical message regardless of host
  // OS (server/routes/server.js formatWritablePathError), so the client is
  // the only place that knows to gate this. Unknown platform (still
  // loading, or the fetch failed) falls back to the plain message rather
  // than guessing.
  if (platform !== "linux") {
    return displayMessage;
  }

  return t("toasts.installationErrorGuidance", {
    message: rawMessage,
    path: LINUX_SERVICE_INSTALL_PATH,
  });
}

export default function ServerSetup() {
  const runtimeInfo = useRuntimeInfo();
  const { t } = useTranslation("serverSetup");
  const [setupMode, setSetupMode] = useState<SetupMode>("select");
  const [currentStep, setCurrentStep] = useState(1);

  // Step 1: Prerequisites
  const [steamCmdPath, setSteamCmdPath] = useState("");
  const [hasSteamCmd, setHasSteamCmd] = useState(false);

  // Step 2: Server Config
  const [installPath, setInstallPath] = useState("");
  const [serverName, setServerName] = useState("myserver");
  const [branch, setBranch] = useState("public");
  const [availableBranches, setAvailableBranches] = useState<
    Array<{ name: string; description: string; buildId?: string | null }>
  >([
    { name: "public", description: "Stable release (Build 42)" },
    { name: "b41multiplayer", description: "Build 41 Multiplayer" },
  ]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [useCustomDataPath, setUseCustomDataPath] = useState(false);
  const [zomboidDataPath, setZomboidDataPath] = useState("");
  const [rconPassword, setRconPassword] = useState("");
  const [rconPort, setRconPort] = useState(27015);
  const [showRconPassword, setShowRconPassword] = useState(false);
  const [copiedPassword, setCopiedPassword] = useState(false);

  // Step 3: Performance
  const [minMemory, setMinMemory] = useState(4);
  const [maxMemory, setMaxMemory] = useState(8);
  const [serverPort, setServerPort] = useState(16261);
  const [useUpnp, setUseUpnp] = useState(true);
  const [adminPassword, setAdminPassword] = useState("");
  const [showAdminPassword, setShowAdminPassword] = useState(false);
  const missingAdminPassword = adminPassword.trim().length === 0;
  const [useNoSteam, setUseNoSteam] = useState(false);
  const [useDebug, setUseDebug] = useState(false);
  const [systemRam, setSystemRam] = useState<{
    totalGB: number;
    freeGB: number;
    recommendedMin: number;
    recommendedMax: number;
  } | null>(null);
  const [detectingRam, setDetectingRam] = useState(false);
  // Drives installationErrorGuidance's Linux-only remediation suffix --
  // null until resolved, so we never show wrong-platform advice on a guess.
  const serverPlatform = runtimeInfo?.platform ?? null;

  // Installation state
  const [installing, setInstalling] = useState(false);
  // bug-hunt-2026-09-06: the request that kicks off an install only confirms
  // SteamCMD was launched (see the comment at its call site below) -- the
  // real outcome arrives later, ONLY via install:complete. If that event
  // never lands, `installing` (and the Install button it disables) would
  // stay stuck forever with zero indication anything went wrong, the same
  // "nobody's listening" shape as tonight's server uploadStream crash.
  // installStalled flips true after INSTALL_STALL_MS of no install:log
  // activity and re-enables the button without fabricating a result --
  // matching the same fix applied to Servers.tsx's steam dialog.
  // installViaSteamCmd scopes the watchdog to ONLY the socket-dependent
  // flow (handleInstall) -- handleQuickSetup also sets `installing` but is
  // fully HTTP-await-driven start to finish, so applying the same stall
  // detection there would risk a false "stalled" mid-legitimate-request and
  // let a second click race the still-in-flight create()/activate() calls.
  const [installStalled, setInstallStalled] = useState(false);
  const [installViaSteamCmd, setInstallViaSteamCmd] = useState(false);
  const installLastActivityRef = useRef<number>(0);
  const [logs, setLogs] = useState<InstallLog[]>([]);
  const [installComplete, setInstallComplete] = useState(false);
  // A leftover marker from a PREVIOUS page load (see readInstallInFlightMarker
  // above) -- not this session's own install, which uses `installing` above.
  const [resumeMarker, setResumeMarker] = useState<InstallInFlightMarker | null>(null);
  const [installProgress, setInstallProgress] = useState<{
    percent: number;
    downloaded: string;
    total: string;
    status: string;
  } | null>(null);

  // SteamCMD auto-download state
  const [downloadingSteamCmd, setDownloadingSteamCmd] = useState(false);
  // Same stuck-forever risk as installStalled above, for the separate
  // steamcmd:status/steamcmd:log channel handleAutoDownloadSteamCmd depends on.
  const [downloadStalled, setDownloadStalled] = useState(false);
  const downloadLastActivityRef = useRef<number>(0);
  const [steamCmdStatus, setSteamCmdStatus] = useState<string>("");

  const { toast } = useToast();
  const { can } = useAuth();
  const socket = useContext(SocketContext);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // POST /server/steamcmd/download, /server/install, /server/quick-setup all
  // require server.install (server.js:3643/2062/2679); PUT /config/app-settings
  // requires panel.settings at the route (config.js:256) -- a DIFFERENT
  // capability from its server.install-gated neighbors, which is exactly why
  // TECHNICIAN (holds server.install/server.control/servers.manage but not
  // panel.settings, server/services/permissions.js:299-320) hits a silent
  // 403 saving the SteamCMD path manually today; POST /server/start requires
  // server.control (server.js:1045). Open/true when capabilities are
  // unknown/null, same convention as every other capability check in the app.
  const canInstall = can("server.install");
  const canSaveSteamCmdPath = can("panel.settings");
  const canControlServer = can("server.control");
  const navigateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [startingServer, setStartingServer] = useState(false);

  // Refs for socket handler closure — avoids re-registering socket listeners when form state changes
  const formStateRef = useRef({
    serverName,
    installPath,
    zomboidDataPath,
    useCustomDataPath,
    rconPort,
    rconPassword,
    adminPassword,
    serverPort,
    minMemory,
    maxMemory,
    useNoSteam,
    useDebug,
    useUpnp,
  });
  useEffect(() => {
    formStateRef.current = {
      serverName,
      installPath,
      zomboidDataPath,
      useCustomDataPath,
      rconPort,
      rconPassword,
      adminPassword,
      serverPort,
      minMemory,
      maxMemory,
      useNoSteam,
      useDebug,
      useUpnp,
    };
  }, [
    serverName,
    installPath,
    zomboidDataPath,
    useCustomDataPath,
    rconPort,
    rconPassword,
    adminPassword,
    serverPort,
    minMemory,
    maxMemory,
    useNoSteam,
    useDebug,
    useUpnp,
  ]);

  // windows-steamcmd-selfheal client wiring, 2026-09-10: same reasoning as
  // formStateRef above -- the socket-handler effect below (handleSteamCmdStatus/
  // handleSteamCmdLog) has a [socket, toast, t] dependency array, not
  // [installViaSteamCmd], so a direct read of installViaSteamCmd inside those
  // closures would always see whichever value was current when that effect
  // last (re)ran, not the value at the moment a socket event actually
  // arrives. Mirrors formStateRef's fix for the identical class of problem.
  const installViaSteamCmdRef = useRef(installViaSteamCmd);
  useEffect(() => {
    installViaSteamCmdRef.current = installViaSteamCmd;
  }, [installViaSteamCmd]);

  // Clean up navigate timer on unmount
  useEffect(
    () => () => {
      if (navigateTimerRef.current) clearTimeout(navigateTimerRef.current);
    },
    [],
  );

  // Total steps based on mode
  const totalSteps = setupMode === "quick" ? 3 : 4;

  // Validation for each step
  const stepValidation = useMemo(() => {
    if (setupMode === "quick") {
      return {
        1: installPath.length > 0,
        2: serverName.length > 0 && rconPassword.length >= 6 && adminPassword.trim().length > 0,
        3: true,
      };
    }
    return {
      1: steamCmdPath.length > 0 && hasSteamCmd,
      2: installPath.length > 0 && serverName.length > 0,
      3: rconPassword.length >= 6 && adminPassword.trim().length > 0,
      4: true,
    };
  }, [
    setupMode,
    steamCmdPath,
    hasSteamCmd,
    installPath,
    serverName,
    rconPassword,
    adminPassword,
  ]);

  const canProceed = stepValidation[currentStep as keyof typeof stepValidation];

  // Generate random password on mount if empty
  useEffect(() => {
    if (!rconPassword) {
      setRconPassword(generatePassword(12));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- intentional mount-only: only generate once if blank

  // Auto-detect RAM on mount
  useEffect(() => {
    handleAutoDetectRam();
  }, []);

  // Was an install left running by a PREVIOUS page load? (closed tab,
  // refresh, crash -- see readInstallInFlightMarker above.) Surfaced as a
  // banner on the mode-select screen rather than silently discarded.
  useEffect(() => {
    const marker = readInstallInFlightMarker();
    if (!marker) return;
    if (Date.now() - marker.startedAt > INSTALL_INFLIGHT_STALE_MS) {
      clearInstallInFlightMarker();
      return;
    }
    setResumeMarker(marker);
  }, []);

  // Load saved settings
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const data = await configApi.getAppSettings();
        const settings = data.settings || {};
        if (settings.steamcmdPath) {
          setSteamCmdPath(settings.steamcmdPath);
          setHasSteamCmd(true);
        }
        if (settings.serverPath) setInstallPath(settings.serverPath);
        if (settings.serverName) setServerName(settings.serverName);
        if (settings.zomboidDataPath) {
          setZomboidDataPath(settings.zomboidDataPath);
          setUseCustomDataPath(true);
        }
        // Memory is stored in MB, convert to GB for display
        // Clamp to reasonable values (2-16 GB) to match slider range
        if (settings.minMemory)
          setMinMemory(
            Math.min(
              16,
              Math.max(2, Math.round(settings.minMemory / 1024) || 4),
            ),
          );
        if (settings.maxMemory)
          setMaxMemory(
            Math.min(
              16,
              Math.max(2, Math.round(settings.maxMemory / 1024) || 8),
            ),
          );
        if (settings.serverPort) setServerPort(settings.serverPort);
      } catch (error) {
        reportClientError("Failed to load settings.", error);
      }
    };
    loadSettings();
  }, []);

  // Fetch available Steam branches
  useEffect(() => {
    const fetchBranches = async () => {
      setLoadingBranches(true);
      try {
        const data = await serverApi.getBranches(steamCmdPath);
        if (data.branches && Array.isArray(data.branches)) {
          setAvailableBranches(data.branches);
          if (!data.branches.find((b: { name: string }) => b.name === branch)) {
            setBranch("public");
          }
        }
      } catch (error) {
        reportClientError("Failed to fetch branches.", error);
      } finally {
        setLoadingBranches(false);
      }
    };

    if (hasSteamCmd && steamCmdPath) {
      fetchBranches();
    }
  }, [hasSteamCmd, steamCmdPath]); // eslint-disable-line react-hooks/exhaustive-deps -- branch intentionally excluded; setBranch('public') inside is a deliberate fallback, not a dep

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Socket.IO events for installation
  useEffect(() => {
    if (!socket) return;

    const handleInstallLog = (data: {
      type: "stdout" | "stderr";
      text: string;
      progressCode?: string;
      params?: Record<string, string | number>;
    }) => {
      installLastActivityRef.current = Date.now();
      setInstallStalled(false);
      const text = data.text.trim();
      const displayText = getInstallProgressMessage(data, text);
      setLogs((prev) => [
        ...prev,
        { type: data.type, message: displayText, timestamp: new Date() },
      ]);

      // Parse SteamCMD progress: "Update state (0x61) downloading, progress: 50.00 (1234567890 / 2469135780)"
      const progressMatch = text.match(
        /progress:\s*([\d.]+)\s*\(([\d,]+)\s*\/\s*([\d,]+)\)/,
      );
      if (progressMatch) {
        const percent = parseFloat(progressMatch[1]);
        const downloaded = formatBytes(
          parseInt(progressMatch[2].replace(/,/g, "")),
        );
        const total = formatBytes(parseInt(progressMatch[3].replace(/,/g, "")));
        setInstallProgress({
          percent,
          downloaded,
          total,
          status: t("common.progressDownloading"),
        });
      }
      // Parse validation: "Validating files... 50%"
      const validateMatch = text.match(/[Vv]alidat\w*[^\d]*(\d+)%/);
      if (validateMatch) {
        setInstallProgress({
          percent: parseInt(validateMatch[1]),
          downloaded: "",
          total: "",
          status: t("common.progressValidating"),
        });
      }
      // Parse update state
      if (text.includes("Update state") && text.includes("verifying")) {
        setInstallProgress((prev) =>
          prev ? { ...prev, status: t("common.progressVerifying") } : null,
        );
      }
      if (text.includes("Success!") || text.includes("fully installed")) {
        setInstallProgress({
          percent: 100,
          downloaded: "",
          total: "",
          status: t("common.progressComplete"),
        });
      }
    };

    const handleInstallComplete = async (data: {
      success: boolean;
      message: string;
      installPath?: string;
      serverName?: string;
      zomboidDataPath?: string;
      serverConfigPath?: string;
      branch?: string;
      rconPort?: number;
      rconPassword?: string;
      serverPort?: number;
      minMemory?: number;
      maxMemory?: number;
      progressCode?: string;
      params?: Record<string, string | number>;
      warnings?: Array<{ progressCode?: string; message: string; params?: Record<string, string | number> }>;
    }) => {
      // The socket connection (and this handler) is the ONLY place that ever
      // learns the true outcome -- clear the in-flight marker on both success
      // and failure, not just success, so a reload after this point has
      // nothing stale left to warn about.
      clearInstallInFlightMarker();
      const displayMessage = getInstallProgressMessage(data, data.message);
      try {
        if (data.success) {
          setLogs((prev) => [
            ...prev,
            { type: "success", message: displayMessage, timestamp: new Date() },
            // The game files installed -- that's success:true and stays true --
            // but a self-healing step (RCON .ini pre-create, startup script)
            // may still have failed underneath it (#6, 2026-08-26 install-
            // failure hunt). Surfaced here rather than silently dropped: the
            // operator sees exactly what didn't get written and that it's
            // retried automatically, instead of either a false "everything is
            // ready" or a false "the install failed".
            ...(data.warnings ?? []).map((w) => ({
              type: 'warning' as const,
              message: getInstallProgressMessage({ progressCode: w.progressCode, params: w.params }, w.message),
              timestamp: new Date(),
            })),
          ]);

          const s = formStateRef.current;
          let createResult: Awaited<ReturnType<typeof serversApi.create>>;
          try {
            // Use data from server response which has computed paths
            createResult = await serversApi.create({
              name: data.serverName || s.serverName,
              serverName: data.serverName || s.serverName,
              installPath: data.installPath || s.installPath,
              zomboidDataPath: data.zomboidDataPath || null,
              serverConfigPath: data.serverConfigPath || null,
              branch: data.branch,
              rconHost: "127.0.0.1",
              rconPort: data.rconPort || s.rconPort,
              rconPassword: data.rconPassword || s.rconPassword,
              adminPassword: s.adminPassword,
              serverPort: data.serverPort || s.serverPort,
              minMemory: (data.minMemory || s.minMemory) * 1024,
              maxMemory: (data.maxMemory || s.maxMemory) * 1024,
              useNoSteam: s.useNoSteam,
              useDebug: s.useDebug,
              useUpnp: s.useUpnp,
            });
            setLogs((prev) => [
              ...prev,
              {
                type: "success",
                message: t("toasts.serverRegisteredLog"),
                timestamp: new Date(),
              },
            ]);
          } catch (error) {
            reportClientError("Failed to create server entry.", error);
            setLogs((prev) => [
              ...prev,
              {
                type: "error",
                message: t("toasts.registerFailedLog"),
                timestamp: new Date(),
              },
            ]);
            toast({
              title: t("toasts.registerFailedTitle"),
              description: t("toasts.registerFailedDesc"),
              variant: "destructive",
            });
            return;
          }

          // Activate the newly created server so "Start Server Now" starts this
          // one. This is a SEPARATE try/catch from the create() above: the
          // server entry above already exists at this point, so a failure here
          // must never be reported as "failed to create server entry" (#2 in
          // the 2026-08-26 install-failure hunt) -- that told a user the whole
          // registration failed when only the auto-activate step had. Also
          // deliberately skip setInstallComplete(true)/the success toast on
          // this path: "Start Server Now" below assumes the server it just
          // installed is the active one, and offering that shortcut here would
          // aim it at whatever was active before (or nothing).
          if (createResult.server?.id) {
            try {
              await serversApi.activate(createResult.server.id);
              setLogs((prev) => [
                ...prev,
                {
                  type: "success",
                  message: t("toasts.activeServerSwitchedLog"),
                  timestamp: new Date(),
                },
              ]);
            } catch (error) {
              reportClientError("Failed to activate newly created server.", error);
              setLogs((prev) => [
                ...prev,
                {
                  type: "error",
                  message: t("toasts.activateFailedLog"),
                  timestamp: new Date(),
                },
              ]);
              toast({
                title: t("toasts.activateFailedTitle"),
                description: t("toasts.activateFailedDesc"),
                variant: "destructive",
              });
              return;
            }
          }

          setInstallComplete(true);
          toast({
            title: t("toasts.serverInstalledTitle"),
            description: t("toasts.serverInstalledDesc"),
          });
        } else {
          setInstallComplete(false);
          setLogs((prev) => [
            ...prev,
            { type: "error", message: displayMessage, timestamp: new Date() },
          ]);
          toast({
            title: t("toasts.installationFailedTitle"),
            description: displayMessage,
            variant: "destructive",
          });
        }
      } finally {
        // Only clear once the full outcome (including the create()/activate()
        // awaits above on the success path) has settled -- clearing this
        // eagerly re-enabled the Install button while server registration was
        // still in flight, letting a second click wipe the in-flight logs and
        // fire a second real SteamCMD install underneath the first.
        setInstalling(false);
        setInstallStalled(false);
        setInstallViaSteamCmd(false);
      }
    };

    socket.on("install:log", handleInstallLog);
    socket.on("install:complete", handleInstallComplete);

    const handleSteamCmdStatus = (data: {
      status: string;
      message: string;
      path?: string;
      progressCode?: string;
      params?: Record<string, string | number>;
    }) => {
      downloadLastActivityRef.current = Date.now();
      setDownloadStalled(false);
      const displayMessage = getInstallProgressMessage(data, data.message);
      setSteamCmdStatus(displayMessage);
      // windows-steamcmd-selfheal client wiring, 2026-09-10: steamCmdStatus
      // (set above) only ever RENDERS inside Step 1's own "no SteamCMD yet"
      // panel (the manual-download button's label) -- once the operator has
      // hasSteamCmd===true and reaches Step 2, that panel is unmounted, so
      // these same events updating steamCmdStatus were invisible on screen.
      // Self-heal triggered from handleInstall (Step 2, POST /install) emits
      // these exact events while installViaSteamCmd is true -- gated on that
      // ref (not unconditional) so Step 1's own manual-download flow, which
      // already has its own dedicated status display, isn't handed a second,
      // redundant log surface it was never showing before.
      if (installViaSteamCmdRef.current) {
        addLog(
          data.status === "complete"
            ? "success"
            : data.status === "error"
              ? "error"
              : "info",
          displayMessage,
        );
      }
      if (data.status === "complete" && data.path) {
        setSteamCmdPath(data.path);
        setHasSteamCmd(true);
        setDownloadingSteamCmd(false);
        toast({
          title: t("toasts.steamCmdReadyTitle"),
          description: t("toasts.steamCmdReadyDesc"),
        });
      } else if (data.status === "error") {
        setDownloadingSteamCmd(false);
        toast({
          title: t("toasts.steamCmdFailedTitle"),
          description: displayMessage,
          variant: "destructive",
        });
      }
    };

    const handleSteamCmdLog = (data: {
      type: string;
      text: string;
      progressCode?: string;
      params?: Record<string, string | number>;
    }) => {
      downloadLastActivityRef.current = Date.now();
      setDownloadStalled(false);
      setSteamCmdStatus(getInstallProgressMessage(data, data.text.trim()));
      // Same reasoning as handleSteamCmdStatus above -- raw SteamCMD
      // stdout/stderr lines from the self-heal step were equally invisible
      // during a Step-2-triggered install. Reuses handleInstallLog's own
      // type mapping (data.type is "stdout"/"stderr", passed straight
      // through, not re-labeled "info") for consistency with how the same
      // raw-line shape already renders elsewhere on this page.
      if (installViaSteamCmdRef.current) {
        addLog(
          data.type === "stderr" ? "stderr" : "stdout",
          getInstallProgressMessage(data, data.text.trim()),
        );
      }
    };

    socket.on("steamcmd:status", handleSteamCmdStatus);
    socket.on("steamcmd:log", handleSteamCmdLog);

    return () => {
      socket.off("install:log", handleInstallLog);
      socket.off("install:complete", handleInstallComplete);
      socket.off("steamcmd:status", handleSteamCmdStatus);
      socket.off("steamcmd:log", handleSteamCmdLog);
    };
  }, [socket, toast, t]);

  // Watchdogs for the install:complete/steamcmd:status-never-arrives case
  // above -- see installStalled's own comment. Deliberately does NOT
  // re-enable the Install button (unlike Servers.tsx's steam dialog, which
  // had no other escape at all): a second click here would launch a second
  // real SteamCMD install racing whatever the first one is still doing.
  // Reload is already a safe, built recovery path (see resumeMarker/the
  // in-flight marker above), so the fix is just to stop being silent about
  // it -- surface a warning in the live log and point the user at that path.
  useEffect(() => {
    if (!installViaSteamCmd) return;
    const INSTALL_STALL_MS = 3 * 60 * 1000;
    const interval = setInterval(() => {
      if (Date.now() - installLastActivityRef.current >= INSTALL_STALL_MS) {
        setInstallStalled(true);
      }
    }, 15000);
    return () => clearInterval(interval);
  }, [installViaSteamCmd]);

  useEffect(() => {
    if (!installStalled) return;
    addLog("warning", t("full.step4.installStalledLog"));
  }, [installStalled, t]);

  useEffect(() => {
    if (!downloadingSteamCmd) return;
    const DOWNLOAD_STALL_MS = 3 * 60 * 1000;
    const interval = setInterval(() => {
      if (Date.now() - downloadLastActivityRef.current >= DOWNLOAD_STALL_MS) {
        setDownloadStalled(true);
      }
    }, 15000);
    return () => clearInterval(interval);
  }, [downloadingSteamCmd]);

  // Same "don't stay silent" fix as installStalled, surfaced directly on
  // the download button's own status text rather than a separate banner.
  useEffect(() => {
    if (!downloadStalled) return;
    setSteamCmdStatus(t("full.step1.downloadStalledStatus"));
  }, [downloadStalled, t]);

  const addLog = (type: InstallLog["type"], message: string) => {
    setLogs((prev) => [...prev, { type, message, timestamp: new Date() }]);
  };

  const handleAutoDownloadSteamCmd = async () => {
    if (!canInstall) return;
    setDownloadingSteamCmd(true);
    setDownloadStalled(false);
    downloadLastActivityRef.current = Date.now();
    setSteamCmdStatus(t("toasts.startingDownloadLog"));
    try {
      await serverApi.downloadSteamCmd(steamCmdPath);
    } catch (error) {
      setDownloadingSteamCmd(false);
      setDownloadStalled(false);
      toast({
        title: t("toasts.downloadFailedTitle"),
        description: getUserErrorMessage(error, t("toasts.downloadFailedFallback")),
        variant: "destructive",
      });
    }
  };

  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseSetter, setBrowseSetter] = useState<{
    fn: (path: string) => void;
    title: string;
    initial?: string;
  } | null>(null);

  const handleBrowseFolder = (
    setter: (path: string) => void,
    description: string,
    currentPath?: string,
  ) => {
    setBrowseSetter({ fn: setter, title: description, initial: currentPath });
    setBrowseOpen(true);
  };

  const handleAutoDetectRam = async () => {
    setDetectingRam(true);
    try {
      const data = await debugApi.getRam();
      setSystemRam({
        totalGB: data.totalGB,
        freeGB: data.freeGB,
        recommendedMin: data.recommendedMin,
        recommendedMax: data.recommendedMax,
      });
      setMinMemory(data.recommendedMin);
      setMaxMemory(data.recommendedMax);
    } catch {
      // Silent fail - defaults are fine
    } finally {
      setDetectingRam(false);
    }
  };

  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopyPassword = () => {
    copyText(rconPassword);
    setCopiedPassword(true);
    toast({
      title: t("toasts.passwordCopiedTitle"),
      description: t("toasts.passwordCopiedDesc"),
    });
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopiedPassword(false), 2000);
  };

  useEffect(
    () => () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    },
    [],
  );

  const handleRegeneratePassword = () => {
    setRconPassword(generatePassword(12));
    toast({
      title: t("toasts.passwordGeneratedTitle"),
      description: t("toasts.passwordGeneratedDesc"),
    });
  };

  const handleInstall = async () => {
    if (!canInstall) return;
    if (!adminPassword) {
      toast({
        title: t("toasts.adminPasswordRequiredTitle"),
        description: t("toasts.adminPasswordRequiredInstallDesc"),
        variant: "destructive",
      });
      return;
    }
    if (!isValidGamePort(serverPort) || !isValidInstallPort(rconPort)) {
      toast({
        title: t("toasts.invalidPortTitle"),
        description: t("toasts.invalidPortDesc"),
        variant: "destructive",
      });
      return;
    }
    setInstalling(true);
    setInstallStalled(false);
    setInstallViaSteamCmd(true);
    installLastActivityRef.current = Date.now();
    setLogs([]);
    setInstallProgress(null);
    addLog("info", t("toasts.startingInstallLog"));

    try {
      await serverApi.install({
        steamcmdPath: steamCmdPath,
        installPath,
        serverName,
        branch,
        zomboidDataPath: useCustomDataPath ? zomboidDataPath : null,
        minMemory,
        maxMemory,
        adminPassword: adminPassword || null,
        serverPort,
        useUpnp,
        useNoSteam,
        useDebug,
        rconPassword,
        rconPort,
      });
      // The request above only confirms SteamCMD was launched -- the real
      // outcome arrives later over the socket (see handleInstallComplete).
      // Remember that an install is in flight so a reload before then can
      // still tell the user something was attempted, instead of forgetting.
      writeInstallInFlightMarker({ installPath, serverName, startedAt: Date.now() });
    } catch (error) {
      const rawMessage = rawErrorMessageIntentional(error, t("common.unknownError"));
      const displayMessage = getUserErrorMessage(error, t("common.unknownError"));
      const msg = installationErrorGuidance(rawMessage, displayMessage, t, serverPlatform);
      addLog("error", msg);
      setInstalling(false);
      setInstallStalled(false);
      setInstallViaSteamCmd(false);
      toast({
        title: t("toasts.installationFailedTitle"),
        description: msg,
        variant: "destructive",
      });
    }
  };

  const handleQuickSetup = async () => {
    if (!canInstall) return;
    if (!adminPassword) {
      toast({
        title: t("toasts.adminPasswordRequiredTitle"),
        description: t("toasts.adminPasswordRequiredCreateDesc"),
        variant: "destructive",
      });
      return;
    }
    if (!isValidGamePort(serverPort) || !isValidInstallPort(rconPort)) {
      toast({
        title: t("toasts.invalidPortTitle"),
        description: t("toasts.invalidPortDesc"),
        variant: "destructive",
      });
      return;
    }
    setInstalling(true);
    setInstallComplete(false);
    setLogs([]);
    addLog("info", t("toasts.creatingConfigLog"));

    try {
      const data = await serverApi.quickSetup({
        installPath,
        serverName,
        zomboidDataPath: useCustomDataPath ? zomboidDataPath : null,
        minMemory,
        maxMemory,
        adminPassword: adminPassword || null,
        serverPort,
        useUpnp,
        useNoSteam,
        useDebug,
        rconPassword,
        rconPort,
      });

      if (data) {
        addLog("success", t("toasts.configCreatedLog"));
        // Same shape as #6 in handleInstallComplete above: the server files
        // already existed (Quick Setup only registers a config for files
        // that are verified present) and stay fine even if a self-healing
        // step underneath failed -- surfaced, not silently dropped.
        for (const w of (data.warnings ?? []) as Array<{ progressCode?: string; message: string; params?: Record<string, string | number> }>) {
          addLog("warning", getInstallProgressMessage({ progressCode: w.progressCode, params: w.params }, w.message));
        }

        let createResult: Awaited<ReturnType<typeof serversApi.create>>;
        try {
          // Use data from server response which has computed paths
          createResult = await serversApi.create({
            name: data.serverName || serverName,
            serverName: data.serverName || serverName,
            installPath: data.installPath || installPath,
            zomboidDataPath: data.zomboidDataPath || null,
            serverConfigPath: data.serverConfigPath || null,
            rconHost: "127.0.0.1",
            rconPort: data.rconPort || rconPort,
            rconPassword: data.rconPassword || rconPassword,
            adminPassword,
            serverPort: data.serverPort || serverPort,
            minMemory: (data.minMemory || minMemory) * 1024,
            maxMemory: (data.maxMemory || maxMemory) * 1024,
            useNoSteam: useNoSteam,
            useDebug: useDebug,
            useUpnp: useUpnp,
          });
          addLog("success", t("toasts.serverRegisteredLog"));
        } catch (error) {
          reportClientError("Failed to create server entry.", error);
          addLog("error", t("toasts.registerFailedLog"));
          toast({
            title: t("toasts.registerFailedTitle"),
            description: t("toasts.registerFailedDesc"),
            variant: "destructive",
          });
          return;
        }

        // Separate try/catch from create() above -- same reasoning as #2 in
        // handleInstallComplete: the server entry already exists at this
        // point, so an activate() failure must never be reported as
        // "failed to create server entry". "Start Server Now" is only
        // offered once activation genuinely succeeds, since it assumes the
        // just-configured server is the active one.
        if (createResult.server?.id) {
          try {
            await serversApi.activate(createResult.server.id);
            addLog("success", t("toasts.activeServerSwitchedLog"));
          } catch (error) {
            reportClientError("Failed to activate newly created server.", error);
            addLog("error", t("toasts.activateFailedLog"));
            toast({
              title: t("toasts.activateFailedTitle"),
              description: t("toasts.activateFailedDesc"),
              variant: "destructive",
            });
            return;
          }
        }

        setInstallComplete(true);
        toast({
          title: t("toasts.serverAddedTitle"),
          description: t("toasts.serverAddedDesc"),
        });
      } else {
        addLog("error", data.error);
        toast({
          title: t("toasts.setupFailedTitle"),
          description: data.error,
          variant: "destructive",
        });
      }
    } catch (error) {
      const msg = getUserErrorMessage(error, t("toasts.unexpectedSetupError"));
      addLog("error", msg);
      toast({
        title: t("toasts.setupFailedTitle"),
        description: msg,
        variant: "destructive",
      });
    } finally {
      setInstalling(false);
    }
  };

  const handleSaveSteamCmdPath = async () => {
    if (!canSaveSteamCmdPath) return;
    try {
      await configApi.updateAppSettings({ steamcmdPath: steamCmdPath });
      setHasSteamCmd(true);
      toast({
        title: t("toasts.pathSavedTitle"),
        description: t("toasts.pathSavedDesc"),
      });
    } catch {
      toast({
        title: t("toasts.saveFailedTitle"),
        description: t("toasts.saveFailedDesc"),
        variant: "destructive",
      });
    }
  };

  // Shared by both post-install "Start Server Now" buttons (full-wizard and
  // quick-setup completion screens) -- was duplicated inline at each render
  // site before this gate; extracted so the server.control guard lives in
  // one place instead of needing to be copied into two identical blocks.
  const handleStartServerNow = async () => {
    if (!canControlServer) return;
    setStartingServer(true);
    try {
      await serverApi.start();
      toast({
        title: t("toasts.serverStartingTitle"),
        description: t("toasts.serverStartingDesc"),
      });
      navigateTimerRef.current = setTimeout(() => navigate("/"), 2000);
    } catch (error) {
      toast({
        title: t("toasts.startFailedTitle"),
        description: getUserErrorMessage(error, t("common.unknownError")),
        variant: "destructive",
      });
    } finally {
      setStartingServer(false);
    }
  };

  // Resume-banner actions -- see resumeMarker/readInstallInFlightMarker above.
  const handleResumeContinue = () => {
    if (!resumeMarker) return;
    setInstallPath(resumeMarker.installPath);
    setServerName(resumeMarker.serverName);
    setSetupMode("full");
    setCurrentStep(2); // Server Config -- where installPath/serverName live
    setResumeMarker(null);
  };

  const handleResumeDismiss = () => {
    clearInstallInFlightMarker();
    setResumeMarker(null);
  };

  // Mode selection screen
  if (setupMode === "select") {
    return (
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="text-center space-y-3">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full bg-primary"
              aria-hidden="true"
            />
            {t("modeSelect.badge")}
          </span>
          <h1 className="text-3xl font-bold">{t("modeSelect.title")}</h1>
          <p className="text-muted-foreground text-base">
            {t("modeSelect.description")}
          </p>
        </div>

        {resumeMarker && (
          <Alert variant="warning" className="text-start">
            <AlertTriangle className="w-4 h-4" />
            <AlertTitle>{t("resumeBanner.title")}</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>
                {t("resumeBanner.description", {
                  installPath: resumeMarker.installPath,
                  elapsed: formatUptime(
                    Math.max(0, Math.floor((Date.now() - resumeMarker.startedAt) / 1000)),
                  ),
                })}
              </p>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleResumeContinue}>
                  {t("resumeBanner.continueButton")}
                </Button>
                <Button size="sm" variant="outline" onClick={handleResumeDismiss}>
                  {t("resumeBanner.dismissButton")}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-6 md:grid-cols-2">
          {/* Full Install Card */}
          {(() => {
            const activate = () => {
              setSetupMode("full");
              setCurrentStep(1);
            };

            return (
              <Card
                role="button"
                tabIndex={0}
                aria-describedby="full-setup-description"
                className="group relative overflow-hidden cursor-pointer border-primary/35 bg-gradient-to-br from-primary/[0.06] via-card to-card ring-1 ring-primary/15 transition-[border-color,box-shadow,transform] hover:border-primary/55 hover:ring-primary/25 hover:shadow-lg hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                onClick={activate}
                onKeyDown={(event) => handleCardKeyDown(event, activate)}
              >
                <div
                  className="absolute top-0 inset-x-0 h-[3px] bg-gradient-to-r from-primary via-primary/80 to-primary/40"
                  aria-hidden="true"
                />
                <div className="absolute right-3 top-3">
                  <Badge
                    variant="secondary"
                    className="text-[10px] font-medium uppercase tracking-wide"
                  >
                    {t("modeSelect.fullCard.recommendedBadge")}
                  </Badge>
                </div>
                <CardHeader className="pb-3">
                  <div className="grid place-items-center w-11 h-11 rounded-md border border-primary/30 bg-primary/[0.08] text-primary mb-3 transition-colors group-hover:bg-primary/15">
                    <Download className="w-5 h-5" />
                  </div>
                  <CardTitle className="text-lg">{t("modeSelect.fullCard.title")}</CardTitle>
                  <CardDescription
                    id="full-setup-description"
                    className="text-xs"
                  >
                    {t("modeSelect.fullCard.description")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 pb-5">
                  <ul className="space-y-1.5 text-[13px]">
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
                      <span>
                        {t("modeSelect.fullCard.bullet1")}{" "}
                        <span className="text-foreground/60">{t("modeSelect.fullCard.bullet1Size")}</span>
                      </span>
                    </li>
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
                      <span>{t("modeSelect.fullCard.bullet2")}</span>
                    </li>
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
                      <span>
                        {t("modeSelect.fullCard.bullet3")}
                      </span>
                    </li>
                  </ul>
                  <div className="flex items-center gap-1.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-primary/90">
                    {t("modeSelect.fullCard.cta")}{" "}
                    <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          {/* Quick Setup Card */}
          {(() => {
            const activate = () => {
              setSetupMode("quick");
              setCurrentStep(1);
            };

            return (
              <Card
                role="button"
                tabIndex={0}
                aria-describedby="quick-setup-description"
                className="group relative overflow-hidden cursor-pointer border-border/60 bg-card transition-[border-color,box-shadow,transform] hover:border-primary/40 hover:shadow-md hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                onClick={activate}
                onKeyDown={(event) => handleCardKeyDown(event, activate)}
              >
                <CardHeader className="pb-3">
                  <div className="grid place-items-center w-11 h-11 rounded-md border border-border/55 bg-muted/40 text-muted-foreground mb-3 transition-colors group-hover:border-primary/30 group-hover:bg-primary/[0.06] group-hover:text-primary">
                    <Plus className="w-5 h-5" />
                  </div>
                  <CardTitle className="text-lg">{t("modeSelect.quickCard.title")}</CardTitle>
                  <CardDescription
                    id="quick-setup-description"
                    className="text-xs"
                  >
                    {t("modeSelect.quickCard.description")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 pb-5">
                  <ul className="space-y-1.5 text-[13px]">
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-muted-foreground/70 shrink-0" />
                      <span>{t("modeSelect.quickCard.bullet1")}</span>
                    </li>
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-muted-foreground/70 shrink-0" />
                      <span>{t("modeSelect.quickCard.bullet2")}</span>
                    </li>
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-muted-foreground/70 shrink-0" />
                      <span>{t("modeSelect.quickCard.bullet3")}</span>
                    </li>
                  </ul>
                  <div className="flex items-center gap-1.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground transition-colors group-hover:text-primary/90">
                    {t("modeSelect.quickCard.cta")}{" "}
                    <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
                  </div>
                </CardContent>
              </Card>
            );
          })()}
        </div>

        {/* Quick Tips */}
        <Card className="bg-secondary/40 border-border/70 shadow-sm">
          <CardContent className="pt-6">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg border border-primary/20 bg-primary/10 flex items-center justify-center shrink-0">
                <Info className="w-5 h-5 text-primary" />
              </div>
              <div className="space-y-1">
                <p className="font-medium">{t("modeSelect.tips.title")}</p>
                <p className="text-sm text-muted-foreground">
                  <Trans i18nKey="modeSelect.tips.description" t={t} components={{ 1: <strong /> }} />
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Step indicator
  const renderStepIndicator = () => {
    const steps =
      setupMode === "quick"
        ? [
            { id: 1, label: t("stepIndicator.quick.location"), icon: HardDrive },
            { id: 2, label: t("stepIndicator.quick.configure"), icon: Settings2 },
            { id: 3, label: t("stepIndicator.quick.create"), icon: Plus },
          ]
        : [
            { id: 1, label: t("stepIndicator.full.steamcmd"), icon: Download },
            { id: 2, label: t("stepIndicator.full.server"), icon: Server },
            { id: 3, label: t("stepIndicator.full.settings"), icon: Settings2 },
            { id: 4, label: t("stepIndicator.full.install"), icon: Zap },
          ];

    return (
      <div className="flex items-center justify-center mb-8">
        <div className="flex items-center gap-0">
          {steps.map((step, index) => {
            const Icon = step.icon;
            const isActive = currentStep === step.id;
            const isComplete = currentStep > step.id;
            const isClickable =
              step.id <= currentStep ||
              stepValidation[step.id as keyof typeof stepValidation];

            return (
              <div key={step.id} className="flex items-center">
                <button
                  onClick={() => isClickable && setCurrentStep(step.id)}
                  disabled={!isClickable}
                  aria-current={isActive ? "step" : undefined}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 sm:px-3.5 sm:py-2 rounded-full border transition-colors",
                    isActive &&
                      "border-primary bg-primary text-primary-foreground shadow-sm",
                    !isActive &&
                      isComplete &&
                      "border-primary/40 bg-primary/[0.08] text-primary",
                    !isActive &&
                      !isComplete &&
                      "border-border/50 bg-muted/30 text-muted-foreground",
                    isClickable &&
                      !isActive &&
                      "hover:border-primary/40 hover:bg-muted/60 cursor-pointer",
                  )}
                >
                  {isComplete ? (
                    <CheckCircle className="w-4 h-4" />
                  ) : (
                    <Icon className="w-4 h-4" />
                  )}
                  <span className="text-[11px] font-medium uppercase tracking-wide hidden sm:inline">
                    {step.label}
                  </span>
                </button>
                {index < steps.length - 1 && (
                  <span
                    className={cn(
                      "w-6 sm:w-10 h-px mx-1",
                      isComplete ? "bg-primary/50" : "bg-border/60",
                    )}
                    aria-hidden="true"
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Full Install Step 1: SteamCMD
  const renderFullStep1 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">{t("full.step1.title")}</h2>
        <p className="text-muted-foreground">
          {t("full.step1.description")}
        </p>
      </div>

      {!hasSteamCmd ? (
        <div className="space-y-6">
          {/* One-Click Setup */}
          <Card className="border-primary/35 bg-card shadow-sm">
            <CardContent className="pt-6">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center shrink-0">
                  <Sparkles className="w-6 h-6 text-primary" />
                </div>
                <div className="flex-1 space-y-4">
                  <div>
                    <h3 className="font-semibold text-lg">{t("full.step1.oneClickTitle")}</h3>
                    <p className="text-sm text-muted-foreground">
                      {t("full.step1.oneClickDesc")}
                    </p>
                  </div>

                  <div className="flex gap-2 items-center">
                    <Input
                      value={steamCmdPath}
                      onChange={(e) => setSteamCmdPath(e.target.value)}
                      placeholder={t("full.step1.pathPlaceholder")}
                      className="font-mono flex-1"
                      disabled={downloadingSteamCmd}
                      maxLength={260}
                    />
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={() =>
                              handleBrowseFolder(
                                setSteamCmdPath,
                                t("common.selectSteamCmdFolderTitle"),
                                steamCmdPath,
                              )
                            }
                            disabled={downloadingSteamCmd}
                            aria-label={t("common.browseFolderAriaSteamCmd")}
                          >
                            <FolderOpen className="w-4 h-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("common.browseFolder")}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>

                  <DisabledReason reason={!canInstall ? t("common.noPermissionInstall") : null}>
                    <Button
                      onClick={handleAutoDownloadSteamCmd}
                      disabled={downloadingSteamCmd || !canInstall}
                      className="w-full"
                      size="lg"
                    >
                      {downloadingSteamCmd ? (
                        <>
                          <Loader2 className="w-4 h-4 me-2 animate-spin" />
                          {steamCmdStatus || t("full.step1.installingButton")}
                        </>
                      ) : (
                        <>
                          <Download className="w-4 h-4 me-2" />
                          {t("full.step1.installButton")}
                        </>
                      )}
                    </Button>
                  </DisabledReason>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Manual Setup Accordion */}
          <Accordion type="single" collapsible className="border rounded-lg">
            <AccordionItem value="manual" className="border-0">
              <AccordionTrigger className="px-4 hover:no-underline">
                <div className="flex items-center gap-2">
                  <Settings2 className="w-4 h-4" />
                  <span>{t("full.step1.manualTrigger")}</span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="px-4 pb-4">
                <div className="space-y-4">
                  <div className="bg-warning/10 border border-warning/40 rounded-lg p-4 text-sm shadow-sm">
                    <p className="font-medium text-warning">{t("full.step1.manualTitle")}</p>
                    <ol className="list-decimal list-inside space-y-1 text-muted-foreground mt-2">
                      <li>{t("full.step1.manualStep1")}</li>
                      <li>
                        <Trans i18nKey={platformTranslationKey("full.step1.manualStep2", runtimeInfo?.family)} t={t} components={{ 1: <code className="bg-muted px-1 rounded" /> }} />
                      </li>
                      <li>
                        <Trans i18nKey="full.step1.manualStep3" t={t} components={{ 1: <code className="bg-muted px-1 rounded" /> }} />
                      </li>
                    </ol>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() =>
                        window.open(
                          "https://developer.valvesoftware.com/wiki/SteamCMD#Downloading_SteamCMD",
                          "_blank",
                        )
                      }
                    >
                      <Download className="w-4 h-4 me-2" />
                      {t("full.step1.downloadButton")}
                      <ExternalLink className="w-3 h-3 ms-2" />
                    </Button>
                  </div>

                  <div className="flex gap-2">
                    <Input
                      value={steamCmdPath}
                      onChange={(e) => setSteamCmdPath(e.target.value)}
                      placeholder={t("full.step1.manualPathPlaceholder")}
                      className="font-mono flex-1"
                      maxLength={260}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() =>
                        handleBrowseFolder(
                          setSteamCmdPath,
                          t("common.selectSteamCmdFolderTitle"),
                          steamCmdPath,
                        )
                      }
                      aria-label={t("common.browseFolderAriaSteamCmd")}
                    >
                      <FolderOpen className="w-4 h-4" />
                    </Button>
                    <DisabledReason reason={!canSaveSteamCmdPath ? t("common.noPermissionSettings") : null}>
                      <Button onClick={handleSaveSteamCmdPath} disabled={!canSaveSteamCmdPath}>
                        {t("full.step1.savePathButton")}
                      </Button>
                    </DisabledReason>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      ) : (
        <Card className="border-primary/30 bg-card shadow-sm">
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl border border-primary/25 bg-primary/14 flex items-center justify-center">
                <CheckCircle className="w-6 h-6 text-primary" />
              </div>
              <div className="flex-1">
                <p className="font-semibold">{t("full.step1.readyTitle")}</p>
                <p className="text-sm text-muted-foreground font-mono">
                  {steamCmdPath}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setHasSteamCmd(false)}
              >
                {t("full.step1.changePathButton")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );

  // Full Install Step 2: Server Location & Name
  const renderFullStep2 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">{t("full.step2.title")}</h2>
        <p className="text-muted-foreground">
          {t("full.step2.description")}
        </p>
      </div>

      <div className="grid gap-6">
        {/* Installation Path */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <Label className="text-base">{t("full.step2.installFolderLabel")}</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto px-0 text-xs"
              onClick={() => setInstallPath(LINUX_SERVICE_INSTALL_PATH)}
            >
              {t("full.step2.useLinuxPath")}
            </Button>
          </div>
          <div className="flex gap-2">
            <Input
              value={installPath}
              onChange={(e) => setInstallPath(e.target.value)}
              placeholder={t(platformTranslationKey("full.step2.installFolderPlaceholder", runtimeInfo?.family))}
              className="font-mono flex-1"
              maxLength={260}
            />
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() =>
                      handleBrowseFolder(
                        setInstallPath,
                        t("common.selectServerFolderTitle"),
                        installPath,
                      )
                    }
                    aria-label={t("common.browseFolderAriaInstall")}
                  >
                    <FolderOpen className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("common.browseFolder")}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("full.step2.installFolderHelp")}
          </p>
        </div>

        <div className="border border-border/60 bg-muted/40 rounded-lg p-4 text-sm space-y-2">
          <p className="font-medium flex items-center gap-2">
            <Info className="w-4 h-4 text-primary" />
            {t("full.step2.linuxNoteTitle")}
          </p>
          <p className="text-muted-foreground">
            <Trans
              i18nKey="full.step2.linuxNoteBody1"
              t={t}
              values={{ path: LINUX_SERVICE_INSTALL_PATH }}
              components={{ 1: <code className="bg-muted px-1 rounded" /> }}
            />
          </p>
          <p className="text-muted-foreground">
            <Trans
              i18nKey="full.step2.linuxNoteBody2"
              t={t}
              values={{ path: installPath.trim() ? `${installPath.trim()}_Data` : t("full.step2.dataFolderPlaceholder") }}
              components={{ 1: <code className="bg-muted px-1 rounded break-all" /> }}
            />
          </p>
        </div>

        {/* Server Name */}
        <div className="space-y-2">
          <Label className="text-base">{t("common.serverNameLabel")}</Label>
          <Input
            value={serverName}
            onChange={(e) =>
              setServerName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))
            }
            placeholder={t("common.serverNamePlaceholder")}
            className="font-mono"
            maxLength={64}
          />
          <p className="text-xs text-muted-foreground">
            {t("full.step2.serverNameHelp")}
          </p>
        </div>

        {/* Branch Selection */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Label className="text-base">{t("full.step2.gameVersionLabel")}</Label>
            <HelpTip label={t("full.step2.gameVersionLabel")}>{t("full.step2.gameVersionHelp")}</HelpTip>
          </div>
          <Select
            value={branch}
            onValueChange={setBranch}
            disabled={loadingBranches}
          >
            <SelectTrigger>
              <SelectValue
                placeholder={
                  loadingBranches
                    ? t("full.step2.loadingVersions")
                    : t("full.step2.selectVersion")
                }
              />
            </SelectTrigger>
            <SelectContent>
              {availableBranches.map((b) => (
                <SelectItem key={b.name} value={b.name}>
                  <div className="flex flex-col">
                    <span>
                      {b.name === "public"
                        ? t("full.step2.buildStable")
                        : b.description || b.name}
                    </span>
                    {b.buildId && (
                      <span className="text-xs text-muted-foreground">
                        {t("full.step2.buildLabel", { buildId: b.buildId })}
                      </span>
                    )}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Custom Data Path - Collapsed by default */}
        <Accordion type="single" collapsible className="border rounded-lg">
          <AccordionItem value="datapath" className="border-0">
            <AccordionTrigger className="px-4 hover:no-underline">
              <div className="flex items-center gap-2 text-sm">
                <FolderOpen className="w-4 h-4" />
                <span>{t("full.step2.customDataLocation")}</span>
                {useCustomDataPath && zomboidDataPath && (
                  <Badge variant="secondary" className="ms-2">
                    {t("full.step2.setBadge")}
                  </Badge>
                )}
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4">
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  {t("full.step2.customDataHelp")}
                </p>
                <div className="flex items-center gap-3">
                  <Switch
                    checked={useCustomDataPath}
                    onCheckedChange={setUseCustomDataPath}
                  />
                  <Label>{t("common.useCustomLocation")}</Label>
                </div>
                {useCustomDataPath && (
                  <>
                    <div className="flex gap-2">
                      <Input
                        value={zomboidDataPath}
                        onChange={(e) => setZomboidDataPath(e.target.value)}
                        placeholder={t(platformTranslationKey("common.customDataPathPlaceholder", runtimeInfo?.family))}
                        className="font-mono flex-1"
                        maxLength={260}
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() =>
                          handleBrowseFolder(
                            setZomboidDataPath,
                            t("common.selectConfigFolderTitle"),
                            zomboidDataPath,
                          )
                        }
                        aria-label={t("common.browseFolderAriaConfig")}
                      >
                        <FolderOpen className="w-4 h-4" />
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("common.customConfigLocationHelp")}
                    </p>
                  </>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </div>
  );

  // Full Install Step 3: RCON & Performance
  const renderFullStep3 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">{t("full.step3.title")}</h2>
        <p className="text-muted-foreground">
          {t("full.step3.description")}
        </p>
      </div>

      {/* RCON Section - Critical */}
      <Card className="border-primary/35 bg-card shadow-sm">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary" />
            <CardTitle className="text-lg">{t("full.step3.rconTitle")}</CardTitle>
            <Badge className="ms-auto">{t("common.requiredBadge")}</Badge>
          </div>
          <CardDescription>
            {t("full.step3.rconDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <Label>{t("common.rconPasswordLabel")}</Label>
                <HelpTip label={t("common.rconPasswordLabel")}>{t("common.rconPasswordHelp")}</HelpTip>
              </div>
              <div className="flex gap-1">
                <div className="relative flex-1">
                  <Input
                    type={showRconPassword ? "text" : "password"}
                    value={rconPassword}
                    onChange={(e) => setRconPassword(e.target.value)}
                    className="pe-10 font-mono"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1 h-9 w-9 p-0"
                    onClick={() => setShowRconPassword(!showRconPassword)}
                    aria-label={
                      showRconPassword
                        ? t("common.hideRconPassword")
                        : t("common.showRconPassword")
                    }
                  >
                    {showRconPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={handleCopyPassword}
                        aria-label={t("common.copyPasswordAria")}
                      >
                        {copiedPassword ? (
                          <Check className="w-4 h-4" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("common.copyPasswordTooltip")}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={handleRegeneratePassword}
                        aria-label={t("common.regeneratePasswordAria")}
                      >
                        <RefreshCw className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("common.regeneratePasswordTooltip")}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              {rconPassword.length > 0 && rconPassword.length < 6 && (
                <p className="text-xs text-destructive">{t("common.rconPasswordMinChars")}</p>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <Label>{t("common.rconPortLabel")}</Label>
                <HelpTip label={t("common.rconPortLabel")}>{t("common.rconPortHelp")}</HelpTip>
              </div>
              <NumberInput
                min={1024}
                max={65535}
                value={rconPort}
                onChange={setRconPort}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                {t("common.rconPortDefaultHint")}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Admin Password - Critical */}
      <Card className="border-primary/35 bg-card shadow-sm">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary" />
            <CardTitle className="text-lg">{t("common.adminPasswordLabel")}</CardTitle>
            <Badge className="ms-auto">{t("common.requiredBadge")}</Badge>
          </div>
          <CardDescription>{t("common.adminPasswordHelp")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="relative max-w-sm">
            <Input
              type={showAdminPassword ? "text" : "password"}
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              placeholder={t("common.adminPasswordPlaceholder")}
              className="pe-10"
              maxLength={128}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="absolute right-1 top-1 h-9 w-9 p-0"
              onClick={() => setShowAdminPassword(!showAdminPassword)}
              aria-label={
                showAdminPassword
                  ? t("common.hideAdminPassword")
                  : t("common.showAdminPassword")
              }
            >
              {showAdminPassword ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Memory Settings */}
      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cpu className="w-5 h-5" />
              <CardTitle className="text-lg">{t("common.memoryTitle")}</CardTitle>
            </div>
            {detectingRam ? (
              <Badge variant="outline" className="animate-pulse">
                {t("common.detectingRam")}
              </Badge>
            ) : (
              systemRam && (
                <Badge variant="outline">
                  {t("full.step3.ramDetectedBadge", { total: systemRam.totalGB })}
                </Badge>
              )
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  <Label>{t("common.minRamLabel")}</Label>
                  <HelpTip label={t("common.minRamLabel")}>{t("common.ramHelp")}</HelpTip>
                </div>
                <NumberInput
                  min={1}
                  max={64}
                  value={minMemory}
                  className="h-8 w-20 bg-background text-end font-mono"
                  clamp={n => Math.min(64, Math.max(1, n))}
                  onChange={value => {
                    setMinMemory(value)
                    if (value > maxMemory) setMaxMemory(value)
                  }}
                  aria-label={t("common.minRamAria")}
                />
              </div>
              <Slider
                value={[Math.min(Number.isFinite(minMemory) ? minMemory : 1, 64)]}
                onValueChange={([val]) => {
                  setMinMemory(val);
                  if (val > maxMemory) setMaxMemory(val);
                }}
                min={2}
                max={64}
                step={1}
                aria-label={t("common.minRamSliderAria", { value: minMemory })}
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <Label>{t("common.maxRamLabel")}</Label>
                <NumberInput
                  min={1}
                  max={128}
                  value={maxMemory}
                  className="h-8 w-20 bg-background text-end font-mono"
                  clamp={n => Math.min(128, Math.max(1, n))}
                  onChange={value => {
                    setMaxMemory(value)
                    if (value < minMemory) setMinMemory(value)
                  }}
                  aria-label={t("common.maxRamAria")}
                />
              </div>
              <Slider
                value={[Math.min(Number.isFinite(maxMemory) ? maxMemory : 1, 128)]}
                onValueChange={([val]) => {
                  setMaxMemory(val);
                  if (val < minMemory) setMinMemory(val);
                }}
                min={2}
                max={128}
                step={1}
                aria-label={t("common.maxRamSliderAria", { value: maxMemory })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Advanced Options - Collapsed */}
      <Accordion type="single" collapsible className="border rounded-lg">
        <AccordionItem value="advanced" className="border-0">
          <AccordionTrigger className="px-4 hover:no-underline">
            <div className="flex items-center gap-2">
              <Settings2 className="w-4 h-4" />
              <span>{t("common.advancedOptions")}</span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-4 pb-4 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <Label>{t("common.gamePortLabel")}</Label>
                  <HelpTip label={t("common.gamePortLabel")}>{t("common.gamePortHelp")}</HelpTip>
                </div>
                <NumberInput
                  min={1024}
                  max={65534}
                  value={serverPort}
                  onChange={setServerPort}
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  {t("common.gamePortDefaultHint")}
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="text-sm font-medium">{t("common.upnpLabel")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("common.upnpDesc")}
                  </p>
                </div>
                <Switch
                  checked={useUpnp}
                  onCheckedChange={setUseUpnp}
                  aria-label={t("common.upnpAria")}
                />
              </div>

              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="text-sm font-medium">{t("common.noSteamLabel")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("common.noSteamDesc")}
                  </p>
                </div>
                <Switch
                  checked={useNoSteam}
                  onCheckedChange={setUseNoSteam}
                  aria-label={t("common.noSteamAria")}
                />
              </div>

              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="text-sm font-medium">{t("common.debugLabel")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("common.debugDesc")}
                  </p>
                </div>
                <Switch
                  checked={useDebug}
                  onCheckedChange={setUseDebug}
                  aria-label={t("common.debugAria")}
                />
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );

  // Full Install Step 4: Review & Install
  const renderFullStep4 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">{t("full.step4.title")}</h2>
        <p className="text-muted-foreground">
          {t("full.step4.description")}
        </p>
      </div>

      {/* Summary */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid gap-3 text-sm">
            <div className="flex justify-between gap-3 py-2 border-b">
              <span className="text-muted-foreground shrink-0">{t("full.step4.summaryInstallPath")}</span>
              <span className="font-mono text-end min-w-0 flex-1 truncate" title={installPath}>
                {installPath}
              </span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{t("common.summaryServerName")}</span>
              <span className="font-mono">{serverName}</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{t("full.step4.summaryGameVersion")}</span>
              <span>{branch === "public" ? t("full.step2.buildStable") : branch}</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{t("common.summaryMemory")}</span>
              <span className="font-mono">
                {formatMemory(minMemory)}GB - {formatMemory(maxMemory)}GB
              </span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{t("common.summaryGamePort")}</span>
              <span className="font-mono">{formatPort(serverPort)}</span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-muted-foreground">{t("common.summaryRconPort")}</span>
              <span className="font-mono">{formatPort(rconPort)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Port Info */}
      <div className="bg-muted/50 border border-border/60 rounded-lg p-4 text-sm shadow-sm">
        <p className="font-medium flex items-center gap-2">
          <Info className="w-4 h-4 text-primary" />
          {t("full.step4.portInfoTitle")}
        </p>
        <p className="text-muted-foreground mt-1">
          {t("full.step4.portInfoIntro")}
        </p>
        <ul className="mt-2 space-y-1 text-muted-foreground">
          <li>
            • <code className="bg-muted px-1 rounded">{formatPort(serverPort)}</code> {t("full.step4.portInfoGame")}
          </li>
          <li>
            • <code className="bg-muted px-1 rounded">{formatPort(serverPort + 1)}</code>{" "}
            {t("full.step4.portInfoDirect")}
          </li>
        </ul>
      </div>

      {/* Install Button */}
      <DisabledReason reason={!canInstall ? t("common.noPermissionInstall") : null}>
        <Button
          onClick={handleInstall}
          disabled={installing || missingAdminPassword || !canInstall}
          className="w-full"
          size="lg"
        >
          {installing ? (
            <>
              <Loader2 className="w-4 h-4 me-2 animate-spin" />
              {t("full.step4.installingButton")}
            </>
          ) : (
            <>
              <Download className="w-4 h-4 me-2" />
              {t("full.step4.installButton")}
            </>
          )}
        </Button>
      </DisabledReason>

      {missingAdminPassword && (
        <p className="text-sm text-warning">
          {t("full.step4.missingAdminPassword")}
        </p>
      )}

      {/* Installation Progress Bar */}
      {installing && installProgress && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {installProgress.status}
            </span>
            <span className="font-mono">
              {installProgress.percent.toFixed(0)}%
              {installProgress.downloaded && installProgress.total && (
                <span className="text-muted-foreground ms-2">
                  ({installProgress.downloaded} / {installProgress.total})
                </span>
              )}
            </span>
          </div>
          <Progress value={installProgress.percent} className="h-2" />
        </div>
      )}

      {/* Installation Log */}
      {logs.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4" />
            <span className="text-sm font-medium">{t("full.step4.logTitle")}</span>
          </div>
          <ScrollArea className="h-[200px] bg-background rounded-lg p-3">
            <div className="font-mono text-xs space-y-0.5">
              {logs.map((log, i) => (
                <div
                  key={i}
                  className={cn(
                    log.type === "error" || log.type === "stderr"
                      ? "text-destructive"
                      : log.type === "warning"
                        ? "text-warning"
                        : log.type === "success"
                          ? "text-success"
                          : log.type === "command"
                            ? "text-primary"
                            : "text-foreground/80",
                  )}
                >
                  {log.message}
                </div>
              ))}
              {installing && (
                <div className="text-muted-foreground animate-pulse">...</div>
              )}
              <div ref={logsEndRef} />
            </div>
          </ScrollArea>
        </div>
      )}

      {/* Post-install */}
      {installComplete && (
        <Card className="border-primary/32 bg-card shadow-sm">
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-center gap-2 text-primary">
              <CheckCircle className="w-5 h-5" />
              <span className="font-medium">{t("full.step4.completeTitle")}</span>
            </div>

            {/* First-run setup notice */}
            <div className="bg-warning/10 border border-warning/40 rounded-lg p-4 text-sm shadow-sm">
              <p className="font-medium flex items-center gap-2 text-warning">
                <Info className="w-4 h-4" />
                {t("full.step4.firstStartTitle")}
              </p>
              <p className="text-muted-foreground mt-1">
                {t("full.step4.firstStartDesc")}
              </p>
            </div>

            <div className="flex gap-3">
              <DisabledReason reason={!canControlServer ? t("common.noPermissionControl") : null}>
                <Button
                  onClick={handleStartServerNow}
                  disabled={startingServer || !canControlServer}
                  className="flex-1"
                >
                  {startingServer ? (
                    <>
                      <Loader2 className="w-4 h-4 me-2 animate-spin" />{" "}
                      {t("common.startingButton")}
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 me-2" /> {t("common.startServerButton")}
                    </>
                  )}
                </Button>
              </DisabledReason>
              <Button variant="outline" onClick={() => navigate("/")}>
                {t("common.openDashboardButton")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );

  // Quick Setup Step 1: Select Files
  const renderQuickStep1 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">{t("quick.step1.title")}</h2>
        <p className="text-muted-foreground">
          {t("quick.step1.description")}
        </p>
      </div>

      <Card className="bg-secondary/40 border-primary/24 shadow-sm">
        <CardContent className="pt-6">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-lg border border-primary/20 bg-primary/10 flex items-center justify-center shrink-0">
              <HardDrive className="w-5 h-5 text-primary" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">{t("quick.step1.usingExistingTitle")}</p>
              <p className="text-sm text-muted-foreground">
                <Trans
                  i18nKey={platformTranslationKey("quick.step1.usingExistingDesc", runtimeInfo?.family)}
                  t={t}
                  components={{
                    1: <code className="bg-muted px-1 rounded" />,
                    2: <code className="bg-muted px-1 rounded" />,
                    3: <code className="bg-muted px-1 rounded" />,
                  }}
                />
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-2">
        <Label className="text-base">{t("quick.step1.locationLabel")}</Label>
        <div className="flex gap-2">
          <Input
            value={installPath}
            onChange={(e) => setInstallPath(e.target.value)}
            placeholder={t("quick.step1.locationPlaceholder")}
            className="font-mono flex-1"
            maxLength={260}
          />
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() =>
                    handleBrowseFolder(
                      setInstallPath,
                      t("common.selectPzServerFolderTitle"),
                      installPath,
                    )
                  }
                  aria-label={t("common.browseFolderAriaServerFiles")}
                >
                  <FolderOpen className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("common.browseFolder")}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("quick.step1.locationHelp")}
        </p>
      </div>
    </div>
  );

  // Quick Setup Step 2: Configure
  const renderQuickStep2 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">{t("quick.step2.title")}</h2>
        <p className="text-muted-foreground">
          {t("quick.step2.description")}
        </p>
      </div>

      <div className="grid gap-6">
        {/* Server Name */}
        <div className="space-y-2">
          <Label className="text-base">{t("common.serverNameLabel")}</Label>
          <Input
            value={serverName}
            onChange={(e) =>
              setServerName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))
            }
            placeholder={t("common.serverNamePlaceholder")}
            className="font-mono"
            maxLength={64}
          />
          <p className="text-xs text-muted-foreground">
            {t("quick.step2.serverNameHelp")}
          </p>
        </div>

        {/* RCON - Critical */}
        <Card className="border-primary/35 bg-card shadow-sm">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-primary" />
              <CardTitle className="text-lg">{t("quick.step2.rconTitle")}</CardTitle>
              <Badge className="ms-auto">{t("common.requiredBadge")}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <Label>{t("common.rconPasswordLabel")}</Label>
                  <HelpTip label={t("common.rconPasswordLabel")}>{t("common.rconPasswordHelp")}</HelpTip>
                </div>
                <div className="flex gap-1">
                  <div className="relative flex-1">
                    <Input
                      type={showRconPassword ? "text" : "password"}
                      value={rconPassword}
                      onChange={(e) => setRconPassword(e.target.value)}
                      className="pe-10 font-mono"
                      maxLength={128}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-1 top-1 h-9 w-9 p-0"
                      onClick={() => setShowRconPassword(!showRconPassword)}
                      aria-label={
                        showRconPassword
                          ? t("common.hideRconPassword")
                          : t("common.showRconPassword")
                      }
                    >
                      {showRconPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={handleCopyPassword}
                          aria-label={t("common.copyPasswordAria")}
                        >
                          {copiedPassword ? (
                            <Check className="w-4 h-4" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t("common.copyPasswordTooltip")}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={handleRegeneratePassword}
                          aria-label={t("common.regeneratePasswordAria")}
                        >
                          <RefreshCw className="w-4 h-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t("common.regeneratePasswordTooltip")}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                {rconPassword.length > 0 && rconPassword.length < 6 && (
                  <p className="text-xs text-destructive">
                    {t("common.rconPasswordMinChars")}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <Label>{t("common.rconPortLabel")}</Label>
                  <HelpTip label={t("common.rconPortLabel")}>{t("common.rconPortHelp")}</HelpTip>
                </div>
                <NumberInput
                  min={1024}
                  max={65535}
                  value={rconPort}
                  onChange={setRconPort}
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  {t("quick.step2.rconPortDefaultHint")}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Admin Password - Critical */}
        <Card className="border-primary/35 bg-card shadow-sm">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-primary" />
              <CardTitle className="text-lg">{t("common.adminPasswordLabel")}</CardTitle>
              <Badge className="ms-auto">{t("common.requiredBadge")}</Badge>
            </div>
            <CardDescription>{t("common.adminPasswordHelp")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="relative max-w-sm">
              <Input
                type={showAdminPassword ? "text" : "password"}
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                placeholder={t("common.adminPasswordPlaceholder")}
                className="pe-10"
                maxLength={128}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-1 top-1 h-9 w-9 p-0"
                onClick={() => setShowAdminPassword(!showAdminPassword)}
                aria-label={
                  showAdminPassword
                    ? t("common.hideAdminPassword")
                    : t("common.showAdminPassword")
                }
              >
                {showAdminPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Memory */}
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu className="w-5 h-5" />
                <CardTitle className="text-lg">{t("common.memoryTitle")}</CardTitle>
              </div>
              {detectingRam ? (
                <Badge variant="outline" className="animate-pulse">
                  {t("common.detectingRam")}
                </Badge>
              ) : (
                systemRam && (
                  <Badge variant="outline">
                    {t("quick.step2.ramDetectedBadge", { total: systemRam.totalGB })}
                  </Badge>
                )
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-1.5">
                    <Label>{t("common.minRamLabel")}</Label>
                    <HelpTip label={t("common.minRamLabel")}>{t("common.ramHelp")}</HelpTip>
                  </div>
                  <NumberInput
                    min={1}
                    max={64}
                    value={minMemory}
                    className="h-8 w-20 bg-background text-end font-mono"
                    clamp={n => Math.min(64, Math.max(1, n))}
                    onChange={value => {
                      setMinMemory(value)
                      if (value > maxMemory) setMaxMemory(value)
                    }}
                    aria-label={t("common.minRamAria")}
                  />
                </div>
                <Slider
                  value={[Math.min(Number.isFinite(minMemory) ? minMemory : 1, 64)]}
                  onValueChange={([val]) => {
                    setMinMemory(val);
                    if (val > maxMemory) setMaxMemory(val);
                  }}
                  min={2}
                  max={64}
                  step={1}
                  aria-label={t("common.minRamSliderAria", { value: minMemory })}
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <Label>{t("common.maxRamLabel")}</Label>
                  <NumberInput
                    min={1}
                    max={128}
                    value={maxMemory}
                    className="h-8 w-20 bg-background text-end font-mono"
                    clamp={n => Math.min(128, Math.max(1, n))}
                    onChange={value => {
                      setMaxMemory(value)
                      if (value < minMemory) setMinMemory(value)
                    }}
                    aria-label={t("common.maxRamAria")}
                  />
                </div>
                <Slider
                  value={[Math.min(Number.isFinite(maxMemory) ? maxMemory : 1, 128)]}
                  onValueChange={([val]) => {
                    setMaxMemory(val);
                    if (val < minMemory) setMinMemory(val);
                  }}
                  min={2}
                  max={128}
                  step={1}
                  aria-label={t("common.maxRamSliderAria", { value: maxMemory })}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Advanced Options */}
        <Accordion type="single" collapsible className="border rounded-lg">
          <AccordionItem value="advanced" className="border-0">
            <AccordionTrigger className="px-4 hover:no-underline">
              <div className="flex items-center gap-2">
                <Settings2 className="w-4 h-4" />
                <span>{t("common.advancedOptions")}</span>
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4 space-y-4">
              <div className="flex items-center gap-3">
                <Switch
                  checked={useCustomDataPath}
                  onCheckedChange={setUseCustomDataPath}
                />
                <Label>{t("common.customConfigLocation")}</Label>
              </div>
              <p className="text-sm text-muted-foreground">
                {t("full.step2.customDataHelp")}
              </p>
              {useCustomDataPath && (
                <>
                  <div className="flex gap-2">
                    <Input
                      value={zomboidDataPath}
                      onChange={(e) => setZomboidDataPath(e.target.value)}
                      placeholder={t(platformTranslationKey("common.customDataPathPlaceholder", runtimeInfo?.family))}
                      className="font-mono flex-1"
                      maxLength={260}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() =>
                        handleBrowseFolder(
                          setZomboidDataPath,
                          t("common.selectConfigFolderTitle"),
                          zomboidDataPath,
                        )
                      }
                      aria-label={t("common.browseFolderAriaConfig")}
                    >
                      <FolderOpen className="w-4 h-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("common.customConfigLocationHelp")}
                  </p>
                </>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <Label>{t("common.gamePortLabel")}</Label>
                    <HelpTip label={t("common.gamePortLabel")}>{t("common.gamePortHelp")}</HelpTip>
                  </div>
                  <NumberInput
                    min={1024}
                    max={65534}
                    value={serverPort}
                    onChange={setServerPort}
                    className="font-mono"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("common.gamePortDefaultHint")}
                  </p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <div>
                    <p className="text-sm font-medium">{t("common.upnpLabel")}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("common.upnpDesc")}
                    </p>
                  </div>
                  <Switch
                    checked={useUpnp}
                    onCheckedChange={setUseUpnp}
                    aria-label={t("common.upnpAria")}
                  />
                </div>
                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <div>
                    <p className="text-sm font-medium">{t("common.noSteamLabel")}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("common.noSteamDesc")}
                    </p>
                  </div>
                  <Switch
                    checked={useNoSteam}
                    onCheckedChange={setUseNoSteam}
                    aria-label={t("common.noSteamAria")}
                  />
                </div>
                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <div>
                    <p className="text-sm font-medium">{t("common.debugLabel")}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("common.debugDesc")}
                    </p>
                  </div>
                  <Switch
                    checked={useDebug}
                    onCheckedChange={setUseDebug}
                    aria-label={t("common.debugAria")}
                  />
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </div>
  );

  // Quick Setup Step 3: Create
  const renderQuickStep3 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">{t("quick.step3.title")}</h2>
        <p className="text-muted-foreground">
          {t("quick.step3.description")}
        </p>
      </div>

      {/* Summary */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid gap-3 text-sm">
            <div className="flex justify-between gap-3 py-2 border-b">
              <span className="text-muted-foreground shrink-0">{t("quick.step3.summaryServerFiles")}</span>
              <span className="font-mono text-end min-w-0 flex-1 truncate" title={installPath}>
                {installPath}
              </span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{t("common.summaryServerName")}</span>
              <span className="font-mono">{serverName}</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{t("common.summaryMemory")}</span>
              <span className="font-mono">
                {formatMemory(minMemory)}GB - {formatMemory(maxMemory)}GB
              </span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{t("common.summaryGamePort")}</span>
              <span className="font-mono">{formatPort(serverPort)}</span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-muted-foreground">{t("common.summaryRconPort")}</span>
              <span className="font-mono">{formatPort(rconPort)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Create Button */}
      <DisabledReason reason={!canInstall ? t("common.noPermissionInstall") : null}>
      <Button
        onClick={handleQuickSetup}
        disabled={installing || missingAdminPassword || !canInstall}
        className="w-full"
        size="lg"
      >
        {installing ? (
          <>
            <Loader2 className="w-4 h-4 me-2 animate-spin" />
            {t("quick.step3.creatingButton")}
          </>
        ) : (
          <>
            <Plus className="w-4 h-4 me-2" />
            {t("quick.step3.createButton")}
          </>
        )}
      </Button>
      </DisabledReason>

      {missingAdminPassword && (
        <p className="text-sm text-warning">
          {t("quick.step3.missingAdminPassword")}
        </p>
      )}

      {/* Log */}
      {logs.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4" />
            <span className="text-sm font-medium">{t("quick.step3.logTitle")}</span>
          </div>
          <ScrollArea className="h-[150px] bg-background rounded-lg p-3">
            <div className="font-mono text-xs space-y-0.5">
              {logs.map((log, i) => (
                <div
                  key={i}
                  className={cn(
                    log.type === "error"
                      ? "text-destructive"
                      : log.type === "warning"
                        ? "text-warning"
                        : log.type === "success"
                          ? "text-success"
                          : "text-foreground/80",
                  )}
                >
                  {log.message}
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </ScrollArea>
        </div>
      )}

      {/* Post-create */}
      {installComplete && (
        <Card className="border-primary/30 bg-card shadow-sm">
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-center gap-2 text-primary">
              <CheckCircle className="w-5 h-5" />
              <span className="font-medium">{t("quick.step3.completeTitle")}</span>
            </div>

            <div className="flex gap-3">
              <DisabledReason reason={!canControlServer ? t("common.noPermissionControl") : null}>
                <Button
                  onClick={handleStartServerNow}
                  disabled={startingServer || !canControlServer}
                  className="flex-1"
                >
                  {startingServer ? (
                    <>
                      <Loader2 className="w-4 h-4 me-2 animate-spin" />{" "}
                      {t("common.startingButton")}
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 me-2" /> {t("common.startServerButton")}
                    </>
                  )}
                </Button>
              </DisabledReason>
              <Button variant="outline" onClick={() => navigate("/")}>
                {t("common.openDashboardButton")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );

  // Render current step content
  const renderStepContent = () => {
    if (setupMode === "quick") {
      switch (currentStep) {
        case 1:
          return renderQuickStep1();
        case 2:
          return renderQuickStep2();
        case 3:
          return renderQuickStep3();
      }
    } else {
      switch (currentStep) {
        case 1:
          return renderFullStep1();
        case 2:
          return renderFullStep2();
        case 3:
          return renderFullStep3();
        case 4:
          return renderFullStep4();
      }
    }
  };

  const isLastStep = currentStep === totalSteps;

  const getStepRequirementMessage = () => {
    if (setupMode === "quick") {
      if (currentStep === 1)
        return t("requirement.quickStep1");
      if (currentStep === 2) {
        if (!serverName.trim() && rconPassword.length < 6)
          return t("requirement.quickStep2Both");
        if (!serverName.trim()) return t("requirement.quickStep2Name");
        if (rconPassword.length < 6)
          return t("requirement.quickStep2Rcon");
        if (!adminPassword.trim()) return t("requirement.quickStep2Admin");
      }
      return "";
    }

    if (currentStep === 1) {
      if (!steamCmdPath.trim())
        return t("requirement.fullStep1Path");
      if (!hasSteamCmd) return t("requirement.fullStep1Confirm");
    }
    if (currentStep === 2) {
      if (!installPath.trim() && !serverName.trim())
        return t("requirement.fullStep2Both");
      if (!installPath.trim()) return t("requirement.fullStep2Path");
      if (!serverName.trim()) return t("requirement.fullStep2Name");
    }
    if (currentStep === 3) {
      if (rconPassword.length < 6) return t("requirement.fullStep3Rcon");
      if (!adminPassword.trim()) return t("requirement.fullStep3Admin");
    }
    return "";
  };

  return (
    <>
      <div className="max-w-3xl mx-auto space-y-6 page-transition">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-3xl font-bold">
            {setupMode === "quick" ? t("quick.pageTitle") : t("full.pageTitle")}
          </h1>
          <p className="text-muted-foreground">
            {setupMode === "quick"
              ? t("quick.pageDescription")
              : t("full.pageDescription")}
          </p>
        </div>

        {/* Step Indicator */}
        {renderStepIndicator()}

        {/* Main Content Card */}
        <Card>
          <CardContent className="pt-6">{renderStepContent()}</CardContent>
        </Card>

        {/* Navigation */}
        {!isLastStep && (
          <div className="space-y-2">
            <div className="flex justify-between">
              <Button
                variant="outline"
                onClick={() => {
                  if (currentStep === 1) {
                    setSetupMode("select");
                  } else {
                    setCurrentStep((s) => s - 1);
                  }
                }}
              >
                <ChevronLeft className="w-4 h-4 me-2" />
                {currentStep === 1 ? t("common.chooseSetupType") : t("common.backButton")}
              </Button>

              <Button
                onClick={() => setCurrentStep((s) => s + 1)}
                disabled={!canProceed}
              >
                {t("common.nextStepButton")}
                <ChevronRight className="w-4 h-4 ms-2" />
              </Button>
            </div>

            {!canProceed && (
              <p className="text-sm text-warning">
                {getStepRequirementMessage()}
              </p>
            )}
          </div>
        )}

        {isLastStep && !installing && !installComplete && (
          <div className="flex justify-start">
            <Button
              variant="outline"
              onClick={() => setCurrentStep((s) => s - 1)}
            >
              <ChevronLeft className="w-4 h-4 me-2" />
              {t("common.backButton")}
            </Button>
          </div>
        )}
      </div>

      <FolderBrowser
        open={browseOpen}
        onOpenChange={setBrowseOpen}
        onSelect={(path) => browseSetter?.fn(path)}
        initialPath={browseSetter?.initial}
        title={browseSetter?.title}
      />
    </>
  );
}

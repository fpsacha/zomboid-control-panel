import { useTranslation } from 'react-i18next';
import { useState, useEffect, useContext, useRef, useMemo } from "react";
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
} from "lucide-react";
import { configApi, serverApi, serversApi, debugApi } from "@/lib/api";
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
import { reportClientError } from "@/lib/client-errors";
import { cn, copyText } from "@/lib/utils";
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
  type: "info" | "success" | "error" | "command" | "stdout" | "stderr";
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

function installationErrorGuidance(message: string, guidance: string) {
  if (!message.startsWith("Installation path is not writable:")) {
    return message;
  }

  return `${message} ${guidance}`;
}

export default function ServerSetup() {
  const { t } = useTranslation('serverSetup');
  
  
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
    { name: "public", description: t('server.stableRelease') },
    { name: "b41multiplayer", description: t('server.build41Multiplayer') },
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

  // Installation state
  const [installing, setInstalling] = useState(false);
  const [logs, setLogs] = useState<InstallLog[]>([]);
  const [installComplete, setInstallComplete] = useState(false);
  const [installProgress, setInstallProgress] = useState<{
    percent: number;
    downloaded: string;
    total: string;
    status: string;
  } | null>(null);

  // SteamCMD auto-download state
  const [downloadingSteamCmd, setDownloadingSteamCmd] = useState(false);
  const [steamCmdStatus, setSteamCmdStatus] = useState<string>("");

  const { toast } = useToast();
  const socket = useContext(SocketContext);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const navigateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [startingServer, setStartingServer] = useState(false);

  // Refs for socket handler closure 鈥?avoids re-registering socket listeners when form state changes
  const formStateRef = useRef({
    serverName,
    installPath,
    zomboidDataPath,
    useCustomDataPath,
    rconPort,
    rconPassword,
    serverPort,
    minMemory,
    maxMemory,
    useNoSteam,
    useDebug,
  });
  useEffect(() => {
    formStateRef.current = {
      serverName,
      installPath,
      zomboidDataPath,
      useCustomDataPath,
      rconPort,
      rconPassword,
      serverPort,
      minMemory,
      maxMemory,
      useNoSteam,
      useDebug,
    };
  }, [
    serverName,
    installPath,
    zomboidDataPath,
    useCustomDataPath,
    rconPort,
    rconPassword,
    serverPort,
    minMemory,
    maxMemory,
    useNoSteam,
    useDebug,
  ]);

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
        2: serverName.length > 0 && rconPassword.length >= 6,
        3: true,
      };
    }
    return {
      1: steamCmdPath.length > 0 && hasSteamCmd,
      2: installPath.length > 0 && serverName.length > 0,
      3: rconPassword.length >= 6,
      4: true,
    };
  }, [
    setupMode,
    steamCmdPath,
    hasSteamCmd,
    installPath,
    serverName,
    rconPassword,
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
    }) => {
      const text = data.text.trim();
      setLogs((prev) => [
        ...prev,
        { type: data.type, message: text, timestamp: new Date() },
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
          status: t('status.downloading'),
        });
      }
      // Parse validation: "Validating files... 50%"
      const validateMatch = text.match(/[Vv]alidat\w*[^\d]*(\d+)%/);
      if (validateMatch) {
        setInstallProgress({
          percent: parseInt(validateMatch[1]),
          downloaded: "",
          total: "",
          status: t('status.validating'),
        });
      }
      // Parse update state
      if (text.includes("Update state") && text.includes("verifying")) {
        setInstallProgress((prev) =>
          prev ? { ...prev, status: t('status.verifying') } : null,
        );
      }
      if (text.includes("Success!") || text.includes("fully installed")) {
        setInstallProgress({
          percent: 100,
          downloaded: "",
          total: "",
          status: t('status.complete'),
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
      rconPort?: number;
      rconPassword?: string;
      serverPort?: number;
      minMemory?: number;
      maxMemory?: number;
    }) => {
      setInstalling(false);
      setInstallComplete(data.success);
      if (data.success) {
        setLogs((prev) => [
          ...prev,
          { type: "success", message: data.message, timestamp: new Date() },
        ]);

        try {
          const s = formStateRef.current;
          // Use data from server response which has computed paths
          const createResult = await serversApi.create({
            name: data.serverName || s.serverName,
            serverName: data.serverName || s.serverName,
            installPath: data.installPath || s.installPath,
            zomboidDataPath: data.zomboidDataPath || null,
            serverConfigPath: data.serverConfigPath || null,
            rconHost: "127.0.0.1",
            rconPort: data.rconPort || s.rconPort,
            rconPassword: data.rconPassword || s.rconPassword,
            serverPort: data.serverPort || s.serverPort,
            minMemory: (data.minMemory || s.minMemory) * 1024,
            maxMemory: (data.maxMemory || s.maxMemory) * 1024,
            useNoSteam: s.useNoSteam,
            useDebug: s.useDebug,
          });
          setLogs((prev) => [
            ...prev,
            {
              type: "success",
              message: t('logs.serverRegistered'),
              timestamp: new Date(),
            },
          ]);

          // Activate the newly created server so "Start Server Now" starts this one
          if (createResult.server?.id) {
            await serversApi.activate(createResult.server.id);
            setLogs((prev) => [
              ...prev,
              {
                type: "success",
                message: t('logs.activeServerSwitched'),
                timestamp: new Date(),
              },
            ]);
          }
        } catch (error) {
          reportClientError("Failed to create server entry.", error);
          setLogs((prev) => [
            ...prev,
            {
              type: "error",
              message: t('logs.serverRegistrationWarning'),
              timestamp: new Date(),
            },
          ]);
        }

        toast({
          title: t('toast.serverInstalled'),
          description:
            t('toast.serverInstalledDescription'),
        });
      } else {
        setLogs((prev) => [
          ...prev,
          { type: "error", message: data.message, timestamp: new Date() },
        ]);
        toast({
          title: t('toast.installationFailed'),
          description: data.message,
          variant: "destructive",
        });
      }
    };

    socket.on("install:log", handleInstallLog);
    socket.on("install:complete", handleInstallComplete);

    const handleSteamCmdStatus = (data: {
      status: string;
      message: string;
      path?: string;
    }) => {
      setSteamCmdStatus(data.message);
      if (data.status === "complete" && data.path) {
        setSteamCmdPath(data.path);
        setHasSteamCmd(true);
        setDownloadingSteamCmd(false);
        toast({
          title: t('toast.steamcmdReady'),
          description: t('toast.steamcmdReadyDescription'),
        });
      } else if (data.status === "error") {
        setDownloadingSteamCmd(false);
        toast({
          title: t('toast.steamcmdSetupFailed'),
          description: data.message,
          variant: "destructive",
        });
      }
    };

    const handleSteamCmdLog = (data: { type: string; text: string }) => {
      setSteamCmdStatus(data.text.trim());
    };

    socket.on("steamcmd:status", handleSteamCmdStatus);
    socket.on("steamcmd:log", handleSteamCmdLog);

    return () => {
      socket.off("install:log", handleInstallLog);
      socket.off("install:complete", handleInstallComplete);
      socket.off("steamcmd:status", handleSteamCmdStatus);
      socket.off("steamcmd:log", handleSteamCmdLog);
    };
  }, [socket, t, toast]);

  const addLog = (type: InstallLog["type"], message: string) => {
    setLogs((prev) => [...prev, { type, message, timestamp: new Date() }]);
  };

  const handleAutoDownloadSteamCmd = async () => {
    setDownloadingSteamCmd(true);
    setSteamCmdStatus(t('status.startingDownload'));
    try {
      await serverApi.downloadSteamCmd(steamCmdPath);
    } catch (error) {
      setDownloadingSteamCmd(false);
      toast({
        title: t('toast.downloadFailed'),
        description:
          error instanceof Error
            ? error.message
            : t('errors.startSteamcmdDownloadFailed'),
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
      title: t('toast.passwordCopied'),
      description: t('toast.passwordCopiedDescription'),
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
      title: t('toast.passwordGenerated'),
      description: t('toast.passwordGeneratedDescription'),
    });
  };

  const handleInstall = async () => {
    if (!adminPassword) {
      toast({
        title: t('errors.adminPasswordRequired'),
        description: t('errors.adminPasswordBeforeInstall'),
        variant: "destructive",
      });
      return;
    }
    setInstalling(true);
    setLogs([]);
    setInstallProgress(null);
    addLog("info", t('logs.startingInstallation'));

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
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : t('errors.unknown');
      const msg = installationErrorGuidance(rawMessage, t('errors.installationPathGuidance', { path: LINUX_SERVICE_INSTALL_PATH }));
      addLog("error", msg);
      setInstalling(false);
      toast({
        title: t('toast.installationFailed'),
        description: msg,
        variant: "destructive",
      });
    }
  };

  const handleQuickSetup = async () => {
    if (!adminPassword) {
      toast({
        title: t('errors.adminPasswordRequired'),
        description: t('errors.adminPasswordBeforeCreate'),
        variant: "destructive",
      });
      return;
    }
    setInstalling(true);
    setLogs([]);
    addLog("info", t('logs.creatingServerConfiguration'));

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
        addLog("success", t('logs.serverConfigurationCreated'));

        try {
          // Use data from server response which has computed paths
          const createResult = await serversApi.create({
            name: data.serverName || serverName,
            serverName: data.serverName || serverName,
            installPath: data.installPath || installPath,
            zomboidDataPath: data.zomboidDataPath || null,
            serverConfigPath: data.serverConfigPath || null,
            rconHost: "127.0.0.1",
            rconPort: data.rconPort || rconPort,
            rconPassword: data.rconPassword || rconPassword,
            serverPort: data.serverPort || serverPort,
            minMemory: (data.minMemory || minMemory) * 1024,
            maxMemory: (data.maxMemory || maxMemory) * 1024,
            useNoSteam: useNoSteam,
            useDebug: useDebug,
          });
          addLog("success", t('logs.serverRegistered'));

          // Activate the newly created server so "Start Server Now" starts this one
          if (createResult.server?.id) {
            await serversApi.activate(createResult.server.id);
          addLog("success", t('logs.activeServerSwitched'));
          }
        } catch (error) {
          reportClientError("Failed to create server entry.", error);
          addLog("error", t('logs.serverRegistrationWarning'));
        }

        setInstallComplete(true);
        toast({
          title: t('toast.serverAdded'),
          description: t('toast.serverAddedDescription'),
        });
      } else {
        addLog("error", data.error);
        toast({
          title: t('toast.setupFailed'),
          description: data.error,
          variant: "destructive",
        });
      }
    } catch (error) {
      const msg =
        error instanceof Error
          ? error.message
          : t('errors.unexpectedCreateServer');
      addLog("error", msg);
      toast({
        title: t('toast.setupFailed'),
        description: msg,
        variant: "destructive",
      });
    } finally {
      setInstalling(false);
    }
  };

  const handleSaveSteamCmdPath = async () => {
    try {
      await configApi.updateAppSettings({ steamcmdPath: steamCmdPath });
      setHasSteamCmd(true);
      toast({
        title: t('toast.pathSaved'),
        description: t('toast.pathSavedDescription'),
      });
    } catch {
      toast({
        title: t('toast.saveFailed'),
        description: t('errors.saveSteamcmdPathFailed'),
        variant: "destructive",
      });
    }
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
            {t('selectMode.newServer')}
          </span>
          <h1 className="text-3xl font-bold">{t('serverSetup')}</h1>
          <p className="text-muted-foreground text-base">
            {t('selectMode.description')}
          </p>
        </div>

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
                  className="absolute top-0 left-0 right-0 h-[3px] bg-gradient-to-r from-primary via-primary/80 to-primary/40"
                  aria-hidden="true"
                />
                <div className="absolute right-3 top-3">
                  <Badge
                    variant="secondary"
                    className="text-[10px] font-medium uppercase tracking-wide"
                  >
                     {t('selectMode.recommended')}
                  </Badge>
                </div>
                <CardHeader className="pb-3">
                  <div className="grid place-items-center w-11 h-11 rounded-md border border-primary/30 bg-primary/[0.08] text-primary mb-3 transition-colors group-hover:bg-primary/15">
                    <Download className="w-5 h-5" />
                  </div>
                  <CardTitle className="text-lg">{t('freshInstall')}</CardTitle>
                  <CardDescription
                    id="full-setup-description"
                    className="text-xs"
                  >
                    {t('selectMode.freshDescription')}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 pb-5">
                  <ul className="space-y-1.5 text-[13px]">
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
                      <span>
                        {t('selectMode.downloadsViaSteamcmd')} {" "}
                        <span className="text-foreground/60">(~3 GB)</span>
                      </span>
                    </li>
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
                      <span>{t('chooseGameVersionBranch')}</span>
                    </li>
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
                      <span>
                        {t('selectMode.generatesFiles')}
                      </span>
                    </li>
                  </ul>
                  <div className="flex items-center gap-1.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-primary/90">
                    {t('selectMode.beginInstall')} {" "}
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
                  <CardTitle className="text-lg">{t('selectMode.existingFiles')}</CardTitle>
                  <CardDescription
                    id="quick-setup-description"
                    className="text-xs"
                  >
                    {t('selectMode.existingDescription')}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 pb-5">
                  <ul className="space-y-1.5 text-[13px]">
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-muted-foreground/70 shrink-0" />
                      <span>{t('noDownloadRequired')}</span>
                    </li>
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-muted-foreground/70 shrink-0" />
                      <span>{t('pointToAnExistingPzServerFolder')}</span>
                    </li>
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-muted-foreground/70 shrink-0" />
                      <span>{t('fast3stepSetup')}</span>
                    </li>
                  </ul>
                  <div className="flex items-center gap-1.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground transition-colors group-hover:text-primary/90">
                    {t('selectMode.registerServer')} {" "}
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
                <p className="font-medium">{t('notSureWhichToChoose')}</p>
                <p className="text-sm text-muted-foreground">
                  {t('selectMode.tipPrefix')} {" "}
                  <strong>{t('freshInstall')}</strong>{t('selectMode.tipSuffix')}
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
            { id: 1, label: t('steps.location'), icon: HardDrive },
            { id: 2, label: t('steps.configure'), icon: Settings2 },
            { id: 3, label: t('steps.create'), icon: Plus },
          ]
        : [
            { id: 1, label: t('steps.steamcmd'), icon: Download },
            { id: 2, label: t('steps.server'), icon: Server },
            { id: 3, label: t('steps.settings'), icon: Settings2 },
            { id: 4, label: t('steps.install'), icon: Zap },
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
        <h2 className="text-2xl font-semibold">{t('setUpSteamcmd')}</h2>
        <p className="text-muted-foreground">{t('steamcmd.stepDescription')}</p>
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
                    <h3 className="font-semibold text-lg">{t('oneclickSetup')}</h3>
                    <p className="text-sm text-muted-foreground">
                      {t('steamcmd.oneClickDescription')}
                    </p>
                  </div>

                  <div className="flex gap-2 items-center">
                    <Input
                      value={steamCmdPath}
                      onChange={(e) => setSteamCmdPath(e.target.value)}
                      placeholder={t('steamcmd.folderPlaceholder')}
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
                                t('steamcmd.selectFolder'),
                                steamCmdPath,
                              )
                            }
                            disabled={downloadingSteamCmd}
                            aria-label={t('steamcmd.browse')}
                          >
                            <FolderOpen className="w-4 h-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('browseFolder')}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>

                  <Button
                    onClick={handleAutoDownloadSteamCmd}
                    disabled={downloadingSteamCmd}
                    className="w-full"
                    size="lg"
                  >
                    {downloadingSteamCmd ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        {steamCmdStatus || t('status.installingSteamcmd')}
                      </>
                    ) : (
                      <>
                        <Download className="w-4 h-4 mr-2" />
                        {t('steamcmd.installAutomatically')}
                      </>
                    )}
                  </Button>
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
                  <span>{t('alreadyHaveSteamcmdSetTheFolderManually')}</span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="px-4 pb-4">
                <div className="space-y-4">
                  <div className="bg-warning/10 border border-warning/40 rounded-lg p-4 text-sm shadow-sm">
                    <p className="font-medium text-warning">{t('manualSetup')}</p>
                    <ol className="list-decimal list-inside space-y-1 text-muted-foreground mt-2">
                      <li>{t('downloadSteamcmdFromValve')}</li>
                      <li>
                        {t('steamcmd.extractPrefix')} {" "}
                        <code className="bg-muted px-1 rounded">
                          C:\SteamCMD
                        </code>{" "}
                         {" "}
                        <code className="bg-muted px-1 rounded">
                          ~/steamcmd
                        </code>
                        {t('steamcmd.extractSuffix')}
                      </li>
                      <li>
                        {t('steamcmd.runPrefix')} {" "}
                        <code className="bg-muted px-1 rounded">steamcmd</code>{" "}
                        {t('steamcmd.runSuffix')}
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
                      <Download className="w-4 h-4 mr-2" />
                      {t('steamcmd.download')}
                      <ExternalLink className="w-3 h-3 ml-2" />
                    </Button>
                  </div>

                  <div className="flex gap-2">
                    <Input
                      value={steamCmdPath}
                      onChange={(e) => setSteamCmdPath(e.target.value)}
                      placeholder={t('steamcmd.existingPlaceholder')}
                      className="font-mono flex-1"
                      maxLength={260}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() =>
                        handleBrowseFolder(
                          setSteamCmdPath,
                          t('steamcmd.selectFolder'),
                          steamCmdPath,
                        )
                      }
                      aria-label={t('steamcmd.browse')}
                    >
                      <FolderOpen className="w-4 h-4" />
                    </Button>
                    <Button onClick={handleSaveSteamCmdPath}>{t('savePath')}</Button>
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
                <p className="font-semibold">{t('steamcmdReady')}</p>
                <p className="text-sm text-muted-foreground font-mono">
                  {steamCmdPath}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setHasSteamCmd(false)}
              >
                {t('steamcmd.changePath')}
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
        <h2 className="text-2xl font-semibold">{t('serverDetails')}</h2>
        <p className="text-muted-foreground">{t('serverDetailsDescription')}</p>
      </div>

      <div className="grid gap-6">
        {/* Installation Path */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <Label className="text-base">{t('installFolder')}</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto px-0 text-xs"
              onClick={() => setInstallPath(LINUX_SERVICE_INSTALL_PATH)}
            >
              {t('install.useLinuxServicePath')}
            </Button>
          </div>
          <div className="flex gap-2">
            <Input
              value={installPath}
              onChange={(e) => setInstallPath(e.target.value)}
              placeholder={t('install.folderPlaceholder')}
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
                        t('install.selectFolder'),
                        installPath,
                      )
                    }
                    aria-label={t('install.browse')}
                  >
                    <FolderOpen className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('browseFolder')}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('install.folderDescription')}
          </p>
        </div>

        <div className="border border-border/60 bg-muted/40 rounded-lg p-4 text-sm space-y-2">
          <p className="font-medium flex items-center gap-2">
            <Info className="w-4 h-4 text-primary" />
            {t('install.linuxServiceTitle')}
          </p>
          <p className="text-muted-foreground">
            {t('install.linuxServiceDescriptionPrefix')} {" "}
            <code className="bg-muted px-1 rounded">{LINUX_SERVICE_INSTALL_PATH}</code>.
            {" "}{t('install.linuxServiceDescriptionSuffix')}
          </p>
          <p className="text-muted-foreground">
            {t('install.dataFolderDescriptionPrefix')} {" "}
            <code className="bg-muted px-1 rounded break-all">
              {installPath.trim() ? `${installPath.trim()}_Data` : "your-install-folder_Data"}
            </code>. {t('install.dataFolderDescriptionSuffix')}
          </p>
        </div>

        {/* Server Name */}
        <div className="space-y-2">
          <Label className="text-base">{t('serverName')}</Label>
          <Input
            value={serverName}
            onChange={(e) =>
              setServerName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))
            }
            placeholder={t('server.namePlaceholder')}
            className="font-mono"
            maxLength={64}
          />
          <p className="text-xs text-muted-foreground">
            {t('server.nameDescription')}
          </p>
        </div>

        {/* Branch Selection */}
        <div className="space-y-2">
          <Label className="text-base">{t('gameVersion')}</Label>
          <Select
            value={branch}
            onValueChange={setBranch}
            disabled={loadingBranches}
          >
            <SelectTrigger>
              <SelectValue
                placeholder={
                  loadingBranches
                    ? t('status.loadingVersions')
                    : t('server.selectGameVersion')
                }
              />
            </SelectTrigger>
            <SelectContent>
              {availableBranches.map((b) => (
                <SelectItem key={b.name} value={b.name}>
                  <div className="flex flex-col">
                    <span>
                      {b.name === "public"
                        ? t('server.build42Stable')
                        : b.description || b.name}
                    </span>
                    {b.buildId && (
                      <span className="text-xs text-muted-foreground">
                        {t('server.buildLabel')}: {b.buildId}
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
                <span>{t('customConfigLocation')}</span>
                {useCustomDataPath && zomboidDataPath && (
                  <Badge variant="secondary" className="ml-2">
                    {t('server.set')}
                  </Badge>
                )}
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4">
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  {t('server.customDataDescription')}
                </p>
                <div className="flex items-center gap-3">
                  <Switch
                    checked={useCustomDataPath}
                    onCheckedChange={setUseCustomDataPath}
                  />
                  <Label>{t('useCustomLocation')}</Label>
                </div>
                {useCustomDataPath && (
                  <div className="flex gap-2">
                    <Input
                      value={zomboidDataPath}
                      onChange={(e) => setZomboidDataPath(e.target.value)}
                      placeholder={t('server.dataPathPlaceholder')}
                      className="font-mono flex-1"
                      maxLength={260}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() =>
                        handleBrowseFolder(
                          setZomboidDataPath,
                          t('server.selectConfigFolder'),
                          zomboidDataPath,
                        )
                      }
                      aria-label={t('server.browseData')}
                    >
                      <FolderOpen className="w-4 h-4" />
                    </Button>
                  </div>
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
        <h2 className="text-2xl font-semibold">{t('serverSettings')}</h2>
        <p className="text-muted-foreground">
          {t('serverSettingsDescription')}
        </p>
      </div>

      {/* RCON Section - Critical */}
      <Card className="border-primary/35 bg-card shadow-sm">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary" />
            <CardTitle className="text-lg">{t('rcon.title')}</CardTitle>
            <Badge className="ml-auto">{t('rcon.required')}</Badge>
          </div>
          <CardDescription>
            {t('rcon.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>{t('rconPassword')}</Label>
              <div className="flex gap-1">
                <div className="relative flex-1">
                  <Input
                    type={showRconPassword ? "text" : "password"}
                    value={rconPassword}
                    onChange={(e) => setRconPassword(e.target.value)}
                    className="pr-10 font-mono"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1 h-9 w-9 p-0"
                    onClick={() => setShowRconPassword(!showRconPassword)}
                    aria-label={
                      showRconPassword
                        ? t('rcon.hidePassword')
                        : t('rcon.showPassword')
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
                        aria-label={t('server.copyPassword')}
                      >
                        {copiedPassword ? (
                          <Check className="w-4 h-4" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('copyPassword')}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={handleRegeneratePassword}
                        aria-label={t('server.generatePassword')}
                      >
                        <RefreshCw className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('generateNewPassword')}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              {rconPassword.length > 0 && rconPassword.length < 6 && (
                <p className="text-xs text-destructive">{t('minimum6Characters')}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>{t('rconPort')}</Label>
              <Input
                type="number"
                value={rconPort}
                onChange={(e) => setRconPort(parseInt(e.target.value) || 27015)}
                className="font-mono"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Memory Settings */}
      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cpu className="w-5 h-5" />
              <CardTitle className="text-lg">{t('memorySettings.title')}</CardTitle>
            </div>
            {detectingRam ? (
              <Badge variant="outline" className="animate-pulse">
                {t('memorySettings.detecting')}
              </Badge>
            ) : (
              systemRam && (
                <Badge variant="outline">
                  {t('memorySettings.detected', { size: systemRam.totalGB })}
                </Badge>
              )
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-3">
              <div className="flex justify-between">
                <Label>{t('minimumRam')}</Label>
                <span className="font-mono font-medium">{minMemory}GB</span>
              </div>
              <Slider
                value={[minMemory]}
                onValueChange={([val]) => {
                  setMinMemory(val);
                  if (val > maxMemory) setMaxMemory(val);
                }}
                min={2}
                max={16}
                step={1}
                aria-label={t('memorySettings.minimumAria', { size: minMemory })}
              />
            </div>

            <div className="space-y-3">
              <div className="flex justify-between">
                <Label>{t('maximumRam')}</Label>
                <span className="font-mono font-medium">{maxMemory}GB</span>
              </div>
              <Slider
                value={[maxMemory]}
                onValueChange={([val]) => {
                  setMaxMemory(val);
                  if (val < minMemory) setMinMemory(val);
                }}
                min={2}
                max={16}
                step={1}
                aria-label={t('memorySettings.maximumAria', { size: maxMemory })}
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
              <span>{t('advancedOptions')}</span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-4 pb-4 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t('gamePort')}</Label>
                <Input
                  type="number"
                  value={serverPort}
                  onChange={(e) =>
                    setServerPort(parseInt(e.target.value) || 16261)
                  }
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  {t('server.defaultPort', { port: 16261 })}
                </p>
              </div>

              <div className="space-y-2">
                <Label>
                  {t('server.adminPassword')} <span className="text-destructive">*</span>
                </Label>
                <div className="relative">
                  <Input
                    type={showAdminPassword ? "text" : "password"}
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    placeholder={t('server.passwordPlaceholder')}
                    className="pr-10"
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
                        ? t('server.hideAdminPassword')
                        : t('server.showAdminPassword')
                    }
                  >
                    {showAdminPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('server.adminPasswordDescription')}
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="text-sm font-medium">{t('upnp')}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('options.upnpDescription')}
                  </p>
                </div>
                <Switch
                  checked={useUpnp}
                  onCheckedChange={setUseUpnp}
                  aria-label={t('options.upnp')}
                />
              </div>

              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="text-sm font-medium">{t('noSteam')}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('options.noSteamDescription')}
                  </p>
                </div>
                <Switch
                  checked={useNoSteam}
                  onCheckedChange={setUseNoSteam}
                  aria-label={t('options.noSteam')}
                />
              </div>

              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="text-sm font-medium">{t('debug')}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('options.debugDescription')}
                  </p>
                </div>
                <Switch
                  checked={useDebug}
                  onCheckedChange={setUseDebug}
                  aria-label={t('options.debug')}
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
        <h2 className="text-2xl font-semibold">{t('reviewAndInstall')}</h2>
        <p className="text-muted-foreground">{t('reviewInstallDescription')}</p>
      </div>

      {/* Summary */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid gap-3 text-sm">
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{t('installationPath')}</span>
              <span className="font-mono text-right max-w-[300px] truncate">
                {installPath}
              </span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{t('serverName')}</span>
              <span className="font-mono">{serverName}</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{t('gameVersion')}</span>
              <span>{branch === "public" ? t('server.build42Stable') : branch}</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{t('memory')}</span>
              <span className="font-mono">
                {minMemory}GB - {maxMemory}GB
              </span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{t('gamePort')}</span>
              <span className="font-mono">{serverPort}</span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-muted-foreground">{t('rconPort')}</span>
              <span className="font-mono">{rconPort}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Port Info */}
      <div className="bg-muted/50 border border-border/60 rounded-lg p-4 text-sm shadow-sm">
        <p className="font-medium flex items-center gap-2">
          <Info className="w-4 h-4 text-primary" />
          {t('network.title')}
        </p>
        <p className="text-muted-foreground mt-1">
          {t('network.description')}
        </p>
        <ul className="mt-2 space-y-1 text-muted-foreground">
          <li>
            • <code className="bg-muted px-1 rounded">{serverPort}</code> UDP - {t('network.gameTraffic')}
          </li>
          <li>
            • <code className="bg-muted px-1 rounded">{serverPort + 1}</code>{" "}
            UDP - {t('network.directConnect')}
          </li>
        </ul>
      </div>

      {/* Install Button */}
      <Button
        onClick={handleInstall}
        disabled={installing || missingAdminPassword}
        className="w-full"
        size="lg"
      >
        {installing ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            {t('status.installingServer')}
          </>
        ) : (
          <>
            <Download className="w-4 h-4 mr-2" />
            {t('actions.installServer')}
          </>
        )}
      </Button>

      {missingAdminPassword && (
        <p className="text-sm text-warning">
          {t('errors.adminPasswordBeforeInstall')}
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
                <span className="text-muted-foreground ml-2">
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
            <span className="text-sm font-medium">{t('installationLog')}</span>
          </div>
          <ScrollArea className="h-[200px] bg-black rounded-lg p-3">
            <div className="font-mono text-xs space-y-0.5">
              {logs.map((log, i) => (
                <div
                  key={i}
                  className={cn(
                    log.type === "error" || log.type === "stderr"
                      ? "text-destructive"
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
              <span className="font-medium">{t('installationComplete')}</span>
            </div>

            {/* First-run setup notice */}
            <div className="bg-warning/10 border border-warning/40 rounded-lg p-4 text-sm shadow-sm">
              <p className="font-medium flex items-center gap-2 text-warning">
                <Info className="w-4 h-4" />
                {t('postInstall.firstStartRequired')}
              </p>
              <p className="text-muted-foreground mt-1">
                {t('postInstall.firstStartDescription')}
              </p>
            </div>

            <div className="flex gap-3">
              <Button
                onClick={async () => {
                  setStartingServer(true);
                  try {
                    await serverApi.start();
                    toast({
                      title: t('toast.serverStarting'),
                      description: t('toast.redirectingDashboard'),
                    });
                    navigateTimerRef.current = setTimeout(
                      () => navigate("/"),
                      2000,
                    );
                  } catch (error) {
                    toast({
                      title: t('toast.startFailed'),
                      description:
                        error instanceof Error
                          ? error.message
                          : t('errors.unknown'),
                      variant: "destructive",
                    });
                  } finally {
                    setStartingServer(false);
                  }
                }}
                disabled={startingServer}
                className="flex-1"
              >
                {startingServer ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />{" "}
                    {t('status.startingServer')}
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 mr-2" /> {t('actions.startServer')}
                  </>
                )}
              </Button>
              <Button variant="outline" onClick={() => navigate("/")}>
                {t('actions.openDashboard')}
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
        <h2 className="text-2xl font-semibold">{t('selectServerFiles')}</h2>
        <p className="text-muted-foreground">{t('quick.selectFilesDescription')}</p>
      </div>

      <Card className="bg-secondary/40 border-primary/24 shadow-sm">
        <CardContent className="pt-6">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-lg border border-primary/20 bg-primary/10 flex items-center justify-center shrink-0">
              <HardDrive className="w-5 h-5 text-primary" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">{t('usingExistingFiles')}</p>
              <p className="text-sm text-muted-foreground">
                {t('quick.folderContainsPrefix')} {" "}
                <code className="bg-muted px-1 rounded">StartServer64.bat</code>{" "}
                {t('quick.folderContainsWindowsOr')} {" "}
                <code className="bg-muted px-1 rounded">start-server.sh</code>{" "}
                {t('quick.folderContainsLinuxPlus')} {" "}
                <code className="bg-muted px-1 rounded">java</code> {t('quick.folderContainsSuffix')}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-2">
        <Label className="text-base">{t('serverFilesLocation')}</Label>
        <div className="flex gap-2">
          <Input
            value={installPath}
            onChange={(e) => setInstallPath(e.target.value)}
            placeholder={t('server.existingPlaceholder')}
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
                      "Select PZ server folder",
                      installPath,
                    )
                  }
                  aria-label={t('server.browseExisting')}
                >
                  <FolderOpen className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('browseFolder')}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('quick.folderDescription')}
        </p>
      </div>
    </div>
  );

  // Quick Setup Step 2: Configure
  const renderQuickStep2 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">{t('configureServer')}</h2>
        <p className="text-muted-foreground">{t('quick.configureDescription')}</p>
      </div>

      <div className="grid gap-6">
        {/* Server Name */}
        <div className="space-y-2">
          <Label className="text-base">{t('serverName')}</Label>
          <Input
            value={serverName}
            onChange={(e) =>
              setServerName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))
            }
            placeholder={t('server.namePlaceholder')}
            className="font-mono"
            maxLength={64}
          />
          <p className="text-xs text-muted-foreground">{t('quick.serverNameDescription')}</p>
        </div>

        {/* RCON - Critical */}
        <Card className="border-primary/35 bg-card shadow-sm">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-primary" />
              <CardTitle className="text-lg">{t('rcon.title')}</CardTitle>
              <Badge className="ml-auto">{t('rcon.required')}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t('rconPassword')}</Label>
                <div className="flex gap-1">
                  <div className="relative flex-1">
                    <Input
                      type={showRconPassword ? "text" : "password"}
                      value={rconPassword}
                      onChange={(e) => setRconPassword(e.target.value)}
                      className="pr-10 font-mono"
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
                          ? t('rcon.hidePassword')
                          : t('rcon.showPassword')
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
                          aria-label={t('server.copyPassword')}
                        >
                          {copiedPassword ? (
                            <Check className="w-4 h-4" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('copyPassword')}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={handleRegeneratePassword}
                          aria-label={t('server.generatePassword')}
                        >
                          <RefreshCw className="w-4 h-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('generateNewPassword')}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                {rconPassword.length > 0 && rconPassword.length < 6 && (
                  <p className="text-xs text-destructive">
                    {t('minimum6Characters')}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label>{t('rconPort')}</Label>
                <Input
                  type="number"
                  value={rconPort}
                  onChange={(e) =>
                    setRconPort(parseInt(e.target.value) || 27015)
                  }
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  {t('server.defaultPort', { port: 27015 })}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Memory */}
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu className="w-5 h-5" />
                <CardTitle className="text-lg">{t('memorySettings.title')}</CardTitle>
              </div>
              {detectingRam ? (
                <Badge variant="outline" className="animate-pulse">
                  {t('memorySettings.detecting')}
                </Badge>
              ) : (
                systemRam && (
                  <Badge variant="outline">
                    {t('memorySettings.detectedShort', { size: systemRam.totalGB })}
                  </Badge>
                )
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="space-y-3">
                <div className="flex justify-between">
                  <Label>{t('minimumRam')}</Label>
                  <span className="font-mono">{minMemory}GB</span>
                </div>
                <Slider
                  value={[minMemory]}
                  onValueChange={([val]) => {
                    setMinMemory(val);
                    if (val > maxMemory) setMaxMemory(val);
                  }}
                  min={2}
                  max={16}
                  step={1}
                  aria-label={t('memorySettings.minimumAria', { size: minMemory })}
                />
              </div>

              <div className="space-y-3">
                <div className="flex justify-between">
                  <Label>{t('maximumRam')}</Label>
                  <span className="font-mono">{maxMemory}GB</span>
                </div>
                <Slider
                  value={[maxMemory]}
                  onValueChange={([val]) => {
                    setMaxMemory(val);
                    if (val < minMemory) setMinMemory(val);
                  }}
                  min={2}
                  max={16}
                  step={1}
                  aria-label={t('memorySettings.maximumAria', { size: maxMemory })}
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
                <span>{t('advancedOptions')}</span>
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4 space-y-4">
              <div className="flex items-center gap-3">
                <Switch
                  checked={useCustomDataPath}
                  onCheckedChange={setUseCustomDataPath}
                />
                <Label>{t('customConfigLocation')}</Label>
              </div>
              {useCustomDataPath && (
                <div className="flex gap-2">
                  <Input
                    value={zomboidDataPath}
                    onChange={(e) => setZomboidDataPath(e.target.value)}
                    placeholder={t('server.dataPathPlaceholder')}
                    className="font-mono flex-1"
                    maxLength={260}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() =>
                      handleBrowseFolder(
                        setZomboidDataPath,
                        t('server.selectConfigFolder'),
                        zomboidDataPath,
                      )
                    }
                    aria-label={t('server.browseData')}
                  >
                    <FolderOpen className="w-4 h-4" />
                  </Button>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>{t('gamePort')}</Label>
                  <Input
                    type="number"
                    value={serverPort}
                    onChange={(e) =>
                      setServerPort(parseInt(e.target.value) || 16261)
                    }
                    className="font-mono"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('server.defaultPort', { port: 16261 })}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>
                    {t('server.adminPassword')} <span className="text-destructive">*</span>
                  </Label>
                  <div className="relative">
                    <Input
                      type={showAdminPassword ? "text" : "password"}
                      value={adminPassword}
                      onChange={(e) => setAdminPassword(e.target.value)}
                      placeholder={t('server.passwordPlaceholder')}
                      className="pr-10"
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
                          ? t('server.hideAdminPassword')
                          : t('server.showAdminPassword')
                      }
                    >
                      {showAdminPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                  {t('server.adminPasswordDescription')}
                  </p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <div>
                    <p className="text-sm font-medium">{t('upnp')}</p>
                    <p className="text-xs text-muted-foreground">
                    {t('options.upnpDescription')}
                    </p>
                  </div>
                  <Switch
                    checked={useUpnp}
                    onCheckedChange={setUseUpnp}
                    aria-label={t('options.upnp')}
                  />
                </div>
                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <div>
                    <p className="text-sm font-medium">{t('noSteam')}</p>
                    <p className="text-xs text-muted-foreground">
                    {t('options.noSteamDescription')}
                    </p>
                  </div>
                  <Switch
                    checked={useNoSteam}
                    onCheckedChange={setUseNoSteam}
                    aria-label={t('options.noSteam')}
                  />
                </div>
                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <div>
                    <p className="text-sm font-medium">{t('debug')}</p>
                    <p className="text-xs text-muted-foreground">
                    {t('options.debugDescription')}
                    </p>
                  </div>
                  <Switch
                    checked={useDebug}
                    onCheckedChange={setUseDebug}
                    aria-label={t('options.debug')}
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
        <h2 className="text-2xl font-semibold">{t('reviewAndCreate')}</h2>
        <p className="text-muted-foreground">{t('quick.reviewDescription')}</p>
      </div>

      {/* Summary */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid gap-3 text-sm">
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{t('serverFiles')}</span>
              <span className="font-mono text-right max-w-[300px] truncate">
                {installPath}
              </span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{t('serverName')}</span>
              <span className="font-mono">{serverName}</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{t('memory')}</span>
              <span className="font-mono">
                {minMemory}GB - {maxMemory}GB
              </span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{t('gamePort')}</span>
              <span className="font-mono">{serverPort}</span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-muted-foreground">{t('rconPort')}</span>
              <span className="font-mono">{rconPort}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Create Button */}
      <Button
        onClick={handleQuickSetup}
        disabled={installing || missingAdminPassword}
        className="w-full"
        size="lg"
      >
        {installing ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            {t('status.creatingServer')}
          </>
        ) : (
          <>
            <Plus className="w-4 h-4 mr-2" />
            {t('actions.createServer')}
          </>
        )}
      </Button>

      {missingAdminPassword && (
        <p className="text-sm text-warning">
          {t('errors.adminPasswordBeforeCreate')}
        </p>
      )}

      {/* Log */}
      {logs.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4" />
            <span className="text-sm font-medium">{t('setupLog')}</span>
          </div>
          <ScrollArea className="h-[150px] bg-black rounded-lg p-3">
            <div className="font-mono text-xs space-y-0.5">
              {logs.map((log, i) => (
                <div
                  key={i}
                  className={cn(
                    log.type === "error"
                      ? "text-destructive"
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
              <span className="font-medium">{t('serverCreated')}</span>
            </div>

            <div className="flex gap-3">
              <Button
                onClick={async () => {
                  setStartingServer(true);
                  try {
                    await serverApi.start();
                    toast({
                      title: t('toast.serverStarting'),
                      description: t('toast.redirectingDashboard'),
                    });
                    navigateTimerRef.current = setTimeout(
                      () => navigate("/"),
                      2000,
                    );
                  } catch (error) {
                    toast({
                      title: t('toast.startFailed'),
                      description:
                        error instanceof Error
                          ? error.message
                          : t('errors.unknown'),
                      variant: "destructive",
                    });
                  } finally {
                    setStartingServer(false);
                  }
                }}
                disabled={startingServer}
                className="flex-1"
              >
                {startingServer ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />{" "}
                    {t('status.startingServer')}
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 mr-2" /> {t('actions.startServer')}
                  </>
                )}
              </Button>
              <Button variant="outline" onClick={() => navigate("/")}>
                {t('actions.openDashboard')}
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
        return t('validation.selectServerFolder');
      if (currentStep === 2) {
        if (!serverName.trim() && rconPassword.length < 6)
          return t('validation.serverNameAndRcon');
        if (!serverName.trim()) return t('validation.serverName');
        if (rconPassword.length < 6)
          return t('validation.rconPassword');
      }
      return "";
    }

    if (currentStep === 1) {
      if (!steamCmdPath.trim())
        return t('validation.steamcmdPath');
      if (!hasSteamCmd) return t('validation.installSteamcmd');
    }
    if (currentStep === 2) {
      if (!installPath.trim() && !serverName.trim())
        return t('validation.installFolderAndName');
      if (!installPath.trim()) return t('validation.installFolder');
      if (!serverName.trim()) return t('validation.serverName');
    }
    if (currentStep === 3 && rconPassword.length < 6)
      return t('validation.rconPassword');
    return "";
  };

  return (
    <>
      <div className="max-w-3xl mx-auto space-y-6 page-transition">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-3xl font-bold">
            {setupMode === "quick" ? t('quick.title') : t('freshInstall')}
          </h1>
          <p className="text-muted-foreground">
            {setupMode === "quick"
              ? t('quick.headerDescription')
              : t('full.headerDescription')}
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
                <ChevronLeft className="w-4 h-4 mr-2" />
                {currentStep === 1 ? t('actions.chooseSetupType') : t('actions.back')}
              </Button>

              <Button
                onClick={() => setCurrentStep((s) => s + 1)}
                disabled={!canProceed}
              >
                {t('actions.nextStep')}
                <ChevronRight className="w-4 h-4 ml-2" />
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
              <ChevronLeft className="w-4 h-4 mr-2" />
              {t('actions.back')}
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

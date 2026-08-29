import type { ServerInstance } from "./api";

export function getDashboardLocalProcessStatus(
  server: Pick<ServerInstance, "isRemote" | "dockerContainerName" | "dockerContainerId"> | null | undefined,
  status: { running?: unknown } | null | undefined,
): boolean | null {
  if (
    server?.isRemote ||
    server?.dockerContainerName ||
    server?.dockerContainerId
  ) {
    return null;
  }
  return typeof status?.running === "boolean" ? status.running : null;
}
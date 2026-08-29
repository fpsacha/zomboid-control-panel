const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

export function shouldAutoOpenBrowser(value = process.env.PANEL_AUTO_OPEN_BROWSER) {
  return !DISABLED_VALUES.has(String(value ?? "").trim().toLowerCase());
}
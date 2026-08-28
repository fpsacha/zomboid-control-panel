import { getSetting, setSetting } from "../database/init.js";
import { createLogger } from "../utils/logger.js";
import {
  loadUiSecret,
  readUiSecretFile,
  replaceUiSecretFiles,
} from "../utils/uiSecretFile.js";

const log = createLogger("SteamSessionCredentials");

export async function getSteamSessionCredentials() {
  const [legacySessionId, legacyLoginSecure] = await Promise.all([
    getSetting("steamSessionId"),
    getSetting("steamLoginSecure"),
  ]);
  const [sessionId, loginSecure] = await Promise.all([
    loadUiSecret("steamSessionId", {
      legacyValue: legacySessionId,
      clearLegacy: () => setSetting("steamSessionId", null),
      log,
    }),
    loadUiSecret("steamLoginSecure", {
      legacyValue: legacyLoginSecure,
      clearLegacy: () => setSetting("steamLoginSecure", null),
      log,
    }),
  ]);
  return { sessionId, loginSecure };
}

/**
 * Persist the cookie pair in canonical secret files. An undefined argument
 * means "unchanged", which lets partial Settings saves preserve the other
 * half of the pair. Legacy database copies are removed only after the new
 * pair has been activated and read back through the production reader.
 */
export async function setSteamSessionCredentials(sessionId, loginSecure) {
  const [legacySessionId, legacyLoginSecure] = await Promise.all([
    getSetting("steamSessionId"),
    getSetting("steamLoginSecure"),
  ]);
  const currentSessionId =
    readUiSecretFile("steamSessionId", log) ?? legacySessionId;
  const currentLoginSecure =
    readUiSecretFile("steamLoginSecure", log) ?? legacyLoginSecure;
  const nextSessionId =
    sessionId === undefined ? currentSessionId : sessionId;
  const nextLoginSecure =
    loginSecure === undefined ? currentLoginSecure : loginSecure;

  try {
    replaceUiSecretFiles([
      ["steamSessionId", nextSessionId],
      ["steamLoginSecure", nextLoginSecure],
    ]);
    const normalize = (value) => {
      if (value == null || value === "") return null;
      return String(value).trim() || null;
    };
    if (
      readUiSecretFile("steamSessionId", log) !== normalize(nextSessionId) ||
      readUiSecretFile("steamLoginSecure", log) !== normalize(nextLoginSecure)
    ) {
      throw new Error("canonical read-back verification failed");
    }
    await Promise.all([
      setSetting("steamSessionId", null),
      setSetting("steamLoginSecure", null),
    ]);
  } catch (err) {
    throw new Error(
      `Could not persist Steam session credentials: ${err.message}`,
    );
  }
}

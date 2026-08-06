/**
 * Several services in this codebase report failure by returning
 * `{ success: false, error }` rather than by throwing. A call whose result is
 * discarded therefore swallows the failure silently — the pattern behind a
 * third of the bugs found in the August 2026 audit (a `/stop` that quit after a
 * failed save, a `/restart` that always claimed success, a `/test-message` that
 * always reported it was sent).
 *
 * This rule flags such a call when its result is thrown away. To ignore a
 * result deliberately, prefix the call with `void`.
 */

// Methods that answer with a result object instead of raising on failure.
const RESULT_RETURNING_METHODS = [
  // backupService
  "createBackup",
  "deleteBackup",
  "deleteBackupsOlderThan",
  "restoreBackup",
  // modChecker
  "addModToTrack",
  "handleModUpdate",
  "triggerModRestart",
  // panelBridge
  "ping",
  // panelUpdateChecker
  "downloadUpdate",
  // scheduler
  "cancelRestart",
  "performRestart",
  // serverManager
  "restartServer",
  "saveServerConfig",
  "startServer",
  "stopServer",
  // rcon — execute() and every wrapper around it
  "addItem",
  "addToWhitelist",
  "addUser",
  "addVehicle",
  "addVehicleAt",
  "addXp",
  "alarm",
  "banPlayer",
  "banSteamId",
  "changeOption",
  "checkModsNeedUpdate",
  "createHorde",
  "execute",
  "kickPlayer",
  "quit",
  "releaseSafehouse",
  "reloadLua",
  "reloadOptions",
  "removeFromWhitelist",
  "removeZombies",
  "save",
  "serverMessage",
  "setAccessLevel",
  "setGodMode",
  "setInvisible",
  "setLogLevel",
  "setNoclip",
  "setStats",
  "showOptions",
  "startRain",
  "startStorm",
  "stopRain",
  "stopWeather",
  "teleportPlayer",
  "teleportTo",
  "triggerChopper",
  "triggerGunshot",
  "triggerLightning",
  "triggerThunder",
  "unbanPlayer",
  "unbanSteamId",
  "voiceBan",
];

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require the result of a method that reports failure by return value to be used",
    },
    schema: [
      {
        type: "object",
        properties: {
          methods: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      discarded:
        "'{{name}}()' reports failure by return value instead of throwing, so discarding its result hides the failure. Use the result, or prefix the call with `void` to ignore it deliberately.",
    },
  },

  create(context) {
    const methods = new Set(
      context.options[0]?.methods ?? RESULT_RETURNING_METHODS,
    );

    return {
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression") return;
        const property = node.callee.property;
        if (property.type !== "Identifier" || !methods.has(property.name)) {
          return;
        }

        // A discarded result is a bare expression statement, optionally awaited.
        // Anything else — assignment, return, .then(), void — is a use.
        let current = node;
        let parent = current.parent;
        if (parent?.type === "AwaitExpression") {
          current = parent;
          parent = current.parent;
        }
        if (parent?.type !== "ExpressionStatement") return;

        context.report({
          node,
          messageId: "discarded",
          data: { name: property.name },
        });
      },
    };
  },
};

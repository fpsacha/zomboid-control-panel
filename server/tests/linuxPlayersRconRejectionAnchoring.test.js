import { describe, expect, it } from "vitest";
import { RconService } from "../services/rcon.js";

// 2026-08-29 hunt (god): players.js moderation/GM-tools, suspects 1 (player
// name escaping into the command string) and 2 (does a failed RCON command
// look like success to the operator) turning out to be the SAME defect seen
// from two sides. classifyRconResponse() ran an UNANCHORED .test() against
// the whole trimmed response, and PZ's own SUCCESS messages for these exact
// commands interpolate the target player's name -- kickuser's success is
// "User <name> kicked.", setaccesslevel's is "<name> granted <level> access
// level on <server>". A player who names themselves text containing a
// rejection fragment (a real griefer move -- it's chosen BECAUSE it breaks
// tooling) made their own SUCCESSFUL command misclassify as a failure, for
// EVERY pattern in the array, old and new alike.
//
// This is the positive control: feeding only the real rejection strings
// proves the classifier fires; feeding a genuine success response whose
// interpolated name contains the same fragment proves it DISCRIMINATES.
// Testing only the first would be indistinguishable from a classifier that
// catches everything.
//
// New pattern sourcing: server/__fixtures__/pzRconRejectionStrings.json
// (decompiled PZ B42 server jar, build 24909800) -- KickUserCommand.class
// ("User X doesn't exist.", "This user can't be kicked."),
// GameServer.getPlayerByUserNameForCommand (shared by AddItemCommand,
// AddXPCommand, TeleportCommand, TeleportPlayerCommand, AddVehicleCommand,
// VoiceBanCommand: "No such user"), and GameServer.changeRole /
// SetAccessLevelCommand.class (four distinct setaccesslevel rejections).
// Automatically cross-checked against the same fixture by
// rconRejectionGroundTruth.test.js's drift gate -- this file only owns the
// discrimination property, not re-proving the strings are real.

describe("classifyRconResponse: real rejections still fire after anchoring", () => {
  const rcon = new RconService();

  it.each([
    ["kickuser: target not connected", "User Bob doesn't exist."],
    ["kickuser: target protected", "This user can't be kicked."],
    ["additem/addxp/teleport/teleportplayer/addvehicle/voiceban: target not connected", "No such user"],
    ["setaccesslevel: bad username", 'Invalid username "Bob"'],
    ["setaccesslevel: bad level name", "Access Level 'overseer2' unknown, list of access level: admin,moderator,overseer,gm,observer,user"],
    ["setaccesslevel: role-hierarchy denial", "You do not have sufficient rights to set this access level."],
    ["setaccesslevel: target has no account", 'User "Bob" is not in the whitelist nor the server, use /adduser first'],
  ])("%s", (_label, response) => {
    expect(rcon.classifyRconResponse(response)).not.toBeNull();
  });
});

describe("classifyRconResponse: a griefer's own display name must not turn their SUCCESSFUL command into a reported failure", () => {
  const rcon = new RconService();

  it.each([
    // kickuser success format: "User <name> kicked."
    ["kickuser success, name = 'Not enough rights'", "User Not enough rights kicked."],
    ["kickuser success, name = 'Wrong arguments!'", "User Wrong arguments! kicked."],
    ["kickuser success, name = 'No such user'", "User No such user kicked."],
    ["kickuser success, name literally containing 'doesn't exist.'", "User Steve doesn't exist. kicked."],
    // setaccesslevel success format: "<name> granted <level> access level on <server>"
    ["setaccesslevel success, name = 'Not enough rights'", "Not enough rights granted admin access level on MyServer"],
    ["setaccesslevel success, name = 'Invalid username \"x\"'", 'Invalid username "x" granted admin access level on MyServer'],
    ["setaccesslevel success, name containing the whitelist-rejection fragment", 'User "x" is not in the whitelist nor the server, use /adduser first granted admin access level on MyServer'],
  ])("%s", (_label, response) => {
    expect(rcon.classifyRconResponse(response)).toBeNull();
  });
});

describe("classifyRconResponse: unrelated informative responses are untouched", () => {
  const rcon = new RconService();

  it("does not classify a normal player list as a rejection", () => {
    expect(rcon.classifyRconResponse("Players connected (2):\n-Alice\n-Bob")).toBeNull();
  });
});

// SECURITY (audit R1-25): "...can be executed only from the game" was only
// end-anchored. A co-op name (no isValidUserName check, no length cap) that
// ends in it and is listed last made every `players` reply a refusal: the
// Players page, the player polling, Discord /players and the restart's RCON
// check all failed while that player stayed on.
describe("classifyRconResponse: 'can be executed only from the game'", () => {
  const rcon = new RconService();

  it("still fires on the one-line refusal", () => {
    expect(rcon.classifyRconResponse("releasesafehouse can be executed only from the game")).not.toBeNull();
    expect(rcon.classifyRconResponse("This command can be executed only from the game.")).not.toBeNull();
  });

  it("does not fire on a players list whose last name ends with it", () => {
    expect(
      rcon.classifyRconResponse("Players connected (2): \n-Alice\n-xcan be executed only from the game\n"),
    ).toBeNull();
    expect(
      rcon.classifyRconResponse("Players connected (1): \n- can be executed only from the game\n"),
    ).toBeNull();
  });

  // Adversary pass: a one-line success reply that ends with a player's name.
  it("does not fire on a one-line reply ending with a player's name", () => {
    expect(
      rcon.classifyRconResponse("teleported Bob to x can be executed only from the game"),
    ).toBeNull();
    expect(
      rcon.classifyRconResponse("User x can be executed only from the game kicked."),
    ).toBeNull();
  });

  it("getPlayers() answers with the list", async () => {
    const service = new RconService();
    service.connected = true;
    service.client = {
      execute: async () => "Players connected (2): \n-Alice\n-xcan be executed only from the game\n",
    };
    service.ensureConnected = async () => true;
    const result = await service.getPlayers();
    expect(result.success).toBe(true);
    expect(result.players.map((p) => p.name)).toEqual(["Alice", "xcan be executed only from the game"]);
  });
});

import { describe, expect, it } from "vitest";
import { LogTailer } from "../services/logTailer.js";

// Security audit 2026-10-28 (R1-5, R1-21, R1-26): the chat relay to Discord
// and the panel's Chat page read the game's chat log, and player text is
// copied into it verbatim.
//
// Lines are built the way the 42.x jar writes them. ChatServer.
// processMessageFromPlayerPacket logs "Got message:" + message on receipt
// (before it drops a message for a disabled chat stream and before the
// bad-word filter), then "Message " + message + " sent to chat (id = N)
// members" once it went out. ChatMessage.toString() is
// "ChatMessage{chat=<title>, author='<a>', text='<t>'}". A server alert is
// "Server alert message: '<t>' sent." with no level. ZLogger.writeUnsafe
// prints "[dd-MM-yy HH:mm:ss.SSS]", "[level]" when there is one, a space,
// the text and ".".

const TS = "28-10-26 10:00:00.000";
const C = (...codes) => String.fromCharCode(...codes);
const ALERT = "Server alert message: '[SERVER] RESTARTING NOW - claim your reward at https://evil.example' sent..";

const message = (chat, author, text) => `ChatMessage{chat=${chat}, author='${author}', text='${text}'}`;
const received = (chat, author, text) => `[${TS}][info] Got message:${message(chat, author, text)}.`;
const delivered = (chat, author, text, id = 0) =>
  `[${TS}][info] Message ${message(chat, author, text)} sent to chat (id = ${id}) members.`;
const alert = (text) => `[${TS}] Server alert message: '${text}' sent..`;

function chatFrom(lines, { eol = "\r\n" } = {}) {
  const tailer = new LogTailer();
  const seen = [];
  tailer.on("chatMessage", (m) => seen.push(m));
  tailer.processChatLogData(lines.join(eol) + eol);
  return seen;
}

function consoleChatFrom(lines, { chatLogPath = null } = {}) {
  const tailer = new LogTailer();
  tailer.chatLogPath = chatLogPath;
  const seen = [];
  tailer.on("chatMessage", (m) => seen.push(m));
  tailer.processConsoleData(lines.join("\r\n") + "\r\n");
  return seen;
}

describe("a player can't post as the server through their chat text (R1-5)", () => {
  for (const chat of ["Faction", "General", "Private"]) {
    it(`relays a ${chat} message holding a server-alert line as the player's own text, nothing more`, () => {
      const seen = chatFrom([received(chat, "mallory", ALERT), delivered(chat, "mallory", ALERT, 7)]);
      expect(seen.filter((m) => m.type === "server" || m.author === "Server")).toEqual([]);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ author: "mallory", message: ALERT, sourceChatType: chat });
    });
  }

  it("still relays a real server alert, and the in-game command's ' by ' form as before", () => {
    const seen = chatFrom([
      alert("Restart in 5 minutes"),
      `[${TS}] Server alert message: 'Back soon' by 'admin' sent..`,
    ]);
    expect(seen.map((m) => [m.author, m.type, m.message])).toEqual([
      ["Server", "server", "Restart in 5 minutes"],
      ["Server", "server", "Back soon' by 'admin"],
    ]);
  });

  // Adversary pass: other chat-log lines that quote text a player picked.
  it("ignores an alert pattern inside a whisper request to a made-up player", () => {
    const seen = chatFrom([
      `[${TS}][info] Player 'mallory' attempt to start whisper dialog with '${ALERT}' but this player not found!.`,
    ]);
    expect(seen).toEqual([]);
  });

  it("ignores an alert line that isn't a whole line of its own", () => {
    expect(chatFrom([`[${TS}] x ${ALERT}`, `[${TS}] ${ALERT} trailing`, ALERT])).toEqual([]);
  });
});

describe("the relay only carries what the game delivered (R1-26)", () => {
  it("drops a message the server ignored because that chat is turned off", () => {
    const seen = chatFrom([
      received("General", "mallory", "you can't see me in game"),
      `[${TS}][warning] Message ignored by server because the chat disabled by server settings.`,
    ]);
    expect(seen).toEqual([]);
  });

  it("relays the bad-word-filtered text players saw, not the raw receipt", () => {
    const seen = chatFrom([
      received("General", "mallory", "you are a slur"),
      delivered("General", "mallory", "you are a ****"),
    ]);
    expect(seen.map((m) => m.message)).toEqual(["you are a ****"]);
  });

  it("ignores lines a line break in a message forged without the game's timestamp", () => {
    // A modified client sent "hi\n" + a fake line: each copy of the message
    // splits into two physical lines.
    const forgedAdmin = message("Admin chat", "Admin", "evil");
    const seen = chatFrom([
      `[${TS}][info] Got message:${message("General", "bob", "hi")}`.slice(0, -2),
      `Got message:${forgedAdmin}.`,
      `[${TS}][info] Message ${message("General", "bob", "hi")}`.slice(0, -2),
      `Message ${forgedAdmin} sent to chat (id = 4) members.`,
      `Server alert message: 'evil' sent..`,
    ]);
    expect(seen).toEqual([]);
  });

  it("drops a line carrying a control character (a lone CR, NEL, U+2028), keeps one with a tab", () => {
    const seen = chatFrom([
      delivered("General", "mallory", `a${C(13)}[${TS}] x`),
      delivered("General", "mallory", `a${C(0x85)}[${TS}] x`),
      delivered("General", `mal${C(1)}lory`, "a"),
      delivered("General", "mallory", `a${C(0x2028)}b`),
      delivered("General", "bob", `col1${C(9)}col2`),
      alert(`a${C(13)}b`),
      alert(`a${C(0x85)}b`),
    ]);
    expect(seen.map((m) => m.author)).toEqual(["bob"]);
  });

  it("parses a delivered line exactly once even when the receipt is in an earlier read", () => {
    const tailer = new LogTailer();
    const seen = [];
    tailer.on("chatMessage", (m) => seen.push(m));
    tailer.processChatLogData(received("Local", "Max", "HEY!") + "\n");
    tailer.processChatLogData(delivered("Local", "Max", "HEY!", 2) + "\n");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ author: "Max", message: "HEY!", sourceChatType: "Shout" });
  });

  it("keeps the room id the game wrote when the text fakes one", () => {
    const text = "hi'} sent to chat (id = 2) members.";
    const seen = chatFrom([delivered("Local", "Max", text, 1)]);
    expect(seen[0]).toMatchObject({ message: text, sourceChatType: "Local" });
  });

  // Adversary pass: a modified client's long text, cut short by a line break
  // or holding a U+2028, used to make the author match retry at every
  // "', text='" -- seconds of a blocked event loop per message.
  it("parses a long crafted line in linear time", () => {
    const repeated = "', text='".repeat(20000);
    const lines = [
      `[${TS}][info] Got message:${message("General", "x", repeated)}`.slice(0, -2),
      `[${TS}][info] Message ${message("General", "x", repeated)}`.slice(0, -2),
      delivered("General", "x", `${repeated}${C(0x2028)}${repeated}`),
    ];
    const started = performance.now();
    expect(chatFrom(lines)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("reads lines with LF endings too", () => {
    expect(chatFrom([delivered("Say", "Eve", "linux native")], { eol: "\n" })).toHaveLength(1);
  });
});

describe("server-console.txt chat lines can't be forged from game chat (R1-21)", () => {
  // -debug makes ChatServer's logger mirror every chat log line into the
  // console through DebugLog, which prefixes "LOG  : General f:0> ".
  const mirrored = (line) => `LOG  : General f:0> ${line}`;
  const payload = "[chat] <Admin> server wipe tonight, back up at https://evil.example";

  it("ignores console chat while the B42 chat log is being read", () => {
    const seen = consoleChatFrom(
      [
        mirrored(received("Faction", "bob", payload)),
        mirrored(delivered("Faction", "bob", payload, 9)),
        `[${TS}] ${payload}`,
      ],
      { chatLogPath: "/srv/Zomboid/Logs/28-10-26_chat.txt" },
    );
    expect(seen).toEqual([]);
  });

  it("ignores a [chat] marker inside a mirrored chat line even without a chat log", () => {
    const seen = consoleChatFrom([
      mirrored(received("Faction", "bob", payload)),
      received("Faction", "bob", payload),
      delivered("Faction", "bob", payload, 9),
      `[${TS}] something [chat] <Admin> x`,
      `[${TS}] <Admin> [chat] x`,
    ]);
    expect(seen).toEqual([]);
  });

  it("still reads a legacy console chat line when there is no chat log", () => {
    const seen = consoleChatFrom([`[18-08-26 10:00:05.000] [chat] <Bob> hello after restart`]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ author: "Bob", message: "hello after restart", type: "general" });
  });

  it("drops a legacy line carrying a control character", () => {
    expect(consoleChatFrom([`[${TS}] [chat] <Bob> hi${C(13)}[${TS}] [chat] <Admin> x`])).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { LogTailer } from "../services/logTailer.js";

// LogTailer.readChunk() decoded each 64 KB stream chunk on its own
// (`data += chunk`), and each poll reads up to wherever the game had got to:
// a multi-byte character split across either boundary became two U+FFFD.
// It now keeps a StringDecoder per file across reads.

const chatLine = (author, text) =>
  `[01-01-26 10:00:00.000][info] Message ChatMessage{chat=General, author='${author}', text='${text}'} sent to chat (id = 0) members.\n`;

describe("LogTailer: a multi-byte character split across reads", () => {
  let dir;
  let file;
  let tailer;
  let seen;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-logtail-utf8-"));
    file = path.join(dir, "01-01-26_chat.txt");
    fs.writeFileSync(file, "");
    tailer = new LogTailer();
    tailer.chatLogPath = file;
    tailer.chatLogSize = 0;
    seen = [];
    tailer.on("chatMessage", (message) => seen.push(message));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("joins a Cyrillic character the game had half written at one poll", async () => {
    const bytes = Buffer.from(chatLine("Дмитрий", "привет"), "utf8");
    const cut = bytes.indexOf(Buffer.from("привет", "utf8")) + 1; // inside "п"
    fs.writeFileSync(file, bytes.subarray(0, cut));
    await tailer.checkChatLog();
    fs.appendFileSync(file, bytes.subarray(cut));
    await tailer.checkChatLog();

    expect(seen).toHaveLength(1);
    expect(seen[0].author).toBe("Дмитрий");
    expect(seen[0].message).toBe("привет");
  });

  it("joins a CJK character that straddles the read stream's 64 KB chunk boundary", async () => {
    const filler = chatLine("Filler", "x".repeat(200));
    let text = "";
    while (Buffer.byteLength(text) + Buffer.byteLength(filler) < 65536 - 300) text += filler;
    // Pad so the next line's first CJK character starts 1 byte before 65536.
    const prefix = "[01-01-26 10:00:00.000][info] Message ChatMessage{chat=General, author='";
    const pad = 65536 - 1 - Buffer.byteLength(text) - Buffer.byteLength(prefix) - 1;
    text += `${chatLine("Pad", "y".repeat(pad - Buffer.byteLength(chatLine("Pad", "")) + 1))}`;
    text += chatLine("名前", "你好世界");
    const bytes = Buffer.from(text, "utf8");
    const at = bytes.indexOf(Buffer.from("名前", "utf8"));
    expect(at).toBeLessThan(65536);
    expect(at + 3).toBeGreaterThan(65536); // "名" crosses the boundary
    fs.writeFileSync(file, bytes);

    await tailer.checkChatLog();

    const cjk = seen.find((message) => message.message === "你好世界");
    expect(cjk?.author).toBe("名前");
    expect(seen.some((message) => message.author.includes("�"))).toBe(false);
  });

  it("starts afresh on a new file or a truncation (no stale half character glued on)", async () => {
    const bytes = Buffer.from(chatLine("Ёж", "ok"), "utf8");
    fs.writeFileSync(file, bytes.subarray(0, bytes.indexOf(Buffer.from("Ёж", "utf8")) + 1));
    await tailer.checkChatLog();
    fs.writeFileSync(file, ""); // the game truncated the file
    await tailer.checkChatLog();
    fs.writeFileSync(file, chatLine("Ann", "after"));
    await tailer.checkChatLog();
    expect(seen.map((message) => [message.author, message.message])).toEqual([["Ann", "after"]]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// SECURITY (2026-10-28, audit R1-9): POST /players/notes (players.moderate)
// checked each tag's type and length but not how many there were, and
// upsertPlayerNote added a row for every new name with no cap. One request
// could carry ~1 MB of tags, written pretty-printed into db.json, which the
// panel rewrites whole on every flush. Notes are now bounded: 20 tags each
// (blank and repeated ones dropped), 5,000 notes, 5 million characters.
//
// Real, unmocked database/init.js: vitest.perFileDataDir.setup.mjs gives
// this file its own throwaway data folder.

vi.mock("../services/panelBridge.js", () => ({ default: { isRunning: false } }));

const {
  getDb,
  upsertPlayerNote,
  getPlayerNote,
  normalizePlayerNoteTags,
  PlayerNotesFullError,
  MAX_PLAYER_NOTES,
  MAX_PLAYER_NOTE_TAGS,
} = await import("../database/init.js");
const { default: router } = await import("../routes/players.js");

function postNotesHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/notes" && entry.route.methods.post,
  );
  return layer.route.stack.at(-1).handle;
}

async function postNote(body) {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  await postNotesHandler()({ body, app: { get: () => ({}) } }, response);
  return { response, payload: response.json.mock.calls[0]?.[0] };
}

function synthetic(count, noteLength = 0) {
  const now = new Date().toISOString();
  return Array.from({ length: count }, (_, i) => ({
    id: `seed-${i}`,
    player_name: `Seed${i}`,
    note: "x".repeat(noteLength),
    tags: [],
    created_at: now,
    updated_at: now,
  }));
}

beforeEach(async () => {
  const db = await getDb();
  db.data.player_notes = [];
});

describe("player notes: tags", () => {
  it("refuses more than 20 distinct tags and stores nothing", async () => {
    expect(MAX_PLAYER_NOTE_TAGS).toBe(20);
    const tags = Array.from({ length: 21 }, (_, i) => `tag${i}`);
    const { response, payload } = await postNote({ playerName: "Bob", note: "n", tags });
    expect(response.status).toHaveBeenCalledWith(400);
    expect(payload.code).toBe("PLAYERS_NOTE_INVALID_TAGS");
    expect(await getPlayerNote("Bob")).toBeNull();
  });

  it("keeps 20 tags, dropping blank and repeated ones", async () => {
    const tags = [...Array.from({ length: 20 }, (_, i) => `tag${i}`), "tag0", "", "  "];
    const { payload } = await postNote({ playerName: "Bob", note: "n", tags });
    expect(payload.success).toBe(true);
    expect((await getPlayerNote("Bob")).tags).toHaveLength(20);
  });

  // Adversary pass: payloads that slip under a distinct-tag count.
  it("a body of thousands of empty or identical tags stores none or one", async () => {
    await postNote({ playerName: "Empty", note: "", tags: Array(30000).fill("") });
    expect((await getPlayerNote("Empty")).tags).toEqual([]);
    await postNote({ playerName: "Same", note: "", tags: Array(30000).fill("x".repeat(50)) });
    expect((await getPlayerNote("Same")).tags).toEqual(["x".repeat(50)]);
  });

  it("upsertPlayerNote clamps tags itself, whoever calls it", async () => {
    const entry = await upsertPlayerNote("Direct", "", Array.from({ length: 500 }, (_, i) => `t${i}`));
    expect(entry.tags).toHaveLength(20);
    expect(normalizePlayerNoteTags([1, null, "a", "a", ""])).toEqual(["a"]);
  });
});

describe("player notes: a cap on how many and how much", () => {
  it("refuses a new player's note at 5,000 notes, but still updates an existing one", async () => {
    expect(MAX_PLAYER_NOTES).toBe(5000);
    const db = await getDb();
    db.data.player_notes = synthetic(MAX_PLAYER_NOTES);

    await expect(upsertPlayerNote("Newcomer", "hi", [])).rejects.toBeInstanceOf(PlayerNotesFullError);
    const { response, payload } = await postNote({ playerName: "Newcomer", note: "hi" });
    expect(response.status).toHaveBeenCalledWith(409);
    expect(payload.code).toBe("PLAYERS_NOTES_FULL");
    expect(db.data.player_notes).toHaveLength(MAX_PLAYER_NOTES);

    // Name matching is case-insensitive, so a known player is an update.
    const updated = await postNote({ playerName: "seed7", note: "updated" });
    expect(updated.payload.success).toBe(true);
    expect(db.data.player_notes).toHaveLength(MAX_PLAYER_NOTES);
  });

  it("refuses a note that would grow the total past 5 million characters, but lets one shrink", async () => {
    const db = await getDb();
    db.data.player_notes = synthetic(500, 10000); // exactly 5,000,000 characters
    const { response, payload } = await postNote({ playerName: "Late", note: "one more" });
    expect(response.status).toHaveBeenCalledWith(409);
    expect(payload.code).toBe("PLAYERS_NOTES_FULL");

    // Growing an existing note is refused too; tags count toward the total.
    await expect(upsertPlayerNote("Seed1", "x".repeat(10000), ["extra"])).rejects.toBeInstanceOf(PlayerNotesFullError);

    const shrunk = await postNote({ playerName: "Seed1", note: "short now" });
    expect(shrunk.payload.success).toBe(true);
    // ...which frees room for a new one.
    expect((await postNote({ playerName: "Late", note: "one more" })).payload.success).toBe(true);
  });
});

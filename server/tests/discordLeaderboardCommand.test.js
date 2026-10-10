import { describe, expect, it, vi } from "vitest";
import { DiscordBot } from "../services/discordBot.js";

// Feature request (GH, 2026-10): players want the stats leaderboard in
// Discord, like /players and /status.

function makeInteraction(sort) {
  const replies = [];
  return {
    replies,
    options: { getString: () => sort ?? null },
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async (reply) => replies.push(reply)),
  };
}

function botWith(players, { running = true } = {}) {
  const bot = Object.create(DiscordBot.prototype);
  bot.panelBridge = {
    isRunning: running,
    getLeaderboard: vi.fn(async () => ({ data: { players } })),
  };
  return bot;
}

const ROWS = [
  { username: "alice", allTimeKills: 40, bestDays: 3.2, deaths: 1 },
  { username: "bob", allTimeKills: 90, bestDays: 1.1, deaths: 6 },
  { username: "carol_*", allTimeKills: 10, bestDays: 9.9, deaths: 0 },
];

describe("Discord /leaderboard", () => {
  it("ranks by all-time kills by default, top first, and escapes names", async () => {
    const bot = botWith(ROWS);
    const interaction = makeInteraction();

    await bot.handleLeaderboard(interaction);

    const embed = interaction.replies.at(-1).embeds[0].data;
    expect(embed.title).toMatch(/All-time kills/);
    const lines = embed.description.split("\n");
    expect(lines[0]).toBe("**1.** bob — 90 kills");
    expect(lines[1]).toBe("**2.** alice — 40 kills");
    expect(lines[2]).toContain("carol\\_\\*");
    expect(bot.panelBridge.getLeaderboard).toHaveBeenCalledWith({ source: "discord" });
  });

  it("ranks by longest survival or deaths when asked", async () => {
    const days = makeInteraction("days");
    await botWith(ROWS).handleLeaderboard(days);
    expect(days.replies.at(-1).embeds[0].data.description.split("\n")[0]).toMatch(/carol.* 9\.9 days/);

    const deaths = makeInteraction("deaths");
    await botWith(ROWS).handleLeaderboard(deaths);
    expect(deaths.replies.at(-1).embeds[0].data.description.split("\n")[0]).toBe("**1.** bob — 6 deaths");
  });

  it("shows only the top 10", async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ username: `p${i}`, allTimeKills: i, bestDays: 0, deaths: 0 }));
    const interaction = makeInteraction();
    await botWith(many).handleLeaderboard(interaction);
    expect(interaction.replies.at(-1).embeds[0].data.description.split("\n")).toHaveLength(10);
  });

  it("says so when PanelBridge is not running, and when there are no rows", async () => {
    const off = makeInteraction();
    await botWith(ROWS, { running: false }).handleLeaderboard(off);
    expect(off.replies.at(-1)).toMatch(/PanelBridge is not running/);

    const empty = makeInteraction();
    await botWith([]).handleLeaderboard(empty);
    expect(empty.replies.at(-1).embeds[0].data.description).toMatch(/No players/);
  });
});

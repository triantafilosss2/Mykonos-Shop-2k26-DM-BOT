require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
  ChannelType,
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  ButtonBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonStyle,
  SlashCommandBuilder,
  REST,
  Routes,
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("❌ DISCORD_TOKEN is missing. Add it in Railway Variables.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const COMMAND = "!dmall";
const SET_NUMBER_COMMAND = "!setnumber";
const SPIN_COMMAND = "!spin";
const SCRATCH_COMMAND = "!scratch";
const SLOTS_COMMAND = "!slots";

const DMALL_COOLDOWN_MS = 60 * 60 * 1000;
const DMALL_DELAY_MS = 1500;
const SCRATCH_MAX = 1000;
const SCRATCH_JACKPOT_NUMBER = 777;

const DEFAULT_GAME_CONFIG = Object.freeze({
  spin: Object.freeze({ winRate: 18, cooldownHours: 3 }),
  scratch: Object.freeze({ winRate: 0.1, cooldownHours: 3 }),
  slots: Object.freeze({ winRate: 3.7, jackpotRate: 0.03, cooldownHours: 3 }),
});

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "games.json");

const dmallLastSuccessfulRuns = new Map(); // guildId -> timestamp
const dmallActiveGuilds = new Set(); // guildIds currently sending
const activeNumbers = new Map();
const gameCooldowns = new Map(); // `${guildId}:${userId}:${game}` -> expiry
const gameLocks = new Set();
const guildSettings = new Map(); // guildId -> channels + per-game win rates/cooldowns

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function countConfiguredGameChannels() {
  let count = 0;
  for (const settings of guildSettings.values()) {
    for (const key of ["spinChannelId", "scratchChannelId", "slotsChannelId", "numberChannelId"]) {
      if (typeof settings?.[key] === "string" && settings[key]) count++;
    }
  }
  return count;
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function validRate(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function validCooldownHours(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 168;
}

function normalizeNumber(value) {
  return Math.round(value * 1000) / 1000;
}

function getGameConfig(guildId, game) {
  const settings = guildSettings.get(guildId) || {};
  if (game === "spin") {
    return {
      winRate: validRate(settings.spinWinRate) ? settings.spinWinRate : DEFAULT_GAME_CONFIG.spin.winRate,
      cooldownHours: validCooldownHours(settings.spinCooldownHours) ? settings.spinCooldownHours : DEFAULT_GAME_CONFIG.spin.cooldownHours,
    };
  }
  if (game === "scratch") {
    return {
      winRate: validRate(settings.scratchWinRate) ? settings.scratchWinRate : DEFAULT_GAME_CONFIG.scratch.winRate,
      cooldownHours: validCooldownHours(settings.scratchCooldownHours) ? settings.scratchCooldownHours : DEFAULT_GAME_CONFIG.scratch.cooldownHours,
    };
  }
  if (game === "slots") {
    const winRate = validRate(settings.slotsWinRate) ? settings.slotsWinRate : DEFAULT_GAME_CONFIG.slots.winRate;
    const rawJackpot = validRate(settings.slotsJackpotRate) ? settings.slotsJackpotRate : DEFAULT_GAME_CONFIG.slots.jackpotRate;
    return {
      winRate,
      jackpotRate: Math.min(rawJackpot, winRate),
      cooldownHours: validCooldownHours(settings.slotsCooldownHours) ? settings.slotsCooldownHours : DEFAULT_GAME_CONFIG.slots.cooldownHours,
    };
  }
  return null;
}

function loadSettings() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    const guilds = parsed?.guilds && typeof parsed.guilds === "object" ? parsed.guilds : {};

    for (const [guildId, settings] of Object.entries(guilds)) {
      if (settings && typeof settings === "object") {
        // v2.2.x migration: an old single channel becomes the default for all three games.
        const legacy = typeof settings.channelId === "string" ? settings.channelId : null;
        guildSettings.set(guildId, {
          // Legacy single-channel configs cannot satisfy strict per-game channel rules.
          // Preserve it only as Spin and require explicit channels for the other games.
          spinChannelId: typeof settings.spinChannelId === "string" ? settings.spinChannelId : legacy,
          scratchChannelId: typeof settings.scratchChannelId === "string" ? settings.scratchChannelId : null,
          numberChannelId: typeof settings.numberChannelId === "string" ? settings.numberChannelId : null,
          slotsChannelId: typeof settings.slotsChannelId === "string" ? settings.slotsChannelId : null,
          spinWinRate: validRate(settings.spinWinRate) ? settings.spinWinRate : DEFAULT_GAME_CONFIG.spin.winRate,
          scratchWinRate: validRate(settings.scratchWinRate) ? settings.scratchWinRate : DEFAULT_GAME_CONFIG.scratch.winRate,
          slotsWinRate: validRate(settings.slotsWinRate) ? settings.slotsWinRate : DEFAULT_GAME_CONFIG.slots.winRate,
          slotsJackpotRate: validRate(settings.slotsJackpotRate) ? settings.slotsJackpotRate : DEFAULT_GAME_CONFIG.slots.jackpotRate,
          spinCooldownHours: validCooldownHours(settings.spinCooldownHours) ? settings.spinCooldownHours : DEFAULT_GAME_CONFIG.spin.cooldownHours,
          scratchCooldownHours: validCooldownHours(settings.scratchCooldownHours) ? settings.scratchCooldownHours : DEFAULT_GAME_CONFIG.scratch.cooldownHours,
          slotsCooldownHours: validCooldownHours(settings.slotsCooldownHours) ? settings.slotsCooldownHours : DEFAULT_GAME_CONFIG.slots.cooldownHours,
          maintenanceMode: settings.maintenanceMode === true,
        });
      }

      if (settings?.activeNumber && Number.isSafeInteger(settings.activeNumber.number)) {
        activeNumbers.set(guildId, settings.activeNumber);
      }
    }

    const cooldownEntries = parsed?.cooldowns && typeof parsed.cooldowns === "object" ? parsed.cooldowns : {};
    const now = Date.now();
    for (const [key, expiry] of Object.entries(cooldownEntries)) {
      if (Number.isSafeInteger(expiry) && expiry > now) gameCooldowns.set(key, expiry);
    }

    const dmallEntries = parsed?.dmallLastSuccessfulRuns && typeof parsed.dmallLastSuccessfulRuns === "object"
      ? parsed.dmallLastSuccessfulRuns
      : {};
    for (const [guildId, timestamp] of Object.entries(dmallEntries)) {
      if (Number.isSafeInteger(timestamp) && timestamp > 0) dmallLastSuccessfulRuns.set(guildId, timestamp);
    }
  } catch (error) {
    console.error("❌ Could not read games settings:", error);
  }
}

function saveSettings() {
  ensureDataDir();
  const guilds = {};
  for (const [guildId, settings] of guildSettings.entries()) {
    guilds[guildId] = {
      spinChannelId: settings.spinChannelId || null,
      scratchChannelId: settings.scratchChannelId || null,
      numberChannelId: settings.numberChannelId || null,
      slotsChannelId: settings.slotsChannelId || null,
      spinWinRate: getGameConfig(guildId, "spin").winRate,
      scratchWinRate: getGameConfig(guildId, "scratch").winRate,
      slotsWinRate: getGameConfig(guildId, "slots").winRate,
      slotsJackpotRate: getGameConfig(guildId, "slots").jackpotRate,
      spinCooldownHours: getGameConfig(guildId, "spin").cooldownHours,
      scratchCooldownHours: getGameConfig(guildId, "scratch").cooldownHours,
      slotsCooldownHours: getGameConfig(guildId, "slots").cooldownHours,
      maintenanceMode: settings.maintenanceMode === true,
    };
    const activeNumber = activeNumbers.get(guildId);
    if (activeNumber) guilds[guildId].activeNumber = activeNumber;
  }

  // Preserve an active number even if its guild has no configured channel (normally prevented by setup).
  for (const [guildId, activeNumber] of activeNumbers.entries()) {
    guilds[guildId] ||= {};
    guilds[guildId].activeNumber = activeNumber;
  }

  const cooldowns = {};
  const now = Date.now();
  for (const [key, expiry] of gameCooldowns.entries()) {
    if (expiry > now) cooldowns[key] = expiry;
  }

  const dmallRuns = {};
  for (const [guildId, timestamp] of dmallLastSuccessfulRuns.entries()) {
    if (Number.isSafeInteger(timestamp) && timestamp > 0) dmallRuns[guildId] = timestamp;
  }

  const output = { version: 2, guilds, cooldowns, dmallLastSuccessfulRuns: dmallRuns };
  const tempFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(output, null, 2), "utf8");
  fs.renameSync(tempFile, DATA_FILE);
}

function formatRemaining(ms) {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60000));
  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes ? `${hours}ω ${minutes}λ` : `${hours}ω`;
  }
  return `${totalMinutes}λ`;
}

function formatGameCooldown(ms) {
  const safeMs = Math.max(0, ms);
  const totalMinutes = Math.max(1, Math.ceil(safeMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}ω ${minutes}λ`;
  if (hours > 0) return `${hours}ω`;
  return `${minutes}λ`;
}

function canManageGames(member, guild) {
  return (
    member.id === guild.ownerId ||
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  );
}

function getMemberAvatarUrl(user) {
  return user.displayAvatarURL({ extension: "png", size: 64 });
}

function createShopEmbed(title, description) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0x2b2d31)
    .setFooter({ text: "Mykonos Shop 2k26" });
}

function getConfiguredChannelId(guildId, game) {
  const settings = guildSettings.get(guildId);
  if (!settings) return null;
  if (game === "spin") return settings.spinChannelId || null;
  if (game === "scratch") return settings.scratchChannelId || null;
  if (game === "number") return settings.numberChannelId || null;
  if (game === "slots") return settings.slotsChannelId || null;
  return null;
}

async function getGameChannel(guild, game) {
  const channelId = getConfiguredChannelId(guild.id, game);
  if (!channelId) return null;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return null;
  return channel;
}

async function requireGameChannel(message, game) {
  const channel = await getGameChannel(message.guild, game);
  if (!channel) {
    const labels = { spin: "Spin", scratch: "Scratch", number: "Guess Number", slots: "Slots" };
    await message.reply(
      `❌ Δεν έχει οριστεί κανάλι για **${labels[game] || game}**. Χρησιμοποίησε \`/games dashboard\` και επίλεξε το αντίστοιχο κανάλι.`
    );
    return null;
  }
  return channel;
}

function cooldownKey(guildId, userId, game) {
  return `${guildId}:${userId}:${game}`;
}

function getCooldown(guildId, userId, game) {
  return gameCooldowns.get(cooldownKey(guildId, userId, game)) || 0;
}

function setCooldown(guildId, userId, game) {
  const config = getGameConfig(guildId, game);
  const cooldownMs = Math.round((config?.cooldownHours || 0) * 60 * 60 * 1000);
  if (cooldownMs <= 0) {
    gameCooldowns.delete(cooldownKey(guildId, userId, game));
    return;
  }
  gameCooldowns.set(cooldownKey(guildId, userId, game), Date.now() + cooldownMs);
}

function clearCooldownsForGame(guildId, game) {
  const prefix = `${guildId}:`;
  const suffix = `:${game}`;
  for (const key of gameCooldowns.keys()) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) gameCooldowns.delete(key);
  }
}

function isMaintenanceMode(guildId) {
  return guildSettings.get(guildId)?.maintenanceMode === true;
}

function getGamesForChannel(guildId, channelId) {
  const games = ["spin", "scratch", "slots", "number"];
  return games.filter((game) => getConfiguredChannelId(guildId, game) === channelId);
}

function allowedMemberMessageForGameChannel(game, contentLower, content) {
  if (game === "spin") return contentLower === SPIN_COMMAND;
  if (game === "scratch") return contentLower === SCRATCH_COMMAND;
  if (game === "slots") return contentLower === SLOTS_COMMAND;
  if (game === "number") return /^\d+$/.test(content);
  return false;
}

async function enforceStrictGameChannel(message, content, lower) {
  // Staff are exempt so they can moderate/configure channels without their messages being deleted.
  if (canManageGames(message.member, message.guild)) return false;

  const games = getGamesForChannel(message.guild.id, message.channel.id);
  if (games.length === 0) return false;

  // If old settings point multiple games to the same channel, do not delete potentially valid content.
  // Dashboard prevents creating new collisions, and logs make the configuration problem visible.
  if (games.length > 1) {
    console.warn(`⚠️ Game channel collision in guild ${message.guild.id}, channel ${message.channel.id}: ${games.join(", ")}`);
    return false;
  }

  const allowed = allowedMemberMessageForGameChannel(games[0], lower, content);
  if (allowed) return false;

  await message.delete().catch((error) => {
    console.error(`❌ Could not delete disallowed message in strict game channel ${message.channel.id}:`, error?.message || error);
  });
  return true;
}

async function ensureCommandChannel(message, game) {
  const channelId = getConfiguredChannelId(message.guild.id, game);
  if (!channelId) {
    await requireGameChannel(message, game);
    return false;
  }
  if (message.channel.id !== channelId) {
    await message.reply(`❌ Το \`${game === "spin" ? "!spin" : game === "scratch" ? "!scratch" : "!slots"}\` χρησιμοποιείται μόνο στο <#${channelId}>.`);
    return false;
  }
  return true;
}

async function maintenanceBlocked(message) {
  if (!isMaintenanceMode(message.guild.id)) return false;
  await message.reply("🛠️ **Τα παιχνίδια είναι προσωρινά σε Maintenance Mode.** Δοκίμασε ξανά όταν ανοίξουν.");
  return true;
}

function channelDisplay(settings, key) {
  return settings[key] ? `<#${settings[key]}>` : "❌ Δεν έχει οριστεί";
}

function rateText(value) {
  return `${normalizeNumber(value)}%`;
}

function cooldownText(hours) {
  if (hours === 0) return "Χωρίς cooldown";
  return `${normalizeNumber(hours)} ώρες`;
}

function dashboardEmbed(guild) {
  const settings = guildSettings.get(guild.id) || {};
  const spin = getGameConfig(guild.id, "spin");
  const scratch = getGameConfig(guild.id, "scratch");
  const slots = getGameConfig(guild.id, "slots");
  const maintenance = isMaintenanceMode(guild.id);
  return new EmbedBuilder()
    .setTitle("🎮 Mykonos Shop 2k26 — Games Dashboard")
    .setDescription(
      `🛠️ **Maintenance:** ${maintenance ? "🔴 ON" : "🟢 OFF"}\n\n` +
      "Διάλεξε παιχνίδι από τα κουμπιά και ρύθμισε **κανάλι, winning rate και cooldown**.\n" +
      "Τα game channels είναι **strict**: οι members μπορούν να γράφουν μόνο την εντολή/guess του συγκεκριμένου game.\n" +
      "Το Guess Number είναι skill game, οπότε δεν έχει τυχαίο Win %."
    )
    .addFields(
      { name: "🎡 Spin", value: `Κανάλι: ${channelDisplay(settings, "spinChannelId")}\nWin: **${rateText(spin.winRate)}** • Cooldown: **${cooldownText(spin.cooldownHours)}**`, inline: false },
      { name: "🎟️ Scratch", value: `Κανάλι: ${channelDisplay(settings, "scratchChannelId")}\nJackpot/Win: **${rateText(scratch.winRate)}** • Cooldown: **${cooldownText(scratch.cooldownHours)}**`, inline: false },
      { name: "🎰 Slots", value: `Κανάλι: ${channelDisplay(settings, "slotsChannelId")}\nWin: **${rateText(slots.winRate)}** • Jackpot: **${rateText(slots.jackpotRate)}** • Cooldown: **${cooldownText(slots.cooldownHours)}**`, inline: false },
      { name: "🎯 Guess Number", value: `Κανάλι: ${channelDisplay(settings, "numberChannelId")}\n!setnumber <αριθμός> • χωρίς random winning rate`, inline: false }
    )
    .setColor(0x2b2d31)
    .setFooter({ text: "Mykonos Shop 2k26 • Dashboard v2.7.1" });
}

function dashboardComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("games:open:spin").setLabel("Spin").setEmoji("🎡").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("games:open:scratch").setLabel("Scratch").setEmoji("🎟️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("games:open:slots").setLabel("Slots").setEmoji("🎰").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("games:open:number").setLabel("Guess Number").setEmoji("🎯").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("games:refresh").setLabel("Refresh").setEmoji("🔄").setStyle(ButtonStyle.Secondary)
    )
  ];
}

function gameMeta(game) {
  return {
    spin: { label: "Spin", emoji: "🎡", channelKey: "spinChannelId" },
    scratch: { label: "Scratch", emoji: "🎟️", channelKey: "scratchChannelId" },
    slots: { label: "Slots", emoji: "🎰", channelKey: "slotsChannelId" },
    number: { label: "Guess Number", emoji: "🎯", channelKey: "numberChannelId" }
  }[game] || null;
}

function gameDashboardEmbed(guild, game) {
  const meta = gameMeta(game);
  const settings = guildSettings.get(guild.id) || {};
  if (!meta) return dashboardEmbed(guild);
  const embed = new EmbedBuilder()
    .setTitle(`${meta.emoji} ${meta.label} — Settings`)
    .setColor(0x2b2d31)
    .addFields({ name: "📢 Channel", value: channelDisplay(settings, meta.channelKey), inline: false });
  if (game === "number") {
    embed.addFields({ name: "🎯 Λειτουργία", value: "Δεν έχει random Win %. Κερδίζει όποιος βρει τον αριθμό που όρισες με `!setnumber`.", inline: false });
  } else {
    const config = getGameConfig(guild.id, game);
    embed.addFields(
      { name: "🏆 Winning rate", value: `**${rateText(config.winRate)}**`, inline: true },
      { name: "⏳ Cooldown", value: `**${cooldownText(config.cooldownHours)}**`, inline: true }
    );
    if (game === "slots") embed.addFields({ name: "💎 Jackpot rate", value: `**${rateText(config.jackpotRate)}**`, inline: true });
    if (game === "scratch") embed.addFields({ name: "ℹ️ Scratch win", value: "Το Winning rate είναι η πιθανότητα να εμφανιστεί το jackpot **777**.", inline: false });
  }
  return embed.setFooter({ text: "Mykonos Shop 2k26 • Dashboard v2.7.1" });
}

function gameDashboardComponents(game) {
  const meta = gameMeta(game);
  const rows = [
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`games:set-channel:${game}`)
        .setPlaceholder(`${meta.emoji} Επίλεξε ${meta.label} channel`)
        .setChannelTypes(ChannelType.GuildText)
        .setMinValues(1)
        .setMaxValues(1)
    )
  ];
  const buttons = [
    new ButtonBuilder().setCustomId("games:back").setLabel("Πίσω").setEmoji("⬅️").setStyle(ButtonStyle.Secondary)
  ];
  if (game !== "number") {
    buttons.unshift(new ButtonBuilder().setCustomId(`games:config:${game}`).setLabel("Win % / Cooldown").setEmoji("⚙️").setStyle(ButtonStyle.Primary));
  }
  rows.push(new ActionRowBuilder().addComponents(...buttons));
  return rows;
}

function configModal(guildId, game) {
  const meta = gameMeta(game);
  const config = getGameConfig(guildId, game);
  const modal = new ModalBuilder().setCustomId(`games:config-submit:${game}`).setTitle(`${meta.label} Settings`);
  const win = new TextInputBuilder()
    .setCustomId("winRate")
    .setLabel("Winning rate % (0 έως 100)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(String(config.winRate));
  const cooldown = new TextInputBuilder()
    .setCustomId("cooldownHours")
    .setLabel("Cooldown σε ώρες (0 έως 168)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(String(config.cooldownHours));
  modal.addComponents(new ActionRowBuilder().addComponents(win));
  if (game === "slots") {
    const jackpot = new TextInputBuilder()
      .setCustomId("jackpotRate")
      .setLabel("Jackpot % (0 έως Winning rate)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(String(config.jackpotRate));
    modal.addComponents(new ActionRowBuilder().addComponents(jackpot));
  }
  modal.addComponents(new ActionRowBuilder().addComponents(cooldown));
  return modal;
}

async function buildSlashCommands() {
  const gamesCommand = new SlashCommandBuilder()
    .setName("games")
    .setDescription("Mykonos Shop 2k26 games dashboard")
    .addSubcommand((sub) =>
      sub.setName("dashboard").setDescription("Άνοιγμα του Games Dashboard")
    )
    .toJSON();

  const maintenanceCommand = new SlashCommandBuilder()
    .setName("maintenance")
    .setDescription("Διαχείριση maintenance των games")
    .addSubcommand((sub) =>
      sub.setName("mode").setDescription("Ενεργοποίηση/απενεργοποίηση Maintenance Mode")
    )
    .toJSON();

  return [gamesCommand, maintenanceCommand];
}

async function registerSlashCommandsForGuild(guild) {
  const applicationId = client.application?.id;
  if (!applicationId) throw new Error("Application ID is unavailable");
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const commands = await buildSlashCommands();
  await rest.put(Routes.applicationGuildCommands(applicationId, guild.id), { body: commands });
  console.log(`✅ Registered /games dashboard and /maintenance mode in guild ${guild.id}.`);
}

async function registerSlashCommands() {
  for (const guild of client.guilds.cache.values()) {
    try {
      await registerSlashCommandsForGuild(guild);
    } catch (error) {
      console.error(`❌ Failed to register slash commands in guild ${guild.id}:`, error);
    }
  }
}

loadSettings();

client.once("clientReady", async () => {
  console.log("🚀 BUILD: Mykonos-DM-Bot v2.7.1 — BUGFIX AUDIT BUILD");
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log("🚀 Mykonos Shop 2k26 bot is online!");
  console.log("🎮 Per-game winning rates/cooldowns are configurable from /games dashboard");
  console.log("🛠️ /maintenance mode is enabled; game channels use strict per-game message rules");
  console.log("🎟️ Scratch uses an exact configurable jackpot/win rate; jackpot number remains 777");
  console.log(`🎮 Configured game channels: ${countConfiguredGameChannels()}`);
  try {
    await registerSlashCommands();
  } catch (error) {
    console.error("❌ Failed to register slash commands:", error);
  }
});

client.on("error", (error) => console.error("Discord client error:", error));
client.on("shardError", (error) => console.error("Discord shard error:", error));

client.on("guildCreate", async (guild) => {
  try {
    await registerSlashCommandsForGuild(guild);
  } catch (error) {
    console.error(`❌ Failed to register slash commands for new guild ${guild.id}:`, error);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "maintenance") {
      if (interaction.options.getSubcommand() !== "mode") return;
      if (!interaction.guild || !canManageGames(interaction.member, interaction.guild)) {
        await interaction.reply({ content: "❌ Μόνο Server Owner / Administrator / Manage Server μπορεί να αλλάξει το Maintenance Mode.", flags: MessageFlags.Ephemeral });
        return;
      }
      const current = guildSettings.get(interaction.guild.id) || {};
      const enabled = current.maintenanceMode !== true;
      guildSettings.set(interaction.guild.id, { ...current, maintenanceMode: enabled });
      saveSettings();
      await interaction.reply({
        content: enabled
          ? "🛠️ **Maintenance Mode: ON** — όλα τα games είναι προσωρινά κλειστά."
          : "✅ **Maintenance Mode: OFF** — τα games λειτουργούν ξανά.",
        flags: MessageFlags.Ephemeral,
      });
      console.log(`🛠️ Maintenance ${enabled ? "ON" : "OFF"}: guild=${interaction.guild.id}, by=${interaction.user.id}`);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "games") {
      if (interaction.options.getSubcommand() !== "dashboard") return;
      if (!canManageGames(interaction.member, interaction.guild)) {
        await interaction.reply({ content: "❌ Δεν έχεις permission για το Games Dashboard.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.reply({ embeds: [dashboardEmbed(interaction.guild)], components: dashboardComponents() });
      return;
    }

    if (!interaction.customId?.startsWith("games:")) return;
    if (!interaction.guild || !canManageGames(interaction.member, interaction.guild)) {
      if (interaction.isRepliable()) await interaction.reply({ content: "❌ Δεν έχεις permission για το Games Dashboard.", flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId === "games:refresh" || interaction.customId === "games:back") {
        await interaction.update({ embeds: [dashboardEmbed(interaction.guild)], components: dashboardComponents() });
        return;
      }
      if (interaction.customId.startsWith("games:open:")) {
        const game = interaction.customId.split(":")[2];
        if (!gameMeta(game)) return;
        await interaction.update({ embeds: [gameDashboardEmbed(interaction.guild, game)], components: gameDashboardComponents(game) });
        return;
      }
      if (interaction.customId.startsWith("games:config:")) {
        const game = interaction.customId.split(":")[2];
        if (!getGameConfig(interaction.guild.id, game)) return;
        await interaction.showModal(configModal(interaction.guild.id, game));
        return;
      }
    }

    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith("games:set-channel:")) {
      const game = interaction.customId.split(":")[2];
      const meta = gameMeta(game);
      if (!meta) return;
      const channelId = interaction.values[0];
      const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildText) {
        await interaction.reply({ content: "❌ Το κανάλι δεν είναι έγκυρο.", flags: MessageFlags.Ephemeral });
        return;
      }
      const current = guildSettings.get(interaction.guild.id) || {};
      const usedBy = Object.entries({
        spin: current.spinChannelId,
        scratch: current.scratchChannelId,
        slots: current.slotsChannelId,
        number: current.numberChannelId,
      }).find(([otherGame, usedChannelId]) => otherGame !== game && usedChannelId === channelId);
      if (usedBy) {
        await interaction.reply({
          content: `❌ Αυτό το κανάλι χρησιμοποιείται ήδη από το **${gameMeta(usedBy[0]).label}**. Για strict game channels επίλεξε διαφορετικό κανάλι.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const botMember = interaction.guild.members.me;
      const perms = botMember ? channel.permissionsFor(botMember) : null;
      if (!perms || !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.EmbedLinks])) {
        await interaction.reply({
          content: "❌ Για strict game channel το bot χρειάζεται **View Channel, Send Messages, Manage Messages και Embed Links** σε αυτό το κανάλι.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      guildSettings.set(interaction.guild.id, { ...current, [meta.channelKey]: channelId });
      saveSettings();
      await interaction.update({ embeds: [gameDashboardEmbed(interaction.guild, game)], components: gameDashboardComponents(game) });
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("games:config-submit:")) {
      const game = interaction.customId.split(":")[2];
      if (!getGameConfig(interaction.guild.id, game)) return;
      const parseInput = (id) => Number(interaction.fields.getTextInputValue(id).trim().replace(",", "."));
      const winRate = parseInput("winRate");
      const cooldownHours = parseInput("cooldownHours");
      if (!validRate(winRate)) {
        await interaction.reply({ content: "❌ Το Winning rate πρέπει να είναι αριθμός από **0 έως 100**.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (!validCooldownHours(cooldownHours)) {
        await interaction.reply({ content: "❌ Το cooldown πρέπει να είναι από **0 έως 168 ώρες**.", flags: MessageFlags.Ephemeral });
        return;
      }
      const current = guildSettings.get(interaction.guild.id) || {};
      const updated = { ...current };
      if (game === "spin") { updated.spinWinRate = normalizeNumber(winRate); updated.spinCooldownHours = normalizeNumber(cooldownHours); }
      if (game === "scratch") { updated.scratchWinRate = normalizeNumber(winRate); updated.scratchCooldownHours = normalizeNumber(cooldownHours); }
      if (game === "slots") {
        const jackpotRate = parseInput("jackpotRate");
        if (!validRate(jackpotRate) || jackpotRate > winRate) {
          await interaction.reply({ content: "❌ Το Jackpot % πρέπει να είναι από **0 έως το Winning rate**.", flags: MessageFlags.Ephemeral });
          return;
        }
        updated.slotsWinRate = normalizeNumber(winRate);
        updated.slotsJackpotRate = normalizeNumber(jackpotRate);
        updated.slotsCooldownHours = normalizeNumber(cooldownHours);
      }
      guildSettings.set(interaction.guild.id, updated);
      // Apply the new cooldown policy immediately instead of leaving users on an old expiry.
      clearCooldownsForGame(interaction.guild.id, game);
      saveSettings();
      await interaction.reply({
        content: `✅ Οι ρυθμίσεις του **${gameMeta(game).label}** αποθηκεύτηκαν. Win: **${rateText(winRate)}**, cooldown: **${cooldownText(cooldownHours)}**${game === "slots" ? `, jackpot: **${rateText(updated.slotsJackpotRate)}**` : ""}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } catch (error) {
    console.error("❌ interactionCreate handler error:", error);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Παρουσιάστηκε σφάλμα.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot || !message.guild) return;

    const content = message.content.trim();
    const lower = content.toLowerCase();

    // Strict per-game channels for regular members.
    if (await enforceStrictGameChannel(message, content, lower)) return;

    // ------------------------------------------------------------
    // !dmall <message>
    // ------------------------------------------------------------
    if (lower === COMMAND || lower.startsWith(`${COMMAND} `)) {
      if (message.author.id !== message.guild.ownerId) {
        await message.reply("❌ Μόνο ο Server Owner μπορεί να χρησιμοποιήσει το `!dmall`.");
        return;
      }

      const announcement = content.slice(COMMAND.length).trim();
      if (!announcement) {
        await message.reply("❌ Βάλε το μήνυμα μετά το `!dmall`.\nΠαράδειγμα: `!dmall Καλησπέρα!`");
        return;
      }
      if (dmallActiveGuilds.has(message.guild.id)) {
        await message.reply("⏳ Ένα `!dmall` βρίσκεται ήδη σε εξέλιξη σε αυτόν τον server. Περίμενε να ολοκληρωθεί.");
        return;
      }

      const now = Date.now();
      const lastSuccessfulRunAt = dmallLastSuccessfulRuns.get(message.guild.id) || 0;
      if (lastSuccessfulRunAt && now - lastSuccessfulRunAt < DMALL_COOLDOWN_MS) {
        const remaining = DMALL_COOLDOWN_MS - (now - lastSuccessfulRunAt);
        await message.reply(`⏳ Το \`!dmall\` είναι σε cooldown. Δοκίμασε ξανά σε περίπου ${formatRemaining(remaining)}.`);
        return;
      }

      dmallActiveGuilds.add(message.guild.id);
      let startMessage = null;
      try {
        startMessage = await message.reply("📨 Ξεκινάω την αποστολή του announcement.");
        let sent = 0;
        let failed = 0;
        const errorCounts = new Map();
        await message.guild.members.fetch();
        const members = [...message.guild.members.cache.values()].filter((member) => !member.user.bot);

        for (const member of members) {
          try {
            await member.send({ content: announcement });
            sent++;
          } catch (error) {
            failed++;
            const code = String(error?.code ?? error?.status ?? error?.rawError?.code ?? "unknown");
            errorCounts.set(code, (errorCounts.get(code) || 0) + 1);
          }
          await sleep(DMALL_DELAY_MS);
        }

        dmallLastSuccessfulRuns.set(message.guild.id, Date.now());
        saveSettings();
        const topErrors = [...errorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([code, count]) => `${code}: ${count}`).join(", ");
        await message.channel.send(`✅ Ολοκληρώθηκε.\n📨 Επιτυχείς αποστολές: **${sent}**\n⚠️ Αποτυχημένες/κλειστά DMs: **${failed}**${topErrors ? `\n🔎 Errors: **${topErrors}**` : ""}`);
      } catch (error) {
        console.error("❌ Fatal DM run error:", error);
        await message.channel.send("❌ Η διαδικασία σταμάτησε λόγω σφάλματος. Δεν ενεργοποιήθηκε νέο cooldown.");
      } finally {
        dmallActiveGuilds.delete(message.guild.id);
        if (startMessage) await startMessage.react("📨").catch(() => {});
      }
      return;
    }

    // ------------------------------------------------------------
    // !setnumber <number> — command can be typed anywhere; result is sent to configured game channel.
    // ------------------------------------------------------------
    if (lower === SET_NUMBER_COMMAND || lower.startsWith(`${SET_NUMBER_COMMAND} `)) {
      if (!canManageGames(message.member, message.guild)) {
        await message.reply("❌ Μόνο ο Server Owner ή κάποιος με **Administrator/Manage Server** μπορεί να χρησιμοποιήσει το `!setnumber`.");
        return;
      }
      if (await maintenanceBlocked(message)) return;

      const rawNumber = content.slice(SET_NUMBER_COMMAND.length).trim();
      if (!/^\d+$/.test(rawNumber)) {
        await message.reply("❌ Χρησιμοποίησε έναν θετικό ακέραιο αριθμό.\nΠαράδειγμα: `!setnumber 123`");
        return;
      }

      const number = Number(rawNumber);
      if (!Number.isSafeInteger(number) || number < 1 || number > 1000000) {
        await message.reply("❌ Ο αριθμός πρέπει να είναι από **1** έως **1.000.000**.");
        return;
      }

      const gameChannel = await requireGameChannel(message, "number");
      if (!gameChannel) return;

      activeNumbers.set(message.guild.id, {
        number,
        setById: message.author.id,
        setAt: Date.now(),
      });
      saveSettings();

      await message.delete().catch(() => {});
      await gameChannel.send("🎯 **Νέος γύρος αριθμού ξεκίνησε!** Γράψε τον αριθμό σου εδώ για να προσπαθήσεις να τον βρεις.");
      console.log(`🎯 Number game set: guild=${message.guild.id}, number=${number}, by=${message.author.id}, channel=${gameChannel.id}`);
      return;
    }

    // ------------------------------------------------------------
    // Plain numeric guess — ONLY in configured game channel.
    // ------------------------------------------------------------
    const activeGame = activeNumbers.get(message.guild.id);
    if (activeGame && /^\d+$/.test(content)) {
      const gameChannelId = getConfiguredChannelId(message.guild.id, "number");
      if (message.channel.id !== gameChannelId) return;
      if (await maintenanceBlocked(message)) return;

      const guess = Number(content);
      if (!Number.isSafeInteger(guess)) return;
      if (guess === activeGame.number) {
        activeNumbers.delete(message.guild.id);
        saveSettings();
        await message.reply(`🎉 **Σωστό!** ${message.author} βρήκε τον αριθμό **${guess}**! 🏆\nΤο παιχνίδι τελείωσε.`);
        console.log(`🏆 Number game won: guild=${message.guild.id}, number=${guess}, winner=${message.author.id}`);
      }
      return;
    }

    // ------------------------------------------------------------
    // !spin — 18% win chance, 3-hour per-user/per-guild cooldown.
    // ------------------------------------------------------------
    if (lower === SPIN_COMMAND) {
      if (!(await ensureCommandChannel(message, "spin"))) return;
      if (await maintenanceBlocked(message)) return;
      const gameChannel = await getGameChannel(message.guild, "spin");
      if (!gameChannel) return;

      const key = cooldownKey(message.guild.id, message.author.id, "spin");
      const now = Date.now();
      const cooldownUntil = gameCooldowns.get(key) || 0;
      if (now < cooldownUntil) {
        await message.reply(`⏳ Έχεις spin cooldown ακόμα **${formatGameCooldown(cooldownUntil - now)}**.`);
        return;
      }

      if (gameLocks.has(key)) return;
      gameLocks.add(key);
      try {
        const config = getGameConfig(message.guild.id, "spin");
        const won = Math.random() < config.winRate / 100;
        const resultEmbed = won
          ? createShopEmbed("🎡 SPIN THE WHEEL", `🎉 ${message.author} **ΚΕΡΔΙΣΕ!**\n\nΗ τύχη ήταν με το μέρος σου! 🍀\n**Πιθανότητα νίκης: ${rateText(config.winRate)}**`).setThumbnail(getMemberAvatarUrl(message.author))
          : createShopEmbed("🎡 SPIN THE WHEEL", `😔 ${message.author} **δεν κέρδισε αυτή τη φορά.**\n\nΔοκίμασε ξανά την τύχη σου! 🍀\n**Πιθανότητα νίκης: ${rateText(config.winRate)}**`).setThumbnail(getMemberAvatarUrl(message.author));

        await gameChannel.send({ embeds: [resultEmbed] });
        setCooldown(message.guild.id, message.author.id, "spin");
        saveSettings();
      } finally {
        gameLocks.delete(key);
      }
      return;
    }

    // ------------------------------------------------------------
    // !scratch — 1..1000, jackpot 777, 3-hour per-user/per-guild cooldown.
    // ------------------------------------------------------------
    if (lower === SCRATCH_COMMAND) {
      if (!(await ensureCommandChannel(message, "scratch"))) return;
      if (await maintenanceBlocked(message)) return;
      const gameChannel = await getGameChannel(message.guild, "scratch");
      if (!gameChannel) return;

      const key = cooldownKey(message.guild.id, message.author.id, "scratch");
      const now = Date.now();
      const cooldownUntil = gameCooldowns.get(key) || 0;
      if (now < cooldownUntil) {
        await message.reply(`⏳ Έχεις scratch cooldown ακόμα **${formatGameCooldown(cooldownUntil - now)}**.`);
        return;
      }

      if (gameLocks.has(key)) return;
      gameLocks.add(key);
      try {
        const config = getGameConfig(message.guild.id, "scratch");
        const isJackpot = Math.random() < config.winRate / 100;
        let number;
        if (isJackpot) {
          number = SCRATCH_JACKPOT_NUMBER;
        } else {
          do {
            number = Math.floor(Math.random() * SCRATCH_MAX) + 1;
          } while (number === SCRATCH_JACKPOT_NUMBER);
        }
        const description = isJackpot
          ? `🎉 ${message.author} ο αριθμός σου είναι **${number}**.\n\n💰 **JACKPOT!** Συγχαρητήρια! 🏆`
          : `${message.author} ο αριθμός σου είναι **${number}**.\n\nΔεν ήταν jackpot αυτή τη φορά — καλή τύχη στο επόμενο! 🍀`;
        const embed = createShopEmbed("🎟️ SCRATCH RESULT", description)
          .setThumbnail(getMemberAvatarUrl(message.author))
          .setTimestamp();
        await gameChannel.send({ embeds: [embed] });
        setCooldown(message.guild.id, message.author.id, "scratch");
        saveSettings();
      } finally {
        gameLocks.delete(key);
      }
      return;
    }

    // ------------------------------------------------------------
    // !slots — 3-hour per-user/per-guild cooldown.
    // ------------------------------------------------------------
    if (lower === SLOTS_COMMAND) {
      if (!(await ensureCommandChannel(message, "slots"))) return;
      if (await maintenanceBlocked(message)) return;
      const gameChannel = await getGameChannel(message.guild, "slots");
      if (!gameChannel) return;

      const key = cooldownKey(message.guild.id, message.author.id, "slots");
      const now = Date.now();
      const cooldownUntil = gameCooldowns.get(key) || 0;
      if (now < cooldownUntil) {
        await message.reply(`⏳ Έχεις slots cooldown ακόμα **${formatGameCooldown(cooldownUntil - now)}**.`);
        return;
      }

      if (gameLocks.has(key)) return;
      gameLocks.add(key);
      try {
        const config = getGameConfig(message.guild.id, "slots");
        const roll = Math.random() * 100;
        const isJackpot = roll < config.jackpotRate;
        const isCherryWin = !isJackpot && roll < config.winRate;
        const losingSymbols = ["🍒", "🍋", "⭐", "🔔", "💎"];
        let reels;
        if (isJackpot) {
          reels = ["💎", "💎", "💎"];
        } else if (isCherryWin) {
          reels = ["🍒", "🍒", "🍒"];
        } else {
          do {
            reels = Array.from({ length: 3 }, () => losingSymbols[Math.floor(Math.random() * losingSymbols.length)]);
          } while (reels.every((s) => s === "💎") || reels.every((s) => s === "🍒"));
        }

        let resultText;
        if (isJackpot) {
          resultText = `🎉 ${message.author} **JACKPOT!**\n\n**${reels.join(" │ ")}**\n\nΠέτυχες **3 💎**! 🏆\nJackpot rate: **${rateText(config.jackpotRate)}**`;
        } else if (isCherryWin) {
          resultText = `🎉 ${message.author} **ΚΕΡΔΙΣΕ!**\n\n**${reels.join(" │ ")}**\n\nΠέτυχες **3 🍒**! 🍀\nWinning rate: **${rateText(config.winRate)}**`;
        } else {
          resultText = `${message.author} δεν κέρδισες αυτή τη φορά.\n\n**${reels.join(" │ ")}**\n\nΔοκίμασε ξανά όταν λήξει το cooldown! 🍀`;
        }

        const embed = createShopEmbed("🎰 MYKONOS SLOTS", resultText)
          .setThumbnail(getMemberAvatarUrl(message.author))
          .setTimestamp();

        await gameChannel.send({ embeds: [embed] });
        setCooldown(message.guild.id, message.author.id, "slots");
        saveSettings();
      } finally {
        gameLocks.delete(key);
      }
      return;
    }

  } catch (error) {
    console.error("❌ messageCreate handler error:", error);
  }
});

client.login(TOKEN).catch((error) => {
  console.error("❌ Discord login failed:", error);
  process.exit(1);
});

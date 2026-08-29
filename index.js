require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  REST,
  Routes,
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

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

const DMALL_COOLDOWN_MS = 60 * 60 * 1000;
const DMALL_DELAY_MS = 1500;
const SPIN_WIN_CHANCE = 0.18;
const GAME_COOLDOWN_MS = 3 * 60 * 60 * 1000;
const SCRATCH_MAX = 1000;
const SCRATCH_JACKPOT_NUMBER = 777;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "games.json");

let lastSuccessfulRunAt = 0;
let isSending = false;
const activeNumbers = new Map();
const gameCooldowns = new Map(); // `${guildId}:${userId}:${game}` -> expiry
const gameLocks = new Set();
const guildSettings = new Map(); // guildId -> { channelId }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadSettings() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    const guilds = parsed?.guilds && typeof parsed.guilds === "object" ? parsed.guilds : {};

    for (const [guildId, settings] of Object.entries(guilds)) {
      if (settings && typeof settings.channelId === "string") {
        guildSettings.set(guildId, { channelId: settings.channelId });
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
  } catch (error) {
    console.error("❌ Could not read games settings:", error);
  }
}

function saveSettings() {
  ensureDataDir();
  const guilds = {};
  for (const [guildId, settings] of guildSettings.entries()) {
    guilds[guildId] = { channelId: settings.channelId };
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

  const output = { version: 1, guilds, cooldowns };
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

function getConfiguredChannelId(guildId) {
  return guildSettings.get(guildId)?.channelId || null;
}

async function getGameChannel(guild) {
  const channelId = getConfiguredChannelId(guild.id);
  if (!channelId) return null;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return null;
  return channel;
}

async function requireGameChannel(message) {
  const channel = await getGameChannel(message.guild);
  if (!channel) {
    await message.reply(
      "❌ Δεν έχει οριστεί κανάλι παιχνιδιών. Ένας Administrator/Server Owner πρέπει να χρησιμοποιήσει `/games dashboard` και να επιλέξει κανάλι."
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
  gameCooldowns.set(cooldownKey(guildId, userId, game), Date.now() + GAME_COOLDOWN_MS);
}

function dashboardEmbed(guild) {
  const channelId = getConfiguredChannelId(guild.id);
  const channelText = channelId ? `<#${channelId}>` : "❌ Δεν έχει οριστεί";
  return new EmbedBuilder()
    .setTitle("🎮 Mykonos Shop 2k26 — Games Dashboard")
    .setDescription(
      "Ρύθμισε το κανάλι όπου θα εμφανίζονται τα παιχνίδια. Οι commands `!spin`, `!scratch` και `!setnumber` μπορούν να σταλούν από οποιοδήποτε text channel, αλλά τα game αποτελέσματα πηγαίνουν στο επιλεγμένο κανάλι.\n\n" +
      `📢 **Game channel:** ${channelText}\n` +
      "🎡 **!spin:** 18% πιθανότητα νίκης • cooldown 3 ώρες\n" +
      "🎟️ **!scratch:** 1–1000 • jackpot 777 • cooldown 3 ώρες\n" +
      "🎯 **!setnumber:** χωρίς cooldown • το μήνυμα του command διαγράφεται\n" +
      "🔢 **Guess:** ο αριθμός γράφεται απευθείας στο game channel • χωρίς cooldown"
    )
    .setColor(0x2b2d31)
    .setFooter({ text: "Mykonos Shop 2k26" });
}

function dashboardComponents() {
  const select = new ChannelSelectMenuBuilder()
    .setCustomId("games:set-channel")
    .setPlaceholder("🎮 Επίλεξε το game channel")
    .setChannelTypes(ChannelType.GuildText)
    .setMinValues(1)
    .setMaxValues(1);

  const row = new ActionRowBuilder().addComponents(select);
  const refresh = new ButtonBuilder()
    .setCustomId("games:refresh")
    .setLabel("Ανανέωση Dashboard")
    .setEmoji("🔄")
    .setStyle(ButtonStyle.Secondary);
  return [row, new ActionRowBuilder().addComponents(refresh)];
}

async function registerSlashCommands() {
  const applicationId = client.application?.id;
  if (!applicationId) {
    console.warn("⚠️ Application ID is unavailable; /games dashboard was not registered.");
    return;
  }

  const command = new SlashCommandBuilder()
    .setName("games")
    .setDescription("Mykonos Shop 2k26 games dashboard")
    .addSubcommand((sub) =>
      sub.setName("dashboard").setDescription("Άνοιγμα του Games Dashboard")
    )
    .toJSON();

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  for (const guild of client.guilds.cache.values()) {
    await rest.put(Routes.applicationGuildCommands(applicationId, guild.id), { body: [command] });
    console.log(`✅ Registered /games dashboard in guild ${guild.id}.`);
  }
}

loadSettings();

client.once("clientReady", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log("🚀 Mykonos Shop 2k26 bot is online!");
  console.log("🎡 !spin win chance: 18%, cooldown: 3h");
  console.log("🎟️ !scratch jackpot: 777 / 1000, cooldown: 3h");
  console.log(`🎮 Configured game channels: ${guildSettings.size}`);
  try {
    await registerSlashCommands();
  } catch (error) {
    console.error("❌ Failed to register /games dashboard:", error);
  }
});

client.on("error", (error) => console.error("Discord client error:", error));
client.on("shardError", (error) => console.error("Discord shard error:", error));

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "games") {
      if (interaction.options.getSubcommand() !== "dashboard") return;
      if (!canManageGames(interaction.member, interaction.guild)) {
        await interaction.reply({ content: "❌ Δεν έχεις permission για το Games Dashboard.", ephemeral: true });
        return;
      }
      await interaction.reply({
        embeds: [dashboardEmbed(interaction.guild)],
        components: dashboardComponents(),
      });
      return;
    }

    if (!interaction.isButton() && !interaction.isChannelSelectMenu()) return;
    if (!interaction.customId.startsWith("games:")) return;

    if (!canManageGames(interaction.member, interaction.guild)) {
      await interaction.reply({ content: "❌ Δεν έχεις permission για το Games Dashboard.", ephemeral: true });
      return;
    }

    if (interaction.customId === "games:set-channel") {
      const channelId = interaction.values[0];
      const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildText) {
        await interaction.reply({ content: "❌ Το κανάλι δεν είναι έγκυρο.", ephemeral: true });
        return;
      }

      guildSettings.set(interaction.guild.id, { channelId });
      saveSettings();
      await interaction.update({
        embeds: [dashboardEmbed(interaction.guild)],
        components: dashboardComponents(),
      });
      return;
    }

    if (interaction.customId === "games:refresh") {
      await interaction.update({
        embeds: [dashboardEmbed(interaction.guild)],
        components: dashboardComponents(),
      });
    }
  } catch (error) {
    console.error("❌ interactionCreate handler error:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Παρουσιάστηκε σφάλμα.", ephemeral: true }).catch(() => {});
    }
  }
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot || !message.guild) return;

    const content = message.content.trim();
    const lower = content.toLowerCase();

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
      if (isSending) {
        await message.reply("⏳ Ένα `!dmall` βρίσκεται ήδη σε εξέλιξη. Περίμενε να ολοκληρωθεί.");
        return;
      }

      const now = Date.now();
      if (lastSuccessfulRunAt && now - lastSuccessfulRunAt < DMALL_COOLDOWN_MS) {
        const remaining = DMALL_COOLDOWN_MS - (now - lastSuccessfulRunAt);
        await message.reply(`⏳ Το \`!dmall\` είναι σε cooldown. Δοκίμασε ξανά σε περίπου ${formatRemaining(remaining)}.`);
        return;
      }

      isSending = true;
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

        lastSuccessfulRunAt = Date.now();
        const topErrors = [...errorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([code, count]) => `${code}: ${count}`).join(", ");
        await message.channel.send(`✅ Ολοκληρώθηκε.\n📨 Επιτυχείς αποστολές: **${sent}**\n⚠️ Αποτυχημένες/κλειστά DMs: **${failed}**${topErrors ? `\n🔎 Errors: **${topErrors}**` : ""}`);
      } catch (error) {
        console.error("❌ Fatal DM run error:", error);
        lastSuccessfulRunAt = 0;
        await message.channel.send("❌ Η διαδικασία σταμάτησε λόγω σφάλματος. Δεν ενεργοποιήθηκε cooldown.");
      } finally {
        isSending = false;
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

      const gameChannel = await requireGameChannel(message);
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
      const gameChannelId = getConfiguredChannelId(message.guild.id);
      if (message.channel.id !== gameChannelId) return;

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
      const gameChannel = await requireGameChannel(message);
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
        const won = Math.random() < SPIN_WIN_CHANCE;
        const resultEmbed = won
          ? createShopEmbed("🎡 SPIN THE WHEEL", `🎉 ${message.author} **ΚΕΡΔΙΣΕ!**\n\nΗ τύχη ήταν με το μέρος σου! 🍀\n**Πιθανότητα νίκης: 18%**`).setThumbnail(getMemberAvatarUrl(message.author))
          : createShopEmbed("🎡 SPIN THE WHEEL", `😔 ${message.author} **δεν κέρδισε αυτή τη φορά.**\n\nΔοκίμασε ξανά την τύχη σου! 🍀\n**Πιθανότητα νίκης: 18%**`).setThumbnail(getMemberAvatarUrl(message.author));

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
      const gameChannel = await requireGameChannel(message);
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
        const number = Math.floor(Math.random() * SCRATCH_MAX) + 1;
        const isJackpot = number === SCRATCH_JACKPOT_NUMBER;
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
  } catch (error) {
    console.error("❌ messageCreate handler error:", error);
  }
});

client.login(TOKEN).catch((error) => {
  console.error("❌ Discord login failed:", error);
  process.exit(1);
});

require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  EmbedBuilder,
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

// !dmall safety
const DMALL_COOLDOWN_MS = 60 * 60 * 1000;
const DMALL_DELAY_MS = 1500;

// Game settings
const SPIN_WIN_CHANCE = 0.18; // EXACTLY 18%
const SCRATCH_MAX = 1000;
const SCRATCH_JACKPOT_NUMBER = 777;
const SCRATCH_COOLDOWN_MS = 3 * 60 * 60 * 1000;

// Runtime state. Each guild has its own active guessing number.
let lastSuccessfulRunAt = 0;
let isSending = false;
const activeNumbers = new Map(); // guildId -> { number, setById, setAt }
const scratchCooldowns = new Map(); // userId -> timestamp when cooldown expires
const scratchInProgress = new Set(); // prevents concurrent !scratch requests from the same user

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatRemaining(ms) {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60000));
  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes ? `${hours} ώρα και ${minutes} λεπτά` : `${hours} ώρα`;
  }
  return `${totalMinutes} λεπτά`;
}


function formatScratchCooldown(ms) {
  const safeMs = Math.max(0, ms);
  if (safeMs >= 60 * 60 * 1000) {
    return `${Math.ceil(safeMs / (60 * 60 * 1000))}ω`;
  }
  return `${Math.max(1, Math.ceil(safeMs / 60000))}λ`;
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

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log("🚀 Mykonos Shop 2k26 bot is online!");
  console.log("🎡 !spin win chance: 18%");
  console.log("🎟️ !scratch jackpot: 777 / 1000");
});

client.on("error", (error) => {
  console.error("Discord client error:", error);
});

client.on("shardError", (error) => {
  console.error("Discord shard error:", error);
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
        await message.reply(
          "❌ Βάλε το μήνυμα μετά το `!dmall`.\nΠαράδειγμα: `!dmall Καλησπέρα!`"
        );
        return;
      }

      if (isSending) {
        await message.reply(
          "⏳ Ένα `!dmall` βρίσκεται ήδη σε εξέλιξη. Περίμενε να ολοκληρωθεί."
        );
        return;
      }

      const now = Date.now();
      if (lastSuccessfulRunAt && now - lastSuccessfulRunAt < DMALL_COOLDOWN_MS) {
        const remaining = DMALL_COOLDOWN_MS - (now - lastSuccessfulRunAt);
        await message.reply(
          `⏳ Το \`!dmall\` είναι σε cooldown. Δοκίμασε ξανά σε περίπου ${formatRemaining(remaining)}.`
        );
        return;
      }

      isSending = true;
      let startMessage = null;

      try {
        startMessage = await message.reply(
          "📨 Ξεκινάω την αποστολή του announcement."
        );

        let sent = 0;
        let failed = 0;
        const errorCounts = new Map();

        await message.guild.members.fetch();

        const members = [...message.guild.members.cache.values()].filter(
          (member) => !member.user.bot
        );

        console.log(
          `📋 DM run started: guild=${message.guild.id}, members=${members.length}`
        );

        for (const member of members) {
          try {
            await member.send({ content: announcement });
            sent++;
          } catch (error) {
            failed++;

            const code = String(
              error?.code ?? error?.status ?? error?.rawError?.code ?? "unknown"
            );
            errorCounts.set(code, (errorCounts.get(code) || 0) + 1);

            console.log(
              `DM failed: member=${member.id} code=${code} status=${error?.status ?? "unknown"} message=${error?.message ?? "unknown"}`
            );
          }

          // Delay after every member to reduce rate-limit pressure.
          await sleep(DMALL_DELAY_MS);
        }

        // The loop completed normally, so cooldown is valid.
        lastSuccessfulRunAt = Date.now();

        const topErrors = [...errorCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([code, count]) => `${code}: ${count}`)
          .join(", ");

        await message.channel.send(
          `✅ Ολοκληρώθηκε.\n` +
            `📨 Επιτυχείς αποστολές: **${sent}**\n` +
            `⚠️ Αποτυχημένες/κλειστά DMs: **${failed}**` +
            (topErrors ? `\n🔎 Errors: **${topErrors}**` : "")
        );

        console.log(`✅ DM run completed: sent=${sent} failed=${failed}`);
      } catch (error) {
        console.error("❌ Fatal DM run error:", error);
        lastSuccessfulRunAt = 0;

        await message.channel.send(
          "❌ Η διαδικασία σταμάτησε λόγω σφάλματος του bot/Discord API. Δεν ενεργοποιήθηκε cooldown."
        );
      } finally {
        isSending = false;

        if (startMessage) {
          try {
            await startMessage.react("📨");
          } catch {
            // Ignore reaction errors.
          }
        }
      }

      return;
    }

    // ------------------------------------------------------------
    // !setnumber <number>
    // ------------------------------------------------------------
    if (lower === SET_NUMBER_COMMAND || lower.startsWith(`${SET_NUMBER_COMMAND} `)) {
      if (!canManageGames(message.member, message.guild)) {
        await message.reply(
          "❌ Μόνο ο Server Owner ή κάποιος με **Administrator/Manage Server** μπορεί να χρησιμοποιήσει το `!setnumber`."
        );
        return;
      }

      const rawNumber = content.slice(SET_NUMBER_COMMAND.length).trim();

      // Keep the game simple and safe: positive integer, max 1,000,000.
      if (!/^\d+$/.test(rawNumber)) {
        await message.reply(
          "❌ Χρησιμοποίησε έναν θετικό ακέραιο αριθμό.\nΠαράδειγμα: `!setnumber 123`"
        );
        return;
      }

      const number = Number(rawNumber);

      if (!Number.isSafeInteger(number) || number < 1 || number > 1000000) {
        await message.reply("❌ Ο αριθμός πρέπει να είναι από **1** έως **1.000.000**.");
        return;
      }

      activeNumbers.set(message.guild.id, {
        number,
        setById: message.author.id,
        setAt: Date.now(),
      });

      await message.reply(
        "🎯 Ο αριθμός ορίστηκε κρυφά. Οι members μπορούν τώρα να γράψουν τον αριθμό τους στο chat για να προσπαθήσουν να τον βρουν."
      );
      console.log(
        `🎯 Number game set: guild=${message.guild.id}, number=${number}, by=${message.author.id}`
      );
      return;
    }

    // ------------------------------------------------------------
    // Number guessing: a plain numeric message guesses the active number.
    // ------------------------------------------------------------
    const activeGame = activeNumbers.get(message.guild.id);

    if (activeGame && /^\d+$/.test(content)) {
      const guess = Number(content);

      if (!Number.isSafeInteger(guess)) return;

      if (guess === activeGame.number) {
        activeNumbers.delete(message.guild.id);

        await message.reply(
          `🎉 **Σωστό!** ${message.author} βρήκε τον αριθμό **${guess}**! 🏆\n` +
            `Το παιχνίδι τελείωσε. Ένας ανώτερος μπορεί να ξεκινήσει νέο γύρο με \`!setnumber <αριθμός>\`.`
        );

        console.log(
          `🏆 Number game won: guild=${message.guild.id}, number=${guess}, winner=${message.author.id}`
        );
      }

      return;
    }

    // ------------------------------------------------------------
    // !spin — Spin the Wheel
    // Exactly 18% winning probability.
    // ------------------------------------------------------------
    if (lower === "!spin") {
      const won = Math.random() < SPIN_WIN_CHANCE;

      if (won) {
        await message.reply({
          embeds: [
            createShopEmbed(
              "🎡 SPIN THE WHEEL",
              `🎉 ${message.author} **ΚΕΡΔΙΣΕ!**\n\nΗ τύχη ήταν με το μέρος σου! 🍀\n**Πιθανότητα νίκης: 18%**`
            ).setThumbnail(getMemberAvatarUrl(message.author)),
          ],
        });
      } else {
        await message.reply({
          embeds: [
            createShopEmbed(
              "🎡 SPIN THE WHEEL",
              `😔 ${message.author} **δεν κέρδισε αυτή τη φορά.**\n\nΔοκίμασε ξανά την τύχη σου! 🍀\n**Πιθανότητα νίκης: 18%**`
            ).setThumbnail(getMemberAvatarUrl(message.author)),
          ],
        });
      }

      return;
    }

    // ------------------------------------------------------------
    // !scratch — random 1..1000; 777 is the jackpot.
    // ------------------------------------------------------------
    if (lower === "!scratch") {
      const userId = message.author.id;
      const now = Date.now();
      const cooldownUntil = scratchCooldowns.get(userId) || 0;

      if (now < cooldownUntil || scratchInProgress.has(userId)) {
        const remaining = Math.max(0, cooldownUntil - now);
        const cooldownText = formatScratchCooldown(remaining || SCRATCH_COOLDOWN_MS);
        await message.reply(
          `⏳ Έχεις scratch cooldown ακόμα **${cooldownText}**.`
        );
        return;
      }

      // Lock immediately so two nearly simultaneous messages cannot both win a scratch.
      scratchInProgress.add(userId);
      scratchCooldowns.set(userId, now + SCRATCH_COOLDOWN_MS);

      try {
        const number = Math.floor(Math.random() * SCRATCH_MAX) + 1;
        const isJackpot = number === SCRATCH_JACKPOT_NUMBER;

        const description = isJackpot
          ? `🎉 ${message.author} ο αριθμός σου είναι **${number}**.\n\n💰 **JACKPOT!** Συγχαρητήρια! 🏆`
          : `${message.author} ο αριθμός σου είναι **${number}**.\n\nΔεν ήταν jackpot αυτή τη φορά — καλή τύχη στο επόμενο! 🍀`;

        const embed = createShopEmbed("🎟️ SCRATCH RESULT", description)
          .setThumbnail(getMemberAvatarUrl(message.author))
          .setTimestamp();

        await message.reply({ embeds: [embed] });
        console.log(
          `🎟️ Scratch: guild=${message.guild.id}, user=${userId}, number=${number}, jackpot=${isJackpot}`
        );
      } catch (error) {
        // If Discord rejects the result, do not charge the user a 3-hour cooldown.
        scratchCooldowns.delete(userId);
        throw error;
      } finally {
        scratchInProgress.delete(userId);
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

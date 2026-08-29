require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
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
const COOLDOWN_MS = 60 * 60 * 1000;
const DELAY_MS = 1500;

let lastSuccessfulRunAt = 0;
let isSending = false;

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

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log("🚀 Mykonos DM Bot is online!");
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

    if (lower !== COMMAND && !lower.startsWith(`${COMMAND} `)) return;

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
    if (lastSuccessfulRunAt && now - lastSuccessfulRunAt < COOLDOWN_MS) {
      const remaining = COOLDOWN_MS - (now - lastSuccessfulRunAt);
      await message.reply(
        `⏳ Το \`!dmall\` είναι σε cooldown. Δοκίμασε ξανά σε περίπου ${formatRemaining(remaining)}.`
      );
      return;
    }

    isSending = true;

    const startMessage = await message.reply(
      "📨 Ξεκινάω την αποστολή του announcement."
    );

    let sent = 0;
    let failed = 0;
    const errorCounts = new Map();
    let fatalError = null;

    try {
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
          await sleep(DELAY_MS);
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
      }

      // Cooldown starts ONLY after a run that actually completed.
      // A completed run may have failed DMs because individual users can block DMs.
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
    } catch (error) {
      fatalError = error;
      console.error("❌ Fatal DM run error:", error);

      // No cooldown if the run itself failed before normal completion.
      lastSuccessfulRunAt = 0;

      await message.channel.send(
        "❌ Η διαδικασία σταμάτησε λόγω σφάλματος του bot/Discord API. Δεν ενεργοποιήθηκε cooldown."
      );
    } finally {
      isSending = false;

      try {
        await startMessage.react("📨");
      } catch {
        // Ignore reaction errors.
      }

      if (fatalError) {
        console.log("ℹ️ DM run ended with a fatal error; cooldown reset.");
      } else {
        console.log(
          `✅ DM run completed: sent=${sent} failed=${failed}`
        );
      }
    }
  } catch (error) {
    console.error("❌ messageCreate handler error:", error);
  }
});

client.login(TOKEN).catch((error) => {
  console.error("❌ Discord login failed:", error);
  process.exit(1);
});

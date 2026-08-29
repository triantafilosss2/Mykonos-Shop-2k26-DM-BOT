require("dotenv").config();

const { Client, GatewayIntentBits } = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) {
  console.error("❌ DISCORD_TOKEN is missing. Add it in Railway Variables.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessages
  ]
});

const PREFIX = "!";
const COMMAND = "dmall";
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const DELAY_MS = 1500; // Delay between successful DM attempts

let lastStartedAt = 0;
let isSending = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log("🚀 Mykonos DM Bot is online!");
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const command = `${PREFIX}${COMMAND}`;
  const content = message.content.trim();

  // Accept exactly !dmall, or !dmall followed by at least one space.
  if (
    content !== command &&
    !content.toLowerCase().startsWith(`${command} `)
  ) {
    return;
  }

  // Only the server owner can use this command.
  if (message.author.id !== message.guild.ownerId) {
    return message.reply(
      "❌ Μόνο ο Owner του server μπορεί να χρησιμοποιήσει αυτή την εντολή."
    );
  }

  const announcement = content.slice(command.length).trim();

  // Never start cooldown or sending when no message was supplied.
  if (!announcement) {
    return message.reply(
      "❌ Γράψε το μήνυμα μετά το `!dmall`.\nΠαράδειγμα: `!dmall Καλησπέρα παιδιά!`"
    );
  }

  // Prevent two DM runs from running at the same time.
  if (isSending) {
    return message.reply(
      "⏳ Ένα !dmall βρίσκεται ήδη σε εξέλιξη. Περίμενε να ολοκληρωθεί."
    );
  }

  const now = Date.now();

  if (lastStartedAt && now - lastStartedAt < COOLDOWN_MS) {
    const remaining = Math.ceil(
      (COOLDOWN_MS - (now - lastStartedAt)) / 60000
    );

    return message.reply(
      `⏳ Το !dmall είναι σε cooldown. Δοκίμασε ξανά σε περίπου ${remaining} λεπτά.`
    );
  }

  isSending = true;
  lastStartedAt = now;

  await message.reply("📨 Ξεκινάω την αποστολή του announcement.");

  let sent = 0;
  let failed = 0;
  let firstErrorCode = null;

  try {
    await message.guild.members.fetch();

    const members = message.guild.members.cache.filter(
      (member) => !member.user.bot
    );

    console.log(
      `Starting DM run in ${message.guild.name}: ${members.size} non-bot members`
    );

    for (const [, member] of members) {
      try {
        await member.send(announcement);
        sent++;

        // Keep requests spaced out.
        await sleep(DELAY_MS);
      } catch (error) {
        failed++;

        if (!firstErrorCode) {
          firstErrorCode = error?.code ?? error?.status ?? "unknown";
        }

        console.log(
          `DM failed for member ${member.id}: code=${error?.code ?? "unknown"} status=${error?.status ?? "unknown"}`
        );
      }
    }

    // Cooldown is kept after a completed run.
    await message.channel.send(
      `✅ Ολοκληρώθηκε.\n` +
      `📨 Επιτυχείς αποστολές: **${sent}**\n` +
      `⚠️ Αποτυχημένες/κλειστά DMs: **${failed}**` +
      (firstErrorCode
        ? `\n🔎 Πρώτος error code: **${firstErrorCode}**`
        : "")
    );
  } catch (error) {
    console.error("DM run error:", error);

    // If the whole run failed before processing members, don't lock the owner
    // out for an hour because of a bot/API/runtime error.
    if (sent === 0 && failed === 0) {
      lastStartedAt = 0;
    }

    await message.channel.send(
      "❌ Η διαδικασία σταμάτησε λόγω σφάλματος. Το cooldown δεν θα μείνει ενεργό αν δεν στάλθηκε κανένα DM."
    );
  } finally {
    isSending = false;
  }
});

client.login(TOKEN).catch((error) => {
  console.error("❌ Discord login failed:", error);
  process.exit(1);
});

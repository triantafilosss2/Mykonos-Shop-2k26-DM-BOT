require("dotenv").config();

const {
  Client,
  GatewayIntentBits
} = require("discord.js");

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
const COOLDOWN = 60 * 60 * 1000; // 1 hour

let lastUsed = 0;

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log("🚀 Mykonos DM Bot is online!");
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const prefix = `${PREFIX}${COMMAND}`;
  if (!message.content.toLowerCase().startsWith(prefix.toLowerCase())) return;

  const announcement = message.content.slice(prefix.length).trim();

  // Only the server owner can use the command.
  if (message.author.id !== message.guild.ownerId) {
    return message.reply("❌ Μόνο ο Owner του server μπορεί να χρησιμοποιήσει αυτή την εντολή.");
  }

  if (!announcement) {
    return message.reply("❌ Γράψε και το μήνυμα μετά το `!dmall`.");
  }

  const now = Date.now();
  if (now - lastUsed < COOLDOWN) {
    const remaining = Math.ceil((COOLDOWN - (now - lastUsed)) / 60000);
    return message.reply(`⏳ Το `!dmall` είναι σε cooldown. Δοκίμασε ξανά σε περίπου ${remaining} λεπτά.`);
  }

  // Set cooldown before starting so repeated commands cannot start another run.
  lastUsed = now;

  await message.reply("📨 Ξεκινάω την αποστολή του announcement.");

  try {
    await message.guild.members.fetch();

    const members = message.guild.members.cache.filter(
      (member) => !member.user.bot
    );

    let sent = 0;
    let failed = 0;

    for (const [, member] of members) {
      try {
        await member.send(announcement);
        sent++;
        // Keep requests spaced out.
        await new Promise((resolve) => setTimeout(resolve, 1500));
      } catch {
        failed++;
      }
    }

    await message.channel.send(
      `✅ Ολοκληρώθηκε.\n📨 Επιτυχείς αποστολές: **${sent}**\n⚠️ Αποτυχημένες/κλειστά DMs: **${failed}**`
    );
  } catch (error) {
    console.error(error);
    await message.channel.send("❌ Παρουσιάστηκε σφάλμα.");
  }
});

client.login(process.env.DISCORD_TOKEN);

# Mykonos Shop 2k26 — Discord Bot

Commands:

### `!dmall <message>`
Sends the announcement by DM to all non-bot members.

- Only the **Server Owner** can use it.
- 1-hour cooldown after a completed run.
- A second `!dmall` cannot start while another is running.
- Individual closed/blocked DMs do not stop the whole run.

### `!spin`
Spin the wheel.

- Winning probability is **exactly 18%** (`Math.random() < 0.18`).
- Each spin is independent.
- The bot reports whether the member won.

### `!setnumber <number>`
Starts a number-guessing round.

- Only the **Server Owner**, **Administrator**, or **Manage Server** can set the number.
- Example: `!setnumber 123`
- The number is kept secret by the bot.
- While a round is active, a plain numeric message such as `123` is treated as a guess.
- When somebody guesses correctly, the round ends automatically.
- A new round can then be started with another `!setnumber`.

**Important:** the active guessing game is stored in bot memory. If Railway restarts/redeploys the bot, the active number is cleared.

### `!scratch`
Generates a random number from **1 to 1000**.

- `777` is the jackpot.
- Any other number gives the normal non-jackpot result.
- The message uses the member's Discord avatar and the **Mykonos Shop 2k26** footer.

## Railway

1. Put the project files in the repository root.
2. Add `DISCORD_TOKEN` as a Railway Variable.
3. Railway runs `npm run start`.

## Discord Developer Portal

Enable:

- **Server Members Intent**
- **Message Content Intent**

The bot also needs the normal permissions required to read/send messages in the server and send DMs.

# Mykonos Shop 2k26 Bot v2.2.0

## Railway variables
- `DISCORD_TOKEN` — Discord bot token.
- `CLIENT_ID` — Discord Application ID, required for automatic registration of `/games dashboard`.
- Optional `DATA_DIR` — directory for persistent game-channel settings. On Railway, use a mounted Volume (for example `/data`) if you want the dashboard channel to survive redeploys/restarts.

## Commands
- `!dmall <message>` — Server Owner only.
- `/games dashboard` — Server Owner / Administrator / Manage Server. Selects the game channel.
- `!setnumber <number>` — Server Owner / Administrator / Manage Server. The command message is deleted after a valid setup; the game announcement is posted in the configured game channel.
- Plain number — guesses the active number, only in the configured game channel. No cooldown.
- `!spin` — 18% win probability, one use per user per guild every 3 hours. Result posts to the configured game channel.
- `!scratch` — random 1–1000, jackpot 777, one use per user per guild every 3 hours. Result posts to the configured game channel.

## Discord permissions / intents
Enable the **Message Content Intent** in the Discord Developer Portal. The bot also needs permission to View Channel, Send Messages, Embed Links, and Manage Messages if you want it to delete `!setnumber` messages.


## v2.3.0
`/games dashboard` now configures separate channels for Spin, Scratch, and Guess Number. `!setnumber` can be typed elsewhere and its message is deleted after a valid setup.


## v2.4.0
- Three independent dashboard channel selectors: Spin, Scratch, Guess Number.
- Clear dashboard sections showing the currently configured channel for each game.
- Railway startup marker: `BUILD: Mykonos-DM-Bot v2.4.0 — MULTI-CHANNEL DASHBOARD`.


## v2.5.0
- Added !slots with its own 3-hour cooldown and dashboard channel.
- 3 💎 = jackpot, 3 🍒 = normal win.


## v2.6.0
Advanced `/games dashboard`: choose a game, set its channel, exact winning rate and cooldown. Slots also has a separate jackpot rate. Guess Number remains skill-based and has no random winning rate.


## v2.7.1
- Added `/maintenance mode` toggle (Owner/Admin/Manage Server only).
- Maintenance state is persisted in games.json.
- Strict game channels: regular members may only send `!spin`, `!scratch`, `!slots`, or numeric guesses in the matching configured channel.
- `!spin`, `!scratch`, and `!slots` now only execute from their configured channels.
- Dashboard prevents assigning the same text channel to two games.
- Strict channels require View Channel, Send Messages, and Manage Messages permissions for the bot.


## v2.7.1 bugfix audit
- Discord interaction ephemeral replies use `MessageFlags.Ephemeral` (no deprecated `ephemeral: true`).
- `!dmall` lock/cooldown is per guild and its successful-run cooldown is persisted in `games.json`.
- New guilds receive `/games dashboard` and `/maintenance mode` without requiring a bot restart.
- Game-channel setup also verifies the bot has `Embed Links`.
- Legacy single-channel settings no longer create four-way strict-channel collisions.
- Startup log now counts configured game channels instead of guild settings.
- Removed duplicated `!dmall` condition.

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

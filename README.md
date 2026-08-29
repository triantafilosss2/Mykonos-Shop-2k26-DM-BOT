# Mykonos DM Bot FINAL

Command:
`!dmall Your message`

Only the Discord server owner can use it. Other bots are excluded.

Railway:
1. Put the project files at the repository root.
2. Add `DISCORD_TOKEN` as a Railway variable.
3. Railway should use `npm run start`.

Discord Developer Portal:
- Enable Server Members Intent.
- Enable Message Content Intent.

Important:
- The bot cannot force DMs to members who cannot receive DMs.
- Individual DM failures are logged with their Discord error code/message.
- A second run is blocked while a run is active.
- The one-hour cooldown starts only after a run completes normally.
- If the whole run crashes/stops before completion, the cooldown is reset.

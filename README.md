# Mykonos DM Bot

This bot has one command:

!dmall YOUR MESSAGE

Only the Discord server owner can use it.

## Important
1. Never share your bot token with anyone.
2. In Discord Developer Portal > Bot > Privileged Gateway Intents, enable:
   - Server Members Intent
   - Message Content Intent
3. Add the token as a Railway variable named DISCORD_TOKEN.
4. Railway should run `npm start`.

Example:
!dmall Καλησπέρα! Έχουμε νέο announcement.

# Mykonos DM Bot

## Command

`!dmall YOUR MESSAGE`

Only the Discord server owner can use the command.

## Railway

Add this variable in Railway:

`DISCORD_TOKEN=YOUR_BOT_TOKEN`

Do not commit the real token to GitHub.

## Discord Developer Portal

Enable:
- Server Members Intent
- Message Content Intent

## Notes

The bot excludes other bots. Members who have DMs disabled or otherwise cannot receive DMs may be counted as failed. The bot logs the first Discord error code in Railway logs.

# Discord Setup

## 1. Create the application & bot

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. Name it, open the **Bot** tab.
3. **Reset Token** → copy it into `.env` as `DISCORD_TOKEN`. Treat it like a password; never commit it.
4. Copy the **Application ID** from General Information into `DISCORD_CLIENT_ID`.

## 2. Privileged intents (required)

On the **Bot** tab, enable:

- ✅ **Message Content Intent** — required: the bot reads message text.
- ✅ **Server Members Intent** — used for member lookups (`get_user_info`, moderation tools).

Without these the gateway connection will fail or events will arrive empty. Past 100 servers these require verification — irrelevant for development.

## 3. Invite the bot

Generate an invite URL (OAuth2 → URL Generator):

- Scopes: `bot`, `applications.commands`
- Recommended bot permissions for the starter toolset: View Channels, Send Messages, Read Message History, Moderate Members, Manage Messages, Embed Links

Or use this template (replace the client id):

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=1099780064256
```

## 4. Development guild

Set `DISCORD_GUILD_ID` to your test server's id (enable Developer Mode in Discord → right-click server → Copy Server ID). It is reserved for guild-scoped slash-command registration (instant updates vs ~1h global) once slash commands land — the current build uses prefix commands and mentions.

## 5. Presence

Irene's Discord presence is configured after login:

```env
DISCORD_PRESENCE_STATUS=online
DISCORD_PRESENCE_ACTIVITY_TYPE=Listening
DISCORD_PRESENCE_ACTIVITY_NAME=for tool calls
```

Supported activity types are `Playing`, `Listening`, `Watching`, `Competing`, and `Custom`.

Voice join/leave commands are shipped behind an opt-in policy. Speech queue commands are present, but `!ai voice say` requires a configured TTS/playback backend before it can produce audio. STT commands are not shipped yet. The current voice code requires guild/channel opt-in, transient raw audio by default, and review before transcripts can feed training.

To enable Irene for the voice channel you are currently in:

```text
!ai voice enable
!ai voice join
!ai voice say hello from Irene
!ai voice stop-speaking
!ai voice status
!ai voice leave
```

Only administrators, server managers, or voice moderators can use the voice control commands.

## 6. Talk to the bot

The bot responds to:

| Trigger | Example |
|---|---|
| Prefix commands | `!ai ping`, `!ai tools`, `!ai help` |
| @mention | `@Irene what's the server's game night?` |
| Reply to one of its messages | (continues the conversation) |
| DM | anything |

It deliberately ignores all other messages (spam/cost control). Slash commands are a documented placeholder (`src/discord/events/interactionCreate.ts`).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Used disallowed intents` on boot | Enable the two privileged intents above |
| Bot online but silent | Mention it or use `!ai`; check it can View Channel + Send Messages there |
| Empty `message.content` | Message Content Intent not enabled |
| Moderation tools fail with permission errors | The *bot's role* also needs the permission (e.g. Moderate Members) and must sit above the target's highest role |

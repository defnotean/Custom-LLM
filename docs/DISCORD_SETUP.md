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

## 4. Development guild and slash commands

Set `DISCORD_GUILD_ID` to your test server's id (enable Developer Mode in Discord → right-click server → Copy Server ID) for fast guild-scoped slash-command registration. Leave it blank to register globally, which can take about an hour to propagate.

```bash
npm run register:discord-commands
```

The registered command is `/ai input:<text>`. It routes through the same deterministic command and agent paths as `!ai`, including text-channel allowlists, disabled-tool policy, permission gates, cooldowns, and confirmation gates.

## 5. Presence

Irene's Discord presence is configured after login:

```env
DISCORD_PRESENCE_STATUS=online
DISCORD_PRESENCE_ACTIVITY_TYPE=Listening
DISCORD_PRESENCE_ACTIVITY_NAME=for tool calls
```

Supported activity types are `Playing`, `Listening`, `Watching`, `Competing`, and `Custom`.

Voice join/leave commands are shipped behind an opt-in policy. `!ai voice say` uses a configurable HTTP TTS endpoint plus Discord Voice playback when `VOICE_TTS_ENDPOINT` is set. STT commands are not shipped yet. The current voice code requires guild/channel opt-in, transient raw audio by default, and review before transcripts can feed training.

```env
# Contract: POST JSON {text, voice, format, metadata}; return audio bytes or JSON {audioBase64}.
VOICE_TTS_ENDPOINT=http://127.0.0.1:8080/tts
VOICE_TTS_API_KEY=
VOICE_TTS_VOICE=irene
VOICE_TTS_FORMAT=ogg-opus
VOICE_TTS_STREAM_TYPE=ogg/opus
VOICE_TTS_TIMEOUT_MS=30000
VOICE_TTS_PLAYBACK_TIMEOUT_MS=120000
VOICE_SPEECH_MAX_CHARS=600
VOICE_SPEECH_MAX_QUEUE_DEPTH=3
VOICE_SPEECH_COOLDOWN_MS=3000
```

Set `VOICE_TTS_STREAM_TYPE` to match the bytes your TTS service returns. `ogg/opus` is the cleanest Discord path; `arbitrary` depends on the local FFmpeg/runtime support available to `@discordjs/voice`.

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

## 6. Server policy controls

Administrators and server managers can manage text-channel access and per-server disabled tools without direct database edits:

```text
!ai settings show
!ai settings allow-channel add current
!ai settings allow-channel remove 123456789012345678
!ai settings allow-channel clear
!ai settings disable-tool send_message
!ai settings enable-tool send_message
```

An empty text allowlist means Irene may respond in every text channel where she can see commands or mentions. If a channel allowlist blocks the current channel, admin `!ai settings ...` commands are still allowed through so the server can recover from a bad allowlist.

## 7. Talk to the bot

The bot responds to:

| Trigger | Example |
|---|---|
| Prefix commands | `!ai ping`, `!ai tools`, `!ai help` |
| Slash command | `/ai input: ping` or `/ai input: hello Irene` |
| @mention | `@Irene what's the server's game night?` |
| Reply to one of its messages | (continues the conversation) |
| DM | anything |

It deliberately ignores all other messages (spam/cost control). Slash commands use the same command/agent pipeline through `src/discord/events/interactionCreate.ts`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Used disallowed intents` on boot | Enable the two privileged intents above |
| Bot online but silent | Mention it or use `!ai`; check it can View Channel + Send Messages there |
| Empty `message.content` | Message Content Intent not enabled |
| Moderation tools fail with permission errors | The *bot's role* also needs the permission (e.g. Moderate Members) and must sit above the target's highest role |

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

The runtime also requests the non-privileged `GuildVoiceStates` gateway intent so Irene can see voice-channel state and use Discord Voice. There is no Developer Portal toggle for that one.

Without these the gateway connection will fail or events will arrive empty. Past 100 servers these require verification — irrelevant for development.

## 3. Invite the bot

Generate an invite URL (OAuth2 → URL Generator):

- Scopes: `bot`, `applications.commands`
- Recommended bot permissions for the starter toolset: View Channels, Send Messages, Read Message History, Moderate Members, Manage Messages, Embed Links, Connect, Speak, Use Voice Activity

Or use this template (replace the client id):

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=1099816764416
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

Voice join/leave commands are shipped behind an opt-in policy. `!ai voice say` uses a configurable HTTP TTS endpoint plus Discord Voice playback when `VOICE_TTS_ENDPOINT` is set. `!ai voice listen status|enable|disable` manages the opt-in listening/transcription policy and requires `VOICE_STT_ENDPOINT` before listening can be enabled. The current voice code requires guild/channel opt-in, transient raw audio by default, visible listening presence while actively transcribing, and review before transcripts can feed training. When listening is enabled before `!ai voice join`, the receive bridge subscribes to Discord speaking events, buffers transient per-speaker Opus packets, optionally sends them through a private HTTP decoder/VAD preprocessor, sends processed audio to STT, routes transcripts through the normal agent/tool/memory path, and can queue a TTS reply. `npm run check:voice-runtime` live-smokes the configured TTS, STT, and optional decoder/VAD preprocessing endpoints before a Discord voice test. `npm run eval:voice:gate` covers deterministic transcript, speaker, turn-taking, latency, social-timing, and retention checks. Speaker-attribution hardening against live audio and live Discord voice-session validation are still TODO.

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

# Contract: POST JSON {audioBase64, format, language, metadata}; return JSON {text, confidence?, language?, durationMs?}.
VOICE_STT_ENDPOINT=http://127.0.0.1:8080/stt
VOICE_STT_API_KEY=
VOICE_STT_MODEL=
VOICE_STT_LANGUAGE=auto
VOICE_STT_FORMAT=ogg-opus
VOICE_RECEIVE_FORMAT=discord-opus-packets
VOICE_RECEIVE_PREPROCESS_ENDPOINT=http://127.0.0.1:8080/voice/preprocess
VOICE_RECEIVE_PREPROCESS_API_KEY=
VOICE_RECEIVE_PREPROCESS_TIMEOUT_MS=30000
VOICE_STT_TIMEOUT_MS=30000
```

Set `VOICE_TTS_STREAM_TYPE` to match the bytes your TTS service returns. `ogg/opus` is the cleanest Discord path; `arbitrary` depends on the local FFmpeg/runtime support available to `@discordjs/voice`.
`VOICE_RECEIVE_FORMAT` describes the raw bytes captured from Discord receive before preprocessing. The built-in receive bridge forwards Discord Opus packet buffers when no preprocessor is configured.
`VOICE_RECEIVE_PREPROCESS_ENDPOINT` is optional. If set, Irene POSTs transient receive audio as JSON `{audioBase64, format, guildId, channelId, speakerUserId, startedAt, finishedAt, durationMs}`. The private service should return either `{shouldTranscribe:false, reason, metadata?}` to drop non-speech or `{shouldTranscribe:true, audioBase64?, format?, durationMs?, metadata?}` to pass decoded/muxed audio and VAD metadata into STT.

Before trying a live Discord voice session, smoke the configured voice services:

```bash
npm run check:voice-runtime -- --audio-file ./sample.ogg --receive-format ogg-opus
```

The command fails if no voice endpoint is configured. With `VOICE_TTS_ENDPOINT`, `VOICE_STT_ENDPOINT`, or `VOICE_RECEIVE_PREPROCESS_ENDPOINT` set, it verifies that the reachable endpoints return non-empty TTS audio, a usable preprocessor speech/no-speech decision, and non-empty STT text.

To enable Irene for the voice channel you are currently in:

```text
!ai voice enable
!ai voice listen enable
!ai voice join
!ai voice say hello from Irene
!ai voice listen status
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
| Voice join/speak fails | Confirm the bot role has Connect, Speak, and Use Voice Activity in that voice channel |

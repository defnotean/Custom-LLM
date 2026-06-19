# Discord Token Setup

A step-by-step walkthrough to create a Discord application, get a bot token, enable
the right intents, invite the bot, and confirm it logs in — tailored to **this**
bot (`custom-llm-discord-bot`).

> **Companion doc:** [`DISCORD_SETUP.md`](./DISCORD_SETUP.md) is the quick-reference
> version (one screen). This document is the longer, click-by-click walkthrough with
> the *why* behind each intent and permission. They don't contradict each other — if
> you just want the short list, read that one.

> **Security:** Never paste a real bot token into this file, a commit, a screenshot,
> an issue, or a chat. A leaked token = full control of your bot. Tokens live only in
> your local `.env` (which is git-ignored). Every value shown below is a placeholder.

---

## What this bot needs from Discord (the short version)

| Thing | Env var | Where you get it |
|---|---|---|
| Bot token | `DISCORD_TOKEN` | Developer Portal → your app → **Bot** → Reset Token |
| Application (Client) ID | `DISCORD_CLIENT_ID` | Developer Portal → your app → **General Information** |
| Test server ID (optional, dev) | `DISCORD_GUILD_ID` | Discord client → right-click your server → Copy Server ID |
| Message Content Intent | *(toggle, not an env var)* | Developer Portal → **Bot** → Privileged Gateway Intents |
| Server Members Intent | *(toggle, not an env var)* | Developer Portal → **Bot** → Privileged Gateway Intents |

These three env vars are read and validated in
[`src/config/env.ts`](../src/config/env.ts) (lines 19–21). They each default to an
empty string, so the app *boots* without them — but with an empty `DISCORD_TOKEN`
the bot stays in **API-only mode** and never connects to Discord
([`src/index.ts`](../src/index.ts) lines 223–227).

---

## Step 1 — Create the application

1. Go to the **Discord Developer Portal**: <https://discord.com/developers/applications>
2. Log in with the Discord account that should own the bot.
3. Click **New Application** (top-right).
4. Give it a name (this is the app name; the bot's display name can differ later) and
   accept the Developer Terms of Service. Click **Create**.
5. You land on the **General Information** page.

## Step 2 — Copy the Application (Client) ID → `DISCORD_CLIENT_ID`

1. Still on **General Information**, find **Application ID**.
2. Click **Copy**.
3. This is your `DISCORD_CLIENT_ID`. It's not a secret (it's part of your public invite
   URL), but you still need it in `.env`.

> The Application ID and the "Client ID" used in OAuth2 invite URLs are the **same
> number**.

## Step 3 — Add the Bot user

Modern Discord applications (2026) include a Bot user automatically. To confirm and
configure it:

1. In the left sidebar, open the **Bot** tab.
2. (Optional) Set the bot's **username** and **avatar** here.
3. (Recommended for development) Decide on **Public Bot**: if you only want *yourself*
   to be able to invite this bot, turn **Public Bot** *off*. Leave it on if others
   should be able to add it.

## Step 4 — Get the bot token → `DISCORD_TOKEN`

1. On the **Bot** tab, find the **Token** section.
2. Click **Reset Token** (you may be asked to confirm / enter 2FA).
3. The token is now shown **once**. Click **Copy** immediately.

> **The "reset reveals once" caveat:** Discord shows a bot token exactly once, at the
> moment you reset it. If you navigate away without copying it, you cannot view it
> again — you must **Reset Token** again (which invalidates the previous token and
> logs the bot out everywhere it was running). So: copy it straight into `.env` now.

4. Paste it into `.env` as `DISCORD_TOKEN=...` (see Step 8). Treat it like a password.

If you ever leak it: come back here and **Reset Token** to invalidate the old one.

## Step 5 — Enable the Privileged Gateway Intents (required)

Scroll down the **Bot** tab to **Privileged Gateway Intents**. This bot needs **two**
of them. Toggle these **on** and click **Save Changes**:

- ✅ **Message Content Intent** — **required.**
- ✅ **Server Members Intent** — **required.**

Leave **Presence Intent** **off** (the bot doesn't read presence/status).

### Why this bot needs them (grounded in the code)

The client is constructed in
[`src/discord/client.ts`](../src/discord/client.ts) (lines 16–22) with exactly these
Gateway Intents:

```ts
intents: [
  GatewayIntentBits.Guilds,          // basic guild/channel data
  GatewayIntentBits.GuildMessages,   // receive message events in servers
  GatewayIntentBits.GuildMembers,    // ← PRIVILEGED: Server Members Intent
  GatewayIntentBits.MessageContent,  // ← PRIVILEGED: Message Content Intent
  GatewayIntentBits.DirectMessages,  // receive DMs
],
```

- **Message Content Intent** backs `GatewayIntentBits.MessageContent`. Without it,
  `message.content` arrives **empty** for normal messages, and this bot is driven
  entirely by reading message text — it checks for the `!ai` prefix, detects
  @mentions, follows replies to its own messages, and processes DM text
  ([`src/discord/events/messageCreate.ts`](../src/discord/events/messageCreate.ts)
  lines 35–51). No message content → the bot looks online but never responds.
- **Server Members Intent** backs `GatewayIntentBits.GuildMembers`. It's used for
  member/permission lookups that gate moderation tools (e.g. resolving a member's
  permissions and roles for tools like timeout/kick). Without it, member data is
  incomplete and those lookups misbehave.

The factory also sets **partials** so DMs work:

```ts
partials: [Partials.Channel, Partials.Message],  // client.ts line 24
```

`Partials.Channel` is required to receive DMs at all; `Partials.Message` lets the bot
resolve replies to messages that aren't in its cache.

> If a privileged intent is requested in code but **not** enabled in the portal, the
> gateway rejects the connection at login with **"Used disallowed intents"** and the
> bot never comes online. See Troubleshooting.

## Step 6 — Build the OAuth2 invite URL

You can let Discord build the URL for you, or use the ready-made template below.

### Option A — URL Generator (recommended)

1. In the left sidebar, open **OAuth2** → **URL Generator**.
2. Under **Scopes**, check:
   - ✅ `bot`
   - ✅ `applications.commands` *(required for `/ai input:<text>` slash commands)*
3. A **Bot Permissions** panel appears. Check the permissions this bot actually uses
   (derived from its feature set):

   | Permission | Why this bot needs it |
   |---|---|
   | **View Channels** | See the channels where it's invited so it can read/respond. |
   | **Send Messages** | Post replies (the bot replies to every message it handles). |
   | **Read Message History** | Build short conversation context from recent messages and resolve replies (see `buildRecentTranscript` / reply handling). |
   | **Embed Links** | Render link previews / richer output. |
   | **Manage Messages** | Backs the message-management tool (e.g. deleting/cleaning messages) when a moderator asks. |
   | **Moderate Members** | Backs the timeout moderation tool. |

   > Permissions are also enforced per-user: the bot only runs a moderation tool if
   > the **requesting member** has the matching permission (e.g. `MODERATE_MEMBERS`,
   > `MANAGE_MESSAGES`) — see
   > [`src/discord/events/messageCreate.ts`](../src/discord/events/messageCreate.ts)
   > and the tool router. The invite permissions above give the *bot itself* the
   > ability to carry out those actions once authorized.

4. Discord generates a URL at the bottom. **Copy** it.

### Option B — Use this template

Replace `YOUR_CLIENT_ID` with your `DISCORD_CLIENT_ID` from Step 2:

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=1099780064256
```

The `permissions=1099780064256` bitfield encodes exactly the six permissions in the
table above (View Channels, Send Messages, Read Message History, Embed Links, Manage
Messages, Moderate Members). It matches the value used in
[`DISCORD_SETUP.md`](./DISCORD_SETUP.md). If you change the checkboxes in Option A, the
number changes too — that's expected.

## Step 7 — Invite the bot to a test server

1. Open the invite URL (from Step 6) in your browser.
2. In the **Add to Server** dropdown, pick a server **you own or can Manage** — use a
   throwaway/test server for development, not a production community.
3. Review the permissions and click **Authorize** (complete the captcha if shown).
4. The bot now appears in that server's member list — **offline** until you run the app
   with a valid token (Step 9).

## Step 8 — Set `DISCORD_GUILD_ID` for development (optional)

1. In your Discord client, enable **Developer Mode**:
   **User Settings → Advanced → Developer Mode → On**.
2. Right-click your test server's icon → **Copy Server ID**.
3. Put it in `.env` as `DISCORD_GUILD_ID=...`.

This is **optional**. It is read in [`src/config/env.ts`](../src/config/env.ts)
and used by `npm run register:discord-commands` for fast, guild-scoped slash-command
registration (guild-scoped commands update almost instantly vs about an hour for
global). The bot also responds via the `!ai` prefix, @mentions, replies, and DMs,
none of which require `DISCORD_GUILD_ID`.

## Step 9 — Put the values in `.env` and start the bot

1. If you haven't already, copy the example file:

   ```bash
   cp .env.example .env
   ```

2. Fill in the Discord section of `.env` (other sections — DB, Redis, LLM — are
   covered in their own docs):

   ```dotenv
   DISCORD_TOKEN=your-bot-token-from-step-4
   DISCORD_CLIENT_ID=your-application-id-from-step-2
   DISCORD_GUILD_ID=your-test-server-id-from-step-8   # optional
   ```

3. Start the bot (see the project README for the exact dev/start script, e.g.
   `npm run dev`).

## Step 10 — Verify it logged in

On a successful Discord connection, the bot logs a **ready** line. Watch the console
for a structured log entry (the message text comes from
[`src/discord/client.ts`](../src/discord/client.ts) lines 39–43):

```
discord client ready
```

That line includes the bot's tag in a `user` field and the number of servers it can
see in a `guilds` field, e.g.:

```json
{"level":30,"user":"YourBot#1234","guilds":1,"msg":"discord client ready"}
```

Other good signs around it:

- `api server listening` — the health/tools API is up
  ([`src/server/api.ts`](../src/server/api.ts) line 48).
- `startup complete` — boot finished ([`src/index.ts`](../src/index.ts) line 241).
- Health check reports Discord connected: `GET /` (or the health route on
  `API_PORT`, default `3000`) returns `discord.connected: true`.

**Then test it live** in your server (per
[`DISCORD_SETUP.md`](./DISCORD_SETUP.md) §5):

- `!ai ping` — prefix command
- `@YourBot hello` — mention
- reply to one of its messages — continues the conversation
- DM it anything

> If you started the app with an **empty** `DISCORD_TOKEN`, you'll instead see
> `DISCORD_TOKEN not set — running in API-only mode (no Discord connection)`
> ([`src/index.ts`](../src/index.ts) line 226). Set the token and restart.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| App logs `DISCORD_TOKEN is empty — set it in .env` and exits the Discord path | `DISCORD_TOKEN` blank | Paste the token from Step 4 into `.env`, restart. (Thrown as `ConfigError` in [`client.ts`](../src/discord/client.ts) lines 33–37.) |
| Login fails with **`Invalid token`** / `An invalid token was provided` | Token mistyped, has a stray space/quote, or was invalidated by a later **Reset Token** | Reset the token (Step 4), copy it cleanly into `.env` (no quotes, no trailing spaces), restart. |
| Login fails with **`Used disallowed intents`** | A privileged intent is requested in code but not enabled in the portal | Enable **Message Content Intent** *and* **Server Members Intent** (Step 5), Save Changes, restart. |
| Bot **appears offline** in the server | App isn't running, crashed at boot, or token is invalid | Confirm the process is running and you see `discord client ready`; check earlier logs for a crash or `Invalid token`; verify the token. |
| Bot is **online but silent / ignores everything** | Not actually addressed, or missing channel perms | It only responds to `!ai`, @mention, a reply to its own message, or a DM ([`messageCreate.ts`](../src/discord/events/messageCreate.ts) line 43). Also confirm it has **View Channels** + **Send Messages** in that channel. |
| Replies come back **empty** or it never reacts to plain mentions/text | **Message Content Intent** not enabled | `message.content` is empty without it — enable it (Step 5) and restart. |
| **DMs don't work** | Missing DM intent/partials, or DMs disabled | The code already sets `DirectMessages` + `Partials.Channel` ([`client.ts`](../src/discord/client.ts) lines 21, 24); make sure your server's privacy settings allow DMs from the bot. |
| Moderation tools fail with a **permission error** | The bot's role lacks the permission, or is too low in the role list | Give the bot's role the needed permission (e.g. **Moderate Members**) and drag its role **above** the target member's highest role. The requesting user also needs that permission. |
| Slash commands do nothing | Not implemented yet | Expected — the current build uses prefix/mention/DM. Use `!ai help`. |

---

## Quick checklist

- [ ] Application created in the Developer Portal
- [ ] **Application ID** copied → `DISCORD_CLIENT_ID`
- [ ] Bot token reset + copied → `DISCORD_TOKEN` (copied on the one reveal)
- [ ] **Message Content Intent** enabled
- [ ] **Server Members Intent** enabled
- [ ] Invite URL built with scopes `bot` + `applications.commands` and the 6 permissions
- [ ] Bot invited to a test server
- [ ] (Optional) **Server ID** copied → `DISCORD_GUILD_ID`
- [ ] `.env` filled in, app started
- [ ] Console shows `discord client ready`; `!ai ping` responds

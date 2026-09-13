# Claude Code ↔ Telegram bridge (Railway)

Runs the Claude Code CLI inside a Docker container on Railway, pointed at a
custom Anthropic-compatible gateway (`ANTHROPIC_BASE_URL`) instead of
Anthropic's own API, and lets you drive it entirely from Telegram.

Default gateway config baked in (overridable at runtime from Telegram):

- Base URL: `https://api.xkiro.com/v1`
- Model: `mistralai/mistral-large-2512`

## How it works

- `Dockerfile` installs Node.js, `git`, and `@anthropic-ai/claude-code` (npm
  package) in the image.
- `bot.js` is a small Telegram bot (long polling, no inbound webhook/port
  needed) that:
  - Writes `~/.claude/settings.json` with your `ANTHROPIC_BASE_URL`,
    `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_MODEL`.
  - Runs `claude -p "<your message>"` (Claude Code's non-interactive mode)
    inside `/workspace` and streams the result back to you in Telegram.
  - Lets you reconfigure the gateway, clone a repo to work on, and toggle
    "YOLO mode" (skip permission prompts) — all as chat commands.

## 1. Get a Telegram bot token

Message **@BotFather** on Telegram, run `/newbot`, and copy the token it
gives you.

## 2. Get your Telegram user ID

Message **@userinfobot** and copy the numeric ID it replies with. This locks
the bot down so strangers can't use your gateway credits.

## 3. Deploy to Railway

1. Push this folder to a GitHub repo (or use `railway up` from this
   directory with the Railway CLI).
2. In Railway: **New Project → Deploy from GitHub repo** (or `railway up`).
   Railway will detect `railway.toml` and build from the `Dockerfile`
   automatically.
3. In the Railway service **Variables** tab, set:
   - `TELEGRAM_BOT_TOKEN` — from step 1
   - `ALLOWED_USER_IDS` — your ID from step 2 (comma-separate for more than
     one person)
   - `ANTHROPIC_BASE_URL` — `https://api.xkiro.com/v1` (or leave unset, it's
     already the default)
   - `ANTHROPIC_MODEL` — `mistralai/mistral-large-2512` (or leave unset)
   - `ANTHROPIC_AUTH_TOKEN` — your xkiro.com API key
4. Deploy. Since this bot uses long polling (not a webhook), it doesn't need
   a public domain or exposed port on Railway — it just needs to be running.

## 4. Use it

Open a chat with your bot on Telegram:

- `/status` — see current base URL / model / masked token
- `/setbaseurl https://api.xkiro.com/v1`
- `/setmodel mistralai/mistral-large-2512`
- `/settoken <your-xkiro-api-key>` (the bot deletes this message right after
  reading it so the key doesn't sit in your chat history)
- `/clone https://github.com/you/your-repo.git` — pull a repo into the
  workspace for Claude Code to work on
- `/yolo on` — let Claude Code edit files / run commands without asking
  (only turn this on for trusted, disposable workspaces)
- Anything else you type is sent straight to Claude Code as a prompt.

## Notes and caveats

- **Persistence:** without a Railway volume attached, `/workspace` and the
  saved config reset on every redeploy — you'll need to `/settoken` again
  after a redeploy unless `ANTHROPIC_AUTH_TOKEN` is also set as a Railway
  variable (which is used as the fallback default).
- **Whether xkiro.com actually works with Claude Code** depends on it
  exposing an Anthropic-compatible `/v1/messages`-style API (this is how
  every "use Claude Code with another model" proxy works — Claude Code just
  needs the endpoint to speak the same wire format Anthropic's API does).
  Confirm that with xkiro.com's own docs before relying on this in
  production.
- **Security:** always set `ALLOWED_USER_IDS`. Without it, anyone who finds
  your bot's username on Telegram can burn your gateway credits and, with
  `/yolo on`, execute arbitrary commands inside your container.
- **Non-interactive mode:** `claude -p` is Claude Code's headless mode built
  for exactly this kind of scripted/bot usage — no TTY required.

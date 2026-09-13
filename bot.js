'use strict';

/**
 * Telegram <-> Claude Code bridge.
 *
 * Lets you, over Telegram, point Claude Code at a custom Anthropic-compatible
 * gateway (base URL + model + token) and then send it prompts to run inside
 * a working directory, all from inside a single Railway container.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const TelegramBot = require('node-telegram-bot-api');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const WORKSPACE_DIR = process.env.WORKSPACE_DIR || '/workspace';
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(WORKSPACE_DIR, '.bot-config.json');
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 5 * 60 * 1000); // 5 min
const MAX_TELEGRAM_CHARS = 3800; // stay safely under Telegram's 4096 limit

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN env var. Set it in Railway variables.');
  process.exit(1);
}

if (ALLOWED_USER_IDS.length === 0) {
  console.warn(
    'WARNING: ALLOWED_USER_IDS is empty. Anyone who finds this bot on Telegram ' +
      'will be able to run Claude Code through it. Set ALLOWED_USER_IDS in Railway variables.'
  );
}

fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });

// ---------------------------------------------------------------------------
// Persisted runtime config (survives restarts as long as the volume/disk does;
// on a fresh Railway deploy without a volume it resets to the env var
// defaults below, which is why ANTHROPIC_BASE_URL / ANTHROPIC_MODEL /
// ANTHROPIC_AUTH_TOKEN are also read from the environment as a fallback).
// ---------------------------------------------------------------------------

function loadConfig() {
  const defaults = {
    baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.xkiro.com/v1',
    model: process.env.ANTHROPIC_MODEL || 'mistralai/mistral-large-2512',
    authToken: process.env.ANTHROPIC_AUTH_TOKEN || '',
    yolo: process.env.CLAUDE_YOLO === 'true',
  };
  try {
    const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...defaults, ...onDisk };
  } catch {
    return defaults;
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();

function writeClaudeSettings() {
  const settings = {
    env: {
      ANTHROPIC_BASE_URL: config.baseUrl,
      ANTHROPIC_AUTH_TOKEN: config.authToken,
      ANTHROPIC_MODEL: config.model,
      // Prevent Claude Code from ever trying to authenticate directly
      // against Anthropic's production API instead of the gateway.
      ANTHROPIC_API_KEY: '',
    },
  };
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

writeClaudeSettings();

// ---------------------------------------------------------------------------
// Telegram bot
// ---------------------------------------------------------------------------

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

function isAllowed(msg) {
  if (ALLOWED_USER_IDS.length === 0) return true; // open mode, not recommended
  return ALLOWED_USER_IDS.includes(String(msg.from.id));
}

function maskToken(token) {
  if (!token) return '(not set)';
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

async function sendLong(chatId, text) {
  if (!text) text = '(no output)';
  for (let i = 0; i < text.length; i += MAX_TELEGRAM_CHARS) {
    await bot.sendMessage(chatId, text.slice(i, i + MAX_TELEGRAM_CHARS));
  }
}

function runClaude(prompt) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'text'];
    if (config.yolo) args.push('--dangerously-skip-permissions');

    const child = spawn('claude', args, {
      cwd: WORKSPACE_DIR,
      // stdin MUST be ignored, not piped: claude -p waits a few seconds for
      // piped stdin input before proceeding, which looked like a hang/error
      // when Node's default pipe was left open with nothing ever written to it.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: config.baseUrl,
        ANTHROPIC_AUTH_TOKEN: config.authToken,
        ANTHROPIC_MODEL: config.model,
        ANTHROPIC_API_KEY: '',
      },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve(`⚠️ Claude Code timed out after ${CLAUDE_TIMEOUT_MS / 1000}s.`);
    }, CLAUDE_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(`⚠️ Failed to start claude: ${err.message}`);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve(`⚠️ Claude Code exited with code ${code}:\n${stderr || stdout || '(no output)'}`);
      } else {
        resolve(stdout || stderr || '(empty response)');
      }
    });
  });
}

function runGit(args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: WORKSPACE_DIR, timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) resolve(`⚠️ git error: ${error.message}\n${stderr || ''}`);
      else resolve(stdout || stderr || 'OK');
    });
  });
}

bot.onText(/^\/start$/, (msg) => {
  if (!isAllowed(msg)) return;
  bot.sendMessage(
    msg.chat.id,
    [
      'Claude Code bridge is up.',
      '',
      'Commands:',
      '/status - show current gateway config',
      '/setbaseurl <url> - set ANTHROPIC_BASE_URL',
      '/setmodel <model> - set ANTHROPIC_MODEL',
      '/settoken <token> - set ANTHROPIC_AUTH_TOKEN',
      '/yolo on|off - allow Claude Code to edit/run files without asking',
      '/clone <git-url> - clone a repo into the workspace',
      '/reset - wipe the workspace directory',
      '',
      'Anything else you type is sent straight to Claude Code as a prompt.',
    ].join('\n')
  );
});

bot.onText(/^\/status$/, (msg) => {
  if (!isAllowed(msg)) return;
  bot.sendMessage(
    msg.chat.id,
    [
      `Base URL: ${config.baseUrl}`,
      `Model: ${config.model}`,
      `Auth token: ${maskToken(config.authToken)}`,
      `YOLO mode (skip permission prompts): ${config.yolo ? 'ON' : 'off'}`,
      `Workspace: ${WORKSPACE_DIR}`,
    ].join('\n')
  );
});

bot.onText(/^\/setbaseurl (.+)$/, (msg, match) => {
  if (!isAllowed(msg)) return;
  config.baseUrl = match[1].trim();
  saveConfig(config);
  writeClaudeSettings();
  bot.sendMessage(msg.chat.id, `Base URL set to: ${config.baseUrl}`);
});

bot.onText(/^\/setmodel (.+)$/, (msg, match) => {
  if (!isAllowed(msg)) return;
  config.model = match[1].trim();
  saveConfig(config);
  writeClaudeSettings();
  bot.sendMessage(msg.chat.id, `Model set to: ${config.model}`);
});

bot.onText(/^\/settoken (.+)$/, async (msg, match) => {
  if (!isAllowed(msg)) return;
  config.authToken = match[1].trim();
  saveConfig(config);
  writeClaudeSettings();
  // Delete the message so the token doesn't linger in chat history.
  try {
    await bot.deleteMessage(msg.chat.id, msg.message_id);
  } catch {
    /* ignore if bot lacks delete rights */
  }
  bot.sendMessage(msg.chat.id, `Auth token updated: ${maskToken(config.authToken)}`);
});

bot.onText(/^\/yolo (on|off)$/, (msg, match) => {
  if (!isAllowed(msg)) return;
  config.yolo = match[1] === 'on';
  saveConfig(config);
  bot.sendMessage(
    msg.chat.id,
    config.yolo
      ? '⚠️ YOLO mode ON: Claude Code will edit/run files without asking permission.'
      : 'YOLO mode off: Claude Code will ask before risky actions (and those requests will just fail non-interactively).'
  );
});

bot.onText(/^\/clone (.+)$/, async (msg, match) => {
  if (!isAllowed(msg)) return;
  bot.sendMessage(msg.chat.id, `Cloning ${match[1]} ...`);
  const result = await runGit(['clone', match[1].trim(), '.']);
  await sendLong(msg.chat.id, result);
});

bot.onText(/^\/reset$/, (msg) => {
  if (!isAllowed(msg)) return;
  fs.rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  bot.sendMessage(msg.chat.id, 'Workspace wiped.');
});

// Catch-all: anything that isn't a recognized command is a prompt for Claude.
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  if (!isAllowed(msg)) {
    bot.sendMessage(msg.chat.id, 'You are not authorized to use this bot.');
    return;
  }
  if (!config.authToken) {
    bot.sendMessage(msg.chat.id, 'No auth token set yet. Use /settoken <token> first.');
    return;
  }

  await bot.sendChatAction(msg.chat.id, 'typing');
  const reply = await runClaude(msg.text);
  await sendLong(msg.chat.id, reply);
});

bot.on('polling_error', (err) => console.error('Polling error:', err.message));

console.log('Claude Code Telegram bridge running.');
console.log(`Workspace: ${WORKSPACE_DIR}`);
console.log(`Base URL: ${config.baseUrl}`);
console.log(`Model: ${config.model}`);

FROM node:20-slim

# git is needed if you want the bot to clone repos before asking Claude Code
# to work on them; ca-certificates/curl are needed for npm/https calls.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Install the Claude Code CLI globally so the bot can shell out to `claude`
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Install bot dependencies first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev

# Copy the bot source
COPY bot.js ./

# Directory Claude Code will treat as its working directory / project folder
RUN mkdir -p /workspace
ENV WORKSPACE_DIR=/workspace

# Railway sets PORT automatically but this bot uses long-polling, not a web
# server, so no EXPOSE is required. It's included only so Railway's health
# checks (if you ever add an HTTP endpoint) have a sane default.
ENV PORT=3000

CMD ["node", "bot.js"]

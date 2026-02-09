# OpenClaw Railway Template

Minimal OpenClaw deployment template using the official installation method.

## Quick Deploy to Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/openclaw)

## Environment Variables

- `ANTHROPIC_API_KEY` - Your Anthropic API key
- `TELEGRAM_BOT_TOKEN` - Telegram bot token from @BotFather
- `BOT_NAME` - Name for your bot (optional)

## Manual Setup

1. Install Railway CLI: `npm install -g @railway/cli`
2. Login: `railway login`
3. Deploy: `railway up`

## How It Works

This template:
1. Installs OpenClaw CLI using the official installer
2. Automatically configures Telegram and Anthropic API
3. Starts the gateway service
4. Exposes health check endpoint on port 8080

Build time: ~60-90 seconds (vs 5+ minutes for source builds)

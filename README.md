# OpenClaw Railway Template

Minimal OpenClaw deployment template using the official installation method.

## Environment Variables

Required:
- `ANTHROPIC_API_KEY` - Your Anthropic API key
- `TELEGRAM_BOT_TOKEN` - Telegram bot token from @BotFather

Optional:
- `BOT_NAME` - Name for your bot (metadata only)
- `USER_ID` - User ID (metadata only)

## How It Works

This template:

1. **Installs OpenClaw** via npm (`npm install -g openclaw@latest`) - ~15s
2. **Runs non-interactive onboarding** (Docker mode - no systemd):
   ```bash
   openclaw onboard --non-interactive \
     --accept-risk \
     --mode local \
     --auth-choice apiKey \
     --anthropic-api-key "$ANTHROPIC_API_KEY" \
     --gateway-port 18789 \
     --workspace /data/workspace
   ```
3. **Configures Telegram** via `TELEGRAM_BOT_TOKEN` environment variable
4. **Starts gateway** in foreground mode:
   ```bash
   openclaw gateway --port 18789
   ```
5. **Health check** endpoint on port 8080 (`/health`)

## Build Time

- **30-45 seconds** total (vs 5+ minutes for source builds)
- Uses official npm package: `openclaw@latest`
- Clean installation, no TTY/wizard issues
- Required dependencies: Node 22, Git, curl, ca-certificates

## Bot Access

This template configures **open DM policy** for managed deployments:
- ✅ **No pairing required** - Anyone can message your bot immediately
- ✅ **Fully automated** - Bot is ready to use after deployment
- ⚠️ **Security note** - Since you control the bot token, this is appropriate for personal/managed use

The bot will respond immediately to `/start` without requiring pairing approval.

## Ports

- `18789` - OpenClaw gateway (internal)
- `8080` - Health check endpoint (public)

## Troubleshooting

### Bot not responding
- Check that `TELEGRAM_BOT_TOKEN` is set correctly
- Verify token is from @BotFather
- Check Railway logs for errors
- Wait 60-90 seconds for full startup

### Health check fails
- Wait 60-90 seconds after deployment for full initialization
- Check that port 8080 is accessible
- Review deployment logs for startup errors
- Verify OpenClaw gateway started successfully

### Bot asks for pairing code
- This should not happen with this template (open DM policy)
- If it does, check logs to ensure DM policy was set correctly
- Config file location: `/data/.openclaw/openclaw.json`

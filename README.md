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

1. **Installs OpenClaw** via npm (`npm install -g openclaw@2026.2.9`) - ~15s
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
3. **Enables Telegram channel**:
   - Runs `openclaw doctor --fix` to detect channels
   - Manually sets `channels.telegram.enabled = true` in config
4. **Starts auto-approval monitor** for first user
5. **Starts gateway** in foreground mode:
   ```bash
   openclaw gateway --port 18789
   ```
5. **Health check** endpoint on port 8080 (`/health`)

## Build Time

- **30-45 seconds** total (vs 5+ minutes for source builds)
- Uses official npm package: `openclaw@2026.2.9`
- Clean installation, no TTY/wizard issues
- Required dependencies: Node 22, Git, curl, ca-certificates

## Bot Access - Open Mode

This template uses **open access mode** for simplicity:

### How It Works
- ✅ **Bot accepts messages from anyone** - No pairing required
- ✅ **Instant access** - Send `/start` and start chatting immediately
- ✅ **Perfect for personal/testing use** - No manual approval needed

### What Happens
```
1. Deploy bot → Wait 2-3 minutes for build & startup
2. Go to Telegram and send /start to your bot
3. Bot responds immediately
4. Start chatting with your AI assistant!
```

### Security Options

**For production/restricted access**, you can switch to allowlist mode:

1. Get your Telegram user ID (send a message to @userinfobot)
2. In Railway, add environment variable:
   ```
   TELEGRAM_ALLOWLIST=123456789,987654321
   ```
3. Update the start.sh script to use `dmPolicy: 'allowlist'`

**Or use pairing mode** for manual approval:
- Set `dmPolicy: 'pairing'` in config
- Users will receive pairing codes
- Approve via: `openclaw pairing approve telegram <CODE>`

### Troubleshooting

**Bot doesn't respond to /start:**
- Wait 2-3 minutes after deployment for full startup
- Check that bot token is correct (from @BotFather)
- Verify agent status is "Active" in dashboard
- Check Railway logs for Telegram provider startup
- Look for: `[telegram] [default] starting provider`

**Bot says "Access not configured":**
- This means the gateway is using pairing/allowlist mode
- Check that `dmPolicy: 'open'` is set in config
- Run `openclaw doctor --fix` to apply config changes

## Ports

- `8081` - Pairing Management API with health check endpoint (public)
- `18789` - OpenClaw gateway (internal, localhost only)

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

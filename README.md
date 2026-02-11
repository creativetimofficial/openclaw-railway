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

1. **Installs OpenClaw** via npm (`npm install -g openclaw@2026.2.6`) - ~15s
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
   - Sets `channels.telegram.enabled = true` with open DM policy
   - Runs `openclaw doctor --fix` to apply configuration
4. **Enables HTTP API endpoints**:
   - Enables `/v1/chat/completions` for web chat interface
   - Configures gateway authentication token
5. **Starts gateway** in foreground mode on port 18789
6. **Starts API server** on port 8081:
   - `/health` - Health check endpoint
   - `/chat` - Chat proxy to gateway
   - `/stats/*` - Usage statistics endpoints

## Build Time

- **30-45 seconds** total (vs 5+ minutes for source builds)
- Uses official npm package: `openclaw@2026.2.9`
- Clean installation, no TTY/wizard issues
- Required dependencies: Node 22, Git, curl, ca-certificates

## Bot Access

### Web Chat Interface (Recommended)
The easiest way to interact with your agent is through the **dashboard chat interface**:

1. Deploy bot → Wait 2-3 minutes for build & startup
2. Go to your dashboard at your-site.com/dashboard/openclaw
3. Click "Chat" button on your agent card
4. Start chatting directly with your AI assistant!

**Features:**
- ✅ **Direct HTTP API access** - No Telegram pairing needed
- ✅ **Session continuity** - Conversation history maintained
- ✅ **Instant access** - Chat immediately after deployment
- ✅ **Web-based** - Works on any device with a browser

### Telegram Access (Optional)
You can also access your agent via Telegram with **open access mode**:

- ✅ **Bot accepts messages from anyone** - No pairing required
- ✅ **Instant access** - Send `/start` and start chatting immediately
- ✅ **Perfect for mobile use** - Chat from anywhere

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
- Check that `dmPolicy: 'open'` is set in config
- Check Railway logs for Telegram channel status
- Verify: `openclaw doctor --fix` ran successfully during startup

## Ports

- `8081` - Stats API with health check endpoint (public)
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

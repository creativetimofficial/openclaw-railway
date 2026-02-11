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

## Bot Access - Auto-Approve First User

This template uses a **secure auto-approval system**:

### How It Works
1. ✅ **Bot deploys in secure pairing mode** - Unknown users must pair before chatting
2. ✅ **Auto-approval activated from dashboard** - When deployment completes, auto-approval starts
3. ✅ **First user is auto-approved** - When you send `/start`, you're instantly approved
4. ✅ **Additional users require manual approval** - Others must be approved via dashboard

### Security Benefits
- 🔒 **Prevents API cost leaks** - Only approved users can use your bot
- 🔒 **Zero friction UX** - Owner gets instant access
- 🔒 **Granular control** - Manually approve family/team members via dashboard

### What Happens
```
1. Deploy bot → Wait 2-3 minutes for build & startup
2. Dashboard detects "Active" status → Auto-approval starts automatically
3. Go to Telegram and send /start to your bot
4. Bot responds with "You've been paired!"
5. Start chatting with your AI assistant!
6. Dashboard shows notification: "First user auto-approved!"
```

### Troubleshooting

**Bot doesn't respond to /start:**
- Wait 2-3 minutes after deployment for full startup
- Check that bot token is correct (from @BotFather)
- Verify agent status is "Active" in dashboard
- Check Railway logs for errors

**Bot says "Pairing required":**
- Auto-approval may not have started - check dashboard
- First user may have already been approved (you're the second user)
- Check Railway logs for auto-approval status

### For Additional Users
Other users who message your bot will receive a pairing code. You can approve them via:
1. Dashboard UI → Agent Details → Pairing tab
2. Railway shell: `openclaw pairing approve telegram <CODE>`

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

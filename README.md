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
- Uses official npm package: `openclaw@latest`
- Clean installation, no TTY/wizard issues
- Required dependencies: Node 22, Git, curl, ca-certificates

## Bot Access - Auto-Approve First User

This template uses a **secure auto-approval system**:

### How It Works
1. ✅ **Bot deploys in secure pairing mode** - Unknown users get pairing codes
2. ✅ **First user is auto-approved** - When you send `/start`, you're instantly approved
3. ✅ **Additional users require manual approval** - Others must be approved via dashboard
4. ✅ **No extra setup needed** - Just send `/start` to your bot after deployment

### Security Benefits
- 🔒 **Prevents API cost leaks** - Only approved users can use your bot
- 🔒 **Zero friction UX** - Owner gets instant access
- 🔒 **Granular control** - Manually approve family/team members via dashboard

### What Happens
```
1. Deploy bot → Wait 60-90 seconds for startup
2. Send /start to your Telegram bot
3. Auto-approved! Start chatting immediately
4. Dashboard shows notification: "First user auto-approved!"
```

### For Additional Users
Other users who message your bot will receive a pairing code. You can approve them via:
1. Dashboard UI (coming soon)
2. Railway shell: `openclaw pairing approve telegram <CODE>`

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

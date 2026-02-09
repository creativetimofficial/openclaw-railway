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
2. **Runs non-interactive onboarding** with:
   ```bash
   openclaw onboard --non-interactive \
     --mode local \
     --auth-choice apiKey \
     --anthropic-api-key "$ANTHROPIC_API_KEY" \
     --gateway-port 18789 \
     --gateway-bind 0.0.0.0 \
     --install-daemon \
     --daemon-runtime node \
     --workspace /data/workspace
   ```
3. **Configures Telegram** via `TELEGRAM_BOT_TOKEN` environment variable
4. **Starts gateway** on port 18789
5. **Health check** endpoint on port 8080 (`/health`)

## Build Time

- **30-45 seconds** total (vs 5+ minutes for source builds)
- Uses official npm package: `openclaw@latest`
- Clean installation, no TTY/wizard issues
- Minimal dependencies

## Pairing Your Bot

After deployment:

1. Send `/start` to your Telegram bot
2. Bot will respond with a pairing code
3. Approve the pairing:
   ```bash
   openclaw pairing approve telegram <CODE>
   ```

For Railway deployments, you can run this via Railway's shell or create a separate pairing endpoint.

## Ports

- `18789` - OpenClaw gateway (internal)
- `8080` - Health check endpoint (public)

## Troubleshooting

### Bot not responding
- Check that `TELEGRAM_BOT_TOKEN` is set correctly
- Verify token is from @BotFather
- Check Railway logs for errors

### Health check fails
- Wait 30-60 seconds after deployment
- Check that port 8080 is accessible
- Review deployment logs for startup errors

### Pairing issues
- Bot requires pairing before first use
- Use `openclaw pairing approve telegram <CODE>` command
- Check that DM policy is set to "pairing" in config

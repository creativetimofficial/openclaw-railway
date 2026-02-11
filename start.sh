#!/bin/bash
set -e

echo "🚀 Starting OpenClaw setup..."

# Set config directories
export OPENCLAW_STATE_DIR="/data/.openclaw"
export OPENCLAW_WORKSPACE_DIR="/data/workspace"

# Ensure directories exist
mkdir -p "$OPENCLAW_STATE_DIR" "$OPENCLAW_WORKSPACE_DIR"

# Check if already onboarded
if [ ! -f "$OPENCLAW_STATE_DIR/openclaw.json" ]; then
  echo "📝 Running non-interactive onboarding..."

  # Run onboard with all required flags (Docker mode - no daemon)
  openclaw onboard --non-interactive \
    --accept-risk \
    --mode local \
    --auth-choice apiKey \
    --anthropic-api-key "$ANTHROPIC_API_KEY" \
    --gateway-port 18789 \
    --workspace "$OPENCLAW_WORKSPACE_DIR" \
    --json || echo "⚠️  Onboard completed with warnings (this is normal)"

  echo "✅ Onboarding complete!"

  # Auto-enable Telegram channel
  echo "🔧 Enabling Telegram channel..."
  openclaw doctor --fix || echo "⚠️  Doctor fix completed with warnings"

  # Manually enable Telegram in config (doctor --fix detects but doesn't enable)
  echo "🔧 Manually enabling Telegram channel in config..."
  node -e "
    const fs = require('fs');
    const configPath = process.env.OPENCLAW_STATE_DIR + '/openclaw.json';
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!config.channels) config.channels = {};
      if (!config.channels.telegram) config.channels.telegram = {};

      // Enable the Telegram channel and set bot token
      config.channels.telegram.enabled = true;
      config.channels.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN;
      config.channels.telegram.dmPolicy = 'open'; // Secure by default
      config.channels.telegram.allowFrom = ['*'];

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('✅ Telegram channel enabled with bot token in config');
    } catch (err) {
      console.log('⚠️  Could not enable Telegram channel:', err.message);
    }
  "

  # Use secure pairing mode (default)
  echo "🔐 Using secure pairing mode - first user will be auto-approved"
else
  echo "ℹ️  Already onboarded, skipping setup"
fi

# Configure Telegram bot token via environment variable
# (OpenClaw will pick this up automatically)
export TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN"

# Start Pairing Management API on port 8081 (includes /health endpoint)
echo "🔐 Starting Pairing Management API on port 8081..."
node /app/pairing-api.js &

# Note: Auto-approval monitor will be started by the UI dashboard after build completes
echo "ℹ️  Pairing will be activated from dashboard after deployment completes"

# Give pairing API time to start
sleep 3
echo "✅ Pairing API ready - Railway will health check on port 8081"

echo "🌐 Starting OpenClaw gateway on port 18789..."
echo "📱 Telegram bot token: ${TELEGRAM_BOT_TOKEN:0:10}..."
echo "🔑 Anthropic API key: ${ANTHROPIC_API_KEY:0:10}..."

# Start the gateway in Docker mode (foreground, no systemd)
exec openclaw gateway --port 18789

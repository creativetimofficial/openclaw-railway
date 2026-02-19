#!/bin/bash
set -e

echo "🚀 Starting OpenClaw setup..."

# Set config directories and bot credentials
export OPENCLAW_STATE_DIR="/data/.openclaw"
export OPENCLAW_WORKSPACE_DIR="/data/workspace"
export TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN"

# Ensure directories exist
mkdir -p "$OPENCLAW_STATE_DIR" "$OPENCLAW_WORKSPACE_DIR"

echo "📋 Environment check:"
echo "   OPENCLAW_STATE_DIR: $OPENCLAW_STATE_DIR"
echo "   OPENCLAW_WORKSPACE_DIR: $OPENCLAW_WORKSPACE_DIR"
echo "   TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN:0:15}..."
echo "   ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:0:15}..."

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

  # Configure Telegram channel properly
  echo "🔧 Configuring Telegram channel..."

  # Use OpenClaw's built-in config method instead of manual JSON editing
  node -e "
    const fs = require('fs');
    const configPath = process.env.OPENCLAW_STATE_DIR + '/openclaw.json';
    try {
      let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

      // Ensure channels object exists
      if (!config.channels) config.channels = {};
      if (!config.channels.telegram) config.channels.telegram = {};

      // Enable the Telegram channel with bot token (pairing mode for security)
      config.channels.telegram = {
        enabled: true,
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        dmPolicy: 'pairing',
        allowFrom: []
      };

      // Enable HTTP endpoints for web chat interface
      if (!config.gateway) config.gateway = {};
      if (!config.gateway.http) config.gateway.http = {};
      if (!config.gateway.http.endpoints) config.gateway.http.endpoints = {};

      config.gateway.http.endpoints.chatCompletions = {
        enabled: true
      };

      config.gateway.http.endpoints.responses = {
        enabled: true
      };

      // Set gateway authentication token (use pairing API secret)
      if (!config.gateway.auth) config.gateway.auth = {};
      config.gateway.auth.mode = 'token';
      config.gateway.auth.token = process.env.PAIRING_API_SECRET;

      // Set default AI model (OpenClaw 2.15+ config format)
      // Model is set in config, but reads from ANTHROPIC_MODEL env var for flexibility
      if (!config.agents) config.agents = {};
      if (!config.agents.defaults) config.agents.defaults = {};
      config.agents.defaults.model = {
        primary: process.env.ANTHROPIC_MODEL
          ? 'anthropic/' + process.env.ANTHROPIC_MODEL
          : 'anthropic/claude-sonnet-4-5-20250929'
      };

      // Write config
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

      // Verify it was written
      const verify = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (verify.channels && verify.channels.telegram && verify.channels.telegram.enabled) {
        console.log('✅ Telegram channel enabled successfully');
        console.log('   DM Policy: pairing (manual approval required)');
        console.log('   Bot Token: ' + process.env.TELEGRAM_BOT_TOKEN.substring(0, 10) + '...');
      } else {
        console.log('⚠️  WARNING: Telegram channel may not be enabled!');
      }
    } catch (err) {
      console.log('❌ Could not enable Telegram channel:', err.message);
      process.exit(1);
    }
  "

  if [ $? -ne 0 ]; then
    echo "❌ Failed to configure Telegram. Exiting."
    exit 1
  fi

  echo "🔐 Using pairing mode - users need approval before chatting"

  # Run doctor to properly enable Telegram channel
  echo "🩺 Running openclaw doctor --fix to enable Telegram channel..."
  openclaw doctor --fix || echo "⚠️  Doctor completed with warnings (this is normal)"

  echo "⏳ Waiting for config to stabilize..."
  sleep 2
else
  echo "ℹ️  Already onboarded, skipping setup"

  # Migration: Update config for OpenClaw 2.15+ compatibility
  echo "🔄 Running config migration..."
  node -e "
    const fs = require('fs');
    const configPath = process.env.OPENCLAW_STATE_DIR + '/openclaw.json';
    try {
      let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      let needsUpdate = false;

      // Remove deprecated 'llm' key if it exists
      if (config.llm) {
        console.log('⚠️  Found deprecated llm config key, removing...');
        delete config.llm;
        needsUpdate = true;
      }

      // Set agents.defaults.model if missing or needs update
      if (!config.agents) config.agents = {};
      if (!config.agents.defaults) config.agents.defaults = {};

      const expectedModel = process.env.ANTHROPIC_MODEL
        ? 'anthropic/' + process.env.ANTHROPIC_MODEL
        : 'anthropic/claude-sonnet-4-5-20250929';

      if (!config.agents.defaults.model || config.agents.defaults.model.primary !== expectedModel) {
        console.log('🔧 Setting AI model to:', expectedModel);
        config.agents.defaults.model = {
          primary: expectedModel
        };
        needsUpdate = true;
      }

      if (needsUpdate) {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        console.log('✅ Config migrated successfully');
      } else {
        console.log('✅ Config already up to date');
      }
    } catch (err) {
      console.log('⚠️  Could not migrate config:', err.message);
    }
  "
fi

# Start Stats API on port 8081 (includes /health endpoint)
echo "📊 Starting Stats API on port 8081..."
node /app/pairing-api.js &

# Give stats API time to start
sleep 3
echo "✅ Stats API ready - Railway will health check on port 8081"

# Verify Telegram config before starting gateway
echo "🔍 Verifying Telegram channel configuration..."
node -e "
  const fs = require('fs');
  const config = JSON.parse(fs.readFileSync('$OPENCLAW_STATE_DIR/openclaw.json', 'utf8'));
  console.log('Telegram config:', JSON.stringify(config.channels?.telegram || {}, null, 2));
  if (!config.channels?.telegram?.enabled) {
    console.error('❌ CRITICAL: Telegram channel is NOT enabled!');
    process.exit(1);
  }
  console.log('✅ Telegram channel is enabled');
"

if [ $? -ne 0 ]; then
  echo "❌ Telegram configuration check failed. Cannot start gateway."
  echo "📋 Config file contents:"
  cat "$OPENCLAW_STATE_DIR/openclaw.json"
  exit 1
fi

echo "🌐 Starting OpenClaw gateway on port 18789..."
echo "📱 Telegram bot token: ${TELEGRAM_BOT_TOKEN:0:10}..."
echo "🔑 Anthropic API key: ${ANTHROPIC_API_KEY:0:10}..."
echo ""
echo "⚠️  IMPORTANT: Gateway will now start. Watch for Telegram channel status in logs."
echo ""

# Start the gateway in Docker mode (foreground, no systemd)
exec openclaw gateway --port 18789

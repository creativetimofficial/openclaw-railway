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

  # Configure open DM policy for managed service (no pairing required)
  echo "🔓 Configuring open DM policy for Telegram..."
  node -e "
    const fs = require('fs');
    const configPath = process.env.OPENCLAW_STATE_DIR + '/openclaw.json';
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!config.channels) config.channels = {};
      if (!config.channels.telegram) config.channels.telegram = {};
      config.channels.telegram.dmPolicy = 'open';
      config.channels.telegram.allowFrom = ['*'];
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('✅ DM policy set to open - no pairing required');
    } catch (err) {
      console.log('⚠️  Could not set DM policy:', err.message);
    }
  "
else
  echo "ℹ️  Already onboarded, skipping setup"
fi

# Configure Telegram bot token via environment variable
# (OpenClaw will pick this up automatically)
export TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN"

echo "🤖 Telegram bot configured with open DM policy (no pairing required)"

# Health check endpoint (runs in background)
echo "🏥 Starting health check server on port 8080..."
node -e "
const http = require('http');
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', service: 'openclaw' }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(8080, '0.0.0.0', () => {
  console.log('✅ Health check server ready on :8080');
});
" &

# Give health check server time to start
sleep 2

echo "🌐 Starting OpenClaw gateway on port 18789..."
echo "📱 Telegram bot token: ${TELEGRAM_BOT_TOKEN:0:10}..."
echo "🔑 Anthropic API key: ${ANTHROPIC_API_KEY:0:10}..."

# Start the gateway in Docker mode (foreground, no systemd)
exec openclaw gateway --port 18789

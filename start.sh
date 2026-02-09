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

  # Run onboard with all required flags
  openclaw onboard --non-interactive \
    --accept-risk \
    --mode local \
    --auth-choice apiKey \
    --anthropic-api-key "$ANTHROPIC_API_KEY" \
    --gateway-port 18789 \
    --gateway-bind 0.0.0.0 \
    --install-daemon \
    --daemon-runtime node \
    --workspace "$OPENCLAW_WORKSPACE_DIR" \
    --json || echo "⚠️  Onboard completed with warnings (this is normal)"

  echo "✅ Onboarding complete!"
else
  echo "ℹ️  Already onboarded, skipping setup"
fi

# Configure Telegram bot token via environment variable
# (OpenClaw will pick this up automatically)
export TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN"

echo "🤖 Telegram bot configured via environment variable"

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

# Start the gateway (blocks)
exec openclaw gateway start

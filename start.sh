#!/bin/bash
set -e

echo "🚀 Starting OpenClaw setup..."

# Set config directory
export OPENCLAW_STATE_DIR="/data/.openclaw"
export OPENCLAW_WORKSPACE_DIR="/data/workspace"
export OPENCLAW_HOME="/root/.openclaw"

# Ensure directories exist
mkdir -p "$OPENCLAW_STATE_DIR" "$OPENCLAW_WORKSPACE_DIR"

# Configure Telegram and API settings
echo "📝 Writing configuration..."

cat > "$OPENCLAW_STATE_DIR/openclaw.json" <<EOF
{
  "agents": {
    "defaults": {
      "model": "claude-sonnet-4-5",
      "workspace": "$OPENCLAW_WORKSPACE_DIR"
    }
  },
  "gateway": {
    "port": 18789,
    "bind": "0.0.0.0",
    "auth": {
      "provider": "apiKey",
      "apiKey": "$ANTHROPIC_API_KEY"
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "$TELEGRAM_BOT_TOKEN",
      "dmPolicy": "pairing"
    }
  },
  "wizard": {
    "lastRunAt": "$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")",
    "lastRunVersion": "1.0.0",
    "completed": true
  }
}
EOF

echo "✅ Configuration written!"

# Health check endpoint
echo "🏥 Starting health check server..."
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
  console.log('Health check server listening on port 8080');
});
" &

# Give health check server time to start
sleep 2

echo "🌐 Starting OpenClaw gateway..."

# Start the gateway (blocks)
exec openclaw gateway start --foreground

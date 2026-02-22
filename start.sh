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
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
  echo "   TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN:0:15}..."
else
  echo "   TELEGRAM_BOT_TOKEN: (not configured)"
fi
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

  # Configure Telegram channel properly (ONLY if token is provided)
  if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
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
    echo "ℹ️  Telegram not configured - you can add it later through the chat interface"
  fi
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

      // Sync AI model from environment variable (source of truth)
      // Note: This will overwrite manual config edits. To change the model,
      // update the ANTHROPIC_MODEL environment variable in Railway dashboard.
      if (!config.agents) config.agents = {};
      if (!config.agents.defaults) config.agents.defaults = {};

      const expectedModel = process.env.ANTHROPIC_MODEL
        ? 'anthropic/' + process.env.ANTHROPIC_MODEL
        : 'anthropic/claude-sonnet-4-5-20250929';

      const currentModel = config.agents.defaults.model?.primary;

      // Always sync config to match env var (env var is source of truth)
      if (!currentModel || currentModel !== expectedModel) {
        console.log('🔧 Syncing AI model from env var:', expectedModel);
        if (currentModel && currentModel !== expectedModel) {
          console.log('   Previous model:', currentModel);
        }
        config.agents.defaults.model = {
          primary: expectedModel
        };
        needsUpdate = true;
      }

      // Ensure HTTP endpoints are configured (required for web chat)
      if (!config.gateway) config.gateway = {};
      if (!config.gateway.http) config.gateway.http = {};
      if (!config.gateway.http.endpoints) config.gateway.http.endpoints = {};

      if (!config.gateway.http.endpoints.chatCompletions || !config.gateway.http.endpoints.responses) {
        console.log('🔧 Configuring HTTP endpoints for web chat');
        config.gateway.http.endpoints.chatCompletions = { enabled: true };
        config.gateway.http.endpoints.responses = { enabled: true };
        needsUpdate = true;
      }

      // Ensure gateway authentication is configured
      if (!config.gateway.auth) config.gateway.auth = {};
      if (!config.gateway.auth.mode || !config.gateway.auth.token) {
        console.log('🔧 Configuring gateway authentication');
        config.gateway.auth.mode = 'token';
        config.gateway.auth.token = process.env.PAIRING_API_SECRET;
        needsUpdate = true;
      }

      // Update Telegram bot token if provided (warm instance reconfiguration)
      const envBotToken = process.env.TELEGRAM_BOT_TOKEN;

      if (envBotToken && envBotToken !== 'PLACEHOLDER' && envBotToken.length > 0) {
        if (!config.channels) config.channels = {};
        if (!config.channels.telegram) config.channels.telegram = {};

        const currentBotToken = config.channels.telegram.botToken;

        if (currentBotToken === 'PLACEHOLDER' || !currentBotToken) {
          console.log('🔧 Updating Telegram configuration with provided bot token');
          config.channels.telegram = {
            enabled: true,
            botToken: envBotToken,
            dmPolicy: 'pairing',
            allowFrom: config.channels.telegram.allowFrom || []
          };
          needsUpdate = true;
        } else if (currentBotToken !== envBotToken) {
          console.log('🔧 Syncing Telegram bot token from environment');
          config.channels.telegram.botToken = envBotToken;
          needsUpdate = true;
        }
      } else {
        // No Telegram token provided - disable Telegram if it exists
        if (config.channels?.telegram?.enabled) {
          console.log('ℹ️  No Telegram token in environment - disabling Telegram channel');
          if (!config.channels) config.channels = {};
          if (!config.channels.telegram) config.channels.telegram = {};
          config.channels.telegram.enabled = false;
          needsUpdate = true;
        }
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

# Verify configuration before starting gateway
echo "🔍 Checking agent configuration..."
node -e "
  const fs = require('fs');
  const config = JSON.parse(fs.readFileSync('$OPENCLAW_STATE_DIR/openclaw.json', 'utf8'));

  // Check Telegram configuration (optional)
  if (config.channels?.telegram?.enabled) {
    console.log('✅ Telegram channel is enabled');
    console.log('   Bot Token: ' + (process.env.TELEGRAM_BOT_TOKEN?.substring(0, 10) || 'N/A') + '...');
  } else {
    console.log('ℹ️  Telegram channel is not configured (optional)');
  }

  // Check gateway configuration (required) - DETAILED VERIFICATION
  console.log('🔍 Verifying gateway configuration...');

  // 1. Check HTTP endpoints exist
  if (!config.gateway?.http?.endpoints) {
    console.error('❌ CRITICAL: config.gateway.http.endpoints is missing!');
    console.error('   Expected structure: { chatCompletions: { enabled: true }, responses: { enabled: true } }');
    process.exit(1);
  }

  // 2. Check chatCompletions endpoint
  if (!config.gateway.http.endpoints.chatCompletions?.enabled) {
    console.error('❌ CRITICAL: chatCompletions endpoint not enabled!');
    console.error('   Current value:', JSON.stringify(config.gateway.http.endpoints.chatCompletions));
    console.error('   Required: { enabled: true }');
    process.exit(1);
  }

  // 3. Check responses endpoint
  if (!config.gateway.http.endpoints.responses?.enabled) {
    console.error('❌ CRITICAL: responses endpoint not enabled!');
    console.error('   Current value:', JSON.stringify(config.gateway.http.endpoints.responses));
    console.error('   Required: { enabled: true }');
    process.exit(1);
  }

  // 4. Check gateway auth
  if (!config.gateway.auth?.mode || !config.gateway.auth?.token) {
    console.error('❌ CRITICAL: Gateway authentication not configured!');
    console.error('   Current auth:', JSON.stringify(config.gateway.auth));
    console.error('   Required: { mode: "token", token: "..." }');
    process.exit(1);
  }

  // 5. Verify auth token matches env var
  if (config.gateway.auth.token !== process.env.PAIRING_API_SECRET) {
    console.error('❌ CRITICAL: Gateway auth token mismatch!');
    console.error('   Config token:', config.gateway.auth.token?.substring(0, 20) + '...');
    console.error('   Env var token:', process.env.PAIRING_API_SECRET?.substring(0, 20) + '...');
    process.exit(1);
  }

  console.log('✅ Gateway HTTP endpoints verified:');
  console.log('   - chatCompletions: enabled');
  console.log('   - responses: enabled');
  console.log('   - auth mode: ' + config.gateway.auth.mode);
  console.log('   - auth token: ' + config.gateway.auth.token.substring(0, 15) + '...');
"

if [ $? -ne 0 ]; then
  echo "❌ Configuration check failed. Cannot start gateway."
  echo "📋 Config file contents:"
  cat "$OPENCLAW_STATE_DIR/openclaw.json"
  exit 1
fi

echo "🌐 Starting OpenClaw gateway on port 18789..."
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
  echo "📱 Telegram bot token: ${TELEGRAM_BOT_TOKEN:0:10}..."
else
  echo "📱 Telegram: Not configured (optional)"
fi
echo "🔑 Anthropic API key: ${ANTHROPIC_API_KEY:0:10}..."
echo ""

# Start the gateway in background first for health check
echo "🚀 Starting gateway in background for health verification..."
openclaw gateway --port 18789 &
GATEWAY_PID=$!

# Wait for gateway to start (give it 30 seconds)
echo "⏳ Waiting for gateway to initialize (30 seconds)..."
sleep 30

# Health check: Test /chat endpoint with authentication
echo "🏥 Running /chat endpoint health check..."
HEALTH_CHECK_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST http://localhost:18789/chat \
  -H "Authorization: Bearer ${PAIRING_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw:main","messages":[{"role":"user","content":"health check"}],"user":"health"}' \
  2>&1)

HTTP_CODE=$(echo "$HEALTH_CHECK_RESPONSE" | tail -n 1)
RESPONSE_BODY=$(echo "$HEALTH_CHECK_RESPONSE" | head -n -1)

echo "📊 Health check response: HTTP $HTTP_CODE"

# Check if /chat endpoint is accessible
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "400" ]; then
  # 200 = success, 400 = validation error (but endpoint is working)
  echo "✅ /chat endpoint is responding correctly!"
  echo "   Status: $HTTP_CODE"
  echo "   Gateway is healthy and ready to accept requests"
else
  echo "❌ CRITICAL: /chat endpoint health check failed!"
  echo "   Expected: HTTP 200 or 400 (validation error)"
  echo "   Got: HTTP $HTTP_CODE"
  echo "   Response: $RESPONSE_BODY"
  echo ""
  echo "📋 This usually means:"
  echo "   1. Gateway authentication is not configured correctly"
  echo "   2. HTTP endpoints are not enabled in openclaw.json"
  echo "   3. Gateway failed to start properly"
  echo ""
  echo "📋 Config file contents:"
  cat "$OPENCLAW_STATE_DIR/openclaw.json"
  echo ""
  echo "Killing gateway process..."
  kill $GATEWAY_PID 2>/dev/null || true
  exit 1
fi

# Health check passed - gateway is already running in background
# Bring it to foreground so it keeps running
echo ""
echo "✅ All health checks passed! Gateway is ready."
echo "🎯 Bringing gateway to foreground..."
echo ""

# Wait for the gateway process (it's already running)
wait $GATEWAY_PID

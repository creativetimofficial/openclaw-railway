# OpenClaw Railway Template by Creative Tim

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
   - `/stats/usage` - Usage and cost statistics
   - `/stats/logs` - Recent log entries
   - `/stats/sessions` - Session list (cached)
   - `/stats/activity` - Activity summary
   - `/stats/cron` - Cron jobs list (cached)
   - `/stats/skills` - Installed skills list (cached)
   - `/skills/filesystem` - List skills from filesystem (workspace + managed)
   - `/skills/install` - Install new skill from SKILL.md content
   - `/debug/status` - Raw openclaw status JSON (for debugging)
   - `/debug/config` - Raw openclaw.json config (for debugging)

   **Memory Optimization:**
   - Status data is cached for 30 seconds with request locking
   - Only ONE request fetches status at a time, others wait for result
   - Prevents parallel `openclaw status --json` executions that cause crashes
   - Conservative buffer limits: 5MB (status), 2MB (logs/usage)
   - 10-second timeouts on all commands to prevent hanging
   - Skills endpoint uses cached status (safe with locking), falls back to config file
   - Sessions, cron, and skills all share the same cached status data

   **Skills Management:**
   - Skills configuration is stored in `~/.openclaw/openclaw.json` → `skills.entries`
   - Skills files are directories with `SKILL.md` files in (priority order):
     - Project-specific: `/data/workspace/.agents/skills/<skill-name>/SKILL.md` (highest)
     - Workspace: `/data/workspace/skills/<skill-name>/SKILL.md`
     - Managed/local: `/data/.openclaw/skills/<skill-name>/SKILL.md`
     - Bundled/system: `/usr/local/lib/node_modules/openclaw/skills/<skill-name>/SKILL.md` (lowest)
   - GET `/stats/skills` returns configured skills from `openclaw.json`
   - GET `/skills/filesystem` scans all 4 locations for SKILL.md files (advanced)
   - POST `/skills/install` creates SKILL.md programmatically (not commonly used)

   **Current Skills Installation Method:**
   - Users install skills by chatting with the agent
   - Example: "Hey, install skill with `npx clawhub install skill-name`"
   - Command installs files AND updates `openclaw.json` config
   - Skills appear in dashboard from `skills.entries` in config
   - This is the recommended MVP approach until full UI is built

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
You can also access your agent via Telegram with **pairing mode** (secure):

- 🔒 **Manual approval required** - Users get a pairing code
- 🔒 **You control access** - Approve only trusted users
- ✅ **Perfect for mobile use** - Chat from anywhere after approval

**How to approve Telegram users:**
1. User sends `/start` to your bot
2. Bot responds with a pairing code (e.g., "Pairing code: ABC123")
3. You can approve via web chat: Ask the agent to "approve telegram pairing code ABC123"
4. User can now chat with the bot

### Security Options

**Current mode: Pairing (Secure by default)**
- Users must be manually approved before chatting
- Recommended for production use

**Alternative modes:**

**1. Allowlist Mode** (Pre-approved users only):
1. Get your Telegram user ID (send a message to @userinfobot)
2. Edit `start.sh` to set:
   ```javascript
   dmPolicy: 'allowlist',
   allowFrom: ['123456789', '987654321']
   ```
3. Redeploy - only listed users can message the bot

**2. Open Mode** (Anyone can message - not recommended):
1. Edit `start.sh` to set:
   ```javascript
   dmPolicy: 'open',
   allowFrom: ['*']
   ```
2. Redeploy - bot accepts messages from anyone

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

### Service Crashes or Becomes Unresponsive

If the OpenClaw service crashes or becomes unresponsive (e.g., gateway crash, memory issues):

**Via Dashboard:**
1. Go to your agent's details page
2. If there's a connection error, click **"Restart Service"** button
3. Wait 1-2 minutes for Railway to redeploy the service
4. Page will refresh automatically when service is back online

**What happens behind the scenes:**
- Triggers a Railway service redeploy via GraphQL API
- Railway pulls latest code and redeploys the container
- All environment variables and volumes are preserved
- More reliable than internal restarts when gateway is crashed

**The service may crash when:**
- Gateway process crashes unexpectedly
- Memory/resource limits exceeded
- Config changes require full restart
- Container becomes unhealthy

**Why Railway restart instead of internal gateway restart:**
- When gateway crashes, internal HTTP endpoints become inaccessible
- Railway service restart works even when gateway is completely down
- Guaranteed clean restart with fresh container state

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

### Bot asks for pairing code (Telegram)
- **This is expected behavior** - the bot uses pairing mode by default
- User gets a pairing code like: `Pairing code: ABC123`
- **To approve:** Use the web chat interface and ask: "approve telegram pairing code ABC123"
- Or check Railway logs to find the code and approve manually

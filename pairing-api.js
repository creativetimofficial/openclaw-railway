#!/usr/bin/env node
/**
 * Pairing Management API for OpenClaw
 * Runs alongside the gateway to provide remote pairing control
 */

const http = require('http');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');

const execAsync = promisify(exec);
const PORT = 8081;
const API_SECRET = process.env.PAIRING_API_SECRET || 'change-me-in-production';
const STATE_DIR = process.env.OPENCLAW_STATE_DIR || '/data/.openclaw';
const FIRST_USER_FILE = path.join(STATE_DIR, 'first-approved-user.json');

// Track the auto-approve monitor process
let autoApproveProcess = null;

/**
 * Execute openclaw pairing commands
 */
async function listPairings(channel = 'telegram') {
  try {
    const { stdout } = await execAsync(`openclaw pairing list ${channel} --json`);
    return JSON.parse(stdout);
  } catch (error) {
    console.error('Failed to list pairings:', error.message);
    return { pending: [] };
  }
}

async function approvePairing(channel, code) {
  try {
    const { stdout, stderr } = await execAsync(
      `openclaw pairing approve ${channel} ${code}`
    );
    return { success: true, output: stdout, error: stderr };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Start the auto-approval monitor
 */
function startAutoApprove() {
  if (autoApproveProcess) {
    console.log('⚠️  Auto-approve monitor already running');
    return { success: false, error: 'Monitor already running' };
  }

  console.log('🚀 Starting auto-approve monitor...');
  autoApproveProcess = spawn('node', ['/app/auto-approve-first.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  autoApproveProcess.stdout.on('data', (data) => {
    console.log(`[auto-approve] ${data.toString().trim()}`);
  });

  autoApproveProcess.stderr.on('data', (data) => {
    console.error(`[auto-approve] ${data.toString().trim()}`);
  });

  autoApproveProcess.on('exit', (code) => {
    console.log(`[auto-approve] Process exited with code ${code}`);
    autoApproveProcess = null;
  });

  return { success: true, message: 'Auto-approve monitor started' };
}

/**
 * Stop the auto-approval monitor
 */
function stopAutoApprove() {
  if (!autoApproveProcess) {
    return { success: false, error: 'Monitor not running' };
  }

  autoApproveProcess.kill();
  autoApproveProcess = null;
  return { success: true, message: 'Auto-approve monitor stopped' };
}

/**
 * Check if auto-approve monitor is running
 */
function isAutoApproveRunning() {
  return autoApproveProcess !== null;
}

/**
 * Check if we've already auto-approved someone
 */
async function hasAutoApproved() {
  try {
    await fs.access(FIRST_USER_FILE);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stats Collection Functions
 */

/**
 * Get usage and cost statistics
 */
async function getUsageStats() {
  try {
    const { stdout } = await execAsync('openclaw status --usage --json');
    const data = JSON.parse(stdout);
    return { success: true, data };
  } catch (error) {
    console.error('Failed to get usage stats:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Get recent logs
 */
async function getRecentLogs(limit = 100) {
  try {
    const { stdout } = await execAsync(`openclaw logs --json --limit ${limit}`);
    const lines = stdout.trim().split('\n').filter(line => line);
    const logs = lines.map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return { message: line };
      }
    });
    return { success: true, logs };
  } catch (error) {
    console.error('Failed to get logs:', error.message);
    return { success: false, error: error.message, logs: [] };
  }
}

/**
 * Get session list and activity
 */
async function getSessionStats() {
  try {
    // Try to find sessions directory
    const sessionsDir = path.join(STATE_DIR, 'sessions');

    try {
      const sessions = await fs.readdir(sessionsDir);
      const sessionData = [];

      for (const sessionId of sessions.slice(0, 20)) { // Limit to 20 most recent
        try {
          const sessionPath = path.join(sessionsDir, sessionId);
          const stats = await fs.stat(sessionPath);

          // Try to read session metadata if it exists
          let metadata = { id: sessionId, updatedAt: stats.mtime };
          try {
            const metaPath = path.join(sessionPath, 'metadata.json');
            const metaContent = await fs.readFile(metaPath, 'utf8');
            metadata = { ...metadata, ...JSON.parse(metaContent) };
          } catch {
            // No metadata file, use defaults
          }

          sessionData.push(metadata);
        } catch (err) {
          console.error(`Error reading session ${sessionId}:`, err.message);
        }
      }

      return {
        success: true,
        sessions: sessionData,
        total: sessions.length
      };
    } catch (error) {
      // Sessions directory doesn't exist yet
      return {
        success: true,
        sessions: [],
        total: 0
      };
    }
  } catch (error) {
    console.error('Failed to get session stats:', error.message);
    return { success: false, error: error.message, sessions: [], total: 0 };
  }
}

/**
 * Get activity summary
 */
async function getActivitySummary() {
  try {
    // Get recent logs for activity
    const logsResult = await getRecentLogs(50);
    const logs = logsResult.logs || [];

    // Count different activity types
    const activity = {
      messages: 0,
      toolCalls: 0,
      errors: 0,
      lastActivity: null
    };

    logs.forEach(log => {
      if (log.level === 'error') activity.errors++;
      if (log.message && log.message.includes('tool')) activity.toolCalls++;
      if (log.message && log.message.includes('message')) activity.messages++;

      if (!activity.lastActivity && log.timestamp) {
        activity.lastActivity = log.timestamp;
      }
    });

    return { success: true, activity };
  } catch (error) {
    console.error('Failed to get activity summary:', error.message);
    return {
      success: false,
      error: error.message,
      activity: { messages: 0, toolCalls: 0, errors: 0, lastActivity: null }
    };
  }
}

/**
 * Simple HTTP server
 */
const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // GET /health - Health check (no auth required for Railway health checks)
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'openclaw-pairing-api' }));
    return;
  }

  // Auth check (required for all endpoints except /health)
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${API_SECRET}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  // GET /pairing/list - List pending pairing requests
  if (req.method === 'GET' && url.pathname === '/pairing/list') {
    const channel = url.searchParams.get('channel') || 'telegram';
    const pairings = await listPairings(channel);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(pairings));
    return;
  }

  // POST /pairing/approve - Approve a pairing code
  if (req.method === 'POST' && url.pathname === '/pairing/approve') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { channel = 'telegram', code } = JSON.parse(body);

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing code parameter' }));
          return;
        }

        const result = await approvePairing(channel, code);
        res.writeHead(result.success ? 200 : 500, {
          'Content-Type': 'application/json'
        });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // GET /first-user - Get first approved user info
  if (req.method === 'GET' && url.pathname === '/first-user') {
    try {
      const data = await fs.readFile(FIRST_USER_FILE, 'utf8');
      const userInfo = JSON.parse(data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, user: userInfo }));
    } catch (error) {
      // File doesn't exist yet - no first user approved
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, user: null }));
    }
    return;
  }

  // POST /start-auto-approve - Start the auto-approval monitor
  if (req.method === 'POST' && url.pathname === '/start-auto-approve') {
    const result = startAutoApprove();
    res.writeHead(result.success ? 200 : 400, {
      'Content-Type': 'application/json'
    });
    res.end(JSON.stringify(result));
    return;
  }

  // POST /stop-auto-approve - Stop the auto-approval monitor
  if (req.method === 'POST' && url.pathname === '/stop-auto-approve') {
    const result = stopAutoApprove();
    res.writeHead(result.success ? 200 : 400, {
      'Content-Type': 'application/json'
    });
    res.end(JSON.stringify(result));
    return;
  }

  // GET /auto-approve-status - Check if auto-approve is running
  if (req.method === 'GET' && url.pathname === '/auto-approve-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      running: isAutoApproveRunning(),
      hasApproved: await hasAutoApproved()
    }));
    return;
  }

  // GET /stats/usage - Get usage and cost statistics
  if (req.method === 'GET' && url.pathname === '/stats/usage') {
    const result = await getUsageStats();
    res.writeHead(result.success ? 200 : 500, {
      'Content-Type': 'application/json'
    });
    res.end(JSON.stringify(result));
    return;
  }

  // GET /stats/logs - Get recent logs
  if (req.method === 'GET' && url.pathname === '/stats/logs') {
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    const result = await getRecentLogs(limit);
    res.writeHead(result.success ? 200 : 500, {
      'Content-Type': 'application/json'
    });
    res.end(JSON.stringify(result));
    return;
  }

  // GET /stats/sessions - Get session list and stats
  if (req.method === 'GET' && url.pathname === '/stats/sessions') {
    const result = await getSessionStats();
    res.writeHead(result.success ? 200 : 500, {
      'Content-Type': 'application/json'
    });
    res.end(JSON.stringify(result));
    return;
  }

  // GET /stats/activity - Get activity summary
  if (req.method === 'GET' && url.pathname === '/stats/activity') {
    const result = await getActivitySummary();
    res.writeHead(result.success ? 200 : 500, {
      'Content-Type': 'application/json'
    });
    res.end(JSON.stringify(result));
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🔐 Pairing API listening on port ${PORT}`);
  console.log(`   `);
  console.log(`   Public endpoints (no auth required):`);
  console.log(`   GET  /health - Health check`);
  console.log(`   `);
  console.log(`   Protected endpoints (require Bearer token):`);
  console.log(`   GET  /first-user - Get first approved user info`);
  console.log(`   GET  /pairing/list?channel=telegram - List pending pairings`);
  console.log(`   POST /pairing/approve - Approve a pairing code`);
  console.log(`   POST /start-auto-approve - Start auto-approval monitor`);
  console.log(`   POST /stop-auto-approve - Stop auto-approval monitor`);
  console.log(`   GET  /auto-approve-status - Check auto-approve status`);
  console.log(`   GET  /stats/usage - Get usage and cost statistics`);
  console.log(`   GET  /stats/logs?limit=100 - Get recent logs`);
  console.log(`   GET  /stats/sessions - Get session list`);
  console.log(`   GET  /stats/activity - Get activity summary`);
  console.log(`   `);
  console.log(`   Auth: Bearer ${API_SECRET.substring(0, 10)}...`);
});

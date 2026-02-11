#!/usr/bin/env node
/**
 * Stats and Health Check API for OpenClaw
 * Provides health checks and stats endpoints for Railway deployment
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
const GATEWAY_URL = 'http://127.0.0.1:18789';

/**
 * Chat Proxy Functions
 */

/**
 * Proxy chat request to OpenClaw gateway
 */
async function proxyChatRequest(body, isStreaming = false) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);

    const options = {
      hostname: '127.0.0.1',
      port: 18789,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_SECRET}`,
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    const req = http.request(options, (res) => {
      if (isStreaming) {
        // For streaming, return the response object directly
        resolve(res);
      } else {
        let responseData = '';
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(responseData);
            resolve({ statusCode: res.statusCode, data: parsed });
          } catch (err) {
            resolve({ statusCode: res.statusCode, data: responseData });
          }
        });
      }
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(data);
    req.end();
  });
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
    res.end(JSON.stringify({ status: 'ok', service: 'openclaw-stats-api' }));
    return;
  }

  // Auth check (required for all endpoints except /health)
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${API_SECRET}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  // POST /chat - Proxy chat requests to OpenClaw gateway
  if (req.method === 'POST' && url.pathname === '/chat') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const chatRequest = JSON.parse(body);
        const isStreaming = chatRequest.stream === true;

        const result = await proxyChatRequest(chatRequest, isStreaming);

        if (isStreaming) {
          // Forward streaming response
          res.writeHead(result.statusCode, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });
          result.pipe(res);
        } else {
          // Forward non-streaming response
          res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.data));
        }
      } catch (error) {
        console.error('Chat proxy error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
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

  // POST /restart-gateway - Restart the OpenClaw gateway
  if (req.method === 'POST' && url.pathname === '/restart-gateway') {
    try {
      console.log('🔄 Restarting OpenClaw gateway using official method...');

      // Step 1: Find gateway PID
      let gatewayPid;
      try {
        const { stdout } = await execAsync('pgrep -f "openclaw gateway"');
        gatewayPid = stdout.trim().split('\n')[0]; // Get first PID if multiple
        console.log(`📍 Found gateway process: PID ${gatewayPid}`);
      } catch (err) {
        console.log('ℹ️  No gateway process found');
        // Try to start gateway anyway
        const gateway = spawn('openclaw', ['gateway', '--port', '18789'], {
          detached: true,
          stdio: 'inherit'
        });
        gateway.unref();
        console.log('✅ Gateway started');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Gateway started (was not running)'
        }));
        return;
      }

      // Step 2: Send SIGTERM for graceful shutdown (official method)
      console.log('📤 Sending SIGTERM for graceful shutdown...');
      await execAsync(`kill -TERM ${gatewayPid}`);

      // Step 3: Wait for process to exit gracefully (up to 10 seconds)
      let attempts = 0;
      while (attempts < 20) {
        try {
          await execAsync(`kill -0 ${gatewayPid}`); // Check if process exists
          await new Promise(resolve => setTimeout(resolve, 500));
          attempts++;
        } catch {
          // Process exited
          console.log('✅ Gateway stopped gracefully');
          break;
        }
      }

      if (attempts >= 20) {
        console.log('⚠️  Gateway did not exit gracefully, may need to wait longer');
      }

      // Step 4: Wait a moment for port to be released
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Step 5: Start new gateway process
      console.log('🚀 Starting new gateway process...');
      const gateway = spawn('openclaw', ['gateway', '--port', '18789'], {
        detached: true,
        stdio: 'inherit'
      });
      gateway.unref();

      console.log('✅ Gateway restarted successfully');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Gateway restarted successfully using SIGTERM'
      }));
    } catch (error) {
      console.error('❌ Failed to restart gateway:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: error.message
      }));
    }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`📊 OpenClaw API listening on port ${PORT}`);
  console.log(`   `);
  console.log(`   Public endpoints (no auth required):`);
  console.log(`   GET  /health - Health check`);
  console.log(`   `);
  console.log(`   Protected endpoints (require Bearer token):`);
  console.log(`   POST /chat - Chat with agent (proxies to gateway)`);
  console.log(`   POST /restart-gateway - Restart gateway (recovery)`);
  console.log(`   GET  /stats/usage - Get usage and cost statistics`);
  console.log(`   GET  /stats/logs?limit=100 - Get recent logs`);
  console.log(`   GET  /stats/sessions - Get session list`);
  console.log(`   GET  /stats/activity - Get activity summary`);
  console.log(`   `);
  console.log(`   Auth: Bearer ${API_SECRET.substring(0, 10)}...`);
});

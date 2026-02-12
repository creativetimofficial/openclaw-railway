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
 * Get session list using official OpenClaw command
 */
async function getSessionStats() {
  try {
    const { stdout } = await execAsync('openclaw sessions --json');
    const sessions = JSON.parse(stdout);

    return {
      success: true,
      sessions: Array.isArray(sessions) ? sessions : [],
      total: Array.isArray(sessions) ? sessions.length : 0
    };
  } catch (error) {
    console.error('Failed to get session stats:', error.message);
    return { success: true, sessions: [], total: 0 };
  }
}

/**
 * Get activity summary by parsing recent logs
 * Note: OpenClaw doesn't have a direct API for message/tool call counts,
 * so we parse logs to derive activity metrics
 */
async function getActivitySummary() {
  try {
    const logsResult = await getRecentLogs(100);
    const logs = logsResult.logs || [];

    let totalMessages = 0;
    let totalToolCalls = 0;
    let totalErrors = 0;
    let lastActivity = null;

    logs.forEach(log => {
      // Count errors
      if (log.level === 'error') {
        totalErrors++;
      }

      // Count tool calls (look for tool-related log messages)
      if (log.message) {
        const msg = log.message.toLowerCase();
        if (msg.includes('tool') || msg.includes('function call') || msg.includes('executing')) {
          totalToolCalls++;
        }
        // Count messages (look for message-related log entries)
        if (msg.includes('message') || msg.includes('chat') || msg.includes('response')) {
          totalMessages++;
        }
      }

      // Track last activity timestamp
      if (log.timestamp) {
        if (!lastActivity || log.timestamp > lastActivity) {
          lastActivity = log.timestamp;
        }
      }
    });

    return {
      success: true,
      activity: {
        messages: totalMessages,
        toolCalls: totalToolCalls,
        errors: totalErrors,
        lastActivity
      }
    };
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
 * Get cron jobs list by parsing openclaw.json config file
 */
async function getCronJobs() {
  try {
    // Read the openclaw.json config file
    const configPath = path.join(STATE_DIR, 'openclaw.json');
    const configContent = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);

    const jobs = [];

    // Check for heartbeat configuration (special cron-like task)
    if (config.heartbeat && config.heartbeat.agents) {
      config.heartbeat.agents.forEach(agent => {
        jobs.push({
          id: `heartbeat-${agent.agentId}`,
          name: `Heartbeat: ${agent.agentId}`,
          schedule: agent.every || 'unknown',
          enabled: agent.enabled !== false,
          lastRun: null,
          nextRun: null
        });
      });
    }

    // Check for cron configuration (if exists in config)
    if (config.cron && Array.isArray(config.cron)) {
      config.cron.forEach((job, index) => {
        jobs.push({
          id: job.id || `cron-${index}`,
          name: job.name || job.description || `Cron job ${index + 1}`,
          schedule: job.schedule || job.cron || 'unknown',
          enabled: job.enabled !== false,
          lastRun: job.lastRun || null,
          nextRun: job.nextRun || null
        });
      });
    }

    // Alternative: check for jobs array (alternative config structure)
    if (config.jobs && Array.isArray(config.jobs)) {
      config.jobs.forEach((job, index) => {
        jobs.push({
          id: job.id || `job-${index}`,
          name: job.name || job.description || `Job ${index + 1}`,
          schedule: job.schedule || job.cron || job.every || 'unknown',
          enabled: job.enabled !== false,
          lastRun: job.lastRun || null,
          nextRun: job.nextRun || null
        });
      });
    }

    return {
      success: true,
      jobs,
      total: jobs.length
    };
  } catch (error) {
    console.error('Failed to get cron jobs:', error.message);
    return { success: true, jobs: [], total: 0 };
  }
}

/**
 * Get installed skills list using official OpenClaw command
 */
async function getSkillsList() {
  try {
    // Try with --json flag first
    try {
      const { stdout } = await execAsync('openclaw skills list --json');
      const skills = JSON.parse(stdout);
      return {
        success: true,
        skills: Array.isArray(skills) ? skills : [],
        total: Array.isArray(skills) ? skills.length : 0
      };
    } catch (jsonError) {
      // If --json flag not supported, parse plain text output
      const { stdout } = await execAsync('openclaw skills list');
      const skills = [];

      // Parse plain text output (format: "1. 🛡️ healthcheck — Description")
      const lines = stdout.trim().split('\n');
      lines.forEach(line => {
        // Match pattern: number. emoji name — description
        const match = line.match(/^\d+\.\s+(?:[\u{1F300}-\u{1F9FF}]\s+)?(.+?)\s+—\s+(.+)$/u);
        if (match) {
          skills.push({
            name: match[1].trim(),
            version: null,
            enabled: true,
            description: match[2].trim()
          });
        }
      });

      return {
        success: true,
        skills,
        total: skills.length
      };
    }
  } catch (error) {
    console.error('Failed to get skills:', error.message);
    return { success: true, skills: [], total: 0 };
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

  // GET /stats/cron - Get cron jobs list
  if (req.method === 'GET' && url.pathname === '/stats/cron') {
    const result = await getCronJobs();
    res.writeHead(result.success ? 200 : 500, {
      'Content-Type': 'application/json'
    });
    res.end(JSON.stringify(result));
    return;
  }

  // GET /stats/skills - Get installed skills list
  if (req.method === 'GET' && url.pathname === '/stats/skills') {
    const result = await getSkillsList();
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
  console.log(`📊 OpenClaw API listening on port ${PORT}`);
  console.log(`   `);
  console.log(`   Public endpoints (no auth required):`);
  console.log(`   GET  /health - Health check`);
  console.log(`   `);
  console.log(`   Protected endpoints (require Bearer token):`);
  console.log(`   POST /chat - Chat with agent (proxies to gateway)`);
  console.log(`   GET  /stats/usage - Get usage and cost statistics`);
  console.log(`   GET  /stats/logs?limit=100 - Get recent logs`);
  console.log(`   GET  /stats/sessions - Get session list`);
  console.log(`   GET  /stats/activity - Get activity summary`);
  console.log(`   GET  /stats/cron - Get cron jobs list`);
  console.log(`   GET  /stats/skills - Get installed skills list`);
  console.log(`   `);
  console.log(`   Auth: Bearer ${API_SECRET.substring(0, 10)}...`);
});

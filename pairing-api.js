#!/usr/bin/env node
/**
 * Pairing Management API for OpenClaw
 * Runs alongside the gateway to provide remote pairing control
 */

const http = require('http');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');

const execAsync = promisify(exec);
const PORT = 8081;
const API_SECRET = process.env.PAIRING_API_SECRET || 'change-me-in-production';
const STATE_DIR = process.env.OPENCLAW_STATE_DIR || '/data/.openclaw';
const FIRST_USER_FILE = path.join(STATE_DIR, 'first-approved-user.json');

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

  // Auth check
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${API_SECRET}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

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

  // GET /health - Health check
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'pairing-api' }));
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🔐 Pairing API listening on port ${PORT}`);
  console.log(`   GET  /first-user - Get first approved user info`);
  console.log(`   GET  /pairing/list?channel=telegram`);
  console.log(`   POST /pairing/approve (body: {"channel":"telegram","code":"ABC123"})`);
  console.log(`   Auth: Bearer ${API_SECRET.substring(0, 10)}...`);
});

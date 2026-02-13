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
 * Status Cache - Prevents memory overflow from parallel requests
 */
let cachedStatus = null;
let statusCacheTimestamp = 0;
let statusFetchPromise = null; // Lock to prevent parallel fetches
const STATUS_CACHE_TTL = 30000; // 30 seconds

/**
 * Get OpenClaw status with caching AND locking to prevent memory overflow
 * This ensures only ONE request fetches status at a time, others wait for the result
 */
async function getCachedStatus() {
  const now = Date.now();

  // Return cached status if still valid
  if (cachedStatus && (now - statusCacheTimestamp) < STATUS_CACHE_TTL) {
    const age = Math.round((now - statusCacheTimestamp) / 1000);
    console.log(`📦 Using cached status (age: ${age}s)`);
    return cachedStatus;
  }

  // If another request is already fetching, wait for that result
  if (statusFetchPromise) {
    console.log('⏳ Waiting for ongoing status fetch...');
    try {
      await statusFetchPromise;
      // After waiting, return the cached result
      if (cachedStatus) {
        console.log('✅ Received status from ongoing fetch');
        return cachedStatus;
      }
    } catch (error) {
      console.error('❌ Ongoing fetch failed:', error.message);
      // Fall through to try fetching ourselves
    }
  }

  // Start a new fetch (this is the lock)
  console.log('🔄 Fetching fresh status from OpenClaw...');
  statusFetchPromise = (async () => {
    try {
      const { stdout } = await execAsync('openclaw status --json', {
        maxBuffer: 5 * 1024 * 1024, // 5MB max buffer (reduced from 10MB)
        timeout: 10000 // 10 second timeout (reduced from 15s)
      });

      // Parse JSON safely
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (parseError) {
        console.error('❌ Failed to parse status JSON:', parseError.message);
        throw new Error('Invalid JSON response from openclaw status');
      }

      cachedStatus = parsed;
      statusCacheTimestamp = Date.now();
      console.log('✅ Status cached successfully');
      return cachedStatus;
    } catch (error) {
      console.error('❌ Failed to get status:', error.message);
      // If we have old cached data, return it despite being stale
      if (cachedStatus) {
        console.log('⚠️  Returning stale cached status due to error');
        return cachedStatus;
      }
      throw error;
    } finally {
      // Release the lock
      statusFetchPromise = null;
    }
  })();

  return await statusFetchPromise;
}

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
    const { stdout } = await execAsync('openclaw status --usage --json', {
      maxBuffer: 2 * 1024 * 1024, // 2MB max buffer (reduced)
      timeout: 10000 // 10 second timeout (reduced)
    });
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
    const { stdout } = await execAsync(`openclaw logs --json --limit ${limit}`, {
      maxBuffer: 2 * 1024 * 1024, // 2MB max buffer (reduced)
      timeout: 10000 // 10 second timeout (reduced)
    });
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
 * Get session list using cached OpenClaw status
 */
async function getSessionStats() {
  try {
    // Use cached status to avoid parallel executions
    const status = await getCachedStatus();

    if (status && status.sessions && status.sessions.recent) {
      const sessions = status.sessions.recent.map(s => ({
        id: s.sessionId || s.key,
        key: s.key,
        agentId: s.agentId,
        updatedAt: new Date(s.updatedAt).toISOString(),
        messageCount: s.inputTokens + s.outputTokens || 0,
        model: s.model,
        totalTokens: s.totalTokens
      }));

      return {
        success: true,
        sessions,
        total: status.sessions.count || sessions.length
      };
    }

    return { success: true, sessions: [], total: 0 };
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
 * Get cron jobs list from cached OpenClaw status and config files
 */
async function getCronJobs() {
  try {
    const jobs = [];

    // Method 1: Get from cached status (most reliable, prevents memory overflow)
    try {
      const status = await getCachedStatus();

      // Check heartbeat configuration
      if (status.heartbeat && status.heartbeat.agents) {
        status.heartbeat.agents.forEach(agent => {
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
    } catch (statusError) {
      console.error('Failed to get cached status for cron:', statusError.message);
    }

    // Method 2: Read cron jobs from the cron jobs file
    try {
      const cronPath = path.join(STATE_DIR, 'cron', 'jobs.json');
      const cronContent = await fs.readFile(cronPath, 'utf8');
      const cronData = JSON.parse(cronContent);

      if (cronData.jobs && Array.isArray(cronData.jobs)) {
        cronData.jobs.forEach(job => {
          jobs.push({
            id: job.id || `cron-${job.name}`,
            name: job.name || job.description || 'Cron job',
            schedule: job.schedule || job.cron || 'unknown',
            enabled: job.enabled !== false,
            lastRun: job.lastRun || null,
            nextRun: job.nextRun || null
          });
        });
      }
    } catch (cronError) {
      // Cron file doesn't exist yet - that's OK
    }

    // Method 3: Read from openclaw.json config (fallback)
    try {
      const configPath = path.join(STATE_DIR, 'openclaw.json');
      const configContent = await fs.readFile(configPath, 'utf8');
      const config = JSON.parse(configContent);

      // Only add if we haven't already found heartbeat jobs
      if (jobs.length === 0 && config.heartbeat && config.heartbeat.agents) {
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
    } catch (configError) {
      console.error('Failed to read config for cron:', configError.message);
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
 * Get installed skills list from config file
 * Skills are stored in ~/.openclaw/openclaw.json under skills.entries
 * Per documentation: https://docs.openclaw.ai/tools/skills-config
 */
async function getSkillsList() {
  try {
    const configPath = path.join(STATE_DIR, 'openclaw.json');
    const configContent = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);

    console.log('📊 Reading skills from config.skills.entries');

    // Skills are in config.skills.entries as an object
    if (!config.skills) {
      console.log('⚠️  No skills key in config');
      return { success: true, skills: [], total: 0 };
    }

    if (!config.skills.entries || typeof config.skills.entries !== 'object') {
      console.log('⚠️  No skills.entries in config or not an object');
      console.log('📊 config.skills keys:', Object.keys(config.skills).join(', '));
      return { success: true, skills: [], total: 0 };
    }

    console.log('📊 config.skills.entries keys:', Object.keys(config.skills.entries).join(', '));

    // Convert entries object to array
    const skills = Object.entries(config.skills.entries).map(([name, data]) => ({
      name: name,
      description: data.description || null,
      location: 'config', // All skills from config
      path: `~/.openclaw/openclaw.json (skills.entries.${name})`,
      enabled: data.enabled !== false, // Default to enabled unless explicitly false
    }));

    console.log(`✅ Found ${skills.length} skills in config.skills.entries`);

    return {
      success: true,
      skills,
      total: skills.length
    };
  } catch (error) {
    console.error('Failed to get skills from config:', error.message);
    return { success: false, error: error.message, skills: [], total: 0 };
  }
}

/**
 * List skills from filesystem directories
 * Skills are stored as directories with SKILL.md files
 * This complements the config-based skills list
 */
async function listSkillsFromFilesystem() {
  try {
    console.log('🔍 Scanning filesystem for SKILL.md files');

    const skillsDirs = [
      path.join(STATE_DIR, '..', 'workspace', '.agents', 'skills'), // Project-specific skills (highest priority)
      path.join(STATE_DIR, '..', 'workspace', 'skills'),             // Workspace skills
      path.join(STATE_DIR, 'skills'),                                // Managed/local skills
      '/usr/local/lib/node_modules/openclaw/skills',                 // Bundled/system skills
    ];

    console.log('🔍 Skills directories to scan:', skillsDirs);

    const allSkills = [];

    for (const skillsDir of skillsDirs) {
      console.log(`📂 Checking directory: ${skillsDir}`);
      try {
        const entries = await fs.readdir(skillsDir, { withFileTypes: true });
        console.log(`✅ Found ${entries.length} entries in ${skillsDir}`);

        for (const entry of entries) {
          if (entry.isDirectory()) {
            const skillPath = path.join(skillsDir, entry.name);
            const skillMdPath = path.join(skillPath, 'SKILL.md');

            console.log(`  📄 Found directory: ${entry.name}, checking for SKILL.md...`);

            try {
              const content = await fs.readFile(skillMdPath, 'utf8');

              // Parse frontmatter
              const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
              let metadata = {};

              if (frontmatterMatch) {
                const frontmatter = frontmatterMatch[1];
                const lines = frontmatter.split('\n');

                for (const line of lines) {
                  const colonIndex = line.indexOf(':');
                  if (colonIndex > 0) {
                    const key = line.substring(0, colonIndex).trim();
                    const value = line.substring(colonIndex + 1).trim();
                    metadata[key] = value;
                  }
                }
              }

              // Determine location based on directory path
              let location = 'managed';
              if (skillsDir.includes('.agents/skills')) {
                location = 'project';
              } else if (skillsDir.includes('workspace/skills')) {
                location = 'workspace';
              } else if (skillsDir.includes('node_modules/openclaw')) {
                location = 'bundled';
              }

              const skill = {
                name: metadata.name || entry.name,
                description: metadata.description || null,
                location: location,
                path: skillPath,
                enabled: true, // Filesystem presence implies available
              };

              console.log(`  ✅ Loaded skill: ${skill.name} (${location})`);
              allSkills.push(skill);
            } catch (readError) {
              // Skill directory exists but no SKILL.md or can't read it
              console.error(`  ❌ Failed to read skill at ${skillPath}:`, readError.message);
            }
          }
        }
      } catch (dirError) {
        // Directory doesn't exist - that's OK
        console.log(`Skills directory ${skillsDir} not found (this is OK)`);
      }
    }

    console.log(`📋 Total skills found: ${allSkills.length}`);

    return {
      success: true,
      skills: allSkills,
      total: allSkills.length,
    };
  } catch (error) {
    console.error('Failed to list skills from filesystem:', error.message);
    return { success: false, error: error.message, skills: [], total: 0 };
  }
}

/**
 * Install a new skill by writing SKILL.md to the workspace skills directory
 */
async function installSkill(skillName, skillContent) {
  try {
    // Validate skill name (alphanumeric, hyphens, underscores only)
    if (!/^[a-zA-Z0-9_-]+$/.test(skillName)) {
      return {
        success: false,
        error: 'Invalid skill name. Use only letters, numbers, hyphens, and underscores.',
      };
    }

    // Validate skill content has frontmatter
    if (!skillContent.startsWith('---\n')) {
      return {
        success: false,
        error: 'Skill content must start with YAML frontmatter (---)',
      };
    }

    const workspaceSkillsDir = path.join(STATE_DIR, '..', 'workspace', 'skills');
    const skillDir = path.join(workspaceSkillsDir, skillName);
    const skillFilePath = path.join(skillDir, 'SKILL.md');

    // Check if skill already exists
    try {
      await fs.access(skillFilePath);
      return {
        success: false,
        error: `Skill '${skillName}' already exists. Delete it first to reinstall.`,
      };
    } catch {
      // Skill doesn't exist - good, we can proceed
    }

    // Create skills directory if it doesn't exist
    await fs.mkdir(workspaceSkillsDir, { recursive: true });

    // Create skill directory
    await fs.mkdir(skillDir, { recursive: true });

    // Write SKILL.md file
    await fs.writeFile(skillFilePath, skillContent, 'utf8');

    console.log(`✅ Installed skill: ${skillName} at ${skillFilePath}`);

    return {
      success: true,
      message: `Skill '${skillName}' installed successfully`,
      path: skillFilePath,
    };
  } catch (error) {
    console.error('Failed to install skill:', error.message);
    return {
      success: false,
      error: error.message,
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
    try {
      const result = await getUsageStats();
      res.writeHead(result.success ? 200 : 500, {
        'Content-Type': 'application/json'
      });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error('Usage endpoint error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return;
  }

  // GET /stats/logs - Get recent logs
  if (req.method === 'GET' && url.pathname === '/stats/logs') {
    try {
      const limit = parseInt(url.searchParams.get('limit') || '100', 10);
      const result = await getRecentLogs(limit);
      res.writeHead(result.success ? 200 : 500, {
        'Content-Type': 'application/json'
      });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error('Logs endpoint error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message, logs: [] }));
    }
    return;
  }

  // GET /stats/sessions - Get session list and stats
  if (req.method === 'GET' && url.pathname === '/stats/sessions') {
    try {
      const result = await getSessionStats();
      res.writeHead(result.success ? 200 : 500, {
        'Content-Type': 'application/json'
      });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error('Sessions endpoint error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message, sessions: [], total: 0 }));
    }
    return;
  }

  // GET /stats/activity - Get activity summary
  if (req.method === 'GET' && url.pathname === '/stats/activity') {
    try {
      const result = await getActivitySummary();
      res.writeHead(result.success ? 200 : 500, {
        'Content-Type': 'application/json'
      });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error('Activity endpoint error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message, activity: { messages: 0, toolCalls: 0, errors: 0, lastActivity: null } }));
    }
    return;
  }

  // GET /stats/cron - Get cron jobs list
  if (req.method === 'GET' && url.pathname === '/stats/cron') {
    try {
      const result = await getCronJobs();
      res.writeHead(result.success ? 200 : 500, {
        'Content-Type': 'application/json'
      });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error('Cron endpoint error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message, jobs: [], total: 0 }));
    }
    return;
  }

  // GET /stats/skills - Get installed skills list
  if (req.method === 'GET' && url.pathname === '/stats/skills') {
    try {
      const result = await getSkillsList();
      res.writeHead(result.success ? 200 : 500, {
        'Content-Type': 'application/json'
      });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error('Skills endpoint error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message, skills: [], total: 0 }));
    }
    return;
  }

  // GET /debug/status - Get raw status output for debugging
  if (req.method === 'GET' && url.pathname === '/debug/status') {
    try {
      const status = await getCachedStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, status }, null, 2));
    } catch (error) {
      console.error('Debug status error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return;
  }

  // GET /debug/config - Get raw config for debugging
  if (req.method === 'GET' && url.pathname === '/debug/config') {
    try {
      const configPath = path.join(STATE_DIR, 'openclaw.json');
      const configContent = await fs.readFile(configPath, 'utf8');
      const config = JSON.parse(configContent);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, config }, null, 2));
    } catch (error) {
      console.error('Debug config error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return;
  }

  // GET /skills/filesystem - List skills from filesystem
  if (req.method === 'GET' && url.pathname === '/skills/filesystem') {
    try {
      const result = await listSkillsFromFilesystem();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error('Filesystem skills error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message, skills: [] }));
    }
    return;
  }

  // POST /skills/install - Install a new skill from SKILL.md content
  if (req.method === 'POST' && url.pathname === '/skills/install') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { skillName, skillContent } = JSON.parse(body);
        const result = await installSkill(skillName, skillContent);
        res.writeHead(result.success ? 200 : 500, {
          'Content-Type': 'application/json'
        });
        res.end(JSON.stringify(result));
      } catch (error) {
        console.error('Install skill error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
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
  console.log(`   GET  /stats/sessions - Get session list (cached)`);
  console.log(`   GET  /stats/activity - Get activity summary`);
  console.log(`   GET  /stats/cron - Get cron jobs list (cached)`);
  console.log(`   GET  /stats/skills - Get installed skills list (cached)`);
  console.log(`   `);
  console.log(`   Skills management:`);
  console.log(`   GET  /skills/filesystem - List skills from filesystem`);
  console.log(`   POST /skills/install - Install new skill (JSON: {skillName, skillContent})`);
  console.log(`   `);
  console.log(`   Debug endpoints:`);
  console.log(`   GET  /debug/status - Get raw openclaw status output`);
  console.log(`   GET  /debug/config - Get raw openclaw.json config`);
  console.log(`   `);
  console.log(`   💾 Status caching with lock (TTL: ${STATUS_CACHE_TTL / 1000}s) - prevents parallel executions`);
  console.log(`   🛡️  Buffer limits: 5MB (status), 2MB (logs/usage) - prevents memory overflow`);
  console.log(`   ⏱️  Timeouts: 10s (all commands) - prevents hanging`);
  console.log(`   `);
  console.log(`   Auth: Bearer ${API_SECRET.substring(0, 10)}...`);
});

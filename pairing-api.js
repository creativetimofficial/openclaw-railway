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
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data, 'utf8')
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
 * Get message statistics by parsing session JSONL files
 * Provides accurate message counts, costs, and token usage per channel
 */
async function getMessageStats() {
  try {
    // Try multiple possible session directory locations
    const possiblePaths = [
      path.join(STATE_DIR, 'agents', 'main', 'sessions'),
      path.join(STATE_DIR, 'sessions'), // Alternative path
      '/data/.openclaw/agents/main/sessions', // Absolute path
    ];

    let sessionsDir = null;
    let sessionsJsonPath = null;

    // Find which path exists
    for (const testPath of possiblePaths) {
      try {
        await fs.access(testPath);
        sessionsDir = testPath;
        sessionsJsonPath = path.join(testPath, 'sessions.json');
        break;
      } catch (error) {
        // Path not found, try next
      }
    }

    // If no sessions directory found
    if (!sessionsDir) {
      return {
        success: true,
        messages: {
          total: 0,
          telegram: 0,
          web: 0,
          assistant: 0
        },
        cost: {
          total: 0,
          telegram: 0,
          web: 0
        },
        tokens: {
          input: 0,
          output: 0,
          total: 0,
          cacheRead: 0,
          cacheWrite: 0
        }
      };
    }

    // List ALL session files for billing (includes active + archived/old sessions)
    let allSessionFiles = [];
    try {
      const files = await fs.readdir(sessionsDir);
      allSessionFiles = files.filter(f => f.endsWith('.jsonl'));
    } catch (listError) {
      // Could not list files
    }

    // Read sessions.json to get session metadata (if available)
    // This maps session keys to session IDs, but we'll process ALL JSONL files for billing
    let sessionsData = {};
    let sessionKeyMap = {}; // Maps sessionId -> sessionKey for channel detection

    try {
      const sessionsContent = await fs.readFile(sessionsJsonPath, 'utf8');
      sessionsData = JSON.parse(sessionsContent);

      // Build reverse map: sessionId -> sessionKey
      for (const [sessionKey, sessionValue] of Object.entries(sessionsData)) {
        let sessionId;
        if (typeof sessionValue === 'string') {
          sessionId = sessionValue;
        } else if (typeof sessionValue === 'object' && sessionValue !== null) {
          sessionId = sessionValue.sessionId || sessionValue.id || sessionValue.key;
        }
        if (sessionId) {
          sessionKeyMap[sessionId] = sessionKey;
        }
      }
    } catch (error) {
      // Continue without sessions.json - we'll still process all JSONL files
    }

    // Initialize counters
    const stats = {
      messages: {
        total: 0,
        telegram: 0,
        web: 0,
        assistant: 0
      },
      cost: {
        total: 0,
        telegram: 0,
        web: 0
      },
      tokens: {
        input: 0,
        output: 0,
        total: 0,
        cacheRead: 0,
        cacheWrite: 0
      },
      toolCalls: 0, // Track tool_use entries
      sessions: {
        total: 0,
        active: 0,
        archived: 0
      }
    };

    // Process ALL session files for complete billing data
    // This includes:
    // - Active sessions (in sessions.json)
    // - Archived/old sessions (stopped but not deleted)

    // Process each JSONL file
    for (const fileName of allSessionFiles) {
      const sessionId = fileName.replace('.jsonl', '');
      const sessionFilePath = path.join(sessionsDir, fileName);

      // Get session key from map (if this is an active session)
      const sessionKey = sessionKeyMap[sessionId] || null;
      const isArchivedSession = !sessionKey;

      // Count sessions
      stats.sessions.total++;
      if (isArchivedSession) {
        stats.sessions.archived++;
      } else {
        stats.sessions.active++;
      }

      // Detect channel from session key (initial guess)
      let channel = 'web'; // default
      if (sessionKey) {
        if (sessionKey.toLowerCase().includes('telegram') || sessionKey.toLowerCase().includes('tg')) {
          channel = 'telegram';
        } else if (sessionKey === 'agent:main:main' || sessionKey.toLowerCase().includes(':main:main')) {
          // "agent:main:main" is the default Telegram session
          channel = 'telegram';
        } else if (sessionKey.toLowerCase().includes('web')) {
          channel = 'web';
        }
      }

      try {
        const content = await fs.readFile(sessionFilePath, 'utf8');
        const lines = content.trim().split('\n').filter(line => line);

        // Try to detect channel from first line (session metadata)
        if (lines.length > 0) {
          try {
            const firstEntry = JSON.parse(lines[0]);
            if (firstEntry.type === 'session') {
              // Check for telegram indicators in session metadata
              const sessionStr = JSON.stringify(firstEntry).toLowerCase();
              if (sessionStr.includes('telegram') || sessionStr.includes('"tg"') || sessionStr.includes('telegram-channel')) {
                channel = 'telegram';
              }
              // Check session key if available
              if (firstEntry.key === 'agent:main:main' || (firstEntry.key && firstEntry.key.includes(':main:main'))) {
                channel = 'telegram';
              }
            }
          } catch (e) {
            // Ignore parse errors on first line
          }
        }

        let sessionMessageCount = 0;

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);

            // Count tool_use entries separately (tool calls)
            if (entry.type === 'tool_use' || entry.type === 'tool_call') {
              stats.toolCalls++;
            }

            // Only count message entries
            if (entry.type === 'message') {
              sessionMessageCount++;
              stats.messages.total++;

              // Count by channel
              if (channel === 'telegram') {
                stats.messages.telegram++;
              } else {
                stats.messages.web++;
              }

              // Count assistant messages separately
              // The message data is nested in entry.message!
              const msg = entry.message || entry;

              // Check multiple possible fields for role detection
              const isAssistant = msg.role === 'assistant' ||
                                  msg.author === 'assistant' ||
                                  msg.role === 'ai' ||
                                  msg.author === 'ai';

              if (isAssistant) {
                stats.messages.assistant++;

                // Extract cost and token data from usage field
                // Usage is in the nested message object
                const usage = msg.usage;

                if (usage) {
                  // Token counts - handle both field name formats
                  // OpenClaw uses: input, output, cacheRead, cacheWrite
                  // Anthropic API uses: input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens
                  const inputTokens = usage.input || usage.input_tokens || 0;
                  const outputTokens = usage.output || usage.output_tokens || 0;
                  const cacheReadTokens = usage.cacheRead || usage.cache_read_input_tokens || 0;
                  const cacheWriteTokens = usage.cacheWrite || usage.cache_creation_input_tokens || 0;

                  stats.tokens.input += inputTokens;
                  stats.tokens.output += outputTokens;
                  stats.tokens.cacheRead += cacheReadTokens;
                  stats.tokens.cacheWrite += cacheWriteTokens;

                  // If cost is already calculated in usage, use it
                  // Cost can be a number OR an object with { input, output, total }
                  let messageCost = 0;
                  if (usage.cost !== undefined && usage.cost !== null) {
                    // Check if cost is an object or a number
                    if (typeof usage.cost === 'object' && usage.cost.total !== undefined) {
                      messageCost = usage.cost.total; // Use pre-calculated total cost
                    } else if (typeof usage.cost === 'number') {
                      messageCost = usage.cost;
                    }
                  }

                  // If no cost provided, calculate using Claude Sonnet 4.5 pricing
                  // Note: Opus 4.6 pricing is $5/$25 per 1M tokens (not currently auto-detected)
                  if (messageCost === 0) {
                    // Claude Sonnet 4.5 pricing (as of 2026-02-14)
                    // Input: $3 per 1M tokens, Output: $15 per 1M tokens
                    // Cache read: $0.30 per 1M tokens, Cache write: $3.75 per 1M tokens
                    const inputCost = inputTokens * 3 / 1000000;
                    const outputCost = outputTokens * 15 / 1000000;
                    const cacheReadCost = cacheReadTokens * 0.30 / 1000000;
                    const cacheWriteCost = cacheWriteTokens * 3.75 / 1000000;
                    messageCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;
                  }

                  stats.cost.total += messageCost;
                  if (channel === 'telegram') {
                    stats.cost.telegram += messageCost;
                  } else {
                    stats.cost.web += messageCost;
                  }
                }
              }
            }
          } catch (parseError) {
            // Skip invalid JSON lines
            continue;
          }
        }

      } catch (fileError) {
        // Session file doesn't exist or can't be read - skip it
        continue;
      }
    }


    // Calculate total tokens
    stats.tokens.total = stats.tokens.input + stats.tokens.output +
                         stats.tokens.cacheRead + stats.tokens.cacheWrite;

    return {
      success: true,
      ...stats
    };
  } catch (error) {
    console.error('Failed to get message stats:', error.message);
    return {
      success: false,
      error: error.message,
      messages: { total: 0, telegram: 0, web: 0, assistant: 0 },
      cost: { total: 0, telegram: 0, web: 0 },
      tokens: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
      toolCalls: 0,
      sessions: { total: 0, active: 0, archived: 0 }
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
 * Category mapping for skills
 */
const SKILL_CATEGORIES = {
  'Communication': ['discord', 'slack', 'telegram', 'imsg', 'bluebubbles'],
  'Development': ['github', 'coding-agent', 'tmux', 'oracle'],
  'Smart Home': ['openhue', 'sonoscli', 'eightctl'],
  'Productivity': ['notion', 'obsidian', 'trello', 'things-mac', 'apple-notes', 'apple-reminders', 'bear-notes'],
  'Entertainment': ['spotify-player', 'songsee', 'gog'],
  'Marketing': ['marketing-psychology', 'blogwatcher'],
  'Media': ['openai-image-gen', 'video-frames', 'nano-pdf', 'gifgrep'],
  'Voice & Audio': ['sag', 'openai-whisper', 'openai-whisper-api', 'sherpa-onnx-tts', 'voice-call'],
  'Security': ['healthcheck', '1password'],
  'Utilities': ['weather', 'skill-creator', 'camsnap', 'peekaboo', 'goplaces', 'local-places', 'food-order', 'ordercli', 'canvas', 'wacli', 'blucli', 'mcporter', 'nano-banana-pro', 'clawhub', 'summarize', 'bird', 'session-logs', 'gemini']
};

const CATEGORY_ICONS = {
  'Communication': '💬',
  'Development': '🛠️',
  'Smart Home': '🏠',
  'Productivity': '📝',
  'Entertainment': '🎮',
  'Marketing': '📈',
  'Media': '🎨',
  'Voice & Audio': '🎙️',
  'Security': '🛡️',
  'Utilities': '⚙️'
};

/**
 * Get category for a skill name
 */
function getSkillCategory(skillName) {
  for (const [category, skills] of Object.entries(SKILL_CATEGORIES)) {
    if (skills.includes(skillName)) {
      return category;
    }
  }
  return 'Utilities'; // Default
}

/**
 * Parse SKILL.md frontmatter
 */
function parseSkillMetadata(content, skillName) {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const metadata = {};

  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    const lines = frontmatter.split('\n');

    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim();
        let value = line.substring(colonIndex + 1).trim();
        // Remove quotes from value if present
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }
        metadata[key] = value;
      }
    }
  }

  return {
    name: metadata.name || skillName,
    description: metadata.description || null
  };
}

/**
 * Read skills from a directory
 */
async function readSkillsFromDir(dirPath) {
  const skills = [];

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = path.join(dirPath, entry.name);
        const skillMdPath = path.join(skillPath, 'SKILL.md');

        try {
          const content = await fs.readFile(skillMdPath, 'utf8');
          const metadata = parseSkillMetadata(content, entry.name);

          skills.push({
            name: metadata.name,
            description: metadata.description,
            dirName: entry.name, // Original directory name for matching
            path: skillPath
          });
        } catch (readError) {
          // Skip directories without SKILL.md
          console.log(`  ⚠️  Skipping ${entry.name} (no SKILL.md or can't read)`);
        }
      }
    }
  } catch (dirError) {
    // Directory doesn't exist - return empty array
    console.log(`  ⚠️  Directory not found: ${dirPath}`);
  }

  return skills;
}

/**
 * List skills from filesystem - OpenClaw architecture
 * Active: /data/workspace/.agents/skills/ (installed)
 * Available: /usr/local/lib/node_modules/openclaw/skills/ (bundled)
 */
async function listSkillsFromFilesystem() {
  try {
    console.log('🔍 Scanning skills directories (OpenClaw architecture)');

    const activeDir = path.join(STATE_DIR, '..', 'workspace', '.agents', 'skills');
    const availableDir = '/usr/local/lib/node_modules/openclaw/skills';

    console.log(`📂 Active skills: ${activeDir}`);
    console.log(`📂 Available skills: ${availableDir}`);

    // Read both directories in parallel
    const [activeSkills, availableSkills] = await Promise.all([
      readSkillsFromDir(activeDir),
      readSkillsFromDir(availableDir)
    ]);

    console.log(`✅ Found ${activeSkills.length} active skills`);
    console.log(`✅ Found ${availableSkills.length} available skills`);

    // Create set of active skill names for deduplication
    const activeSkillNames = new Set(activeSkills.map(s => s.dirName));

    // Build active skills array
    const active = activeSkills.map(skill => {
      const category = getSkillCategory(skill.dirName);
      return {
        name: skill.name,
        description: skill.description,
        location: 'project',
        path: skill.path,
        enabled: true,
        category: category,
        icon: CATEGORY_ICONS[category]
      };
    });

    // Build available skills array (exclude if in active)
    const available = availableSkills
      .filter(skill => !activeSkillNames.has(skill.dirName))
      .map(skill => {
        const category = getSkillCategory(skill.dirName);
        return {
          name: skill.name,
          description: skill.description,
          location: 'bundled',
          path: skill.path,
          enabled: false,
          category: category,
          icon: CATEGORY_ICONS[category]
        };
      });

    // Build categories array
    const categoryCounts = {};
    [...active, ...available].forEach(skill => {
      categoryCounts[skill.category] = (categoryCounts[skill.category] || 0) + 1;
    });

    const categories = Object.entries(categoryCounts).map(([name, count]) => ({
      name,
      count,
      icon: CATEGORY_ICONS[name]
    })).sort((a, b) => b.count - a.count); // Sort by count descending

    console.log(`📋 Categories: ${categories.map(c => `${c.name} (${c.count})`).join(', ')}`);

    return {
      success: true,
      active,
      available,
      categories,
      total: active.length + available.length
    };
  } catch (error) {
    console.error('Failed to list skills from filesystem:', error.message);
    return {
      success: false,
      error: error.message,
      active: [],
      available: [],
      categories: [],
      total: 0
    };
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

  // GET /stats/messages - Get message statistics from session JSONL files
  if (req.method === 'GET' && url.pathname === '/stats/messages') {
    try {
      const result = await getMessageStats();
      res.writeHead(result.success ? 200 : 500, {
        'Content-Type': 'application/json'
      });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error('Messages endpoint error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: error.message,
        messages: { total: 0, telegram: 0, web: 0, assistant: 0 },
        cost: { total: 0, telegram: 0, web: 0 },
        tokens: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 }
      }));
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
  console.log(`   GET  /stats/messages - Get message stats from JSONL files`);
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

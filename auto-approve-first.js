#!/usr/bin/env node
/**
 * Auto-approve first user who sends /start to the bot
 * Monitors for pairing requests and auto-approves the first one
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');

const execAsync = promisify(exec);

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || '/data/.openclaw';
const FIRST_USER_FILE = path.join(STATE_DIR, 'first-approved-user.json');
const CHECK_INTERVAL = 3000; // Check every 3 seconds

let isApproving = false;

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
 * Get pending pairing requests
 */
async function getPendingPairings() {
  try {
    const { stdout } = await execAsync('openclaw pairing list telegram --json');
    const data = JSON.parse(stdout);
    return data.pending || [];
  } catch (error) {
    console.error('Failed to get pairing list:', error.message);
    return [];
  }
}

/**
 * Auto-approve a pairing code
 */
async function approvePairing(code) {
  try {
    await execAsync(`openclaw pairing approve telegram ${code}`);
    return true;
  } catch (error) {
    console.error('Failed to approve pairing:', error.message);
    return false;
  }
}

/**
 * Store first approved user info
 */
async function storeFirstUser(userInfo) {
  try {
    const data = {
      userId: userInfo.userId,
      username: userInfo.username || null,
      firstName: userInfo.firstName || null,
      code: userInfo.code,
      approvedAt: new Date().toISOString(),
    };
    await fs.writeFile(FIRST_USER_FILE, JSON.stringify(data, null, 2));
    console.log('✅ First user info stored:', data);
  } catch (error) {
    console.error('Failed to store first user:', error.message);
  }
}

/**
 * Main monitoring loop
 */
async function monitorAndApprove() {
  // Check if we've already auto-approved someone
  if (await hasAutoApproved()) {
    console.log('ℹ️  First user already auto-approved, exiting monitor');
    process.exit(0);
    return;
  }

  console.log('👀 Monitoring for first pairing request...');

  const interval = setInterval(async () => {
    if (isApproving) return; // Skip if already processing

    try {
      // Check if we've been approved while we were checking
      if (await hasAutoApproved()) {
        console.log('✅ First user auto-approved, stopping monitor');
        clearInterval(interval);
        process.exit(0);
        return;
      }

      const pending = await getPendingPairings();

      if (pending.length > 0) {
        isApproving = true;
        const firstRequest = pending[0];

        console.log('🎯 Found first pairing request:', firstRequest);
        console.log(`   User ID: ${firstRequest.userId}`);
        console.log(`   Code: ${firstRequest.code}`);
        console.log(`   Username: ${firstRequest.username || 'N/A'}`);

        // Approve the first user
        const approved = await approvePairing(firstRequest.code);

        if (approved) {
          console.log('✅ Auto-approved first user!');
          await storeFirstUser(firstRequest);
          clearInterval(interval);
          process.exit(0);
        } else {
          console.error('❌ Failed to auto-approve, will retry...');
          isApproving = false;
        }
      }
    } catch (error) {
      console.error('Error in monitor loop:', error.message);
      isApproving = false;
    }
  }, CHECK_INTERVAL);
}

// Start monitoring
console.log('🚀 Starting first-user auto-approval monitor...');
monitorAndApprove();

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('📴 Shutting down monitor...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('📴 Shutting down monitor...');
  process.exit(0);
});

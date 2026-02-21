import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getScraperState, clearScraperPid, setScraperPid } from '../database/queries';
import { validateConfig } from '../config';
import { logger } from '../logger';

export interface AgentStatus {
  running: boolean;
  pid: number | null;
  lastRunAt: Date;
  lastSuccessAt: Date | null;
  errorCount: number;
  isRunningCycle: boolean;
}

/**
 * Checks if a process with the given PID is alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the current status of the scraper agent, probing the PID for liveness.
 * Automatically cleans up stale PIDs from crashed processes.
 */
export async function getAgentStatus(): Promise<AgentStatus> {
  const state = await getScraperState();

  let running = false;
  let pid = state.pid;

  if (pid !== null) {
    if (isProcessAlive(pid)) {
      running = true;
    } else {
      // Process died unexpectedly — clean up stale PID
      logger.warn('Scraper agent PID is stale, cleaning up', { stalePid: pid });
      await clearScraperPid();
      pid = null;
    }
  }

  return {
    running,
    pid,
    lastRunAt: state.lastRunAt,
    lastSuccessAt: state.lastSuccessAt,
    errorCount: state.errorCount,
    isRunningCycle: state.isRunning,
  };
}

/**
 * Spawns the scraper agent as a detached child process.
 * The agent writes its own PID to the database on startup.
 */
export async function startAgent(): Promise<{ pid: number }> {
  const status = await getAgentStatus();
  if (status.running) {
    throw new Error('Agent is already running');
  }

  // Validate config before spawning
  const { valid, errors } = validateConfig();
  if (!valid) {
    throw new Error(`Configuration invalid: ${errors.join(', ')}`);
  }

  const agentScript = path.resolve('./src/scraper-agent.ts');
  const logsDir = path.resolve('./logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  const agentLogPath = path.join(logsDir, 'agent.log');
  const logFd = fs.openSync(agentLogPath, 'a');

  const child = spawn('npx', ['tsx', agentScript], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: path.resolve('.'),
    env: { ...process.env },
  });

  fs.closeSync(logFd);

  child.unref();

  const pid = child.pid;
  if (!pid) {
    throw new Error('Failed to spawn agent process');
  }

  // Write PID to DB immediately so status checks and duplicate-start guards work
  // before the agent process has finished initializing.
  await setScraperPid(pid);

  // Wait briefly and verify the process is alive
  await new Promise((r) => setTimeout(r, 500));

  if (!isProcessAlive(pid)) {
    await clearScraperPid();
    throw new Error('Agent process died immediately after spawn. Check logs for errors.');
  }

  logger.info('Scraper agent started', { pid });
  return { pid };
}

/**
 * Sends SIGTERM to the running scraper agent and waits for it to exit.
 * Falls back to SIGKILL after 15 seconds.
 */
export async function stopAgent(): Promise<void> {
  const state = await getScraperState();
  const pid = state.pid;

  if (pid === null) {
    return; // Nothing to stop
  }

  if (!isProcessAlive(pid)) {
    // Already dead — just clean up DB
    await clearScraperPid();
    return;
  }

  // Send SIGTERM to the process group (negative PID) since the agent is detached
  // and spawned via npx which creates child processes.
  logger.info('Sending SIGTERM to scraper agent', { pid });
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // Try direct PID if process group kill fails
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process already gone
      await clearScraperPid();
      return;
    }
  }

  // Wait up to 15 seconds for graceful shutdown
  const maxWaitMs = 15_000;
  const pollMs = 500;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (!isProcessAlive(pid)) {
      logger.info('Scraper agent stopped gracefully', { pid });
      await clearScraperPid();
      return;
    }
  }

  // Force kill as last resort
  logger.warn('Scraper agent did not exit in time, sending SIGKILL', { pid });
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone */ }
  }

  await clearScraperPid();
}

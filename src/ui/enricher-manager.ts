import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getEnricherState, clearEnricherPid } from '../database/enrichment-queries';
import { validateConfig } from '../config';
import { logger } from '../logger';

export interface EnricherAgentStatus {
  running: boolean;
  pid: number | null;
  lastRunAt: Date;
  lastSuccessAt: Date | null;
  errorCount: number;
  isProcessing: boolean;
  totalEnriched: number;
  totalFailed: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the current status of the enricher agent, probing the PID for liveness.
 */
export async function getEnricherStatus(): Promise<EnricherAgentStatus> {
  const state = await getEnricherState();

  let running = false;
  let pid = state.pid;

  if (pid !== null) {
    if (isProcessAlive(pid)) {
      running = true;
    } else {
      logger.warn('Enricher agent PID is stale, cleaning up', { stalePid: pid });
      await clearEnricherPid();
      pid = null;
    }
  }

  return {
    running,
    pid,
    lastRunAt: state.lastRunAt,
    lastSuccessAt: state.lastSuccessAt,
    errorCount: state.errorCount,
    isProcessing: state.isProcessing,
    totalEnriched: state.totalEnriched,
    totalFailed: state.totalFailed,
  };
}

/**
 * Spawns the enricher agent as a detached child process.
 */
export async function startEnricher(): Promise<{ pid: number }> {
  const status = await getEnricherStatus();
  if (status.running) {
    throw new Error('Enricher is already running');
  }

  const { valid, errors } = validateConfig();
  if (!valid) {
    throw new Error(`Configuration invalid: ${errors.join(', ')}`);
  }

  const agentScript = path.resolve('./src/enricher-agent.ts');
  const logsDir = path.resolve('./logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  const logPath = path.join(logsDir, 'enricher.log');
  const logFd = fs.openSync(logPath, 'a');

  const child = spawn('npx', ['tsx', agentScript], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: path.resolve('.'),
    env: { ...process.env },
    shell: true,
  });

  fs.closeSync(logFd);
  child.unref();

  const pid = child.pid;
  if (!pid) {
    throw new Error('Failed to spawn enricher process');
  }

  await new Promise((r) => setTimeout(r, 1500));

  if (!isProcessAlive(pid)) {
    throw new Error('Enricher process died immediately after spawn. Check logs/enricher.log for errors.');
  }

  logger.info('Enricher agent started', { pid });
  return { pid };
}

/**
 * Sends SIGTERM to the running enricher agent and waits for it to exit.
 */
export async function stopEnricher(): Promise<void> {
  const state = await getEnricherState();
  const pid = state.pid;

  if (pid === null) return;

  if (!isProcessAlive(pid)) {
    await clearEnricherPid();
    return;
  }

  logger.info('Sending SIGTERM to enricher agent', { pid });
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      await clearEnricherPid();
      return;
    }
  }

  const maxWaitMs = 15_000;
  const pollMs = 500;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (!isProcessAlive(pid)) {
      logger.info('Enricher agent stopped gracefully', { pid });
      await clearEnricherPid();
      return;
    }
  }

  logger.warn('Enricher agent did not exit in time, sending SIGKILL', { pid });
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone */ }
  }

  await clearEnricherPid();
}

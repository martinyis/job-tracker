import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

let filterPid: number | null = null;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getApplicantFilterStatus(): { running: boolean; pid: number | null } {
  if (filterPid !== null && !isProcessAlive(filterPid)) {
    filterPid = null;
  }
  return { running: filterPid !== null, pid: filterPid };
}

export function startApplicantFilter(): { pid: number } {
  const status = getApplicantFilterStatus();
  if (status.running) {
    throw new Error('Applicant filter is already running');
  }

  const agentScript = path.resolve('./src/applicant-filter-agent.ts');
  const logsDir = path.resolve('./logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  const logPath = path.join(logsDir, 'applicant-filter.log');

  // Truncate log file for each new run so it's clean
  fs.writeFileSync(logPath, '');
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
    throw new Error('Failed to spawn applicant filter process');
  }

  filterPid = pid;
  logger.info('Applicant filter started', { pid });
  return { pid };
}

export async function stopApplicantFilter(): Promise<void> {
  if (filterPid === null) return;

  if (!isProcessAlive(filterPid)) {
    filterPid = null;
    return;
  }

  logger.info('Sending SIGTERM to applicant filter', { pid: filterPid });
  try {
    process.kill(-filterPid, 'SIGTERM');
  } catch {
    try {
      process.kill(filterPid, 'SIGTERM');
    } catch {
      filterPid = null;
      return;
    }
  }

  const maxWaitMs = 15_000;
  const pollMs = 500;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (!isProcessAlive(filterPid)) {
      logger.info('Applicant filter stopped gracefully', { pid: filterPid });
      filterPid = null;
      return;
    }
  }

  logger.warn('Applicant filter did not exit in time, sending SIGKILL', { pid: filterPid });
  try {
    process.kill(-filterPid, 'SIGKILL');
  } catch {
    try { process.kill(filterPid, 'SIGKILL'); } catch { /* Already gone */ }
  }

  filterPid = null;
}

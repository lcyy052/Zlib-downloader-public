import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Detached from the launching terminal. Never auto-resume or auto-restart jobs.
export async function launchBackgroundProcess({ command = process.execPath, args, cwd, logDirectory, env = process.env }) {
  mkdirSync(logDirectory, { recursive: true });
  const name = `service-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const stdout = path.join(logDirectory, `${name}.stdout.log`);
  const stderr = path.join(logDirectory, `${name}.stderr.log`);
  const handles = [];
  try {
    handles.push(openSync(stdout, 'wx'));
    handles.push(openSync(stderr, 'wx'));
    const child = spawn(command, args, { cwd, env, detached: true, windowsHide: true, stdio: ['ignore', ...handles] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return { pid: child.pid, stdout, stderr };
  } finally { for (const handle of handles) closeSync(handle); }
}

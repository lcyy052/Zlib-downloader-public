import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

export function safeDiagnosticError(error) {
  const clean = value => String(value || '').replace(/https?:\/\/[^\s)"']+/gi, '<redacted-url>').replace(/(authorization|cookie|password|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>').slice(0, 3000);
  return { name: clean(error?.name), code: clean(error?.code), message: clean(error?.message), stack: clean(error?.stack) };
}

export function startRuntimeDiagnostics({ directory, getStatus = () => ({}), intervalMs = 60000 }) {
  const file = path.join(directory, 'runtime.jsonl');
  const record = (event, details = {}) => {
    try {
      mkdirSync(directory, { recursive: true });
      if (statSync(file, { throwIfNoEntry: false })?.size > 2 * 1024 * 1024) renameSync(file, `${file}.1`);
      let status; try { status = getStatus(); } catch { status = { unavailable: true }; }
      appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, uptime: Math.round(process.uptime()), memory: process.memoryUsage(), status, ...details }) + '\n');
    } catch { /* Logging failure must not become another process failure. */ }
  };
  const fatal = (error, origin) => record('fatal', { origin, error: safeDiagnosticError(error) });
  const warning = error => record('warning', { error: safeDiagnosticError(error) });
  const exit = code => record('exit', { code });
  // Monitor only: do not suppress Node's default termination after a fatal error.
  process.on('uncaughtExceptionMonitor', fatal); process.on('warning', warning); process.on('exit', exit);
  const timer = setInterval(() => record('heartbeat'), intervalMs); timer.unref();
  record('starting', { node: process.version });
  return { record, file, close() { clearInterval(timer); process.off('uncaughtExceptionMonitor', fatal); process.off('warning', warning); process.off('exit', exit); } };
}

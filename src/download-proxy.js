import * as http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const loopback = 'localhost,127.0.0.1,::1';
const value = (env, name) => String(env[name.toLowerCase()] || env[name] || '').trim();

export function normalizeProxy(raw) {
  if (!raw) return '';
  const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.search || url.hash || (url.pathname && url.pathname !== '/')) throw new Error('Unsupported proxy');
  return url.href;
}

export function parseWindowsProxy(output) {
  const enabled = Number.parseInt(output.match(/^\s*ProxyEnable\s+REG_DWORD\s+0x([\da-f]+)/im)?.[1] || '0', 16) === 1;
  const raw = output.match(/^\s*ProxyServer\s+REG_SZ\s+([^\r\n]+)/im)?.[1]?.trim() || '';
  const pac = Boolean(output.match(/^\s*AutoConfigURL\s+REG_SZ\s+\S/im));
  if (!enabled || !raw) return { http: '', https: '', pac };
  if (!raw.includes('=')) return { http: normalizeProxy(raw), https: normalizeProxy(raw), pac };
  const entries = Object.fromEntries(raw.split(';').map(entry => entry.trim().split('=')).filter(entry => entry.length === 2));
  return { http: normalizeProxy(entries.http), https: normalizeProxy(entries.https), pac };
}

export async function readWindowsProxy() {
  const { stdout } = await runFile('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024 });
  return parseWindowsProxy(stdout);
}

// Application-process only. Do not change registry, user environment or TLS checks.
export async function configureDownloadProxy({ env = process.env, platform = process.platform, readSystemProxy = readWindowsProxy, applyProxy = http.setGlobalProxyFromEnv } = {}) {
  if (env.NODE_USE_ENV_PROXY === '0') return { active: false, source: 'disabled', message: 'Node 网络代理已由环境显式禁用；Chrome 回退仍可使用。' };
  let proxies, source;
  try {
    const explicit = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].some(name => value(env, name));
    if (explicit) {
      const common = value(env, 'ALL_PROXY');
      proxies = { http: normalizeProxy(value(env, 'HTTP_PROXY') || common), https: normalizeProxy(value(env, 'HTTPS_PROXY') || common) };
      source = 'environment';
    } else if (platform === 'win32') {
      proxies = await readSystemProxy(); source = 'windows';
    } else return { active: false, source: 'direct', message: 'Node 文件传输使用直连网络。' };
  } catch {
    return { active: false, source: 'unsupported', message: '未能读取可用的 HTTP/HTTPS 代理，保留 Chrome 回退；不更改系统代理。' };
  }
  if (!proxies.http && !proxies.https) return { active: false, source: 'direct', message: proxies.pac ? '系统使用 PAC 自动代理，Node 暂不解析 PAC；需要时使用 Chrome 回退。' : 'Node 文件传输使用直连网络。' };
  if (typeof applyProxy !== 'function') return { active: false, source, message: '当前 Node 缺少动态代理接口，使用 Chrome 回退；建议升级 Node 24.14 或更新版本。' };
  const bypass = [value(env, 'NO_PROXY'), loopback].filter(Boolean).join(',');
  try { applyProxy({ http_proxy: proxies.http, https_proxy: proxies.https, no_proxy: bypass }); }
  catch { return { active: false, source, message: 'Node 代理初始化失败，保留 Chrome 回退。' }; }
  return { active: true, source, message: source === 'windows' ? 'Node 文件传输已使用现有 Windows 系统代理；本地服务不经过代理。' : 'Node 文件传输已使用显式环境代理；本地服务不经过代理。' };
}

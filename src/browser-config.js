import path from 'node:path';
import { access } from 'node:fs/promises';

export function browserPreference(value = 'chrome') {
  if (!['chrome', 'edge', 'auto'].includes(value)) throw new Error('请选择 Chrome、Edge 或自动选择浏览器');
  return value;
}

export function browserCandidates(preference = 'chrome', env = process.env) {
  browserPreference(preference);
  const chrome = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean).map(executablePath => ({ executablePath, name: 'Chrome', profile: 'browser-profile-chrome' }));
  const edge = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft/Edge/Application/msedge.exe'),
    '/usr/bin/microsoft-edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ].filter(Boolean).map(executablePath => ({ executablePath, name: 'Edge', profile: 'browser-profile' }));
  if (env.BROWSER_PATH) return [{ executablePath: env.BROWSER_PATH, name: '自定义浏览器', profile: 'browser-profile-custom' }];
  return preference === 'chrome' ? chrome : preference === 'edge' ? edge : [...chrome, ...edge];
}

export async function resolveBrowser(preference, { env = process.env, exists = access } = {}) {
  for (const candidate of browserCandidates(preference, env)) {
    try { await exists(candidate.executablePath); return candidate; } catch {}
  }
  throw new Error(env.BROWSER_PATH ? 'BROWSER_PATH 指定的浏览器不存在，请检查路径' : `未找到${preference === 'edge' ? ' Edge' : preference === 'chrome' ? ' Chrome' : ' Chrome 或 Edge'}，请安装浏览器或在站点设置中更改浏览器选择`);
}

export function pageAccessProblem(title, body, url) {
  if (/access denied|forbidden|diamwall/i.test(title) || /^\s*(access denied|forbidden)\b/i.test(body)) return { code: 'SITE_ACCESS_DENIED', message: '网站拒绝访问，已保留当前浏览器页面。请查看页面提示；若普通 Chrome 也无法访问，需先确认站点或网络可用性。' };
  if (/just a moment|checking your browser|verify you are human|attention required|验证您是真人|安全验证/i.test(`${title}\n${body}`)) return { code: 'SITE_VERIFICATION_REQUIRED', message: '网站需要浏览器验证，已保留当前页面。请在 Chrome / Edge 中手动完成，保持窗口打开，然后重试。' };
  if (/\/login(?:[/?]|$)/.test(new URL(url).pathname)) return { code: 'LOGIN_REQUIRED', message: '网站要求登录，已保留登录页面。请在工具打开的浏览器中完成登录，然后重试。' };
  return null;
}

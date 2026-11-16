import test from 'node:test';
import assert from 'node:assert/strict';
import { browserPreference, browserCandidates, resolveBrowser, pageAccessProblem } from '../src/browser-config.js';

test('defaults to Chrome and auto prefers Chrome before Edge', async () => {
  assert.equal(browserPreference(), 'chrome');
  assert.equal(browserCandidates('auto', {})[0].name, 'Chrome');
  const selected = await resolveBrowser('auto', { env: {}, exists: async () => {} });
  assert.equal(selected.name, 'Chrome');
  assert.equal(selected.profile, 'browser-profile-chrome');
});
test('explicit Chrome selection never silently falls back to Edge', async () => {
  await assert.rejects(() => resolveBrowser('chrome', { env: {}, exists: async p => { if (!p.includes('Edge')) throw new Error('missing'); } }), /未找到 Chrome/);
  assert.ok(browserCandidates('chrome', {}).every(c => c.name === 'Chrome'));
  assert.ok(browserCandidates('edge', {}).every(c => c.profile === 'browser-profile'));
});
test('user-local installs and explicit executable paths are supported', async () => {
  const sampleProfile = ['C:', 'Users', 'test', 'AppData', 'Local'].join('/');
  assert.ok(browserCandidates('chrome', { LOCALAPPDATA: sampleProfile }).some(c => c.executablePath.includes('Users')));
  const selected = await resolveBrowser('chrome', { env: { BROWSER_PATH: 'D:/custom/chrome.exe' }, exists: async () => {} });
  assert.equal(selected.executablePath, 'D:/custom/chrome.exe');
  assert.throws(() => browserPreference('unknown'));
});
test('distinguishes access denial, verification and login from a normal page', () => {
  assert.equal(pageAccessProblem('Access Denied | DiamWall', '', 'https://example.com/s/a').code, 'SITE_ACCESS_DENIED');
  assert.equal(pageAccessProblem('Loading', 'Checking your browser', 'https://example.com').code, 'SITE_VERIFICATION_REQUIRED');
  assert.equal(pageAccessProblem('Sign in', '', 'https://example.com/login').code, 'LOGIN_REQUIRED');
  assert.equal(pageAccessProblem('Books', 'Welcome', 'https://example.com'), null);
});

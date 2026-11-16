import path from 'node:path';
import { mkdir, readdir, stat } from 'node:fs/promises';

function transferBase(name) {
  return name.endsWith('.crdownload') ? name.slice(0, -'.crdownload'.length) : name;
}

export async function createDownloadProgress(dataDir, { pollMs = 250 } = {}) {
  const downloadPath = path.join(dataDir, 'transfers');
  await mkdir(downloadPath, { recursive: true });
  const activeStops = new Set(), claimedBases = new Set();
  return {
    async observe(onProgress) {
      const before = new Set((await readdir(downloadPath, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name));
      let stopped = false, timer, activeBase = '', lastBytes = -1, lastState = '';
      const stop = async () => { stopped = true; clearTimeout(timer); if (activeBase) claimedBases.delete(activeBase); activeStops.delete(stop); };
      activeStops.add(stop);
      const poll = async () => {
        if (stopped) return;
        try {
          const entries = (await readdir(downloadPath, { withFileTypes: true })).filter(entry => entry.isFile());
          const files = await Promise.all(entries.map(async entry => ({ name: entry.name, info: await stat(path.join(downloadPath, entry.name)) })));
          if (!activeBase) {
            const fresh = files.filter(file => !before.has(file.name) && !claimedBases.has(transferBase(file.name))).sort((a, b) => a.info.mtimeMs - b.info.mtimeMs);
            if (fresh[0]) { activeBase = transferBase(fresh[0].name); claimedBases.add(activeBase); }
          }
          if (activeBase) {
            const matching = files.filter(file => transferBase(file.name) === activeBase);
            const current = matching.find(file => file.name.endsWith('.crdownload')) || matching.find(file => file.name === activeBase);
            if (current) {
              const state = current.name.endsWith('.crdownload') ? 'inProgress' : 'saving';
              if (current.info.size !== lastBytes || state !== lastState) {
                lastBytes = current.info.size; lastState = state;
                onProgress({ state, message: state === 'saving' ? '传输完成，正在保存…' : '正在传输文件…', receivedBytes: current.info.size, totalBytes: 0, percent: null });
              }
            }
          }
        } catch {
          // Progress is best-effort. Playwright remains the source of truth for completion.
        }
        if (!stopped) { timer = setTimeout(poll, pollMs); timer.unref?.(); }
      };
      timer = setTimeout(poll, 0); timer.unref?.();
      return stop;
    },
    async close() { await Promise.all([...activeStops].map(stop => stop())); },
  };
}

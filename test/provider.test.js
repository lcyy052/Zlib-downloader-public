import test from 'node:test';
import assert from 'node:assert/strict';
import { LibraryProvider } from '../src/provider.js';

function provider() {
  return new LibraryProvider({
    getSettings: () => ({ browserMode: 'background' }),
    dataDir: '.',
    demo: false,
  });
}

test('Chrome fallback transfers are serialized', async () => {
  const library = provider();
  let active = 0;
  let peak = 0;
  const order = [];
  const transfer = id => library.runBrowserTransfer(async () => {
    active++;
    peak = Math.max(peak, active);
    order.push(`start-${id}`);
    await new Promise(resolve => setTimeout(resolve, 15));
    order.push(`end-${id}`);
    active--;
    return id;
  });

  assert.deepEqual(await Promise.all([transfer(1), transfer(2), transfer(3)]), [1, 2, 3]);
  assert.equal(peak, 1);
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
});

test('a failed Chrome fallback does not block the next transfer', async () => {
  const library = provider();
  await assert.rejects(library.runBrowserTransfer(async () => { throw new Error('first failed'); }), /first failed/);
  assert.equal(await library.runBrowserTransfer(async () => 'second completed'), 'second completed');
});

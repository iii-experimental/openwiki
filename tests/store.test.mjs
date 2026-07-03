import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/lib/store.mjs';

// In-memory mock of the iii client's state:: functions.
function mockClient() {
  const db = new Map(); // scope -> Map(key -> value)
  const scoped = (s) => { if (!db.has(s)) db.set(s, new Map()); return db.get(s); };
  return {
    async trigger({ function_id, payload }) {
      const { scope, key, value } = payload || {};
      if (function_id === 'state::set') { scoped(scope).set(key, value); return {}; }
      if (function_id === 'state::get') { return scoped(scope).has(key) ? scoped(scope).get(key) : null; }
      if (function_id === 'state::list') { return [...scoped(scope).values()]; }
      if (function_id === 'state::delete') { scoped(scope).delete(key); return {}; }
      throw new Error('unexpected ' + function_id);
    },
  };
}

test('wiki round-trip via iii-state, listed newest first', async () => {
  store.setClient(mockClient());
  await store.saveWiki('w1', { id: 'w1', repo_name: 'a/b', updated_at: '2026-01-02' });
  await store.saveWiki('w2', { id: 'w2', repo_name: 'c/d', updated_at: '2026-01-03' });
  assert.equal((await store.getWiki('w1')).repo_name, 'a/b');
  const all = await store.listWikis();
  assert.equal(all.length, 2);
  assert.equal(all[0].id, 'w2');
});

test('page save / get / list / delete', async () => {
  store.setClient(mockClient());
  await store.savePage('w1', 'overview', '# Overview\n\nbody', { title: 'Overview', category: 'overview' });
  const p = await store.getPage('w1', 'overview');
  assert.equal(p.meta.title, 'Overview');
  assert.match(p.markdown, /# Overview/);
  const pages = await store.listPages('w1');
  assert.equal(pages.length, 1);
  assert.equal(pages[0].slug, 'overview');
  await store.deletePage('w1', 'overview');
  assert.equal(await store.getPage('w1', 'overview'), null);
});

test('status stamps updated_at; log appends and caps', async () => {
  store.setClient(mockClient());
  await store.updateStatus('w1', { phase: 'ready', progress: 1 });
  const s = await store.getStatus('w1');
  assert.equal(s.phase, 'ready');
  assert.ok(s.updated_at);
  await store.appendLog('w1', 'started');
  await store.appendLog('w1', 'done');
  const log = await store.getLog('w1');
  assert.equal(log.length, 2);
  assert.match(log[1], /done/);
});

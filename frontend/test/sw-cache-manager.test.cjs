const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Minimal CacheStorage adapter: production code still uses the browser's real API.
function setup() {
  const stores = new Map();
  const caches = {
    async open(name) {
      if (!stores.has(name)) {
        const entries = new Map();
        stores.set(name, {
          async keys() { return [...entries.keys()].map(url => new Request(url)); },
          async match(request) { return entries.get(request.url || request)?.clone(); },
          async put(request, response) { entries.set(request.url || request, response.clone()); },
          async delete(request) { return entries.delete(request.url || request); },
        });
      }
      return stores.get(name);
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  let now = 100000;
  const context = vm.createContext({ caches, Request, Response, Headers, URL, console, Date: { now: () => now }, self: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../sw-cache-manager.js'), 'utf8'), context);
  const manager = context.self.swCacheManager;
  manager.__BUILD_REV = 'regression';
  return { manager, caches, context, advance: ms => { now += ms; } };
}
const request = name => new Request(`https://photonix.test/${name}`);

test('thumbnail retries share a cached image while content revisions remain distinct', async () => {
  const { manager } = setup();
  await manager.putWithLRU('thumbnail', request('api/thumbnail?path=album%2Fphoto.jpg&v=1&_t=100'), new Response('image'));
  const cached = await manager.matchWithLRU('thumbnail', request('api/thumbnail?path=album%2Fphoto.jpg&v=1&_t=200&_sse=refresh'));
  assert.equal(await cached.text(), 'image');
  assert.equal(await manager.matchWithLRU('thumbnail', request('api/thumbnail?path=album%2Fphoto.jpg&v=2')), undefined);
});

test('stores a cloned response with TTL without consuming the network response', async () => {
  const { manager, caches } = setup();
  const response = new Response('gallery', { headers: { 'content-type': 'application/json' } });
  await manager.putWithLRU('api', request('browse'), response, { maxAgeMs: 1000 });
  assert.equal(await response.text(), 'gallery');
  const cached = await (await caches.open('api-regression')).match(request('browse'));
  assert.equal(await cached.text(), 'gallery');
  assert.equal(cached.headers.get('x-cache-expires-at'), '101000');
  assert.equal(cached.headers.get('content-type'), 'application/json');
});

test('reads refresh LRU recency without extending TTL; expired entries miss', async () => {
  const { manager, caches, advance } = setup();
  await manager.putWithLRU('api', request('a'), new Response('A'), { maxAgeMs: 100 });
  advance(50);
  assert.equal(await (await manager.matchWithLRU('api', request('a'))).text(), 'A');
  advance(51);
  assert.equal(await manager.matchWithLRU('api', request('a')), undefined);
  assert.equal((await (await caches.open('api-regression')).keys()).length, 0);
});

test('evicts the least recently read entry and preserves other cache namespaces', async () => {
  const { manager, caches, advance } = setup();
  await manager.putWithLRU('api', request('a'), new Response('A'));
  advance(1);
  await manager.putWithLRU('api', request('b'), new Response('B'));
  advance(1);
  await manager.matchWithLRU('api', request('a'));
  const unrelated = await caches.open('another-app');
  await unrelated.put(request('untouched'), new Response('keep'));
  await manager.performLRUCleanup('api-regression', { MAX_ENTRIES: 1, MAX_AGE_MS: 10000 });
  const cache = await caches.open('api-regression');
  assert.ok(await cache.match(request('a')));
  assert.equal(await cache.match(request('b')), undefined);
  assert.equal(await (await unrelated.match(request('untouched'))).text(), 'keep');
});

test('never stores pending thumbnails, partial responses, writes, or no-store data', async () => {
  const { manager, caches } = setup();
  for (const status of [202, 206, 401, 403, 500]) {
    assert.equal(await manager.putWithLRU('thumbnail', request(`status-${status}`), new Response('pending', { status })), false);
  }
  assert.equal(await manager.putWithLRU('api', new Request('https://photonix.test/write', { method: 'POST' }), new Response('write')), false);
  assert.equal(await manager.putWithLRU('api', request('private'), new Response('secret', { headers: { 'cache-control': 'no-store' } })), false);
  assert.equal(await manager.putWithLRU('api', request('cookie-private'), new Response('secret', { headers: { 'cache-control': 'private' } })), false);
  assert.deepEqual(await caches.keys(), []);
});

test('LRU recency stays ordered when several accesses share a millisecond', async () => {
  const { manager, caches } = setup();
  await manager.putWithLRU('api', request('a'), new Response('A'));
  await manager.putWithLRU('api', request('b'), new Response('B'));
  await manager.matchWithLRU('api', request('a'));
  await manager.performLRUCleanup('api-regression', { MAX_ENTRIES: 1, MAX_AGE_MS: 10000 });
  const cache = await caches.open('api-regression');
  assert.ok(await cache.match(request('a')));
  assert.equal(await cache.match(request('b')), undefined);
});

test('unavailable cache storage does not break the network response', async () => {
  const { manager, caches } = setup();
  caches.open = async () => { throw new Error('quota exhausted'); };
  const response = new Response('still usable online');
  assert.equal(await manager.putWithLRU('api', request('browse'), response), false);
  assert.equal(await response.text(), 'still usable online');
  assert.equal(await manager.matchWithLRU('api', request('browse')), undefined);
});

test('different injected build manifests produce different cache namespaces', () => {
  const names = ['first', 'second'].map(revision => {
    const { context } = setup();
    context.self.__WB_MANIFEST = [{ url: '/index.html', revision }];
    context.self.addEventListener = () => {};
    context.importScripts = () => {};
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../sw-src.js'), 'utf8'), context);
    return context.self.swCacheManager.getCacheNameForType('static');
  });
  assert.notEqual(names[0], names[1]);
});

test('authenticated buckets stay isolated and cleanup reaches current API buckets', async () => {
  const { manager, caches, advance } = setup();
  const options = user => ({ cacheName: `api-regression-auth-${user}`, maxAgeMs: 10 });
  await manager.putWithLRU('api', request('browse'), new Response('Alice', { headers: { 'cache-control': 'private' } }), options('alice'));
  await manager.putWithLRU('api', request('browse'), new Response('Bob'), options('bob'));
  assert.equal(await (await manager.matchWithLRU('api', request('browse'), options('alice'))).text(), 'Alice');
  await assert.rejects(manager.putWithLRU('api', request('browse'), new Response('bad'), { cacheName: 'another-app' }));
  const old = await caches.open('api-old-build');
  await old.put(request('keep'), new Response('old'));
  advance(11);
  await manager.manualCleanup('api');
  assert.equal((await (await caches.open(options('alice').cacheName)).keys()).length, 0);
  assert.equal((await (await caches.open(options('bob').cacheName)).keys()).length, 0);
  assert.ok(await old.match(request('keep')));
});

test('concurrent writes honor the configured entry limit', async () => {
  const { manager, caches } = setup();
  await Promise.all(Array.from({ length: 105 }, (_, i) => manager.putWithLRU('static', request(`asset-${i}`), new Response(String(i)))));
  assert.equal((await (await caches.open('static-regression')).keys()).length, 100);
});

test('service worker imports the manager and gives each authentication token a separate bucket', () => {
  const { context } = setup();
  context.self.addEventListener = () => {};
  context.importScripts = script => {
    if (script === '/sw-cache-manager.js') return;
    throw new Error('External Workbox is unavailable in the isolated regression test');
  };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../sw-src.js'), 'utf8'), context);
  const alice = context.getApiCacheContext(new Request('https://photonix.test/api/browse', { headers: { Authorization: 'Bearer alice-token' } }), null, true, 'browse');
  const bob = context.getApiCacheContext(new Request('https://photonix.test/api/browse', { headers: { Authorization: 'Bearer bob-token' } }), null, true, 'browse');
  assert.notEqual(alice.cacheName, bob.cacheName);
  assert.equal(alice.ttlMs, 30000);
  assert.equal(context.getApiCacheContext(new Request('https://photonix.test/api/settings', { method: 'POST' }), null, false), null);
});

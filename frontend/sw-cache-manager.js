/* Classic script loaded by sw-src.js through importScripts. */
(() => {
  'use strict';

  const CONFIG = Object.freeze({
    static: Object.freeze({ MAX_ENTRIES: 100, MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000 }),
    api: Object.freeze({ MAX_ENTRIES: 500, MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000 }),
    media: Object.freeze({ MAX_ENTRIES: 800, MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000 }),
    thumbnail: Object.freeze({ MAX_ENTRIES: 2000, MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000 }),
  });
  const operations = new Map();
  let lastAccess = 0;
  const accessStamp = () => { lastAccess = Math.max(Date.now(), lastAccess + 1); return lastAccess; };
  const manager = {
    __BUILD_REV: 'dev',
    getCacheConfig(type) {
      if (!Object.hasOwn(CONFIG, type)) throw new TypeError(`Unknown cache type: ${type}`);
      return CONFIG[type];
    },
    getCacheNameForType(type) {
      this.getCacheConfig(type);
      return `${type}-${this.__BUILD_REV}`;
    },
  };

  // Serialize mutations of one cache so concurrent requests cannot lose touches or exceed its limit.
  function serialize(cacheName, operation) {
    const previous = operations.get(cacheName) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    operations.set(cacheName, next);
    const release = () => { if (operations.get(cacheName) === next) operations.delete(cacheName); };
    next.then(release, release);
    return next;
  }

  function cacheNameFor(type, options) {
    const name = options.cacheName || manager.getCacheNameForType(type);
    const prefix = manager.getCacheNameForType(type);
    if (name !== prefix && !name.startsWith(`${prefix}-`)) throw new TypeError('Cache name is outside the current build namespace');
    return name;
  }

  function cacheKeyFor(type, request) {
    if (type !== 'thumbnail' || !request.url) return request;
    const url = new URL(request.url);
    // Retries add transport-only cache busters. Keep path and v so content revisions stay isolated.
    url.searchParams.delete('_t');
    url.searchParams.delete('_sse');
    return new Request(url, request);
  }

  function expired(response, config) {
    const expiresAt = Number(response.headers.get('x-cache-expires-at'));
    if (expiresAt > 0) return expiresAt <= Date.now();
    const cachedAt = Number(response.headers.get('x-cached-at'));
    return cachedAt > 0 && cachedAt + config.MAX_AGE_MS <= Date.now();
  }

  async function withHeaders(response, headers) {
    return new Response(await response.clone().arrayBuffer(), {
      status: response.status, statusText: response.statusText, headers,
    });
  }

  async function cleanup(cache, config) {
    const keys = await cache.keys();
    const entries = [];
    for (const [index, request] of keys.entries()) {
      const response = await cache.match(request);
      if (!response) continue;
      if (expired(response, config)) {
        await cache.delete(request);
      } else {
        entries.push({ request, index, accessedAt: Number(response.headers.get('x-cache-last-access') || response.headers.get('x-cached-at') || 0) });
      }
    }
    entries.sort((a, b) => a.accessedAt - b.accessedAt || a.index - b.index);
    const excess = Math.max(0, entries.length - config.MAX_ENTRIES);
    for (const entry of entries.slice(0, excess)) await cache.delete(entry.request);
  }

  manager.putWithLRU = async function (type, request, response, options = {}) {
    const config = this.getCacheConfig(type);
    // Pending thumbnails, partial video responses, writes and no-store data must never become offline hits.
    if (!response || response.status !== 200 || (request.method && request.method !== 'GET') ||
        /(?:^|,)\s*no-store\b/i.test(response.headers.get('cache-control') || '')) return false;
    const cacheName = cacheNameFor(type, options);
    const control = response.headers.get('cache-control') || '';
    if (/\bprivate\b/i.test(control) && !cacheName.startsWith(`${this.getCacheNameForType(type)}-auth-`)) return false;
    return serialize(cacheName, async () => {
      const headers = new Headers(response.headers);
      const now = Date.now();
      const maxAge = options.maxAgeMs ?? config.MAX_AGE_MS;
      headers.set('x-cached-at', String(now));
      headers.set('x-cache-last-access', String(accessStamp()));
      headers.set('x-cache-expires-at', String(now + maxAge));
      const wrapped = await withHeaders(response, headers);
      const cache = await caches.open(cacheName);
      await cache.put(cacheKeyFor(type, request), wrapped);
      await cleanup(cache, config);
      return true;
    }).catch(error => { console.warn('[SW] Cache write failed:', error.message); return false; });
  };

  manager.matchWithLRU = async function (type, request, options = {}) {
    const config = this.getCacheConfig(type);
    const cacheName = cacheNameFor(type, options);
    return serialize(cacheName, async () => {
      const cache = await caches.open(cacheName);
      const key = cacheKeyFor(type, request);
      const response = await cache.match(key);
      if (!response) return undefined;
      if (expired(response, config)) {
        await cache.delete(key);
        return undefined;
      }
      const headers = new Headers(response.headers);
      headers.set('x-cache-last-access', String(accessStamp()));
      // A read changes recency, but never extends the original TTL.
      try {
        await cache.put(key, await withHeaders(response, headers));
      } catch (error) {
        console.warn('[SW] Cache recency update failed:', error.message);
      }
      return response;
    }).catch(error => { console.warn('[SW] Cache read failed:', error.message); return undefined; });
  };

  manager.performLRUCleanup = function (cacheName, config) {
    return serialize(cacheName, async () => cleanup(await caches.open(cacheName), config));
  };

  manager.manualCleanup = async function (type) {
    const prefix = this.getCacheNameForType(type);
    const config = this.getCacheConfig(type);
    const names = await caches.keys();
    await Promise.all(names.filter(name => name === prefix || name.startsWith(`${prefix}-`))
      .map(name => this.performLRUCleanup(name, config)));
  };

  self.swCacheManager = manager;
})();

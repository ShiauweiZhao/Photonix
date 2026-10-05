const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBackfill } = require('../services/thumbnail/backfill');

function setup(rows = [], overrides = {}) {
    let active = false;
    const dispatched = [], marked = [];
    const backfill = createBackfill({
        fs: { async access() {} },
        state: { thumbnail: {
            setBatchActive: value => { active = value; }, getActiveCount: () => 0,
            getQueueLen: () => 0, isBatchLoopActive: () => false,
        } },
        logger: { debug() {}, info() {}, error() {} }, LOG_PREFIXES: {}, logThumbIgnore() {},
        PHOTOS_DIR_SAFE_ROOT: '/photos', THUMBS_DIR: '/thumbnails',
        sanitizePath: value => value, isPathSafe: () => true,
        redis: null, safeRedisGet: async () => null, queueThumbStatusUpdate: async () => {},
        scheduler: { hasActiveTask: () => false, dispatch: (task, context) => { dispatched.push({ task, context }); return true; }, getOndemandQueueLength: () => 0 },
        thumbMetrics: { pending: 0 }, workerManager: { destroyThumbnailWorkerPool() {} },
        orchestrator: { async gate() {}, async isHeavy() { return false; } },
        thumbStatusRepo: { async getByStatus(status) { return Array.isArray(status) ? rows : []; } },
        dbAll: async () => [], markProcessing: async value => { marked.push(value); },
        ...overrides,
    });
    return { backfill, dispatched, marked, active: () => active };
}

test('empty backfill restores the batch flag without dispatching work', async () => {
    const { backfill, active, dispatched } = setup();
    const result = await backfill();
    assert.equal(result.foundMissing, 0);
    assert.equal(result.success, true);
    assert.equal(active(), false);
    assert.deepEqual(dispatched, []);
});

test('bulk candidates keep their media types, counters, and status updates', async () => {
    const { backfill, dispatched, marked, active } = setup([{ path: 'album/photo.jpg' }, { path: 'album/video.mp4' }]);
    const result = await backfill(2);
    assert.equal(result.queued, 2);
    assert.equal(result.skipped, 0);
    assert.equal(result.foundMissing, 2);
    assert.deepEqual(dispatched.map(({ task, context }) => [task.relativePath, task.type, context]), [
        ['album/photo.jpg', 'photo', 'batch'], ['album/video.mp4', 'video', 'batch'],
    ]);
    assert.deepEqual(marked, ['album/photo.jpg', 'album/video.mp4']);
    assert.equal(active(), false);
});

test('a failed database query restores the batch flag and propagates the failure', async () => {
    const { backfill, active } = setup([], { thumbStatusRepo: { async getByStatus() { throw new Error('database unavailable'); } } });
    await assert.rejects(backfill(), /database unavailable/);
    assert.equal(active(), false);
});

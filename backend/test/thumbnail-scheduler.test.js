const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createThumbnailScheduler } = require('../services/thumbnail/scheduler');

function setup(options = {}) {
    let active = 0, queued = 0;
    const started = [];
    const release = new Map();
    const metrics = {};
    const scheduler = createThumbnailScheduler({
        normalizeThumbnailTask: task => task?.relativePath ? task : null,
        onResult: async () => {},
        state: { thumbnail: {
            getActiveCount: () => active, incrementActiveCount: () => ++active,
            decrementActiveCount: () => --active, setQueueLen: value => { queued = value; },
        } },
        thumbMetrics: metrics,
        workerManager: {
            ensureThumbnailWorkerPool() {}, noteThumbnailUse() {}, scaleThumbnailWorkerPool() {}, destroyThumbnailWorkerPool() {},
            runThumbnailTask: ({ task }) => {
                started.push(task.relativePath);
                return new Promise(resolve => release.set(task.relativePath, () => resolve({ success: true })));
            },
        },
        logger: { debug() {}, warn() {} }, LOG_PREFIXES: {}, throttledLog() {},
        TraceManager: { getCurrentContext: () => null }, RetryManager: { clearFallbackCounts() {} },
        failureTimestamps: new Map(), NUM_WORKERS: 1, THUMB_ONDEMAND_RESERVE: 0,
        logThumbIgnore() {}, THUMBS_DIR: '/tmp/thumbnails',
        env: { THUMB_ONDEMAND_QUEUE_MAX: '2', THUMB_BATCH_QUEUE_MAX: '2', ...options },
    });
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const cleanup = async () => {
        const stopping = scheduler.stop();
        for (const complete of release.values()) complete();
        await stopping;
    };
    return { scheduler, started, release, metrics, tick, cleanup, counts: () => ({ active, queued }) };
}
const task = relativePath => ({ relativePath, filePath: `/tmp/${relativePath}`, type: 'photo' });

test('deduplicates queued/active work, rejects overflow, and restores counters on completion', async t => {
    const { scheduler, started, release, metrics, counts, tick, cleanup } = setup();
    t.after(cleanup);
    assert.equal(scheduler.dispatch(null), false);
    assert.equal(scheduler.dispatch(task('a.jpg')), true);
    assert.equal(scheduler.dispatch(task('a.jpg')), true);
    assert.equal(scheduler.dispatch(task('b.jpg')), true);
    assert.equal(scheduler.dispatch(task('b.jpg')), true);
    assert.equal(scheduler.dispatch(task('c.jpg')), true);
    assert.equal(scheduler.dispatch(task('overflow.jpg')), false);
    assert.deepEqual(counts(), { active: 1, queued: 2 });
    assert.equal(metrics.pending, 3);
    release.get('a.jpg')(); await tick();
    release.get('b.jpg')(); await tick();
    release.get('c.jpg')(); await scheduler.onIdle();
    assert.deepEqual(started, ['a.jpg', 'b.jpg', 'c.jpg']);
    assert.deepEqual(counts(), { active: 0, queued: 0 });
    assert.equal(metrics.pending, 0);
});

test('on-demand work runs before queued bulk work with the same concurrency budget', async t => {
    const { scheduler, started, release, tick, cleanup } = setup();
    t.after(cleanup);
    scheduler.dispatch(task('running.jpg'));
    scheduler.dispatch(task('bulk.jpg'), 'batch');
    scheduler.dispatch(task('foreground.jpg'));
    release.get('running.jpg')(); await tick();
    assert.deepEqual(started, ['running.jpg', 'foreground.jpg']);
    release.get('foreground.jpg')(); await tick();
    release.get('bulk.jpg')(); await scheduler.onIdle();
});

test('shutdown cancels retries and queued work, while waiting for an active worker', async () => {
    const { scheduler, started, release, metrics, tick } = setup();
    scheduler.dispatch(task('running.jpg'));
    scheduler.dispatch(task('queued.jpg'));
    let retried = false;
    scheduler.scheduleRetry(() => { retried = true; }, 10);
    const stopping = scheduler.stop();
    assert.equal(scheduler.dispatch(task('after-stop.jpg')), false);
    release.get('running.jpg')(); await stopping;
    await new Promise(resolve => setTimeout(resolve, 20));
    await tick();
    assert.deepEqual(started, ['running.jpg']);
    assert.equal(retried, false);
    assert.equal(metrics.pending, 0);
});

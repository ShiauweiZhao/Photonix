const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStatusWriter } = require('../services/thumbnail/status-writer');
const logger = { debug() {}, warn() {}, error() {} };

function writer(repo, orchestrator = { withAdmission: (_name, work) => work() }) {
    return createStatusWriter({ repo, orchestrator, logger, LOG_PREFIXES: {}, redis: null, retryDelayMs: 10000 });
}

test('coalesces status updates and rejects an older mtime while a write is in flight', async t => {
    const writes = [];
    let unblock;
    const waiting = new Promise(resolve => { unblock = resolve; });
    const instance = writer({
        async upsertBatch(rows) { writes.push(rows); if (writes.length === 1) await waiting; },
    });
    t.after(() => { unblock(); return instance.stop(); });
    await instance.queueUpdate('photo.jpg', 10, 'processing');
    await instance.queueUpdate('photo.jpg', 30, 'exists');
    await instance.queueUpdate('photo.jpg', 20, 'failed');
    unblock();
    await instance.flush();
    assert.deepEqual(writes.at(-1), [['photo.jpg', 30, 'exists']]);
});

test('admission failure falls back to direct persistence', async t => {
    const writes = [];
    const instance = writer({ async upsertBatch(rows) { writes.push(rows); } }, {
        async withAdmission() { throw new Error('admission unavailable'); },
    });
    t.after(() => instance.stop());
    await instance.queueUpdate('photo.jpg', 10, 'exists');
    await instance.flush();
    assert.deepEqual(writes, [[['photo.jpg', 10, 'exists']]]);
});

test('failed status writes are retained and can be flushed after persistence recovers', async t => {
    let failed = true;
    const persisted = [];
    const instance = writer({
        async upsertBatch(rows) { if (failed) throw new Error('database busy'); persisted.push(...rows); },
        async upsertSingle() { throw new Error('database busy'); },
    });
    t.after(() => instance.stop());
    await instance.queueUpdate('photo.jpg', 10, 'failed');
    await assert.rejects(instance.flush(), /could not be persisted/);
    failed = false;
    await instance.flush();
    assert.deepEqual(persisted, [['photo.jpg', 10, 'failed']]);
});

test('shutdown drains writes and refuses new status updates', async () => {
    const writes = [];
    const instance = writer({ async upsertBatch(rows) { writes.push(...rows); } });
    await instance.queueUpdate('photo.jpg', 10, 'exists');
    await instance.stop();
    await instance.queueUpdate('late.jpg', 20, 'exists');
    assert.deepEqual(writes, [['photo.jpg', 10, 'exists']]);
});

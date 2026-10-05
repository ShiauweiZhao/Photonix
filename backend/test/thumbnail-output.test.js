const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { writeThumbnailAtomically } = require('../services/thumbnail/output');

test('the final thumbnail remains unavailable until generation finishes', async t => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'photonix-atomic-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const destination = path.join(dir, 'image.webp');
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    let started;
    const begun = new Promise(resolve => { started = resolve; });
    const writing = writeThumbnailAtomically(destination, async temporary => {
        await fs.writeFile(temporary, '');
        started();
        await waiting;
        await fs.writeFile(temporary, 'complete image');
        return { success: true };
    });
    await begun;
    await assert.rejects(fs.access(destination), { code: 'ENOENT' });
    release();
    assert.equal((await writing).success, true);
    assert.equal(await fs.readFile(destination, 'utf8'), 'complete image');
    assert.deepEqual(await fs.readdir(dir), ['image.webp']);
});

test('failed generation preserves existing output and removes temporary files', async t => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'photonix-atomic-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const destination = path.join(dir, 'image.jpg');
    await fs.writeFile(destination, 'previous');
    const result = await writeThumbnailAtomically(destination, async temporary => {
        await fs.writeFile(temporary, 'partial');
        return { success: false, error: 'failed renderer' };
    });
    assert.equal(result.success, false);
    assert.equal(await fs.readFile(destination, 'utf8'), 'previous');
    assert.deepEqual(await fs.readdir(dir), ['image.jpg']);
    await assert.rejects(writeThumbnailAtomically(destination, temporary => fs.writeFile(temporary, '')), /empty/);
    assert.deepEqual(await fs.readdir(dir), ['image.jpg']);
});

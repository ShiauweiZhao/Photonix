const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, mkdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const sharp = require('sharp');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

let directory, child, base, port;
let logs = '';
const secret = randomBytes(48).toString('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function stopServer() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
        const [code, signal] = await exited;
        assert.equal(signal, null, 'Server should stop gracefully without SIGKILL');
        assert.equal(code, 0, `Server shutdown failed:\n${logs}`);
    } finally { clearTimeout(timeout); }
}

async function startServer() {
    logs = '';
    child = spawn(process.execPath, ['server.js'], {
        cwd: path.resolve(__dirname, '..'),
        env: {
            ...process.env, NODE_ENV: 'test', PORT: String(port),
            DATA_DIR: path.join(directory, 'data'), PHOTOS_DIR: path.join(directory, 'photos'),
            PHOTONIX_DOWNLOAD_PATH: path.join(directory, 'downloads'),
            ENABLE_REDIS: 'false', JWT_SECRET: secret, ADMIN_SECRET: secret,
            NUM_WORKERS: '1', SHARP_CONCURRENCY: '1', WORKER_MEMORY_MB: '256',
            DETECTED_CPU_COUNT: '2', DETECTED_MEMORY_GB: '2',
            HEALTH_CACHE_TTL_MS: '1', LOG_LEVEL: 'error', TRUST_PROXY: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-10000); });
    child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-10000); });
    for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) throw new Error(`Server exited during startup:\n${logs}`);
        try {
            const response = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
            if (response.status === 200 && (await response.json()).status === 'ok') return;
        } catch { /* Wait for the server's socket and worker initialization. */ }
        await sleep(100);
    }
    throw new Error(`Server failed readiness:\n${logs}`);
}

before(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'photonix-regression-'));
    await mkdir(path.join(directory, 'photos', 'Regression-Album'), { recursive: true });
    await sharp({ create: { width: 640, height: 480, channels: 3, background: '#3388bb' } })
        .jpeg().toFile(path.join(directory, 'photos', 'Regression-Album', 'sample.jpg'));
    const socket = net.createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    base = `http://127.0.0.1:${port}`;
    await startServer();
}, { timeout: 20000 });

after(async () => {
    await stopServer();
    if (directory) await rm(directory, { recursive: true, force: true });
});

test('cold startup creates healthy SQLite schemas and an indexing worker', async () => {
    const response = await fetch(base + '/health');
    const health = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(health.issues, []);
    assert.equal(health.dependencies.workers.indexing.active, true);
    for (const state of Object.values(health.dependencies.database.connections)) assert.equal(state, 'connected');
});

test('a real photo is indexed, browsable, and its album is searchable', { timeout: 15000 }, async () => {
    let root;
    for (let attempt = 0; attempt < 100; attempt++) {
        root = await (await fetch(base + '/api/browse/')).json();
        if (root.items?.some(item => item.data.path === 'Regression-Album')) break;
        await sleep(100);
    }
    assert.ok(root.items.some(item => item.type === 'album' && item.data.path === 'Regression-Album'));
    const album = await (await fetch(base + '/api/browse/Regression-Album')).json();
    assert.equal(album.totalResults, 1);
    assert.equal(album.items[0].type, 'photo');
    assert.equal(album.items[0].data.width, 640);
    assert.equal(album.items[0].data.height, 480);
    const search = await (await fetch(base + '/api/search?q=regression')).json();
    assert.ok(search.results.some(result => result.path === 'Regression-Album'));
});

test('original JPEG and on-demand WebP thumbnail return real decoded images', { timeout: 15000 }, async () => {
    const original = await fetch(base + '/static/Regression-Album/sample.jpg');
    assert.equal(original.status, 200);
    const metadata = await sharp(Buffer.from(await original.arrayBuffer())).metadata();
    assert.equal(metadata.width, 640);
    const thumbnailUrl = base + '/api/thumbnail?path=Regression-Album%2Fsample.jpg';
    let thumbnail;
    for (let attempt = 0; attempt < 100; attempt++) {
        thumbnail = await fetch(thumbnailUrl);
        if (thumbnail.status !== 202) break;
        assert.equal(thumbnail.headers.get('x-thumbnail-status'), 'processing');
        await thumbnail.arrayBuffer();
        await sleep(100);
    }
    assert.equal(thumbnail.status, 200);
    assert.match(thumbnail.headers.get('content-type'), /image\/webp/);
    const result = await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata();
    assert.equal(result.format, 'webp');
    assert.equal(result.width, 500);
    assert.equal(result.height, 375);
});

test('anonymous users cannot start bulk generation and traversal is rejected', async () => {
    const denied = await fetch(base + '/api/thumbnail/batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'INSUFFICIENT_PERMISSIONS');
    const traversal = await fetch(base + '/api/thumbnail?path=..%2Foutside.jpg');
    assert.equal(traversal.status, 400);
});

test('password-protected galleries reject anonymous and invalid tokens', { timeout: 20000 }, async () => {
    await stopServer();
    const db = new Database(path.join(directory, 'data', 'settings.db'));
    try {
        const update = db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)');
        update.run('PASSWORD_ENABLED', 'true');
        update.run('ALLOW_PUBLIC_ACCESS', 'false');
        update.run('PASSWORD_HASH', bcrypt.hashSync(randomBytes(16).toString('hex'), 4));
    } finally { db.close(); }
    await startServer();
    assert.equal((await fetch(base + '/api/browse/')).status, 401);
    assert.equal((await fetch(base + '/static/Regression-Album/sample.jpg')).status, 401);
    const invalid = await fetch(base + '/api/search?q=regression', { headers: { Authorization: 'Bearer invalid' } });
    assert.equal(invalid.status, 401);
    assert.equal((await invalid.json()).code, 'INVALID_TOKEN');
    const token = jwt.sign({ sub: 'regression-user' }, secret, { expiresIn: '1m' });
    const allowed = await fetch(base + '/api/browse/Regression-Album', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).totalResults, 1);
});

const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

// Keep the final pathname invisible until Sharp/FFmpeg has finished writing.
async function writeThumbnailAtomically(destination, generate) {
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp${path.extname(destination)}`);
    try {
        const result = await generate(temporary);
        if (result?.success === false) return result;
        const stat = await fs.stat(temporary);
        if (stat.size === 0) throw new Error('Thumbnail output is empty');
        await fs.rename(temporary, destination);
        return result;
    } finally {
        await fs.rm(temporary, { force: true });
    }
}

module.exports = { writeThumbnailAtomically };

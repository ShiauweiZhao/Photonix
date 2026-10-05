const path = require('node:path');

function createTaskValidator({ photosDir, sanitizePath, isPathSafe, logger, LOG_PREFIXES }) {
    const PHOTOS_DIR_SAFE_ROOT = path.resolve(photosDir);
    function normalizeThumbnailTask(task) {
        if (!task || (typeof task !== 'object')) {
            return null;
        }

        const rawRelative = typeof task.relativePath === 'string' ? task.relativePath : '';
        const sanitizedRelative = sanitizePath(rawRelative);
        if (!sanitizedRelative) {
            logger.warn(`${LOG_PREFIXES.ONDEMAND_GENERATE} 拒绝缺少相对路径的缩略图任务`);
            return null;
        }

        if (!isPathSafe(sanitizedRelative)) {
            logger.warn(`${LOG_PREFIXES.ONDEMAND_GENERATE} 检测到不安全的缩略图路径: ${rawRelative}`);
            return null;
        }

        const resolvedAbsolute = path.resolve(PHOTOS_DIR_SAFE_ROOT, sanitizedRelative);
        if (!resolvedAbsolute.startsWith(PHOTOS_DIR_SAFE_ROOT)) {
            logger.warn(`${LOG_PREFIXES.ONDEMAND_GENERATE} 缩略图任务路径超出受信目录: ${resolvedAbsolute}`);
            return null;
        }

        const declaredAbsolute = typeof task.filePath === 'string' ? task.filePath : resolvedAbsolute;
        const normalizedAbsolute = declaredAbsolute.startsWith(PHOTOS_DIR_SAFE_ROOT)
            ? declaredAbsolute
            : resolvedAbsolute;

        const inferredType = task.type || (/\.(mp4|webm|mov)$/i.test(sanitizedRelative) ? 'video' : 'photo');

        if (!/\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(normalizedAbsolute) && !/\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i.test(sanitizedRelative)) {
            logger.warn(`${LOG_PREFIXES.ONDEMAND_GENERATE} 拒绝不支持的媒体类型任务: ${sanitizedRelative}`);
            return null;
        }

        return {
            filePath: normalizedAbsolute,
            relativePath: sanitizedRelative,
            type: inferredType
        };
    }


    return normalizeThumbnailTask;
}

module.exports = { createTaskValidator };

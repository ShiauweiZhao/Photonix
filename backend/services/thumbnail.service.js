/**
 * 缩略图服务公共入口与 Worker 结果处理。
 * 队列、批量补全和状态持久化由独立模块管理。
 */
const path = require('path');
const { promises: fs } = require('fs');
const logger = require('../config/logger');
const { LOG_PREFIXES, throttledLog } = logger;
const { TraceManager } = require('../utils/trace');
const { redis } = require('../config/redis');
const { safeRedisIncr, safeRedisSet, safeRedisDel, safeRedisExpire, safeRedisGet } = require('../utils/helpers');
const { RetryManager } = require('../utils/retry');
const { THUMBS_DIR, PHOTOS_DIR, MAX_THUMBNAIL_RETRIES, INITIAL_RETRY_DELAY, NUM_WORKERS, THUMB_ONDEMAND_RESERVE } = require('../config');
const workerManager = require('./worker.manager');
const { dbAll, runAsync } = require('../db/multi-db');
const eventBus = require('./event.service');
const { sanitizePath, isPathSafe } = require('../utils/path.utils');
const state = require('./state.manager');

const PHOTOS_DIR_SAFE_ROOT = path.resolve(PHOTOS_DIR);
const thumbMetrics = {
    generated: 0,
    skipped: 0,
    failures: 0,
    permanentFailures: 0,
    retries: 0,
    lastError: null,
    lastFailureAt: null,
    lastGeneratedAt: null,
    processing: 0,
    queued: 0,
    pending: 0,
    lastUpdatedAt: 0
};
// 使用状态管理器替代全局变量
state.thumbnail.setTaskMetrics(thumbMetrics);

function logThumbIgnore(scope, error) {
    if (!error) return;
    logger.debug(`${LOG_PREFIXES.THUMB} ${scope} 忽略异常: ${error.message}`);
}

const { createStatusWriter } = require('./thumbnail/status-writer');
const { createThumbnailScheduler } = require('./thumbnail/scheduler');
const { createTaskValidator } = require('./thumbnail/task-validator');
const { createBackfill } = require('./thumbnail/backfill');
const orchestrator = require('./orchestrator');
const ThumbStatusRepository = require('../repositories/thumbStatus.repo');
const statusWriter = createStatusWriter({ repo: new ThumbStatusRepository(), orchestrator, redis, logger, LOG_PREFIXES });
const queueThumbStatusUpdate = statusWriter.queueUpdate;
const normalizeThumbnailTask = createTaskValidator({ photosDir: PHOTOS_DIR, sanitizePath, isPathSafe, logger, LOG_PREFIXES });
const failureTimestamps = new Map();
const scheduler = createThumbnailScheduler({ normalizeThumbnailTask, onResult: handleWorkerResult, state,
    thumbMetrics, workerManager, logger, LOG_PREFIXES, throttledLog, TraceManager, RetryManager, failureTimestamps,
    NUM_WORKERS, THUMB_ONDEMAND_RESERVE, logThumbIgnore, THUMBS_DIR });
const batchGenerateMissingThumbnails = createBackfill({ fs, state, logger, LOG_PREFIXES, logThumbIgnore,
    PHOTOS_DIR_SAFE_ROOT, THUMBS_DIR, sanitizePath, isPathSafe, redis, safeRedisGet,
    queueThumbStatusUpdate, scheduler, thumbMetrics, workerManager, orchestrator,
    thumbStatusRepo: new ThumbStatusRepository(), dbAll,
    markProcessing: relativePath => runAsync('main', 'UPDATE thumb_status SET status = ? WHERE path = ?', ['processing', relativePath]) });

async function stopThumbnailService() {
    await scheduler.stop();
    await statusWriter.stop();
}

async function handleWorkerResult(task, workerResult) {
    try {
        if (workerResult && workerResult.success) {
            await processWorkerSuccess(task, Boolean(workerResult.skipped));
        } else {
            const errorPayload = workerResult && workerResult.error ? workerResult.error : null;
            await processWorkerFailure(task, errorPayload);
        }
    } catch (error) {
        logThumbIgnore('处理缩略图任务结果', error);
    }
}

async function processWorkerSuccess(task, skipped) {
    const relativePath = task.relativePath;
    const failureKey = `thumb_failed_permanently:${relativePath}`;

    // 清理重试计数（成功后重置）
    await RetryManager.resetRetryCount(`thumb:${relativePath}`);
    failureTimestamps.delete(relativePath);

    if (skipped) {
        await safeRedisDel(redis, failureKey, '清理永久失败标记');
        thumbMetrics.skipped += 1;
        await safeRedisIncr(redis, 'metrics:thumb:skip', '缩略图跳过指标');
    } else {
        // 更新统计指标（不输出单条日志避免刷屏）
        thumbMetrics.generated += 1;
        thumbMetrics.lastGeneratedAt = Date.now();

        // 通过 Redis pub/sub 发布事件，若 Redis 未启用/不可用则回落到本地事件
        let publishedToRedis = false;
        try {
            await redis.publish('thumbnail-generated', JSON.stringify({ path: relativePath }));
            publishedToRedis = !redis.isNoRedis;
        } catch (pubErr) {
            logger.debug(`${LOG_PREFIXES.THUMB} 发布缩略图事件失败（回退本地事件）`, { error: pubErr && pubErr.message });
        }
        if (!publishedToRedis) {
            eventBus.emit('thumbnail-generated', { path: relativePath });
        }
        await safeRedisDel(redis, failureKey, '清理永久失败标记');
        await safeRedisIncr(redis, 'metrics:thumb:success', '缩略图成功指标');

        try {
            const { invalidateTags } = require('./cache.service');
            const dirname = path.dirname(relativePath);
            const tags = [
                `thumbnail:${relativePath}`,
                `album:${dirname}`,
                `album:/`
            ];

            await invalidateTags(tags);
        } catch (cacheError) {
            logger.debug(`${LOG_PREFIXES.CACHE} 失效缩略图缓存失败（已忽略）: ${cacheError.message}`);
        }
    }

    try {
        const isVideo = task.type === 'video';
        const extension = isVideo ? '.jpg' : '.webp';
        const thumbRelPath = task.relativePath.replace(/\.[^.]+$/, extension);
        const thumbAbsPath = path.join(THUMBS_DIR, thumbRelPath);
        const thumbMtime = await fs.stat(thumbAbsPath).then((s) => s.mtimeMs).catch(() => Date.now());
        await queueThumbStatusUpdate(task.relativePath, thumbMtime, 'exists');
    } catch (dbErr) {
        logger.warn(`${LOG_PREFIXES.THUMB} 写入缩略图状态队列失败（成功分支）`, {
            relativePath: task.relativePath,
            error: dbErr?.message
        });
    }
}

async function processWorkerFailure(task, errorPayload) {
    const relativePath = task.relativePath;
    const failureKey = `thumb_failed_permanently:${relativePath}`;
    const message = errorPayload && errorPayload.message ? errorPayload.message : (typeof errorPayload === 'string' ? errorPayload : '未知错误');
    let deletedByCorruptionRule = false;

    try {
        const CORRUPT_PARSE_SNIPPET = '损坏或格式异常，无法解析';
        if (typeof message === 'string' && message.includes(CORRUPT_PARSE_SNIPPET)) {
            const corruptionKey = `thumb_corrupt_parse_count:${relativePath}`;
            const corruptCount = await safeRedisIncr(redis, corruptionKey, '缩略图损坏计数') || 0;
            if (corruptCount === 1) {
                await safeRedisExpire(redis, corruptionKey, 3600 * 24 * 30, '缩略图损坏标记');
            }
            // 仅在首次或每5次记录一次，减少刷屏
            if (corruptCount === 1 || corruptCount % 5 === 0) {
                logger.warn(`${LOG_PREFIXES.THUMB} 发现文件损坏`, {
                    relativePath: path.basename(relativePath),
                    corruptCount,
                    threshold: 10,
                    reason: message
                });
            }
            if (corruptCount >= 10) {
                try {
                    await fs.unlink(task.filePath).catch(() => { });
                    logger.error(`${LOG_PREFIXES.THUMB} 已删除损坏的源文件`, {
                        filePath: task.filePath,
                        relativePath,
                        corruptCount,
                        reason: CORRUPT_PARSE_SNIPPET
                    });
                    await RetryManager.resetRetryCount(`thumb:${relativePath}`);
                    failureTimestamps.delete(relativePath);
                    await safeRedisSet(redis, failureKey, '1', 'EX', 3600 * 24 * 7, '缩略图永久失败标记');
                    await safeRedisDel(redis, corruptionKey, '清理缩略图损坏标记');
                    deletedByCorruptionRule = true;
                } catch (delErr) {
                    logger.warn(`${LOG_PREFIXES.THUMB} 触发损坏文件删除失败`, { error: delErr && delErr.message });
                    deletedByCorruptionRule = true;
                }
            }
        }
    } catch (err) {
        logger.debug(`${LOG_PREFIXES.THUMB} 损坏文件检测逻辑失败`, { error: err.message });
    }

    // 使用 RetryManager 管理重试计数（Redis 持久化 + 指数退避）
    const retryInfo = await RetryManager.incrementRetryCount(
        `thumb:${relativePath}`,
        MAX_THUMBNAIL_RETRIES,
        INITIAL_RETRY_DELAY,
        30000 // 最大延迟 30 秒
    );

    failureTimestamps.set(relativePath, Date.now());

    // 中间重试仅记录 debug，减少刷屏
    logger.debug(`${LOG_PREFIXES.THUMB} 处理任务失败`, {
        relativePath,
        retryCount: retryInfo.retryCount,
        maxRetries: MAX_THUMBNAIL_RETRIES,
        error: message,
        taskType: task.type
    });
    await safeRedisIncr(redis, 'metrics:thumb:fail', '缩略图失败指标');

    thumbMetrics.failures += 1;
    thumbMetrics.lastError = message;
    thumbMetrics.lastFailureAt = Date.now();

    let statusForDb = 'failed';
    if (deletedByCorruptionRule) {
        thumbMetrics.permanentFailures += 1;
        await RetryManager.resetRetryCount(`thumb:${relativePath}`);
        failureTimestamps.delete(relativePath);
        statusForDb = 'permanent_failed';
    } else if (retryInfo.shouldRetry) {
        // 合并重试信息到一条日志，使用 info 级别（仅在首次重试时记录）
        if (retryInfo.retryCount === 1) {
            logger.info(`${LOG_PREFIXES.THUMB} 任务将重试`, {
                relativePath: path.basename(relativePath),
                retryCount: retryInfo.retryCount,
                maxRetries: MAX_THUMBNAIL_RETRIES,
                reason: message
            });
        }
        thumbMetrics.retries += 1;
        scheduler.scheduleRetry(() => {
            scheduler.dispatch({
                filePath: task.filePath,
                relativePath: task.relativePath,
                type: task.type,
            });
        }, retryInfo.delay);
    } else {
        logger.error(`${LOG_PREFIXES.THUMB} 任务已达最大重试次数，标记为永久失败`, {
            relativePath,
            maxRetries: MAX_THUMBNAIL_RETRIES,
            reason: message
        });
        await safeRedisSet(redis, failureKey, '1', 'EX', 3600 * 24 * 7, '缩略图永久失败标记');
        await safeRedisIncr(redis, 'metrics:thumb:permanent_fail', '缩略图永久失败指标');
        thumbMetrics.permanentFailures += 1;
        failureTimestamps.delete(relativePath);
        statusForDb = 'permanent_failed';
    }

    try {
        const srcMtime = await fs.stat(task.filePath).then((s) => s.mtimeMs).catch(() => Date.now());
        await queueThumbStatusUpdate(relativePath, srcMtime, statusForDb);
    } catch (dbErr) {
        logger.warn(`${LOG_PREFIXES.THUMB} 写入缩略图状态队列失败（失败分支）`, {
            relativePath,
            status: statusForDb,
            error: dbErr?.message
        });
    }

    // 永久失败时同步清理封面缓存/引用，避免相册封面卡在坏缩略图上
    if (statusForDb === 'permanent_failed') {
        try {
            await clearCoverCacheForPath(relativePath);
        } catch (clearErr) {
            logThumbIgnore('清理封面缓存', clearErr);
        }
    }
}

/**
 * 清理引用指定媒体的相册封面缓存/表记录，避免封面卡在永久失败缩略图上
 */
async function clearCoverCacheForPath(relativePath) {
    const sanitized = sanitizePath(relativePath);
    if (!sanitized || !isPathSafe(sanitized)) return;

    try {
        const AlbumCoversRepository = require('../repositories/albumCovers.repo');
        const coversRepo = new AlbumCoversRepository();
        const affectedAlbums = await coversRepo.getAlbumPathsByCoverPrefix(sanitized);

        if (affectedAlbums.length > 0) {
            await coversRepo.deleteByCoverPrefix(sanitized).catch(err => logThumbIgnore('删除封面引用', err));
            try {
                const { invalidateCoverCache } = require('./file.service');
                await Promise.all(affectedAlbums.map(async (albumRel) => {
                    try {
                        await invalidateCoverCache(path.join(PHOTOS_DIR_SAFE_ROOT, albumRel));
                    } catch (e) {
                        logThumbIgnore('失效单个封面缓存', e);
                    }
                    try {
                        await safeRedisDel(redis, `cover_info:/${albumRel}`, '封面缓存清理');
                    } catch (e) {
                        logThumbIgnore('清理封面缓存键', e);
                    }
                }));
            } catch (cacheErr) {
                logThumbIgnore('封面缓存失效总控', cacheErr);
            }
        }
    } catch (err) {
        logThumbIgnore('清理封面缓存入口', err);
    }
}

/**
 * 确保缩略图存在 - 按需生成版本
 * 检查缩略图是否存在，不存在则立即创建生成任务
 * @param {string} sourceAbsPath - 源文件绝对路径
 * @param {string} sourceRelPath - 源文件相对路径
 * @returns {Promise<Object>} 缩略图状态信息
 */
async function ensureThumbnailExists(sourceAbsPath, sourceRelPath) {
    // 检查是否包含 @eaDir，如果是则直接返回失败状态
    if (sourceRelPath.includes('@eaDir')) {
        logger.debug(`跳过 @eaDir 文件的缩略图生成: ${sourceRelPath}`);
        return { status: 'failed' };
    }

    const sanitizedRelPath = sanitizePath(sourceRelPath);
    if (!sanitizedRelPath || !isPathSafe(sanitizedRelPath)) {
        logger.warn(`${LOG_PREFIXES.ONDEMAND_GENERATE} 拒绝不安全的缩略图生成请求: ${sourceRelPath}`);
        return { status: 'failed' };
    }

    const resolvedSourceAbsPath = path.resolve(PHOTOS_DIR_SAFE_ROOT, sanitizedRelPath);

    // 根据文件类型确定缩略图格式
    const isVideo = /\.(mp4|webm|mov)$/i.test(sanitizedRelPath);
    const extension = isVideo ? '.jpg' : '.webp';
    const thumbRelPath = sanitizedRelPath.replace(/\.[^.]+$/, extension);
    const thumbAbsPath = path.join(THUMBS_DIR, thumbRelPath);
    // 修复：使用API调用方式生成缩略图URL，与文件服务保持一致
    const thumbUrl = `/api/thumbnail?path=${encodeURIComponent(sanitizedRelPath)}`;

    try {
        // 检查缩略图文件是否存在
        await fs.access(thumbAbsPath);
        return { status: 'exists', path: thumbUrl };
    } catch (e) {
        // 检查是否已标记为永久失败
        const isPermanentlyFailed = await safeRedisGet(redis, `thumb_failed_permanently:${sanitizedRelPath}`, '检查永久失败标记');
        if (isPermanentlyFailed) {
            return { status: 'failed' };
        }

        // 按需生成：立即派发任务
        const task = {
            filePath: resolvedSourceAbsPath,
            relativePath: sanitizedRelPath,
            type: isVideo ? 'video' : 'photo'
        };

        const dispatched = scheduler.dispatch(task);
        if (!dispatched) {
            logger.warn(`${LOG_PREFIXES.ONDEMAND_GENERATE} 任务派发失败: ${sanitizedRelPath} (工作线程繁忙或重复任务)`);
        }

        return { status: 'processing' };
    }
}

function getThumbnailTaskMetrics() {
    scheduler.refreshMetrics();
    return {
        generated: thumbMetrics.generated,
        skipped: thumbMetrics.skipped,
        failures: thumbMetrics.failures,
        permanentFailures: thumbMetrics.permanentFailures,
        retries: thumbMetrics.retries,
        lastError: thumbMetrics.lastError,
        lastFailureAt: thumbMetrics.lastFailureAt,
        lastGeneratedAt: thumbMetrics.lastGeneratedAt,
        queued: thumbMetrics.queued,
        processing: thumbMetrics.processing,
        pending: thumbMetrics.pending,
        lastUpdatedAt: thumbMetrics.lastUpdatedAt
    };
}

// 导出缩略图服务函数
module.exports = {
    ensureThumbnailExists,
    batchGenerateMissingThumbnails,
    queueThumbStatusUpdate,
    getThumbnailTaskMetrics,
    stopThumbnailService,
};

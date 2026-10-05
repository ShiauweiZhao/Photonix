const path = require('node:path');

function createBackfill({ fs, state, logger, LOG_PREFIXES, logThumbIgnore, PHOTOS_DIR_SAFE_ROOT, THUMBS_DIR, sanitizePath, isPathSafe, redis, safeRedisGet, queueThumbStatusUpdate, scheduler, thumbMetrics, workerManager, orchestrator, thumbStatusRepo, dbAll, markProcessing }) {
    const BATCH_COOLDOWN_MS = Math.max(0, Number(process.env.THUMB_BATCH_COOLDOWN_MS || 0));
    const TELEMETRY_LOG_INTERVAL_MS = Math.max(5000, Number(process.env.THUMB_TELEMETRY_LOG_INTERVAL_MS || 15000));
    let __lastBatchTelemetryLog = 0;
    async function batchGenerateMissingThumbnails(limit = 1000) {
        const batchStartTs = Date.now();
        try {
            try {
                state.thumbnail.setBatchActive(true);
            } catch (error) {
                logThumbIgnore('标记批量缩略图任务开始', error);
            }

            // 统一闸门：重负载时让路，空闲窗口再跑（零配置）
            try {
                await orchestrator.gate('thumb-batch', { checkIntervalMs: 3000 });
            } catch (error) {
                logThumbIgnore('批量缩略图任务等待空闲窗口', error);
            }

            // 使用Repository优先查询明确需要补全的状态

            let missingThumbs = await thumbStatusRepo.getByStatus(['missing', 'failed', 'pending'], limit);

            logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 明确缺失状态查询结果: ${missingThumbs?.length || 0} 个`);

            // 如果明确缺失的不够limit，则检查'exists'状态的记录是否真的存在
            if (missingThumbs.length < limit) {
                const remainingLimit = limit - missingThumbs.length;
                logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 需要额外检查 ${remainingLimit} 个'exists'状态记录`);

                // 查询最近检查的'exists'状态记录，优先检查可能过期的
                const existsCandidates = await thumbStatusRepo.getByStatus('exists', remainingLimit * 3); // 多查询一些用于验证

                if (existsCandidates && existsCandidates.length > 0) {
                    logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 找到 ${existsCandidates.length} 个'exists'状态记录待验证`);

                    // 限制并发文件检查数量，避免系统过载
                    const MAX_CONCURRENT_CHECKS = Math.min(50, existsCandidates.length);

                    // 并行验证文件存在性，避免同步I/O阻塞
                    const validationPromises = existsCandidates.slice(0, MAX_CONCURRENT_CHECKS).map(async (row) => {
                        const relativePath = row.path;
                        const isVideo = /\.(mp4|webm|mov)$/i.test(relativePath);
                        const extension = isVideo ? '.jpg' : '.webp';
                        const thumbRelPath = relativePath.replace(/\.[^.]+$/, extension);
                        const thumbAbsPath = path.join(THUMBS_DIR, thumbRelPath);

                        try {
                            await fs.access(thumbAbsPath);
                            return null; // 文件存在，不需要补全
                        } catch (error) {
                            if (error && error.code !== 'ENOENT') {
                                logThumbIgnore('验证缩略图文件存在性', error);
                            }
                            // 文件不存在，需要补全
                            return { path: relativePath };
                        }
                    });

                    // 等待所有验证完成
                    const validationResults = await Promise.all(validationPromises);

                    // 收集需要补全的文件
                    const additionalMissing = validationResults.filter(result => result !== null);

                    if (additionalMissing.length > 0) {
                        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 在'exists'状态记录中发现 ${additionalMissing.length} 个缺失缩略图`);
                        missingThumbs = missingThumbs.concat(additionalMissing);
                    }
                }
            }

            logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 验证后发现 ${missingThumbs.length} 个真正需要补全的缩略图`);

            // 添加更详细的调试信息（仅在有需要补全的文件时）
            if (missingThumbs && missingThumbs.length > 0) {
                // 查询各状态的总数，用于调试（使用索引优化）
                const statusCounts = await dbAll('main', `
                    SELECT status, COUNT(1) as count
                    FROM thumb_status INDEXED BY idx_thumb_status_status
                    WHERE status IN ('missing', 'failed', 'pending', 'processing', 'exists', 'permanent_failed')
                    GROUP BY status
                `);
                logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 当前状态统计: ${statusCounts.map(s => `${s.status}:${s.count}`).join(', ')}`);
            }

            // 调试：显示前5个需要补全的文件
            if (missingThumbs && missingThumbs.length > 0) {
                const samplePaths = missingThumbs.slice(0, 5).map(row => row.path);
                logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 示例文件: ${samplePaths.join(', ')}`);
            }

            if (missingThumbs.length === 0) {
                return {
                    success: true,
                    message: '没有发现需要补全的缩略图',
                    processed: 0,
                    queued: 0,
                    skipped: 0,
                    foundMissing: 0  // 关键：没有找到缺失的缩略图
                };
            }

            let queued = 0;
            let skipped = 0;
            let cooldownEnforced = false;
            let yieldCount = 0;

            for (let i = 0; i < missingThumbs.length; i += 1) {
                // 持续等待直到按需任务清空
                while (await orchestrator.isHeavy()) {
                    yieldCount++;
                    const ondemandPending = (state.thumbnail.getActiveCount() || 0) + (state.thumbnail.getQueueLen() || 0);
                    if (yieldCount === 1) {
                        logger.info(`${LOG_PREFIXES.BATCH_BACKFILL} 检测到前台任务，批量补全完全暂停等待 (按需任务=${ondemandPending})`);
                    } else if (yieldCount % 10 === 0) {
                        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 继续等待前台任务完成 (按需任务=${ondemandPending}, 已等待${yieldCount}秒)`);
                    }
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

                // 恢复日志
                if (yieldCount > 0) {
                    logger.info(`${LOG_PREFIXES.BATCH_BACKFILL} 前台任务完成，批量补全恢复运行 (共等待${yieldCount}秒)`);
                    yieldCount = 0;
                }

                const rawRelativePath = missingThumbs[i].path;
                const sanitizedRelativePath = sanitizePath(rawRelativePath);
                if (!sanitizedRelativePath || !isPathSafe(sanitizedRelativePath)) {
                    skipped++;
                    continue;
                }

                if (missingThumbs[i].status === 'permanent_failed') {
                    skipped++;
                    continue;
                }

                const sourceAbsPath = path.join(PHOTOS_DIR_SAFE_ROOT, sanitizedRelativePath);
                try {
                    await fs.access(sourceAbsPath);
                } catch (error) {
                    if (error && error.code !== 'ENOENT') {
                        logThumbIgnore('批量任务验证源文件', error);
                    }
                    skipped++;
                    continue;
                }

                try {
                    const permanentKey = await safeRedisGet(redis, `thumb_failed_permanently:${sanitizedRelativePath}`, '批量检查永久失败标记');
                    if (permanentKey) {
                        await queueThumbStatusUpdate(sanitizedRelativePath, Date.now(), 'permanent_failed');
                        skipped++;
                        continue;
                    }
                } catch (permErr) {
                    logThumbIgnore('检查永久失败标记', permErr);
                }

                if (scheduler.hasActiveTask(sanitizedRelativePath)) {
                    skipped++;
                    continue;
                }

                const isVideo = /(\.mp4|\.webm|\.mov)$/i.test(sanitizedRelativePath);
                const task = { filePath: sourceAbsPath, relativePath: sanitizedRelativePath, type: isVideo ? 'video' : 'photo' };
                const dispatched = scheduler.dispatch(task, 'batch');
                if (dispatched) {
                    queued++;
                    try {
                        await markProcessing(sanitizedRelativePath);
                    } catch (e) {
                        logger.debug(`${LOG_PREFIXES.BATCH_BACKFILL} 更新任务状态失败: ${sanitizedRelativePath}, ${e.message}`);
                    }
                } else {
                    skipped++;
                }
            }

            logger.debug(`${LOG_PREFIXES.MANUAL_BACKFILL} 缩略图批量补全完成: 已排队 ${queued} 个任务，跳过 ${skipped} 个文件`);
            const batchDurationMs = Date.now() - batchStartTs;
            const now = Date.now();
            if (now - __lastBatchTelemetryLog >= TELEMETRY_LOG_INTERVAL_MS) {
                __lastBatchTelemetryLog = now;
                logger.info(`${LOG_PREFIXES.THUMB_METRICS} batch_dispatch`, {
                    processed: missingThumbs.length,
                    queued,
                    skipped,
                    durationMs: batchDurationMs,
                    cooldownMs: cooldownEnforced ? BATCH_COOLDOWN_MS : 0,
                    backlogPending: thumbMetrics.pending,
                    queuedLength: scheduler.getOndemandQueueLength()
                });
            }

            try {
                state.thumbnail.setBatchActive(false);
            } catch (error) {
                logThumbIgnore('批量任务结束时更新状态', error);
            }
            //   在循环批量模式下，不要销毁worker池，避免下一轮无法启动
            try {
                const active = state.thumbnail.getActiveCount();
                const qlen = state.thumbnail.getQueueLen();
                // 只有在非循环批量模式且确实空闲时才销毁worker池
                if (active === 0 && qlen === 0 && !state.thumbnail.isBatchLoopActive()) {
                    try {
                        // 销毁 worker 池时，Piscina 会终止所有 worker 线程，
                        // worker 进程的内存（包括 Sharp 缓存）会随之释放
                        workerManager.destroyThumbnailWorkerPool();
                        logger.debug(`${LOG_PREFIXES.THUMB} 批量任务完成，已销毁 worker 池（内存随线程释放）`);
                    } catch (error) {
                        logThumbIgnore('批量任务销毁缩略图线程池', error);
                    }
                }
            } catch (error) {
                logThumbIgnore('批量任务清理线程池状态', error);
            }
            return {
                success: true,
                message: `批量补全任务已启动`,
                processed: missingThumbs.length,  // 返回本批次处理的总数量
                queued: queued,                   // 返回实际排队的任务数量
                skipped: skipped,
                foundMissing: missingThumbs.length,  // 新增：本批次找到的缺失数量
                cooldownApplied: cooldownEnforced,
                durationMs: batchDurationMs
            };
        } catch (error) {
            logger.error('批量补全缩略图失败:', error);
            try {
                state.thumbnail.setBatchActive(false);
            } catch (resetError) {
                logThumbIgnore('批量任务错误时恢复状态', resetError);
            }
            throw error;
        } finally {
            state.thumbnail.setBatchActive(false);
        }
    }


    return batchGenerateMissingThumbnails;
}

module.exports = { createBackfill };

// Coalesces status changes independently of task scheduling and worker execution.
function createStatusWriter({ repo, orchestrator, redis, logger, LOG_PREFIXES, retryDelayMs = 1000 }) {
    class ThumbStatusManager {
        constructor() {
            this.repo = repo;
            this.orchestrator = orchestrator;
        }

        /**
         * 准备批量数据
         */
        prepareBatchData(snapshot) {
            return snapshot.map(([relPath, v]) => [
                relPath,
                v.mtime || Date.now(),
                v.status || 'pending'
            ]).filter(row => row[0]); // 过滤掉空路径
        }

        /**
         * 批量写入缩略图状态
         */
        async batchUpsert(rows, redis) {
            try {
                await this.orchestrator.withAdmission('thumb-status-upsert', async () => {
                    await this.repo.upsertBatch(rows, { manageTransaction: true, chunkSize: 400 }, redis);
                });
                // 小批次静默处理，避免日志刷屏（仓库层已有相同阈值）
                if (rows.length >= 10) {
                    logger.debug(`${LOG_PREFIXES.THUMB} 批量写入缩略图状态成功`, { count: rows.length });
                }
                return { success: true, rowsAffected: rows.length };
            } catch (e) {
                // 兜底：即便闸门封装异常也直接写一次，确保最终可达
                await this.repo.upsertBatch(rows, { manageTransaction: true, chunkSize: 400 }, redis);
                if (rows.length >= 10) {
                    logger.debug(`${LOG_PREFIXES.THUMB} 兜底批量写入成功`, { count: rows.length });
                }
                return { success: true, rowsAffected: rows.length };
            }
        }

        /**
         * 逐条重试失败的记录
         */
        async retryIndividual(rows, redis) {
            let successCount = 0;
            let failureCount = 0;

            for (const [pathRel, mtime, status] of rows) {
                try {
                    // 清理路径并验证参数
                    const cleanPath = String(pathRel || '').replace(/\\/g, '/').trim();
                    if (!cleanPath) {
                        logger.warn(`跳过空路径的缩略图状态更新`);
                        failureCount++;
                        continue;
                    }

                    await this.repo.upsertSingle(cleanPath, Number(mtime) || Date.now(), String(status || 'pending'), redis);
                    successCount++;
                } catch (retryError) {
                    failureCount++;
                    const displayPath = String(pathRel || '').length > 50 ?
                        String(pathRel).substring(0, 50) + '...' : pathRel;
                    logger.error(`${LOG_PREFIXES.THUMB} 缩略图状态写入失败`, {
                        path: pathRel,
                        displayPath,
                        mtime,
                        status,
                        error: retryError?.message,
                        code: retryError?.code
                    });
                }
            }

            return { successCount, failureCount };
        }

        /**
         * 执行批量刷新
         */
        async executeBatchFlush(snapshot, redis) {
            const rows = this.prepareBatchData(snapshot);
            if (rows.length === 0) return { success: true, rowsAffected: 0 };

            try {
                return await this.batchUpsert(rows, redis);
            } catch (e) {
                logger.warn(`批量写入缩略图状态失败，回退为逐条重试: ${e.message}`);
                const retryResult = await this.retryIndividual(rows, redis);

                if (retryResult.successCount > 0 || retryResult.failureCount > 0) {
                    logger.debug(`${LOG_PREFIXES.THUMB} 逐条重试完成`, { success: retryResult.successCount, failed: retryResult.failureCount });
                }

                return {
                    success: retryResult.successCount > 0,
                    rowsAffected: retryResult.successCount,
                    retryResult
                };
            }
        }
    }


    const manager = new ThumbStatusManager();
    const pending = new Map();
    let flushing = null;
    let retryTimer = null;
    let stopped = false;

    function restore(snapshot) {
        for (const [relativePath, payload] of snapshot) {
            const current = pending.get(relativePath);
            if (!current || payload.mtime >= current.mtime) pending.set(relativePath, payload);
        }
    }

    function flush() {
        if (flushing) return flushing;
        flushing = Promise.resolve().then(async () => {
            while (pending.size > 0) {
                const snapshot = [...pending.entries()];
                pending.clear();
                try {
                    const result = await manager.executeBatchFlush(snapshot, redis);
                    if (result.rowsAffected !== snapshot.filter(([relativePath]) => relativePath).length) {
                        throw new Error('Some thumbnail status updates could not be persisted');
                    }
                } catch (error) {
                    restore(snapshot);
                    throw error;
                }
            }
        }).finally(() => { flushing = null; });
        // Keep failed rows and retry with a timer, rather than spinning in microtasks or losing updates.
        flushing.catch(error => {
            logger.error(`${LOG_PREFIXES.THUMB} 批量刷新缩略图状态失败`, { error: error.message });
            if (!stopped && !retryTimer) {
                retryTimer = setTimeout(() => { retryTimer = null; flush(); }, retryDelayMs);
                retryTimer.unref?.();
            }
        });
        return flushing;
    }

    async function queueUpdate(relativePath, mtime, status) {
        if (stopped) return;
        const payload = { mtime: mtime || Date.now(), status };
        const previous = pending.get(relativePath);
        if (!previous || payload.mtime >= previous.mtime) pending.set(relativePath, payload);
        flush();
    }

    async function stop() {
        stopped = true;
        clearTimeout(retryTimer);
        retryTimer = null;
        await flush();
    }

    return { queueUpdate, flush, stop };
}

module.exports = { createStatusWriter };

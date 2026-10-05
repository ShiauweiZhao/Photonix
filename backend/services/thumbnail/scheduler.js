const PQueue = require('p-queue').default;

// Owns queue admission, deduplication, concurrency, counters and all scheduling timers.
function createThumbnailScheduler({ normalizeThumbnailTask, onResult, state, thumbMetrics,
    workerManager, logger, LOG_PREFIXES, throttledLog, TraceManager, RetryManager, failureTimestamps,
    NUM_WORKERS, THUMB_ONDEMAND_RESERVE, logThumbIgnore, THUMBS_DIR, env = process.env }) {
    const { noteThumbnailUse, scaleThumbnailWorkerPool,
        destroyThumbnailWorkerPool, runThumbnailTask } = workerManager;
    let stopped = false;
    const retryTimers = new Set();
    // 简化的任务管理
    const activeTasks = new Set();          // 正在处理的任务集合
    const activeTaskContexts = new Map();   // relativePath -> context (ondemand/batch)
    const activeCounts = { ondemand: 0, batch: 0 };  // 正在执行的任务数
    // 注意：重试计数由 RetryManager 在 Redis 中持久化管理，此处仅保留时间戳用于指标
    // 失败时间戳与 Worker 结果处理共享，重试计数由 RetryManager 管理。

    // 按需任务比批量任务拥有更高优先级。
    const MAX_ONDEMAND_QUEUE = Number(env.THUMB_ONDEMAND_QUEUE_MAX || 2000);
    const MAX_BATCH_QUEUE = Number(env.THUMB_BATCH_QUEUE_MAX || 5000);
    const QUEUE_FULL_WARN_INTERVAL_MS = Math.max(1000, Number(env.THUMB_QUEUE_WARN_INTERVAL_MS || 5000));
    const QUEUE_FULL_DEBUG_INTERVAL_MS = Math.max(5000, Number(env.THUMB_QUEUE_DEBUG_INTERVAL_MS || 30000));
    const ENQUEUE_LOG_INTERVAL_MS = Math.max(1000, Number(env.THUMB_QUEUE_ENQUEUE_LOG_INTERVAL_MS || 2000));
    // 仅当排队数较上次增加到 100 条时才追加一条日志，避免高并发时刷屏
    const ENQUEUE_LOG_STEP = Math.max(10, Number(env.THUMB_QUEUE_ENQUEUE_LOG_STEP || 100));

    const pendingTasks = new Map(); // relativePath -> context
    const pendingCounts = { ondemand: 0, batch: 0 };
    const thumbQueue = new PQueue({ concurrency: resolveThumbConcurrencyLimit() });
    thumbQueue.on('idle', () => scheduleIdlePoolDestroy());

    // 按需空闲销毁：当按需队列清空且无在途任务时，短延时销毁线程池（更符合“本目录生成完后退出”）
    let __idleDestroyTimer = null;
    const THUMB_ONDEMAND_IDLE_DESTROY_MS = Number(env.THUMB_ONDEMAND_IDLE_DESTROY_MS || 30000);
    let lastQueueFullWarnAt = 0;
    let lastQueueFullDebugAt = 0;
    const enqueueLogState = {
        ondemand: { lastCount: 0, lastAt: 0, loggedOnce: false },
        batch: { lastCount: 0, lastAt: 0, loggedOnce: false }
    };

    function scheduleIdlePoolDestroy() {
        if (stopped) return;
        try {
            if (__idleDestroyTimer) clearTimeout(__idleDestroyTimer);
            __idleDestroyTimer = setTimeout(() => {
                try {
                    if ((pendingCounts.ondemand + pendingCounts.batch) === 0 && state.thumbnail.getActiveCount() === 0) {
                        destroyThumbnailWorkerPool();
                    }
                } catch (error) {
                    logThumbIgnore('缩回缩略图线程池', error);
                }
            }, THUMB_ONDEMAND_IDLE_DESTROY_MS);
        } catch (error) {
            logThumbIgnore('安排缩略图线程池缩容', error);
        }
    }
    // 需求信号指标：供自适应增压判断是否需要扩容
    function refreshThumbMetrics() {
        const active = state.thumbnail.getActiveCount();
        const queued = pendingCounts.ondemand + pendingCounts.batch;
        thumbMetrics.processing = active;
        thumbMetrics.queued = queued;
        thumbMetrics.pending = active + queued;
        thumbMetrics.lastUpdatedAt = Date.now();
        // 关键：只记录按需队列长度，供批量补全让路判断使用
        state.thumbnail.setQueueLen(pendingCounts.ondemand);
    }

    refreshThumbMetrics();

    function resolveThumbConcurrencyLimit() {
        // 直接使用 NUM_WORKERS（已在 runtime.js 中智能计算，考虑了 I/O 超配）
        const hardLimit = Math.max(1, Math.floor(Number(NUM_WORKERS) || 1));
        const softCap = Math.max(1, Number(env.THUMB_MAX_CONCURRENCY || Math.min(hardLimit, 6)));
        return Math.min(hardLimit, softCap);
    }

    function synchronizeQueueCapacity() {
        const maxConcurrency = resolveThumbConcurrencyLimit();
        ensureThumbnailPoolCapacity(maxConcurrency);
        if (thumbQueue.concurrency !== maxConcurrency) {
            thumbQueue.concurrency = maxConcurrency;
        }
    }

    function triggerIdleDestroyCheck() {
        if (
            pendingCounts.ondemand === 0 &&
            pendingCounts.batch === 0 &&
            state.thumbnail.getActiveCount() === 0 &&
            thumbQueue.size === 0 &&
            thumbQueue.pending === 0
        ) {
            scheduleIdlePoolDestroy();
        }
    }

    async function runQueuedTask(task, context, traceData) {
        if (pendingTasks.delete(task.relativePath)) {
            pendingCounts[context] = Math.max(0, pendingCounts[context] - 1);
            refreshThumbMetrics();
        }
        try {
            await startThumbnailTask(task, context, traceData);
        } finally {
            triggerIdleDestroyCheck();
        }
    }

    // 内存清理配置
    const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30分钟清理一次
    const FAILURE_ENTRY_TTL_MS = 24 * 60 * 60 * 1000; // 失败记录保留24小时
    const ACTIVE_TASK_TTL_MS = 60 * 60 * 1000; // 活动任务记录保留1小时

    // 任务记录的时间戳追踪
    const taskTimestamps = new Map();

    // 定期清理过期记录
    let cleanupTimer = null;
    function start() {
        if (stopped || cleanupTimer) return;
        cleanupTimer = setInterval(() => {
            const now = Date.now();
            let cleanedFailures = 0;
            let cleanedTasks = 0;

            // 清理失败时间戳记录（重试计数由 RetryManager 通过 Redis TTL 自动清理）
            const expiredPaths = [];
            for (const [path, timestamp] of failureTimestamps.entries()) {
                if ((now - timestamp) > FAILURE_ENTRY_TTL_MS) {
                    failureTimestamps.delete(path);
                    expiredPaths.push(`thumb:${path}`); // 收集需要清理的 RetryManager 上下文
                    cleanedFailures++;
                }
            }

            // 清理 RetryManager 的降级计数（仅在 Redis 不可用时才存在）
            if (expiredPaths.length > 0) {
                RetryManager.clearFallbackCounts(expiredPaths);
            }

            // 清理活动任务记录（防止任务卡住）
            for (const path of activeTasks) {
                const timestamp = taskTimestamps.get(path);
                if (timestamp && (now - timestamp) > ACTIVE_TASK_TTL_MS) {
                    activeTasks.delete(path);
                    taskTimestamps.delete(path);
                    cleanedTasks++;
                }
            }

            // 清理时间戳记录
            for (const [path, timestamp] of taskTimestamps.entries()) {
                if ((now - timestamp) > Math.max(FAILURE_ENTRY_TTL_MS, ACTIVE_TASK_TTL_MS)) {
                    taskTimestamps.delete(path);
                }
            }

            if (cleanedFailures > 0 || cleanedTasks > 0) {
                logger.debug(`${LOG_PREFIXES.THUMBNAIL_CLEANUP} 清理了 ${cleanedFailures} 个失败记录和 ${cleanedTasks} 个过期任务`);
            }
        }, CLEANUP_INTERVAL_MS);
        // 允许进程退出（定时器不阻止进程退出）
        if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
    }


    // 更新任务时间戳的辅助函数
    function updateTaskTimestamp(path) {
        taskTimestamps.set(path, Date.now());
    }

    function dispatchThumbnailTask(task, context = 'ondemand') {
        if (stopped) return false;
        start();
        const safeTask = normalizeThumbnailTask(task);
        if (!safeTask) {
            return false;
        }

        const label = context === 'batch' ? 'batch' : 'ondemand';
        const maxQueue = label === 'ondemand' ? MAX_ONDEMAND_QUEUE : MAX_BATCH_QUEUE;

        if (activeTasks.has(safeTask.relativePath) || pendingTasks.has(safeTask.relativePath)) {
            return true;
        }

        synchronizeQueueCapacity();

        const traceContext = TraceManager.getCurrentContext();
        const traceData = traceContext ? traceContext.toObject() : null;

        // 预留槽位检查：只在有按需任务时才限制批量（按需预留，而非永久预留）
        if (label === 'batch' && THUMB_ONDEMAND_RESERVE > 0) {
            // 关键：检查是否有按需任务在排队或执行
            const ondemandPending = activeCounts.ondemand + pendingCounts.ondemand;

            if (ondemandPending > 0) {
                // 有按需任务时，限制批量使用量
                const totalConcurrency = thumbQueue.concurrency;
                const availableForBatch = Math.max(1, totalConcurrency - THUMB_ONDEMAND_RESERVE);
                const currentBatchUsage = activeCounts.batch + pendingCounts.batch;

                if (currentBatchUsage >= availableForBatch) {
                    // 批量任务已用满可用槽位，拒绝派发（为按需任务保留）
                    const now = Date.now();
                    if (now - lastQueueFullDebugAt >= QUEUE_FULL_DEBUG_INTERVAL_MS) {
                        logger.debug(`${LOG_PREFIXES.BATCH_GENERATE} 检测到按需任务(${ondemandPending}个)，限制批量并发(${currentBatchUsage}/${availableForBatch})，预留${THUMB_ONDEMAND_RESERVE}个槽位`);
                        lastQueueFullDebugAt = now;
                    }
                    return false;
                }
            }
            // 没有按需任务时，批量可以使用所有worker（火力全开）
        }

        if (pendingCounts[label] >= maxQueue) {
            const now = Date.now();
            if (now - lastQueueFullWarnAt >= QUEUE_FULL_WARN_INTERVAL_MS) {
                const sample = safeTask?.relativePath ? `，示例=${safeTask.relativePath}` : '';
                logger.warn(`[${label === 'ondemand' ? '按需' : '批量'}队列] 已满(${maxQueue})，暂缓新任务${sample}`);
                lastQueueFullWarnAt = now;
            }
            return false;
        }

        pendingTasks.set(safeTask.relativePath, label);
        pendingCounts[label] += 1;
        refreshThumbMetrics();
        const now = Date.now();
        const stateForLabel = enqueueLogState[label];
        const isFirstFew = pendingCounts[label] <= 3;
        const steppedIncrease = pendingCounts[label] - stateForLabel.lastCount >= ENQUEUE_LOG_STEP;
        const intervalElapsed = now - stateForLabel.lastAt >= ENQUEUE_LOG_INTERVAL_MS;
        const shouldLog = !stateForLabel.loggedOnce || (isFirstFew || ((steppedIncrease || intervalElapsed) && pendingCounts[label] > stateForLabel.lastCount));
        if (shouldLog) {
            // 使用节流日志，避免高并发时刷屏
            throttledLog('debug', `thumb-enqueue-${label}`,
                `${LOG_PREFIXES.THUMB} ${label === 'ondemand' ? '按需' : '批量'}任务排队中`,
                { queue: pendingCounts[label], active: state.thumbnail.getActiveCount(), limit: thumbQueue.concurrency },
                ENQUEUE_LOG_INTERVAL_MS
            );
            stateForLabel.lastCount = pendingCounts[label];
            stateForLabel.lastAt = now;
            stateForLabel.loggedOnce = true;
        }
        const priority = label === 'ondemand' ? 2 : 1; // PQueue runs higher numeric priorities first.
        thumbQueue.add(() => runQueuedTask(safeTask, label, traceData), { priority }).catch((error) => {
            logThumbIgnore('缩略图任务队列执行', error);
        });
        return true;
    }

    async function startThumbnailTask(task, context, traceData) {
        const logPrefix = context === 'batch' ? LOG_PREFIXES.BATCH_BACKFILL : LOG_PREFIXES.ONDEMAND_GENERATE;
        const label = context === 'batch' ? 'batch' : 'ondemand';

        activeTasks.add(task.relativePath);
        activeTaskContexts.set(task.relativePath, label);
        activeCounts[label] += 1;
        updateTaskTimestamp(task.relativePath);
        state.thumbnail.incrementActiveCount();
        refreshThumbMetrics();
        const traceContext = traceData ? null : TraceManager.getCurrentContext();
        const payload = {
            task: { ...task, thumbsDir: THUMBS_DIR },
            trace: traceData || (traceContext ? traceContext.toObject() : null),
        };

        // 缩略图任务派发成功，详细日志已在队列入队时输出，此处不再重复
        try {
            noteThumbnailUse();
        } catch (error) {
            logThumbIgnore('分派缩略图任务使用记录', error);
        }

        try {
            const result = await runThumbnailTask(payload);
            await onResult(task, result);
        } catch (error) {
            logThumbIgnore('缩略图任务执行异常', error);
            await onResult(task, {
                success: false,
                error: { message: error && error.message ? error.message : 'Thumbnail worker failure' }
            });
        } finally {
            finalizeWorkerCycle(task.relativePath);
        }
    }

    function finalizeWorkerCycle(relativePath) {
        // 减少活跃任务计数
        const taskContext = activeTaskContexts.get(relativePath);
        if (taskContext) {
            activeCounts[taskContext] = Math.max(0, activeCounts[taskContext] - 1);
            activeTaskContexts.delete(relativePath);
        }

        activeTasks.delete(relativePath);
        state.thumbnail.decrementActiveCount();
        refreshThumbMetrics();
        try {
            noteThumbnailUse();
        } catch (error) {
            logThumbIgnore('更新缩略图使用指标', error);
        }
        triggerIdleDestroyCheck();
    }

    function ensureThumbnailPoolCapacity(limit) {
        const desiredSize = Math.max(1, Math.min(Math.floor(limit), NUM_WORKERS || 1));
        try {
            scaleThumbnailWorkerPool(desiredSize);
        } catch (error) {
            logThumbIgnore('调整缩略图线程池大小', error);
        }
    }


    function scheduleRetry(callback, delay) {
        if (stopped) return;
        const timer = setTimeout(() => {
            retryTimers.delete(timer);
            if (!stopped) callback();
        }, delay);
        retryTimers.add(timer);
    }

    async function stop() {
        stopped = true;
        clearInterval(cleanupTimer);
        clearTimeout(__idleDestroyTimer);
        for (const timer of retryTimers) clearTimeout(timer);
        retryTimers.clear();
        thumbQueue.pause();
        thumbQueue.clear();
        pendingTasks.clear();
        pendingCounts.ondemand = 0;
        pendingCounts.batch = 0;
        refreshThumbMetrics();
        await thumbQueue.onIdle();
        await destroyThumbnailWorkerPool();
    }

    return {
        dispatch: dispatchThumbnailTask, refreshMetrics: refreshThumbMetrics,
        hasActiveTask: relativePath => activeTasks.has(relativePath),
        getOndemandQueueLength: () => pendingCounts.ondemand,
        onIdle: () => thumbQueue.onIdle(), scheduleRetry, stop,
    };
}

module.exports = { createThumbnailScheduler };

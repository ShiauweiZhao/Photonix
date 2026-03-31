/**
 * @file archiveWatcher.service.js
 * @description 压缩包监听服务，自动检测并解压目录中的压缩包
 */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const chokidar = require('chokidar');
const ArchiveExtractor = require('./download/ArchiveExtractor');
const logger = require('../config/logger');

const { LOG_PREFIXES } = logger;

// 支持的压缩包扩展名
const ARCHIVE_EXTENSIONS = ['.zip', '.rar', '.7z'];

class ArchiveWatcherService {
  constructor() {
    this.watcher = null;
    this.extractor = null;
    this.watchPaths = [];
    this.isProcessing = new Map(); // 防止重复处理
    this.config = {
      enabled: true,
      deleteAfterExtract: true,
      maxExtractSize: 500 * 1024 * 1024, // 500MB
      maxFileCount: 500,
      maxExtractTime: 60,
      allowedMediaTypes: [
        'image/jpeg', 'image/png', 'image/gif', 'image/webp',
        'image/bmp', 'image/tiff', 'image/svg+xml',
        'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo'
      ]
    };
  }

  /**
   * 初始化服务
   * @param {object} options 配置选项
   */
  async initialize(options = {}) {
    this.config = { ...this.config, ...options };

    // 初始化解压器
    this.extractor = new ArchiveExtractor({
      archiveExtraction: this.config
    }, {
      log: (level, message, data) => {
        // 映射 level: ArchiveExtractor 用 'warning'/'success', winston 用 'warn'/'info'
        const levelMap = { warning: 'warn', success: 'info', error: 'error' };
        const mappedLevel = levelMap[level] || 'info';
        logger[mappedLevel](`${LOG_PREFIXES.INDEXER_SERVICE} [ArchiveWatcher] ${message}`, data);
      }
    });

    // 获取要监听的路径
    this.watchPaths = options.watchPaths || this.getDefaultWatchPaths();

    if (!this.config.enabled) {
      logger.info(`${LOG_PREFIXES.INDEXER_SERVICE} [ArchiveWatcher] 压缩包监听已禁用`);
      return;
    }

    // 先扫描现有文件
    await this.scanExistingArchives();

    // 启动文件监听
    this.startWatcher();

    logger.info(`${LOG_PREFIXES.INDEXER_SERVICE} [ArchiveWatcher] 服务已启动，监听路径: ${this.watchPaths.join(', ')}`);
  }

  /**
   * 获取默认监听路径
   */
  getDefaultWatchPaths() {
    const paths = [];

    // 下载目录
    const downloadPath = process.env.PHOTONIX_DOWNLOAD_PATH || path.join(process.env.DATA_DIR || './data', 'downloads');
    paths.push(downloadPath);

    // photos 目录
    const photosDir = process.env.PHOTOS_DIR || './photos';
    paths.push(photosDir);

    return paths.filter(p => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
  }

  /**
   * 扫描现有压缩包
   */
  async scanExistingArchives() {
    logger.info(`${LOG_PREFIXES.INDEXER_SERVICE} [ArchiveWatcher] 扫描现有压缩包...`);

    for (const watchPath of this.watchPaths) {
      try {
        await this.scanDirectory(watchPath);
      } catch (error) {
        logger.warn(`${LOG_PREFIXES.INDEXER_SERVICE} [ArchiveWatcher] 扫描目录失败: ${watchPath}`, { error: error.message });
      }
    }
  }

  /**
   * 递归扫描目录
   */
  async scanDirectory(dirPath) {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        // 递归扫描子目录
        await this.scanDirectory(fullPath);
      } else if (entry.isFile()) {
        // 检查是否为压缩包
        if (this.isArchiveFile(fullPath)) {
          await this.processArchive(fullPath);
        }
      }
    }
  }

  /**
   * 启动文件监听器
   */
  startWatcher() {
    if (this.watcher) {
      this.watcher.close();
    }

    this.watcher = chokidar.watch(this.watchPaths, {
      ignored: /(^|[\/\\])\../, // 忽略隐藏文件
      persistent: true,
      ignoreInitial: true, // 忽略初始扫描
      awaitWriteFinish: {
        stabilityThreshold: 2000, // 文件稳定2秒后才处理
        pollInterval: 100
      }
    });

    this.watcher.on('add', (filePath) => {
      if (this.isArchiveFile(filePath)) {
        this.processArchive(filePath);
      }
    });

    this.watcher.on('error', (error) => {
      logger.error(`${LOG_PREFIXES.INDEXER_SERVICE} [ArchiveWatcher] 监听器错误`, { error: error.message });
    });
  }

  /**
   * 检查是否为压缩包文件
   */
  isArchiveFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return ARCHIVE_EXTENSIONS.includes(ext);
  }

  /**
   * 处理压缩包
   */
  async processArchive(archivePath) {
    // 防止重复处理
    if (this.isProcessing.get(archivePath)) {
      return;
    }
    this.isProcessing.set(archivePath, true);

    try {
      logger.info(`${LOG_PREFIXES.INDEXER_SERVICE} [ArchiveWatcher] 发现压缩包: ${archivePath}`);

      // 获取目标目录（压缩包所在目录）
      const targetDir = path.dirname(archivePath);

      // 解压
      const result = await this.extractor.extractArchive(archivePath, targetDir);

      if (result.success) {
        logger.info(
          `${LOG_PREFIXES.INDEXER_SERVICE} [ArchiveWatcher] 解压成功: ${result.files.length} 个文件`,
          {
            archivePath,
            extractedCount: result.files.length,
            totalSize: this.extractor.formatBytes(result.totalSize)
          }
        );

        // 触发索引更新（如果解压到 photos 目录）
        const photosDir = path.resolve(process.env.PHOTOS_DIR || './photos');
        if (archivePath.startsWith(photosDir)) {
          // 通知索引服务有新文件
          const indexerService = require('./indexer.service');
          for (const file of result.files) {
            if (indexerService.enqueueIndexChange) {
              indexerService.enqueueIndexChange({ type: 'add', filePath: file.path });
            }
          }
          // 触发索引处理
          if (indexerService.triggerDelayedIndexProcessing) {
            indexerService.triggerDelayedIndexProcessing();
          }
        }
      } else {
        logger.warn(
          `${LOG_PREFIXES.INDEXER_SERVICE} [ArchiveWatcher] 解压失败: ${result.error}`,
          { archivePath }
        );
      }
    } catch (error) {
      logger.error(
        `${LOG_PREFIXES.INDEXER_SERVICE} [ArchiveWatcher] 处理压缩包异常`,
        { archivePath, error: error.message }
      );
    } finally {
      this.isProcessing.delete(archivePath);
    }
  }

  /**
   * 添加监听路径
   */
  addWatchPath(dirPath) {
    if (!this.watchPaths.includes(dirPath)) {
      this.watchPaths.push(dirPath);
      if (this.watcher) {
        this.watcher.add(dirPath);
      }
      // 扫描新路径中的现有压缩包
      this.scanDirectory(dirPath).catch(() => {});
    }
  }

  /**
   * 手动触发解压
   */
  async extractNow(archivePath, targetDir) {
    return this.extractor.extractArchive(archivePath, targetDir || path.dirname(archivePath));
  }

  /**
   * 停止服务
   */
  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    logger.info(`${LOG_PREFIXES.INDEXER_SERVICE} [ArchiveWatcher] 服务已停止`);
  }

  /**
   * 获取服务状态
   */
  getStatus() {
    return {
      enabled: this.config.enabled,
      watching: this.watcher !== null,
      watchPaths: this.watchPaths,
      processing: Array.from(this.isProcessing.keys())
    };
  }
}

// 单例
const archiveWatcherService = new ArchiveWatcherService();

module.exports = archiveWatcherService;

/**
 * @file ArchiveExtractor.js
 * @description 压缩包解压器，负责解压压缩包并提取媒体文件
 */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const AdmZip = require('adm-zip');
const mime = require('mime-types');

// 支持的压缩包格式
const ARCHIVE_EXTENSIONS = {
  '.zip': 'zip',
  '.rar': 'rar',
  '.7z': '7z'
};

// 默认允许的媒体类型
const DEFAULT_ALLOWED_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo'
];

class ArchiveExtractor {
  constructor(config, logger) {
    this.config = config || {};
    this.logger = logger;

    // 解压配置
    const archiveConfig = config.archiveExtraction || {};
    this.enabled = archiveConfig.enabled !== false;
    this.supportedFormats = archiveConfig.supportedFormats || ['zip'];
    this.deleteAfterExtract = archiveConfig.deleteAfterExtract !== false;
    this.maxExtractSize = archiveConfig.maxExtractSize || 500 * 1024 * 1024; // 500MB
    this.maxFileCount = archiveConfig.maxFileCount || 500;
    this.maxExtractTime = archiveConfig.maxExtractTime || 60; // 60秒
    this.allowedMediaTypes = archiveConfig.allowedMediaTypes || DEFAULT_ALLOWED_MEDIA_TYPES;
  }

  /**
   * 解压压缩包
   * @param {string} archivePath 压缩包路径
   * @param {string} targetDir 目标目录
   * @returns {Promise<object>} 解压结果 { success, files, totalSize, error }
   */
  async extractArchive(archivePath, targetDir) {
    if (!this.enabled) {
      return { success: false, files: [], error: 'Archive extraction is disabled' };
    }

    const startTime = Date.now();
    const format = this.detectArchiveType(archivePath);

    if (!format) {
      return { success: false, files: [], error: 'Unsupported archive format' };
    }

    if (!this.supportedFormats.includes(format)) {
      return { success: false, files: [], error: `Format '${format}' is not supported` };
    }

    // 检查压缩包大小
    try {
      const stats = await fsp.stat(archivePath);
      if (stats.size > this.maxExtractSize) {
        return {
          success: false,
          files: [],
          error: `Archive size (${this.formatBytes(stats.size)}) exceeds limit (${this.formatBytes(this.maxExtractSize)})`
        };
      }
    } catch (error) {
      return { success: false, files: [], error: `Cannot read archive: ${error.message}` };
    }

    // 创建以压缩包名命名的解压目录
    const archiveBasename = path.basename(archivePath, path.extname(archivePath));
    const extractDir = path.join(targetDir, archiveBasename);
    await fsp.mkdir(extractDir, { recursive: true });

    try {
      let extractedFiles = [];

      // 设置超时
      const timeoutMs = this.maxExtractTime * 1000;
      const extractPromise = this._extractByFormat(archivePath, extractDir, format);

      // 使用超时包装
      const result = await Promise.race([
        extractPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Extraction timeout')), timeoutMs)
        )
      ]);

      extractedFiles = result;

      // 安全检查：验证所有文件路径
      extractedFiles = extractedFiles.filter(file => {
        const isValid = this.validateExtractedPath(file.path, extractDir);
        if (!isValid && this.logger) {
          this.logger.log('warning', `Blocked unsafe path in archive: ${file.path}`);
        }
        return isValid;
      });

      // 检查文件数量
      if (extractedFiles.length > this.maxFileCount) {
        await this.cleanupExtractedFiles(extractDir);
        return {
          success: false,
          files: [],
          error: `Too many files (${extractedFiles.length}) in archive, max is ${this.maxFileCount}`
        };
      }

      // 计算总大小
      let totalSize = 0;
      for (const file of extractedFiles) {
        totalSize += file.size || 0;
      }

      // 过滤媒体文件
      const mediaFiles = this.filterMediaFiles(extractedFiles);

      // 删除非媒体文件（保持解压目录干净）
      const nonMediaFiles = extractedFiles.filter(f => !mediaFiles.includes(f));
      for (const file of nonMediaFiles) {
        try { await fsp.unlink(file.path); } catch {}
      }

      // 媒体文件已经在 extractDir 中，直接使用
      const finalFiles = mediaFiles.map(file => ({
        path: file.path,
        filename: path.basename(file.path),
        size: file.size,
        mimeType: file.mimeType
      }));

      // 删除原压缩包
      if (this.deleteAfterExtract) {
        try {
          await fsp.unlink(archivePath);
        } catch (error) {
          // 忽略删除失败
        }
      }

      const durationMs = Date.now() - startTime;

      if (this.logger) {
        this.logger.log('success', `Extracted ${finalFiles.length} media files from archive`, {
          archivePath,
          fileCount: finalFiles.length,
          totalSize: this.formatBytes(totalSize),
          durationMs
        });
      }

      return {
        success: true,
        files: finalFiles,
        totalSize,
        durationMs
      };
    } catch (error) {
      // 清理解压目录
      await this.cleanupExtractedFiles(extractDir);

      if (this.logger) {
        this.logger.log('error', `Archive extraction failed: ${error.message}`, {
          archivePath,
          error: error.message
        });
      }

      return { success: false, files: [], error: error.message };
    }
  }

  /**
   * 根据格式解压
   * @private
   */
  async _extractByFormat(archivePath, extractDir, format) {
    if (format === 'zip') {
      return this._extractZip(archivePath, extractDir);
    }

    // RAR 和 7z 需要系统工具
    if (format === 'rar') {
      return this._extractWithTool(archivePath, extractDir, 'unrar');
    }

    if (format === '7z') {
      return this._extractWithTool(archivePath, extractDir, '7z');
    }

    throw new Error(`Unsupported format: ${format}`);
  }

  /**
   * 解压 ZIP 文件
   * @private
   */
  async _extractZip(archivePath, extractDir) {
    const zip = new AdmZip(archivePath);
    const zipEntries = zip.getEntries();

    const extractedFiles = [];
    let totalSize = 0;

    for (const entry of zipEntries) {
      // 跳过目录
      if (entry.isDirectory) continue;

      const entryPath = entry.entryName;

      // 路径安全检查
      if (!this.validateExtractedPath(entryPath, extractDir)) {
        continue;
      }

      const destPath = path.join(extractDir, entryPath);

      // 确保父目录存在
      await fsp.mkdir(path.dirname(destPath), { recursive: true });

      // 解压文件
      zip.extractEntryTo(entry, path.dirname(destPath), false, true);

      // 获取文件信息
      const stats = await fsp.stat(destPath);
      totalSize += stats.size;

      extractedFiles.push({
        path: destPath,
        originalPath: entryPath,
        size: stats.size,
        mimeType: mime.lookup(destPath) || 'application/octet-stream'
      });
    }

    return extractedFiles;
  }

  /**
   * 使用系统工具解压（RAR/7z）
   * @private
   */
  async _extractWithTool(archivePath, extractDir, tool) {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    // 检查工具是否可用
    try {
      await execAsync(`which ${tool}`);
    } catch {
      throw new Error(`Tool '${tool}' is not installed. Please install it to extract ${path.extname(archivePath)} files.`);
    }

    // 执行解压命令
    let cmd;
    if (tool === 'unrar') {
      cmd = `unrar x -o+ "${archivePath}" "${extractDir}/"`;
    } else {
      cmd = `7z x -y "${archivePath}" -o"${extractDir}"`;
    }

    await execAsync(cmd);

    // 遍历解压后的文件
    const extractedFiles = [];
    await this._walkDir(extractDir, async (filePath) => {
      const stats = await fsp.stat(filePath);
      extractedFiles.push({
        path: filePath,
        originalPath: path.relative(extractDir, filePath),
        size: stats.size,
        mimeType: mime.lookup(filePath) || 'application/octet-stream'
      });
    });

    return extractedFiles;
  }

  /**
   * 遍历目录
   * @private
   */
  async _walkDir(dir, callback) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await this._walkDir(fullPath, callback);
      } else {
        await callback(fullPath);
      }
    }
  }

  /**
   * 检测压缩包类型
   * @param {string} filePath 文件路径
   * @returns {string|null} 压缩包类型 (zip/rar/7z) 或 null
   */
  detectArchiveType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return ARCHIVE_EXTENSIONS[ext] || null;
  }

  /**
   * 检查文件是否为压缩包
   * @param {string} filePath 文件路径
   * @returns {boolean}
   */
  isArchive(filePath) {
    return this.detectArchiveType(filePath) !== null;
  }

  /**
   * 验证解压路径安全性
   * @param {string} filePath 文件路径
   * @param {string} targetDir 目标目录
   * @returns {boolean} 是否安全
   */
  validateExtractedPath(filePath, targetDir) {
    // 规范化路径
    const normalized = path.normalize(filePath);

    // 检查危险序列（针对 zip 内相对路径）
    if (normalized.includes('..') || normalized.includes('~')) {
      return false;
    }

    // 解析完整路径
    const resolvedPath = path.isAbsolute(normalized)
      ? normalized
      : path.resolve(targetDir, normalized);
    const resolvedTarget = path.resolve(targetDir);

    // 检查路径是否在目标目录内（防止 zip slip）
    if (!resolvedPath.startsWith(resolvedTarget + path.sep) && resolvedPath !== resolvedTarget) {
      return false;
    }

    return true;
  }

  /**
   * 过滤媒体文件
   * @param {Array} files 文件列表
   * @returns {Array} 过滤后的媒体文件列表
   */
  filterMediaFiles(files) {
    return files.filter(file => {
      const mimeType = file.mimeType || mime.lookup(file.path) || '';

      // 检查是否在允许列表中
      const isAllowed = this.allowedMediaTypes.some(type =>
        mimeType.startsWith(type) || mimeType === type
      );

      return isAllowed;
    });
  }

  /**
   * 清理解压的文件
   * @param {string} dir 目录路径
   */
  async cleanupExtractedFiles(dir) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch (error) {
      // 忽略清理错误
      if (this.logger) {
        this.logger.log('warning', `Failed to cleanup extraction directory: ${error.message}`);
      }
    }
  }

  /**
   * 格式化字节数
   */
  formatBytes(bytes) {
    const size = Number(bytes);
    if (!Number.isFinite(size) || size <= 0) return '0B';
    if (size < 1024) return `${size}B`;

    const units = ['KB', 'MB', 'GB', 'TB'];
    let index = -1;
    let value = size;

    do {
      value /= 1024;
      index += 1;
    } while (value >= 1024 && index < units.length - 1);

    return `${value.toFixed(value >= 10 ? 1 : 2)}${units[index]}`;
  }
}

module.exports = ArchiveExtractor;

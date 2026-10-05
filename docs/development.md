# 本地开发环境搭建

如果您希望手动运行 Photonix 而非使用 Docker，请参考以下步骤配置您的本地开发环境。

## 📋 前置需求

### 运行环境
- **Node.js**: v20.0.0 或更高版本。
- **Redis**: v6.0+ (用于服务端限流与缓存)。
- **FFmpeg**: 系统需安装 `ffmpeg` (且必须包含在系统 PATH 中)，用于视频转码与截帧。

### 外部服务 (可选)
- **OneAPI / OpenAI**: 如果需要 AI 识图功能，请准备相关的 API 密钥。

---

## 🛠️ 安装步骤

### 1. 克隆代码
```bash
git clone https://github.com/li88iioo/Photonix.git
cd Photonix
```

### 2. 安装依赖
```bash
# 安装后端依赖
cd backend && npm install

# 安装前端依赖 (Tailwind 构建)
cd ../frontend && npm install
```

### 3. 前端构建与联调 (关键步骤)
由于后端服务默认从 `backend/public` 目录读取静态资源，您需要先构建前端产生这些文件：

```bash
cd frontend
npm run build
```

**本地联调方案 (二选一)：**

- **方案 A (推荐 - 软链接)**：在 `backend` 目录下创建一个指向前端产物的符号链接，实现实时同步。
  ```bash
  # 从项目根目录运行；仅在目标文件尚不存在时创建软链接
  mkdir -p backend/public/js
  ln -s ../../frontend/index.html backend/public/index.html
  ln -s ../../frontend/manifest.json backend/public/manifest.json
  ln -s ../../frontend/sw.js backend/public/sw.js
  ln -s ../../frontend/sw-cache-manager.js backend/public/sw-cache-manager.js
  ln -s ../../frontend/assets backend/public/assets
  ln -s ../../../frontend/js/dist backend/public/js/dist
  ```
- **方案 B (手动拷贝)**：按照 Dockerfile 的逻辑手动拷贝。
  ```bash
  mkdir -p backend/public/js/dist
  cp frontend/index.html backend/public/
  cp frontend/manifest.json frontend/sw.js frontend/sw-cache-manager.js backend/public/
  cp -r frontend/assets backend/public/
  cp -r frontend/js/dist/* backend/public/js/dist/
  ```

### 4. 配置环境变量
将示例复制为 `.env`，替换示例密钥，并设置可读写的 `PHOTOS_DIR`、`DATA_DIR` 和实际 `REDIS_URL`。后端不使用 dotenv，需要由 shell 或进程管理器注入变量：
```bash
cp env.example/env.example .env
# 编辑 .env，确保设置了 JWT_SECRET 和 PHOTOS_DIR
set -a
source .env
set +a
```

### 5. 启动后端服务
```bash
cd backend
npm start
```

### 6. 启动前端构建 (开发模式)
```bash
cd frontend
npm run dev
```

---

## 💡 开发提示

- **数据库位置**：在本地运行模式下，SQLite 数据库文件将默认创建在 `backend/data/` 目录中。
- **日志级别**：可在 `.env` 中设置 `LOG_LEVEL=debug` 以获取更详细的调试信息。
- **端口映射**：后端默认监听 `13001`，Docker 对外默认映射 `12080`。直接运行时可通过 `PORT` 修改监听端口。

## 🧪 回归测试

从项目根目录运行：

```bash
npm --prefix backend test
npm --prefix frontend test
npm --prefix frontend run build
```

后端测试会启动临时服务，使用独立照片目录、端口和 SQLite 数据库，验证索引、浏览、搜索、缩略图、认证及权限检查；结束时删除测试数据。该测试不依赖运行中的 Redis，使用应用支持的无 Redis 模式。调度、状态写入、批量补全和原子输出分别有回归测试。

前端测试验证 Service Worker 缓存的过期时间、LRU 淘汰、登录令牌隔离、存储失败降级及构建版本隔离。GitHub Actions 会执行两套测试和前端构建。

缩略图公共接口仍由 `backend/services/thumbnail.service.js` 提供；具体职责位于 `backend/services/thumbnail/` 中的 `scheduler.js`、`status-writer.js`、`backfill.js`、`task-validator.js` 和 `output.js`。服务退出时会清理重试和排队任务、等待正在执行的任务，并刷新状态写入。

## 🧪 建议测试工具
- **Postman / Insomnia**：用于测试 RESTful API。
- **Redis Desktop Manager**：监控缓存与频率限制状态。

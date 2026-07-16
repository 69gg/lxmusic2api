# lxmusic2api

把 LX Music Desktop 的在线搜索、歌单、排行榜、评论、歌词、封面、跨平台匹配与自定义源 URL 解析能力，整理为无 GUI 的私有 HTTP API 服务。

作者：Null <pylindex@qq.com>

> [!IMPORTANT]
> 本项目仅用于技术学习与可行性研究，不提供音乐、不内置音频源，也不保证第三方数据或链接的合法性、准确性。使用前必须阅读 [Apache-2.0](./LICENSE) 与 [LX Music 补充协议](./LICENSES/LX-MUSIC-ADDITIONAL-zh-CN.txt)，遵守当地法律、非商业要求，并在 24 小时内清除使用过程中产生的版权数据。服务会将其管理的已下载文件在配置的 1–24 小时内自动清理。

## 能力范围

- 酷我、酷狗、QQ 音乐、网易云、咪咕的歌曲与歌单搜索。
- 热搜、歌单标签与详情、排行榜与详情、评论与回复。
- 歌词、逐字歌词、翻译、罗马音与封面地址。
- 跨平台歌曲匹配。
- 兼容 LX 自定义源 API v2 的 `musicUrl` 解析。
- 返回短期直链、代理音频流、服务端持久化下载任务。
- 单一 Bearer API 密钥、CORS 白名单、速率限制、请求中断与上游 URL 安全检查。
- SQLite 任务持久化；服务重启后，未完成任务转为 `paused`，不会擅自继续。

不包含播放器、本地曲库、“我的列表”、同步、GUI/Electron，以及实验性的歌手、专辑或搜索建议接口。自定义源只能在 `config.toml` 中指定唯一脚本；没有上传、切换、查看或下载源脚本的 API。

## 快速开始

要求 Node.js 22.19 或更高版本。

```bash
npm ci
cp config.toml.example config.toml
openssl rand -hex 32
```

编辑 `config.toml`：

1. 将生成的随机值写入 `auth.api_key`。
2. 阅读两份许可证后，将 `legal.accept_lx_music_terms` 改为 `true`。
3. 将唯一自定义源脚本路径写入 `custom_source.script_path`。建议把脚本放在已忽略的 `.private/` 中。
4. 按需修改监听地址、代理、下载目录与保留时间。

然后启动：

```bash
npm run dev
# 或
npm run build
npm start
```

自定义源缺失或校验失败时，服务仍会启动：`/readyz` 返回 HTTP 200 和 `degraded`。搜索、歌单、歌词等官方平台能力仍可用；直链、音频流和下载会返回 503 或进入失败状态。

## 调用示例

健康检查不需要鉴权；所有 `/v1` 接口都需要同一个 Bearer 密钥。

```bash
curl http://127.0.0.1:3000/healthz

curl \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  'http://127.0.0.1:3000/v1/search/tracks?q=夜曲&source=all&page=1&limit=20'
```

搜索响应中的完整 `Track` 对象是后续歌词、评论、解析和下载接口的输入，不要只保留歌曲 ID：

```bash
curl -X POST \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  --data '{"track": { ...搜索返回的完整 Track... }, "quality":"320k"}' \
  http://127.0.0.1:3000/v1/tracks/resolve
```

启用 `server.docs_enabled` 后，Swagger UI 位于 `/docs`。完整端点、对象格式和下载状态流转见 [API 文档](./docs/api.md)，配置说明见 [配置文档](./docs/configuration.md)。

## Docker

先准备本机的 `config.toml` 与 `.private/custom-source.js`。容器内监听需要把 `server.host` 设为 `0.0.0.0`。

```bash
docker build -t lxmusic2api .
docker run --rm -p 3000:3000 \
  -v "$PWD/config.toml:/app/config.toml:ro" \
  -v "$PWD/.private:/app/.private:ro" \
  -v "$PWD/data:/app/data" \
  -v "$PWD/downloads:/app/downloads" \
  lxmusic2api
```

也可以使用 `docker compose up --build`。下载目录是受服务管理的临时版权数据目录，不要把永久文件放进去。

## 验证与维护

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run docs:generate
npm run licenses:check
npm run test:compat -- --config ./config.toml
```

最后一条只在本机读取配置的唯一自定义源并验证初始化能力，不会启动 API，也不会提交源脚本。`config.toml`、`.private/`、运行数据库和下载目录都已加入 Git 忽略。

## 实现与来源

整体边界、隔离模型和故障行为见 [架构说明](./docs/architecture.md)。LX 派生代码的主要基线是 `lyswhut/lx-music-desktop@9c364b482e5621a1d38b50e8610d2fb974457e6e`；纯 JavaScript 歌词解码还采用上游提交 `cb2798cb`。归属与修改说明见 [NOTICE](./NOTICE)。

本仓库主分支为 `main`。

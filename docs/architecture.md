# 架构与边界

```text
客户端
  |
  | Bearer API key
  v
Fastify /v1 路由
  |---------------------> LX 平台适配层 -----> kw/kg/tx/wy/mg 公共上游
  |                              |
  |                              +---- 搜索、歌单、榜单、评论、歌词、封面
  |
  +---- URL 服务 -----> 单一 QuickJS Worker -----> 受控 HTTP 桥 -----> 自定义源所访问的上游
  |                         |                         |
  |                         | CPU/内存/栈/超时限制    +-- URL/重定向/私网检查
  |                         +-- 无 process/require/文件系统
  |
  +---- 音频代理
  |
  +---- 下载调度器 -----> SQLite 状态 + 受管临时目录 -----> 到期清理（<= 24h）
```

## LX 代码复用

平台请求、签名、结果整理和歌词解码尽量保持 LX Music 原有实现。新的适配层只替换 Electron 请求、IPC/native 歌词解码和 GUI 状态依赖，并把平台返回值转换成稳定的 `Track` DTO。旧模块包含可取消的单例请求状态，因此服务按“平台 + 功能”串行化同类调用，避免并发请求互相取消；不同平台和不同功能仍可并行。

## 自定义源隔离

配置脚本运行在独立 Worker 中的 QuickJS WASM 上下文。兼容面固定为 LX 自定义源 API v2：`window.lx`/`lx`、`EVENT_NAMES`、`request`、`send`、`on`、Buffer/crypto/zlib、计时器、`version=2.0.0` 和 `env=desktop`。

宿主不向脚本提供 Node.js `process`、`require`、模块加载、原生 `fetch`、文件系统或环境变量。脚本的网络请求只能通过消息桥回到主线程，并受超时、响应体、协议、凭据 URL、逐跳重定向和私网限制。直连模式使用 Undici DNS interceptor 固定并复检实际连接 IP，缩小 DNS 重绑定窗口；显式配置代理后，代理及其 DNS 解析属于操作者选择的额外信任边界。同步死循环由 QuickJS interrupt 中止；动作 Promise 超时后整个 Worker 熔断并终止。

隔离降低风险但不等于证明第三方脚本可信。操作者仍应审查来源，把脚本与配置作为私密文件管理，并以低权限用户运行容器或进程。

## 数据与许可证边界

SQLite 只保存任务状态和客户端提交的 Track 信息。搜索结果本身不做持久缓存。下载音频、封面和歌词只写入受管下载目录，并按配置在 1–24 小时内删除；下载任务记录可以保留，但过期后不再含可读取文件路径。

主许可证、上游补充协议与归属分别位于 `LICENSE`、`LICENSES/LX-MUSIC-ADDITIONAL-zh-CN.txt` 和 `NOTICE`。启动许可开关用于防止操作者跳过这些要求，不替代操作者的法律判断。

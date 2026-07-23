# 配置说明

服务只读取 TOML 配置。默认路径是当前目录的 `config.toml`，也可以使用 `--config /path/to/config.toml` 或环境变量 `LXMUSIC2API_CONFIG` 指定。所有相对路径都以配置文件所在目录为基准。

请从仓库跟踪的 `config.toml.example` 复制；真实 `config.toml` 已忽略。

## 关键配置

- `legal.accept_lx_music_terms`：必须在阅读两份协议后显式设为 `true`，否则拒绝启动。
- `auth.api_key`：唯一 Bearer 密钥，至少 32 个字符；示例占位符会被拒绝。
- `server.host/port`：监听地址。Docker 中通常把 host 改为 `0.0.0.0`。
- `server.docs_enabled`：是否提供 `/docs`。文档本身不包含自定义源信息。
- `server.request_timeout_ms`：普通 API 的入站读取与完整路由处理时限；超时返回 HTTP 504，并中止仍在运行的上游请求。音频流与下载文件改用 `network.audio_timeout_ms`。
- `server.cors`：默认关闭；开启时必须给出明确的 HTTP(S) Origin，不接受通配符。
- `paths.database`：SQLite 数据库。
- `paths.downloads`：受服务管理并会自动删除文件的临时下载目录。
- `network.proxy_url`：可选 HTTP(S) 代理。
- `network.request_timeout_ms`：单次普通上游请求的总时限，包含 URL/DNS 安全检查、连接和响应体读取。
- `network.block_private_networks`：默认阻止自定义源和重定向访问环回、私网、链路本地、保留网段与云元数据地址。
- `network.allow_private_hosts`：只有明确需要时才允许指定主机；这是安全边界的主动放宽。
- `network.dns_cache_ttl_ms`：直连时固定并复检实际连接 IP 的缓存时间；配置代理后，代理自身及其 DNS 解析成为额外信任边界。
- `music.allow_source_fallback`：是否在原平台 URL 解析失败后进行跨平台匹配。
- `custom_source.script_path`：唯一启用的 LX 自定义源脚本；无法由 API 更改。
- `custom_source.*_timeout`、内存、栈和并发请求限制：QuickJS Worker 的隔离上限。
- `download.max_concurrent/max_file_bytes`：并行数与单文件硬上限。
- `download.existing_file`：`skip`、`overwrite` 或 `rename`。
- `download.retention_hours`：只能是 1–24；服务不支持关闭自动清理。
- `rate_limit`：只作用于 `/v1` API 范围。

Clash 等透明代理的 fake-IP 模式可能把公网域名解析到 `198.18.0.0/15` 保留网段，从而被私网保护按预期拒绝。应优先显式配置 `network.proxy_url`；确需沿用透明代理时，只把已确认的精确上游主机名加入 `network.allow_private_hosts`，不要关闭全局保护。

## 自定义源故障

启动时只读取 `custom_source.script_path` 指向的一个普通文件，并检查头注释、大小、初始化事件与 `musicUrl` 能力。失败时不终止服务，而是进入降级模式。运行中超时或 Worker 异常会熔断该解析器；为避免在未知状态继续执行，必须重启服务后才会重新加载。

使用以下命令在不启动 API 的情况下检查真实私有源：

```bash
npm run test:compat -- --config ./config.toml
```

该命令只在终端输出通过检查的平台别名，不输出脚本内容或元数据。

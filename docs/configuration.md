# 配置说明

服务只读取 TOML 配置。默认路径是当前目录的 `config.toml`，也可以使用 `--config /path/to/config.toml` 或环境变量 `LXMUSIC2API_CONFIG` 指定。所有相对路径都以配置文件所在目录为基准。

请从仓库跟踪的 `config.toml.example` 复制；真实 `config.toml` 已忽略。

## 关键配置

- `legal.accept_lx_music_terms`：必须在阅读两份协议后显式设为 `true`，否则拒绝启动。
- `auth.api_key`：唯一 Bearer 密钥，至少 32 个字符；示例占位符会被拒绝。
- `server.host/port`：监听地址。Docker 中通常把 host 改为 `0.0.0.0`。
- `server.docs_enabled`：是否提供 `/docs`。文档本身不包含自定义源信息。
- `server.request_timeout_ms`：普通 API 的入站读取与完整路由处理时限；超时返回 HTTP 504，并通过服务自有的请求取消信号中止仍在运行的上游请求。音频流与下载文件改用 `network.audio_timeout_ms`。
- `server.cors`：默认关闭；开启时必须给出明确的 HTTP(S) Origin，不接受通配符。
- `paths.database`：SQLite 数据库。
- `paths.downloads`：受服务管理并会自动删除文件的临时下载目录。
- `network.proxy_url`：可选 HTTP(S) 代理。
- `network.request_timeout_ms`：单次普通上游请求的总时限，包含 URL/DNS 安全检查、连接和响应体读取。
- `network.audio_user_agent`：音频代理与下载访问上游 CDN 时使用的 `User-Agent`；默认与 LX Music Desktop 下载器一致，避免部分平台返回防盗链占位音频。自定义源有特殊要求时可覆盖。
- `network.block_private_networks`：默认阻止自定义源和重定向访问环回、私网、链路本地、保留网段与云元数据地址。
- `network.allow_private_hosts`：只有明确需要时才允许指定主机；这是安全边界的主动放宽。
- `network.dns_cache_ttl_ms`：直连时固定并复检实际连接 IP 的缓存时间；配置代理后，代理自身及其 DNS 解析成为额外信任边界。
- `music.allow_source_fallback`：是否在原平台的全部兼容自定义源均无法解析或返回可信完整音频后，再进行跨平台匹配。它不会让其他平台抢在同平台源池前面。
- `music.minimum_full_audio_bitrate_kbps`：按 Track 时长校验完整音频响应体积的极低合理码率下限，默认 `16`；用于拒绝试听片段和防盗链占位音频，设为 `0` 可关闭。无有效时长、无 `Content-Length` 或 Range/206 响应不会做整文件体积预判；后台下载完成后还会按实际字节数复检。
- `custom_source.script_path`：可选的单个 LX 自定义源脚本；留空时不加载显式脚本。
- `custom_source.directory_path`：可选的自定义源目录；自动加载第一层的全部普通 `.js` 文件。
- `custom_source.*_timeout`、内存、栈和并发请求限制：分别作用于每个 QuickJS Worker 的隔离上限。
- `download.max_concurrent/max_file_bytes`：并行数与单文件硬上限。
- `download.existing_file`：`skip`、`overwrite` 或 `rename`。
- `download.retention_hours`：只能是 1–24；服务不支持关闭自动清理。
- `rate_limit`：只作用于 `/v1` API 范围。

Clash 等透明代理的 fake-IP 模式可能把公网域名解析到 `198.18.0.0/15` 保留网段，从而被私网保护按预期拒绝。应优先显式配置 `network.proxy_url`；确需沿用透明代理时，只把已确认的精确上游主机名加入 `network.allow_private_hosts`，不要关闭全局保护。

## 自定义源故障

启动时会合并 `custom_source.script_path` 指向的显式脚本与 `custom_source.directory_path` 第一层按文件名排序的全部普通 `.js` 文件，并按绝对路径去重。若只想使用目录，应显式设置 `script_path = ""`。目录不会递归扫描，也不会加载其他扩展名或符号链接；源文件变化不会热加载，需重启服务。

每个脚本都在独立 Worker 中检查头注释、文件大小、初始化事件与 `musicUrl` 能力。某个脚本初始化失败、运行超时或 Worker 异常时只熔断该脚本；只要仍有一个脚本可用，URL 解析就保持就绪。解析同一 Track 时先固定其平台，筛选所有 `ready`、支持该平台且与歌曲具有共同音质的脚本，优先精确音质，再结合连续失败次数、近期响应延迟和稳定文件顺序选择。URL 解析失败、音频 HTTP 失败或完整音频鉴伪失败都会继续尝试同平台的下一个兼容脚本；只有同平台池全部失败，才可能按配置进入跨平台匹配。所有脚本均不可用时 `/readyz` 才显示 `degraded`。

资源限制按脚本分别计算。例如目录中有 4 个脚本时，最多会创建 4 个 Worker，每个 Worker 都拥有独立的内存、栈、动作超时和 HTTP 并发上限。脚本及其路径、元数据、能力表和选择结果不会通过 API 暴露。

使用以下命令在不启动 API 的情况下检查真实私有源：

```bash
npm run test:compat -- --config ./config.toml
```

该命令只在终端输出通过检查的平台别名，不输出脚本内容或元数据。

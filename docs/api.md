# API 使用说明

默认地址为 `http://127.0.0.1:3000`。除 `/healthz`、`/readyz` 和可选的 `/docs` 外，所有接口都位于 `/v1`，并要求：

```http
Authorization: Bearer <config.toml 中的 auth.api_key>
```

普通 JSON 成功响应使用 `{ "data": ... }`；错误响应使用：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "请求参数校验失败",
    "requestId": "req-1"
  }
}
```

## Track 对象

搜索、歌单和排行榜返回的 `Track` 是无状态 API 的完整凭据。`sourceData` 中的平台字段是后续请求所需数据，因此客户端应原样保存并回传。

```json
{
  "id": "kg_song-id_hash",
  "source": "kg",
  "name": "歌曲名",
  "singer": "歌手",
  "interval": "03:42",
  "albumName": "专辑",
  "picUrl": null,
  "qualities": [
    { "type": "320k", "size": "9.1 MB", "hash": "optional" }
  ],
  "sourceData": {
    "songId": "平台歌曲 ID",
    "albumId": "可选专辑 ID",
    "hash": "可选平台 hash",
    "mediaMid": "可选媒体 ID"
  }
}
```

平台值：`kw`、`kg`、`tx`、`wy`、`mg`。音质值：`flac24bit`、`flac`、`wav`、`ape`、`320k`、`192k`、`128k`。LX 自定义源实际 URL 能力按 v2 兼容范围收敛为 `flac24bit`、`flac`、`320k`、`128k`。

## 端点

| 方法 | 路径 | 功能 |
| --- | --- | --- |
| GET | `/healthz` | 进程存活检查，无鉴权 |
| GET | `/readyz` | 就绪/降级状态，无鉴权且降级仍返回 200 |
| GET | `/v1/providers` | 官方平台与公开能力 |
| GET | `/v1/search/tracks` | 搜索歌曲；参数 `q/source/page/limit` |
| GET | `/v1/search/playlists` | 搜索歌单；参数同上 |
| GET | `/v1/search/hot` | 热搜；参数 `source`，默认 `all` |
| GET | `/v1/playlists/:source/tags` | 歌单标签 |
| GET | `/v1/playlists/:source` | 歌单列表；参数 `tagId/sortId/page` |
| GET | `/v1/playlists/:source/:id` | 歌单详情；参数 `page` |
| GET | `/v1/leaderboards/:source` | 排行榜列表 |
| GET | `/v1/leaderboards/:source/:id` | 排行榜详情；参数 `page` |
| POST | `/v1/tracks/lyrics` | 歌词，正文 `{ "track": Track }` |
| POST | `/v1/tracks/cover` | 封面 URL |
| POST | `/v1/tracks/comments` | 最新/热门评论 |
| POST | `/v1/tracks/comments/:commentId/replies` | 评论回复 |
| POST | `/v1/tracks/matches` | 跨平台匹配 |
| POST | `/v1/tracks/resolve` | 使用配置的自定义源池解析直链 |
| POST | `/v1/tracks/stream` | 解析并代理音频，支持传入 `Range` |
| POST | `/v1/downloads` | 创建持久化下载任务，返回 202 |
| GET | `/v1/downloads` | 下载任务分页列表，可按 `state` 过滤 |
| GET | `/v1/downloads/:id` | 下载任务详情 |
| POST | `/v1/downloads/:id/pause` | 暂停 |
| POST | `/v1/downloads/:id/resume` | 恢复暂停、失败或取消的任务 |
| POST | `/v1/downloads/:id/cancel` | 取消 |
| DELETE | `/v1/downloads/:id` | 删除任务及受管文件 |
| GET | `/v1/downloads/:id/file` | 获取完成文件，支持单段 `Range` |

所有查询字符串与 JSON 正文都拒绝未声明字段。`source=all` 的搜索会并行查询平台；只要至少一个平台成功，就返回结果，并在 `upstreamErrors` 中报告部分失败。

## URL 解析和流

`/tracks/resolve` 与 `/tracks/stream` 的正文：

```json
{
  "track": { "...": "完整 Track" },
  "quality": "320k",
  "strictQuality": false
}
```

`strictQuality=false` 时会按可用质量降级。服务先固定请求 Track 的平台，并把所有 `ready`、支持该平台且有共同音质的自定义源按音质、健康度、延迟和稳定顺序逐个尝试；解析 URL 后的 HTTP/内容鉴伪失败也属于当前源失败。只有同平台源池全部失败且 `music.allow_source_fallback=true` 时，才最多尝试配置数量的跨平台匹配项。因此选择 `wy` Track 时不会因为第一个源失败就直接发送 `kw` 版本。

`/tracks/resolve` 的 JSON 响应会给出 `resolvedQuality`、`qualityFallbackUsed`、`sourceFallbackUsed` 与实际使用的 `track`，但不会暴露具体自定义源。`/tracks/stream` 成功时直接返回音频流，并通过以下响应头报告最终实际采用的平台和音质：

- `X-LXMusic2API-Resolved-Source`
- `X-LXMusic2API-Requested-Quality`
- `X-LXMusic2API-Resolved-Quality`
- `X-LXMusic2API-Source-Fallback-Used`
- `X-LXMusic2API-Quality-Fallback-Used`

平台值为 `kw`、`kg`、`tx`、`wy` 或 `mg`，回退标记为 `true` / `false`。这些响应头只描述最终解析结果，不包含自定义源脚本名称、路径或音频直链。若所有同平台候选都无法返回可信完整音频，则返回 `AUDIO_RESPONSE_SUSPICIOUS` 或 `ALL_AUDIO_SOURCES_FAILED`，不会把占位音频当歌曲回传。

直链由第三方自定义源返回，可能快速失效。`/tracks/stream` 与后台下载访问音频 CDN 时统一使用配置的 `network.audio_user_agent`，默认值与 LX Music Desktop 下载器一致；客户端请求中的鉴权信息不会透传给音频 CDN。对非 Range 完整响应，服务会用 `music.minimum_full_audio_bitrate_kbps` 和 Track 时长校验 `Content-Length`，拒绝明显过短的试听片段或防盗链占位音频；后台下载还会按最终实际字节数复检。Range/206 响应只校验 HTTP 状态与正文类型，不以分段大小误判完整歌曲。服务不会缓存或通过 API 暴露自定义源脚本、名称、版本、主页、能力表或路径。

## 下载任务

状态流转：

```text
queued -> running -> completed -> expired
   |         |  \-> failed
   |         \----> paused/cancelled
   \--------------> paused/cancelled

paused/failed/cancelled -> queued（resume）
```

- 任务记录写入 SQLite；进度按配置节流写入。
- 重启时 `queued` 和 `running` 统一变为 `paused`。
- 临时文件使用服务专属名称，完成后原子移动。
- `max_file_bytes` 在响应头与实际流量两层执行。
- MP3 可写入标题、歌手、专辑、封面和歌词；其他格式保留原音频，可按配置另存 `.lrc`。
- 完成文件的 `expiresAt` 最多为完成后 24 小时；到期后文件和同名歌词被删除，记录改为 `expired`。
- `paths.downloads` 是受管临时目录；`existing_file=skip` 指向的同名文件同样会受保留期清理。

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
| POST | `/v1/tracks/resolve` | 使用配置的唯一自定义源解析直链 |
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

`strictQuality=false` 时会按可用质量降级。`music.allow_source_fallback=true` 时，原平台解析失败后最多尝试配置数量的跨平台匹配项。响应会明确给出 `resolvedQuality`、`qualityFallbackUsed`、`sourceFallbackUsed` 与实际使用的 `track`。

直链由第三方自定义源返回，可能快速失效。服务不会缓存或通过 API 暴露自定义源脚本、名称、版本、主页、能力表或路径。

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

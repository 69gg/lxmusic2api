import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import { Type, type TSchema } from 'typebox'
import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { AppConfig } from '@app/config/schema'
import { AppError } from './errors.js'
import { TrackSchema } from '@app/domain/track'
import { CreateDownloadSchema, DownloadJobSchema } from '@app/download/types'
import type { DownloadService } from '@app/download/service'
import { openHttpStream } from '@app/network/http-client'
import type { MusicUrlService } from '@app/music/url-service'
import type { ProviderService } from '@app/provider/service'
import {
  CommentReplyParamsSchema,
  CommentsBodySchema,
  DownloadListQuerySchema,
  ErrorResponseSchema,
  IdParamsSchema,
  ResolveBodySchema,
  SearchQuerySchema,
  secureSchema,
  SourceIdParamsSchema,
  SourceParamsSchema,
  SourceQuerySchema,
  TrackBodySchema,
} from './schemas.js'

export interface ApiServices {
  config: AppConfig
  providers: ProviderService
  urls: MusicUrlService
  downloads: DownloadService
}

const dataSchema = <T extends TSchema>(schema: T) => Type.Object({ data: schema }, { additionalProperties: false })
const JsonObjectSchema = Type.Object({}, { additionalProperties: true })
const jsonResponses = <T extends TSchema>(schema: T): Record<number, TSchema> => ({
  200: dataSchema(schema),
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  413: ErrorResponseSchema,
  422: ErrorResponseSchema,
  429: ErrorResponseSchema,
  502: ErrorResponseSchema,
  503: ErrorResponseSchema,
  504: ErrorResponseSchema,
})

const contentDisposition = (fileName: string): string => {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

const parseRange = (header: string | undefined, size: number): { start: number, end: number } | null => {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) throw new AppError('INVALID_RANGE', 416, '仅支持单个 bytes 范围')
  const startText = match[1] ?? ''
  const endText = match[2] ?? ''
  if (!startText && !endText) throw new AppError('INVALID_RANGE', 416, 'Range 为空')
  let start: number
  let end: number
  if (!startText) {
    const suffixLength = Number.parseInt(endText, 10)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) throw new AppError('INVALID_RANGE', 416, 'Range 无效')
    start = Math.max(0, size - suffixLength)
    end = size - 1
  } else {
    start = Number.parseInt(startText, 10)
    end = endText ? Number.parseInt(endText, 10) : size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    throw new AppError('INVALID_RANGE', 416, 'Range 超出文件范围')
  }
  return { start, end: Math.min(end, size - 1) }
}

export const registerApiRoutes = (app: FastifyInstance, services: ApiServices): void => {
  const server = app.withTypeProvider<TypeBoxTypeProvider>()
  const { config, providers, urls, downloads } = services

  server.get('/providers', {
    schema: secureSchema({
      tags: ['providers'], summary: '列出在线平台',
      response: jsonResponses(Type.Array(Type.Object({
        id: Type.String(), name: Type.String(), capabilities: Type.Array(Type.String()),
      }, { additionalProperties: false }))),
    }),
  }, () => ({ data: providers.listProviders() }))

  server.get('/search/tracks', {
    schema: secureSchema({ tags: ['search'], summary: '搜索歌曲', querystring: SearchQuerySchema, response: jsonResponses(JsonObjectSchema) }),
  }, async request => {
    const signal = request.signal
    return { data: await providers.searchTracks(request.query.q, request.query.source ?? 'all', request.query.page ?? 1, request.query.limit ?? 20, signal) }
  })

  server.get('/search/playlists', {
    schema: secureSchema({ tags: ['search'], summary: '搜索歌单', querystring: SearchQuerySchema, response: jsonResponses(JsonObjectSchema) }),
  }, async request => {
    const signal = request.signal
    return { data: await providers.searchPlaylists(request.query.q, request.query.source ?? 'all', request.query.page ?? 1, request.query.limit ?? 20, signal) }
  })

  server.get('/search/hot', {
    schema: secureSchema({ tags: ['search'], summary: '获取热门搜索', querystring: SourceQuerySchema, response: jsonResponses(JsonObjectSchema) }),
  }, async request => ({
    data: await providers.getHotSearch(request.query.source ?? 'all', request.signal),
  }))

  server.get('/playlists/:source/tags', {
    schema: secureSchema({ tags: ['playlists'], summary: '获取歌单标签', params: SourceParamsSchema, response: jsonResponses(JsonObjectSchema) }),
  }, async request => ({ data: await providers.getPlaylistTags(request.params.source, request.signal) }))

  server.get('/playlists/:source', {
    schema: secureSchema({
      tags: ['playlists'], summary: '获取歌单列表', params: SourceParamsSchema,
      querystring: Type.Object({
        tagId: Type.Optional(Type.String({ maxLength: 1024, default: '' })),
        sortId: Type.Optional(Type.String({ maxLength: 1024, default: '' })),
        page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000, default: 1 })),
      }, { additionalProperties: false }),
      response: jsonResponses(JsonObjectSchema),
    }),
  }, async request => ({
    data: await providers.getPlaylists(
      request.params.source, request.query.tagId ?? '', request.query.sortId ?? '', request.query.page ?? 1,
      request.signal,
    ),
  }))

  server.get('/playlists/:source/:id', {
    schema: secureSchema({
      tags: ['playlists'], summary: '获取歌单详情', params: SourceIdParamsSchema,
      querystring: Type.Object({ page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000, default: 1 })) }, { additionalProperties: false }),
      response: jsonResponses(JsonObjectSchema),
    }),
  }, async request => ({
    data: await providers.getPlaylistDetail(request.params.source, request.params.id, request.query.page ?? 1, request.signal),
  }))

  server.get('/leaderboards/:source', {
    schema: secureSchema({ tags: ['leaderboards'], summary: '获取排行榜', params: SourceParamsSchema, response: jsonResponses(JsonObjectSchema) }),
  }, async request => ({ data: await providers.getLeaderboards(request.params.source, request.signal) }))

  server.get('/leaderboards/:source/:id', {
    schema: secureSchema({
      tags: ['leaderboards'], summary: '获取排行榜详情', params: SourceIdParamsSchema,
      querystring: Type.Object({ page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000, default: 1 })) }, { additionalProperties: false }),
      response: jsonResponses(JsonObjectSchema),
    }),
  }, async request => ({
    data: await providers.getLeaderboardDetail(request.params.source, request.params.id, request.query.page ?? 1, request.signal),
  }))

  server.post('/tracks/lyrics', {
    schema: secureSchema({ tags: ['tracks'], summary: '获取歌词', body: TrackBodySchema, response: jsonResponses(JsonObjectSchema) }),
  }, async request => ({ data: await providers.getLyrics(request.body.track, request.signal) }))

  server.post('/tracks/cover', {
    schema: secureSchema({ tags: ['tracks'], summary: '获取封面地址', body: TrackBodySchema, response: jsonResponses(Type.Object({ url: Type.String() })) }),
  }, async request => ({ data: { url: await providers.getCover(request.body.track, request.signal) } }))

  server.post('/tracks/comments', {
    schema: secureSchema({ tags: ['tracks'], summary: '获取评论', body: CommentsBodySchema, response: jsonResponses(JsonObjectSchema) }),
  }, async request => ({
    data: await providers.getComments(
      request.body.track, request.body.kind ?? 'latest', request.body.page ?? 1, request.body.limit ?? 20,
      request.signal,
    ),
  }))

  server.post('/tracks/comments/:commentId/replies', {
    schema: secureSchema({
      tags: ['tracks'], summary: '获取评论回复', params: CommentReplyParamsSchema,
      body: Type.Object({
        track: TrackSchema,
        page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000, default: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
      }, { additionalProperties: false }),
      response: jsonResponses(JsonObjectSchema),
    }),
  }, async request => ({
    data: await providers.getCommentReplies(
      request.body.track, request.params.commentId, request.body.page ?? 1, request.body.limit ?? 20,
      request.signal,
    ),
  }))

  server.post('/tracks/matches', {
    schema: secureSchema({ tags: ['tracks'], summary: '跨平台匹配歌曲', body: TrackBodySchema, response: jsonResponses(Type.Array(TrackSchema)) }),
  }, async request => ({ data: await providers.findMatches(request.body.track, request.signal) }))

  server.post('/tracks/resolve', {
    schema: secureSchema({ tags: ['audio'], summary: '解析直链', body: ResolveBodySchema, response: jsonResponses(JsonObjectSchema) }),
  }, async request => {
    const result = await urls.resolve(
      request.body.track, request.body.quality ?? config.music.default_quality,
      request.body.strictQuality ?? false, request.signal,
    )
    return { data: result }
  })

  server.post('/tracks/stream', {
    handlerTimeout: config.network.audio_timeout_ms,
    schema: secureSchema({ tags: ['audio'], summary: '代理音频流', body: ResolveBodySchema }),
  }, async (request, reply) => {
    const signal = request.signal
    const resolved = await urls.resolve(
      request.body.track, request.body.quality ?? config.music.default_quality,
      request.body.strictQuality ?? false, signal,
    )
    const range = typeof request.headers.range === 'string' ? request.headers.range : undefined
    const upstream = await openHttpStream(resolved.url, { signal, headers: range ? { range } : {} })
    if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
      await upstream.body.dump()
      if (upstream.statusCode === 416) throw new AppError('INVALID_RANGE', 416, '上游音频不接受该 Range')
      throw new AppError('AUDIO_UPSTREAM_ERROR', 502, `音频上游返回 HTTP ${upstream.statusCode}`)
    }
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'] as const) {
      const value = upstream.headers[header]
      if (value != null) reply.header(header, value)
    }
    reply.header('content-disposition', 'inline')
    return reply.status(upstream.statusCode).send(upstream.body)
  })

  server.post('/downloads', {
    schema: secureSchema({ tags: ['downloads'], summary: '创建下载任务', body: CreateDownloadSchema, response: { 202: dataSchema(DownloadJobSchema) } }),
  }, (request, reply) => {
    reply.status(202)
    return { data: downloads.create(request.body) }
  })

  server.get('/downloads', {
    schema: secureSchema({ tags: ['downloads'], summary: '列出下载任务', querystring: DownloadListQuerySchema, response: jsonResponses(JsonObjectSchema) }),
  }, request => ({ data: downloads.list(request.query.page ?? 1, request.query.limit ?? 20, request.query.state) }))

  server.get('/downloads/:id', {
    schema: secureSchema({ tags: ['downloads'], summary: '获取下载任务', params: IdParamsSchema, response: jsonResponses(DownloadJobSchema) }),
  }, request => ({ data: downloads.get(request.params.id) }))

  server.post('/downloads/:id/pause', {
    schema: secureSchema({ tags: ['downloads'], summary: '暂停下载任务', params: IdParamsSchema, response: jsonResponses(DownloadJobSchema) }),
  }, request => ({ data: downloads.pause(request.params.id) }))

  server.post('/downloads/:id/resume', {
    schema: secureSchema({ tags: ['downloads'], summary: '恢复下载任务', params: IdParamsSchema, response: jsonResponses(DownloadJobSchema) }),
  }, request => ({ data: downloads.resume(request.params.id) }))

  server.post('/downloads/:id/cancel', {
    schema: secureSchema({ tags: ['downloads'], summary: '取消下载任务', params: IdParamsSchema, response: jsonResponses(DownloadJobSchema) }),
  }, request => ({ data: downloads.cancel(request.params.id) }))

  server.delete('/downloads/:id', {
    schema: secureSchema({ tags: ['downloads'], summary: '删除下载任务及文件', params: IdParamsSchema, response: { 204: Type.Null() } }),
  }, async (request, reply) => {
    await downloads.delete(request.params.id)
    return reply.status(204).send(null)
  })

  server.get('/downloads/:id/file', {
    handlerTimeout: config.network.audio_timeout_ms,
    schema: secureSchema({ tags: ['downloads'], summary: '读取已完成的下载文件', params: IdParamsSchema }),
  }, async (request, reply) => {
    const file = await downloads.getFile(request.params.id)
    const stats = await fsPromises.stat(file.path)
    let range: { start: number, end: number } | null
    try {
      range = parseRange(typeof request.headers.range === 'string' ? request.headers.range : undefined, stats.size)
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 416) reply.header('content-range', `bytes */${stats.size}`)
      throw error
    }
    reply.header('accept-ranges', 'bytes')
    reply.header('content-type', file.contentType)
    reply.header('content-disposition', contentDisposition(file.fileName))
    if (range) {
      reply.header('content-range', `bytes ${range.start}-${range.end}/${stats.size}`)
      reply.header('content-length', range.end - range.start + 1)
      return reply.status(206).send(fs.createReadStream(file.path, range))
    }
    reply.header('content-length', stats.size)
    return reply.send(fs.createReadStream(file.path))
  })
}

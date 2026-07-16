import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Transform, type TransformCallback } from 'node:stream'
import NodeID3 from 'node-id3'
import type { FastifyBaseLogger } from 'fastify'
import type Database from 'better-sqlite3'
import type { AppConfig } from '@app/config/schema'
import { AppError } from '@app/api/errors'
import type { Quality, Track } from '@app/domain/track'
import { openHttpStream, requestBuffer } from '@app/network/http-client'
import type { MusicUrlService, ResolvedMusicUrl } from '@app/music/url-service'
import type { ProviderService } from '@app/provider/service'
import { buildLyrics, type LyricData } from './lrc.js'
import type { CreateDownload, DownloadJob, DownloadState } from './types.js'

interface DownloadRow {
  id: string
  state: DownloadState
  track_json: string
  resolved_track_json: string | null
  requested_quality: Quality
  resolved_quality: Quality | null
  strict_quality: number
  source_fallback_used: number
  quality_fallback_used: number
  file_path: string | null
  file_name: string | null
  content_type: string | null
  bytes_downloaded: number
  total_bytes: number | null
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  expires_at: string | null
}

interface ActiveDownload {
  controller: AbortController
  promise: Promise<void>
}

const MANAGED_PART_PATTERN = /^\.lxmusic2api-[0-9a-f-]{36}\.part$/i

const extensionForQuality = (quality: Quality): string => {
  switch (quality) {
    case 'flac':
    case 'flac24bit': return 'flac'
    case 'wav': return 'wav'
    case 'ape': return 'ape'
    default: return 'mp3'
  }
}

const firstHeader = (value: string | string[] | undefined): string | undefined => Array.isArray(value) ? value[0] : value

const safeFileSegment = (value: string): string => {
  const withoutControls = [...value].map(character => {
    const code = character.codePointAt(0) ?? 0
    return code <= 31 || code === 127 ? '_' : character
  }).join('')
  const sanitized = withoutControls
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
  return sanitized.slice(0, 180) || 'untitled'
}

const renderFileName = (template: string, track: Track, quality: Quality): string => safeFileSegment(template.replace(
  /\{(name|singer|album|source|quality|id)\}/g,
  (_match, key: string) => ({
    name: track.name,
    singer: track.singer,
    album: track.albumName,
    source: track.source,
    quality,
    id: track.id,
  })[key] ?? '',
))

const isWithinDirectory = (directory: string, candidate: string): boolean => {
  const relative = path.relative(directory, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

const rowToJob = (row: DownloadRow): DownloadJob => ({
  id: row.id,
  state: row.state,
  track: JSON.parse(row.track_json) as Track,
  resolvedTrack: row.resolved_track_json ? JSON.parse(row.resolved_track_json) as Track : null,
  requestedQuality: row.requested_quality,
  resolvedQuality: row.resolved_quality,
  strictQuality: Boolean(row.strict_quality),
  sourceFallbackUsed: Boolean(row.source_fallback_used),
  qualityFallbackUsed: Boolean(row.quality_fallback_used),
  fileName: row.file_name,
  contentType: row.content_type,
  bytesDownloaded: row.bytes_downloaded,
  totalBytes: row.total_bytes,
  error: row.error_code && row.error_message ? { code: row.error_code, message: row.error_message } : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
  expiresAt: row.expires_at,
  downloadPath: row.state === 'completed' && row.file_path ? `/v1/downloads/${row.id}/file` : null,
})

export class DownloadService {
  readonly #config: AppConfig
  readonly #db: Database.Database
  readonly #urls: MusicUrlService
  readonly #providers: ProviderService
  readonly #logger: FastifyBaseLogger
  readonly #active = new Map<string, ActiveDownload>()
  #cleanupTimer: NodeJS.Timeout | undefined
  #pumpScheduled = false
  #closing = false

  public constructor(
    config: AppConfig,
    db: Database.Database,
    urls: MusicUrlService,
    providers: ProviderService,
    logger: FastifyBaseLogger,
  ) {
    this.#config = config
    this.#db = db
    this.#urls = urls
    this.#providers = providers
    this.#logger = logger
  }

  public async initialize(): Promise<void> {
    await fsPromises.mkdir(this.#config.paths.downloads, { recursive: true })
    const now = new Date().toISOString()
    this.#db.prepare(`
      UPDATE download_jobs
      SET state = 'paused', updated_at = ?, error_code = NULL, error_message = NULL
      WHERE state IN ('queued', 'running')
    `).run(now)
    await this.cleanupExpired()
    await this.#cleanupStaleParts()
    this.#scheduleCleanup()
  }

  #row(id: string): DownloadRow {
    const row = this.#db.prepare<[string], DownloadRow>('SELECT * FROM download_jobs WHERE id = ?').get(id)
    if (!row) throw new AppError('DOWNLOAD_NOT_FOUND', 404, '下载任务不存在')
    return row
  }

  public get(id: string): DownloadJob {
    return rowToJob(this.#row(id))
  }

  public list(page: number, limit: number, state?: DownloadState): { items: DownloadJob[], page: number, limit: number, total: number } {
    const where = state ? 'WHERE state = ?' : ''
    const parameters = state ? [state] : []
    const totalRow = this.#db.prepare<unknown[], { total: number }>(`SELECT count(*) AS total FROM download_jobs ${where}`).get(...parameters)
    const rows = this.#db.prepare<unknown[], DownloadRow>(`
      SELECT * FROM download_jobs ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...parameters, limit, (page - 1) * limit)
    return { items: rows.map(rowToJob), page, limit, total: totalRow?.total ?? 0 }
  }

  public create(input: CreateDownload): DownloadJob {
    if (this.#closing) throw new AppError('SERVICE_SHUTTING_DOWN', 503, '服务正在关闭')
    const id = randomUUID()
    const now = new Date().toISOString()
    const quality = input.quality ?? this.#config.music.default_quality
    this.#db.prepare(`
      INSERT INTO download_jobs (
        id, state, track_json, requested_quality, strict_quality, created_at, updated_at
      ) VALUES (?, 'queued', ?, ?, ?, ?, ?)
    `).run(id, JSON.stringify(input.track), quality, input.strictQuality ? 1 : 0, now, now)
    this.#schedulePump()
    return this.get(id)
  }

  public pause(id: string): DownloadJob {
    const row = this.#row(id)
    if (!['queued', 'running'].includes(row.state)) {
      throw new AppError('INVALID_DOWNLOAD_STATE', 409, `状态 ${row.state} 的任务不能暂停`)
    }
    this.#setState(id, 'paused')
    this.#active.get(id)?.controller.abort(new Error('下载已暂停'))
    return this.get(id)
  }

  public resume(id: string): DownloadJob {
    const row = this.#row(id)
    if (!['paused', 'failed', 'cancelled'].includes(row.state)) {
      throw new AppError('INVALID_DOWNLOAD_STATE', 409, `状态 ${row.state} 的任务不能恢复`)
    }
    const now = new Date().toISOString()
    this.#db.prepare(`
      UPDATE download_jobs
      SET state = 'queued', updated_at = ?, error_code = NULL, error_message = NULL,
          bytes_downloaded = 0, total_bytes = NULL, file_path = NULL, file_name = NULL,
          completed_at = NULL, expires_at = NULL
      WHERE id = ?
    `).run(now, id)
    this.#schedulePump()
    return this.get(id)
  }

  public cancel(id: string): DownloadJob {
    const row = this.#row(id)
    if (!['queued', 'running', 'paused', 'failed'].includes(row.state)) {
      throw new AppError('INVALID_DOWNLOAD_STATE', 409, `状态 ${row.state} 的任务不能取消`)
    }
    this.#setState(id, 'cancelled')
    this.#active.get(id)?.controller.abort(new Error('下载已取消'))
    return this.get(id)
  }

  public async delete(id: string): Promise<void> {
    const row = this.#row(id)
    const active = this.#active.get(id)
    if (active) {
      this.#setState(id, 'cancelled')
      active.controller.abort(new Error('下载任务已删除'))
      await active.promise
    }
    await this.#removeRowArtifacts(row)
    this.#db.prepare('DELETE FROM download_jobs WHERE id = ?').run(id)
  }

  public async getFile(id: string): Promise<{ path: string, fileName: string, contentType: string }> {
    const row = this.#row(id)
    if (row.state !== 'completed' || !row.file_path || !row.file_name) {
      throw new AppError('DOWNLOAD_FILE_UNAVAILABLE', 409, '下载文件尚不可用')
    }
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
      await this.#expire(row)
      throw new AppError('DOWNLOAD_FILE_EXPIRED', 410, '下载文件已过期并清理')
    }
    if (!isWithinDirectory(this.#config.paths.downloads, row.file_path)) {
      throw new AppError('DOWNLOAD_FILE_INVALID', 500, '下载记录中的文件路径无效', false)
    }
    try {
      const stats = await fsPromises.stat(row.file_path)
      if (!stats.isFile()) throw new Error('not a regular file')
    } catch {
      throw new AppError('DOWNLOAD_FILE_MISSING', 410, '下载文件已不存在')
    }
    return { path: row.file_path, fileName: row.file_name, contentType: row.content_type ?? 'application/octet-stream' }
  }

  #setState(id: string, state: DownloadState): void {
    this.#db.prepare('UPDATE download_jobs SET state = ?, updated_at = ? WHERE id = ?')
      .run(state, new Date().toISOString(), id)
  }

  #schedulePump(): void {
    if (this.#closing || this.#pumpScheduled) return
    this.#pumpScheduled = true
    queueMicrotask(() => {
      this.#pumpScheduled = false
      this.#pump()
    })
  }

  #scheduleCleanup(): void {
    if (this.#closing) return
    if (this.#cleanupTimer) clearTimeout(this.#cleanupTimer)
    const intervalMs = this.#config.download.cleanup_interval_minutes * 60_000
    const next = this.#db.prepare<[], { expires_at: string | null }>(`
      SELECT min(expires_at) AS expires_at FROM download_jobs WHERE state = 'completed' AND expires_at IS NOT NULL
    `).get()?.expires_at
    const untilNextExpiry = next ? Date.parse(next) - Date.now() : intervalMs
    const delay = Number.isFinite(untilNextExpiry)
      ? Math.min(intervalMs, Math.max(0, untilNextExpiry))
      : intervalMs
    this.#cleanupTimer = setTimeout(() => {
      void this.cleanupExpired()
        .catch(error => this.#logger.error({ err: error }, '清理过期下载失败'))
        .finally(() => this.#scheduleCleanup())
    }, delay)
    this.#cleanupTimer.unref()
  }

  #pump(): void {
    if (this.#closing) return
    while (this.#active.size < this.#config.download.max_concurrent) {
      const row = this.#db.prepare<[], DownloadRow>(`
        SELECT * FROM download_jobs WHERE state = 'queued' ORDER BY created_at ASC LIMIT 1
      `).get()
      if (!row || this.#active.has(row.id)) return
      const controller = new AbortController()
      const promise = this.#run(row.id, controller.signal)
        .catch(error => this.#logger.error({ err: error, downloadId: row.id }, '下载任务执行器发生未处理错误'))
        .finally(() => {
          this.#active.delete(row.id)
          this.#schedulePump()
        })
      this.#active.set(row.id, { controller, promise })
    }
  }

  async #run(id: string, signal: AbortSignal): Promise<void> {
    const row = this.#row(id)
    if (row.state !== 'queued') return
    const startedAt = new Date().toISOString()
    this.#db.prepare(`
      UPDATE download_jobs
      SET state = 'running', updated_at = ?, error_code = NULL, error_message = NULL,
          bytes_downloaded = 0, total_bytes = NULL
      WHERE id = ? AND state = 'queued'
    `).run(startedAt, id)

    const track = JSON.parse(row.track_json) as Track
    const partPath = path.join(this.#config.paths.downloads, `.lxmusic2api-${id}.part`)
    let streamBody: Awaited<ReturnType<typeof openHttpStream>>['body'] | undefined
    try {
      signal.throwIfAborted()
      await fsPromises.rm(partPath, { force: true })
      const resolved = await this.#urls.resolve(track, row.requested_quality, Boolean(row.strict_quality), signal)
      const extension = extensionForQuality(resolved.resolvedQuality)
      const baseName = renderFileName(this.#config.download.file_name_template, track, resolved.resolvedQuality)
      const preferredPath = path.join(this.#config.paths.downloads, `${baseName}.${extension}`)
      const existing = await this.#resolveExistingPath(preferredPath)
      if (existing.skip) {
        const stats = await fsPromises.stat(existing.path)
        this.#complete(id, resolved, existing.path, path.basename(existing.path), null, stats.size, stats.size)
        return
      }

      const response = await openHttpStream(resolved.url, { signal })
      streamBody = response.body
      if (response.statusCode < 200 || response.statusCode >= 300) {
        await response.body.dump()
        streamBody = undefined
        throw new AppError('AUDIO_UPSTREAM_ERROR', 502, `音频上游返回 HTTP ${response.statusCode}`)
      }
      const contentType = firstHeader(response.headers['content-type'])?.split(';', 1)[0]?.trim() ?? null
      if (contentType && (contentType.startsWith('text/') || contentType === 'application/json')) {
        throw new AppError('AUDIO_RESPONSE_INVALID', 502, `音频上游返回了非音频内容：${contentType}`)
      }
      const contentLengthValue = Number.parseInt(firstHeader(response.headers['content-length']) ?? '', 10)
      const totalBytes = Number.isFinite(contentLengthValue) && contentLengthValue >= 0 ? contentLengthValue : null
      if (totalBytes != null && totalBytes > this.#config.download.max_file_bytes) {
        throw new AppError('DOWNLOAD_TOO_LARGE', 413, '音频文件超过配置的大小限制')
      }
      this.#db.prepare(`
        UPDATE download_jobs SET resolved_track_json = ?, resolved_quality = ?, source_fallback_used = ?,
          quality_fallback_used = ?, content_type = ?, total_bytes = ?, updated_at = ? WHERE id = ?
      `).run(
        JSON.stringify(resolved.track), resolved.resolvedQuality, resolved.sourceFallbackUsed ? 1 : 0,
        resolved.qualityFallbackUsed ? 1 : 0, contentType, totalBytes, new Date().toISOString(), id,
      )

      let downloaded = 0
      let lastPersistedAt = 0
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void => {
          downloaded += chunk.length
          if (downloaded > this.#config.download.max_file_bytes) {
            callback(new AppError('DOWNLOAD_TOO_LARGE', 413, '音频文件超过配置的大小限制'))
            return
          }
          const now = Date.now()
          if (now - lastPersistedAt >= this.#config.download.progress_update_ms) {
            lastPersistedAt = now
            this.#db.prepare('UPDATE download_jobs SET bytes_downloaded = ?, updated_at = ? WHERE id = ?')
              .run(downloaded, new Date(now).toISOString(), id)
          }
          callback(null, chunk)
        },
      })
      await pipeline(response.body, meter, fs.createWriteStream(partPath, { flags: 'wx' }), { signal })
      streamBody = undefined

      const lyrics = await this.#loadLyrics(resolved.track, signal)
      await this.#writeMp3Metadata(partPath, extension, resolved.track, lyrics, signal)
      const finalPath = await this.#moveIntoPlace(partPath, existing.path)
      if (lyrics && this.#config.download.save_lrc) {
        const lyricText = buildLyrics(
          lyrics,
          this.#config.download.save_word_by_word_lyric,
          this.#config.download.save_translated_lyric,
          this.#config.download.save_romanized_lyric,
        )
        await fsPromises.writeFile(finalPath.replace(/\.[^.]+$/, '.lrc'), `\uFEFF${lyricText}`, 'utf8')
          .catch(error => this.#logger.warn({ err: error, downloadId: id }, '保存歌词文件失败'))
      }
      const finalStats = await fsPromises.stat(finalPath)
      this.#complete(id, resolved, finalPath, path.basename(finalPath), contentType, finalStats.size, totalBytes)
    } catch (error) {
      streamBody?.destroy(error instanceof Error ? error : new Error(String(error)))
      await fsPromises.rm(partPath, { force: true }).catch(() => undefined)
      const current = this.#db.prepare<[string], Pick<DownloadRow, 'state'>>('SELECT state FROM download_jobs WHERE id = ?').get(id)
      if (!current || current.state === 'paused' || current.state === 'cancelled') return
      const appError = error instanceof AppError ? error : new AppError('DOWNLOAD_FAILED', 502, error instanceof Error ? error.message : String(error))
      this.#db.prepare(`
        UPDATE download_jobs SET state = 'failed', error_code = ?, error_message = ?, updated_at = ? WHERE id = ?
      `).run(appError.code, appError.message, new Date().toISOString(), id)
    }
  }

  async #resolveExistingPath(preferredPath: string): Promise<{ path: string, skip: boolean }> {
    const exists = async (candidate: string): Promise<boolean> => fsPromises.access(candidate).then(() => true, () => false)
    if (!await exists(preferredPath)) return { path: preferredPath, skip: false }
    switch (this.#config.download.existing_file) {
      case 'skip': return { path: preferredPath, skip: true }
      case 'overwrite': return { path: preferredPath, skip: false }
      case 'rename': {
        const extension = path.extname(preferredPath)
        const base = preferredPath.slice(0, -extension.length)
        for (let suffix = 2; suffix < 10000; suffix += 1) {
          const candidate = `${base} (${suffix})${extension}`
          if (!await exists(candidate)) return { path: candidate, skip: false }
        }
        throw new AppError('DOWNLOAD_FILE_CONFLICT', 409, '无法生成不重名的下载文件名')
      }
    }
  }

  async #moveIntoPlace(partPath: string, targetPath: string): Promise<string> {
    if (this.#config.download.existing_file === 'overwrite') {
      await fsPromises.rename(partPath, targetPath)
      return targetPath
    }
    if (this.#config.download.existing_file === 'skip') {
      try {
        await fsPromises.link(partPath, targetPath)
        await fsPromises.unlink(partPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await fsPromises.unlink(partPath)
      }
      return targetPath
    }
    const extension = path.extname(targetPath)
    const base = targetPath.slice(0, -extension.length)
    for (let suffix = 1; suffix < 10000; suffix += 1) {
      const candidate = suffix === 1 ? targetPath : `${base} (${suffix})${extension}`
      try {
        await fsPromises.link(partPath, candidate)
        await fsPromises.unlink(partPath)
        return candidate
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    throw new AppError('DOWNLOAD_FILE_CONFLICT', 409, '无法生成不重名的下载文件名')
  }

  async #loadLyrics(track: Track, signal: AbortSignal): Promise<LyricData | null> {
    if (!this.#config.download.save_lrc && !this.#config.download.embed_lyric) return null
    try {
      const result = await this.#providers.getLyrics(track, signal)
      return {
        lyric: result.lyric ?? '',
        tlyric: result.tlyric ?? null,
        rlyric: result.rlyric ?? null,
        lxlyric: result.lxlyric ?? null,
      }
    } catch (error) {
      this.#logger.warn({ err: error, trackId: track.id }, '获取下载歌词失败，继续保存音频')
      return null
    }
  }

  async #writeMp3Metadata(
    filePath: string,
    extension: string,
    track: Track,
    lyrics: LyricData | null,
    signal: AbortSignal,
  ): Promise<void> {
    if (extension !== 'mp3') return
    const tags: NodeID3.Tags = { title: track.name, artist: track.singer, album: track.albumName }
    if (lyrics && this.#config.download.embed_lyric) {
      tags.unsynchronisedLyrics = {
        language: 'und',
        text: buildLyrics(
          lyrics,
          this.#config.download.save_word_by_word_lyric,
          this.#config.download.save_translated_lyric,
          this.#config.download.save_romanized_lyric,
        ),
      }
    }
    if (this.#config.download.embed_cover) {
      try {
        const coverUrl = await this.#providers.getCover(track, signal)
        const cover = await requestBuffer(coverUrl, { timeout: this.#config.network.request_timeout_ms })
        const mime = firstHeader(cover.headers['content-type'])?.split(';', 1)[0] ?? 'image/jpeg'
        if (cover.statusCode >= 200 && cover.statusCode < 300 && mime.startsWith('image/')) {
          tags.image = { mime, type: { id: 3 }, description: 'Cover', imageBuffer: cover.raw }
        }
      } catch (error) {
        this.#logger.warn({ err: error, trackId: track.id }, '获取或嵌入封面失败，继续保存音频')
      }
    }
    signal.throwIfAborted()
    try {
      await NodeID3.Promise.update(tags, filePath)
    } catch (error) {
      this.#logger.warn({ err: error, trackId: track.id }, '写入 MP3 元数据失败，继续保存音频')
    }
  }

  #complete(
    id: string,
    resolved: ResolvedMusicUrl,
    filePath: string,
    fileName: string,
    contentType: string | null,
    bytes: number,
    totalBytes: number | null,
  ): void {
    const completedAt = new Date()
    const expiresAt = new Date(completedAt.getTime() + this.#config.download.retention_hours * 60 * 60 * 1000)
    this.#db.prepare(`
      UPDATE download_jobs SET state = 'completed', resolved_track_json = ?, resolved_quality = ?,
        source_fallback_used = ?, quality_fallback_used = ?, file_path = ?, file_name = ?, content_type = ?,
        bytes_downloaded = ?, total_bytes = ?, error_code = NULL, error_message = NULL,
        completed_at = ?, expires_at = ?, updated_at = ? WHERE id = ?
    `).run(
      JSON.stringify(resolved.track), resolved.resolvedQuality, resolved.sourceFallbackUsed ? 1 : 0,
      resolved.qualityFallbackUsed ? 1 : 0, filePath, fileName, contentType, bytes, totalBytes,
      completedAt.toISOString(), expiresAt.toISOString(), completedAt.toISOString(), id,
    )
    this.#scheduleCleanup()
  }

  public async cleanupExpired(): Promise<number> {
    const rows = this.#db.prepare<[string], DownloadRow>(`
      SELECT * FROM download_jobs WHERE state = 'completed' AND expires_at IS NOT NULL AND expires_at <= ?
    `).all(new Date().toISOString())
    for (const row of rows) await this.#expire(row)
    return rows.length
  }

  async #expire(row: DownloadRow): Promise<void> {
    await this.#removeRowArtifacts(row)
    this.#db.prepare(`
      UPDATE download_jobs SET state = 'expired', file_path = NULL, updated_at = ? WHERE id = ?
    `).run(new Date().toISOString(), row.id)
  }

  async #removeRowArtifacts(row: DownloadRow): Promise<void> {
    const candidates = [row.file_path, row.file_path?.replace(/\.[^.]+$/, '.lrc')].filter((value): value is string => value != null)
    for (const candidate of candidates) {
      if (isWithinDirectory(this.#config.paths.downloads, candidate)) {
        await fsPromises.rm(candidate, { force: true }).catch(error => this.#logger.warn({ err: error }, '删除下载产物失败'))
      }
    }
    await fsPromises.rm(path.join(this.#config.paths.downloads, `.lxmusic2api-${row.id}.part`), { force: true }).catch(() => undefined)
  }

  async #cleanupStaleParts(): Promise<void> {
    const entries = await fsPromises.readdir(this.#config.paths.downloads, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !MANAGED_PART_PATTERN.test(entry.name)) continue
      const candidate = path.join(this.#config.paths.downloads, entry.name)
      await fsPromises.rm(candidate, { force: true })
    }
  }

  public async close(): Promise<void> {
    this.#closing = true
    if (this.#cleanupTimer) clearInterval(this.#cleanupTimer)
    this.#db.prepare(`UPDATE download_jobs SET state = 'paused', updated_at = ? WHERE state IN ('queued', 'running')`)
      .run(new Date().toISOString())
    const active = [...this.#active.values()]
    for (const item of active) item.controller.abort(new Error('服务正在关闭'))
    await Promise.allSettled(active.map(item => item.promise))
  }
}

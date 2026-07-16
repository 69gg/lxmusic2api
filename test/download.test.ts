import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyBaseLogger } from 'fastify'
import { AppDatabase } from '@app/database/database'
import { DownloadService } from '@app/download/service'
import type { Track } from '@app/domain/track'
import type { MusicUrlService } from '@app/music/url-service'
import { openHttpStream, type HttpStreamResponse } from '@app/network/http-client'
import type { ProviderService } from '@app/provider/service'
import { createTestConfig } from './helpers'

vi.mock('@app/network/http-client', () => ({
  openHttpStream: vi.fn(),
  requestBuffer: vi.fn(),
}))

const directories: string[] = []

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

const FLAC_TRACK: Track = {
  id: 'kw_download-1',
  source: 'kw',
  name: 'Download Test',
  singer: 'Test Singer',
  interval: '00:01',
  albumName: 'Test Album',
  picUrl: null,
  qualities: [{ type: 'flac', size: '4 B' }],
  sourceData: { songId: 'download-1' },
}

describe('持久化下载服务', () => {
  it('完成原子下载、到期清理，并在重启时暂停未完成任务', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lxmusic2api-download-'))
    directories.push(directory)
    const config = createTestConfig(directory)
    config.download.embed_cover = false
    config.download.embed_lyric = false
    config.download.save_lrc = false
    config.download.existing_file = 'rename'

    vi.mocked(openHttpStream).mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'audio/flac', 'content-length': '4' },
      body: Readable.from([Buffer.from('FLAC')]) as unknown as HttpStreamResponse['body'],
      finalUrl: new URL('https://audio.invalid/test.flac'),
    })

    const urls = {
      resolve: vi.fn(() => Promise.resolve({
        url: 'https://audio.invalid/test.flac',
        track: FLAC_TRACK,
        requestedQuality: 'flac',
        resolvedQuality: 'flac',
        qualityFallbackUsed: false,
        sourceFallbackUsed: false,
      })),
    } as unknown as MusicUrlService
    const providers = {} as ProviderService
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
    } as unknown as FastifyBaseLogger
    const database = new AppDatabase(config.paths.database)
    const service = new DownloadService(config, database.connection, urls, providers, logger)
    await fs.mkdir(config.paths.downloads, { recursive: true })
    const stalePart = path.join(config.paths.downloads, '.lxmusic2api-00000000-0000-4000-8000-000000000000.part')
    await fs.writeFile(stalePart, 'partial', 'utf8')
    await service.initialize()
    await expect(fs.access(stalePart)).rejects.toThrow()

    const created = service.create({ track: FLAC_TRACK, quality: 'flac', strictQuality: true })
    await expect.poll(() => service.get(created.id).state).toBe('completed')
    const file = await service.getFile(created.id)
    expect(await fs.readFile(file.path, 'utf8')).toBe('FLAC')

    database.connection.prepare("UPDATE download_jobs SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), created.id)
    expect(await service.cleanupExpired()).toBe(1)
    expect(service.get(created.id).state).toBe('expired')
    await expect(fs.access(file.path)).rejects.toThrow()

    await service.close()
    database.connection.prepare("UPDATE download_jobs SET state = 'running' WHERE id = ?").run(created.id)
    const restarted = new DownloadService(config, database.connection, urls, providers, logger)
    await restarted.initialize()
    expect(restarted.get(created.id).state).toBe('paused')
    await restarted.close()
    database.close()
  })
})

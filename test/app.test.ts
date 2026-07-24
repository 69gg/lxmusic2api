import fs from 'node:fs/promises'
import http, { type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '@app/app'
import { getRequestSignal, requestTimeoutRouteConfig } from '@app/api/request-signal'
import type { Track } from '@app/domain/track'
import { ProviderService } from '@app/provider/service'
import { createTestConfig, TEST_TRACK } from './helpers'

const applications: FastifyInstance[] = []
const directories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(applications.splice(0).map(application => application.close()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })))
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

const createDirectory = async (): Promise<string> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lxmusic2api-app-'))
  directories.push(directory)
  return directory
}

const listen = async (app: FastifyInstance): Promise<string> => {
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('测试服务器未监听 TCP 端口')
  return `http://127.0.0.1:${address.port}`
}

const listenAudioServer = async (server: Server): Promise<string> => {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  servers.push(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('音频测试服务器未监听 TCP 端口')
  return `http://127.0.0.1:${address.port}`
}

const customSourceScript = (options: {
  name: string
  qualities: string[]
  url?: string
  error?: string
}): string => `/**
 * @name ${options.name}
 * @version 1.0.0
 */
lx.on(lx.EVENT_NAMES.request, async request => {
  if (request.action !== 'musicUrl') throw new Error('unsupported')
  ${options.error ? `throw new Error(${JSON.stringify(options.error)})` : `return ${JSON.stringify(options.url)}`}
})
lx.send(lx.EVENT_NAMES.inited, {
  sources: {
    kw: { type: 'music', actions: ['musicUrl'], qualitys: ${JSON.stringify(options.qualities)} },
  },
})
`

const multiProviderCustomSourceScript = (name: string, urls: { wy: string, kw: string }): string => `/**
 * @name ${name}
 * @version 1.0.0
 */
lx.on(lx.EVENT_NAMES.request, async request => {
  if (request.action !== 'musicUrl') throw new Error('unsupported')
  return request.source === 'wy' ? ${JSON.stringify(urls.wy)} : ${JSON.stringify(urls.kw)}
})
lx.send(lx.EVENT_NAMES.inited, {
  sources: {
    wy: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] },
    kw: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] },
  },
})
`

describe('HTTP API', () => {
  it('自定义源缺失时降级启动，并保护所有 v1 接口', async () => {
    const directory = await createDirectory()
    const config = createTestConfig(directory)
    const app = await buildApp(config)
    applications.push(app)

    const health = await app.inject({ method: 'GET', url: '/healthz' })
    expect(health.statusCode).toBe(200)
    const ready = await app.inject({ method: 'GET', url: '/readyz' })
    expect(ready.statusCode).toBe(200)
    expect(ready.json()).toMatchObject({ status: 'degraded', musicUrlResolver: 'degraded' })

    const unauthenticated = await app.inject({ method: 'GET', url: '/v1/providers' })
    expect(unauthenticated.statusCode).toBe(401)
    const authenticated = await app.inject({
      method: 'GET',
      url: '/v1/providers',
      headers: { authorization: `Bearer ${config.auth.api_key}` },
    })
    expect(authenticated.statusCode).toBe(200)
    expect(authenticated.body).not.toContain('customSource')

    const created = await app.inject({
      method: 'POST',
      url: '/v1/downloads',
      headers: { authorization: `Bearer ${config.auth.api_key}` },
      payload: { track: TEST_TRACK, quality: '128k' },
    })
    expect(created.statusCode, created.body).toBe(202)
    const downloadId = created.json<{ data: { id: string } }>().data.id
    await expect.poll(async () => {
      const status = await app.inject({
        method: 'GET',
        url: `/v1/downloads/${downloadId}`,
        headers: { authorization: `Bearer ${config.auth.api_key}` },
      })
      return status.json<{ data: { state: string } }>().data.state
    }).toBe('failed')
  })

  it('从显式配置脚本加载自定义源，API 不返回其元数据', async () => {
    const directory = await createDirectory()
    const config = createTestConfig(directory)
    await fs.writeFile(config.custom_source.script_path, `/**
 * @name 仅用于自动化测试的源
 * @description synthetic
 * @version 1.0.0
 * @author test
 * @homepage https://invalid.example
 */
lx.on(lx.EVENT_NAMES.request, async request => {
  if (request.action !== 'musicUrl') throw new Error('unsupported')
  if (lx.utils.crypto.md5('hello') !== '5d41402abc4b2a76b9719d911017c592') throw new Error('md5 failed')
  const compressed = await lx.utils.zlib.deflate(lx.utils.buffer.from('bridge-ok'))
  const inflated = await lx.utils.zlib.inflate(compressed)
  if (lx.utils.buffer.bufToString(inflated, 'utf8') !== 'bridge-ok') throw new Error('zlib failed')
  await new Promise(resolve => setTimeout(resolve, 1))
  return 'https://audio.invalid.example/test.mp3'
})
lx.send(lx.EVENT_NAMES.inited, {
  sources: {
    kw: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] },
  },
})
`, 'utf8')
    const app = await buildApp(config)
    applications.push(app)

    const ready = await app.inject({ method: 'GET', url: '/readyz' })
    expect(ready.json()).toMatchObject({ status: 'ready' })
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tracks/resolve',
      headers: { authorization: `Bearer ${config.auth.api_key}` },
      payload: { track: TEST_TRACK, quality: '128k' },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ data: { url: 'https://audio.invalid.example/test.mp3' } })
    expect(response.json()).toMatchObject({
      data: { track: { picUrl: null, qualities: [{ type: '128k', size: null }] } },
    })
    expect(response.body).not.toContain('仅用于自动化测试的源')
    expect(response.body).not.toContain('synthetic')
  })

  it('自动加载目录中的全部 JS，并按音质与健康状态选择和回退', async () => {
    const directory = await createDirectory()
    const sourceDirectory = path.join(directory, 'sources')
    const config = createTestConfig(directory)
    config.custom_source.script_path = ''
    config.custom_source.directory_path = sourceDirectory
    await fs.mkdir(sourceDirectory, { recursive: true })
    await Promise.all([
      fs.writeFile(path.join(sourceDirectory, 'a-low.js'), customSourceScript({
        name: '低音质源',
        qualities: ['128k'],
        url: 'https://audio.invalid.example/low.mp3',
      }), 'utf8'),
      fs.writeFile(path.join(sourceDirectory, 'b-failing.js'), customSourceScript({
        name: '故障源',
        qualities: ['320k'],
        error: 'synthetic failure',
      }), 'utf8'),
      fs.writeFile(path.join(sourceDirectory, 'c-best.js'), customSourceScript({
        name: '最佳源',
        qualities: ['320k', '128k'],
        url: 'https://audio.invalid.example/best.mp3',
      }), 'utf8'),
      fs.writeFile(path.join(sourceDirectory, '00-ignored.txt'), customSourceScript({
        name: '不应加载',
        qualities: ['320k'],
        url: 'https://audio.invalid.example/ignored.mp3',
      }), 'utf8'),
      fs.writeFile(path.join(sourceDirectory, 'invalid.js'), 'not a valid custom source', 'utf8'),
    ])
    const app = await buildApp(config)
    applications.push(app)

    const ready = await app.inject({ method: 'GET', url: '/readyz' })
    expect(ready.json()).toMatchObject({ status: 'ready', musicUrlResolver: 'ready' })
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tracks/resolve',
      headers: { authorization: `Bearer ${config.auth.api_key}` },
      payload: {
        track: {
          ...TEST_TRACK,
          qualities: [
            { type: '320k', size: null },
            { type: '128k', size: null },
          ],
        },
        quality: '320k',
      },
    })

    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({
      data: {
        url: 'https://audio.invalid.example/best.mp3',
        requestedQuality: '320k',
        resolvedQuality: '320k',
        qualityFallbackUsed: false,
      },
    })
  })

  it('音频内容疑似防盗链占位时自动尝试下一个兼容自定义源', async () => {
    const badAudio = Buffer.alloc(185_336)
    const goodAudio = Buffer.alloc(800_000, 1)
    const hits: string[] = []
    const audioServer = http.createServer((request, response) => {
      const pathname = request.url ?? '/'
      hits.push(pathname)
      const body = pathname === '/bad' ? badAudio : goodAudio
      response.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-length': String(body.length),
      })
      response.end(body)
    })
    const baseUrl = await listenAudioServer(audioServer)
    const directory = await createDirectory()
    const sourceDirectory = path.join(directory, 'sources')
    const config = createTestConfig(directory)
    config.custom_source.script_path = ''
    config.custom_source.directory_path = sourceDirectory
    config.music.allow_source_fallback = true
    const findMatches = vi.spyOn(ProviderService.prototype, 'findMatches').mockResolvedValue([])
    await fs.mkdir(sourceDirectory, { recursive: true })
    await Promise.all([
      fs.writeFile(path.join(sourceDirectory, 'a-placeholder.js'), customSourceScript({
        name: '占位音频源',
        qualities: ['128k'],
        url: `${baseUrl}/bad`,
      }), 'utf8'),
      fs.writeFile(path.join(sourceDirectory, 'b-complete.js'), customSourceScript({
        name: '完整音频源',
        qualities: ['128k'],
        url: `${baseUrl}/good`,
      }), 'utf8'),
    ])
    const app = await buildApp(config)
    applications.push(app)

    const result = await app.inject({
      method: 'POST',
      url: '/v1/tracks/stream',
      headers: { authorization: `Bearer ${config.auth.api_key}` },
      payload: { track: { ...TEST_TRACK, interval: '03:33' }, quality: '128k' },
    })

    expect(result.statusCode, result.body).toBe(200)
    expect(result.rawPayload).toEqual(goodAudio)
    expect(hits).toEqual(['/bad', '/good'])
    expect(findMatches).not.toHaveBeenCalled()
    expect(result.headers['x-lxmusic2api-resolved-source']).toBe('kw')
    expect(result.headers['x-lxmusic2api-requested-quality']).toBe('128k')
    expect(result.headers['x-lxmusic2api-resolved-quality']).toBe('128k')
    expect(result.headers['x-lxmusic2api-source-fallback-used']).toBe('false')
    expect(result.headers['x-lxmusic2api-quality-fallback-used']).toBe('false')
  })

  it('音频流响应头报告最终降级后的音质', async () => {
    const audio = Buffer.alloc(800_000, 1)
    const audioServer = http.createServer((_request, response) => {
      response.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-length': String(audio.length),
      })
      response.end(audio)
    })
    const baseUrl = await listenAudioServer(audioServer)
    const directory = await createDirectory()
    const sourceDirectory = path.join(directory, 'sources')
    const config = createTestConfig(directory)
    config.custom_source.script_path = ''
    config.custom_source.directory_path = sourceDirectory
    await fs.mkdir(sourceDirectory, { recursive: true })
    await fs.writeFile(path.join(sourceDirectory, 'only-128k.js'), customSourceScript({
      name: '仅 128k 音源',
      qualities: ['128k'],
      url: `${baseUrl}/audio`,
    }), 'utf8')
    const app = await buildApp(config)
    applications.push(app)

    const result = await app.inject({
      method: 'POST',
      url: '/v1/tracks/stream',
      headers: { authorization: `Bearer ${config.auth.api_key}` },
      payload: {
        track: {
          ...TEST_TRACK,
          interval: '03:33',
          qualities: [
            { type: '320k', size: null },
            { type: '128k', size: null },
          ],
        },
        quality: '320k',
      },
    })

    expect(result.statusCode, result.body).toBe(200)
    expect(result.rawPayload).toEqual(audio)
    expect(result.headers['x-lxmusic2api-resolved-source']).toBe('kw')
    expect(result.headers['x-lxmusic2api-requested-quality']).toBe('320k')
    expect(result.headers['x-lxmusic2api-resolved-quality']).toBe('128k')
    expect(result.headers['x-lxmusic2api-source-fallback-used']).toBe('false')
    expect(result.headers['x-lxmusic2api-quality-fallback-used']).toBe('true')
  })

  it('全部候选均返回占位音频时明确失败而不回传伪音频', async () => {
    const placeholder = Buffer.alloc(185_336)
    const audioServer = http.createServer((_request, response) => {
      response.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-length': String(placeholder.length),
      })
      response.end(placeholder)
    })
    const baseUrl = await listenAudioServer(audioServer)
    const directory = await createDirectory()
    const sourceDirectory = path.join(directory, 'sources')
    const config = createTestConfig(directory)
    config.custom_source.script_path = ''
    config.custom_source.directory_path = sourceDirectory
    await fs.mkdir(sourceDirectory, { recursive: true })
    await Promise.all(['a', 'b'].map(name => fs.writeFile(
      path.join(sourceDirectory, `${name}.js`),
      customSourceScript({ name, qualities: ['128k'], url: `${baseUrl}/${name}` }),
      'utf8',
    )))
    const app = await buildApp(config)
    applications.push(app)

    const result = await app.inject({
      method: 'POST',
      url: '/v1/tracks/stream',
      headers: { authorization: `Bearer ${config.auth.api_key}` },
      payload: { track: { ...TEST_TRACK, interval: '03:33' }, quality: '128k' },
    })

    expect(result.statusCode, result.body).toBe(502)
    expect(result.json()).toMatchObject({
      error: {
        code: 'ALL_AUDIO_SOURCES_FAILED',
        message: '所有兼容自定义源均未返回可用的完整音频（已尝试 2 个）',
      },
    })
    expect(result.rawPayload).not.toEqual(placeholder)
  })

  it('跨平台回退只在原平台的全部 ready 自定义源失败后开始', async () => {
    const placeholder = Buffer.alloc(185_336)
    const completeAudio = Buffer.alloc(800_000, 2)
    const hits: string[] = []
    const audioServer = http.createServer((request, response) => {
      const pathname = request.url ?? '/'
      hits.push(pathname)
      const body = pathname.startsWith('/wy-') ? placeholder : completeAudio
      response.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-length': String(body.length),
      })
      response.end(body)
    })
    const baseUrl = await listenAudioServer(audioServer)
    const directory = await createDirectory()
    const sourceDirectory = path.join(directory, 'sources')
    const config = createTestConfig(directory)
    config.custom_source.script_path = ''
    config.custom_source.directory_path = sourceDirectory
    config.music.allow_source_fallback = true
    await fs.mkdir(sourceDirectory, { recursive: true })
    await Promise.all(['a', 'b'].map(name => fs.writeFile(
      path.join(sourceDirectory, `${name}.js`),
      multiProviderCustomSourceScript(name, {
        wy: `${baseUrl}/wy-${name}`,
        kw: `${baseUrl}/kw-${name}`,
      }),
      'utf8',
    )))
    const fallbackTrack: Track = {
      ...TEST_TRACK,
      id: 'kw-fallback',
      source: 'kw' as const,
      interval: '03:33',
      qualities: TEST_TRACK.qualities.map(quality => ({ ...quality })),
      sourceData: { songId: 'fallback' },
    }
    vi.spyOn(ProviderService.prototype, 'findMatches').mockResolvedValue([fallbackTrack])
    const app = await buildApp(config)
    applications.push(app)
    const originalTrack: Track = {
      ...TEST_TRACK,
      id: 'wy-original',
      source: 'wy' as const,
      interval: '03:33',
      qualities: TEST_TRACK.qualities.map(quality => ({ ...quality })),
      sourceData: { songId: 'original' },
    }

    const result = await app.inject({
      method: 'POST',
      url: '/v1/tracks/stream',
      headers: { authorization: `Bearer ${config.auth.api_key}` },
      payload: { track: originalTrack, quality: '128k' },
    })

    expect(result.statusCode, result.body).toBe(200)
    expect(result.rawPayload).toEqual(completeAudio)
    expect(hits).toHaveLength(3)
    expect(hits.slice(0, 2).every(pathname => pathname.startsWith('/wy-'))).toBe(true)
    expect(hits[2]).toMatch(/^\/kw-/)
    expect(result.headers['x-lxmusic2api-resolved-source']).toBe('kw')
    expect(result.headers['x-lxmusic2api-requested-quality']).toBe('128k')
    expect(result.headers['x-lxmusic2api-resolved-quality']).toBe('128k')
    expect(result.headers['x-lxmusic2api-source-fallback-used']).toBe('true')
    expect(result.headers['x-lxmusic2api-quality-fallback-used']).toBe('false')
  })

  it('路由超过配置时限时返回 504 并中止上游工作', async () => {
    const directory = await createDirectory()
    const config = createTestConfig(directory)
    config.server.request_timeout_ms = 25
    const aborted = vi.fn()
    vi.spyOn(ProviderService.prototype, 'searchTracks').mockImplementation(async (
      _query,
      _source,
      _page,
      _limit,
      signal,
    ): Promise<never> => {
      if (!signal) throw new Error('缺少请求取消信号')
      signal.throwIfAborted()
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted()
          reject(signal.reason instanceof Error ? signal.reason : new Error('请求已取消'))
        }, { once: true })
      })
    })

    const app = await buildApp(config)
    applications.push(app)
    const response = await app.inject({
      method: 'GET',
      url: '/v1/search/tracks?q=test&source=all&page=1&limit=20',
      headers: { authorization: `Bearer ${config.auth.api_key}` },
    })

    expect(response.statusCode, response.body).toBe(504)
    expect(response.json()).toMatchObject({
      error: { code: 'REQUEST_TIMEOUT', message: '请求处理超时' },
    })
    expect(aborted).toHaveBeenCalledOnce()
  })

  it('真实 POST 请求读完正文后不会误判为客户端断开', async () => {
    const directory = await createDirectory()
    const config = createTestConfig(directory)
    const app = await buildApp(config)
    applications.push(app)
    app.post('/request-signal-probe', async request => {
      const signal = getRequestSignal(request)
      await sleep(0, undefined, { signal })
      return { aborted: signal.aborted }
    })

    const baseUrl = await listen(app)
    const response = await fetch(`${baseUrl}/request-signal-probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ test: true }),
    })

    expect(response.status, await response.text()).toBe(200)
  })

  it('真实 POST 请求仍执行超时，且路由可以覆盖为更长时限', async () => {
    const directory = await createDirectory()
    const config = createTestConfig(directory)
    config.server.request_timeout_ms = 25
    const app = await buildApp(config)
    applications.push(app)
    app.post('/slow-post', async request => {
      const signal = getRequestSignal(request)
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const reason = signal.reason as unknown
          reject(reason instanceof Error ? reason : new Error('请求已取消', { cause: reason }))
        }, { once: true })
      })
    })
    app.post('/long-post', {
      config: requestTimeoutRouteConfig(250),
    }, async request => {
      await sleep(50, undefined, { signal: getRequestSignal(request) })
      return { ok: true }
    })

    const baseUrl = await listen(app)
    const longResponse = await fetch(`${baseUrl}/long-post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ test: true }),
    })
    const timeoutResponse = await fetch(`${baseUrl}/slow-post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ test: true }),
    })

    expect(longResponse.status, await longResponse.text()).toBe(200)
    expect(timeoutResponse.status, await timeoutResponse.text()).toBe(504)
  })

  it('客户端主动断开时会中止请求后台工作', async () => {
    const directory = await createDirectory()
    const config = createTestConfig(directory)
    const app = await buildApp(config)
    applications.push(app)
    const aborted = vi.fn()
    let markStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => {
      markStarted = resolve
    })
    app.post('/disconnect-probe', async request => {
      const signal = getRequestSignal(request)
      markStarted?.()
      await new Promise<void>(resolve => {
        signal.addEventListener('abort', () => {
          aborted()
          resolve()
        }, { once: true })
      })
      return { aborted: true }
    })

    const baseUrl = await listen(app)
    const controller = new AbortController()
    const response = fetch(`${baseUrl}/disconnect-probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ test: true }),
      signal: controller.signal,
    })
    await started
    controller.abort()

    await expect(response).rejects.toThrow()
    await expect.poll(() => aborted.mock.calls.length).toBe(1)
  })
})

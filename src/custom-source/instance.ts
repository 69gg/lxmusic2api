import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import type { FastifyBaseLogger } from 'fastify'
import type { AppConfig } from '@app/config/schema'
import { AppError } from '@app/api/errors'
import { QUALITY_ORDER, toUpstreamTrack, type Provider, type Quality, type Track } from '@app/domain/track'
import { assertConfiguredSafeUrl, requestBuffer, type CompatibleRequestOptions } from '@app/network/http-client'
import { runWithRequestSignal } from '@app/network/request-context'
import { SerialExecutor } from '@app/utils/serial-executor'
import { parseCustomSourceMetadata } from './metadata.js'
import type {
  CustomSourceCapabilities,
  MainToWorkerMessage,
  SourceWorkerData,
  WorkerToMainMessage,
} from './protocol.js'

export type ResolverStatus = 'starting' | 'ready' | 'degraded' | 'closed'

interface PendingInvocation {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export interface CustomSourceResolution {
  url: string
  requestedQuality: Quality
  resolvedQuality: Quality
  fallbackUsed: boolean
}

const PROVIDERS = new Set<Provider>(['kw', 'kg', 'tx', 'wy', 'mg'])
const URL_QUALITIES = new Set<Quality>(['128k', '320k', 'flac', 'flac24bit'])
const LATENCY_WEIGHT = 0.25

const sanitizeCapabilities = (value: unknown): CustomSourceCapabilities => {
  if (typeof value !== 'object' || value === null) throw new Error('自定义源未声明 sources')
  const capabilities: CustomSourceCapabilities = {}
  for (const [source, raw] of Object.entries(value)) {
    if (!PROVIDERS.has(source as Provider) || typeof raw !== 'object' || raw === null) continue
    const item = raw as { type?: unknown, actions?: unknown, qualitys?: unknown }
    if (item.type !== 'music' || !Array.isArray(item.actions) || !item.actions.includes('musicUrl')) continue
    const qualities = Array.isArray(item.qualitys)
      ? [...new Set(item.qualitys.filter((quality): quality is Quality => URL_QUALITIES.has(quality as Quality)))]
      : []
    if (qualities.length > 0) capabilities[source as Provider] = { actions: ['musicUrl'], qualities }
  }
  if (Object.keys(capabilities).length === 0) throw new Error('自定义源不支持任何在线平台的 musicUrl')
  return capabilities
}

const decodeBufferJson = (_key: string, value: unknown): unknown => {
  if (typeof value !== 'object' || value === null) return value
  const candidate = value as { type?: unknown, data?: unknown }
  return candidate.type === 'Buffer' && Array.isArray(candidate.data) ? Buffer.from(candidate.data as number[]) : value
}

export class CustomSourceInstance {
  readonly #config: AppConfig
  readonly #logger: FastifyBaseLogger
  readonly #scriptPath: string
  readonly #serial = new SerialExecutor()
  readonly #pendingInvocations = new Map<string, PendingInvocation>()
  readonly #httpControllers = new Map<string, AbortController>()
  #worker: Worker | undefined
  #status: ResolverStatus = 'starting'
  #capabilities: CustomSourceCapabilities = {}
  #consecutiveFailures = 0
  #latencyEwmaMs: number | undefined

  public constructor(config: AppConfig, logger: FastifyBaseLogger, scriptPath: string) {
    this.#config = config
    this.#logger = logger
    this.#scriptPath = scriptPath
  }

  public get status(): ResolverStatus {
    return this.#status
  }

  public get available(): boolean {
    return this.#status === 'ready'
  }

  public get consecutiveFailures(): number {
    return this.#consecutiveFailures
  }

  public get latencyEwmaMs(): number {
    return this.#latencyEwmaMs ?? 0
  }

  public supportsProvider(provider: Provider): boolean {
    return this.available && this.#capabilities[provider] != null
  }

  public async initialize(): Promise<void> {
    this.#status = 'starting'
    try {
      const stats = await fs.stat(this.#scriptPath)
      if (!stats.isFile()) throw new Error('配置路径不是普通文件')
      if (stats.size > this.#config.custom_source.max_script_bytes) throw new Error('自定义源脚本超过大小限制')
      const script = await fs.readFile(this.#scriptPath, 'utf8')
      const metadata = parseCustomSourceMetadata(script)
      const workerData: SourceWorkerData = {
        script,
        metadata,
        limits: {
          initTimeoutMs: this.#config.custom_source.init_timeout_ms,
          actionTimeoutMs: this.#config.custom_source.action_timeout_ms,
          memoryLimitMb: this.#config.custom_source.memory_limit_mb,
          stackLimitKb: this.#config.custom_source.stack_limit_kb,
          maxHttpRequests: this.#config.custom_source.max_http_requests,
        },
      }
      await this.#startWorker(workerData)
    } catch (error) {
      this.#markDegraded(error)
    }
  }

  async #startWorker(workerData: SourceWorkerData): Promise<void> {
    const builtWorkerUrl = new URL('./custom-source-worker.js', import.meta.url)
    const developmentWorkerUrl = new URL('./worker.ts', import.meta.url)
    const useBuiltWorker = existsSync(fileURLToPath(builtWorkerUrl))
    const worker = new Worker(useBuiltWorker ? builtWorkerUrl : developmentWorkerUrl, {
      workerData,
      ...(useBuiltWorker ? {} : { execArgv: ['--import', 'tsx'] }),
      resourceLimits: {
        maxOldGenerationSizeMb: workerData.limits.memoryLimitMb + 32,
        stackSizeMb: Math.max(1, Math.ceil(workerData.limits.stackLimitKb / 1024) + 1),
      },
    })
    this.#worker = worker
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('自定义源初始化超时')), workerData.limits.initTimeoutMs + 500)
      const handleMessage = (message: WorkerToMainMessage): void => {
        if (message.type === 'inited') {
          try {
            this.#capabilities = sanitizeCapabilities(message.sources)
            this.#status = 'ready'
            clearTimeout(timeout)
            resolve()
          } catch (error) {
            clearTimeout(timeout)
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        } else if (message.type === 'initError') {
          clearTimeout(timeout)
          reject(new Error(message.error))
        }
        this.#handleWorkerMessage(message)
      }
      worker.on('message', handleMessage)
      worker.once('error', error => {
        clearTimeout(timeout)
        reject(error)
        this.#markDegraded(error)
      })
      worker.once('exit', code => {
        if (!['closed', 'degraded'].includes(this.#status) && code !== 0) {
          this.#markDegraded(new Error(`自定义源 Worker 异常退出：${code}`))
        }
      })
    }).catch(async error => {
      await worker.terminate()
      if (this.#worker === worker) this.#worker = undefined
      throw error
    })
  }

  #markDegraded(error: unknown): void {
    if (this.#status === 'closed' || this.#status === 'degraded') return
    this.#status = 'degraded'
    this.#capabilities = {}
    this.#logger.error({ err: error, source: path.basename(this.#scriptPath) }, '自定义源不可用')
    for (const pending of this.#pendingInvocations.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('自定义源运行时不可用'))
    }
    this.#pendingInvocations.clear()
    for (const controller of this.#httpControllers.values()) controller.abort()
    this.#httpControllers.clear()
  }

  #handleWorkerMessage(message: WorkerToMainMessage): void {
    switch (message.type) {
      case 'invokeResult': {
        const pending = this.#pendingInvocations.get(message.id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.#pendingInvocations.delete(message.id)
        if (message.ok) pending.resolve(message.result)
        else pending.reject(new AppError('CUSTOM_SOURCE_ERROR', 502, message.error ?? '自定义源调用失败'))
        break
      }
      case 'httpRequest': void this.#handleHttpRequest(message); break
      case 'httpCancel': this.#httpControllers.get(message.id)?.abort(new Error('自定义源取消请求')); break
      case 'updateNotice': this.#logger.warn({ source: path.basename(this.#scriptPath) }, '自定义源报告了更新提示；内容未写入日志或 API'); break
      case 'scriptError': this.#logger.warn({ source: path.basename(this.#scriptPath) }, '自定义源脚本调用了 console.error；参数已丢弃'); break
      default: break
    }
  }

  async #handleHttpRequest(message: Extract<WorkerToMainMessage, { type: 'httpRequest' }>): Promise<void> {
    const controller = new AbortController()
    this.#httpControllers.set(message.id, controller)
    try {
      const options = JSON.parse(JSON.stringify(message.options), decodeBufferJson) as CompatibleRequestOptions
      const configuredTimeout = this.#config.network.request_timeout_ms
      options.timeout = Math.min(Math.max(Number(options.timeout ?? configuredTimeout), 1), 60000)
      const response = await runWithRequestSignal(controller.signal, async () => requestBuffer(message.url, options))
      this.#post({
        type: 'httpResponse',
        id: message.id,
        ok: true,
        payload: {
          statusCode: response.statusCode,
          statusMessage: response.statusMessage,
          headers: response.headers,
          bytes: response.bytes,
          rawBase64: response.raw.toString('base64'),
          body: response.body,
        },
      })
    } catch (error) {
      this.#post({
        type: 'httpResponse',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.#httpControllers.delete(message.id)
    }
  }

  #post(message: MainToWorkerMessage): void {
    this.#worker?.postMessage(message)
  }

  async #invoke(payload: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.available || !this.#worker) {
      throw new AppError('MUSIC_RESOLVER_UNAVAILABLE', 503, '音乐 URL 解析能力当前不可用')
    }
    return this.#serial.run('custom-source', async () => {
      signal?.throwIfAborted()
      const id = randomUUID()
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pendingInvocations.delete(id)
          const error = new AppError('CUSTOM_SOURCE_TIMEOUT', 504, '自定义源调用超时')
          reject(error)
          this.#markDegraded(error)
          const worker = this.#worker
          this.#worker = undefined
          if (worker) void worker.terminate()
        }, this.#config.custom_source.action_timeout_ms + 500)
        this.#pendingInvocations.set(id, { resolve, reject, timer })
        this.#post({ type: 'invoke', id, payload })
      })
    }, signal)
  }

  public selectQuality(track: Track, requested: Quality, strict: boolean): Quality {
    const capability = this.#capabilities[track.source]
    if (!capability) throw new AppError('SOURCE_UNSUPPORTED_BY_RESOLVER', 422, `该自定义源不支持 ${track.source}`)
    const trackQualities = new Set(track.qualities.map(item => item.type))
    const available = new Set(capability.qualities.filter(quality => trackQualities.has(quality)))
    if (available.has(requested)) return requested
    if (strict) throw new AppError('QUALITY_UNAVAILABLE', 422, `音质 ${requested} 不可用`)
    const start = Math.max(0, QUALITY_ORDER.indexOf(requested))
    const fallback = QUALITY_ORDER.slice(start).find(quality => available.has(quality)) ?? QUALITY_ORDER.find(quality => available.has(quality))
    if (!fallback) throw new AppError('QUALITY_UNAVAILABLE', 422, '歌曲与自定义源没有共同支持的音质')
    return fallback
  }

  public async resolveMusicUrl(
    track: Track,
    requested: Quality,
    strict: boolean,
    signal?: AbortSignal,
  ): Promise<CustomSourceResolution> {
    const startedAt = performance.now()
    try {
      const resolvedQuality = this.selectQuality(track, requested, strict)
      const result = await this.#invoke({
        source: track.source,
        action: 'musicUrl',
        info: {
          type: resolvedQuality,
          musicInfo: toUpstreamTrack(track),
        },
      }, signal)
      if (typeof result !== 'string' || result.length > 2048 || !/^https?:\/\//.test(result)) {
        throw new AppError('CUSTOM_SOURCE_INVALID_RESPONSE', 502, '自定义源未返回有效 HTTP(S) 音乐地址')
      }
      await assertConfiguredSafeUrl(result, signal)
      this.#recordSuccess(performance.now() - startedAt)
      return {
        url: result,
        requestedQuality: requested,
        resolvedQuality,
        fallbackUsed: requested !== resolvedQuality,
      }
    } catch (error) {
      if (!signal?.aborted) this.#consecutiveFailures += 1
      throw error
    }
  }

  #recordSuccess(latencyMs: number): void {
    this.#consecutiveFailures = 0
    this.#latencyEwmaMs = this.#latencyEwmaMs == null
      ? latencyMs
      : this.#latencyEwmaMs * (1 - LATENCY_WEIGHT) + latencyMs * LATENCY_WEIGHT
  }

  public async close(): Promise<void> {
    this.#status = 'closed'
    if (this.#worker) {
      this.#post({ type: 'dispose' })
      await this.#worker.terminate()
      this.#worker = undefined
    }
    for (const controller of this.#httpControllers.values()) controller.abort()
    this.#httpControllers.clear()
  }
}

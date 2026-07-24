import fs from 'node:fs/promises'
import path from 'node:path'
import type { FastifyBaseLogger } from 'fastify'
import type { AppConfig } from '@app/config/schema'
import { AppError } from '@app/api/errors'
import { QUALITY_ORDER, type Provider, type Quality, type Track } from '@app/domain/track'
import {
  CustomSourceInstance,
  type CustomSourceResolution,
  type ResolverStatus,
} from './instance.js'

interface ResolutionCandidate {
  source: CustomSourceInstance
  resolvedQuality: Quality
  qualityPenalty: number
  order: number
}

const PROVIDERS: readonly Provider[] = ['kw', 'kg', 'tx', 'wy', 'mg']

const qualityPenalty = (requested: Quality, resolved: Quality): number => {
  if (requested === resolved) return 0
  const requestedIndex = QUALITY_ORDER.indexOf(requested)
  const resolvedIndex = QUALITY_ORDER.indexOf(resolved)
  if (resolvedIndex >= requestedIndex) return resolvedIndex - requestedIndex
  return QUALITY_ORDER.length + requestedIndex - resolvedIndex
}

const compareCandidates = (left: ResolutionCandidate, right: ResolutionCandidate): number => (
  left.qualityPenalty - right.qualityPenalty ||
  left.source.consecutiveFailures - right.source.consecutiveFailures ||
  left.source.latencyEwmaMs - right.source.latencyEwmaMs ||
  left.order - right.order
)

export class CustomSourceManager {
  readonly #config: AppConfig
  readonly #logger: FastifyBaseLogger
  #sources: CustomSourceInstance[] = []
  #status: ResolverStatus = 'starting'

  public constructor(config: AppConfig, logger: FastifyBaseLogger) {
    this.#config = config
    this.#logger = logger
  }

  public get status(): ResolverStatus {
    if (this.#status === 'closed' || this.#status === 'starting') return this.#status
    return this.available ? 'ready' : 'degraded'
  }

  public get available(): boolean {
    return this.#sources.some(source => source.available)
  }

  public providerAvailability(): Record<Provider, boolean> {
    return Object.fromEntries(PROVIDERS.map(provider => [
      provider,
      this.#sources.some(source => source.supportsProvider(provider)),
    ])) as Record<Provider, boolean>
  }

  public async initialize(): Promise<void> {
    this.#status = 'starting'
    const scripts = await this.#discoverScripts()
    this.#sources = scripts.map(script => new CustomSourceInstance(this.#config, this.#logger, script))
    await Promise.all(this.#sources.map(source => source.initialize()))
    this.#status = this.available ? 'ready' : 'degraded'
    if (scripts.length === 0) {
      this.#logger.error('没有配置可加载的自定义源脚本，音乐 URL 解析以降级模式启动')
    } else {
      this.#logger.info({ configured: scripts.length, ready: this.#sources.filter(source => source.available).length }, '自定义源加载完成')
    }
  }

  async #discoverScripts(): Promise<string[]> {
    const scripts: string[] = []
    const explicitPath = this.#config.custom_source.script_path
    if (explicitPath) scripts.push(explicitPath)

    const directoryPath = this.#config.custom_source.directory_path
    if (directoryPath) {
      try {
        const entries = await fs.readdir(directoryPath, { withFileTypes: true })
        const directoryScripts = entries
          .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.js')
          .map(entry => path.join(directoryPath, entry.name))
          .sort((left, right) => left.localeCompare(right))
        scripts.push(...directoryScripts)
      } catch (error) {
        this.#logger.error({ err: error }, '无法读取自定义源目录')
      }
    }

    return [...new Set(scripts.map(script => path.resolve(script)))]
  }

  public async resolveMusicUrl(
    track: Track,
    requested: Quality,
    strict: boolean,
    signal?: AbortSignal,
  ): Promise<CustomSourceResolution> {
    const readySources = this.#sources.filter(source => source.available)
    if (readySources.length === 0) {
      throw new AppError('MUSIC_RESOLVER_UNAVAILABLE', 503, '音乐 URL 解析能力当前不可用')
    }
    const providerSources = readySources.filter(source => source.supportsProvider(track.source))
    if (providerSources.length === 0) {
      throw new AppError('SOURCE_UNSUPPORTED_BY_RESOLVER', 422, `当前自定义源均不支持 ${track.source}`)
    }

    const candidates = providerSources.flatMap((source, order): ResolutionCandidate[] => {
      try {
        const resolvedQuality = source.selectQuality(track, requested, strict)
        return [{ source, resolvedQuality, qualityPenalty: qualityPenalty(requested, resolvedQuality), order }]
      } catch {
        return []
      }
    }).sort(compareCandidates)
    if (candidates.length === 0) {
      throw new AppError('QUALITY_UNAVAILABLE', 422, strict
        ? `当前自定义源均不支持严格音质 ${requested}`
        : '歌曲与当前自定义源没有共同支持的音质')
    }

    const errors: unknown[] = []
    for (const candidate of candidates) {
      try {
        return await candidate.source.resolveMusicUrl(track, requested, strict, signal)
      } catch (error) {
        signal?.throwIfAborted()
        errors.push(error)
      }
    }
    if (errors.length === 1) throw errors[0]
    throw new AppError(
      'ALL_CUSTOM_SOURCES_FAILED',
      502,
      `所有兼容自定义源均解析失败（已尝试 ${errors.length} 个）`,
      true,
      { cause: errors.at(-1) },
    )
  }

  public async close(): Promise<void> {
    this.#status = 'closed'
    const sources = this.#sources
    this.#sources = []
    const results = await Promise.allSettled(sources.map(source => source.close()))
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
  }
}

import type { AppConfig } from '@app/config/schema'
import type { Quality, Track } from '@app/domain/track'
import type { CustomSourceManager } from '@app/custom-source/manager'
import type { ProviderService } from '@app/provider/service'

export interface ResolvedMusicUrl {
  url: string
  track: Track
  requestedQuality: Quality
  resolvedQuality: Quality
  qualityFallbackUsed: boolean
  sourceFallbackUsed: boolean
}

export interface ResolvedMusicUrlValue<T> {
  resolved: ResolvedMusicUrl
  value: T
}

export class MusicUrlService {
  readonly #config: AppConfig
  readonly #resolver: CustomSourceManager
  readonly #providers: ProviderService

  public constructor(config: AppConfig, resolver: CustomSourceManager, providers: ProviderService) {
    this.#config = config
    this.#resolver = resolver
    this.#providers = providers
  }

  public async resolve(track: Track, quality: Quality, strictQuality: boolean, signal?: AbortSignal): Promise<ResolvedMusicUrl> {
    const result = await this.resolveAndUse(track, quality, strictQuality, resolved => Promise.resolve(resolved), signal)
    return result.value
  }

  public async resolveAndUse<T>(
    track: Track,
    quality: Quality,
    strictQuality: boolean,
    use: (resolved: ResolvedMusicUrl) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<ResolvedMusicUrlValue<T>> {
    try {
      return await this.#resolveTrackAndUse(track, quality, strictQuality, false, use, signal)
    } catch (originalError) {
      signal?.throwIfAborted()
      if (!this.#config.music.allow_source_fallback || !this.#resolver.available) throw originalError
      const matches = await this.#providers.findMatches(track, signal)
      for (const candidate of matches.slice(0, this.#config.music.max_fallback_candidates)) {
        try {
          return await this.#resolveTrackAndUse(candidate, quality, strictQuality, true, use, signal)
        } catch {
          signal?.throwIfAborted()
        }
      }
      throw originalError
    }
  }

  async #resolveTrackAndUse<T>(
    track: Track,
    quality: Quality,
    strictQuality: boolean,
    sourceFallbackUsed: boolean,
    use: (resolved: ResolvedMusicUrl) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<ResolvedMusicUrlValue<T>> {
    return this.#resolver.resolveMusicUrlWith(track, quality, strictQuality, async resolution => {
      const resolved: ResolvedMusicUrl = {
        url: resolution.url,
        track,
        requestedQuality: resolution.requestedQuality,
        resolvedQuality: resolution.resolvedQuality,
        qualityFallbackUsed: resolution.fallbackUsed,
        sourceFallbackUsed,
      }
      return { resolved, value: await use(resolved) }
    }, signal)
  }
}

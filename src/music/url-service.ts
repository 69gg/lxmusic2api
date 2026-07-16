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
    try {
      const resolved = await this.#resolver.resolveMusicUrl(track, quality, strictQuality, signal)
      return {
        url: resolved.url,
        track,
        requestedQuality: resolved.requestedQuality,
        resolvedQuality: resolved.resolvedQuality,
        qualityFallbackUsed: resolved.fallbackUsed,
        sourceFallbackUsed: false,
      }
    } catch (originalError) {
      signal?.throwIfAborted()
      if (!this.#config.music.allow_source_fallback || !this.#resolver.available) throw originalError
      const matches = await this.#providers.findMatches(track, signal)
      for (const candidate of matches.slice(0, this.#config.music.max_fallback_candidates)) {
        try {
          const resolved = await this.#resolver.resolveMusicUrl(candidate, quality, strictQuality, signal)
          return {
            url: resolved.url,
            track: candidate,
            requestedQuality: resolved.requestedQuality,
            resolvedQuality: resolved.resolvedQuality,
            qualityFallbackUsed: resolved.fallbackUsed,
            sourceFallbackUsed: true,
          }
        } catch {
          signal?.throwIfAborted()
        }
      }
      throw originalError
    }
  }
}

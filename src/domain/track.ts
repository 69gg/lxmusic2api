import { Type, type Static } from 'typebox'

const NullableString = (options: Record<string, unknown> = {}) => Type.Unsafe<string | null>({
  type: 'string',
  nullable: true,
  ...options,
})

export const ProviderSchema = Type.Union([
  Type.Literal('kw'),
  Type.Literal('kg'),
  Type.Literal('tx'),
  Type.Literal('wy'),
  Type.Literal('mg'),
])

export const QualitySchema = Type.Union([
  Type.Literal('flac24bit'),
  Type.Literal('flac'),
  Type.Literal('wav'),
  Type.Literal('ape'),
  Type.Literal('320k'),
  Type.Literal('192k'),
  Type.Literal('128k'),
])

const QualityInfoSchema = Type.Object({
  type: QualitySchema,
  size: NullableString(),
  hash: Type.Optional(Type.String()),
}, { additionalProperties: false })

const SourceDataSchema = Type.Object({
  songId: Type.Union([Type.String(), Type.Number()]),
  albumId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  hash: Type.Optional(Type.String()),
  mediaMid: Type.Optional(Type.String()),
  numericId: Type.Optional(Type.Number()),
  albumMid: Type.Optional(Type.String()),
  copyrightId: Type.Optional(Type.String()),
  lrcUrl: Type.Optional(Type.String()),
  mrcUrl: Type.Optional(Type.String()),
  trcUrl: Type.Optional(Type.String()),
}, { additionalProperties: false })

export const TrackSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 512 }),
  source: ProviderSchema,
  name: Type.String({ minLength: 1, maxLength: 512 }),
  singer: Type.String({ maxLength: 1024 }),
  interval: NullableString({ maxLength: 32 }),
  albumName: Type.String({ maxLength: 512 }),
  picUrl: NullableString({ maxLength: 4096 }),
  qualities: Type.Array(QualityInfoSchema, { maxItems: 16 }),
  sourceData: SourceDataSchema,
}, { additionalProperties: false })

export type Provider = Static<typeof ProviderSchema>
export type Quality = Static<typeof QualitySchema>
export type Track = Static<typeof TrackSchema>

const PROVIDERS = new Set<Provider>(['kw', 'kg', 'tx', 'wy', 'mg'])

const toDisplayString = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value)
  return ''
}

export const isProvider = (value: unknown): value is Provider => typeof value === 'string' && PROVIDERS.has(value as Provider)

export const fromUpstreamTrack = (raw: Record<string, unknown>): Track => {
  if (!isProvider(raw.source)) throw new Error('上游返回了不支持的平台')
  const source = raw.source
  const songId = raw.songmid
  if ((typeof songId !== 'string' && typeof songId !== 'number') || String(songId).length === 0) {
    throw new Error('上游歌曲缺少 songmid')
  }
  const name = toDisplayString(raw.name).trim()
  if (!name) throw new Error('上游歌曲缺少名称')
  const hash = typeof raw.hash === 'string' ? raw.hash : undefined
  const id = source === 'kg' && hash ? `${songId}_${hash}` : `${source}_${songId}`
  const rawQualities = Array.isArray(raw.types) ? raw.types : []
  const qualities = rawQualities.flatMap(item => {
    if (typeof item !== 'object' || item === null) return []
    const quality = item as Record<string, unknown>
    const type = quality.type
    if (!['flac24bit', 'flac', 'wav', 'ape', '320k', '192k', '128k'].includes(String(type))) return []
    return [{
      type: type as Quality,
      size: typeof quality.size === 'string' ? quality.size : null,
      ...(typeof quality.hash === 'string' ? { hash: quality.hash } : {}),
    }]
  })
  return {
    id,
    source,
    name,
    singer: toDisplayString(raw.singer),
    interval: typeof raw.interval === 'string' ? raw.interval : null,
    albumName: toDisplayString(raw.albumName),
    picUrl: typeof raw.img === 'string' && raw.img ? raw.img : null,
    qualities,
    sourceData: {
      songId,
      ...(typeof raw.albumId === 'string' || typeof raw.albumId === 'number' ? { albumId: raw.albumId } : {}),
      ...(hash ? { hash } : {}),
      ...(typeof raw.strMediaMid === 'string' ? { mediaMid: raw.strMediaMid } : {}),
      ...(typeof raw.songId === 'number' ? { numericId: raw.songId } : {}),
      ...(typeof raw.albumMid === 'string' ? { albumMid: raw.albumMid } : {}),
      ...(typeof raw.copyrightId === 'string' ? { copyrightId: raw.copyrightId } : {}),
      ...(typeof raw.lrcUrl === 'string' ? { lrcUrl: raw.lrcUrl } : {}),
      ...(typeof raw.mrcUrl === 'string' ? { mrcUrl: raw.mrcUrl } : {}),
      ...(typeof raw.trcUrl === 'string' ? { trcUrl: raw.trcUrl } : {}),
    },
  }
}

export const toUpstreamTrack = (track: Track): Record<string, unknown> => {
  const qualityMap = Object.fromEntries(track.qualities.map(quality => [quality.type, {
    size: quality.size,
    ...(quality.hash ? { hash: quality.hash } : {}),
  }]))
  return {
    name: track.name,
    singer: track.singer,
    source: track.source,
    songmid: track.sourceData.songId,
    interval: track.interval,
    albumName: track.albumName,
    img: track.picUrl ?? '',
    albumId: track.sourceData.albumId,
    types: track.qualities,
    _types: qualityMap,
    typeUrl: {},
    hash: track.sourceData.hash,
    strMediaMid: track.sourceData.mediaMid,
    songId: track.sourceData.numericId,
    albumMid: track.sourceData.albumMid,
    copyrightId: track.sourceData.copyrightId,
    lrcUrl: track.sourceData.lrcUrl,
    mrcUrl: track.sourceData.mrcUrl,
    trcUrl: track.sourceData.trcUrl,
  }
}

export const QUALITY_ORDER: readonly Quality[] = [
  'flac24bit', 'flac', 'wav', 'ape', '320k', '192k', '128k',
]

import { Type, type Static } from 'typebox'
import { QualitySchema, TrackSchema } from '@app/domain/track'

export const DownloadStateSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('paused'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
  Type.Literal('expired'),
])

export type DownloadState = Static<typeof DownloadStateSchema>

export const DownloadJobSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  state: DownloadStateSchema,
  track: TrackSchema,
  resolvedTrack: Type.Union([TrackSchema, Type.Null()]),
  requestedQuality: QualitySchema,
  resolvedQuality: Type.Union([QualitySchema, Type.Null()]),
  strictQuality: Type.Boolean(),
  sourceFallbackUsed: Type.Boolean(),
  qualityFallbackUsed: Type.Boolean(),
  fileName: Type.Union([Type.String(), Type.Null()]),
  contentType: Type.Union([Type.String(), Type.Null()]),
  bytesDownloaded: Type.Integer({ minimum: 0 }),
  totalBytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  error: Type.Union([
    Type.Object({ code: Type.String(), message: Type.String() }, { additionalProperties: false }),
    Type.Null(),
  ]),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
  completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  expiresAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  downloadPath: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false })

export type DownloadJob = Static<typeof DownloadJobSchema>

export const CreateDownloadSchema = Type.Object({
  track: TrackSchema,
  quality: Type.Optional(QualitySchema),
  strictQuality: Type.Optional(Type.Boolean({ default: false })),
}, { additionalProperties: false })

export type CreateDownload = Static<typeof CreateDownloadSchema>

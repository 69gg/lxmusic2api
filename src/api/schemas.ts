import { Type } from 'typebox'
import { ProviderSchema, QualitySchema, TrackSchema } from '@app/domain/track'
import { DownloadStateSchema } from '@app/download/types'

export const SourceOrAllSchema = Type.Union([ProviderSchema, Type.Literal('all')])

export const PaginationSchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000, default: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
}, { additionalProperties: false })

export const SearchQuerySchema = Type.Object({
  q: Type.String({ minLength: 1, maxLength: 200 }),
  source: Type.Optional(SourceOrAllSchema),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000, default: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
}, { additionalProperties: false })

export const SourceQuerySchema = Type.Object({
  source: Type.Optional(SourceOrAllSchema),
}, { additionalProperties: false })

export const SourceParamsSchema = Type.Object({ source: ProviderSchema }, { additionalProperties: false })

export const SourceIdParamsSchema = Type.Object({
  source: ProviderSchema,
  id: Type.String({ minLength: 1, maxLength: 1024 }),
}, { additionalProperties: false })

export const TrackBodySchema = Type.Object({ track: TrackSchema }, { additionalProperties: false })

export const ResolveBodySchema = Type.Object({
  track: TrackSchema,
  quality: Type.Optional(QualitySchema),
  strictQuality: Type.Optional(Type.Boolean({ default: false })),
}, { additionalProperties: false })

export const CommentsBodySchema = Type.Object({
  track: TrackSchema,
  kind: Type.Optional(Type.Union([Type.Literal('latest'), Type.Literal('hot')], { default: 'latest' })),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000, default: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
}, { additionalProperties: false })

export const CommentReplyParamsSchema = Type.Object({
  commentId: Type.String({ minLength: 1, maxLength: 1024 }),
}, { additionalProperties: false })

export const DownloadListQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000, default: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  state: Type.Optional(DownloadStateSchema),
}, { additionalProperties: false })

export const IdParamsSchema = Type.Object({ id: Type.String({ format: 'uuid' }) }, { additionalProperties: false })

export const ErrorResponseSchema = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    requestId: Type.String(),
  }, { additionalProperties: false }),
}, { additionalProperties: false })

export const secureSchema = <T extends Record<string, unknown>>(schema: T): T & { security: Array<{ bearerAuth: never[] }> } => ({
  ...schema,
  security: [{ bearerAuth: [] }],
})

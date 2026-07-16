import { createHash, timingSafeEqual } from 'node:crypto'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type HookHandlerDoneFunction,
} from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import packageInfo from '../package.json' with { type: 'json' }
import type { AppConfig } from '@app/config/schema'
import { AppError } from '@app/api/errors'
import { registerApiRoutes } from '@app/api/routes'
import { AppDatabase } from '@app/database/database'
import { CustomSourceManager } from '@app/custom-source/manager'
import { DownloadService } from '@app/download/service'
import { MusicUrlService } from '@app/music/url-service'
import { closeHttpClient, configureHttpClient } from '@app/network/http-client'
import { ProviderService } from '@app/provider/service'

const unauthorized = (): AppError => new AppError('UNAUTHORIZED', 401, '缺少或无效的 Bearer API 密钥')

const createAuthenticator = (apiKey: string) => {
  const expected = createHash('sha256').update(apiKey).digest()
  return (request: FastifyRequest, _reply: FastifyReply, done: HookHandlerDoneFunction): void => {
    try {
      const authorization = request.headers.authorization
      if (!authorization?.startsWith('Bearer ')) throw unauthorized()
      const token = authorization.slice('Bearer '.length)
      const candidate = createHash('sha256').update(token).digest()
      if (!timingSafeEqual(candidate, expected)) throw unauthorized()
      done()
    } catch (error) {
      done(error instanceof Error ? error : unauthorized())
    }
  }
}

export const buildApp = async (config: AppConfig): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: { level: config.logging.level },
    trustProxy: config.server.trust_proxy,
    bodyLimit: config.server.body_limit_bytes,
    requestTimeout: config.server.request_timeout_ms,
  }).withTypeProvider<TypeBoxTypeProvider>()
  app.setSerializerCompiler(() => data => JSON.stringify(data, (_key, value: unknown) => (
    typeof value === 'bigint' ? value.toString() : value
  )))

  configureHttpClient(config)
  const database = new AppDatabase(config.paths.database)
  const providers = new ProviderService()
  const resolver = new CustomSourceManager(config, app.log)
  const urls = new MusicUrlService(config, resolver, providers)
  const downloads = new DownloadService(config, database.connection, urls, providers, app.log)

  try {
    await resolver.initialize()
    await downloads.initialize()

    await app.register(swagger, {
      openapi: {
        info: {
          title: 'lxmusic2api',
          description: 'LX Music 在线逻辑的无 GUI 私有 API 服务；自定义源仅由服务端配置。',
          version: packageInfo.version,
        },
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer' },
          },
        },
      },
    })
    if (config.server.docs_enabled) {
      await app.register(swaggerUi, { routePrefix: '/docs' })
    }
    if (config.server.cors.enabled) {
      const allowedOrigins = new Set(config.server.cors.origins)
      await app.register(cors, {
        origin: (origin, callback) => {
          if (!origin || allowedOrigins.has(origin)) callback(null, true)
          else callback(new AppError('CORS_ORIGIN_FORBIDDEN', 403, '该 Origin 未获 CORS 授权'), false)
        },
      })
    }

    app.addHook('onSend', (_request, reply, payload, done) => {
      reply.header('x-content-type-options', 'nosniff')
      reply.header('cache-control', 'no-store')
      done(null, payload)
    })

    app.setNotFoundHandler(request => ({
      error: { code: 'NOT_FOUND', message: '接口不存在', requestId: request.id },
    }))
    app.setErrorHandler((error, request, reply) => {
      const validation = typeof error === 'object' && error !== null &&
        Array.isArray((error as { validation?: unknown }).validation)
      const frameworkStatus = typeof error === 'object' && error !== null &&
        typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 0
      const appError = error instanceof AppError
        ? error
        : validation
          ? new AppError('VALIDATION_ERROR', 400, '请求参数校验失败')
          : frameworkStatus === 413
            ? new AppError('REQUEST_BODY_TOO_LARGE', 413, '请求体超过大小限制')
            : frameworkStatus === 429
              ? new AppError('RATE_LIMITED', 429, '请求过于频繁，请稍后再试')
              : new AppError('INTERNAL_ERROR', 500, '服务内部错误', false, { cause: error })
      if (!(error instanceof AppError) && !validation) request.log.error({ err: error }, '请求处理失败')
      if (appError.statusCode === 401) reply.header('www-authenticate', 'Bearer realm="lxmusic2api"')
      return reply.status(appError.statusCode).send({
        error: {
          code: appError.code,
          message: appError.expose ? appError.message : '服务内部错误',
          requestId: request.id,
        },
      })
    })

    app.get('/healthz', {
      schema: {
        tags: ['system'], summary: '存活检查',
        response: { 200: { type: 'object', properties: { status: { type: 'string' }, version: { type: 'string' } } } },
      },
    }, () => ({ status: 'ok', version: packageInfo.version }))

    app.get('/readyz', {
      schema: {
        tags: ['system'], summary: '就绪与降级状态',
        response: { 200: {
          type: 'object',
          properties: { status: { type: 'string' }, musicUrlResolver: { type: 'string' } },
        } },
      },
    }, () => ({
      status: resolver.available ? 'ready' : 'degraded',
      musicUrlResolver: resolver.available ? 'ready' : 'degraded',
    }))

    await app.register(async api => {
      if (config.rate_limit.enabled) {
        await api.register(rateLimit, {
          global: true,
          max: config.rate_limit.max,
          timeWindow: config.rate_limit.window_ms,
        })
      }
      api.addHook('preHandler', createAuthenticator(config.auth.api_key))
      registerApiRoutes(api, { config, providers, urls, downloads })
    }, { prefix: '/v1' })

    app.addHook('onClose', async () => {
      await downloads.close()
      await resolver.close()
      database.close()
      await closeHttpClient()
    })
    return app
  } catch (error) {
    await downloads.close().catch(() => undefined)
    await resolver.close().catch(() => undefined)
    database.close()
    await closeHttpClient().catch(() => undefined)
    throw error
  }
}

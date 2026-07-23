import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from './errors.js'

interface RequestTimeoutRouteConfig {
  requestTimeoutMs?: unknown
}

const requestSignals = new WeakMap<FastifyRequest, AbortSignal>()

const timeoutForRequest = (request: FastifyRequest, defaultTimeoutMs: number): number => {
  const routeConfig = request.routeOptions.config as RequestTimeoutRouteConfig | undefined
  const routeTimeoutMs = routeConfig?.requestTimeoutMs
  return typeof routeTimeoutMs === 'number' && Number.isFinite(routeTimeoutMs) && routeTimeoutMs > 0
    ? routeTimeoutMs
    : defaultTimeoutMs
}

const clientAbortError = (): Error => {
  const error = new Error('客户端中断了请求')
  error.name = 'AbortError'
  return error
}

export const requestTimeoutRouteConfig = (requestTimeoutMs: number): RequestTimeoutRouteConfig => ({
  requestTimeoutMs,
})

export const initializeRequestSignal = (
  request: FastifyRequest,
  reply: FastifyReply,
  defaultTimeoutMs: number,
): void => {
  const controller = new AbortController()
  requestSignals.set(request, controller.signal)

  const cleanup = (): void => {
    clearTimeout(timeout)
    request.raw.removeListener('close', onRequestClose)
    reply.raw.removeListener('finish', cleanup)
    reply.raw.removeListener('close', onReplyClose)
  }
  const abortForClientDisconnect = (): void => {
    if (!controller.signal.aborted) controller.abort(clientAbortError())
  }
  const onRequestClose = (): void => {
    if (request.raw.aborted) abortForClientDisconnect()
  }
  const onReplyClose = (): void => {
    if (!reply.raw.writableFinished) abortForClientDisconnect()
    cleanup()
  }

  const timeout = setTimeout(() => {
    const error = new AppError('REQUEST_TIMEOUT', 504, '请求处理超时')
    if (!controller.signal.aborted) controller.abort(error)
    if (!reply.sent && !reply.raw.destroyed) reply.send(error)
  }, timeoutForRequest(request, defaultTimeoutMs))
  timeout.unref()

  request.raw.on('close', onRequestClose)
  reply.raw.once('finish', cleanup)
  reply.raw.once('close', onReplyClose)
}

export const getRequestSignal = (request: FastifyRequest): AbortSignal => {
  const signal = requestSignals.get(request)
  if (!signal) throw new Error('请求取消信号尚未初始化')
  return signal
}

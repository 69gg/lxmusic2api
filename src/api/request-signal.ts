import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * 保留旧的内部辅助函数签名；Fastify 5.10 的原生信号同时覆盖客户端断开和 handler 超时。
 */
export const createRequestSignal = (request: FastifyRequest, _reply: FastifyReply): AbortSignal => request.signal

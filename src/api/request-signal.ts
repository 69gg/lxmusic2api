import type { FastifyReply, FastifyRequest } from 'fastify'

export const createRequestSignal = (request: FastifyRequest, reply: FastifyReply): AbortSignal => {
  const controller = new AbortController()
  request.raw.once('aborted', () => controller.abort(new Error('客户端中断了请求')))
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) controller.abort(new Error('客户端关闭了连接'))
  })
  return controller.signal
}

import http, { type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { closeHttpClient, configureHttpClient, openHttpStream } from '@app/network/http-client'
import { createTestConfig } from './helpers'

const servers: Server[] = []

afterEach(async () => {
  await closeHttpClient()
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })))
})

const listen = async (server: Server): Promise<string> => {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  servers.push(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试服务器未监听 TCP 端口')
  return `http://127.0.0.1:${address.port}`
}

describe('音频上游请求', () => {
  it('使用配置的默认 User-Agent，并允许内部调用显式覆盖', async () => {
    const userAgents: Array<string | undefined> = []
    const server = http.createServer((request, response) => {
      userAgents.push(request.headers['user-agent'])
      response.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-length': '5',
      })
      response.end('audio')
    })
    const baseUrl = await listen(server)
    const config = createTestConfig(process.cwd())
    config.network.audio_user_agent = 'configured-audio-agent'
    configureHttpClient(config)

    const defaultResponse = await openHttpStream(`${baseUrl}/default`)
    await defaultResponse.body.dump()
    const overriddenResponse = await openHttpStream(`${baseUrl}/override`, {
      headers: { 'User-Agent': 'explicit-audio-agent' },
    })
    await overriddenResponse.body.dump()

    expect(userAgents).toEqual(['configured-audio-agent', 'explicit-audio-agent'])
  })
})

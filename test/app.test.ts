import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '@app/app'
import { createTestConfig, TEST_TRACK } from './helpers'

const applications: FastifyInstance[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(applications.splice(0).map(application => application.close()))
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

const createDirectory = async (): Promise<string> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lxmusic2api-app-'))
  directories.push(directory)
  return directory
}

describe('HTTP API', () => {
  it('自定义源缺失时降级启动，并保护所有 v1 接口', async () => {
    const directory = await createDirectory()
    const config = createTestConfig(directory)
    const app = await buildApp(config)
    applications.push(app)

    const health = await app.inject({ method: 'GET', url: '/healthz' })
    expect(health.statusCode).toBe(200)
    const ready = await app.inject({ method: 'GET', url: '/readyz' })
    expect(ready.statusCode).toBe(200)
    expect(ready.json()).toMatchObject({ status: 'degraded', musicUrlResolver: 'degraded' })

    const unauthenticated = await app.inject({ method: 'GET', url: '/v1/providers' })
    expect(unauthenticated.statusCode).toBe(401)
    const authenticated = await app.inject({
      method: 'GET',
      url: '/v1/providers',
      headers: { authorization: `Bearer ${config.auth.api_key}` },
    })
    expect(authenticated.statusCode).toBe(200)
    expect(authenticated.body).not.toContain('customSource')

    const created = await app.inject({
      method: 'POST',
      url: '/v1/downloads',
      headers: { authorization: `Bearer ${config.auth.api_key}` },
      payload: { track: TEST_TRACK, quality: '128k' },
    })
    expect(created.statusCode, created.body).toBe(202)
    const downloadId = created.json<{ data: { id: string } }>().data.id
    await expect.poll(async () => {
      const status = await app.inject({
        method: 'GET',
        url: `/v1/downloads/${downloadId}`,
        headers: { authorization: `Bearer ${config.auth.api_key}` },
      })
      return status.json<{ data: { state: string } }>().data.state
    }).toBe('failed')
  })

  it('只从配置脚本加载唯一自定义源，API 不返回其元数据', async () => {
    const directory = await createDirectory()
    const config = createTestConfig(directory)
    await fs.writeFile(config.custom_source.script_path, `/**
 * @name 仅用于自动化测试的源
 * @description synthetic
 * @version 1.0.0
 * @author test
 * @homepage https://invalid.example
 */
lx.on(lx.EVENT_NAMES.request, async request => {
  if (request.action !== 'musicUrl') throw new Error('unsupported')
  if (lx.utils.crypto.md5('hello') !== '5d41402abc4b2a76b9719d911017c592') throw new Error('md5 failed')
  const compressed = await lx.utils.zlib.deflate(lx.utils.buffer.from('bridge-ok'))
  const inflated = await lx.utils.zlib.inflate(compressed)
  if (lx.utils.buffer.bufToString(inflated, 'utf8') !== 'bridge-ok') throw new Error('zlib failed')
  await new Promise(resolve => setTimeout(resolve, 1))
  return 'https://audio.invalid.example/test.mp3'
})
lx.send(lx.EVENT_NAMES.inited, {
  sources: {
    kw: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] },
  },
})
`, 'utf8')
    const app = await buildApp(config)
    applications.push(app)

    const ready = await app.inject({ method: 'GET', url: '/readyz' })
    expect(ready.json()).toMatchObject({ status: 'ready' })
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tracks/resolve',
      headers: { authorization: `Bearer ${config.auth.api_key}` },
      payload: { track: TEST_TRACK, quality: '128k' },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ data: { url: 'https://audio.invalid.example/test.mp3' } })
    expect(response.json()).toMatchObject({
      data: { track: { picUrl: null, qualities: [{ type: '128k', size: null }] } },
    })
    expect(response.body).not.toContain('仅用于自动化测试的源')
    expect(response.body).not.toContain('synthetic')
  })
})

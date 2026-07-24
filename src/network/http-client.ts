import http from 'node:http'
import dns from 'node:dns'
import { Agent, FormData, ProxyAgent, interceptors, request as undiciRequest, type Dispatcher } from 'undici'
import type { AppConfig } from '@app/config/schema'
import { getRequestSignal } from './request-context.js'
import { assertSafeHttpUrl, isPrivateAddress, normalizeHostname, type UrlSecurityOptions } from './security.js'

export interface CompatibleRequestOptions {
  method?: string
  headers?: Record<string, string | number | string[] | undefined>
  body?: unknown
  form?: Record<string, unknown>
  formData?: Record<string, unknown>
  timeout?: number
  follow_max?: number
  [key: string]: unknown
}

export interface CompatibleResponse {
  statusCode: number
  statusMessage: string
  headers: Record<string, string | string[] | undefined>
  bytes: number
  raw: Buffer
  body: unknown
}

interface HttpClientState {
  dispatcher: Dispatcher
  requestTimeoutMs: number
  audioTimeoutMs: number
  audioUserAgent: string
  maxRedirects: number
  maxResponseBytes: number
  security: UrlSecurityOptions
}

let state: HttpClientState | undefined

export const configureHttpClient = (config: AppConfig): void => {
  const security: UrlSecurityOptions = {
    blockPrivateNetworks: config.network.block_private_networks,
    allowedPrivateHosts: new Set(config.network.allow_private_hosts.map(host => normalizeHostname(host))),
  }
  const dispatcher = config.network.proxy_url
    ? new ProxyAgent(config.network.proxy_url)
    : new Agent({ connect: { timeout: config.network.connect_timeout_ms } }).compose([interceptors.dns({
        maxTTL: config.network.dns_cache_ttl_ms,
        lookup: (origin, options, callback) => {
          dns.lookup(origin.hostname, {
            all: true,
            verbatim: true,
            ...(options.family ? { family: options.family } : {}),
            ...(options.hints ? { hints: options.hints } : {}),
          }, (error, addresses) => {
            if (error) {
              callback(error, [])
              return
            }
            const hostname = normalizeHostname(origin.hostname)
            if (security.blockPrivateNetworks && !security.allowedPrivateHosts.has(hostname) &&
              addresses.some(address => isPrivateAddress(address.address))) {
              const denied = new Error('实际连接地址属于内网、环回或保留网段') as NodeJS.ErrnoException
              denied.code = 'EACCES'
              callback(denied, [])
              return
            }
            const records: Array<{ address: string, family: 4 | 6, ttl: number }> = []
            for (const address of addresses) {
              if (address.family !== 4 && address.family !== 6) {
                const unsupported = new Error(`DNS 返回了不支持的地址族：${address.family}`) as NodeJS.ErrnoException
                unsupported.code = 'EAFNOSUPPORT'
                callback(unsupported, [])
                return
              }
              records.push({
                address: address.address,
                family: address.family,
                ttl: config.network.dns_cache_ttl_ms,
              })
            }
            callback(null, records)
          })
        },
      })])
  state = {
    dispatcher,
    requestTimeoutMs: config.network.request_timeout_ms,
    audioTimeoutMs: config.network.audio_timeout_ms,
    audioUserAgent: config.network.audio_user_agent,
    maxRedirects: config.network.max_redirects,
    maxResponseBytes: config.network.max_response_bytes,
    security,
  }
}

const getState = (): HttpClientState => {
  if (!state) throw new Error('HTTP 客户端尚未初始化')
  return state
}

const normalizeHeaders = (headers: CompatibleRequestOptions['headers']): Record<string, string | string[]> => {
  const result: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value == null) continue
    result[key] = Array.isArray(value) ? value : String(value)
  }
  return result
}

const formValueToString = (value: unknown): string => {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value)
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return JSON.stringify(value)
}

const buildBody = (options: CompatibleRequestOptions, headers: Record<string, string | string[]>): Dispatcher.DispatchOptions['body'] => {
  if (options.body != null) {
    if (typeof options.body === 'string' || Buffer.isBuffer(options.body) || options.body instanceof Uint8Array) return options.body
    if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json; charset=utf-8'
    return JSON.stringify(options.body)
  }
  if (options.form) {
    if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/x-www-form-urlencoded; charset=utf-8'
    }
    const form = new URLSearchParams()
    for (const [key, value] of Object.entries(options.form)) form.set(key, formValueToString(value))
    return form.toString()
  }
  if (options.formData) {
    const form = new FormData()
    for (const [key, value] of Object.entries(options.formData)) form.set(key, formValueToString(value))
    return form
  }
  return null
}

const readLimitedBody = async (body: Dispatcher.ResponseData['body'], maxBytes: number): Promise<Buffer> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) {
      body.destroy(new Error('上游响应体超过限制'))
      throw new Error('上游响应体超过限制')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, size)
}

export const requestBuffer = async (
  rawUrl: string,
  options: CompatibleRequestOptions = {},
  maxResponseBytes?: number,
): Promise<CompatibleResponse> => {
  const client = getState()
  const timeoutSignal = AbortSignal.timeout(options.timeout ?? client.requestTimeoutMs)
  const contextSignal = getRequestSignal()
  const signal = contextSignal
    ? AbortSignal.any([timeoutSignal, contextSignal])
    : timeoutSignal
  const url = await assertSafeHttpUrl(rawUrl, client.security, signal)
  let headers = normalizeHeaders(options.headers)
  let method = String(options.method ?? 'GET').toUpperCase()
  const maxRedirections = Math.max(0, Math.min(Number(options.follow_max ?? client.maxRedirects), 10))
  let currentUrl = url
  let response: Awaited<ReturnType<typeof undiciRequest>>
  for (let redirectCount = 0; ; redirectCount += 1) {
    const body = method === 'GET' || method === 'HEAD' ? null : buildBody(options, headers) ?? null
    response = await undiciRequest(currentUrl, {
      method,
      headers,
      body,
      dispatcher: client.dispatcher,
      signal,
    })
    const location = response.headers.location
    if (response.statusCode < 300 || response.statusCode >= 400 || !location || redirectCount >= maxRedirections) break
    const nextLocation = Array.isArray(location) ? location[0] : location
    if (!nextLocation) break
    await response.body.dump()
    const nextUrl = await assertSafeHttpUrl(new URL(nextLocation, currentUrl).href, client.security, signal)
    if (nextUrl.origin !== currentUrl.origin) {
      headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !['authorization', 'cookie'].includes(key.toLowerCase())))
    }
    if (response.statusCode === 303 || ((response.statusCode === 301 || response.statusCode === 302) && method === 'POST')) {
      method = 'GET'
      headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !['content-type', 'content-length'].includes(key.toLowerCase())))
    }
    currentUrl = nextUrl
  }
  const raw = await readLimitedBody(response.body, maxResponseBytes ?? client.maxResponseBytes)
  const text = raw.toString('utf8')
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    // 非 JSON 响应按字符串返回，同时保留 raw Buffer。
  }
  return {
    statusCode: response.statusCode,
    statusMessage: http.STATUS_CODES[response.statusCode] ?? '',
    headers: response.headers,
    bytes: raw.length,
    raw,
    body: parsed,
  }
}

export interface HttpStreamOptions {
  headers?: Record<string, string | undefined>
  signal?: AbortSignal
  timeoutMs?: number
  maxRedirections?: number
}

export interface HttpStreamResponse {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: Dispatcher.ResponseData['body']
  finalUrl: URL
}

export const openHttpStream = async (rawUrl: string, options: HttpStreamOptions = {}): Promise<HttpStreamResponse> => {
  const client = getState()
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? client.audioTimeoutMs)
  const contextSignal = getRequestSignal()
  const signals = [timeoutSignal, options.signal, contextSignal].filter((signal): signal is AbortSignal => signal != null)
  const signal = AbortSignal.any(signals)
  let currentUrl = await assertSafeHttpUrl(rawUrl, client.security, signal)
  const headers = Object.fromEntries(Object.entries(options.headers ?? {}).filter((entry): entry is [string, string] => entry[1] != null))
  if (!Object.keys(headers).some(header => header.toLowerCase() === 'user-agent')) {
    headers['user-agent'] = client.audioUserAgent
  }
  const maxRedirections = Math.max(0, Math.min(options.maxRedirections ?? client.maxRedirects, 10))

  for (let redirectCount = 0; ; redirectCount += 1) {
    const response = await undiciRequest(currentUrl, {
      method: 'GET',
      headers,
      dispatcher: client.dispatcher,
      signal,
    })
    const location = response.headers.location
    if (response.statusCode < 300 || response.statusCode >= 400 || !location) {
      return { statusCode: response.statusCode, headers: response.headers, body: response.body, finalUrl: currentUrl }
    }
    if (redirectCount >= maxRedirections) {
      await response.body.dump()
      throw new Error('上游重定向次数超过限制')
    }
    const nextLocation = Array.isArray(location) ? location[0] : location
    if (!nextLocation) {
      return { statusCode: response.statusCode, headers: response.headers, body: response.body, finalUrl: currentUrl }
    }
    await response.body.dump()
    currentUrl = await assertSafeHttpUrl(new URL(nextLocation, currentUrl).href, client.security, signal)
  }
}

export const assertConfiguredSafeUrl = async (rawUrl: string, signal?: AbortSignal): Promise<URL> => {
  const client = getState()
  return assertSafeHttpUrl(rawUrl, client.security, signal)
}

export interface CancellableRequest<T> {
  promise: Promise<T>
  cancelHttp: () => void
}

export const createCancellableRequest = <T>(factory: (signal: AbortSignal) => Promise<T>): CancellableRequest<T> => {
  const controller = new AbortController()
  return {
    promise: factory(controller.signal),
    cancelHttp: () => controller.abort(new Error('请求已取消')),
  }
}

export const closeHttpClient = async (): Promise<void> => {
  if (!state) return
  await state.dispatcher.close()
  state = undefined
}

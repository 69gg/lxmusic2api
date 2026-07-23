import dns from 'node:dns/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertSafeHttpUrl, isPrivateAddress, normalizeHostname } from '@app/network/security'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('上游 URL 安全检查', () => {
  it('识别常见私网和环回地址', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true)
    expect(isPrivateAddress('10.0.0.1')).toBe(true)
    expect(isPrivateAddress('169.254.169.254')).toBe(true)
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    expect(isPrivateAddress('::1')).toBe(true)
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true)
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false)
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false)
  })

  it('规范化配置和 URL 中的主机名', () => {
    expect(normalizeHostname('Example.COM.')).toBe('example.com')
    expect(normalizeHostname('[::1]')).toBe('::1')
  })

  it('拒绝凭据 URL 与本机地址', async () => {
    const options = { blockPrivateNetworks: true, allowedPrivateHosts: new Set<string>() }
    await expect(assertSafeHttpUrl('http://user:pass@example.com', options)).rejects.toThrow(/用户名/)
    await expect(assertSafeHttpUrl('http://localhost/test', options)).rejects.toThrow(/本机/)
  })

  it('URL 安全检查尊重上游取消信号', async () => {
    const options = { blockPrivateNetworks: true, allowedPrivateHosts: new Set<string>() }
    const controller = new AbortController()
    controller.abort(new Error('请求处理超时'))
    await expect(assertSafeHttpUrl('https://example.com/test', options, controller.signal)).rejects.toThrow(/请求处理超时/)
  })

  it('DNS 解析挂起时也能由取消信号立即结束', async () => {
    const options = { blockPrivateNetworks: true, allowedPrivateHosts: new Set<string>() }
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(async (): Promise<never> => (
      new Promise<never>(() => undefined)
    ))
    const controller = new AbortController()
    const pending = assertSafeHttpUrl('https://example.com/test', options, controller.signal)
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce())

    controller.abort(new Error('DNS 检查超时'))

    await expect(pending).rejects.toThrow(/DNS 检查超时/)
  })
})

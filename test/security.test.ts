import { describe, expect, it } from 'vitest'
import { assertSafeHttpUrl, isPrivateAddress, normalizeHostname } from '@app/network/security'

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
})

import dns from 'node:dns/promises'
import net from 'node:net'

export const normalizeHostname = (host: string): string => host
  .toLowerCase()
  .replace(/\.$/, '')
  .replace(/^\[(.*)]$/, '$1')

const blockedIpv4Addresses = new net.BlockList()
const blockedIpv6Addresses = new net.BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) {
  blockedIpv4Addresses.addSubnet(network, prefix, 'ipv4')
  // Node 会把 IPv4 映射地址（::ffff:x.x.x.x）与 IPv4 规则匹配。
  blockedIpv6Addresses.addSubnet(network, prefix, 'ipv4')
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) blockedIpv6Addresses.addSubnet(network, prefix, 'ipv6')

export const isPrivateAddress = (address: string): boolean => {
  const normalized = address.toLowerCase().split('%')[0] ?? ''
  const family = net.isIP(normalized)
  if (family === 4) return blockedIpv4Addresses.check(normalized, 'ipv4')
  if (family === 6) return blockedIpv6Addresses.check(normalized, 'ipv6')
  return true
}

export interface UrlSecurityOptions {
  blockPrivateNetworks: boolean
  allowedPrivateHosts: ReadonlySet<string>
}

export const assertSafeHttpUrl = async (rawUrl: string, options: UrlSecurityOptions): Promise<URL> => {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch (error) {
    throw new Error('无效的上游 URL', { cause: error })
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('上游 URL 只允许 HTTP(S)')
  if (url.username || url.password) throw new Error('上游 URL 不允许内嵌用户名或密码')
  if (!options.blockPrivateNetworks) return url

  const hostname = normalizeHostname(url.hostname)
  if (options.allowedPrivateHosts.has(hostname)) return url
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) throw new Error('禁止访问本机地址')

  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some(item => isPrivateAddress(item.address))) {
    throw new Error('禁止访问内网、环回或链路本地地址')
  }
  return url
}

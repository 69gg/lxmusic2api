import type { CustomSourceMetadata } from './protocol.js'

const FIELD_LIMITS = {
  name: 24,
  description: 36,
  version: 36,
  author: 56,
  homepage: 1024,
} as const

export const parseCustomSourceMetadata = (script: string): CustomSourceMetadata => {
  const comment = /^\/\*[\s\S]+?\*\//.exec(script)?.[0]
  if (!comment) throw new Error('自定义源缺少文件头注释')
  const values: Record<string, string> = {}
  for (const line of comment.split(/\r?\n/)) {
    const match = /^\s?\*\s?@(\w+)\s(.*)$/.exec(line)
    if (match?.[1]) values[match[1]] = (match[2] ?? '').trim()
  }
  const metadata = Object.fromEntries(Object.entries(FIELD_LIMITS).map(([key, limit]) => [
    key,
    String(values[key] ?? '').slice(0, limit),
  ])) as unknown as CustomSourceMetadata
  if (!metadata.name) metadata.name = '未命名自定义源'
  return metadata
}

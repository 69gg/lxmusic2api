const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
}

export const decodeName = (value: string | null = ''): string => {
  if (!value) return ''
  return value.replace(/&(#x?[\da-f]+|[a-z]+);/gi, (_match, entity: string) => {
    const normalized = entity.toLowerCase()
    if (normalized.startsWith('#x')) return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16))
    if (normalized.startsWith('#')) return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10))
    return HTML_ENTITIES[normalized] ?? `&${entity};`
  })
}

const padNumber = (value: number): string => value.toString().padStart(2, '0')

export const formatPlayTime = (seconds: number): string => {
  const minutes = Math.trunc(seconds / 60)
  const remainingSeconds = Math.trunc(seconds % 60)
  return minutes === 0 && remainingSeconds === 0 ? '--/--' : `${padNumber(minutes)}:${padNumber(remainingSeconds)}`
}

export const sizeFormate = (size: number): string => {
  if (!size) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  const unitIndex = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1)
  return `${(size / (1024 ** unitIndex)).toFixed(2)} ${units[unitIndex]}`
}

export const dateFormat = (input: string | number | Date, format = 'Y-M-D h:m:s'): string => {
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) return ''
  return format
    .replace('Y', String(date.getFullYear()))
    .replace('M', padNumber(date.getMonth() + 1))
    .replace('D', padNumber(date.getDate()))
    .replace('h', padNumber(date.getHours()))
    .replace('m', padNumber(date.getMinutes()))
    .replace('s', padNumber(date.getSeconds()))
}

export const dateFormat2 = (time: number): string => {
  const seconds = Math.max(0, Math.trunc((Date.now() - time) / 1000))
  if (seconds < 60) return `${seconds}秒前`
  if (seconds < 3600) return `${Math.trunc(seconds / 60)}分钟前`
  if (seconds < 86400) return `${Math.trunc(seconds / 3600)}小时前`
  return dateFormat(time)
}

export const formatPlayCount = (value: number): string => {
  if (value > 100000000) return `${Math.trunc(value / 10000000) / 10}亿`
  if (value > 10000) return `${Math.trunc(value / 1000) / 10}万`
  return String(value)
}

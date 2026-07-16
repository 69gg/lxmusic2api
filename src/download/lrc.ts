/*
 * Adapted from LX Music Desktop renderer/worker/download/lrcTool.ts.
 * Reworked with standalone types for lxmusic2api. Copyright 2026 Null.
 */
export interface LyricData {
  lyric: string
  tlyric: string | null
  rlyric: string | null
  lxlyric: string | null
}

const TIME_FIELD_PATTERN = /^(?:\[[\d:.]+\])+/g
const TIME_PATTERN = /\d{1,3}(:\d{1,3}){0,2}(?:\.\d{1,3})/g

const formatTimeLabel = (label: string): string => label
  .replace(/^0+(\d+)/, '$1')
  .replace(/:0+(\d+)/g, ':$1')
  .replace(/\.0+(\d+)/, '.$1')

const parseLrcTimeLabels = (lyric: string): Set<string> => {
  const labels = new Set<string>()
  for (const line of lyric.split(/\r\n|\n|\r/)) {
    const timeField = line.trim().match(TIME_FIELD_PATTERN)?.[0]
    if (!timeField || !line.replace(TIME_FIELD_PATTERN, '').trim()) continue
    for (const time of timeField.match(TIME_PATTERN) ?? []) labels.add(formatTimeLabel(time))
  }
  return labels
}

const filterExtendedLyricLabels = (allowedLabels: Set<string>, extendedLyric: string): string => {
  const lines: string[] = []
  for (const rawLine of extendedLyric.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim()
    const timeField = line.match(TIME_FIELD_PATTERN)?.[0]
    if (!timeField) continue
    const text = line.replace(TIME_FIELD_PATTERN, '').trim()
    if (!text) continue
    const times = (timeField.match(TIME_PATTERN) ?? []).filter(time => allowedLabels.has(formatTimeLabel(time)))
    if (times.length > 0) lines.push(`[${times.join('][')}]${text}`)
  }
  return lines.join('\n')
}

const buildWordByWordPayload = (data: LyricData): string => {
  const entries: string[] = []
  if (data.lyric) entries.push(`lrc:${Buffer.from(data.lyric.trim(), 'utf8').toString('base64')}`)
  if (data.tlyric) entries.push(`tlrc:${Buffer.from(data.tlyric.trim(), 'utf8').toString('base64')}`)
  if (data.rlyric) entries.push(`rlrc:${Buffer.from(data.rlyric.trim(), 'utf8').toString('base64')}`)
  if (data.lxlyric) entries.push(`awlrc:${Buffer.from(data.lxlyric.trim(), 'utf8').toString('base64')}`)
  return entries.length > 0 ? `[awlrc:${entries.join(',')}]` : ''
}

// 逻辑移植自 LX Music 的 renderer/worker/download/lrcTool.ts，并改为独立类型。
export const buildLyrics = (
  data: LyricData,
  includeWordByWord: boolean,
  includeTranslation: boolean,
  includeRomanization: boolean,
): string => {
  if (!data.tlyric && !data.rlyric && !data.lxlyric) return data.lyric
  const labels = parseLrcTimeLabels(data.lyric)
  const sections = [data.lyric.trim()]
  if (includeTranslation && data.tlyric) sections.push(filterExtendedLyricLabels(labels, data.tlyric))
  if (includeRomanization && data.rlyric) sections.push(filterExtendedLyricLabels(labels, data.rlyric))
  if (includeWordByWord) sections.push(buildWordByWordPayload(data))
  return `${sections.filter(Boolean).join('\n\n')}\n`
}

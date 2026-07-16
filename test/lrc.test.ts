import { describe, expect, it } from 'vitest'
import { buildLyrics } from '@app/download/lrc'

describe('歌词合并', () => {
  it('只合并与原歌词时间轴匹配的翻译和罗马音', () => {
    const result = buildLyrics({
      lyric: '[00:01.00]原文一\n[00:02.00]原文二',
      tlyric: '[00:01.00]翻译一\n[00:09.00]无匹配',
      rlyric: '[00:02.00]romanized',
      lxlyric: null,
    }, false, true, true)
    expect(result).toContain('[00:01.00]翻译一')
    expect(result).toContain('[00:02.00]romanized')
    expect(result).not.toContain('无匹配')
  })
})

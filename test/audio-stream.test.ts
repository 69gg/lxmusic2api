import { describe, expect, it } from 'vitest'
import type { AppError } from '@app/api/errors'
import { parseTrackDurationSeconds } from '@app/domain/track'
import {
  minimumExpectedAudioBytes,
  validateAudioStreamResponse,
} from '@app/music/audio-stream'

const response = (contentLength: string, statusCode = 200) => ({
  statusCode,
  headers: { 'content-type': 'audio/mpeg', 'content-length': contentLength },
})

describe('音频响应鉴伪', () => {
  it('按歌曲时长和最低合理码率拒绝防盗链短音频', () => {
    expect(parseTrackDurationSeconds('03:33')).toBe(213)
    expect(parseTrackDurationSeconds('1:02:03')).toBe(3723)
    expect(parseTrackDurationSeconds('unknown')).toBeNull()
    expect(minimumExpectedAudioBytes(213, 16)).toBe(426_000)

    expect(() => validateAudioStreamResponse(response('185336'), {
      expectedInterval: '03:33',
      minimumBitrateKbps: 16,
      rangeRequested: false,
    })).toThrowError(expect.objectContaining<Partial<AppError>>({
      code: 'AUDIO_RESPONSE_SUSPICIOUS',
      statusCode: 502,
    }))
  })

  it('接受体积合理的完整响应，并跳过分段响应的整文件体积检查', () => {
    expect(() => validateAudioStreamResponse(response('800000'), {
      expectedInterval: '03:33',
      minimumBitrateKbps: 16,
      rangeRequested: false,
    })).not.toThrow()
    expect(() => validateAudioStreamResponse(response('1024', 206), {
      expectedInterval: '03:33',
      minimumBitrateKbps: 16,
      rangeRequested: true,
    })).not.toThrow()
  })

  it('时长或响应体积未知时不误判，同时继续拒绝非音频正文', () => {
    expect(() => validateAudioStreamResponse(response('185336'), {
      expectedInterval: null,
      minimumBitrateKbps: 16,
      rangeRequested: false,
    })).not.toThrow()
    expect(() => validateAudioStreamResponse({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
    }, {
      expectedInterval: '03:33',
      minimumBitrateKbps: 16,
      rangeRequested: false,
    })).toThrowError(expect.objectContaining<Partial<AppError>>({ code: 'AUDIO_RESPONSE_INVALID' }))
  })
})

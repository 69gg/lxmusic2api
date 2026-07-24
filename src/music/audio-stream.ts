import { AppError } from '@app/api/errors'
import { parseTrackDurationSeconds } from '@app/domain/track'
import { openHttpStream, type HttpStreamOptions, type HttpStreamResponse } from '@app/network/http-client'

export interface ValidatedAudioStreamOptions extends HttpStreamOptions {
  expectedInterval: string | null
  minimumBitrateKbps: number
}

export interface AudioStreamValidationOptions {
  expectedInterval: string | null
  minimumBitrateKbps: number
  rangeRequested: boolean
}

const firstHeader = (value: string | string[] | undefined): string | undefined => (
  Array.isArray(value) ? value[0] : value
)

export const minimumExpectedAudioBytes = (durationSeconds: number, minimumBitrateKbps: number): number => (
  Math.ceil(durationSeconds * minimumBitrateKbps * 1000 / 8)
)

export const validateFullAudioByteLength = (
  byteLength: number,
  expectedInterval: string | null,
  minimumBitrateKbps: number,
): void => {
  if (minimumBitrateKbps === 0) return
  const durationSeconds = parseTrackDurationSeconds(expectedInterval)
  if (durationSeconds == null) return
  const minimumBytes = minimumExpectedAudioBytes(durationSeconds, minimumBitrateKbps)
  if (byteLength >= minimumBytes) return
  throw new AppError(
    'AUDIO_RESPONSE_SUSPICIOUS',
    502,
    `音频上游仅返回 ${byteLength} 字节，低于 ${durationSeconds} 秒歌曲的完整音频合理下限 ${minimumBytes} 字节，疑似试听片段或防盗链占位音频`,
  )
}

const hasRangeHeader = (headers: HttpStreamOptions['headers']): boolean => Object.entries(headers ?? {})
  .some(([name, value]) => name.toLowerCase() === 'range' && value != null && value.length > 0)

export const validateAudioStreamResponse = (
  response: Pick<HttpStreamResponse, 'statusCode' | 'headers'>,
  options: AudioStreamValidationOptions,
): void => {
  if (response.statusCode !== 200 && response.statusCode !== 206) {
    if (response.statusCode === 416) throw new AppError('INVALID_RANGE', 416, '上游音频不接受该 Range')
    throw new AppError('AUDIO_UPSTREAM_ERROR', 502, `音频上游返回 HTTP ${response.statusCode}`)
  }

  const contentType = firstHeader(response.headers['content-type'])?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType?.startsWith('text/') || [
    'application/json',
    'application/xml',
    'application/xhtml+xml',
  ].includes(contentType ?? '')) {
    throw new AppError('AUDIO_RESPONSE_INVALID', 502, `音频上游返回了非音频内容：${contentType}`)
  }

  if (options.rangeRequested || response.statusCode === 206 || response.headers['content-range'] != null) return
  const contentLength = Number.parseInt(firstHeader(response.headers['content-length']) ?? '', 10)
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) return
  validateFullAudioByteLength(contentLength, options.expectedInterval, options.minimumBitrateKbps)
}

export const openValidatedAudioStream = async (
  rawUrl: string,
  options: ValidatedAudioStreamOptions,
): Promise<HttpStreamResponse> => {
  const { expectedInterval, minimumBitrateKbps, ...requestOptions } = options
  const response = await openHttpStream(rawUrl, requestOptions)
  try {
    validateAudioStreamResponse(response, {
      expectedInterval,
      minimumBitrateKbps,
      rangeRequested: hasRangeHeader(requestOptions.headers),
    })
    return response
  } catch (error) {
    try {
      await response.body.dump()
    } catch {
      response.body.destroy()
    }
    throw error
  }
}

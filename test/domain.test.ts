import { describe, expect, it } from 'vitest'
import { fromUpstreamTrack, toUpstreamTrack } from '@app/domain/track'

describe('Track DTO', () => {
  it('保留解析 URL 所需的平台字段并可往返', () => {
    const track = fromUpstreamTrack({
      source: 'kg',
      songmid: '123',
      hash: 'ABCDEF',
      name: 'Song',
      singer: 'Singer',
      albumName: 'Album',
      interval: '03:12',
      albumId: 'album-1',
      types: [{ type: '320k', size: '8 MB', hash: 'HQHASH' }],
    })
    expect(track.id).toBe('123_ABCDEF')
    expect(track.sourceData.hash).toBe('ABCDEF')
    const upstream = toUpstreamTrack(track)
    expect(upstream.songmid).toBe('123')
    expect(upstream.hash).toBe('ABCDEF')
    expect(upstream.albumId).toBe('album-1')
  })
})

import kwMusicSearch from '@renderer/utils/musicSdk/kw/musicSearch'
import kwLeaderboard from '@renderer/utils/musicSdk/kw/leaderboard'
import kwSongList from '@renderer/utils/musicSdk/kw/songList'
import kwHotSearch from '@renderer/utils/musicSdk/kw/hotSearch'
import kwComment from '@renderer/utils/musicSdk/kw/comment'
import kwLyric from '@renderer/utils/musicSdk/kw/lyric'
import kwPic from '@renderer/utils/musicSdk/kw/pic'

import kgMusicSearch from '@renderer/utils/musicSdk/kg/musicSearch'
import kgLeaderboard from '@renderer/utils/musicSdk/kg/leaderboard'
import kgSongList from '@renderer/utils/musicSdk/kg/songList'
import kgHotSearch from '@renderer/utils/musicSdk/kg/hotSearch'
import kgComment from '@renderer/utils/musicSdk/kg/comment'
import kgLyric from '@renderer/utils/musicSdk/kg/lyric'
import kgPic from '@renderer/utils/musicSdk/kg/pic'

import txMusicSearch from '@renderer/utils/musicSdk/tx/musicSearch'
import txLeaderboard from '@renderer/utils/musicSdk/tx/leaderboard'
import txSongList from '@renderer/utils/musicSdk/tx/songList'
import txHotSearch from '@renderer/utils/musicSdk/tx/hotSearch'
import txComment from '@renderer/utils/musicSdk/tx/comment'
import txLyric from '@renderer/utils/musicSdk/tx/lyric'

import wyMusicSearch from '@renderer/utils/musicSdk/wy/musicSearch'
import wyLeaderboard from '@renderer/utils/musicSdk/wy/leaderboard'
import wySongList from '@renderer/utils/musicSdk/wy/songList'
import wyHotSearch from '@renderer/utils/musicSdk/wy/hotSearch'
import wyComment from '@renderer/utils/musicSdk/wy/comment'
import wyLyric from '@renderer/utils/musicSdk/wy/lyric'
import wyMusicInfo from '@renderer/utils/musicSdk/wy/musicInfo'

import mgMusicSearch from '@renderer/utils/musicSdk/mg/musicSearch'
import mgLeaderboard from '@renderer/utils/musicSdk/mg/leaderboard'
import mgSongList from '@renderer/utils/musicSdk/mg/songList'
import mgHotSearch from '@renderer/utils/musicSdk/mg/hotSearch'
import mgComment from '@renderer/utils/musicSdk/mg/comment'
import mgLyric from '@renderer/utils/musicSdk/mg/lyric'
import mgPic from '@renderer/utils/musicSdk/mg/pic'

import { AppError, upstreamError } from '@app/api/errors'
import { fromUpstreamTrack, toUpstreamTrack, type Provider, type Track } from '@app/domain/track'
import { runWithRequestSignal } from '@app/network/request-context'
import { SerialExecutor } from '@app/utils/serial-executor'

type LegacyObject = Record<string, any>

interface ProviderAdapter {
  name: string
  musicSearch: LegacyObject
  leaderboard: LegacyObject
  songList: LegacyObject
  hotSearch: LegacyObject
  comment: LegacyObject
  getLyric: (track: LegacyObject) => unknown
  getPic: (track: LegacyObject) => unknown
}

const awaitLegacy = async <T>(value: unknown): Promise<T> => {
  const candidate = await value as any
  return candidate && typeof candidate === 'object' && 'promise' in candidate
    ? await candidate.promise as T
    : candidate as T
}

const adapters: Record<Provider, ProviderAdapter> = {
  kw: {
    name: '酷我音乐',
    musicSearch: kwMusicSearch,
    leaderboard: kwLeaderboard,
    songList: kwSongList,
    hotSearch: kwHotSearch,
    comment: kwComment,
    getLyric: track => kwLyric.getLyric(track, true),
    getPic: track => kwPic.getPic({ songmid: track.songmid }),
  },
  kg: {
    name: '酷狗音乐',
    musicSearch: kgMusicSearch,
    leaderboard: kgLeaderboard,
    songList: kgSongList,
    hotSearch: kgHotSearch,
    comment: kgComment,
    getLyric: track => kgLyric.getLyric(track),
    getPic: track => kgPic.getPic(track),
  },
  tx: {
    name: 'QQ音乐',
    musicSearch: txMusicSearch,
    leaderboard: txLeaderboard,
    songList: txSongList,
    hotSearch: txHotSearch,
    comment: txComment,
    getLyric: track => txLyric.getLyric(track),
    getPic: async track => `https://y.gtimg.cn/music/photo_new/T002R500x500M000${String(track.albumId ?? '')}.jpg`,
  },
  wy: {
    name: '网易云音乐',
    musicSearch: wyMusicSearch,
    leaderboard: wyLeaderboard,
    songList: wySongList,
    hotSearch: wyHotSearch,
    comment: wyComment,
    getLyric: track => wyLyric({ songmid: track.songmid }),
    getPic: async track => {
      const info = await awaitLegacy<LegacyObject>(wyMusicInfo(track.songmid))
      return info.al?.picUrl
    },
  },
  mg: {
    name: '咪咕音乐',
    musicSearch: mgMusicSearch,
    leaderboard: mgLeaderboard,
    songList: mgSongList,
    hotSearch: mgHotSearch,
    comment: mgComment,
    getLyric: track => mgLyric.getLyric(track),
    getPic: track => mgPic.getPic(track),
  },
}

export interface PartialFailure {
  source: Provider
  code: string
  message: string
}

export interface PageResult<T> {
  items: T[]
  page: number
  limit: number
  total: number
  totalPages: number
  upstreamErrors: PartialFailure[]
}

const toFailure = (source: Provider, error: unknown): PartialFailure => ({
  source,
  code: 'UPSTREAM_ERROR',
  message: error instanceof Error ? error.message : String(error),
})

const normalizePlaylist = (item: LegacyObject): LegacyObject => ({
  id: String(item.id ?? ''),
  source: item.source,
  name: String(item.name ?? ''),
  author: String(item.author ?? ''),
  description: item.desc == null ? null : String(item.desc),
  coverUrl: String(item.img ?? ''),
  playCount: String(item.play_count ?? item.playCount ?? ''),
  time: item.time == null ? null : String(item.time),
})

const normalizeTracks = (items: unknown): Track[] => {
  if (!Array.isArray(items)) return []
  return items.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return []
    try {
      return [fromUpstreamTrack(item as LegacyObject)]
    } catch {
      return []
    }
  })
}

const intervalSeconds = (interval: string | null): number => {
  if (!interval) return 0
  return interval.split(':').reduce((total, part) => total * 60 + Number.parseInt(part, 10), 0)
}

const normalizeText = (value: string): string => value
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, '')

export class ProviderService {
  readonly #serial = new SerialExecutor()

  public listProviders(): Array<{ id: Provider, name: string, capabilities: string[] }> {
    return (Object.entries(adapters) as Array<[Provider, ProviderAdapter]>).map(([id, adapter]) => ({
      id,
      name: adapter.name,
      capabilities: ['trackSearch', 'playlistSearch', 'hotSearch', 'playlist', 'leaderboard', 'comment', 'lyric', 'cover'],
    }))
  }

  async #run<T>(source: Provider, feature: string, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    return this.#serial.run(`${source}:${feature}`, async () => runWithRequestSignal(signal, task), signal)
  }

  public async searchTracks(
    query: string,
    source: Provider | 'all',
    page: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<PageResult<Track>> {
    const sources = source === 'all' ? Object.keys(adapters) as Provider[] : [source]
    const results = await Promise.all(sources.map(async current => {
      try {
        const result = await this.#run<LegacyObject>(current, 'trackSearch', signal, async () => (
          adapters[current].musicSearch.search(query, page, limit)
        ))
        return { source: current, result }
      } catch (error) {
        return { source: current, error }
      }
    }))
    const failures = results.filter(result => 'error' in result).map(result => toFailure(result.source, result.error))
    const successes = results.filter((result): result is { source: Provider, result: LegacyObject } => 'result' in result)
    if (successes.length === 0) throw new AppError('UPSTREAM_UNAVAILABLE', 502, '所有音乐平台搜索均失败')
    const items = successes.flatMap(({ result }) => normalizeTracks(result.list))
    return {
      items,
      page,
      limit,
      total: successes.reduce((sum, item) => sum + Number(item.result.total ?? 0), 0),
      totalPages: Math.max(0, ...successes.map(item => Number(item.result.allPage ?? 0))),
      upstreamErrors: failures,
    }
  }

  public async searchPlaylists(
    query: string,
    source: Provider | 'all',
    page: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<PageResult<LegacyObject>> {
    const sources = source === 'all' ? Object.keys(adapters) as Provider[] : [source]
    const results = await Promise.all(sources.map(async current => {
      try {
        const result = await this.#run<LegacyObject>(current, 'playlistSearch', signal, async () => (
          adapters[current].songList.search(query, page, limit)
        ))
        return { source: current, result }
      } catch (error) {
        return { source: current, error }
      }
    }))
    const failures = results.filter(result => 'error' in result).map(result => toFailure(result.source, result.error))
    const successes = results.filter((result): result is { source: Provider, result: LegacyObject } => 'result' in result)
    if (successes.length === 0) throw new AppError('UPSTREAM_UNAVAILABLE', 502, '所有音乐平台歌单搜索均失败')
    return {
      items: successes.flatMap(({ result }) => (Array.isArray(result.list) ? result.list : []).map(normalizePlaylist)),
      page,
      limit,
      total: successes.reduce((sum, item) => sum + Number(item.result.total ?? 0), 0),
      totalPages: Math.max(0, ...successes.map(item => Math.ceil(Number(item.result.total ?? 0) / Number(item.result.limit ?? limit)))),
      upstreamErrors: failures,
    }
  }

  public async getHotSearch(source: Provider | 'all', signal?: AbortSignal): Promise<{ items: string[], upstreamErrors: PartialFailure[] }> {
    const sources = source === 'all' ? Object.keys(adapters) as Provider[] : [source]
    const results = await Promise.all(sources.map(async current => {
      try {
        const result = await this.#run<LegacyObject>(current, 'hotSearch', signal, async () => adapters[current].hotSearch.getList())
        return { source: current, items: Array.isArray(result.list) ? result.list.map(String) : [] }
      } catch (error) {
        return { source: current, error }
      }
    }))
    const successfulItems = results.flatMap(result => 'items' in result ? result.items : [])
    if (successfulItems.length === 0 && results.every(result => 'error' in result)) {
      throw new AppError('UPSTREAM_UNAVAILABLE', 502, '所有音乐平台热搜获取均失败')
    }
    return {
      items: [...new Set(successfulItems)],
      upstreamErrors: results.filter(result => 'error' in result).map(result => toFailure(result.source, result.error)),
    }
  }

  public async getPlaylistTags(source: Provider, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.#run(source, 'playlistTags', signal, async () => adapters[source].songList.getTags())
    } catch (error) {
      throw upstreamError(source, error)
    }
  }

  public async getPlaylists(source: Provider, tagId: string, sortId: string, page: number, signal?: AbortSignal): Promise<unknown> {
    try {
      const result = await this.#run<LegacyObject>(source, 'playlistList', signal, async () => (
        adapters[source].songList.getList(sortId, tagId, page)
      ))
      return { ...result, list: Array.isArray(result.list) ? result.list.map(normalizePlaylist) : [] }
    } catch (error) {
      throw upstreamError(source, error)
    }
  }

  public async getPlaylistDetail(source: Provider, id: string, page: number, signal?: AbortSignal): Promise<unknown> {
    try {
      const result = await this.#run<LegacyObject>(source, 'playlistDetail', signal, async () => (
        adapters[source].songList.getListDetail(id, page)
      ))
      return { ...result, list: normalizeTracks(result.list) }
    } catch (error) {
      throw upstreamError(source, error)
    }
  }

  public async getLeaderboards(source: Provider, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.#run(source, 'leaderboards', signal, async () => adapters[source].leaderboard.getBoards())
    } catch (error) {
      throw upstreamError(source, error)
    }
  }

  public async getLeaderboardDetail(source: Provider, id: string, page: number, signal?: AbortSignal): Promise<unknown> {
    try {
      const result = await this.#run<LegacyObject>(source, 'leaderboardDetail', signal, async () => (
        adapters[source].leaderboard.getList(id, page)
      ))
      return { ...result, list: normalizeTracks(result.list) }
    } catch (error) {
      throw upstreamError(source, error)
    }
  }

  public async getLyrics(track: Track, signal?: AbortSignal): Promise<Record<string, string | null>> {
    try {
      const result = await this.#run<LegacyObject>(track.source, 'lyric', signal, async () => (
        awaitLegacy(adapters[track.source].getLyric(toUpstreamTrack(track)))
      ))
      return {
        lyric: typeof result.lyric === 'string' ? result.lyric : '',
        tlyric: typeof result.tlyric === 'string' ? result.tlyric : null,
        rlyric: typeof result.rlyric === 'string' ? result.rlyric : null,
        lxlyric: typeof result.lxlyric === 'string' ? result.lxlyric : null,
      }
    } catch (error) {
      throw upstreamError(track.source, error)
    }
  }

  public async getCover(track: Track, signal?: AbortSignal): Promise<string> {
    if (track.picUrl) return track.picUrl
    try {
      const result = await this.#run<unknown>(track.source, 'cover', signal, async () => (
        awaitLegacy(adapters[track.source].getPic(toUpstreamTrack(track)))
      ))
      if (typeof result !== 'string' || !/^https?:\/\//.test(result)) throw new Error('平台未返回有效封面地址')
      return result
    } catch (error) {
      throw upstreamError(track.source, error)
    }
  }

  public async getComments(
    track: Track,
    kind: 'latest' | 'hot',
    page: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const comment = adapters[track.source].comment
    const method = kind === 'hot' ? comment.getHotComment : comment.getComment
    try {
      return await this.#run(track.source, `comment:${kind}`, signal, async () => (
        method.call(comment, toUpstreamTrack(track), page, limit)
      ))
    } catch (error) {
      throw upstreamError(track.source, error)
    }
  }

  public async getCommentReplies(track: Track, commentId: string, page: number, limit: number, signal?: AbortSignal): Promise<unknown> {
    const comment = adapters[track.source].comment
    if (typeof comment.getReplyComment !== 'function') {
      throw new AppError('FEATURE_UNSUPPORTED_FOR_SOURCE', 422, `${track.source} 不支持评论回复`)
    }
    try {
      return await this.#run(track.source, 'comment:replies', signal, async () => (
        comment.getReplyComment(toUpstreamTrack(track), commentId, page, limit)
      ))
    } catch (error) {
      throw upstreamError(track.source, error)
    }
  }

  public async findMatches(track: Track, signal?: AbortSignal): Promise<Track[]> {
    const result = await this.searchTracks(`${track.name} ${track.singer}`.trim(), 'all', 1, 25, signal)
    const targetName = normalizeText(track.name)
    const targetSinger = normalizeText(track.singer.split(/[、&;；/,，|]/).sort().join('、'))
    const targetInterval = intervalSeconds(track.interval)
    return result.items
      .filter(candidate => candidate.source !== track.source)
      .map(candidate => {
        const name = normalizeText(candidate.name)
        const singer = normalizeText(candidate.singer.split(/[、&;；/,，|]/).sort().join('、'))
        const interval = intervalSeconds(candidate.interval)
        const score = (name === targetName ? 8 : name.includes(targetName) || targetName.includes(name) ? 4 : 0) +
          (singer === targetSinger ? 4 : singer.includes(targetSinger) || targetSinger.includes(singer) ? 2 : 0) +
          (Math.abs(interval - targetInterval) < 5 ? 2 : 0)
        return { candidate, score }
      })
      .filter(item => item.score >= 6)
      .sort((left, right) => right.score - left.score)
      .map(item => item.candidate)
  }
}

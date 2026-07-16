import path from 'node:path'
import type { AppConfig } from '@app/config/schema'
import { DEFAULT_CONFIG } from '@app/config/schema'

export const createTestConfig = (directory: string): AppConfig => {
  const config = structuredClone(DEFAULT_CONFIG)
  config.legal.accept_lx_music_terms = true
  config.auth.api_key = 'test-api-key-that-is-at-least-32-characters-long'
  config.paths.database = path.join(directory, 'test.sqlite')
  config.paths.downloads = path.join(directory, 'downloads')
  config.custom_source.script_path = path.join(directory, 'custom-source.js')
  config.custom_source.init_timeout_ms = 5000
  config.custom_source.action_timeout_ms = 5000
  config.network.block_private_networks = false
  config.rate_limit.enabled = false
  config.server.docs_enabled = false
  config.logging.level = 'silent'
  return config
}

export const TEST_TRACK = {
  id: 'kw_1',
  source: 'kw',
  name: '测试歌曲',
  singer: '测试歌手',
  interval: '03:00',
  albumName: '测试专辑',
  picUrl: null,
  qualities: [{ type: '128k', size: null }],
  sourceData: { songId: '1' },
} as const

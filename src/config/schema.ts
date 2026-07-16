import { Type, type Static } from 'typebox'

const StrictObject = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, {
  additionalProperties: false,
})

const CorsSchema = StrictObject({
  enabled: Type.Boolean(),
  origins: Type.Array(Type.String({ minLength: 1 })),
})

export const ConfigSchema = StrictObject({
  legal: StrictObject({
    accept_lx_music_terms: Type.Boolean(),
  }),
  server: StrictObject({
    host: Type.String({ minLength: 1 }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    docs_enabled: Type.Boolean(),
    trust_proxy: Type.Boolean(),
    body_limit_bytes: Type.Integer({ minimum: 65536, maximum: 16 * 1024 * 1024 }),
    request_timeout_ms: Type.Integer({ minimum: 1000, maximum: 300000 }),
    cors: CorsSchema,
  }),
  auth: StrictObject({
    api_key: Type.String({ minLength: 32, maxLength: 4096 }),
  }),
  paths: StrictObject({
    database: Type.String({ minLength: 1 }),
    downloads: Type.String({ minLength: 1 }),
  }),
  network: StrictObject({
    proxy_url: Type.String(),
    connect_timeout_ms: Type.Integer({ minimum: 100, maximum: 120000 }),
    request_timeout_ms: Type.Integer({ minimum: 1000, maximum: 120000 }),
    audio_timeout_ms: Type.Integer({ minimum: 10000, maximum: 4 * 60 * 60 * 1000 }),
    max_redirects: Type.Integer({ minimum: 0, maximum: 10 }),
    dns_cache_ttl_ms: Type.Integer({ minimum: 0, maximum: 300000 }),
    max_response_bytes: Type.Integer({ minimum: 1024, maximum: 64 * 1024 * 1024 }),
    block_private_networks: Type.Boolean(),
    allow_private_hosts: Type.Array(Type.String({ minLength: 1 })),
  }),
  music: StrictObject({
    default_quality: Type.Union([
      Type.Literal('flac24bit'),
      Type.Literal('flac'),
      Type.Literal('wav'),
      Type.Literal('ape'),
      Type.Literal('320k'),
      Type.Literal('192k'),
      Type.Literal('128k'),
    ]),
    allow_source_fallback: Type.Boolean(),
    max_fallback_candidates: Type.Integer({ minimum: 1, maximum: 20 }),
  }),
  custom_source: StrictObject({
    script_path: Type.String({ minLength: 1 }),
    max_script_bytes: Type.Integer({ minimum: 1024, maximum: 8 * 1024 * 1024 }),
    init_timeout_ms: Type.Integer({ minimum: 100, maximum: 120000 }),
    action_timeout_ms: Type.Integer({ minimum: 100, maximum: 120000 }),
    memory_limit_mb: Type.Integer({ minimum: 8, maximum: 512 }),
    stack_limit_kb: Type.Integer({ minimum: 128, maximum: 8192 }),
    max_http_requests: Type.Integer({ minimum: 1, maximum: 64 }),
  }),
  download: StrictObject({
    max_concurrent: Type.Integer({ minimum: 1, maximum: 32 }),
    max_file_bytes: Type.Integer({ minimum: 1024 * 1024, maximum: 10 * 1024 * 1024 * 1024 }),
    file_name_template: Type.String({ minLength: 1, maxLength: 256 }),
    existing_file: Type.Union([Type.Literal('skip'), Type.Literal('overwrite'), Type.Literal('rename')]),
    save_lrc: Type.Boolean(),
    save_word_by_word_lyric: Type.Boolean(),
    save_translated_lyric: Type.Boolean(),
    save_romanized_lyric: Type.Boolean(),
    embed_cover: Type.Boolean(),
    embed_lyric: Type.Boolean(),
    retention_hours: Type.Integer({ minimum: 1, maximum: 24 }),
    cleanup_interval_minutes: Type.Integer({ minimum: 1, maximum: 60 }),
    progress_update_ms: Type.Integer({ minimum: 100, maximum: 10000 }),
  }),
  rate_limit: StrictObject({
    enabled: Type.Boolean(),
    max: Type.Integer({ minimum: 1, maximum: 100000 }),
    window_ms: Type.Integer({ minimum: 1000, maximum: 3600000 }),
  }),
  logging: StrictObject({
    level: Type.Union([
      Type.Literal('fatal'),
      Type.Literal('error'),
      Type.Literal('warn'),
      Type.Literal('info'),
      Type.Literal('debug'),
      Type.Literal('trace'),
      Type.Literal('silent'),
    ]),
  }),
})

export type AppConfig = Static<typeof ConfigSchema>

export const DEFAULT_CONFIG: AppConfig = {
  legal: { accept_lx_music_terms: false },
  server: {
    host: '127.0.0.1',
    port: 3000,
    docs_enabled: true,
    trust_proxy: false,
    body_limit_bytes: 2 * 1024 * 1024,
    request_timeout_ms: 30000,
    cors: { enabled: false, origins: [] },
  },
  auth: { api_key: 'REPLACE_WITH_A_RANDOM_SECRET_OF_AT_LEAST_32_CHARACTERS' },
  paths: {
    database: './data/lxmusic2api.sqlite',
    downloads: './downloads',
  },
  network: {
    proxy_url: '',
    connect_timeout_ms: 10000,
    request_timeout_ms: 15000,
    audio_timeout_ms: 60 * 60 * 1000,
    max_redirects: 5,
    dns_cache_ttl_ms: 10000,
    max_response_bytes: 8 * 1024 * 1024,
    block_private_networks: true,
    allow_private_hosts: [],
  },
  music: {
    default_quality: '320k',
    allow_source_fallback: false,
    max_fallback_candidates: 5,
  },
  custom_source: {
    script_path: './.private/custom-source.js',
    max_script_bytes: 1024 * 1024,
    init_timeout_ms: 10000,
    action_timeout_ms: 20000,
    memory_limit_mb: 64,
    stack_limit_kb: 1024,
    max_http_requests: 8,
  },
  download: {
    max_concurrent: 3,
    max_file_bytes: 1024 * 1024 * 1024,
    file_name_template: '{name} - {singer}',
    existing_file: 'skip',
    save_lrc: false,
    save_word_by_word_lyric: true,
    save_translated_lyric: false,
    save_romanized_lyric: false,
    embed_cover: true,
    embed_lyric: false,
    retention_hours: 24,
    cleanup_interval_minutes: 15,
    progress_update_ms: 1000,
  },
  rate_limit: {
    enabled: true,
    max: 120,
    window_ms: 60000,
  },
  logging: { level: 'info' },
}

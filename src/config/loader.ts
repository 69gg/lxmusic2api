import fs from 'node:fs'
import path from 'node:path'
import { load, SyntaxParseError } from 'js-toml'
import Value from 'typebox/value'
import { ConfigSchema, DEFAULT_CONFIG, type AppConfig } from './schema.js'

export interface LoadedConfig {
  config: AppConfig
  configPath: string
  configDirectory: string
}

export class ConfigError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ConfigError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const mergeConfig = (base: unknown, overlay: unknown): unknown => {
  if (!isRecord(base) || !isRecord(overlay)) return overlay
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    merged[key] = key in base ? mergeConfig(base[key], value) : value
  }
  return merged
}

const formatValidationErrors = (value: unknown): string => Value.Errors(ConfigSchema, value)
  .map(error => `${error.instancePath || '/'} ${error.message}`)
  .join('; ')

const validateUrls = (config: AppConfig): void => {
  if (config.network.proxy_url) {
    let proxy: URL
    try {
      proxy = new URL(config.network.proxy_url)
    } catch (error) {
      throw new ConfigError('network.proxy_url 不是有效 URL', { cause: error })
    }
    if (!['http:', 'https:'].includes(proxy.protocol)) {
      throw new ConfigError('network.proxy_url 只支持 http:// 或 https://')
    }
  }
  for (const origin of config.server.cors.origins) {
    try {
      const url = new URL(origin)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol')
    } catch (error) {
      throw new ConfigError(`server.cors.origins 包含无效来源：${origin}`, { cause: error })
    }
  }
  if (config.server.cors.enabled && config.server.cors.origins.length === 0) {
    throw new ConfigError('启用 CORS 时必须配置至少一个 server.cors.origins')
  }
}

const validateFileNameTemplate = (config: AppConfig): void => {
  const template = config.download.file_name_template
  if ([...template].some(character => {
    const code = character.codePointAt(0) ?? 0
    return code <= 31 || code === 127
  })) {
    throw new ConfigError('download.file_name_template 不能包含控制字符')
  }
  const remainder = template.replace(/\{(?:name|singer|album|source|quality|id)\}/g, '')
  if (remainder.includes('{') || remainder.includes('}')) {
    throw new ConfigError('download.file_name_template 包含未知占位符')
  }
}

export const loadConfig = (inputPath: string): LoadedConfig => {
  const configPath = path.resolve(inputPath)
  let source: string
  try {
    source = fs.readFileSync(configPath, 'utf8')
  } catch (error) {
    throw new ConfigError(`无法读取配置文件：${configPath}`, { cause: error })
  }

  let parsed: unknown
  try {
    parsed = load(source)
  } catch (error) {
    if (error instanceof SyntaxParseError) {
      throw new ConfigError(`config.toml 语法错误：${error.message}`, { cause: error })
    }
    throw new ConfigError('解析 config.toml 失败', { cause: error })
  }

  const merged = mergeConfig(structuredClone(DEFAULT_CONFIG), parsed)
  if (!Value.Check(ConfigSchema, merged)) {
    throw new ConfigError(`config.toml 校验失败：${formatValidationErrors(merged)}`)
  }
  const config = merged

  if (!config.legal.accept_lx_music_terms) {
    throw new ConfigError('必须阅读 LICENSE 与 LX Music 补充协议，并设置 legal.accept_lx_music_terms = true')
  }
  if (config.auth.api_key.startsWith('REPLACE_')) {
    throw new ConfigError('auth.api_key 仍是示例占位值，请替换为至少 32 字符的随机密钥')
  }
  validateUrls(config)
  validateFileNameTemplate(config)

  const configDirectory = path.dirname(configPath)
  config.paths.database = path.resolve(configDirectory, config.paths.database)
  config.paths.downloads = path.resolve(configDirectory, config.paths.downloads)
  if (config.custom_source.script_path) {
    config.custom_source.script_path = path.resolve(configDirectory, config.custom_source.script_path)
  }
  if (config.custom_source.directory_path) {
    config.custom_source.directory_path = path.resolve(configDirectory, config.custom_source.directory_path)
  }

  return { config, configPath, configDirectory }
}

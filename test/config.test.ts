import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '@app/config/loader'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

const temporaryDirectory = async (): Promise<string> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lxmusic2api-config-'))
  directories.push(directory)
  return directory
}

describe('配置加载', () => {
  it('拒绝未接受补充协议的配置', async () => {
    const directory = await temporaryDirectory()
    const file = path.join(directory, 'config.toml')
    await fs.writeFile(file, '[legal]\naccept_lx_music_terms = false\n', 'utf8')
    expect(() => loadConfig(file)).toThrow(ConfigError)
  })

  it('拒绝示例密钥并解析相对路径', async () => {
    const directory = await temporaryDirectory()
    const placeholder = path.join(directory, 'placeholder.toml')
    await fs.writeFile(placeholder, '[legal]\naccept_lx_music_terms = true\n', 'utf8')
    expect(() => loadConfig(placeholder)).toThrow(/占位值/)

    const valid = path.join(directory, 'valid.toml')
    await fs.writeFile(valid, `
[legal]
accept_lx_music_terms = true
[auth]
api_key = "a-secure-test-key-with-more-than-32-characters"
[paths]
database = "./state/app.sqlite"
downloads = "./music"
[custom_source]
script_path = "./private/source.js"
directory_path = "./private/sources"
`, 'utf8')
    const loaded = loadConfig(valid)
    expect(loaded.config.paths.database).toBe(path.join(directory, 'state/app.sqlite'))
    expect(loaded.config.custom_source.script_path).toBe(path.join(directory, 'private/source.js'))
    expect(loaded.config.custom_source.directory_path).toBe(path.join(directory, 'private/sources'))
  })

  it('允许留空单文件路径并仅使用目录', async () => {
    const directory = await temporaryDirectory()
    const file = path.join(directory, 'directory-only.toml')
    await fs.writeFile(file, `
[legal]
accept_lx_music_terms = true
[auth]
api_key = "a-secure-test-key-with-more-than-32-characters"
[custom_source]
script_path = ""
directory_path = "./private/sources"
`, 'utf8')

    const loaded = loadConfig(file)
    expect(loaded.config.custom_source.script_path).toBe('')
    expect(loaded.config.custom_source.directory_path).toBe(path.join(directory, 'private/sources'))
  })
})

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { DEFAULT_CONFIG } from '../src/config/schema.js'

const main = async (): Promise<void> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lxmusic2api-openapi-'))
  const config = structuredClone(DEFAULT_CONFIG)
  config.legal.accept_lx_music_terms = true
  config.auth.api_key = randomBytes(32).toString('hex')
  config.paths.database = path.join(directory, 'openapi.sqlite')
  config.paths.downloads = path.join(directory, 'downloads')
  config.custom_source.script_path = path.join(directory, 'missing-source.js')
  config.server.docs_enabled = false
  config.rate_limit.enabled = false
  config.logging.level = 'silent'
  const app = await buildApp(config)
  try {
    await app.ready()
    const output = path.resolve('docs/openapi.json')
    await fs.mkdir(path.dirname(output), { recursive: true })
    await fs.writeFile(output, `${JSON.stringify(app.swagger(), null, 2)}\n`, 'utf8')
  } finally {
    await app.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
}

await main()

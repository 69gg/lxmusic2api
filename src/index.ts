import process from 'node:process'
import { buildApp } from './app.js'
import { ConfigError, loadConfig } from './config/loader.js'

const parseConfigPath = (arguments_: readonly string[]): string => {
  const index = arguments_.indexOf('--config')
  if (index < 0) return process.env.LXMUSIC2API_CONFIG ?? './config.toml'
  const value = arguments_[index + 1]
  if (!value) throw new ConfigError('--config 后必须提供配置文件路径')
  return value
}

const main = async (): Promise<void> => {
  const { config } = loadConfig(parseConfigPath(process.argv.slice(2)))
  const app = await buildApp(config)
  const close = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, '收到退出信号，正在安全关闭')
    await app.close()
  }
  process.once('SIGINT', () => void close('SIGINT'))
  process.once('SIGTERM', () => void close('SIGTERM'))
  await app.listen({ host: config.server.host, port: config.server.port })
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`lxmusic2api 启动失败：${message}\n`)
  process.exitCode = 1
})

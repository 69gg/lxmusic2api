import process from 'node:process'
import Fastify from 'fastify'
import { loadConfig } from '../src/config/loader.js'
import { CustomSourceManager } from '../src/custom-source/manager.js'
import { closeHttpClient, configureHttpClient } from '../src/network/http-client.js'

const configArgument = process.argv.indexOf('--config')
const configPath = configArgument >= 0 ? process.argv[configArgument + 1] : './config.toml'
if (!configPath) throw new Error('--config 后必须提供配置路径')

const { config } = loadConfig(configPath)
const logger = Fastify({ logger: { level: config.logging.level } })
configureHttpClient(config)
const source = new CustomSourceManager(config, logger.log)
try {
  await source.initialize()
  if (!source.available) throw new Error('唯一自定义源未通过初始化与能力声明检查')
  const supportedProviders = Object.entries(source.providerAvailability())
    .filter(([, supported]) => supported)
    .map(([provider]) => provider)
  process.stdout.write(`自定义源兼容性检查通过；支持平台：${supportedProviders.join(', ')}\n`)
} finally {
  await source.close()
  await closeHttpClient()
  await logger.close()
}

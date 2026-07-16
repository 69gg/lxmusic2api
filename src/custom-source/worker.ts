import { createCipheriv, createHash, constants, publicEncrypt, randomBytes } from 'node:crypto'
import { inflate, deflate } from 'node:zlib'
import { parentPort, workerData } from 'node:worker_threads'
import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
} from 'quickjs-emscripten'
import type {
  MainToWorkerMessage,
  SourceWorkerData,
  WorkerToMainMessage,
} from './protocol.js'

if (!parentPort) throw new Error('自定义源 Worker 缺少 parentPort')

const data = workerData as SourceWorkerData
const port = parentPort
const post = (message: WorkerToMainMessage): void => port.postMessage(message)

let runtime: QuickJSRuntime | undefined
let context: QuickJSContext | undefined
let deadline = 0
let nextTimerId = 1
const timers = new Map<number, { handle: QuickJSHandle, timer: NodeJS.Timeout }>()
const pendingHttp = new Map<string, QuickJSDeferredPromise>()

const bufferFromDump = (value: unknown, encoding?: BufferEncoding): Buffer => {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value, encoding)
  if (Array.isArray(value)) return Buffer.from(value as number[])
  if (typeof value === 'object' && value !== null) {
    const candidate = value as { type?: unknown, data?: unknown }
    if (candidate.type === 'Buffer' && Array.isArray(candidate.data)) return Buffer.from(candidate.data as number[])
  }
  throw new Error('无法转换为 Buffer')
}

const toArrayBuffer = (buffer: Buffer): ArrayBuffer => buffer.buffer.slice(
  buffer.byteOffset,
  buffer.byteOffset + buffer.byteLength,
) as ArrayBuffer

const disposeCallResult = (vm: QuickJSContext, result: ReturnType<QuickJSContext['callFunction']>): void => {
  if (result.error) {
    result.error.dispose()
  } else {
    result.value.dispose()
  }
  vm.runtime.executePendingJobs()
}

const clearTimers = (): void => {
  for (const { handle, timer } of timers.values()) {
    clearTimeout(timer)
    handle.dispose()
  }
  timers.clear()
}

const installHostFunction = (
  vm: QuickJSContext,
  name: string,
  callback: (...handles: QuickJSHandle[]) => QuickJSHandle | void,
): void => {
  const handle = vm.newFunction(name, callback)
  vm.setProp(vm.global, name, handle)
  handle.dispose()
}

const createZlibPromise = (
  vm: QuickJSContext,
  operation: typeof inflate | typeof deflate,
  inputHandle: QuickJSHandle,
): QuickJSHandle => {
  const deferred = vm.newPromise()
  const input = bufferFromDump(vm.dump(inputHandle))
  operation(input, (error, output) => {
    if (error) {
      const errorHandle = vm.newError(error.message)
      deferred.reject(errorHandle)
      errorHandle.dispose()
    } else {
      const outputHandle = vm.newArrayBuffer(toArrayBuffer(output))
      deferred.resolve(outputHandle)
      outputHandle.dispose()
    }
    vm.runtime.executePendingJobs()
  })
  return deferred.handle
}

const installHostApi = (vm: QuickJSContext): void => {
  installHostFunction(vm, '__hostBufferFrom', (valueHandle, encodingHandle) => {
    const encoding = vm.typeof(encodingHandle) === 'string' ? vm.getString(encodingHandle) as BufferEncoding : undefined
    return vm.newArrayBuffer(toArrayBuffer(bufferFromDump(vm.dump(valueHandle), encoding)))
  })
  installHostFunction(vm, '__hostBufferToString', (valueHandle, encodingHandle) => {
    const encoding = vm.typeof(encodingHandle) === 'string' ? vm.getString(encodingHandle) as BufferEncoding : 'utf8'
    return vm.newString(bufferFromDump(vm.dump(valueHandle)).toString(encoding))
  })
  installHostFunction(vm, '__hostAesEncrypt', (bufferHandle, modeHandle, keyHandle, ivHandle) => {
    const cipher = createCipheriv(
      vm.getString(modeHandle),
      bufferFromDump(vm.dump(keyHandle)),
      bufferFromDump(vm.dump(ivHandle)),
    )
    const output = Buffer.concat([cipher.update(bufferFromDump(vm.dump(bufferHandle))), cipher.final()])
    return vm.newArrayBuffer(toArrayBuffer(output))
  })
  installHostFunction(vm, '__hostRsaEncrypt', (bufferHandle, keyHandle) => {
    const input = bufferFromDump(vm.dump(bufferHandle))
    const padded = Buffer.concat([Buffer.alloc(Math.max(0, 128 - input.length)), input])
    const output = publicEncrypt({ key: vm.getString(keyHandle), padding: constants.RSA_NO_PADDING }, padded)
    return vm.newArrayBuffer(toArrayBuffer(output))
  })
  installHostFunction(vm, '__hostRandomBytes', sizeHandle => {
    const size = Math.min(Math.max(vm.getNumber(sizeHandle), 0), 65536)
    return vm.newArrayBuffer(toArrayBuffer(randomBytes(size)))
  })
  installHostFunction(vm, '__hostMd5', valueHandle => vm.newString(
    createHash('md5').update(vm.getString(valueHandle)).digest('hex'),
  ))
  installHostFunction(vm, '__hostInflate', inputHandle => createZlibPromise(vm, inflate, inputHandle))
  installHostFunction(vm, '__hostDeflate', inputHandle => createZlibPromise(vm, deflate, inputHandle))

  installHostFunction(vm, '__hostSetTimeout', (callbackHandle, delayHandle, repeatHandle) => {
    if (timers.size >= 100) throw new Error('定时器数量超过限制')
    const id = nextTimerId++
    const delay = Math.min(Math.max(vm.getNumber(delayHandle), 0), 3600000)
    const repeat = Boolean(vm.dump(repeatHandle))
    const retained = callbackHandle.dup()
    const invoke = (): void => {
      if (!retained.alive || !context) return
      disposeCallResult(context, context.callFunction(retained, context.undefined))
      if (repeat && timers.has(id)) {
        const timer = setTimeout(invoke, delay)
        timers.set(id, { handle: retained, timer })
      } else {
        retained.dispose()
        timers.delete(id)
      }
    }
    const timer = setTimeout(invoke, delay)
    timers.set(id, { handle: retained, timer })
    return vm.newNumber(id)
  })
  installHostFunction(vm, '__hostClearTimer', idHandle => {
    const id = vm.getNumber(idHandle)
    const entry = timers.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    entry.handle.dispose()
    timers.delete(id)
  })

  installHostFunction(vm, '__hostRequest', (idHandle, urlHandle, optionsHandle) => {
    if (pendingHttp.size >= data.limits.maxHttpRequests) throw new Error('自定义源并发 HTTP 请求超过限制')
    const id = vm.getString(idHandle)
    const deferred = vm.newPromise()
    pendingHttp.set(id, deferred)
    post({
      type: 'httpRequest',
      id,
      url: vm.getString(urlHandle),
      options: JSON.parse(vm.getString(optionsHandle)) as unknown,
    })
    return deferred.handle
  })
  installHostFunction(vm, '__hostCancelRequest', idHandle => {
    const id = vm.getString(idHandle)
    const pending = pendingHttp.get(id)
    if (pending) {
      const errorHandle = vm.newError('请求已取消')
      pending.reject(errorHandle)
      errorHandle.dispose()
      pendingHttp.delete(id)
      vm.runtime.executePendingJobs()
    }
    post({ type: 'httpCancel', id })
  })
  installHostFunction(vm, '__hostInited', jsonHandle => {
    const value = JSON.parse(vm.getString(jsonHandle)) as { sources?: unknown }
    post({ type: 'inited', sources: value.sources })
  })
  installHostFunction(vm, '__hostUpdateNotice', () => post({ type: 'updateNotice' }))
  installHostFunction(vm, '__hostScriptError', () => post({ type: 'scriptError' }))
}

const bootstrap = (sourceData: SourceWorkerData): string => `
(() => {
  globalThis.window = globalThis
  globalThis.self = globalThis
  const __info = ${JSON.stringify({ ...sourceData.metadata, rawScript: sourceData.script })}
  let __requestHandler = null
  let __inited = false
  let __showedUpdate = false
  let __requestSeq = 0

  class LXBuffer extends Uint8Array {
    static from(value, encoding) { return new LXBuffer(__hostBufferFrom(value, encoding)) }
    static alloc(size) { return new LXBuffer(Number(size) || 0) }
    static concat(values) {
      const length = values.reduce((sum, value) => sum + value.length, 0)
      const output = new LXBuffer(length)
      let offset = 0
      for (const value of values) { output.set(value, offset); offset += value.length }
      return output
    }
    toString(encoding = 'utf8') { return __hostBufferToString(this, encoding) }
    toJSON() { return { type: 'Buffer', data: Array.from(this) } }
  }

  globalThis.Buffer = LXBuffer
  globalThis.atob = value => LXBuffer.from(String(value), 'base64').toString('binary')
  globalThis.btoa = value => LXBuffer.from(String(value), 'binary').toString('base64')
  globalThis.setTimeout = (fn, delay = 0) => __hostSetTimeout(fn, delay, false)
  globalThis.clearTimeout = id => __hostClearTimer(id)
  globalThis.setInterval = (fn, delay = 0) => __hostSetTimeout(fn, delay, true)
  globalThis.clearInterval = id => __hostClearTimer(id)
  globalThis.console = Object.freeze({ log() {}, info() {}, debug() {}, warn() {}, error() { __hostScriptError() } })

  const EVENT_NAMES = Object.freeze({ request: 'request', inited: 'inited', updateAlert: 'updateAlert' })
  const lx = Object.freeze({
    EVENT_NAMES,
    version: '2.0.0',
    env: 'desktop',
    currentScriptInfo: Object.freeze(__info),
    request(url, options = {}, callback) {
      const id = 'http_' + (++__requestSeq)
      let cancelled = false
      __hostRequest(id, String(url), JSON.stringify(options)).then(serialized => {
        if (cancelled) return
        const payload = JSON.parse(serialized)
        if (!payload.ok) {
          callback.call(lx, new Error(payload.error || '请求失败'), null, null)
          return
        }
        const response = payload.response
        response.raw = LXBuffer.from(response.rawBase64, 'base64')
        delete response.rawBase64
        callback.call(lx, null, response, response.body)
      }, error => {
        if (!cancelled) callback.call(lx, error instanceof Error ? error : new Error(String(error)), null, null)
      })
      return () => { cancelled = true; __hostCancelRequest(id) }
    },
    async send(eventName, payload) {
      if (!Object.values(EVENT_NAMES).includes(eventName)) throw new Error('不支持的事件：' + eventName)
      if (eventName === EVENT_NAMES.inited) {
        if (__inited) throw new Error('脚本已初始化')
        __inited = true
        __hostInited(JSON.stringify(payload || {}))
        return
      }
      if (eventName === EVENT_NAMES.updateAlert) {
        if (__showedUpdate) throw new Error('更新提示只能发送一次')
        __showedUpdate = true
        __hostUpdateNotice()
        return
      }
      throw new Error('未知事件：' + eventName)
    },
    async on(eventName, handler) {
      if (eventName !== EVENT_NAMES.request || typeof handler !== 'function') throw new Error('不支持的事件：' + eventName)
      __requestHandler = handler
    },
    utils: Object.freeze({
      buffer: Object.freeze({
        from: (value, encoding) => LXBuffer.from(value, encoding),
        bufToString: (value, encoding) => LXBuffer.from(value).toString(encoding),
      }),
      crypto: Object.freeze({
        aesEncrypt: (buffer, mode, key, iv) => new LXBuffer(__hostAesEncrypt(buffer, mode, key, iv)),
        rsaEncrypt: (buffer, key) => new LXBuffer(__hostRsaEncrypt(buffer, key)),
        randomBytes: size => new LXBuffer(__hostRandomBytes(size)),
        md5: value => __hostMd5(String(value)),
      }),
      zlib: Object.freeze({
        inflate: async value => new LXBuffer(await __hostInflate(value)),
        deflate: async value => new LXBuffer(await __hostDeflate(value)),
      }),
    }),
  })
  globalThis.lx = lx
  globalThis.__lxInvoke = async payload => {
    if (!__requestHandler) throw new Error('Request event is not defined')
    const result = __requestHandler(payload)
    if (!result || typeof result.then !== 'function') throw new Error('自定义源请求处理器必须返回 Promise')
    return await result
  }
})()
`

const handleHttpResponse = (message: Extract<MainToWorkerMessage, { type: 'httpResponse' }>): void => {
  if (!context) return
  const deferred = pendingHttp.get(message.id)
  if (!deferred) return
  pendingHttp.delete(message.id)
  const payloadHandle = context.newString(JSON.stringify({
    ok: message.ok,
    ...(message.ok ? { response: message.payload } : { error: message.error ?? '请求失败' }),
  }))
  deferred.resolve(payloadHandle)
  payloadHandle.dispose()
  context.runtime.executePendingJobs()
}

const invoke = async (message: Extract<MainToWorkerMessage, { type: 'invoke' }>): Promise<void> => {
  if (!context) return
  deadline = Date.now() + data.limits.actionTimeoutMs
  const expression = `globalThis.__lxInvoke(JSON.parse(${JSON.stringify(JSON.stringify(message.payload))}))`
  const evaluation = context.evalCode(expression, 'lxmusic2api-action.js')
  if (evaluation.error) {
    const error = context.dump(evaluation.error) as { message?: string }
    evaluation.error.dispose()
    deadline = 0
    post({ type: 'invokeResult', id: message.id, ok: false, error: error.message ?? '自定义源执行失败' })
    return
  }
  const promiseHandle = evaluation.value
  try {
    const resolution = context.resolvePromise(promiseHandle)
    context.runtime.executePendingJobs()
    const resolved = await resolution
    if (resolved.error) {
      const error = context.dump(resolved.error) as { message?: string }
      resolved.error.dispose()
      post({ type: 'invokeResult', id: message.id, ok: false, error: error.message ?? '自定义源执行失败' })
    } else {
      const result: unknown = context.dump(resolved.value) as unknown
      resolved.value.dispose()
      post({ type: 'invokeResult', id: message.id, ok: true, result })
    }
  } catch (error) {
    post({ type: 'invokeResult', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  } finally {
    promiseHandle.dispose()
    deadline = 0
  }
}

const dispose = (): void => {
  clearTimers()
  for (const pending of pendingHttp.values()) pending.dispose()
  pendingHttp.clear()
  context?.dispose()
  context = undefined
  runtime?.dispose()
  runtime = undefined
}

const main = async (): Promise<void> => {
  const quickJS = await getQuickJS()
  runtime = quickJS.newRuntime()
  runtime.setMemoryLimit(data.limits.memoryLimitMb * 1024 * 1024)
  runtime.setMaxStackSize(data.limits.stackLimitKb * 1024)
  runtime.setInterruptHandler(() => deadline > 0 && Date.now() > deadline)
  runtime.setModuleLoader(() => { throw new Error('自定义源不允许加载模块') })
  context = runtime.newContext()
  installHostApi(context)

  deadline = Date.now() + data.limits.initTimeoutMs
  const environment = context.evalCode(bootstrap(data), 'lxmusic2api-bootstrap.js')
  if (environment.error) {
    const error = context.dump(environment.error) as { message?: string }
    environment.error.dispose()
    post({ type: 'initError', error: error.message ?? '初始化运行环境失败' })
    return
  }
  environment.value.dispose()

  const result = context.evalCode(data.script, 'custom-source.js')
  if (result.error) {
    const error = context.dump(result.error) as { message?: string }
    result.error.dispose()
    post({ type: 'initError', error: error.message ?? '自定义源语法或运行错误' })
    return
  }
  result.value.dispose()
  runtime.executePendingJobs()

  port.on('message', (message: MainToWorkerMessage) => {
    switch (message.type) {
      case 'invoke': void invoke(message); break
      case 'httpResponse': handleHttpResponse(message); break
      case 'dispose': dispose(); process.exit(0)
    }
  })
}

void main().catch(error => {
  post({ type: 'initError', error: error instanceof Error ? error.message : String(error) })
})

process.once('exit', dispose)

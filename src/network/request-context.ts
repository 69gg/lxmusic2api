import { AsyncLocalStorage } from 'node:async_hooks'

interface RequestContext {
  signal: AbortSignal | undefined
}

const storage = new AsyncLocalStorage<RequestContext>()

export const runWithRequestSignal = async <T>(signal: AbortSignal | undefined, callback: () => Promise<T>): Promise<T> => (
  storage.run({ signal }, callback)
)

export const getRequestSignal = (): AbortSignal | undefined => storage.getStore()?.signal

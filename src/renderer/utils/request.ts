import { getRequestSignal, runWithRequestSignal } from '@app/network/request-context'
import { requestBuffer, type CompatibleRequestOptions, type CancellableRequest } from '@app/network/http-client'

export interface LegacyHttpResult extends CancellableRequest<Awaited<ReturnType<typeof requestBuffer>>> {
  isCancelled: boolean
}

export const httpFetch = (url: string, options: CompatibleRequestOptions = { method: 'get' }): LegacyHttpResult => {
  const controller = new AbortController()
  const outerSignal = getRequestSignal()
  const signal = outerSignal ? AbortSignal.any([controller.signal, outerSignal]) : controller.signal
  const result: LegacyHttpResult = {
    isCancelled: false,
    cancelHttp: () => {
      result.isCancelled = true
      controller.abort(new Error('请求已取消'))
    },
    promise: runWithRequestSignal(signal, async () => requestBuffer(url, options)),
  }
  return result
}

export const cancelHttp = (request: { abort?: () => void } | null | undefined): void => request?.abort?.()

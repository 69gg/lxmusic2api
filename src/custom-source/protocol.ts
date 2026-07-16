import type { Provider, Quality } from '@app/domain/track'

export interface CustomSourceMetadata {
  name: string
  description: string
  version: string
  author: string
  homepage: string
}

export interface CustomSourceLimits {
  initTimeoutMs: number
  actionTimeoutMs: number
  memoryLimitMb: number
  stackLimitKb: number
  maxHttpRequests: number
}

export interface CustomSourceCapability {
  actions: Array<'musicUrl'>
  qualities: Quality[]
}

export type CustomSourceCapabilities = Partial<Record<Provider, CustomSourceCapability>>

export interface SourceWorkerData {
  script: string
  metadata: CustomSourceMetadata
  limits: CustomSourceLimits
}

export type MainToWorkerMessage =
  | { type: 'invoke', id: string, payload: unknown }
  | { type: 'httpResponse', id: string, ok: boolean, payload?: unknown, error?: string }
  | { type: 'dispose' }

export type WorkerToMainMessage =
  | { type: 'inited', sources: unknown }
  | { type: 'initError', error: string }
  | { type: 'invokeResult', id: string, ok: boolean, result?: unknown, error?: string }
  | { type: 'httpRequest', id: string, url: string, options: unknown }
  | { type: 'httpCancel', id: string }
  | { type: 'updateNotice' }
  | { type: 'scriptError' }

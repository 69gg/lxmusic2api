export class AppError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
    public readonly expose = true,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AppError'
  }
}

export const upstreamError = (source: string, error: unknown): AppError => new AppError(
  'UPSTREAM_ERROR',
  502,
  `${source} 平台请求失败：${error instanceof Error ? error.message : String(error)}`,
  true,
  { cause: error },
)

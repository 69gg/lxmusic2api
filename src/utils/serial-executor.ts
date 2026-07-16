export class SerialExecutor {
  readonly #tails = new Map<string, Promise<void>>()

  public async run<T>(key: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve()
    let release: (() => void) | undefined
    const current = new Promise<void>(resolve => {
      release = resolve
    })
    const tail = previous.catch(() => undefined).then(() => current)
    this.#tails.set(key, tail)

    await previous.catch(() => undefined)
    try {
      signal?.throwIfAborted()
      return await task()
    } finally {
      release?.()
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    }
  }
}

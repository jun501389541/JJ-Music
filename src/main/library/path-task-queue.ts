import { resolve } from 'node:path'

/** Reserve every affected path together; dependencies always point to older tasks. */
export class PathTaskQueue {
  private readonly tails = new Map<string, Promise<void>>()

  run<T>(paths: readonly string[], work: () => Promise<T>): Promise<T> {
    const keys = [...new Set(paths.map(path => {
      const absolute = resolve(path)
      return process.platform === 'win32' ? absolute.toLowerCase() : absolute
    }))]
    if (!keys.length) throw new Error('文件任务至少需要一个目标路径')
    const previous = keys.map(key => this.tails.get(key)).filter((tail): tail is Promise<void> => !!tail)
    const operation = Promise.all(previous).then(work)
    const tail = operation.then(() => undefined, () => undefined)
    for (const key of keys) this.tails.set(key, tail)
    void tail.then(() => {
      for (const key of keys) if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return operation
  }

  async flush(): Promise<void> {
    while (this.tails.size) await Promise.all([...this.tails.values()])
  }
}

/** Track producers that can pause before submitting their next file task. */
export class TaskGroup {
  private readonly active = new Set<Promise<unknown>>()

  run<T>(work: () => Promise<T>): Promise<T> {
    const operation = Promise.resolve().then(work)
    this.active.add(operation)
    void operation.then(() => this.active.delete(operation), () => this.active.delete(operation))
    return operation
  }

  async flush(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active])
  }
}

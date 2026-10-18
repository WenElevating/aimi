/**
 * 按业务 key 串行执行异步任务；不同 key 之间保持并行。
 * 队列尾部永不拒绝，单个任务失败不会阻塞后续任务。
 */
export class KeyedSerialQueue {
  readonly #tails = new Map<string, Promise<void>>();

  /**
   * 把任务追加到 key 对应的队尾，并返回该任务自身的结果。
   * @param key - 需要保持顺序的业务分片键，当前由 sessionId 提供
   * @param task - 任务函数；只有前一个同 key 任务完成后才会调用
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const current = previous.then(task);
    const tail = current.then(() => undefined, () => undefined);
    this.#tails.set(key, tail);
    return current.finally(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
  }
}

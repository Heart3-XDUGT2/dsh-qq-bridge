/**
 * 033：准入后的内容准备队列，仅存当前进程的有界任务。
 *
 * 同聊天 prepare→复核→deliver 串行，不同聊天并行。prepare 只能读取内容，
 * 不得自行投递；取消/过期不调用 fallback。prepare 失败或超时才可用同步
 * fallback(reason) 生成安全降级值，再经相同复核进入 deliver。
 *
 * accepted:false 是明确未受理，调用方须记账，不能越过前序即时投递。
 * deliver 开始后无法回滚外部副作用；若其内部还需 await，应在提交前复核
 * 收到的 guard。delivered 仅表示该回调完成，不代表 QQ 或模型已确认。
 */
export function createContentQueue ({
  maxChats = 32, maxPendingPerChat = 16, taskTimeoutMs = 12000,
  now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout
} = {}) {
  const limit = (value, fallback, ceiling) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? Math.min(ceiling, Math.max(1, Math.floor(n))) : fallback
  }
  const chatLimit = limit(maxChats, 32, 32)
  const pendingLimit = limit(maxPendingPerChat, 16, 16)
  const timeout = limit(taskTimeoutMs, 12000, 12000)
  const chats = new Map()
  let disposed = false

  const reject = reason => ({ accepted: false, reason, done: Promise.resolve({ status: 'rejected', reason }) })
  const time = () => {
    try { const n = Number(now()); return Number.isFinite(n) ? n : Infinity } catch { return Infinity }
  }
  function settle (job, result) {
    if (job.settled) return
    job.settled = true
    job.resolve(result)
  }
  function blocked (state, job) {
    if (disposed || !state.active || chats.get(state.key) !== state || job.settled) return 'cancelled'
    if (time() >= job.expiresAt) return 'expired'
    try { if (job.isCurrent() !== true) return 'cancelled' } catch { return 'cancelled' }
    return ''
  }
  function context (state, job) {
    return { isCurrent: () => blocked(state, job) === '', signal: job.controller.signal }
  }
  function stopIfBlocked (state, job) {
    const status = blocked(state, job)
    if (!status) return false
    job.controller.abort(status)
    settle(job, { status, reason: status === 'expired' ? 'deadline' : 'not-current' })
    return true
  }
  function prepare (state, job) {
    return new Promise(resolve => {
      let finished = false
      let timer = null
      const finish = result => {
        if (finished) return
        finished = true
        try { if (timer !== null) clearTimer(timer) } catch { /* cleanup only */ }
        job.controller.signal.removeEventListener('abort', onAbort)
        resolve(result)
      }
      const onAbort = () => finish({ kind: 'cancelled' })
      job.controller.signal.addEventListener('abort', onAbort, { once: true })
      if (job.controller.signal.aborted) { onAbort(); return }
      try {
        timer = setTimer(() => finish({ kind: 'failed', reason: 'prepare-timeout' }), timeout)
      } catch {
        finish({ kind: 'failed', reason: 'prepare-failed' })
        return
      }
      // Both handlers consume late success/rejection after cancellation or timeout.
      Promise.resolve().then(() => {
        if (finished) return
        if (blocked(state, job)) { finish({ kind: 'cancelled' }); return }
        return job.task.prepare(context(state, job))
      }).then(
        value => finish({ kind: 'prepared', value }),
        () => finish({ kind: 'failed', reason: 'prepare-failed' })
      )
    })
  }
  async function run (state, job) {
    if (stopIfBlocked(state, job)) return
    job.phase = 'preparing'
    const prepared = await prepare(state, job)
    if (job.settled || stopIfBlocked(state, job)) return
    if (prepared.kind === 'cancelled') {
      settle(job, { status: 'cancelled', reason: 'not-current' })
      return
    }
    let value = prepared.value
    const usedFallback = prepared.kind === 'failed'
    if (usedFallback) {
      if (typeof job.task.fallback !== 'function') {
        settle(job, { status: 'prepare-failed', reason: prepared.reason })
        return
      }
      try {
        value = job.task.fallback(prepared.reason)
        if (value && typeof value.then === 'function') {
          // Fallback must not start another asynchronous content pipeline.
          Promise.resolve(value).catch(() => {})
          settle(job, { status: 'fallback-failed', reason: 'fallback-must-be-synchronous' })
          return
        }
      } catch {
        settle(job, { status: 'fallback-failed', reason: 'fallback-failed' })
        return
      }
    }
    if (stopIfBlocked(state, job)) return
    job.phase = 'delivering'
    try {
      const result = await job.task.deliver(value, context(state, job))
      settle(job, {
        status: 'delivered', value: result, usedFallback,
        ...(usedFallback ? { reason: prepared.reason } : {})
      })
    } catch {
      settle(job, { status: 'delivery-failed', reason: 'delivery-failed' })
    }
  }
  async function pump (state) {
    try {
      while (!disposed && state.active && chats.get(state.key) === state && state.pending.length > 0) {
        const job = state.pending.shift()
        state.running = job
        try { await run(state, job) } catch { settle(job, { status: 'prepare-failed', reason: 'queue-task-failed' }) }
        state.running = null
      }
    } finally {
      state.pumping = false
      if (chats.get(state.key) === state && state.pending.length === 0) chats.delete(state.key)
    }
  }
  function enqueue (key, task, options = {}) {
    if (disposed) return reject('disposed')
    if (typeof key !== 'string' || key.trim() === '' || key.length > 256) return reject('invalid-key')
    if (!task || typeof task.prepare !== 'function' || typeof task.deliver !== 'function'
      || (task.fallback !== undefined && typeof task.fallback !== 'function')
      || (options.isCurrent !== undefined && typeof options.isCurrent !== 'function')) return reject('invalid-task')
    const expiresAt = options.expiresAt === undefined ? Infinity : Number(options.expiresAt)
    if (Number.isNaN(expiresAt)) return reject('invalid-deadline')
    let state = chats.get(key)
    if (!state) {
      if (chats.size >= chatLimit) return reject('chat-limit')
      state = { key, active: true, pending: [], running: null, pumping: false }
      chats.set(key, state)
    }
    if (state.pending.length >= pendingLimit) return reject('chat-queue-full')
    let resolve
    const done = new Promise(yes => { resolve = yes })
    const job = {
      task, resolve, settled: false, expiresAt, phase: 'waiting',
      isCurrent: options.isCurrent ?? (() => true), controller: new AbortController()
    }
    state.pending.push(job)
    if (!state.pumping) { state.pumping = true; void pump(state) }
    return { accepted: true, done }
  }
  function cancelState (key, reason) {
    const state = chats.get(key)
    if (!state) return 0
    state.active = false
    chats.delete(key)
    const jobs = [...(state.running ? [state.running] : []), ...state.pending]
    state.pending = []
    let cancelled = 0
    for (const job of jobs) {
      if (job.settled) continue
      cancelled += 1
      job.controller.abort(reason)
      settle(job, {
        status: 'cancelled', reason,
        ...(job.phase === 'delivering' ? { deliveryStarted: true } : {})
      })
    }
    return cancelled
  }
  function invalidate (key) { return cancelState(key, 'invalidated') }
  function dispose () {
    if (disposed) return 0
    disposed = true
    let cancelled = 0
    for (const key of [...chats.keys()]) cancelled += cancelState(key, 'disposed')
    return cancelled
  }
  function stats () {
    return {
      chats: chats.size,
      pending: [...chats.values()].reduce((sum, state) => sum + state.pending.length, 0),
      running: [...chats.values()].filter(state => state.running !== null).length,
      disposed
    }
  }
  return { enqueue, invalidate, dispose, stats }
}

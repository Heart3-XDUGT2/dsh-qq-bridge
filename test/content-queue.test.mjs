import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createContentQueue } from '../lib/content-queue.js'

const tick = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve() }
function deferred () {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function job (name, trace, gate = null) {
  return {
    prepare: async () => { trace.push('prepare:' + name); return gate ? await gate.promise : name },
    deliver: async value => { trace.push('deliver:' + name); return value }
  }
}
function fakeTimers () {
  let seq = 0
  const tasks = new Map()
  return {
    setTimer: fn => { const id = ++seq; tasks.set(id, fn); return id },
    clearTimer: id => tasks.delete(id),
    fire: () => { const all = [...tasks.values()]; tasks.clear(); for (const fn of all) fn() },
    size: () => tasks.size
  }
}

test('033 queue：同聊天慢转发A先准备并交付，随后文字B不能越过', async t => {
  const q = createContentQueue(), trace = [], gate = deferred()
  t.after(() => q.dispose())
  const a = q.enqueue('chat-a', job('a', trace, gate))
  const b = q.enqueue('chat-a', job('b', trace))
  await tick()
  assert.deepEqual(trace, ['prepare:a'])
  gate.resolve('a')
  assert.equal((await a.done).status, 'delivered')
  assert.equal((await b.done).status, 'delivered')
  assert.deepEqual(trace, ['prepare:a', 'deliver:a', 'prepare:b', 'deliver:b'])
})

test('033 queue：另一聊天不被慢转发阻塞', async t => {
  const q = createContentQueue(), trace = [], gate = deferred()
  t.after(() => q.dispose())
  const a = q.enqueue('chat-a', job('a', trace, gate))
  const b = q.enqueue('chat-b', job('b', trace))
  assert.equal((await b.done).status, 'delivered')
  assert.equal(trace.includes('deliver:a'), false)
  gate.resolve('a')
  await a.done
})

test('033 queue：每聊天等待有界，明确拒绝且不执行超额任务', async t => {
  const q = createContentQueue({ maxPendingPerChat: 2 }), trace = [], gate = deferred()
  t.after(() => q.dispose())
  const a = q.enqueue('chat-a', job('a', trace, gate))
  const b = q.enqueue('chat-a', job('b', trace))
  const c = q.enqueue('chat-a', job('c', trace))
  const d = q.enqueue('chat-a', job('rejected', trace))
  assert.equal(d.accepted, false)
  assert.equal(d.reason, 'chat-queue-full')
  assert.equal((await d.done).status, 'rejected')
  gate.resolve('a')
  await Promise.all([a.done, b.done, c.done])
  assert.equal(trace.some(line => line.includes('rejected')), false)
})

test('033 queue：聊天槽有界，结束后释放', async t => {
  const q = createContentQueue({ maxChats: 1 }), trace = [], gate = deferred()
  t.after(() => q.dispose())
  const a = q.enqueue('chat-a', job('a', trace, gate))
  const rejected = q.enqueue('chat-b', job('rejected', trace))
  assert.equal(rejected.accepted, false)
  assert.equal(rejected.reason, 'chat-limit')
  gate.resolve('a')
  await a.done
  await tick()
  const b = q.enqueue('chat-b', job('b', trace))
  assert.equal(b.accepted, true)
  assert.equal((await b.done).status, 'delivered')
})

test('033 queue：invalidate取消在途和等待任务，晚结果不交付', async t => {
  const q = createContentQueue(), trace = [], gate = deferred()
  t.after(() => q.dispose())
  const a = q.enqueue('chat-a', job('a', trace, gate))
  const b = q.enqueue('chat-a', job('b', trace))
  await tick()
  assert.equal(q.invalidate('chat-a'), 2)
  gate.resolve('late')
  assert.equal((await a.done).status, 'cancelled')
  assert.equal((await b.done).status, 'cancelled')
  assert.deepEqual(trace, ['prepare:a'])
})

test('033 queue：enqueue后立即撤销，尚未开始的prepare也不能调用', async t => {
  const q = createContentQueue(), trace = []
  t.after(() => q.dispose())
  const r = q.enqueue('chat-a', job('a', trace))
  q.invalidate('chat-a')
  assert.equal((await r.done).status, 'cancelled')
  await tick()
  assert.deepEqual(trace, [])
})

test('033 queue：invalidate立即释放逻辑槽，新代同key不等旧查询', async t => {
  const q = createContentQueue({ maxChats: 1 }), trace = [], gate = deferred()
  t.after(() => q.dispose())
  const a = q.enqueue('chat-a', job('old', trace, gate))
  await tick()
  q.invalidate('chat-a')
  const b = q.enqueue('chat-a', job('new', trace))
  assert.equal((await b.done).status, 'delivered')
  gate.resolve('late')
  await a.done
  assert.equal(trace.includes('deliver:old'), false)
})

test('033 queue：准入已撤销时不准备、不fallback、不交付', async t => {
  const q = createContentQueue(), trace = []
  t.after(() => q.dispose())
  const r = q.enqueue('chat-a', {
    ...job('a', trace), fallback: () => { trace.push('fallback'); return 'raw' }
  }, { isCurrent: () => false })
  assert.equal((await r.done).status, 'cancelled')
  assert.deepEqual(trace, [])
})

test('033 queue：慢准备期间群睡/撤销，结果和fallback均不进入交付', async t => {
  const q = createContentQueue(), trace = [], gate = deferred()
  let current = true
  t.after(() => q.dispose())
  const r = q.enqueue('chat-a', {
    ...job('a', trace, gate), fallback: () => { trace.push('fallback'); return 'raw' }
  }, { isCurrent: () => current })
  await tick()
  current = false
  gate.resolve('late')
  assert.equal((await r.done).status, 'cancelled')
  assert.deepEqual(trace, ['prepare:a'])
})

test('033 queue：排队到期不准备，也不fallback交付', async t => {
  let now = 0
  const q = createContentQueue({ now: () => now }), trace = [], gate = deferred()
  t.after(() => q.dispose())
  const a = q.enqueue('chat-a', job('a', trace, gate))
  const b = q.enqueue('chat-a', {
    ...job('expired', trace), fallback: () => { trace.push('fallback'); return 'raw' }
  }, { expiresAt: 10 })
  await tick()
  now = 20
  gate.resolve('a')
  await a.done
  assert.equal((await b.done).status, 'expired')
  assert.equal(trace.some(line => line.includes('expired') || line === 'fallback'), false)
})

test('033 queue：准备后到期不能交付原结果或fallback', async t => {
  let now = 0
  const q = createContentQueue({ now: () => now }), trace = [], gate = deferred()
  t.after(() => q.dispose())
  const r = q.enqueue('chat-a', job('expired', trace, gate), { expiresAt: 10 })
  await tick()
  now = 10
  gate.resolve('late')
  assert.equal((await r.done).status, 'expired')
  assert.deepEqual(trace, ['prepare:expired'])
})

test('033 queue：prepare失败仍current时用安全fallback交付原话', async t => {
  const q = createContentQueue(), seen = []
  t.after(() => q.dispose())
  const r = q.enqueue('chat-a', {
    prepare: async () => { throw Error('synthetic-private-detail') },
    fallback: reason => { seen.push(reason); return { raw: '原话', unread: true } },
    deliver: value => { seen.push(value) }
  })
  const result = await r.done
  assert.equal(result.status, 'delivered')
  assert.equal(result.usedFallback, true)
  assert.deepEqual(seen, ['prepare-failed', { raw: '原话', unread: true }])
  assert.equal(JSON.stringify(result).includes('synthetic-private-detail'), false)
})

test('033 queue：fallback构造期间失去准入，仍不交付降级值', async t => {
  const q = createContentQueue()
  let current = true, delivered = false
  t.after(() => q.dispose())
  const r = q.enqueue('chat-a', {
    prepare: () => { throw Error('fake') },
    fallback: () => { current = false; return '原话' },
    deliver: () => { delivered = true }
  }, { isCurrent: () => current })
  assert.equal((await r.done).status, 'cancelled')
  assert.equal(delivered, false)
})

test('033 queue：prepare超时fallback一次，迟到成功不会二次交付', async t => {
  const timers = fakeTimers(), q = createContentQueue({ ...timers, taskTimeoutMs: 12 })
  const gate = deferred(), seen = []
  t.after(() => q.dispose())
  const r = q.enqueue('chat-a', {
    prepare: () => gate.promise,
    fallback: reason => { seen.push(reason); return '原话+未读' },
    deliver: value => { seen.push(value) }
  })
  await tick()
  timers.fire()
  const result = await r.done
  assert.equal(result.status, 'delivered')
  assert.equal(result.usedFallback, true)
  gate.resolve('too late')
  await tick()
  assert.deepEqual(seen, ['prepare-timeout', '原话+未读'])
  assert.equal(timers.size(), 0)
})

test('033 queue：prepare失败无fallback明确失败，后续同聊天继续', async t => {
  const q = createContentQueue(), trace = []
  t.after(() => q.dispose())
  const a = q.enqueue('chat-a', { prepare: () => { throw Error('fake') }, deliver: () => assert.fail('不得交付') })
  const b = q.enqueue('chat-a', job('b', trace))
  assert.equal((await a.done).status, 'prepare-failed')
  assert.equal((await b.done).status, 'delivered')
})

test('033 queue：fallback抛错和deliver抛错都不能卡住后续', async t => {
  const q = createContentQueue(), trace = []
  t.after(() => q.dispose())
  const a = q.enqueue('chat-a', { prepare: () => { throw Error('fake') }, fallback: () => { throw Error('fake') }, deliver: () => assert.fail('不得交付') })
  const b = q.enqueue('chat-a', { prepare: () => 'b', deliver: () => { throw Error('fake') } })
  const c = q.enqueue('chat-a', job('c', trace))
  assert.equal((await a.done).status, 'fallback-failed')
  assert.equal((await b.done).status, 'delivery-failed')
  assert.equal((await c.done).status, 'delivered')
})

test('033 queue：dispose取消各聊天、释放计时器，后续明确拒绝', async () => {
  const timers = fakeTimers(), q = createContentQueue(timers), trace = [], gate = deferred()
  const a = q.enqueue('chat-a', job('a', trace, gate))
  const b = q.enqueue('chat-b', job('b', trace, gate))
  await tick()
  q.dispose()
  gate.resolve('late')
  assert.equal((await a.done).status, 'cancelled')
  assert.equal((await b.done).status, 'cancelled')
  const r = q.enqueue('chat-c', job('c', trace))
  assert.equal(r.accepted, false)
  assert.equal(r.reason, 'disposed')
  assert.equal(timers.size(), 0)
  assert.equal(trace.some(line => line.startsWith('deliver:')), false)
})

test('033 queue：传入guard在invalidate后失效，abort信号可见', async t => {
  const q = createContentQueue(), gate = deferred()
  let guard = null
  t.after(() => q.dispose())
  const r = q.enqueue('chat-a', {
    prepare: ctx => { guard = ctx; return gate.promise },
    deliver: () => assert.fail('不得交付')
  })
  await tick()
  assert.equal(guard.isCurrent(), true)
  q.invalidate('chat-a')
  assert.equal(guard.isCurrent(), false)
  assert.equal(guard.signal.aborted, true)
  gate.resolve('late')
  await r.done
})

test('033 queue：isCurrent抛错按撤销处理，不泄漏异常', async t => {
  const q = createContentQueue(), trace = []
  t.after(() => q.dispose())
  const r = q.enqueue('chat-a', job('a', trace), { isCurrent: () => { throw Error('private fake detail') } })
  const result = await r.done
  assert.equal(result.status, 'cancelled')
  assert.deepEqual(trace, [])
  assert.equal(JSON.stringify(result).includes('private fake detail'), false)
})

test('033 queue：无效任务或key明确拒绝，不调用任何任务函数', async t => {
  const q = createContentQueue()
  t.after(() => q.dispose())
  for (const [key, task] of [['', {}], ['x', {}], ['x', { prepare () {} }], ['x', { deliver () {} }]]) {
    const r = q.enqueue(key, task)
    assert.equal(r.accepted, false)
    assert.equal((await r.done).status, 'rejected')
  }
})

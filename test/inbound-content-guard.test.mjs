import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createChannel, SERVICE_NAME } from '../lib/contract.js'

function channelOf (inject) {
  return createChannel({
    ctx: { get: name => name === SERVICE_NAME ? { inject } : undefined },
    settings: { inboundRetryTimes: 3, inboundRetryBaseMs: 1 }
  })
}

test('033：内容来源已撤销时一次主包调用也不发生', async () => {
  let calls = 0
  const channel = channelOf(async () => { calls++; return { ok: true } })
  const result = await channel.inject({ msgId: 'a' }, { isCurrent: () => false })
  assert.equal(calls, 0)
  assert.equal(result.reason, 'inbound-cancelled')
})

test('033：来源复核异常固定取消，不回显异常或继续注入', async () => {
  let calls = 0
  const channel = channelOf(async () => { calls++; return { ok: true } })
  const result = await channel.inject({ msgId: 'a' }, { isCurrent: () => { throw Error('private-synthetic') } })
  assert.equal(calls, 0)
  assert.equal(result.reason, 'inbound-cancelled')
  assert.equal(JSON.stringify(result).includes('private-synthetic'), false)
})

test('033：忙时等待中撤销来源，下一次重试不得注入旧读取结果', async () => {
  let current = true
  let calls = 0
  const channel = channelOf(async () => {
    calls++
    current = false
    return { ok: false, reason: 'agent-busy' }
  })
  const result = await channel.inject({ msgId: 'a', text: '真实原话' }, { isCurrent: () => current })
  assert.equal(calls, 1)
  assert.equal(result.reason, 'inbound-cancelled')
})

test('033：旧调用缺省来源guard，保留原有忙时重试', async () => {
  let calls = 0
  const channel = channelOf(async () => (++calls === 1 ? { ok: false, reason: 'agent-busy' } : { ok: true }))
  assert.equal((await channel.inject({ msgId: 'legacy' })).ok, true)
  assert.equal(calls, 2)
})

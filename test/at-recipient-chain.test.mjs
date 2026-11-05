/**
 * 032：真实数组/CQ归一化 → 信封 → 主包渲染。
 * 仅在127.0.0.1启动测试WS，由本进程客户端发送虚构事件；无真实QQ或模型。
 * 运行时必须 --import ../dsh-echo/tests/_isolate.mjs。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { createOneBot, normalizeSegment } from '../lib/onebot.js'
import { buildPrivateEnvelope } from '../lib/envelope.js'
import { decideGroupMessage } from '../lib/group-awake.js'
import { parseEnvelope, renderInboundText } from '../../dsh-memory-agent/lib/relay.js'

const SELF = '99'
const BODY = '你看这个'

async function freePort () {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  return port
}

function finishChain (event) {
  const built = buildPrivateEnvelope({ ...event, isMaster: false })
  assert.equal(built.ok, true)
  assert.equal(built.envelope.text, event.text)
  const parsed = parseEnvelope(built.envelope)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.text, event.text)
  return { raw: built.envelope, env: parsed.value, text: renderInboundText(parsed.value) }
}

test('032：数组与CQ实际路径，醒群继续旁听而接收对象不混淆', async t => {
  const received = []
  const port = await freePort()
  const server = createOneBot({
    host: '127.0.0.1', port, accessToken: 'test-032',
    onEvent: event => received.push(event), log: () => {}
  })
  t.after(() => server.stop())
  await server.start()
  const socket = new WebSocket('ws://127.0.0.1:' + port, {
    headers: { authorization: 'Bearer test-032' }
  })
  t.after(() => socket.close())
  await once(socket, 'open')

  const cases = [
    { name: 'other', ats: [{ qq: '22', name: '乙' }], expected: /本条没有@Echo/ },
    { name: 'self', ats: [{ qq: SELF }], expected: /本条明确@了Echo/ },
    { name: 'mixed', ats: [{ qq: SELF }, { qq: '22', name: '乙' }], expected: /本条明确@了Echo/ },
    { name: 'same-name', ats: [{ qq: '22', name: 'Echo' }], expected: /本条没有@Echo/ },
    { name: 'you-name', ats: [{ qq: '22', name: '你' }], expected: /本条没有@Echo/ },
    { name: 'no-name', ats: [{ qq: '22' }], expected: /本条没有@Echo/ },
    { name: 'all', ats: [{ qq: 'all' }], expected: /群体通知/, broadcast: true },
    { name: 'all-zero', ats: [{ qq: '0' }], expected: /群体通知/, broadcast: true },
    ...['all', '0'].map(qq => ({
      name: 'late-broadcast-' + qq,
      ats: [...Array.from({ length: 8 }, (_, i) => ({ qq: String(20 + i) })), { qq }],
      expected: /群体通知/, broadcast: true
    })),
    { name: 'invalid-target', ats: [{ qq: 'x' }], expected: /未确认/, unknown: true },
    { name: 'missing-target', ats: [{}], expected: /未确认/, unknown: true },
    { name: 'missing-self-id', ats: [{ qq: SELF }], selfId: undefined, expected: /未确认/, unknown: true },
    { name: 'literal-and-reply', ats: [], literal: true, expected: null }
  ]
  for (const mode of ['array', 'cq']) {
    for (const sample of cases) {
      await t.test(mode + ':' + sample.name, async () => {
        const id = mode + '-' + sample.name
        const message = mode === 'array'
          ? [
              ...sample.ats.map(data => ({ type: 'at', data })),
              ...(sample.literal ? [{ type: 'reply', data: { id: '88' } }] : []),
              { type: 'text', data: { text: sample.literal ? '@Echo ' + BODY : BODY } }
            ]
          : sample.ats.map(data => '[CQ:at' + Object.entries(data).map(([key, value]) => ',' + key + '=' + value).join('') + ']').join('')
            + (sample.literal ? '[CQ:reply,id=88]@Echo ' : '') + BODY
        const frame = {
          post_type: 'message', message_type: 'group',
          user_id: '11', group_id: '33', message_id: id,
          sender: { nickname: '甲' }, message
        }
        if (sample.name !== 'missing-self-id') frame.self_id = SELF
        socket.send(JSON.stringify(frame))
        const deadline = Date.now() + 2000
        while (!received.some(event => event.messageId === id) && Date.now() < deadline) await delay(5)
        const event = received.find(event => event.messageId === id)
        assert.ok(event, '测试WS事件必须到达')
        const { raw, env, text } = finishChain(event)
        const wake = decideGroupMessage({ awake: true, atMe: raw.atMe })
        assert.equal(wake.send, true, '已醒群继续旁听')
        assert.equal(wake.action, 'touch')
        const prefix = text.slice(0, text.indexOf('说:' + event.text))
        if (sample.expected) {
          assert.match(prefix, sample.expected)
          assert.equal(raw.atMeKnown, !sample.unknown)
          assert.equal(env.atMeKnown, raw.atMeKnown)
        } else {
          assert.equal('atMeKnown' in raw, false, '无@不新增元数据')
          assert.doesNotMatch(text, /本条明确@了Echo|本条没有@Echo|未确认/)
        }
        if (sample.unknown) assert.doesNotMatch(text, /本条没有@Echo|本条明确@了Echo|群体通知/)
        if (sample.broadcast) {
          assert.doesNotMatch(prefix, /本条没有@Echo|只@了其他/)
          assert.match(prefix, /没有单独@Echo/)
        }
        if (sample.name === 'all') assert.equal(raw.atOthers[0].qq, 'all')
        if (sample.name === 'missing-target') assert.equal(raw.atOthers[0].qq, 'NaN')
      })
    }
  }
})

test('032：直接归一化接口保留原text，缺自身ID的atMe=false不能作确定否定', () => {
  const segments = [normalizeSegment('at', { qq: SELF }), normalizeSegment('text', { text: BODY })]
  const { raw, text } = finishChain({
    userId: '11', userName: '甲', messageId: 'no-self',
    text: BODY, chatType: 'group', groupId: '33', segments
  })
  assert.equal(raw.atMe, false)
  assert.equal(raw.atMeKnown, false)
  assert.match(text, /未确认/)
  assert.doesNotMatch(text, /本条没有@Echo|本条明确@了Echo/)
})

test('032：无@与私聊信封不增加自身身份标志', () => {
  const base = { userId: '11', text: BODY, messageId: 'plain', selfId: SELF }
  for (const chatType of ['group', 'private']) {
    const built = buildPrivateEnvelope({ ...base, groupId: '33', chatType, segments: [] })
    assert.equal('atMeKnown' in built.envelope, false)
  }
  const privateAt = buildPrivateEnvelope({
    ...base, chatType: 'private', segments: [{ type: 'at', qq: Number(SELF) }]
  })
  assert.equal('atMeKnown' in privateAt.envelope, false)
  const first = Array.from({ length: 8 }, (_, i) => ({ type: 'at', qq: 20 + i }))
  const privateMany = buildPrivateEnvelope({
    ...base, chatType: 'private', segments: [...first, { type: 'at', qq: 'all' }]
  })
  assert.deepEqual(privateMany.envelope.atOthers.map(a => a.qq), first.map(a => String(a.qq)))
})

test('032：完整目标集合先判确定性，不能被8人显示上限遮掉未知目标', () => {
  const ats = Array.from({ length: 9 }, (_, i) => ({ type: 'at', qq: 20 + i }))
  const base = {
    userId: '11', userName: '甲', messageId: 'bounded-targets', selfId: SELF,
    text: BODY, chatType: 'group', groupId: '33'
  }
  const unknown = finishChain({ ...base, segments: [...ats, { type: 'at', qq: 'NaN' }] })
  assert.equal(unknown.raw.atOthers.length, 8)
  assert.equal(unknown.raw.atMeKnown, false)
  assert.match(unknown.text, /未确认/)
  assert.doesNotMatch(unknown.text, /本条没有@Echo/)
  const self = finishChain({ ...base, segments: [...ats, { type: 'at', qq: Number(SELF) }] })
  assert.equal(self.raw.atMe, true)
  assert.equal(self.raw.atMeKnown, true)
  assert.match(self.text, /本条明确@了Echo/)
})

test('032：直接嵌套at段缺目标，不把空值数值化为@全体', () => {
  const { raw, text } = finishChain({
    userId: '11', userName: '甲', messageId: 'nested-unknown', selfId: SELF,
    text: BODY, chatType: 'group', groupId: '33',
    segments: [{ type: 'at', data: { name: '你' } }]
  })
  assert.equal(raw.atMeKnown, false)
  assert.doesNotMatch(text, /群体通知|甲@了 全体成员|本条没有@Echo|本条明确@了Echo/)
})

test('032：直接嵌套已知目标混空at，过滤后不能冒充完整判定', () => {
  const { raw, text } = finishChain({
    userId: '11', userName: '甲', messageId: 'nested-mixed-unknown', selfId: SELF,
    text: BODY, chatType: 'group', groupId: '33',
    segments: [{ type: 'at', data: { qq: '22' } }, { type: 'at', data: {} }]
  })
  assert.equal(raw.atMeKnown, false)
  assert.match(text, /未确认/)
  assert.doesNotMatch(text, /本条没有@Echo/)
})

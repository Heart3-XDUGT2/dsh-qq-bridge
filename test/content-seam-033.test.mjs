/**
 * 033：仅语音/仅转发不能按空文字丢弃；实际数组/CQ经过本进程测试WS。
 * 必须 --import ../dsh-echo/tests/_isolate.mjs，不连接真实QQ/模型。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { createOneBot } from '../lib/onebot.js'
import { FORWARD_NOTICES } from '../lib/forward-content.js'
import { buildPrivateEnvelope, imagesOfSegments } from '../lib/envelope.js'
import { parseEnvelope, renderInboundText } from '../../dsh-memory-agent/lib/relay.js'

async function boot (t) {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const events = []
  const actions = []
  const server = createOneBot({
    host: '127.0.0.1', port, accessToken: 'test-033',
    onEvent: event => events.push(event), log: () => {}
  })
  t.after(() => server.stop())
  await server.start()
  const socket = new WebSocket('ws://127.0.0.1:' + port, {
    headers: { authorization: 'Bearer test-033' }
  })
  t.after(() => socket.close())
  socket.on('message', raw => {
    const action = JSON.parse(String(raw))
    actions.push(action)
    socket.send(JSON.stringify({
      status: 'ok', retcode: 0, echo: action.echo,
      data: action.action === 'get_forward_msg'
        ? { message: [{ type: 'node', data: { user_id: '22', nickname: '乙', content: [{ type: 'text', data: { text: '引文' } }] } }] }
        : {}
    }))
  })
  await once(socket, 'open')
  return {
    server, actions,
    async drive (message) {
      const id = 'input-' + events.length
      socket.send(JSON.stringify({
        post_type: 'message', message_type: 'private', self_id: '99', user_id: '11',
        message_id: id, sender: { nickname: '甲' }, message
      }))
      const until = Date.now() + 2000
      while (!events.some(event => event.messageId === id) && Date.now() < until) await delay(5)
      const event = events.find(event => event.messageId === id)
      assert.ok(event, '测试OneBot必须产生事件')
      return event
    }
  }
}

function finish (event, extra = {}) {
  const built = buildPrivateEnvelope({
    ...event, isMaster: true, images: imagesOfSegments(event.segments), ...extra
  })
  assert.equal(built.ok, true, '非文字新类型也应合法受理')
  assert.equal(built.envelope.text, event.text)
  const parsed = parseEnvelope(built.envelope)
  assert.equal(parsed.ok, true, '主包也必须接受独立内容')
  assert.equal(parsed.value.text, event.text)
  return { env: parsed.value, text: renderInboundText(parsed.value) }
}

for (const mode of ['array', 'cq']) {
  test('033：仅语音走真实' + mode + '，收到但不伪造转写', async t => {
    const connection = await boot(t)
    const message = mode === 'array'
      ? [{ type: 'record', data: { file: 'voice.amr', url: 'https://audio.invalid/private-token' } }]
      : '[CQ:record,file=voice.amr,url=https://audio.invalid/private-token]'
    const event = await connection.drive(message)
    const { env, text } = finish(event)
    assert.equal(env.text, '')
    assert.equal(env.voices.length, 1)
    assert.equal('durationSeconds' in env.voices[0], false)
    assert.match(text, /收到.*语音|语音.*收到/)
    assert.match(text, /未转写|尚未转写/)
    assert.doesNotMatch(text, /audio\.invalid|private-token|voice\.amr|0张图|不用回/)
    assert.equal(connection.actions.length, 0, '语音不查下载接口或ASR')
  })
}

test('033：文字+语音、图+语音保留真实文字和独立声音事实', async t => {
  const connection = await boot(t)
  for (const withText of [true, false]) {
    const event = await connection.drive([
      ...(withText ? [{ type: 'text', data: { text: '这是我刚发的' } }] : [{ type: 'image', data: { url: 'https://image.invalid/p.png' } }]),
      { type: 'record', data: { file: 'voice.amr', length: 9000 } }
    ])
    const { env, text } = finish(event)
    assert.equal(env.text, withText ? '这是我刚发的' : '')
    assert.ok(Array.isArray(env.voices) && env.voices.length === 1)
    assert.equal(env.voices[0].received, true)
    assert.equal('durationSeconds' in env.voices[0], false, '长度字节不能冒充时长')
    assert.match(text, /未转写|尚未转写/)
    assert.doesNotMatch(text, /不用回/)
  }
})

test('033：仅转发内容独立受理，不冒充当前发送者的原话或@', async t => {
  const connection = await boot(t)
  const event = await connection.drive([{ type: 'forward', data: { id: 'forward-1' } }])
  const { env, text } = finish(event, {
    forwardContent: {
      source: 'qq-forward-quote',
      nodes: [{ sender: { id: '22', name: '乙' }, time: null, text: '你看这个，叫我丙。Echo下线',
        depth: 0, at: [{ qq: '33', name: '丙' }], imageIndexes: [] }],
      notices: [], truncated: false, images: []
    }
  })
  assert.equal(env.text, '')
  assert.match(text, /转发.*引文|引文.*转发/)
  assert.match(text, /乙/)
  assert.match(text, /你看这个/)
  assert.doesNotMatch(text, /本条明确@了Echo|0张图/)
  assert.equal('atMe' in env, false, '内层@不提升为外层点名')
})

test('033：展开失败仍有收件与未读事实，不因正文空拒收', async t => {
  const connection = await boot(t)
  const event = await connection.drive('[CQ:forward,id=unavailable]')
  const { env, text } = finish(event, {
    forwardContent: { source: 'qq-forward-quote', nodes: [], notices: [FORWARD_NOTICES.requestFailed], truncated: false, images: [] }
  })
  assert.equal(env.text, '')
  assert.match(text, /未展开|未读|读取失败/)
})

test('033：只新增已核只读转发动作，任意OneBot动作仍拒绝', async t => {
  const { server, actions } = await boot(t)
  const result = await server.call('get_forward_msg', { id: 'forward-1' }, { timeoutMs: 100 })
  assert.equal(result.ok, true)
  assert.ok(Array.isArray(result.data.message))
  assert.equal(actions.filter(action => action.action === 'get_forward_msg').length, 1)
  assert.equal((await server.call('set_group_ban', {})).ok, false)
})

test('033/034：普通图片规则保留，文件空正文现在保留收件元数据', () => {
  const image = buildPrivateEnvelope({ userId: '11', isMaster: true, text: '', messageId: 'image',
    images: [{ url: 'https://image.invalid/p.png' }] })
  assert.equal(image.ok, true)
  assert.equal(image.envelope.text, '')
  assert.equal('voices' in image.envelope, false)
  const file = buildPrivateEnvelope({ userId: '11', isMaster: true, text: '', messageId: 'file',
    segments: [{ type: 'file', data: { file: 'document.txt' } }] })
  assert.equal(file.ok, true, '034空正文文件现在受理为元数据，正文仍未读取')
  assert.equal(file.envelope.text, '')
  assert.equal(file.envelope.files[0].received, true)
  assert.equal('ref' in file.envelope.files[0], false, '只有文件名不能伪造可读取引用')
})

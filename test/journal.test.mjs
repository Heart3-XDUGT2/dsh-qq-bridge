/**
 * 入站流水账(lib/journal.js)—— 2026-09-29。
 *
 * 现场:他在 QQ 发了一张图,界面**什么都没发生**。那一刻有两种死法都看不见:
 * 适配器在门口拒了(旧版"没有正文不许进"),或信出门了主包没接。
 * 这本账把每一步写进 `<dataDir>/inbound.jsonl`,排查从"翻宿主日志"变成"看一个文件"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendInbound, inboundEntry, readInbound, JOURNAL_FILE, JOURNAL_MAX_LINES } from '../lib/journal.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'echoqq-journal-'))

test('账本:一条记录只留长度与前 40 字(正文不整段落盘)', () => {
  const e = inboundEntry({ ok: false, stage: 'envelope', reason: 'text 不能为空(除非他发的是图)', userId: '3783', msgId: 'm-1', text: 'あ'.repeat(80), images: [1, 2] })
  assert.equal(e.ok, false)
  assert.equal(e.stage, 'envelope')
  assert.equal(e.textLen, 80)
  assert.equal(e.text.length, 40, '正文只留预览')
  assert.equal(e.images, 2)
  assert.ok(e.at > 0)
})

test('账本:写进文件 + 读得回来(新的在后)', () => {
  const dir = tmp()
  try {
    assert.equal(appendInbound(dir, inboundEntry({ ok: true, stage: 'sent', userId: 'u', msgId: 'a', text: '在吗', images: [1] })), true)
    assert.equal(appendInbound(dir, inboundEntry({ ok: false, stage: 'gate', reason: '不在白名单', userId: 'x' })), true)
    const rows = readInbound(dir, 10)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].msgId, 'a')
    assert.equal(rows[1].stage, 'gate')
    assert.ok(readFileSync(join(dir, JOURNAL_FILE), 'utf8').endsWith('\n'), '一行一条,行尾要有换行')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('账本:超上限留尾部(不无限长)', () => {
  const dir = tmp()
  try {
    for (let i = 0; i < JOURNAL_MAX_LINES + 25; i += 1) {
      appendInbound(dir, inboundEntry({ ok: true, stage: 'sent', msgId: 'm' + i }))
    }
    const lines = readFileSync(join(dir, JOURNAL_FILE), 'utf8').split('\n').filter((l) => l.trim() !== '')
    assert.equal(lines.length, JOURNAL_MAX_LINES)
    const rows = readInbound(dir, 5)
    assert.equal(rows[rows.length - 1].msgId, 'm' + (JOURNAL_MAX_LINES + 24), '留下的必须是最近的')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('账本:自己坏了也不炸(坏行跳过 / 目录不存在回空 / 写不进去回 false)', () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, JOURNAL_FILE), '{"ok":true}\n这不是 JSON\n\n{"ok":false,"stage":"gate"}\n', 'utf8')
    const rows = readInbound(dir, 10)
    assert.equal(rows.length, 2, '坏行跳过,好的照读')
    assert.equal(rows[1].stage, 'gate')
    assert.deepEqual(readInbound(join(dir, '不存在的目录'), 5), [])
    assert.equal(appendInbound('', inboundEntry({ ok: true })), false, '空路径不写(回 false,不抛)')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

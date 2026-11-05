/**
 * dsh-echo-qq — 入站流水账(2026-09-29)
 * ============================================================
 * 为什么有这本账:他发了一张图,界面上**什么都没发生** —— 而那一刻"什么都没发生"
 * 有两种完全不同的死法,谁都看不出来:
 *   · 适配器在门口就拒了(比如旧版"没有正文不许进"⇒ 只发图的那条根本不出门);
 *   · 信出门了,主包那边没接(有 `relay_in` 审计可查,那是主包的地盘)。
 * 前一种在旧版里**只有宿主日志里一行 info** —— 排查要翻进程输出,等于看不见。
 * 这本账把两种都写进一个磁盘文件,谁都查得:`<dataDir>/inbound.jsonl`。
 *
 * 纪律:写账**永远不抛**(记不上账不该影响传话);只记事实,不记正文全文
 * (正文有隐私,只记长度与前 40 字 —— 够认出是哪一条就行)。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 账本文件名(放适配器的数据目录:`~/.dsh/echo-qq/inbound.jsonl`)。 */
export const JOURNAL_FILE = 'inbound.jsonl'

/** 留多少行:按行滚,超了就留尾部(够回看一晚上的排查)。 */
export const JOURNAL_MAX_LINES = 500

/** 正文预览长度(隐私与可辨认的折中)。 */
const PREVIEW = 40

/** 一条入站记录(纯函数:事件 + 结果 + 判决 → 账本要的一行)。 */
export function inboundEntry ({ at = Date.now(), ok, reason = '', stage = 'message', userId = '', msgId = '', text = '', images = [] } = {}) {
  const body = String(text ?? '')
  return {
    at: Number(at) || Date.now(),
    ok: ok === true,
    // stage:message | sent | gate | envelope | core-refused | core-error —— 死在门口哪一道,一眼看出来
    stage: String(stage || 'message'),
    reason: String(reason || ''),
    userId: String(userId || ''),
    msgId: String(msgId || ''),
    textLen: body.length,
    text: body.slice(0, PREVIEW),
    images: Array.isArray(images) ? images.length : 0
  }
}

/**
 * 追加一条(尽力而为,永不抛)。
 * @param {string} dir 数据目录(dataDirOf())
 * @param {object} entry inboundEntry() 的产物
 */
export function appendInbound (dir, entry) {
  try {
    if (typeof dir !== 'string' || dir === '') return false
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = join(dir, JOURNAL_FILE)
    appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8')
    // 滚动:超上限就留尾部(整文件重写,500 行量级 —— 不值得为它上流式)
    try {
      const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '')
      if (lines.length > JOURNAL_MAX_LINES) {
        writeFileSync(file, lines.slice(-JOURNAL_MAX_LINES).join('\n') + '\n', 'utf8')
      }
    } catch { /* 滚动失败不影响这一条已经写进去 */ }
    return true
  } catch { return false }
}

/** 读最近 N 条(新的在后);账本不在/坏了都回空数组(排查工具不许自己炸)。 */
export function readInbound (dir, limit = 20) {
  try {
    const file = join(String(dir), JOURNAL_FILE)
    if (!existsSync(file)) return []
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '')
    const tail = lines.slice(-Math.max(1, Number(limit) || 20))
    const out = []
    for (const line of tail) {
      try { out.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
    }
    return out
  } catch { return [] }
}

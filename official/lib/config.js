import { createHash } from 'node:crypto'
import { isAbsolute, parse, resolve } from 'node:path'

export const PLATFORM = 'qq-official'
export const SERVICE = 'echo:relay'
export const WINDOW_MS = 300000
export const MAX_REPLY = 4
export const digest = (...v) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
export function identity (appId, openid) { return 'official:c2c:' + digest(appId, 'c2c', openid) }
export function inboundKey (appId, msgId, index = '') { return digest(appId, 'c2c', msgId, index) }
export const STATES = Object.freeze({
  disabled: '官方私聊渠道未启用', credentials: '尚未配置机器人凭据', binding: '尚未明确绑定主人',
  storage: '需要独立的本地投递记录目录', service: '等待 Echo 服务',
  connecting: '正在连接官方私聊渠道', inbound_only: '可接收主人私聊；Echo 尚未提供可靠回复关联，发送关闭',
  ready: '主人私聊渠道已连接', stopped: '渠道已停止', error: '渠道连接中断，请检查本机配置',
  context: '缺少可靠的原消息与完整回复关联，未发送', rejected: '对方拒收或关系不可用，已停止此消息',
  unknown: '发送结果未确认，已暂停，未自动重发', expired: '回复已超过保守的五分钟窗口',
  rate_limited: '发送受到频率限制，等待后再尝试', token: '凭据失效，此消息暂停等待检查',
  delivered: '已确认发送并完成回执', ack_pending: '发送已确认，等待 Echo 回执', budget: '回复超过本次允许的次数或文本长度',
  invalid: '收到不支持或无效的消息', owner: '非已绑定主人消息，已忽略', duplicate: '重复事件已忽略',
  storage_error: '本地投递记录不可用，已停止发送', busy: '上一操作仍在处理中',
  storage_busy: '无法取得写入独占，可能有其它实例，未启动第二个写入方',
  storage_legacy: '旧版写入锁需一次人工审核，未自动恢复',
  storage_unsupported: '此系统或路径无法确认本机安全独占，未启动官方私聊',
  storage_recovery: '投递记录恢复检查未通过，已保留现场，请检查'
})
export function normalizeConfig (raw = {}) {
  const config = {
    enabled: raw.enabled === true,
    appId: typeof raw.appId === 'string' ? raw.appId.trim() : '',
    appSecret: typeof raw.appSecret === 'string' ? raw.appSecret : '',
    stateDir: typeof raw.stateDir === 'string' ? raw.stateDir : '',
    ownerBinding: raw.ownerBinding && typeof raw.ownerBinding === 'object' ? { ...raw.ownerBinding } : null
  }
  if (!config.enabled) return { config, reason: 'disabled' }
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(config.appId) || !config.appSecret) return { config, reason: 'credentials' }
  const b = config.ownerBinding
  if (!b || b.authorized !== true || b.appId !== config.appId || typeof b.userOpenid !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(b.userOpenid) || /^\d+$/.test(b.userOpenid)) return { config, reason: 'binding' }
  if (!isAbsolute(config.stateDir) || resolve(config.stateDir) === parse(resolve(config.stateDir)).root) return { config, reason: 'storage' }
  return { config, reason: '' }
}
export function basicService (s) { return !!s && ['inject', 'registerChannel'].every(k => typeof s[k] === 'function') }
export function replyService (s) {
  const c = s?.officialC2c
  return c?.version === 1 && c.contract === 'complete-turn-v1' && ['leaseReplies', 'ackReplies'].every(k => typeof c[k] === 'function') ? c : null
}

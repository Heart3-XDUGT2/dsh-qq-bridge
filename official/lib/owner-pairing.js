import { randomBytes, createHash } from 'node:crypto'
import { createTransport } from './transport.js'
import { readFileSync, existsSync, lstatSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs'
import { isAbsolute, resolve, dirname } from 'node:path'

const realClock = { now: Date.now, setTimeout, clearTimeout }
function appIdOf (value) {
  if (typeof value !== 'string') throw Error('pairing_credentials')
  const result = value.trim()
  if (!result || result.length > 80 || /[^A-Za-z0-9_-]/.test(result)) throw Error('pairing_credentials')
  return result
}
const validOwner = value => typeof value === 'string' && value.length >= 8 && value.length <= 128 &&
  !/[^A-Za-z0-9_-]/.test(value) && !/^\d+$/.test(value)

/** Explicitly created, one-shot local pairing session; never a normal plugin. */
export function createOwnerPairing ({ appId, clock = realClock, ttlMs = 120000 } = {}) {
  appId = appIdOf(appId)
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000) throw Error('pairing_expiry')
  const startedAtMs = clock.now(), expiresAtMs = startedAtMs + ttlMs
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0 || !Number.isSafeInteger(expiresAtMs)) throw Error('pairing_expiry')
  const challenge = 'ECHO-PAIR:' + randomBytes(32).toString('base64url')
  let phase = 'waiting', candidate = null, fingerprint = null
  const fresh = () => Number.isSafeInteger(clock.now()) && clock.now() < expiresAtMs
  return Object.freeze({
    challenge: () => ({ text: challenge, expiresAtMs }),
    status: () => ({ phase: fresh() ? phase : 'expired', fingerprint, expiresAtMs }),
    offer ({ appId: receivedAppId, event } = {}) {
      if (!fresh() || !['waiting', 'candidate'].includes(phase) || receivedAppId !== appId ||
        event?.t !== 'C2C_MESSAGE_CREATE' || event.d?.author?.bot === true ||
        event.d?.content !== challenge || !validOwner(event.d?.author?.user_openid)) return { candidate: false }
      const owner = event.d.author.user_openid
      if (candidate && candidate !== owner) { phase = 'conflict'; return { candidate: false, conflict: true } }
      candidate = owner
      fingerprint = createHash('sha256').update(JSON.stringify(['owner-pairing-v1', appId, owner])).digest('hex').slice(0, 12)
      phase = 'candidate'
      return { candidate: true, fingerprint, expiresAtMs }
    },
    confirm (answer) {
      if (!fresh() || phase !== 'candidate' || answer !== 'CONFIRM ' + fingerprint) throw Error('pairing_local_confirmation_required')
      phase = 'consumed'
      return { appId, userOpenid: candidate, authorized: true, authorizationMethod: 'local-nonce-confirmed' }
    },
    cancel () { phase = 'canceled'; candidate = null }
  })
}

/** Only invoked by an explicit CLI command or a temporary loopback test. */
export async function runOwnerSetup ({ configPath, outputPath, ask, print = () => {}, clock = realClock, transportFactory = createTransport, ttlMs = 120000 } = {}) {
  if (!isAbsolute(configPath ?? '') || !isAbsolute(outputPath ?? '') || typeof ask !== 'function' || existsSync(outputPath)) throw Error('pairing_paths')
  for (const path of [configPath, dirname(outputPath)]) {
    for (let p = resolve(path); ; p = dirname(p)) {
      if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw Error('pairing_paths')
      if (dirname(p) === p) break
    }
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8')), appId = appIdOf(config.appId)
  if (typeof config.appSecret !== 'string' || !config.appSecret) throw Error('pairing_credentials')
  const pairing = createOwnerPairing({ appId, clock, ttlMs })
  let accept, reject, expire, timer, transport
  const candidate = new Promise((yes, no) => { accept = yes; reject = no })
  const expiry = new Promise((_yes, no) => { expire = no })
  // Install rejection handling before slow startup to avoid an unhandled TTL.
  candidate.catch(() => {}); expiry.catch(() => {})
  timer = clock.setTimeout(() => {
    pairing.cancel()
    try { transport?.stop() } catch {}
    reject(Error('pairing_expired')); expire(Error('pairing_expired'))
  }, ttlMs)
  try {
    transport = transportFactory({
    appId, appSecret: config.appSecret, clock,
    onEvent: async event => {
      const offered = pairing.offer({ appId, event })
      if (offered.candidate) accept(offered)
      if (offered.conflict) reject(Error('pairing_conflict'))
      return true
    },
    onState: state => { if (['token', 'error'].includes(state)) reject(Error('pairing_connection')) }
    })
    print('仅配对模式：不接 Echo、不调用模型、不发送应用回复。')
    print('请由你本人私聊此机器人，发送以下一次性文字（短时有效）：')
    print(pairing.challenge().text)
    if ((await Promise.race([transport.start(), expiry])) === false) throw Error('pairing_connection')
    const offered = await candidate
    const answer = await Promise.race([ask('收到配对候选。确认刚才是你本人发送后，在本机输入 CONFIRM ' + offered.fingerprint + '：'), expiry])
    const ownerBinding = pairing.confirm(answer)
    const out = openSync(outputPath, 'wx', 0o600)
    try { writeFileSync(out, JSON.stringify({ ownerBinding }, null, 2) + '\n'); fsyncSync(out) } finally { closeSync(out) }
    print('本机主人授权草稿已保存；机器人尚未启用。')
    return { ok: true, fingerprint: offered.fingerprint, enabled: false }
  } finally {
    clock.clearTimeout(timer); pairing.cancel()
    try { transport.stop() } catch {}
  }
}

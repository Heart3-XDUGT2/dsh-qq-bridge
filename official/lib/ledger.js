import { mkdirSync, existsSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, lstatSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { digest } from './config.js'

// One writer only. A crash leaves the lock in place: operator review is required;
// never infer that a process is dead, remove its lock, or replay an uncertain send.
export function openLedger (directory, namespace) {
  if (!isAbsolute(directory)) throw Error('storage')
  const dir = resolve(directory)
  const marker = join(dir, '.echo-official-owner')
  const lock = join(dir, '.writer-lock')
  const file = join(dir, 'delivery.json')
  const temp = join(dir, 'delivery.pending')
  const fresh = !existsSync(dir)
  if (fresh) mkdirSync(dir, { mode: 0o700 })
  if (lstatSync(dir).isSymbolicLink()) throw Error('storage')
  if (fresh) writeFileSync(marker, 'echo-official-v1\n', { flag: 'wx', mode: 0o600 })
  if (!existsSync(marker) || lstatSync(marker).isSymbolicLink() || readFileSync(marker, 'utf8') !== 'echo-official-v1\n') throw Error('storage')
  const lockFd = openSync(lock, 'wx', 0o600)
  let closed = false
  let data
  const release = () => { if (!closed) { closed = true; closeSync(lockFd); unlinkSync(lock) } }
  function persist (next) {
    if (closed) throw Error('storage_closed')
    if (existsSync(temp)) throw Error('storage_pending')
    const body = JSON.stringify(next)
    if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw Error('storage_full')
    const fd = openSync(temp, 'wx', 0o600)
    try { writeFileSync(fd, body); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temp, file)
    // File is flushed. Directory fsync is platform-dependent: do not promise
    // atomic power-loss recovery on every filesystem (especially Windows).
    data = next
  }
  try {
    if (existsSync(file)) {
      if (lstatSync(file).isSymbolicLink() || lstatSync(file).size > 8 * 1024 * 1024) throw Error('storage')
      data = JSON.parse(readFileSync(file, 'utf8'))
      if (data.version !== 1 || data.namespace !== namespace || !data.inbound || !data.plans || !data.rows || Array.isArray(data.inbound) || Array.isArray(data.plans)) throw Error('storage_identity')
      // A clean restart may encounter a persisted pre-send boundary. A sending
      // record is uncertain regardless of whether the HTTP request was made.
      for (const p of Object.values(data.plans)) {
        for (const part of p.parts ?? []) if (part.state === 'sending') part.state = 'unknown'
      }
    } else data = { version: 1, namespace, inbound: {}, plans: {}, rows: {}, budgets: {} }
    data.budgets ??= {}
    data.sendHistory ??= []
    data.replyAt ??= {}
    persist(structuredClone(data))
  } catch { release(); throw Error('storage') }
  return {
    snapshot: () => structuredClone(data),
    change (fn) {
      const next = structuredClone(data)
      const result = fn(next)
      persist(next)
      return result
    },
    close: release,
    // No auto-expiry/drop: a full journal requires operator review; evicting
    // idempotency records would make old deliveries eligible again.
    remember (entry) {
      return this.change(d => {
        if (d.inbound[entry.key]) return false
        if (Object.keys(d.inbound).length >= 2048) throw Error('storage_full')
        d.inbound[entry.key] = { ...entry, accepted: false, used: 0 }
        d.replyAt[entry.replyKey] = Math.min(d.replyAt[entry.replyKey] ?? entry.receivedAt, entry.receivedAt)
        return true
      })
    }
  }
}
export const ledgerNamespace = c => digest(c.appId, 'c2c', c.ownerBinding.userOpenid)

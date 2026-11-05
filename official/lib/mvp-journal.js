import { mkdirSync, existsSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, lstatSync } from 'node:fs'
import { resolve, join, isAbsolute, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const MARKER = 'echo-owner-text-mvp-1\n'
const contract = 'owner-text-mvp-1'
const clone = value => structuredClone(value)
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const hashKey = (value, prefix) => typeof value === 'string' && value.length === prefix.length + 64 && value.startsWith(prefix) && !/[^0-9a-f]/.test(value.slice(prefix.length))
const millis = value => Number.isSafeInteger(value) && value >= 0
export function mvpEntryExists (path) {
  try { lstatSync(path); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}
function safeTree (path) {
  for (let p = resolve(path); ; p = dirname(p)) {
    if (mvpEntryExists(p) && lstatSync(p).isSymbolicLink()) throw Error('storage_path')
    if (dirname(p) === p) return
  }
}

function regularFile (file, maxBytes = Infinity) {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) throw Error('storage_format')
}
function readStoredJournal (dir, scope, maxBytes, maxInputs) {
  const file = join(dir, 'owner-text.json')
  let data
  regularFile(file, maxBytes)
  data = JSON.parse(readFileSync(file, 'utf8'))
  if (data.contract !== contract || data.version !== 1 || data.keyScheme !== scope.keyScheme ||
    data.appId !== scope.appId || data.ownerHash !== scope.ownerHash || data.scopeKey !== scope.scopeKey ||
    !['inputs', 'anchors', 'metadata'].every(k => object(data[k])) || !Array.isArray(data.dispatchHistory)) throw Error('storage_identity')
  for (const [key, input] of Object.entries(data.inputs)) {
    if (!hashKey(key, 'in2_') || !object(input) || input.inboundKey !== key || input.scopeKey !== scope.scopeKey ||
      !hashKey(input.replyAnchorKey, 'ra2_') || typeof input.text !== 'string' || !input.text.isWellFormed() ||
      typeof input.rawMsgId !== 'string' || !input.rawMsgId || !input.rawMsgId.isWellFormed()) throw Error('storage_format')
  }
  for (const [key, anchor] of Object.entries(data.anchors)) {
    if (!hashKey(key, 'ra2_') || !object(anchor) || !hashKey(anchor.firstInboundKey, 'in2_') ||
      !millis(anchor.firstAtMs) || !millis(anchor.deadlineMs) || anchor.deadlineMs !== anchor.firstAtMs + 300000 ||
      typeof anchor.rawMsgId !== 'string' || !anchor.rawMsgId || !Array.isArray(anchor.attempts) || anchor.attempts.length > 3 ||
      !['seen', 'claimed', 'sending', 'rate_limited', 'confirmed', 'unknown', 'rejected', 'expired', 'abandoned'].includes(anchor.state) ||
      anchor.attempts.some((a, i) => !object(a) || a.ordinal !== i + 1 || a.msgSeq !== 1 || !millis(a.dispatchedAtMs) ||
        !['sending', 'rate_limited', 'confirmed', 'unknown', 'rejected', 'expired'].includes(a.state))) throw Error('storage_format')
  }
  for (const [key, record] of Object.entries(data.metadata)) {
    if (!hashKey(key, 'in2_') || !object(record) || record.inboundKey !== key || record.scopeKey !== scope.scopeKey) throw Error('storage_format')
  }
  if (data.dispatchHistory.some(t => !millis(t)) || data.dispatchHistory.length > maxInputs * 3 ||
    (data.pendingClaim !== null && (!object(data.pendingClaim) || typeof data.pendingClaim.key !== 'string' || !data.pendingClaim.key))) throw Error('storage_format')
  if (['inputs', 'metadata', 'anchors'].some(k => Object.keys(data[k]).length > maxInputs)) throw Error('storage_full')
  return data
}
/** Read-only validation used before managed recovery changes any old file. */
export function inspectMvpJournal (directory, scope, { maxBytes = 8 * 1024 * 1024, maxInputs = 2048 } = {}) {
  const dir = resolve(directory)
  safeTree(dir)
  regularFile(join(dir, '.echo-owner-text-mvp'), 128)
  if (readFileSync(join(dir, '.echo-owner-text-mvp'), 'utf8') !== MARKER ||
    mvpEntryExists(join(dir, '.echo-official-owner')) || mvpEntryExists(join(dir, 'owner-text.pending'))) throw Error('storage_format')
  return readStoredJournal(dir, scope, maxBytes, maxInputs)
}

/** One explicit new directory. A crash/fault lock is never automatically removed. */
export function openMvpJournal (directory, scope, { maxBytes = 8 * 1024 * 1024, maxInputs = 2048, now = Date.now, managedLockRecord } = {}) {
  if (!isAbsolute(directory) || resolve(directory) === dirname(resolve(directory)) ||
    !hashKey(scope?.scopeKey, 'sc2_') || !hashKey(scope?.ownerHash, 'oh2_') ||
    typeof scope?.appId !== 'string' || !scope.appId || scope.keyScheme !== 'eqqc2c-lp32-v2' ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 512 || !Number.isSafeInteger(maxInputs) || maxInputs < 1 || maxInputs > 2048) throw Error('storage_identity')
  const dir = resolve(directory)
  safeTree(dir)
  const marker = join(dir, '.echo-owner-text-mvp'), lock = join(dir, '.writer-lock')
  const file = join(dir, 'owner-text.json'), pending = join(dir, 'owner-text.pending')
  const fresh = !mvpEntryExists(dir)
  if (fresh) {
    mkdirSync(dir, { mode: 0o700 })
    const fd = openSync(marker, 'wx', 0o600)
    try { writeFileSync(fd, MARKER); fsyncSync(fd) } finally { closeSync(fd) }
  }
  if (!mvpEntryExists(marker) || lstatSync(marker).isSymbolicLink() || readFileSync(marker, 'utf8') !== MARKER ||
    mvpEntryExists(join(dir, '.echo-official-owner')) || mvpEntryExists(pending)) throw Error('storage_format')
  const fd = openSync(lock, 'wx', 0o600)
  let closed = false, failed = false, operations = 0, directoryFlushed = false
  let serial = Promise.resolve(), data
  const bootId = randomUUID()
  function persist (next) {
    if (closed || failed) throw Error('storage_unavailable')
    try {
      const text = JSON.stringify(next)
      if (Buffer.byteLength(text) > maxBytes || Object.keys(next.inputs).length > maxInputs ||
        Object.keys(next.metadata).length > maxInputs || Object.keys(next.anchors).length > maxInputs) throw Error('storage_full')
      if (mvpEntryExists(pending)) throw Error('storage_pending')
      const out = openSync(pending, 'wx', 0o600)
      try { writeFileSync(out, text); fsyncSync(out) } finally { closeSync(out) }
      renameSync(pending, file)
      let dirFd
      try {
        dirFd = openSync(dir, 'r'); fsyncSync(dirFd); directoryFlushed = true
      } catch (error) {
        if (!['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP', 'EACCES'].includes(error.code)) throw error
        directoryFlushed = false
      } finally { if (dirFd !== undefined) closeSync(dirFd) }
      data = next
    } catch { failed = true; throw Error('storage_unavailable') }
  }
  try {
    if (managedLockRecord) {
      const record = managedLockRecord(dir)
      writeFileSync(fd, JSON.stringify(record) + '\n')
      fsyncSync(fd)
    }
    if (mvpEntryExists(file)) {
      data = readStoredJournal(dir, scope, maxBytes, maxInputs)
      // No replay of any earlier boot's draft or sending boundary.
      for (const anchor of Object.values(data.anchors)) {
        if (anchor.state === 'sending') anchor.state = 'unknown'
        else if (!['confirmed', 'unknown', 'rejected', 'expired', 'abandoned'].includes(anchor.state)) anchor.state = 'abandoned'
        anchor.coreSettled = false
      }
      for (const record of Object.values(data.metadata)) {
        if (!record.everAccepted) { record.admissionState = 'unknown'; record.processingState = 'unknown' }
        else if (['not_started', 'queued_volatile', 'publishing', 'host_enqueued', 'claimed', 'entered'].includes(record.processingState)) record.processingState = 'lost_on_restart'
      }
      data.pendingClaim = null
    } else data = {
      version: 1, contract, keyScheme: scope.keyScheme, appId: scope.appId, ownerHash: scope.ownerHash, scopeKey: scope.scopeKey,
      inputs: {}, anchors: {}, metadata: {}, dispatchHistory: [], pendingClaim: null
    }
    data.bootId = bootId
    data.openedAtMs = now()
    if (!millis(data.openedAtMs)) throw Error('storage_clock')
    persist(clone(data))
  } catch {
    failed = true
    closeSync(fd) // lock remains for deliberate operator review
    throw Error('storage_unavailable')
  }
  function change (reducer) {
    if (closed || failed) throw Error('storage_unavailable')
    const next = clone(data), result = reducer(next)
    if (result && typeof result.then === 'function') throw Error('async_journal_reducer')
    persist(next)
    return clone(result)
  }
  function enqueue (fn) {
    operations++
    const promise = serial.then(() => { if (closed || failed) throw Error('storage_unavailable'); return fn() })
    serial = promise.catch(() => {})
    return promise.finally(() => { operations-- })
  }
  function metadataRef (ref) {
    if (ref?.scopeKey !== scope.scopeKey || !hashKey(ref.inboundKey, 'in2_')) throw Error('metadata_scope_conflict')
    return ref.inboundKey
  }
  const metadataStore = Object.freeze({
    contract: 'official-input-metadata-v1', durability: 'durable-metadata',
    transaction (ref, reducer) {
      return enqueue(() => {
        const key = metadataRef(ref)
        return change(next => {
          const previous = next.metadata[key]
          const result = reducer(previous ? clone(previous) : null)
          if (!object(result) || typeof result.then === 'function' || !Object.hasOwn(result, 'next')) throw Error('metadata_reducer')
          const record = result.next
          if (record == null) {
            if (previous) throw Error('metadata_delete_forbidden')
          } else {
            if (!object(record) || record.scopeKey !== scope.scopeKey || record.inboundKey !== key ||
              (previous && ['inputDigest', 'replyAnchorKey', 'requestKey', 'sourceKey', 'attemptKey'].some(k => previous[k] !== record[k]))) throw Error('metadata_conflict')
            next.metadata[key] = clone(record)
          }
          return result.value
        })
      })
    },
    read (ref) { return enqueue(() => clone(data.metadata[metadataRef(ref)] ?? null)) }
  })
  return Object.freeze({
    metadataStore, change, snapshot: () => clone(data),
    status: () => ({ healthy: !failed && !closed, closed, failed, pendingOperations: operations, directoryFlushed }),
    rememberInput (entry) {
      if (entry.scopeKey !== scope.scopeKey || !hashKey(entry.inboundKey, 'in2_') || !hashKey(entry.replyAnchorKey, 'ra2_') ||
        !millis(entry.firstAtMs) || !millis(entry.deadlineMs) || typeof entry.rawMsgId !== 'string' || !entry.rawMsgId ||
        typeof entry.text !== 'string' || !entry.text.isWellFormed()) throw Error('input_identity')
      return change(next => {
        const previous = next.inputs[entry.inboundKey], anchor = next.anchors[entry.replyAnchorKey]
        if (previous && ['scopeKey', 'replyAnchorKey', 'rawMsgId', 'text'].some(k => previous[k] !== entry[k])) throw Error('input_conflict')
        if (anchor && anchor.rawMsgId !== entry.rawMsgId) throw Error('input_conflict')
        if (!previous) next.inputs[entry.inboundKey] = { ...entry, accepted: false, admissionState: 'seen' }
        if (!anchor) next.anchors[entry.replyAnchorKey] = {
          rawMsgId: entry.rawMsgId, firstInboundKey: entry.inboundKey, firstAtMs: entry.firstAtMs,
          deadlineMs: entry.deadlineMs, state: 'seen', attempts: [], coreSettled: false, bootId
        }
        else { anchor.firstAtMs = Math.min(anchor.firstAtMs, entry.firstAtMs); anchor.deadlineMs = Math.min(anchor.deadlineMs, entry.deadlineMs) }
        return { input: next.inputs[entry.inboundKey], anchor: next.anchors[entry.replyAnchorKey] }
      })
    },
    close ({ drained = false } = {}) {
      if (closed) return { closed: true }
      if (!drained || failed || operations) return { closed: false, lockRetained: true }
      closeSync(fd); unlinkSync(lock); closed = true
      return { closed: true, lockRetained: false }
    }
  })
}

// Windows-only startup ownership. No PID/age inference, daemon or lock expiry.
import { createServer } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { realpathSync, statSync, lstatSync, existsSync, readFileSync, mkdirSync, copyFileSync,
  openSync, fsyncSync, closeSync, unlinkSync, writeFileSync, constants } from 'node:fs'
import { resolve, dirname, basename, parse, join, isAbsolute } from 'node:path'
import { inspectMvpJournal, openMvpJournal, mvpEntryExists } from './mvp-journal.js'

const execute = promisify(execFile)
const PROTOCOL = 'echo-owner-writer-v1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const hex = s => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s) && s.length === 64
const hash = (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex')
const error = code => Object.assign(Error(code), { code })
const aborted = signal => { if (signal?.aborted) throw error('storage_canceled') }
function dosPath (value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw error('storage_unsupported')
  let path = value
  if (path.startsWith('\\\\?\\')) {
    if (!/^\\\\\?\\[A-Za-z]:[\\/]/.test(path)) throw error('storage_unsupported')
    path = path.slice(4)
  }
  // Check before resolve: namespace UNC must never become a relative C: path.
  if (!/^[A-Za-z]:[\\/]/.test(path)) throw error('storage_unsupported')
  return resolve(path)
}
function safePath (path) {
  for (let p = path; ; p = dirname(p)) {
    if (mvpEntryExists(p) && lstatSync(p).isSymbolicLink()) throw error('storage_recovery')
    if (p === dirname(p)) break
  }
}
function directoryId (path) {
  const s = statSync(path, { bigint: true })
  if (!s.isDirectory() || s.ino <= 0n) throw error('storage_unsupported')
  return `${s.dev}:${s.ino}`
}
function regular (path, max) {
  const s = lstatSync(path)
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > max) throw error('storage_recovery')
}

/** Read only OS volume/installation metadata; never user profiles/credentials.
 * DriveInfo type 3 is a local fixed volume. Raw MachineGuid never leaves memory.
 */
async function localSystem (path, signal) {
  if (process.platform !== 'win32') throw error('storage_unsupported')
  const drive = parse(dosPath(path)).root.toUpperCase()
  const script = `$ErrorActionPreference='Stop';$v=[System.IO.DriveInfo]::new('${drive}');$k=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\\Microsoft\\Cryptography');try{$m=[string]$k.GetValue('MachineGuid');[Console]::Write((@{type=[int]$v.DriveType;machine=$m}|ConvertTo-Json -Compress))}finally{if($k){$k.Dispose()}}`
  try {
    const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const result = await execute(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 8192, signal })
    const info = JSON.parse(result.stdout)
    if (info.type !== 3 || typeof info.machine !== 'string' || !UUID.test(info.machine)) throw Error()
    return { hostKey: hash(PROTOCOL, info.machine.toLowerCase(), hostname().toLowerCase()) }
  } catch { aborted(signal); throw error('storage_unsupported') }
}

/** Kernel object is deliberately held for the whole writer life. */
function acquire (key, signal) {
  aborted(signal)
  const pipe = '\\\\.\\pipe\\echo-owner-writer-v1-' + key
  return new Promise((resolveOwner, reject) => {
    let settled = false, canceled = false, active = false, releasePromise
    const server = createServer(socket => socket.destroy())
    const cancel = () => { canceled = true }
    signal?.addEventListener('abort', cancel, { once: true })
    const cleanup = () => signal?.removeEventListener('abort', cancel)
    server.on('error', e => {
      active = false
      if (!settled) { settled = true; cleanup(); reject(error(['EADDRINUSE', 'EACCES', 'EPERM'].includes(e.code) ? 'storage_busy' : 'storage_unsupported')) }
    })
    server.on('close', () => { active = false })
    server.listen({ path: pipe, exclusive: true }, () => {
      active = true
      if (canceled || signal?.aborted) {
        server.close(() => { if (!settled) { settled = true; cleanup(); reject(error('storage_canceled')) } })
        return
      }
      settled = true; cleanup()
      server.unref()
      resolveOwner({
        key, healthy: () => active,
        release: () => releasePromise ??= new Promise((yes, no) => {
          server.close(e => e ? no(error('storage_recovery')) : yes())
        })
      })
    })
  })
}

function protocolRecord (bytes, expected) {
  if (bytes.length === 0) throw error('storage_legacy')
  let r
  try { r = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw error('storage_recovery') }
  if (!r || Object.keys(r).sort().join(',') !== 'directoryId,guardKey,guardKind,hostKey,protocol,scopeKey,writerId' ||
    r.protocol !== PROTOCOL || r.hostKey !== expected.hostKey || r.directoryId !== expected.directoryId ||
    r.scopeKey !== expected.scopeKey || !hex(r.guardKey) ||
    !UUID.test(r.writerId) || !['directory', 'path'].includes(r.guardKind) ||
    r.guardKey !== (r.guardKind === 'directory' ? expected.directoryKey : expected.pathKey)) throw error('storage_recovery')
  return r
}
function backupAndArchive (dir, lockBytes, { archiveNameFactory = () => 'recovery-' + randomUUID() } = {}) {
  const name = archiveNameFactory()
  if (!/^recovery-[0-9a-f-]{36}$/.test(name)) throw error('storage_recovery')
  const directory = join(dir, name)
  mkdirSync(directory, { mode: 0o700 })
  for (const [from, to] of [['.writer-lock', 'writer-lock.json'], ['owner-text.json', 'owner-text.json']]) {
    const target = join(directory, to)
    copyFileSync(join(dir, from), target, constants.COPYFILE_EXCL)
    const fd = openSync(target, 'r+')
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }
  if (!readFileSync(join(directory, 'writer-lock.json')).equals(lockBytes)) throw error('storage_recovery')
  const manifest = { protocol: PROTOCOL, complete: true,
    lockSha256: createHash('sha256').update(lockBytes).digest('hex'),
    journalSha256: createHash('sha256').update(readFileSync(join(directory, 'owner-text.json'))).digest('hex') }
  const fd = openSync(join(directory, 'manifest.json'), 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify(manifest) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
  // Both complete backups exist before removing the original stale pathname.
  // New journal creation is still wx; an unexpected legacy contender wins no
  // shared ownership and cannot have its file overwritten by this wrapper.
  unlinkSync(join(dir, '.writer-lock'))
  return directory
}

export async function openManagedMvpJournal (directory, scope, options = {}) {
  const { signal, systemProbe = localSystem, archive = backupAndArchive } = options
  const check = () => {
    aborted(signal)
    if (options.isCurrent && options.isCurrent() !== true) throw error('storage_canceled')
  }
  if (process.platform !== 'win32') throw error('storage_unsupported')
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024, maxInputs = options.maxInputs ?? 2048
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 512 || !Number.isSafeInteger(maxInputs) || maxInputs < 1 || maxInputs > 2048) throw error('storage_recovery')
  const input = dosPath(directory)
  if (input === parse(input).root) throw error('storage_unsupported')
  check()
  const system = await systemProbe(input, signal)
  if (!hex(system?.hostKey)) throw error('storage_unsupported')
  check(); safePath(input)
  const fresh = !mvpEntryExists(input)
  const parent = dosPath(realpathSync.native(dirname(input)))
  const dir = fresh ? join(parent, basename(input)) : dosPath(realpathSync.native(input))
  // Re-check a canonical root if native resolution crossed a local drive.
  if (parse(dir).root.toLowerCase() !== parse(input).root.toLowerCase()) {
    const resolvedSystem = await systemProbe(dir, signal)
    if (resolvedSystem.hostKey !== system.hostKey) throw error('storage_unsupported')
  }
  const pathKey = hash(PROTOCOL, 'path', directoryId(dirname(dir)), basename(dir).toLowerCase())
  let identity = fresh ? null : directoryId(dir)
  const directoryKey = identity ? hash(PROTOCOL, 'directory', identity) : null
  // All entrants take parent/name first, then physical directory identity.
  // A contender observing fresh creation must not invert that order.
  const primaryKind = 'path', primaryKey = pathKey
  const owners = [], held = new Map()
  let journal, recovered = false
  async function own (key) {
    if (held.has(key)) return
    const owner = await acquire(key, signal)
    owners.push(owner); held.set(key, owner)
  }
  const release = async () => { for (const owner of owners.slice().reverse()) await owner.release() }
  const healthy = () => owners.every(o => o.healthy())
  const fence = () => { if (!healthy()) throw error('storage_unavailable') }
  try {
    await own(primaryKey); check()
    if (!fresh) {
      await own(directoryKey); check()
      safePath(dir)
      inspectMvpJournal(dir, scope, options)
      const lock = join(dir, '.writer-lock')
      if (mvpEntryExists(lock)) {
        regular(lock, 2048)
        const bytes = readFileSync(lock)
        const r = protocolRecord(bytes, { ...system, directoryId: identity, directoryKey, pathKey, scopeKey: scope.scopeKey })
        await own(r.guardKey); check()
        // No mutation happened before all protocol ownership and data checks.
        inspectMvpJournal(dir, scope, options)
        if (!readFileSync(lock).equals(bytes)) throw error('storage_recovery')
        await options.onStage?.('before-archive')
        check()
        inspectMvpJournal(dir, scope, options)
        if (!readFileSync(lock).equals(bytes)) throw error('storage_recovery')
        archive(dir, bytes, options); recovered = true
      }
    }
    check()
    journal = openMvpJournal(dir, scope, {
      ...options,
      managedLockRecord: path => {
        identity = directoryId(path)
        return { protocol: PROTOCOL, hostKey: system.hostKey, directoryId: identity,
          guardKind: primaryKind, guardKey: primaryKey, scopeKey: scope.scopeKey, writerId: randomUUID() }
      }
    })
    await options.onStage?.('journal-opened')
    check()
    // Fresh creation initially holds the canonical parent/name resource. Add
    // physical directory identity before publishing the journal to any caller.
    await own(hash(PROTOCOL, 'directory', identity)); check()
    let closing
    const store = journal.metadataStore
    const metadataStore = Object.freeze({
      contract: store.contract, durability: store.durability,
      transaction: (ref, reducer) => { fence(); return store.transaction(ref, old => { fence(); return reducer(old) }) },
      read: ref => { fence(); return store.read(ref) }
    })
    return Object.freeze({
      ...journal, metadataStore,
      change: reducer => { fence(); return journal.change(reducer) },
      rememberInput: entry => { fence(); return journal.rememberInput(entry) },
      status: () => ({ ...journal.status(), healthy: journal.status().healthy && healthy(),
        managed: true, recovered, ownershipHeld: healthy() }),
      async close (args) {
        if (closing) return closing
        const result = journal.close(args)
        if (!result.closed) return result
        closing = release().then(() => result)
        return closing
      }
    })
  } catch (e) {
    // Initialization has never published this journal/store to core. A healthy
    // late journal can close before its kernel ownership is relinquished.
    if (journal) {
      const closed = journal.close({ drained: true })
      if (!closed.closed) throw error('storage_recovery') // retain kernel owner
    }
    await release()
    if (e?.code && ['storage_busy', 'storage_legacy', 'storage_unsupported', 'storage_canceled'].includes(e.code)) throw e
    throw error('storage_recovery')
  }
}

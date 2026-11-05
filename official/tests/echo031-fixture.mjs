import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as codec from '../../../dsh-memory-agent/lib/official-c2c-codec.js'
const ownedCleanup = new WeakMap()
export const ids = codec.deriveMessageIdentity({ appId: 'synthetic-app-A', rawOpenid: 'SYNTHETIC_OWNER_OPENID_A', rawMsgId: 'synthetic-031-old', indexKind: 'missing', indexValue: '' })
export const scope = { ...codec.validateScope({ platform: 'qq-official', appId: 'synthetic-app-A', ownerHash: ids.ownerHash, chatId: ids.chatId }), keyScheme: codec.KEY_SCHEME }
export function temporary (t) {
  const base = resolve(tmpdir()), root = mkdtempSync(join(base, 'echo031-'))
  const rel = relative(base, root)
  assert.ok(rel.startsWith('echo031-') && !rel.startsWith('..') && !isAbsolute(rel))
  t.after(async () => {
    for (const stop of ownedCleanup.get(t) ?? []) await stop()
    assert.equal(resolve(root), root); rmSync(root, { recursive: true, force: true })
  })
  return root
}
export function actor (t, directory, scenario = 'plain') {
  const nonce = randomUUID(), child = fork(fileURLToPath(new URL('./echo031-worker.mjs', import.meta.url)),
    [directory, scenario, nonce], { windowsHide: true, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { SystemRoot: process.env.SystemRoot, TEMP: tmpdir(), TMP: tmpdir(), NODE_OPTIONS: '' } })
  const pid = child.pid
  assert.ok(Number.isInteger(pid) && pid > 0)
  let verified = false, exited = false, resolveResult, resolveCreated, resolveExit
  const result = new Promise(r => { resolveResult = r }), created = new Promise(r => { resolveCreated = r }), exit = new Promise(r => { resolveExit = r })
  const messages = [], output = []
  child.stdout.on('data', chunk => output.push(chunk.toString()))
  child.stderr.on('data', chunk => output.push(chunk.toString()))
  child.on('message', message => {
    assert.equal(message.pid, pid); assert.equal(message.nonce, nonce); verified = true; messages.push(message)
    if (message.event === 'created') resolveCreated(message)
    else if (['ready', 'rejected'].includes(message.event)) resolveResult(message)
  })
  child.on('exit', (code, signal) => { exited = true; resolveExit({ code, signal }) })
  child.on('error', e => resolveResult({ event: 'rejected', code: e.code }))
  const bounded = async p => {
    let timer
    try { return await Promise.race([p, new Promise((_, no) => { timer = setTimeout(() => no(Error('owned_child_timeout')), 10000) })]) } finally { clearTimeout(timer) }
  }
  const terminate = async forced => {
    if (exited) return
    assert.equal(child.pid, pid); assert.equal(verified, true)
    if (forced) assert.equal(child.kill('SIGKILL'), true)
    else child.send('close')
    await bounded(exit)
  }
  const cleanup = async () => { if (!exited) { assert.equal(child.pid, pid); child.kill('SIGKILL'); await bounded(exit) } }
  ownedCleanup.set(t, [...(ownedCleanup.get(t) ?? []), cleanup])
  t.after(cleanup)
  return { result: () => bounded(result), created: () => bounded(created), continue: () => child.send('continue'), stop: () => terminate(false),
    force: () => terminate(true), exit: () => bounded(exit), messages, output, pid }
}

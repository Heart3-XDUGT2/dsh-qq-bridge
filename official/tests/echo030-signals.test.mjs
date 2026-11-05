import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { installedShutdown } from './echo030-shutdown-source.mjs'
import { openMvpJournal } from '../lib/mvp-journal.js'

const records = []
after(() => {
  const label = process.env.ECHO030_LABEL ?? 'manual-' + Date.now() + '-' + process.pid
  if (!/^[a-z0-9-]+$/.test(label ?? '')) throw Error('new_030_label_required')
  writeFileSync(new URL('../../.scratch/test-traces/echo-executor-030-signals-' + label + '.json', import.meta.url),
    JSON.stringify({ task: 'ECHO-030', records }, null, 2) + '\n', { flag: 'wx' })
})
for (const mode of ['sigint-idle', 'sigint-confirmed', 'force-idle', 'force-confirmed', 'double-sigint-confirmed']) {
  test('030 installed CLI shutdown source + actual Cordis/core/journal child: ' + mode, t => {
    const base = resolve(tmpdir()), root = mkdtempSync(join(base, 'echo030-process-')), rel = relative(base, root)
    assert.ok(rel.startsWith('echo030-process-') && !rel.startsWith('..') && !isAbsolute(rel))
    t.after(() => {
      assert.equal(resolve(root), root)
      assert.ok(relative(base, root).startsWith('echo030-process-'))
      rmSync(root, { recursive: true, force: true })
    })
    const child = fileURLToPath(new URL('./echo030-process-child.mjs', import.meta.url))
    const preload = pathToFileURL(fileURLToPath(new URL('./echo025-preload.mjs', import.meta.url))).href
    const result = spawnSync(process.execPath, ['--import', preload, child, mode, root], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: '', TEMP: root, TMP: root, TMPDIR: root }
    })
    assert.equal(result.error, undefined)
    assert.equal(result.stderr, '')
    const proof = JSON.parse(readFileSync(join(root, 'exit-proof.json'), 'utf8'))
    records.push({ ...proof, stdout: result.stdout, stderr: result.stderr, processExitCode: result.status })
    assert.equal(result.status, mode.startsWith('force-') ? 137 : 130)
    assert.equal(proof.network.forbidden, 0)
    assert.equal(proof.isolation.networkAttempts, 0)
    assert.equal(proof.journalLockExitCleanupPerformed, false)
    const graceful = mode.startsWith('sigint-')
    assert.equal(proof.disposeCompleted, graceful)
    assert.equal(proof.lockExists, !graceful)
    assert.equal(proof.journal.closed, graceful)
    assert.equal(proof.facts.unknown, 0)
    assert.equal(proof.facts.sending, 0)
    assert.equal(proof.posts, mode.endsWith('confirmed') ? 1 : 0)
    if (!graceful) {
      // Retained lock must continue excluding the next writer, even with only
      // known-success facts. No automatic archive/delete/replay is introduced.
      const disk = JSON.parse(readFileSync(join(root, 'owner-mvp', 'owner-text.json'), 'utf8'))
      assert.throws(() => openMvpJournal(join(root, 'owner-mvp'), {
        scopeKey: disk.scopeKey, ownerHash: disk.ownerHash, appId: disk.appId, keyScheme: disk.keyScheme
      }), /EEXIST/)
      assert.equal(existsSync(join(root, 'owner-mvp', '.writer-lock')), true)
    }
  })
}
test('030 exact CLI controller enforces its 5000ms grace if disposer never finishes', async () => {
  const timers = new Map(), forced = [], completed = []
  const source = installedShutdown({
    process: {},
    setTimeout: (fn, ms) => { timers.set(1, { fn, ms }); return 1 },
    clearTimeout: id => timers.delete(id)
  })
  const controller = source.create(() => new Promise(() => {}), code => forced.push(code), code => completed.push(code))
  controller.interrupt(130)
  assert.equal(timers.get(1).ms, 5000)
  await Promise.resolve() // starts the intentionally uncooperative disposer
  timers.get(1).fn()
  assert.deepEqual(forced, [130])
  assert.deepEqual(completed, [])
  records.push({ mode: 'controller-timeout-fault', requestedGraceMs: 5000, forced, completed, source: source.provenance })
})

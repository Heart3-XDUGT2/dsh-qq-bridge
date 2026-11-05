import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'

test('025 current core intentionally rejects generic official ingress before old routing', async t => {
  const base = resolve(tmpdir()), root = mkdtempSync(join(base, 'echo025-reserved-'))
  const rel = relative(base, root)
  assert.ok(rel.startsWith('echo025-reserved-') && !rel.startsWith('..') && !isAbsolute(rel))
  t.after(() => { assert.equal(resolve(root), root); rmSync(root, { recursive: true, force: true }) })
  const data = join(root, 'echo'); mkdirSync(data)
  process.env.DSH_HOME = root; process.env.ECHO_DATA_DIR = data; process.env.ECHO_DB = join(data, 'DO-NOT-OPEN.db')
  const { createRelay } = await import('../../../dsh-memory-agent/lib/relay.js')
  let touched = 0
  const relay = createRelay({ store: {}, config: () => ({}), isEnabled: () => true,
    ensureCompanion: () => { touched++; throw Error('unexpected_legacy_route') },
    injectInbound: () => { touched++; throw Error('unexpected_legacy_route') } })
  const result = await relay.handleInbound({ v: 1, platform: 'qq-official', text: 'synthetic' })
  assert.equal(result.status, 403)
  assert.equal(result.body.reason, 'reserved-platform')
  assert.equal(touched, 0)
})

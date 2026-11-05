// Historical R1 only. Its frozen test expects pre-MVP generic relay acceptance.
// This hook is NEVER loaded by MVP or real-current-core integration tests.
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const snapshot = JSON.parse(readFileSync(new URL('../../docs/echo-executor-025-legacy-relay.json', import.meta.url), 'utf8'))
if (createHash('sha256').update(snapshot.utf8).digest('hex') !== snapshot.sha256) throw Error('legacy_snapshot_changed')
const target = new URL('../../../dsh-memory-agent/lib/relay.js', import.meta.url).href
registerHooks({
  load (url, context, next) {
    if (url === target) return { format: 'module', source: snapshot.utf8, shortCircuit: true }
    return next(url, context)
  }
})

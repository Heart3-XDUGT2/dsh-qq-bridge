import { allowLoopback, network } from '../../../dsh-memory-agent/tests/fixtures/echo024-network.mjs'
import { coreHost, response, isolation } from '../../../dsh-memory-agent/tests/fixtures/echo024-core.mjs'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createOwnerTextPlugin } from '../lib/owner-text.js'
import { createTransport } from '../lib/transport.js'
import { openMvpJournal } from '../lib/mvp-journal.js'
import { fixture, until } from './transport-fixture.mjs'
import { configFor } from './echo025-fixture.mjs'
import { installedShutdown } from './echo030-shutdown-source.mjs'

allowLoopback()
const [mode, parentRoot] = process.argv.slice(2), root = resolve(parentRoot ?? '')
if (root !== resolve(tmpdir()) || !basename(root).startsWith('echo030-process-') ||
  !['sigint-idle', 'sigint-confirmed', 'force-idle', 'force-confirmed', 'double-sigint-confirmed'].includes(mode)) throw Error('invalid_process_fixture')
const callbacks = [], t = { after: callback => callbacks.push(callback) }
const script = (_request, index) => index % 2 === 0
  ? response('', [{ id: 'echo030-child-tool-' + index, name: 'echo_qq_say', arguments: JSON.stringify({ text: 'synthetic child answer' }) }])
  : response('ordinary tail')
const core = await coreHost(t, { bind: false, allowMemoryMetadata: false, script })
core.h.ctx.effect(() => () => core.owner.dispose(), 'echo030.core-close')
const server = await fixture(t), config = configFor(root)
let journal
const plugin = core.h.ctx.plugin(createOwnerTextPlugin({
  transportFactory: opts => createTransport({ ...opts, testEndpoints: server.testEndpoints }),
  journalFactory: (...args) => { journal = openMvpJournal(...args); return journal }
}), config)
await plugin
const controller = plugin.ctx.get('echo:official-c2c')
await controller.ready
await until(() => controller.status().connected && controller.status().activeTasks === 0)
if (mode.endsWith('confirmed')) {
  server.send({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: {
    id: 'synthetic-030-child-message', content: 'synthetic child input', timestamp: new Date().toISOString(),
    author: { user_openid: config.ownerBinding.userOpenid }
  } })
  await until(() => {
    const a = Object.values(journal.snapshot().anchors)[0]
    return a?.state === 'confirmed' && a.coreSettled && controller.status().activeTasks === 0
  })
  await core.h.agent.whenIdle()
}
const source = installedShutdown()
let disposeStarted = false, disposeCompleted = false
source.install(async () => {
  disposeStarted = true
  await core.h.ctx.fiber.dispose()
  disposeCompleted = true
})
const lock = join(config.stateDir, '.writer-lock')
const before = journal.status(), began = Date.now()
// Synchronous test evidence only. NEVER closes/removes a lock or runs async
// cleanup at process exit; the lock outcome is exactly what teardown produced.
process.once('exit', code => {
  const disk = JSON.parse(readFileSync(join(config.stateDir, 'owner-text.json'), 'utf8'))
  const anchors = Object.values(disk.anchors)
  writeFileSync(join(root, 'exit-proof.json'), JSON.stringify({
    mode, code, elapsedMs: Date.now() - began, disposeStarted, disposeCompleted,
    lockExists: existsSync(lock), journal: journal.status(), before,
    facts: { anchors: anchors.length, confirmed: anchors.filter(a => a.state === 'confirmed').length,
      coreSettled: anchors.filter(a => a.coreSettled).length,
      sending: anchors.filter(a => a.state === 'sending').length, unknown: anchors.filter(a => a.state === 'unknown').length,
      attempts: anchors.reduce((n, a) => n + a.attempts.length, 0) },
    posts: server.posts().length, network, isolation, source: source.provenance,
    signalDelivery: mode.startsWith('force-') ? 'direct process.exit fault injection' : 'synthetic process.emit(SIGINT), exact installed signal handler',
    fullProductionProfileBooted: false, journalLockExitCleanupPerformed: false
  }, null, 2) + '\n', { flag: 'wx' })
})
if (mode.startsWith('force-')) process.exit(137)
else {
  process.emit('SIGINT')
  if (mode.startsWith('double-')) process.emit('SIGINT')
}

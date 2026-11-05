// Only the test parent can command this owned child. No QQ, profile or core.
import { openManagedMvpJournal } from '../lib/managed-journal.js'
import { readdirSync, realpathSync } from 'node:fs'
import { dirname, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import * as codec from '../../../dsh-memory-agent/lib/official-c2c-codec.js'
const [directory, scenario = 'plain', nonce] = process.argv.slice(2)
const parent = realpathSync.native(dirname(directory)), rel = relative(realpathSync.native(tmpdir()), parent)
if (!rel.toLowerCase().startsWith('echo031-') || rel.startsWith('..') || isAbsolute(rel) || !nonce) throw Error('owned_test_directory_required')
const send = message => process.send?.({ ...message, pid: process.pid, nonce })
let go
const resume = new Promise(resolve => { go = resolve })
let journal
process.on('message', async message => {
  if (message === 'continue') go()
  if (message === 'close' && journal) {
    await journal.close({ drained: true }); send({ event: 'closed' }); process.disconnect()
  }
})
const ids = codec.deriveMessageIdentity({ appId: 'synthetic-app-A', rawOpenid: 'SYNTHETIC_OWNER_OPENID_A',
  rawMsgId: 'synthetic-031-old', indexKind: 'missing', indexValue: '' })
const scope = { ...codec.validateScope({ platform: 'qq-official', appId: 'synthetic-app-A', ownerHash: ids.ownerHash, chatId: ids.chatId }), keyScheme: codec.KEY_SCHEME }
try {
  journal = await openManagedMvpJournal(directory, scope, {
    onStage: async stage => { if (scenario === 'fresh-handoff' && stage === 'journal-opened') { send({ event: 'created' }); await resume } }
  })
  if (scenario.startsWith('seed-')) {
    const state = scenario.slice(5), now = Date.now()
    journal.rememberInput({ ...ids, rawMsgId: 'synthetic-031-old', text: 'synthetic old input', firstAtMs: now, deadlineMs: now + 300000 })
    journal.change(d => {
      const a = d.anchors[ids.replyAnchorKey]
      a.state = state === 'draft' ? 'claimed' : state
      a.claimKey = 'synthetic-old-claim'
      a.reply = { replyId: 'synthetic-old-reply', sourceKey: 'synthetic-old-source', inboundKey: ids.inboundKey,
        replyAnchorKey: ids.replyAnchorKey, scopeKey: ids.scopeKey, text: 'synthetic old answer', createdAtMs: now }
      if (state !== 'draft') {
        a.attempts = [{ ordinal: 1, msgSeq: 1, state, dispatchedAtMs: now }]
        d.dispatchHistory.push(now)
      }
      if (state === 'confirmed' || state === 'unknown') a.outcome = state
      a.coreSettled = state === 'confirmed'
      d.pendingClaim = { key: a.claimKey }
      d.inputs[ids.inboundKey].accepted = true
      d.inputs[ids.inboundKey].sourceKey = 'synthetic-old-source'
      d.metadata[ids.inboundKey] = { scopeKey: ids.scopeKey, inboundKey: ids.inboundKey, replyAnchorKey: ids.replyAnchorKey,
        inputDigest: codec.inputDigest({ ...ids, text: 'synthetic old input' }), sourceKey: 'synthetic-old-source',
        admissionState: 'accepted', everAccepted: true, processingState: 'host_enqueued', receipt: { id: 'synthetic-old-receipt' },
        ownerText: { reply: a.reply, claimKey: a.claimKey, outcome: a.outcome ?? null } }
    })
  }
  const data = journal.snapshot()
  send({ event: 'ready', managed: journal.status().managed, recovered: journal.status().recovered,
    states: Object.values(data.anchors).map(a => a.state), attempts: Object.values(data.anchors).map(a => a.attempts.length),
    pendingClaimCleared: data.pendingClaim === null, history: data.dispatchHistory.length,
    archives: readdirSync(directory).filter(p => p.startsWith('recovery-')).length })
} catch (e) {
  send({ event: 'rejected', code: e.code ?? 'storage_recovery' })
  process.disconnect()
}

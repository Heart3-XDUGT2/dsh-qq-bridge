// Explicit MVP contract stub, for adapter faults only. Not core/host proof.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import * as codec from '../../../dsh-memory-agent/lib/official-c2c-codec.js'
import { createOwnerTextPlugin } from '../lib/owner-text.js'
import { Clock } from './transport-fixture.mjs'

export const gate = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
export const tick = () => new Promise(resolve => setImmediate(resolve))
export function rootFor (t) {
  const base = resolve(tmpdir()), root = mkdtempSync(join(base, 'echo025-'))
  const rel = relative(base, root)
  assert.ok(rel.startsWith('echo025-') && !rel.startsWith('..') && !isAbsolute(rel))
  return { root, cleanup: () => { assert.equal(resolve(root), root); rmSync(root, { recursive: true, force: true }) } }
}
export const configFor = root => ({
  enabled: true, appId: 'synthetic-app-A', appSecret: 'SYNTHETIC_025_SECRET',
  ownerBinding: { authorized: true, appId: 'synthetic-app-A', userOpenid: 'SYNTHETIC_OWNER_OPENID_A' },
  stateDir: join(root, 'owner-mvp')
})
export const eventFor = (c, id = 'synthetic-in-1', text = 'synthetic body', extra = {}) => ({
  op: 0, t: 'C2C_MESSAGE_CREATE', s: 2,
  d: { id, author: { user_openid: c.ownerBinding.userOpenid }, timestamp: new Date(1000000).toISOString(), content: text, ...extra }
})
export function stubService ({ text = 'synthetic answer', injectHook, takeHook, confirmHook, closeHook } = {}) {
  const data = { injects: [], takes: [], confirms: [], bindings: [], replies: [], claims: new Map(), outcomes: new Map(), active: true, next: 0 }
  const service = { officialOwnerText: {
    version: 1, contract: 'owner-text-mvp-1', keyScheme: codec.KEY_SCHEME, codec,
    status: () => ({ available: true }),
    async openBinding ({ scope, authorization, metadataStore }) {
      data.bindings.push({ scope, authorization, metadataStore })
      const b = {
        async inject (input) {
          data.injects.push(structuredClone(input))
          if (injectHook) await injectHook(input, data)
          const ref = { scopeKey: scope.scopeKey, inboundKey: input.inboundKey }
          const result = await metadataStore.transaction(ref, old => {
            if (old?.everAccepted) return { next: old, value: { record: old, duplicate: true } }
            const id = ++data.next
            const record = { ...input, scopeKey: scope.scopeKey,
              inputDigest: codec.inputDigest({ scopeKey: scope.scopeKey, ...input }),
              requestKey: 'synthetic-request-' + id, sourceKey: 'synthetic-source-' + id, attemptKey: 'synthetic-attempt-' + id,
              admissionState: 'accepted', everAccepted: true, processingState: 'turn_closed',
              receipt: { id: 'synthetic-admission-' + id } }
            return { next: record, value: { record, duplicate: false } }
          })
          const { record, duplicate } = result
          if (!duplicate) {
            for (const reply of data.replies) if (!data.outcomes.has(reply.replyId)) reply.canceled = true
            const reply = { replyId: 'synthetic-reply-' + data.next, sourceKey: record.sourceKey, inboundKey: input.inboundKey,
              replyAnchorKey: input.replyAnchorKey, scopeKey: scope.scopeKey, text, createdAtMs: 1000000 }
            data.replies.push(reply)
          }
          return { ok: true, admissionState: 'accepted', everAccepted: true, duplicate, sourceKey: record.sourceKey,
            admissionReceiptId: record.receipt.id, receipt: record.receipt }
        },
        async takeReply ({ claimKey }) {
          data.takes.push(claimKey)
          let reply = data.claims.get(claimKey)
          if (!reply) {
            reply = data.replies.find(r => !r.canceled && !data.outcomes.has(r.replyId) && ![...data.claims.values()].includes(r))
            if (reply) data.claims.set(claimKey, reply)
          }
          if (takeHook) await takeHook(claimKey, reply, data)
          if (!reply) return { reply: null }
          const { canceled, ...wire } = reply
          return { reply: structuredClone(wire) }
        },
        canSendReply ({ replyId, claimKey }) {
          const reply = data.claims.get(claimKey)
          return data.active && reply?.replyId === replyId && !reply.canceled && !['confirmed', 'unknown', 'rejected', 'expired'].includes(data.outcomes.get(replyId))
        },
        async confirmReply (input) {
          data.confirms.push(structuredClone(input))
          const prior = data.outcomes.get(input.replyId)
          if (!prior || prior === 'rate_limited') data.outcomes.set(input.replyId, input.outcome)
          if (confirmHook) await confirmHook(input, data)
          return { ok: data.outcomes.get(input.replyId) === input.outcome, replayed: prior === input.outcome }
        },
        status: () => ({ active: data.active }),
        async close () { data.active = false; if (closeHook) return await closeHook(data); return { drained: true } }
      }
      data.binding = b
      return b
    }
  }, registerChannel: () => { throw Error('generic_channel_forbidden') } }
  return { service, data }
}
export async function setupMvp (t, options = {}) {
  const local = rootFor(t), raw = options.raw ?? configFor(local.root), clock = options.clock ?? new Clock()
  const f = options.stub ?? stubService(options)
  const store = new Map([['echo:relay', f.service]]), disposers = [], sent = []
  let transportOptions
  const ctx = {
    get: key => store.get(key), provide: (key, value) => { store.set(key, value); return () => store.delete(key) },
    effect: fn => { disposers.push(fn()) }
  }
  const transportFactory = options.transportFactory ?? (opts => {
    transportOptions = opts
    return {
      async start () { opts.onState('ready'); return true }, stop () {},
      async sendText (payload) {
        if (options.beforeSend) await options.beforeSend(payload)
        if (!payload.isCurrent()) return { kind: 'unknown' }
        const allowed = payload.beforePost()
        if (!allowed.allowed) return { kind: 'not_dispatched', reason: allowed.reason, retryAtMs: allowed.retryAtMs }
        sent.push(payload)
        return options.send ? await options.send(payload, sent.length) : { kind: 'confirmed', id: 'synthetic-sent-' + sent.length }
      }
    }
  })
  const plugin = createOwnerTextPlugin({ clock, transportFactory, ...(options.journalFactory ? { journalFactory: options.journalFactory } : {}) })
  plugin.apply(ctx, raw)
  const controller = store.get('echo:official-c2c')
  await controller.ready
  t.after(async () => {
    await controller.dispose({ timeoutMs: 100 })
    for (const fn of disposers.reverse()) await fn()
    local.cleanup()
  })
  return { ...f, ...local, raw, clock, ctx, store, sent, controller,
    emit: e => transportOptions.onEvent(e),
    async idle () { await tick(); await tick(); await controller.poll(); await tick() } }
}

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { createPlugin, STATUS_SERVICE } from '../lib/index.js'
import { identity, inboundKey, PLATFORM } from '../lib/config.js'
import { Clock, until } from './transport-fixture.mjs'

export function temp (t) {
  const root = mkdtempSync(join(tmpdir(), 'echo-018-'))
  const resolved = resolve(root), base = resolve(tmpdir())
  const rel = relative(base, resolved)
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && rel.startsWith('echo-018-'))
  t.after(() => { assert.equal(resolve(root), resolved); rmSync(resolved, { recursive: true, force: true }) })
  return root
}
export function config (root, extra = {}) {
  return { enabled: true, appId: 'synthetic-app-A', appSecret: 'SYNTHETIC_SECRET_NEVER_IN_STATUS', ownerBinding: { appId: 'synthetic-app-A', userOpenid: 'SYNTHETIC_OWNER_OPENID_A', authorized: true }, stateDir: join(root, 'ledger'), ...extra }
}
export function event (c, id = 'synthetic-in-1', extra = {}) {
  return { op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id, author: { user_openid: c.ownerBinding.userOpenid }, content: 'synthetic input', timestamp: new Date(1000000).toISOString(), ...extra } }
}
export function plan (c, id = 'synthetic-in-1', texts = ['synthetic answer'], extra = {}) {
  const chatId = identity(c.appId, c.ownerBinding.userOpenid)
  return { platform: PLATFORM, appId: c.appId, chatId, planKey: 'plan-1', inboundKey: inboundKey(c.appId, id), turnId: 'synthetic-turn-1', kind: 'reply', complete: true,
    rows: texts.map((text, i) => ({ platform: PLATFORM, id: i + 1, chatId, kind: 'reply', text, turnId: 'synthetic-turn-1#' + i, notBefore: 0 })), ...extra }
}
export async function setup (t, { raw, replies = true, transportFactory, serviceOverride, clock = new Clock(), outcomes = [], root } = {}) {
  root ??= temp(t)
  const c = raw ?? config(root)
  const data = { injections: [], leases: [], acks: [], sent: [], registered: [], rawLease: 0, rawAck: 0, agentCalls: 0, unsubscribed: 0, unregistered: 0, plans: [], outcomes, readyCallbacks: [] }
  let notify = null, events = null
  const service = {
    inject: async envelope => { data.injections.push(envelope); return { ok: true, accepted: true, sessionId: 'original-companion-session' } },
    registerChannel: ch => { data.registered.push(ch); return () => { data.unregistered++ } },
    subscribeOutbound: fn => { notify = fn; return () => { data.unsubscribed++; notify = null } },
    lease: () => { data.rawLease++; throw Error('unfiltered_lease_forbidden') },
    ack: () => { data.rawAck++; throw Error('unscoped_ack_forbidden') },
    ...(replies ? { officialC2c: { version: 1, contract: 'complete-turn-v1',
      leaseReplies: async scope => { data.leases.push(scope); return { plans: data.plans.slice(0, 1) } },
      ackReplies: async scope => { data.acks.push(scope); data.plans = data.plans.filter(p => p.planKey !== scope.planKey); return { ok: true, ids: scope.ids } }
    } } : {}), ...serviceOverride
  }
  const store = new Map([['echo:relay', service]])
  const disposers = []
  const ctx = {
    get: k => k === 'agents' ? { create: () => { data.agentCalls++; throw Error('new_agent_forbidden') } } : store.get(k),
    provide: (k, v) => { store.set(k, v); return () => store.delete(k) },
    effect: fn => { disposers.push(fn()) }
  }
  const plugin = createPlugin({ clock, transportFactory: transportFactory ?? (opts => {
    events = opts.onEvent
    data.transportOpts = opts
    return { start: async () => { opts.onState('ready'); return true }, stop: () => { data.transportStopped = true }, sendText: async payload => {
      data.sent.push(payload)
      const next = data.outcomes.shift() ?? { kind: 'confirmed' }
      return typeof next === 'function' ? next(payload) : next
    } }
  }) })
  plugin.apply(ctx, c)
  const controller = store.get(STATUS_SERVICE)
  await controller.ready
  t.after(async () => { await controller.dispose(); for (const d of disposers.reverse()) await d() })
  return { c, data, service, ctx, store, controller, clock, root, emit: p => events(p), notify: () => notify?.(), async idle () { await new Promise(r => setTimeout(r, 5)) }, until }
}

/**
 * /echo-qq/ 这一页:每 2 秒拉一次 /api/echo-qq/status。
 * 故意不引任何前端库(主页面板才用 d3):这一页只回答"通道通不通、卡在哪一段"。
 */
const $ = (id) => document.getElementById(id)

// ★ 2026-10-20：白名单编辑框"用户改过没"。
// ⚠️ **必须声明在 render() 之前** —— 这页是顶层脚本，render 由下面的 tick() 立刻调用，
//   声明放底部就是 TDZ（ReferenceError: Cannot access 'wlDirty' before initialization）。
let wlDirty = false

function set (id, text, cls) {
  const el = $(id)
  if (el === null) return
  el.textContent = text
  el.className = 'v' + (cls ? ' ' + cls : '')
}

function when (ts) {
  if (!Number(ts)) return '—'
  const d = new Date(Number(ts))
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return hh + ':' + mm + ':' + ss
}

function connClass (state) {
  if (state === 'client-connected') return 'ok'
  if (state === 'listening') return 'warn'
  return 'bad'
}

function render (s) {
  const client = s.client ?? {}
  const ch = s.channel ?? {}
  const c = ch.counters ?? {}

  set('enabled', s.enabled === true ? '开着' : '关着', s.enabled === true ? 'ok' : 'warn')
  set('listening', client.listening === true ? '监听中' : '未监听', client.listening === true ? 'ok' : 'warn')
  set('clients', String(client.clients ?? 0), (client.clients ?? 0) > 0 ? 'ok' : 'warn')
  set('stale', client.stale === true ? '心跳超时' : '正常', client.stale === true ? 'bad' : 'ok')
  set('addr', String(s.host ?? '') + ':' + String(s.port ?? ''))
  // 唯一的路 = 服务注入(旧桥的 HTTP 兜底已于 2026-09-28 退役)。
  // 这两行照旧显示"这条路通不通",只是数据来源与文案跟着退役改了。
  set('mode', ch.mode === 'service' ? '服务注入(零轮询)' : '无(主包不在)', ch.mode === 'service' ? 'ok' : 'bad')
  set('svc', ch.serviceAvailable === true ? '在' : '不在', ch.serviceAvailable === true ? 'ok' : 'warn')
  set('svcname', String(s.serviceName ?? ''))
  set('base', ch.mode === 'service' ? '服务注入' : '无', ch.mode === 'service' ? 'ok' : 'bad')
  set('cin', String(c.in ?? 0))
  set('crej', String(c.inRejected ?? 0))
  set('cout', String(c.out ?? 0))
  set('cack', String(c.ack ?? 0))
  set('cerr', String(c.errors ?? 0), (c.errors ?? 0) > 0 ? 'bad' : '')
  set('lin', when(ch.lastInboundAt))
  set('lout', when(ch.lastOutboundAt))
  set('lerr', String(ch.lastError ?? '') || '—', ch.lastError ? 'bad' : '')
  set('allow', String(s.allowlistSize ?? 0))
  set('cfgpath', String(s.dataDir ?? '') + '\\config.json')

  // ★ 2026-10-20：把服务端**解析后**的名单填进编辑框。
  //   ⚠️ 正在编辑（焦点在框里）时**不覆盖** —— 这页每 2 秒刷一次，
  //   一覆盖他打到一半的号就没了（这是诊断页，不是表单页，只能靠这个躲）。
  const wlText = Array.isArray(s.qzone?.watchList) ? s.qzone.watchList.join('\n') : ''
  const wlEl = $('wl')

  if (wlEl !== null && document.activeElement !== wlEl && !wlDirty) {
    wlEl.value = wlText
  }
  const ul = $('problems')
  if (ul !== null) {
    const items = Array.isArray(s.configProblems) ? s.configProblems : []
    ul.innerHTML = ''
    if (items.length === 0) {
      const li = document.createElement('li')
      li.textContent = '没有'
      li.className = 'ok'
      ul.appendChild(li)
    } else {
      for (const p of items) {
        const li = document.createElement('li')
        li.textContent = p
        li.className = 'warn'
        ul.appendChild(li)
      }
    }
  }
}

async function tick () {
  try {
    const res = await fetch('/api/echo-qq/status', { cache: 'no-store' })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    render(await res.json())
  } catch (err) {
    set('mode', '状态取不到:' + String(err.message ?? err), 'bad')
  }
}

tick()
setInterval(() => { tick().catch(() => {}) }, 2000)

// ---- 空间评论白名单（★ 2026-10-20）----------------------------------------
// 这个框是全页唯一的**写**操作，所以两个细节要注意：
//   ① 打了字就置 wlDirty，轮询不再覆盖它（不然 2 秒一次把输入冲掉）
//   ② 保存后清掉 wlDirty，让轮询把服务端**解析后**的结果回填（顺便验证写进去了）
const wlEl = $('wl')
if (wlEl !== null) {
  wlEl.addEventListener('input', () => { wlDirty = true })
}

async function saveWatchList () {
  const box = $('wl')
  const msg = $('wlmsg')
  if (box === null || msg === null) return
  // 一行一个（也接受逗号/空格混写）—— 交给服务端统一解析，这里只把换行纳入分隔符
  const nums = box.value.split(/[\s,，、;；]+/).map((s) => s.trim()).filter(Boolean)
  if (msg !== null) { msg.textContent = '保存中…'; msg.className = '' }
  try {
    const res = await fetch('/api/echo-qq/qzone-watchlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-echo-qq-edit': '1' },
      body: JSON.stringify({ qzoneWatchList: nums })
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok || j.ok !== true) {
      if (msg !== null) { msg.textContent = '没存成:' + String(j.reason ?? 'HTTP ' + res.status); msg.className = 'bad' }
      return
    }
    wlDirty = false
    const got = Array.isArray(j.watchList) ? j.watchList : []
    if (box !== null) box.value = got.join('\n')
    if (msg !== null) {
      msg.textContent = got.length === 0
        ? '已保存（空 = 只感知主人）'
        : '已保存，读到 ' + got.length + ' 个:' + got.join(', ')
      msg.className = 'ok'
    }
  } catch (err) {
    if (msg !== null) { msg.textContent = '没存成:' + String(err.message ?? err); msg.className = 'bad' }
  }
}

const wlSave = $('wlsave')
if (wlSave !== null) wlSave.addEventListener('click', () => { saveWatchList().catch(() => {}) })

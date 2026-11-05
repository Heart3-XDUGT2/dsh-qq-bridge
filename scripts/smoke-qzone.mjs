/**
 * 真机冒烟（临时脚本，不进仓）：拿 lib/qzone.js 直接打**正在跑的桥**。
 * 验证：白名单、鉴权头、读通路、权限校验、status 形状。
 */
import { createQzoneChannel, UGC_RIGHT } from '../lib/qzone.js'
import { DEFAULT_SETTINGS } from '../lib/config.js'

const ch = createQzoneChannel({
  settings: {
    ...DEFAULT_SETTINGS,
    qzoneEnabled: true,
    qzoneHost: '127.0.0.1',
    qzonePort: 5700,
    qzoneAccessToken: process.env.QZONE_TOK ?? '',
    qzoneDefaultUgcRight: UGC_RIGHT.PUBLIC,
    qzoneSelfUin: '3783207594'
  },
  log: (lv, m) => console.log('  [' + lv + '] ' + m)
})

console.log('=== ① status ===')
console.log('  ' + JSON.stringify(ch.status()))

console.log('=== ② 白名单（应被拒，且不发请求）===')
console.log('  ' + JSON.stringify(await ch.call('set_group_ban', {})))

console.log('=== ③ 探活 get_login_info ===')
const info = await ch.loginInfo()
console.log('  ' + JSON.stringify(info))

console.log('=== ④ 读说说 listMoods(num:2) ===')
const list = await ch.listMoods({ num: 2 })
if (list.ok) {
  console.log('  ok, 条数=' + list.items.length)
  for (const it of list.items) {
    console.log('    ' + it.createdAtText + '  tid=' + it.tid + '  赞' + it.likes + '  图' + it.imageCount)
    console.log('      ' + it.content.replace(/\s+/g, ' ').slice(0, 70))
  }
} else {
  console.log('  失败: ' + JSON.stringify(list))
}

console.log('=== ⑤ 权限必填（应被拒，且不发请求）===')
const noRight = createQzoneChannel({
  settings: { ...DEFAULT_SETTINGS, qzoneEnabled: true, qzoneAccessToken: process.env.QZONE_TOK ?? '', qzoneDefaultUgcRight: 0 },
  log: () => {}
})
console.log('  ' + JSON.stringify(await noRight.postMood({ content: '测试' })))

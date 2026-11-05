/**
 * 装机器(`scripts/install.mjs`)的测试 —— 在**临时 DSH_HOME** 里真装真卸。
 *
 * 为什么值得测:装机这件事出错的方式都很恶心 ——
 *   「登记在、装机位没了」⇒ **整个 dsh web 起不来**(主包 2026-09-26 现场);
 *   「装机位在、登记没了」⇒ DSH 起得来,但这条嘴**不挂载**(最难查的半死)。
 *   所以这里把四种状态(未装/装好/断一半/已卸)与坏 profile 都跑一遍,退出码与文件两侧都验。
 *
 * 不 spawn 出管道(stdio: 'ignore'):在受限沙箱里管道会 EPERM 假红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'install.mjs')
const NAME = 'dsh-echo-qq'

/** 跑装机器:返回退出码(输出不抓,靠退出码 + 文件状态判)。 */
function run (args, dshHome) {
  try {
    execFileSync(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: 'ignore'
    })
    return 0
  } catch (err) { return err.status ?? 1 }
}

/** 造一个像样的假 DSH_HOME(只到 profile 那一层)。 */
function makeHome () {
  const home = mkdtempSync(join(tmpdir(), 'echo-qq-install-'))
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'live' } }
  }, null, 2) + '\n', 'utf8')
  return home
}

const profilePkg = (home) => JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
const slot = (home) => join(home, 'profiles', 'web', 'node_modules', NAME)

test('装机器:装完三件套齐(装机位 junction + bundles + dependencies), --check 过', () => {
  const home = makeHome()
  try {
    assert.equal(run([], home), 0, '装机应当成功')
    // ① 装机位是 junction 且指向源码区
    assert.ok(existsSync(slot(home)), '装机位不在')
    assert.equal(lstatSync(slot(home)).isSymbolicLink(), true, 'link 装机,装机位应当是 junction')
    // ② bundles 登记
    const pkg = profilePkg(home)
    assert.ok(pkg.dsh.profile.bundles.includes(NAME), 'bundles 里没有登记')
    assert.ok(pkg.dsh.profile.bundles.includes('@deepseek-ai/dsh-base'), '别人的登记不许动')
    // ③ 依赖登记(防 pnpm wipe 后 bundles 悬空)
    assert.equal(typeof pkg.dependencies[NAME], 'string')
    assert.ok(pkg.dependencies[NAME].startsWith('link:'), '依赖该是指向源码区的 link')
    assert.ok(!pkg.dependencies[NAME].includes('\\'), 'Windows 反斜杠要转成正斜杠(pnpm 认)')
    // 幂等:再装一次还是 0,且不重复登记
    assert.equal(run([], home), 0)
    assert.equal(profilePkg(home).dsh.profile.bundles.filter((x) => x === NAME).length, 1, '不许重复登记')
    assert.equal(run(['--check'], home), 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('断一半①:装机位被删、bundles 登记还在 ⇒ --check 报错、--doctor 致命(这个状态会拦住宿主启动)', () => {
  const home = makeHome()
  try {
    assert.equal(run([], home), 0)
    rmSync(slot(home), { recursive: true, force: true }) // 模拟"登记在、文件没了"
    assert.notEqual(run(['--check'], home), 0, '--check 必须报错')
    assert.equal(run(['--doctor'], home), 1, '--doctor 应当以致命收尾(退出码 1)')
    assert.equal(run(['--remove'], home), 0, '摘登记要走得通 —— 这就是那条"救回 dsh web"的路')
    const pkg = profilePkg(home)
    assert.deepEqual(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base'])
    assert.equal(pkg.dependencies[NAME], undefined)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('断一半②:装机位在、bundles 登记没了 ⇒ --doctor 警告但不拦(DSH 起得来,嘴不挂载)', () => {
  const home = makeHome()
  try {
    assert.equal(run([], home), 0)
    const pkg = profilePkg(home)
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((x) => x !== NAME)
    writeFileSync(join(home, 'profiles', 'web', 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    assert.notEqual(run(['--check'], home), 0, '--check 要发现登记没了')
    assert.equal(run(['--doctor'], home), 0, '不是致命(宿主能起)')
    assert.equal(run([], home), 0, '重装一次应当补回登记')
    assert.equal(run(['--check'], home), 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('坏 profile 名:先拦住,别把半个登记写进去', () => {
  const home = makeHome()
  try {
    assert.equal(run(['--profile', 'qqtest'], home), 1, '没有的 profile 要报错退出')
    assert.equal(existsSync(join(home, 'profiles', 'qqtest')), false, '不许顺手造一个 profile 出来')
    assert.equal(profilePkg(home).dsh.profile.bundles.filter((x) => x === NAME).length, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('卸载:--remove 把装机位与两份登记都摘干净, 再 --doctor 只剩"未装机"信息', () => {
  const home = makeHome()
  try {
    assert.equal(run([], home), 0)
    assert.equal(run(['--remove'], home), 0)
    assert.equal(existsSync(slot(home)), false, '装机位要删掉')
    assert.equal(profilePkg(home).dependencies[NAME], undefined)
    assert.notEqual(run(['--check'], home), 0, '没装时 --check 该报错')
    assert.equal(run(['--doctor'], home), 0, '未装机只是信息,不是致命')
    // 卸干净之后再装,仍然 0
    assert.equal(run([], home), 0)
    assert.equal(run(['--check'], home), 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('未知参数要拦住(而不是默默忽略)', () => {
  const home = makeHome()
  try { assert.equal(run(['--whatever'], home), 2) } finally { rmSync(home, { recursive: true, force: true }) }
})

test('profile 的 package.json 带 BOM 也要能装(2026-09-28 我自己踩的:Set-Content -Encoding utf8 会写 BOM)', () => {
  const home = makeHome()
  try {
    const p = join(home, 'profiles', 'web', 'package.json')
    writeFileSync(p, '\uFEFF' + readFileSync(p, 'utf8'), 'utf8') // 加个 BOM
    assert.equal(run([], home), 0, '带 BOM 也要装得上(JSON.parse 见 BOM 会抛)')
    assert.equal(run(['--check'], home), 0)
    assert.equal(run(['--remove'], home), 0)
    assert.equal(profilePkg(home).dependencies[NAME], undefined)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

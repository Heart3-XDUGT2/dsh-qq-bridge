#!/usr/bin/env node
/**
 * dsh-echo-qq — 装机器(与主包 `dsh-echo` 那套同款配方,但简单得多)
 * ============================================================
 * 用法:
 *   node scripts/install.mjs                    # link 装机(junction → 源码区)+ 登记三件套
 *   node scripts/install.mjs --check            # 只校验装机状态(不改)
 *   node scripts/install.mjs --doctor           # 诊断"会拦宿主启动 / 会让插件起不来"的状态
 *   node scripts/install.mjs --remove           # 卸载(摘登记 + 删装机位)
 *   node scripts/install.mjs --profile qqtest    # 换 profile(默认 web)
 *   node scripts/install.mjs --help
 *
 * **三件套**(缺一件就是半死状态):
 *   ① `profiles/<profile>/node_modules/dsh-echo-qq` —— junction 指向源码区(link 装机);
 *   ② `profiles/<profile>/package.json` 的 `dsh.profile.bundles` 里有 "dsh-echo-qq";
 *   ③ 同一份 package.json 的 `dependencies["dsh-echo-qq"] = "link:<源码区>"`。
 *
 * **为什么必须在重启前先 `--check`**(2026-09-26 现场,主包那边栽过):
 * 只登记 ②、装机位却不在 ⇒ loader 抛 `cannot resolve profile bundle "dsh-echo-qq"`
 * ⇒ **整个 `dsh web` 起不来**。一个插件的安装方式不该有本事拦住宿主启动。
 * 反之只装机位不登记 ② ⇒ DSH 起得来,但**她这条嘴不会被挂载**(最难查的半死)。
 *
 * **本插件为什么比主包简单**:
 *   - 不 import 宿主包(一律 `ctx.get('webServer')`)⇒ 没有"链接装机解析不到 @deepseek-ai/*"那条雷;
 *   - 唯一的真依赖是 `ws`。但 link 装机时 Node 会**先把 junction 解析成真实路径**,
 *     裸 import 的解析起点因此落在源码区 —— 那里必须能解析到 `ws`。
 *     本机靠 `~/.dsh/plugins/node_modules`(junction → `~/.dsh/profiles/node_modules`)兜住;
 *     `verify()` 会**真解析一次**并打印解析到哪儿(别靠猜)。
 *
 * 开发循环:改源码 → 重启 `dsh web`(link 装机不用重跑本脚本;只有 web/ 是刷新页面就够)。
 */
import { mkdir, readFile, readdir, readlink, rm, symlink, writeFile, lstat, unlink } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyInstallBoundary } from './install-boundary.mjs'

const HELP = `dsh-echo-qq installer

Usage:
  node scripts/install.mjs                     Install (link) + register into the web profile
  node scripts/install.mjs --check             Verify installation without changing it
  node scripts/install.mjs --doctor            Diagnose states that stop dsh web / the plugin
  node scripts/install.mjs --remove            Uninstall: drop bundles + dependencies + install slot
  node scripts/install.mjs --profile <name>    Target another profile (default: web)

装机形态 = link:装机位是指向源码区的 junction,源码区即装机位(改源码重启即生效)。
Set DSH_HOME to override the default ~/.dsh location.`

const knownFlags = new Set(['--check', '--doctor', '--remove', '--help', '--profile'])
const argv = process.argv.slice(2)
const opts = { check: false, doctor: false, remove: false, help: false, profile: 'web' }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--profile') { opts.profile = String(argv[++i] ?? 'web'); continue }
  if (a.startsWith('--profile=')) { opts.profile = a.slice(10); continue }
  if (!knownFlags.has(a)) { console.error('Unknown option: ' + a); process.exit(2) }
  opts[a.slice(2)] = true
}
if (opts.help) { console.log(HELP); process.exit(0) }
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(opts.profile)) {
  console.error('Invalid profile name: use letters, numbers, underscores or hyphens.')
  process.exit(2)
}

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const sourcePackage = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
const NAME = sourcePackage.name
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', opts.profile)
const target = join(profileDir, 'node_modules', NAME)
const profilePkgPath = join(profileDir, 'package.json')
const verifyBoundary = () => verifyInstallBoundary({ home: dshHome, profile: opts.profile, name: NAME, source: sourceRoot })
await verifyBoundary()

async function readOptional (path) {
  try { return await readFile(path, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/**
 * 读 JSON,**容忍 BOM**。
 * 2026-09-28 我自己踩的:PowerShell 的 `Set-Content -Encoding utf8` 会写 BOM,
 * 而 `JSON.parse` 见 BOM 就抛 `Unexpected token '\uFEFF'` —— 装机器当场炸在半路
 * (装机位已经建好、登记只写了一半)。别人手改过 profile 的 package.json 也是这个下场。
 */
async function readJson (path) {
  const raw = await readOptional(path)
  if (raw === null) return null
  return JSON.parse(raw.replace(/^\uFEFF/, ''))
}

/** 装机位里每个相对 import 都要有着落(复制被拦腰截断是这个插件最阴的一种半死)。 */
async function checkImports (dir) {
  const missing = []
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.js')) continue
    const src = await readFile(join(dir, f), 'utf8')
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.\/[^"']+)["']/g)) {
      if (!existsSync(join(dir, m[1]))) missing.push(f + ' → ' + m[1])
    }
  }
  return missing
}

/** `ws` 从装机位能解析到吗。返回解析结果或 throw。 */
function resolveWs () {
  // **先把 junction 解析成真实路径**,再从这里解析 —— 这才是 ESM 加载插件时的行为
  // (Node 的 ESM 会 realpath 模块;link 装机时解析起点因此在源码区)。
  // 头一版直接拿 junction 路径做 CJS 解析 ⇒ 假红(生产是好的,检查方式错了)。
  const real = realpathSync(target)
  const req = createRequire(join(real, 'lib', 'index.js'))
  try { return req.resolve('ws') } catch (error) {
    throw new Error('装机位解析不到 ws(' + (error?.code ?? error?.message) + ')—— 插件起来时'
      + ' `await import("./onebot.js")` 会失败,她这条嘴直接哑掉(而且只在运行期报,装机时看不出来)。'
      + ' 修法:在插件源码目录运行 npm ci --legacy-peer-deps --ignore-scripts。不要链接私人宿主依赖目录。')
  }
}

async function verify () {
  const installed = await readJson(join(target, 'package.json'))
  if (installed === null) throw new Error('package is not installed at ' + target)
  if (installed.name !== NAME) throw new Error('installed package name mismatch: ' + installed.name)
  if (installed.version !== sourcePackage.version) {
    throw new Error('installed ' + installed.version + ' != source ' + sourcePackage.version + ' — re-run install')
  }
  if (installed.dsh?.bundle?.patch === undefined) {
    throw new Error('装机位的 package.json 没有 dsh.bundle.patch ⇒ loader 抛 "declares no dsh.bundle"')
  }
  const patchPath = join(target, installed.dsh.bundle.patch)
  if (!existsSync(patchPath)) throw new Error('bundle patch 文件缺失:' + patchPath)
  const patchText = await readFile(patchPath, 'utf8')
  if (!patchText.includes('name: ' + NAME)) {
    throw new Error('bundle patch 里的 loader entry 名字不是 ' + NAME + ' ⇒ 会抛 failed to import loader entry')
  }
  const profile = await readJson(profilePkgPath)
  if (profile === null) throw new Error('profile package.json not found: ' + profilePkgPath)
  const bundles = profile?.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.includes(NAME)) {
    throw new Error(NAME + ' is not in dsh.profile.bundles of ' + profilePkgPath
      + ' ⇒ DSH 起得来,但这条嘴不会被挂载')
  }
  const deps = profile?.dependencies ?? {}
  if (typeof deps[NAME] !== 'string') {
    throw new Error(NAME + ' 不在 ' + profilePkgPath + ' 的 dependencies 里 —— 只登记 bundles 的话,'
      + ' 别人(或你自己)wipe node_modules 后 `dsh plugin install` 不会把它装回来,而 bundles 登记还在'
      + ' ⇒ dsh web 直接起不来')
  }
  const missing = await checkImports(join(target, 'lib'))
  if (missing.length > 0) throw new Error('装机位缺文件(reload 会起不来):' + missing.join('; '))
  if (sourcePackage.dependencies?.ws) console.log('  ws: ' + resolveWs())
  console.log('Verified ' + NAME + '@' + sourcePackage.version)
  console.log('  install: ' + target)
  console.log('  profile: ' + profilePkgPath + '  (profile=' + opts.profile + ')')
  console.log('  dependency: ' + deps[NAME])
}

async function doctor () {
  const notes = []
  const installed = await readJson(join(target, 'package.json'))
  const profile = await readJson(profilePkgPath)
  const bundles = profile?.dsh?.profile?.bundles
  const listed = Array.isArray(bundles) && bundles.includes(NAME)
  const deps = profile?.dependencies ?? {}
  const declared = typeof deps[NAME] === 'string'

  if (!listed && installed === null) notes.push(['信息', '未装机 —— 插件不会被加载'])
  if (listed && installed === null) {
    notes.push(['致命', 'bundles 登记在、装机位不在:' + target
      + '\n         ⇒ loader 抛 cannot resolve profile bundle,**dsh web 起不来**'
      + '\n         ⇒ 修法:`node scripts/install.mjs`(或 `node scripts/install.mjs --remove` 先摘登记)'])
  }
  if (!listed && installed !== null) notes.push(['警告', '装机位在、bundles 登记没了:DSH 能起,但**这条嘴不挂载** ⇒ 修法:`node scripts/install.mjs`'])
  if (installed !== null) {
    if (installed.version !== sourcePackage.version) {
      notes.push(['警告', '装机位版本 ' + installed.version + ' != 源码 ' + sourcePackage.version + ' —— 重启后跑的仍是旧代码'])
    }
    try { if (sourcePackage.dependencies?.ws) resolveWs(); } catch (error) { notes.push(['致命', String(error.message)]) }
    const missing = await checkImports(join(target, 'lib'))
    if (missing.length > 0) notes.push(['致命', '装机位缺文件:' + missing.join('; ')])
  }
  if (!declared && listed) {
    notes.push(['警告', 'profile 依赖表里没有 ' + NAME + ' ⇒ 下次 `dsh plugin install` 会把它清掉,清完 bundles 登记变悬空'
      + '\n         ⇒ 修法:`node scripts/install.mjs`'])
  }
  if (!existsSync(join(dshHome, 'profiles', opts.profile))) {
    notes.push(['致命', '没有这个 profile:' + profileDir + ' —— profile 名写错了?'])
  }
  // 与主包无关但会让他白等的一条:配置里总闸/口令/白名单
  const cfgPath = join(dshHome, 'echo-qq', 'config.json')
  const cfg = await readJson(cfgPath)
  if (cfg === null) {
    notes.push(['信息', '还没有 ' + cfgPath + ' ⇒ 插件会用默认值跑(总闸关、无口令 ⇒ 只挂页面)'])
  } else {
    if (cfg.enabled !== true) notes.push(['信息', '配置里 enabled 不是 true ⇒ 插件只挂页面,不监听连接、不自报家门'])
    if (String(cfg.accessToken ?? '') === '') notes.push(['警告', 'accessToken 为空 = **拒收一切连接**(NapCat 那边填了也没用)'])
    if (!Array.isArray(cfg.allowedUsers) || cfg.allowedUsers.length === 0) notes.push(['警告', 'allowedUsers 为空 = **一律拒收**'])
    if (Number(cfg.port) > 0) {
      notes.push(['信息', '监听 ' + String(cfg.host ?? '?') + ':' + String(cfg.port) + ' —— 起来后确认这个端口没被别的程序占着'])
    }
  }
  if (notes.length === 0) {
    console.log('没问题:装机位、bundles、dependencies、bundle patch、相对 import、ws 解析、profile、配置八项都过。')
    return
  }
  for (const [level, text] of notes) console.log('[' + level + '] ' + text)
  if (notes.some(([level]) => level === '致命')) process.exitCode = 1
}

if (opts.check) { await verify(); process.exit(0) }
if (opts.doctor) { await doctor(); process.exit(process.exitCode ?? 0) }

if (opts.remove) {
  await verifyBoundary()
  if (existsSync(target)) {
    const st = await lstat(target)
    if (st.isSymbolicLink()) await unlink(target)
    else await rm(target, { recursive: true, force: true })
    console.log('Removed install at ' + target)
  } else {
    console.log('No install found at ' + target)
  }
  const profile = await readJson(profilePkgPath)
  if (profile !== null) {
    let dirty = false
    const bundles = profile?.dsh?.profile?.bundles
    if (Array.isArray(bundles) && bundles.includes(NAME)) {
      bundles.splice(bundles.indexOf(NAME), 1)
      dirty = true
      console.log('Removed ' + NAME + ' from dsh.profile.bundles')
    }
    if (profile?.dependencies && typeof profile.dependencies[NAME] === 'string') {
      delete profile.dependencies[NAME]
      dirty = true
      console.log('Removed ' + NAME + ' from profile dependencies')
    }
    if (dirty) { await verifyBoundary(); await writeFile(profilePkgPath, JSON.stringify(profile, null, 2) + '\n', 'utf8') }
  }
  console.log('Uninstall complete. Restart dsh web.')
  process.exit(0)
}

if (!existsSync(join(dshHome, 'profiles', opts.profile))) {
  console.error('✖ 没有这个 profile:' + profileDir)
  console.error('  先建一个(例如):dsh --from-default-profile web ' + opts.profile)
  process.exit(1)
}
if (!existsSync(profilePkgPath)) {
  console.error('✖ profile 里没有 package.json:' + profilePkgPath)
  process.exit(1)
}

// ---- 1. 装机位:link(junction → 源码区)。已有同向 junction 就跳过。 ----
{
  let isOurLink = false
  try {
    const st = await lstat(target)
    isOurLink = st.isSymbolicLink() && resolve(await readlink(target)) === resolve(sourceRoot)
  } catch { /* 没装过 */ }
  await verifyBoundary()
  if (!isOurLink && existsSync(target)) {
    const st = await lstat(target)
    if (st.isSymbolicLink()) await unlink(target)
    else await rm(target, { recursive: true, force: true })
    console.log('Removed old install at ' + target)
  }
  if (!isOurLink) {
    await mkdir(dirname(target), { recursive: true })
    await verifyBoundary()
    await symlink(sourceRoot, target, 'junction')
    console.log('Linked ' + target + ' → ' + sourceRoot)
  } else {
    console.log('Already linked: ' + target + ' → ' + sourceRoot)
  }
}

// ---- 2. 登记 bundles + dependencies 依赖(两道都写,才不会被 pnpm 清成悬空) ----
{
  const profile = await readJson(profilePkgPath)
  if (!Array.isArray(profile?.dsh?.profile?.bundles)) {
    console.error('✖ profile package.json 缺 dsh.profile.bundles:' + profilePkgPath)
    process.exit(1)
  }
  let dirty = false
  if (!profile.dsh.profile.bundles.includes(NAME)) {
    profile.dsh.profile.bundles.push(NAME)
    dirty = true
    console.log('Added ' + NAME + ' to dsh.profile.bundles')
  } else {
    console.log('bundles already contains ' + NAME)
  }
  const spec = 'link:' + sourceRoot.replace(/\\/g, '/')
  if (profile.dependencies === undefined) profile.dependencies = {}
  if (profile.dependencies[NAME] !== spec) {
    profile.dependencies[NAME] = spec
    dirty = true
    console.log('Registered dependency ' + NAME + ' -> ' + spec)
  } else {
    console.log('dependency already points to the source tree')
  }
  if (dirty) { await verifyBoundary(); await writeFile(profilePkgPath, JSON.stringify(profile, null, 2) + '\n', 'utf8') }
}

await verify()
console.log('Installation complete. Restart dsh web (link 装机:改源码也只需重启,web/ 刷新页面即可)。')

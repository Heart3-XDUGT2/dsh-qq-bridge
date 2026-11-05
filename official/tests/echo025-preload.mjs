// Before all imports: every data/config/DB fallback is a checked new temp tree.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
mkdirSync(fileURLToPath(new URL('../../.scratch/test-traces/', import.meta.url)), { recursive: true })
const base = resolve(tmpdir()), root = mkdtempSync(join(base, 'echo025-isolation-'))
const rel = relative(base, root)
if (!rel.startsWith('echo025-isolation-') || rel.startsWith('..') || isAbsolute(rel)) throw Error('unsafe_isolation')
for (const name of ['DSH_HOME', 'DSH_DATA_DIR', 'ECHO_DATA_DIR', 'ECHO_QQ_DATA_DIR', 'ECHO_QQ_OFFICIAL_DATA_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
  process.env[name] = join(root, name)
  mkdirSync(process.env[name])
}
process.env.ECHO_DB = join(root, 'DO-NOT-OPEN.db')
process.on('exit', () => {
  if (resolve(root) !== root || !relative(base, root).startsWith('echo025-isolation-')) throw Error('unsafe_isolation_cleanup')
  rmSync(root, { recursive: true, force: true })
})

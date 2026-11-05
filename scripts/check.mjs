import { readdir, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let checked = 0
async function walk (directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', '.scratch'].includes(entry.name)) continue
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) await walk(filename)
    else if (/\.(?:[cm]?js|json|md|ya?ml)$/u.test(entry.name)) {
      const bytes = await readFile(filename)
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) throw Error('BOM: ' + path.relative(root, filename))
      if (/\.[cm]?js$/u.test(entry.name)) {
        const result = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8', windowsHide: true })
        if (result.status !== 0) throw Error(result.stderr)
        checked++
      }
    }
  }
}
await walk(root)
console.log(JSON.stringify({ syntaxFiles: checked, utf8: true, bom: false }))

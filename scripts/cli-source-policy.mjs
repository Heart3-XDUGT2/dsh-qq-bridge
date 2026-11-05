import { createHash } from 'node:crypto'
import { lstat, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
export const CLI_SOURCE = Object.freeze({
  package: '@deepseek-ai/dsh@0.2.0-rc.2', registry: 'https://registry.npmjs.org',
  integrity: 'sha512-EAJ3gPNcVt/uv8X19PMm9NkVhWgT7xXNMk0UKCVm+IQ5rpSQOcsMUa0HWlnYYVybKMsccjcRB21vVVsaXQ6IdA=='
})
export function verifyArchive (bytes, integrity = CLI_SOURCE.integrity) {
  if ('sha512-' + createHash('sha512').update(bytes).digest('base64') !== integrity) throw Error('public_cli_integrity_mismatch')
}
export function validateMembers (members) {
  if (!Array.isArray(members) || !members.length) throw Error('invalid_public_cli_archive')
  const seen = new Set()
  for (const { name, type } of members) {
    if (typeof name !== 'string' || !name.startsWith('package/') || name.includes('\\') ||
      name.split('/').includes('..') || name.split('/').includes('.') || /[\u0000-\u001f:]/u.test(name) ||
      !['file', 'directory'].includes(type) || seen.has(name)) throw Error('unsafe_public_cli_archive_member')
    seen.add(name)
  }
  const selected = members.filter(member => member.type === 'file' &&
    (member.name === 'package/package.json' || /^package\/lib\/profile-boot-[A-Za-z0-9_-]+\.js$/u.test(member.name)))
    .map(member => member.name)
  if (!selected.includes('package/package.json') || selected.length !== 2) throw Error('public_cli_source_not_unique')
  return selected
}
export async function assertSafeDestination (root, destination) {
  const base = await realpath(root), target = path.resolve(destination)
  const relative = path.relative(path.resolve(root), target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('unsafe_public_cli_destination')
  let current = path.resolve(root)
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part)
    let entry
    try { entry = await lstat(current) } catch (error) { if (error.code === 'ENOENT') break; throw error }
    if (entry.isSymbolicLink()) throw Error('public_cli_destination_link_refused')
    const resolved = await realpath(current), within = path.relative(base, resolved)
    if (within.startsWith('..') || path.isAbsolute(within)) throw Error('unsafe_public_cli_destination')
  }
  async function inspect (directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name), info = await lstat(filename)
      if (info.isSymbolicLink()) throw Error('public_cli_destination_link_refused')
      if (info.isDirectory()) await inspect(filename)
    }
  }
  try { const info = await lstat(target); if (!info.isDirectory()) throw Error('unsafe_public_cli_destination'); await inspect(target) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}

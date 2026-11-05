import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
const contains = (parent, child) => {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}
async function existing (filename) {
  try { return await lstat(filename) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
export async function verifyInstallBoundary ({ home, profile, name, source }) {
  const base = await realpath(home), physicalSource = await realpath(source)
  let current = base
  for (const part of ['profiles', profile, 'node_modules']) {
    current = path.join(current, part)
    const info = await existing(current)
    if (!info) continue
    if (info.isSymbolicLink() || !info.isDirectory()) throw Error('unsafe_install_ancestor')
    if (!contains(base, await realpath(current))) throw Error('install_ancestor_outside_home')
  }
  const slot = path.join(current, name)
  if (!contains(base, slot) || path.dirname(slot) !== current) throw Error('unsafe_install_slot_name')
  // Source/slot containment would let replacement remove its own source.
  if (contains(physicalSource, slot) || contains(slot, physicalSource)) throw Error('source_install_overlap')
  const manifest = path.join(base, 'profiles', profile, 'package.json')
  const manifestInfo = await existing(manifest)
  if (manifestInfo && (manifestInfo.isSymbolicLink() || !manifestInfo.isFile() || manifestInfo.nlink > 1 ||
    !contains(base, await realpath(manifest)))) throw Error('unsafe_profile_manifest')
  const info = await existing(slot)
  if (info?.isSymbolicLink()) {
    let linked
    try { linked = await realpath(slot) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (linked && linked !== physicalSource && (contains(linked, physicalSource) || contains(physicalSource, linked))) {
      throw Error('source_install_overlap')
    }
  }
  if (info && !info.isSymbolicLink()) {
    const physicalSlot = await realpath(slot)
    if (!contains(base, physicalSlot)) throw Error('install_slot_outside_home')
    if (contains(physicalSource, physicalSlot) || contains(physicalSlot, physicalSource)) throw Error('source_install_overlap')
  }
  // A slot symlink/junction is allowed, but removal must only unlink that entry.
  return { home: base, slot, manifest }
}

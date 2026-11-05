// Execute the installed CLI's unchanged controller/signal blocks in isolation.
// This does not load a profile, patch node_modules or reimplement the algorithm.
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

export function installedShutdown ({ process: processApi = process, setTimeout: later = setTimeout, clearTimeout: cancel = clearTimeout } = {}) {
  // Public npm tarball is explicitly prepared without installing the CLI's
  // large runtime. No profile/global/private dependency lookup is permitted.
  const directory = fileURLToPath(new URL('../../.scratch/public-cli-source/package/lib/', import.meta.url))
  const matches = readdirSync(directory).filter(name => name.startsWith('profile-boot-') && name.endsWith('.js'))
    .map(name => join(directory, name)).filter(name => readFileSync(name, 'utf8').includes('const PROCESS_SHUTDOWN_TIMEOUT_MS ='))
  if (matches.length !== 1) throw Error('public_cli_shutdown_source_not_uniquely_resolved')
  const path = pathToFileURL(matches[0])
  const bytes = readFileSync(path), text = bytes.toString('utf8')
  const controllerStart = text.indexOf('const PROCESS_SHUTDOWN_TIMEOUT_MS =')
  const controllerEnd = text.indexOf('//#endregion', controllerStart)
  const signalsStart = text.indexOf('const shutdown = createProcessShutdown(dispose);')
  const signalsEnd = text.indexOf('installFailLoud(NAME, process,', signalsStart)
  if (controllerStart < 0 || controllerEnd < controllerStart || signalsStart < 0 || signalsEnd < signalsStart) throw Error('installed_shutdown_source_shape_changed')
  const controller = text.slice(controllerStart, controllerEnd), signals = text.slice(signalsStart, signalsEnd)
  const api = runInNewContext(`(() => {
    ${controller}
    return {
      create: createProcessShutdown,
      install: function (dispose) { ${signals} return { shutdown, signalShutdown }; }
    }
  })()`, { process: processApi, setTimeout: later, clearTimeout: cancel, AbortController })
  return {
    ...api,
    provenance: {
      path: '@deepseek-ai/dsh/lib/' + matches[0].split(/[\\/]/).at(-1),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      controllerStartLine: text.slice(0, controllerStart).split('\n').length,
      signalsStartLine: text.slice(0, signalsStart).split('\n').length,
      execution: 'exact installed controller and SIGINT/SIGTERM registration source; no full profile boot'
    }
  }
}

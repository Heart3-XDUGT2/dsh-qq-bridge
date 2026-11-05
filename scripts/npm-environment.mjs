import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
export async function isolatedNpmEnvironment (inherited = process.env) {
  const directory = await mkdtemp(path.join(tmpdir(), 'echo-npm-isolation-'))
  const user = path.join(directory, 'user.npmrc'), global = path.join(directory, 'global.npmrc')
  await writeFile(user, ''); await writeFile(global, ''); await mkdir(path.join(directory, 'cache'))
  const env = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (/^npm_config_/i.test(key) || /^(NODE_OPTIONS|NODE_PATH|DSH_HOME|DSH_DATA_DIR|ECHO_DB|ECHO_DATA_DIR|ECHO_QQ_DATA_DIR|ECHO_QQ_OFFICIAL_DATA_DIR)$/i.test(key)) continue
    env[key] = value
  }
  env.npm_config_userconfig = user
  env.npm_config_globalconfig = global
  env.npm_config_cache = path.join(directory, 'cache')
  return env
}

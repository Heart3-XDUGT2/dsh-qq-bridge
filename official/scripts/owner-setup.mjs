// Preparation tool. This command is never run against real credentials by tests.
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { runOwnerSetup } from '../lib/owner-pairing.js'

export async function main (args = process.argv.slice(2)) {
  if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--output') throw Error('setup_usage')
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await runOwnerSetup({ configPath: resolve(args[1]), outputPath: resolve(args[3]),
      ask: question => terminal.question(question), print: line => process.stdout.write(line + '\n') })
  } finally { terminal.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('配对未完成。检查本机文件、有效期和确认步骤；未启用机器人。\n'); process.exitCode = 1 })
}

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function prepare(_config, { cwd, nextRelease }) {
  const pluginPath = join(cwd, 'mods/account-switcher/.claude-plugin/plugin.json')
  const marketplacePath = join(cwd, '.claude-plugin/marketplace.json')
  const plugin = JSON.parse(await readFile(pluginPath, 'utf8'))
  const marketplace = JSON.parse(await readFile(marketplacePath, 'utf8'))
  const entry = marketplace.plugins.find(item => item.name === plugin.name)
  if (!entry) throw new Error(`Marketplace entry missing for ${plugin.name}`)
  plugin.version = nextRelease.version
  entry.version = nextRelease.version
  await writeFile(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`)
  await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`)
}

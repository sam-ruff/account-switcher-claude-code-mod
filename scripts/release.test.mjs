import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { prepare } from './release.mjs'
import { analyzeCommits } from '@semantic-release/commit-analyzer'

test('release rules follow the repository Conventional Commit policy', async () => {
  const config = JSON.parse(await readFile(new URL('../.releaserc.json', import.meta.url)))
  const [, options] = config.plugins[0]
  const logger = { log() {} }
  for (const [message, expected] of [
    ['feat: add automatic switching', 'minor'],
    ['fix: stop after all accounts are exhausted', 'patch'],
    ['refactor: simplify account selection', 'patch'],
    ['docs: describe usage', null],
    ['ci: add local runner workflow', null],
    ['feat: change account storage\n\nBREAKING CHANGE: new storage format', 'major'],
  ]) {
    assert.equal(await analyzeCommits(options, { cwd: process.cwd(), commits: [{ message }], logger }), expected)
  }
})

test('release updates both manifests and preserves their other fields', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'account-switcher-release-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  for (const dir of ['.claude-plugin', 'mods/account-switcher/.claude-plugin']) {
    await mkdir(join(cwd, dir), { recursive: true })
  }
  const pluginPath = 'mods/account-switcher/.claude-plugin/plugin.json'
  const marketPath = '.claude-plugin/marketplace.json'
  const plugin = { name: 'account-switcher', version: '0.3.0', license: 'MIT' }
  const entry = { name: 'account-switcher', source: './mods/account-switcher' }
  await writeFile(join(cwd, pluginPath), JSON.stringify(plugin))
  await writeFile(join(cwd, marketPath), JSON.stringify({ plugins: [entry] }))
  await prepare({}, { cwd, nextRelease: { version: '1.2.3' } })
  assert.deepEqual(JSON.parse(await readFile(join(cwd, pluginPath))), { ...plugin, version: '1.2.3' })
  assert.deepEqual(JSON.parse(await readFile(join(cwd, marketPath))), { plugins: [{ ...entry, version: '1.2.3' }] })
})

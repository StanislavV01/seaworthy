// @ts-check
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { scanGuard } from '../plugins/seaworthy/core/guard.js'
import { treeFingerprint } from '../plugins/seaworthy/core/git.js'
import { repo, writeFiles } from './helpers.js'

const TESTS = `import { it } from 'vitest'\nit('a', () => {})\nit('b', () => {})\nit('c', () => {})\n`

/** @param {Record<string,string>} files */
async function session(files) {
  const dir = repo({ 'src/a.test.ts': TESTS, 'src/a.ts': 'export const a = 1\n', 'package.json': '{"scripts":{"test":"vitest","dev":"vite"}}', 'tsconfig.json': '{"compilerOptions":{"strict": true}}', ...files })
  return { dir, start: await treeFingerprint(dir) }
}

/** @param {string} dir @param {string} start */
const types = async (dir, start) => (await scanGuard(dir, start)).map((e) => `${e.type}:${e.path}`)

test('test file deleted', async () => {
  const { dir, start } = await session({})
  rmSync(join(dir, 'src/a.test.ts'))
  assert.deepEqual(await types(dir, start), ['test_deleted:src/a.test.ts'])
})

test('test case removed', async () => {
  const { dir, start } = await session({})
  writeFileSync(join(dir, 'src/a.test.ts'), TESTS.replace("it('c', () => {})\n", ''))
  const ev = await scanGuard(dir, start)
  assert.equal(ev[0].type, 'test_case_removed')
  assert.match(ev[0].detail, /3 → 2/)
})

test('skips added', async () => {
  for (const s of ["it.skip('a', () => {})", "test.only('x', () => {})", "xit('a', () => {})", "it.todo('later')"]) {
    const { dir, start } = await session({})
    writeFileSync(join(dir, 'src/a.test.ts'), TESTS + s + '\n')
    assert.ok((await types(dir, start)).includes('skip_added:src/a.test.ts'), s)
  }
})

test('suppressions added', async () => {
  for (const s of ['// @ts-ignore', '// eslint-disable-next-line', '// biome-ignore lint: x', '// oxlint-disable-next-line', '// @ts-expect-error']) {
    const { dir, start } = await session({})
    writeFileSync(join(dir, 'src/a.ts'), `${s}\nexport const a = 1\n`)
    assert.deepEqual(await types(dir, start), ['suppression_added:src/a.ts'], s)
  }
})

test('config changes', async () => {
  const { dir, start } = await session({})
  writeFiles(dir, {
    'vitest.config.ts': 'export default {}\n',
    '.github/workflows/ci.yml': 'on: push\n',
    'tsconfig.json': '{"compilerOptions":{"strict": false}}',
    'package.json': '{"scripts":{"test":"true","dev":"vite --open"}}',
  })
  const t = await types(dir, start)
  assert.ok(t.includes('config_changed:vitest.config.ts'))
  assert.ok(t.includes('config_changed:.github/workflows/ci.yml'))
  assert.ok(t.includes('config_changed:tsconfig.json'))
  const pkg = (await scanGuard(dir, start)).find((e) => e.path === 'package.json')
  assert.equal(pkg?.detail, 'scripts changed: test')
})

test('normal code changes and new tests are not flagged', async () => {
  const { dir, start } = await session({})
  writeFiles(dir, { 'src/a.ts': 'export const a = 2\n', 'src/b.test.ts': "import { it } from 'vitest'\nit('new', () => {})\n", 'tsconfig.json': '{"compilerOptions":{"strict": true, "outDir": "dist"}}' })
  assert.deepEqual(await types(dir, start), [])
})

test('pre-existing changes at start are not flagged', async () => {
  const dir = repo({ 'src/a.test.ts': TESTS })
  writeFileSync(join(dir, 'src/a.test.ts'), TESTS + "it.skip('dev did this', () => {})\n")
  const start = await treeFingerprint(dir)
  assert.deepEqual(await scanGuard(dir, start), [])
})

test('ids stable across scans', async () => {
  const { dir, start } = await session({})
  rmSync(join(dir, 'src/a.test.ts'))
  const a = await scanGuard(dir, start)
  const b = await scanGuard(dir, start)
  assert.equal(a[0].id, b[0].id)
  assert.match(a[0].id, /^g-[0-9a-f]{8}$/)
})

test('moving a test out of a test location counts as deletion', async () => {
  const { dir, start } = await session({})
  rmSync(join(dir, 'src/a.test.ts'))
  writeFileSync(join(dir, 'src/a.notes.ts'), TESTS)
  const t = await types(dir, start)
  assert.ok(t.includes('test_deleted:src/a.test.ts'), t.join())
})

test('guard command exits 1 with open events', async () => {
  const { main } = await import('../plugins/seaworthy/core/cli.js')
  const { captureIO } = await import('./helpers.js')
  const { dir } = await session({})
  rmSync(join(dir, 'src/a.test.ts'))
  const c = captureIO(dir)
  assert.equal(await main(['guard'], c.io), 1)
  assert.match(c.out(), /✗ open\s+g-\w+\s+test_deleted\s+src\/a.test.ts/)
})

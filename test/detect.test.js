// @ts-check
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { detectProject } from '../plugins/seaworthy/core/detect.js'
import { FIXTURES, tmp } from './helpers.js'

const fx = (/** @type {string} */ n) => detectProject(join(FIXTURES, n))

test('packageManager field wins over lockfile', async () => {
  assert.equal((await fx('pm-field')).packageManager, 'pnpm')
})

test('lockfile order', async () => {
  assert.equal((await fx('npm')).packageManager, 'npm')
  assert.equal((await fx('pnpm')).packageManager, 'pnpm')
  assert.equal((await fx('yarn')).packageManager, 'yarn')
  assert.equal((await fx('bun')).packageManager, 'bun')
  assert.equal((await fx('bun-legacy')).packageManager, 'bun')
  assert.equal((await fx('no-scripts')).packageManager, 'npm')
})

test('scripts map to checks', async () => {
  const p = await fx('pnpm')
  assert.deepEqual(
    p.checks.map((c) => [c.id, c.cmd]),
    [
      ['lint', 'pnpm run lint'],
      ['typecheck', 'pnpm run type-check'],
      ['test', 'pnpm run test'],
    ],
  )
  assert.equal((await fx('tsc-script')).checks[0].cmd, 'npm run tsc')
})

test('npm placeholder test ignored', async () => {
  const p = await fx('placeholder-test')
  assert.deepEqual(p.checks.map((c) => c.id), ['build'])
})

test('tiers', async () => {
  assert.deepEqual((await fx('npm')).tiers, {
    fast: ['lint', 'typecheck'],
    commit: ['lint', 'typecheck', 'test'],
    push: ['lint', 'typecheck', 'test', 'build'],
  })
  assert.deepEqual((await fx('yarn')).tiers, { fast: [], commit: ['test'], push: ['test'] })
})

test('nothing recognisable is a clear error', async () => {
  await assert.rejects(detectProject(tmp()), /no checks found/)
})

test('non-JS components in subdirectories: C++ build.sh test binary + Python unittest', async () => {
  const { writeFiles } = await import('./helpers.js')
  const dir = tmp()
  writeFiles(dir, {
    'backtrack_cpp/build.sh': '#!/bin/sh\n$CXX a.cpp -o build/run_demo\n$CXX t.cpp -o build/unit_tests\n',
    'backtrack_cpp/tests/test_main.cpp': 'int main(){}\n',
    'backtrack_demo/tests/test_x.py': 'import unittest\n',
    'docs/readme.md': '# x\n',
  })
  const p = await detectProject(dir)
  assert.equal(p.packageManager, 'none')
  assert.deepEqual(p.checks.map((c) => [c.id, c.cmd]), [
    ['test', '(cd backtrack_cpp && ./build.sh && ./build/unit_tests) && (cd backtrack_demo && python3 -m unittest discover -s tests)'],
  ])
  assert.deepEqual(p.tiers.commit, ['test'])
})

test('Go, CMake + CTest and pytest at the root', async () => {
  const { writeFiles } = await import('./helpers.js')
  const go = tmp()
  writeFiles(go, { 'go.mod': 'module x\n' })
  assert.deepEqual((await detectProject(go)).checks.map((c) => c.cmd), ['go vet ./...', 'go test ./...', 'go build ./...'])
  const cm = tmp()
  writeFiles(cm, { 'CMakeLists.txt': 'enable_testing()\nadd_test(NAME t COMMAND t)\n' })
  assert.match((await detectProject(cm)).checks.find((c) => c.id === 'test')?.cmd ?? '', /ctest --test-dir build-seaworthy/)
  const py = tmp()
  writeFiles(py, { 'pyproject.toml': '[tool.pytest.ini_options]\n[tool.ruff]\n', 'tests/test_a.py': 'def test_a(): pass\n' })
  assert.deepEqual((await detectProject(py)).checks.map((c) => c.cmd), ['ruff check .', 'python3 -m pytest -q'])
})

test('per-file lint command for known linters', async () => {
  const p = await fx('pnpm')
  assert.equal(p.checks[0].perFile, 'pnpm exec eslint {files}')
  assert.equal((await fx('npm')).checks[0].perFile, 'npx eslint {files}')
})

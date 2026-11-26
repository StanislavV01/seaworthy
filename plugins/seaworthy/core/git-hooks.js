// @ts-check
import { existsSync } from 'node:fs'
import { chmod, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { git } from './git.js'

// reference-transaction (git ≥ 2.28) runs for every ref update, plumbing included (`update-ref`,
// `commit-tree` + `update-ref`, commits made by a test file or any other program). pre-commit does not.
export const HOOK_NAMES = /** @type {const} */ (['pre-commit', 'commit-msg', 'pre-push', 'reference-transaction'])
const MARK = '# seaworthy git hook'

/** @param {string} name */
export function hookScript(name) {
  return `#!/bin/sh
${MARK} (installed by \`seaworthy init\`; the previous hook, if any, runs first)
${name === 'reference-transaction' ? '[ "$1" = prepared ] || exit 0\n' : ''}prev="$(dirname "$0")/${name}.seaworthy-prev"
if [ -x "$prev" ]; then "$prev" "$@" || exit $?; fi
common="$(git rev-parse --git-common-dir 2>/dev/null)" || exit 0
cli="$common/seaworthy-core/cli.js"
[ -f "$cli" ] || exit 0
command -v node >/dev/null 2>&1 || { echo "seaworthy: node not found; git hook skipped" >&2; exit 0; }
exec node "$cli" githook ${name} "$@"
`
}

/** @param {string} cwd @param {string[]} args */
async function gitPath(cwd, args) {
  const r = await git(cwd, args)
  if (r.code !== 0) throw new Error(r.stderr.trim())
  const p = r.stdout.trim()
  return isAbsolute(p) ? p : resolve(cwd, p)
}

/**
 * Installs the backstop hooks into the effective hooks directory (honours core.hooksPath, so
 * husky and lefthook setups keep working: an existing hook is kept as `<name>.seaworthy-prev`
 * and still runs first), and copies the seaworthy core into the git dir so the hooks do not
 * depend on where the Claude Code plugin is installed.
 * @param {string} cwd
 * @returns {Promise<{ hooksDir: string, installed: string[], chained: string[] }>}
 */
export async function installGitHooks(cwd) {
  const hooksDir = await gitPath(cwd, ['rev-parse', '--git-path', 'hooks'])
  const common = await gitPath(cwd, ['rev-parse', '--git-common-dir'])
  const coreSrc = dirname(fileURLToPath(import.meta.url))
  const coreDst = join(common, 'seaworthy-core')
  await rm(coreDst, { recursive: true, force: true })
  await cp(coreSrc, coreDst, { recursive: true })
  await writeFile(join(coreDst, 'package.json'), '{ "type": "module" }\n')

  await mkdir(hooksDir, { recursive: true })
  /** @type {string[]} */
  const installed = []
  /** @type {string[]} */
  const chained = []
  for (const name of HOOK_NAMES) {
    const p = join(hooksDir, name)
    if (existsSync(p)) {
      const cur = await readFile(p, 'utf8')
      if (!cur.includes(MARK)) {
        await rename(p, `${p}.seaworthy-prev`)
        await chmod(`${p}.seaworthy-prev`, 0o755)
        chained.push(name)
      }
    }
    await writeFile(p, hookScript(name), { mode: 0o755 })
    await chmod(p, 0o755)
    installed.push(name)
  }
  return { hooksDir, installed, chained }
}

/**
 * Are seaworthy's hooks still in place? (A `husky install` can overwrite them.)
 * @param {string} cwd
 */
export async function gitHooksInstalled(cwd) {
  const hooksDir = await gitPath(cwd, ['rev-parse', '--git-path', 'hooks'])
  for (const name of HOOK_NAMES) {
    const p = join(hooksDir, name)
    if (!existsSync(p) || !(await readFile(p, 'utf8')).includes(MARK)) return false
  }
  return true
}

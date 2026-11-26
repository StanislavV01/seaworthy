// @ts-check
import { parseArgs, writeJson } from '../args.js'
import { CONFIG_FILE, configFromProject, loadConfig, saveConfig } from '../config.js'
import { detectProject } from '../detect.js'
import { crossCheck, readWorkflows } from '../workflows.js'
import { describe } from './detect.js'
import { isGitRepo } from '../git.js'
import { installGitHooks } from '../git-hooks.js'

/**
 * `seaworthy init` shows what it found; `--yes` writes `.seaworthy.json`.
 * An existing config is kept unless `--force`.
 * @type {import('../cli.js').Command}
 */
export async function run(args, io) {
  const { flags } = parseArgs(args)
  const project = await detectProject(io.cwd)
  const workflows = await readWorkflows(io.cwd)
  const warnings = crossCheck(project, workflows)
  const existing = await loadConfig(io.cwd).catch(() => null)
  const cfg = configFromProject(project)

  if (!flags.yes) {
    if (flags.json) writeJson(io.stdout, { config: cfg, warnings, exists: Boolean(existing) })
    else io.stdout.write(describe(project, workflows, warnings) + `\nRun \`seaworthy init --yes\` to write ${CONFIG_FILE}.\n`)
    return 0
  }
  if (existing && !flags.force) {
    io.stderr.write(`${CONFIG_FILE} already exists; use --force to overwrite\n`)
    return 1
  }
  await saveConfig(io.cwd, cfg)
  const hooks = await installHooksIfPossible(io.cwd)
  if (flags.json) writeJson(io.stdout, { config: cfg, warnings, written: CONFIG_FILE, gitHooks: hooks })
  else io.stdout.write(describe(project, workflows, warnings) + `\nWrote ${CONFIG_FILE}.${hooks ? ` Git hooks: ${hooks}.` : ''}\n`)
  return 0
}

/**
 * @param {string} cwd
 * @returns {Promise<string | null>}
 */
async function installHooksIfPossible(cwd) {
  if (!(await isGitRepo(cwd))) return null
  const r = await installGitHooks(cwd)
  return `${r.installed.join(', ')} in ${r.hooksDir}${r.chained.length ? ` (existing ${r.chained.join(', ')} kept and chained)` : ''}`
}

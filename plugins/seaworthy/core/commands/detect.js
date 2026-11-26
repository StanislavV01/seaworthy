// @ts-check
import { parseArgs, writeJson } from '../args.js'
import { detectProject } from '../detect.js'
import { crossCheck, readWorkflows } from '../workflows.js'

/** @type {import('../cli.js').Command} */
export async function run(args, io) {
  const { flags } = parseArgs(args)
  const project = await detectProject(io.cwd)
  const workflows = await readWorkflows(io.cwd)
  const warnings = crossCheck(project, workflows)
  if (flags.json) writeJson(io.stdout, { ...project, workflows, warnings })
  else io.stdout.write(describe(project, workflows, warnings))
  return 0
}

/**
 * @param {import('../detect.js').ProjectConfig} project
 * @param {import('../workflows.js').Workflow[]} workflows
 * @param {string[]} warnings
 */
export function describe(project, workflows, warnings) {
  const lines = [`seaworthy found:`, `  package manager  ${project.packageManager}`]
  for (const c of project.checks) lines.push(`  ${c.id.padEnd(16)} ${c.cmd}`)
  if (project.checks.length === 0) lines.push('  (no lint/typecheck/test/build scripts found)')
  lines.push(
    `  tiers            fast: ${project.tiers.fast.join(', ') || '—'} · commit: ${project.tiers.commit.join(', ') || '—'} · push: ${project.tiers.push.join(', ') || '—'}`,
  )
  lines.push(`  CI workflows     ${workflows.map((w) => w.file).join(', ') || 'none'}`)
  for (const w of warnings) lines.push(`  ! ${w}`)
  return lines.join('\n') + '\n'
}

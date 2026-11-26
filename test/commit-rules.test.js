// @ts-check
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allowedTrailerKeys, checkMessage, parseCommitArgs, trailerKeys } from '../plugins/seaworthy/core/commit-rules.js'
import { repo, sh } from './helpers.js'

test('trailer keys come from the last paragraph only', () => {
  assert.deepEqual(trailerKeys('feat: x\n\nbody\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nClaude-Session: https://x'), ['co-authored-by', 'claude-session'])
  assert.deepEqual(trailerKeys('feat: x\n\nNote: this is prose, not a trailer block\nand continues'), [])
  assert.deepEqual(trailerKeys('feat: x'), [])
})

test('Co-Authored-By rejected on a repo without such trailers', async () => {
  const dir = repo()
  const allowed = await allowedTrailerKeys(dir, null)
  const reasons = checkMessage('feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>', [], allowed)
  assert.match(reasons[0], /co-authored-by/)
})

test('trailer allowed when the repo history already uses it', async () => {
  const dir = repo()
  sh(dir, ['git', 'commit', '-q', '--allow-empty', '-m', 'chore: y\n\nSigned-off-by: Dev <d@x>'])
  const allowed = await allowedTrailerKeys(dir, { allowedTrailers: ['Reviewed-by'] })
  assert.deepEqual(checkMessage('fix: z\n\nSigned-off-by: Dev <d@x>\nReviewed-by: A <a@x>', [], allowed), [])
  assert.equal(checkMessage('fix: z', ['co-authored-by'], allowed).length, 1)
})

test('argument rules', () => {
  assert.deepEqual(parseCommitArgs(['-m', 'feat: x']).reasons, [])
  assert.deepEqual(parseCommitArgs(['-am', 'feat: x']).messages, ['feat: x'])
  assert.deepEqual(parseCommitArgs(['-F', 'msg.txt']).messageFile, 'msg.txt')
  assert.match(parseCommitArgs(['-m', 'x', '--no-verify']).reasons.join(), /no-verify/)
  assert.match(parseCommitArgs(['-nm', 'x']).reasons.join(), /no-verify/)
  assert.match(parseCommitArgs(['-m', 'x', '--author=Bot <b@x>']).reasons.join(), /someone else/)
  assert.match(parseCommitArgs(['--amend', '--no-edit']).reasons.join(), /amend/)
  assert.match(parseCommitArgs(['-C', 'HEAD']).reasons.join(), /copies another/)
  assert.match(parseCommitArgs([]).reasons.join(), /no message/)
  assert.deepEqual(parseCommitArgs(['-s', '-m', 'x']).trailers, ['signed-off-by'])
  assert.deepEqual(parseCommitArgs(['-m', 'x', '--trailer', 'Co-authored-by: Bot <b@x>']).trailers, ['co-authored-by'])
})

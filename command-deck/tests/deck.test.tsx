// Option D: the one condition, and the band it leads. The deck pane is gone,
// so the condition is read from the mod's own value.

import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { HEARTBEAT_MS } from '../hooks/features/fleet'
import { pollJitterMs } from '../hooks/features/pr-strip'
import { AMBER, RED } from '../hooks/lib/lcars'

import { BAND, DECK, NOW, ok, SESSION, START, world } from './world'

import type { DeckHeartbeat } from '../types'

const JITTER = pollJitterMs(SESSION)
const GB = 1e9 / 1024

const waiting = (more: Partial<DeckHeartbeat> = {}): DeckHeartbeat => ({
  version: 1,
  sessionId: 'other',
  repo: 'api-service',
  cwd: '/code/api-service/.claude/worktrees/dns',
  branch: 'main',
  state: 'needs-you',
  waitingOn: 'A plan waits for your approval.',
  since: NOW - 360_000,
  updatedAt: NOW - 10_000,
  activeSubagents: 0,
  costUsd: 0.4,
  ...more,
})
const beat = (w: ReturnType<typeof world>, found: DeckHeartbeat) =>
  w.files.set(`${DECK}/fleet/${found.sessionId}.json`, { text: JSON.stringify(found), mtimeMs: found.updatedAt })
const failingPr = (argv: readonly string[]) =>
  argv[1] === 'pr' && argv.includes('view')
    ? ok(
        JSON.stringify({
          number: 41,
          reviewDecision: 'REVIEW_REQUIRED',
          state: 'OPEN',
          url: 'https://github.com/acme/home/pull/41',
          statusCheckRollup: [{ __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }],
        }),
      )
    : undefined
// Under a plain look the band writes the condition and its reason in words; nominal writes none.
const conditionOf = async ($: Engine) => {
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const line = (await band.find({ type: 'Text', text: /^(Alert|Caution): / }))?.text

  await band.unmount()

  return line ?? 'nominal'
}
const bandLead = async ($: Engine) => {
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const first = (await band.findAll({ type: 'Box' })).find(box => box.props.backgroundColor !== undefined)

  await band.unmount()

  return first
}

test('the condition follows what waits, the checks, the limits and the disk, and always names its reason', async ($, on) => {
  const w = world(on)

  w.answers.push(failingPr)
  await $.session.start(START)
  await w.clock.settle()
  expect(await conditionOf($)).toBe('nominal')

  // gh answers a pull request with a failing check: caution.
  await w.clock.advance(JITTER)
  expect(await conditionOf($)).toBe('Caution: CI failing on PR #41: lint.')

  // A rate limit at 80% or more is a second caution, named after the first.
  await $.session.measure({
    context: { window: 200_000, percent: 95 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 86 }],
    changed: ['rateLimits'],
  })
  expect(await conditionOf($)).toBe('Caution: CI failing on PR #41: lint. Also: the 5h limit is at 86%.')

  // Another session starts to wait: read at the next minute, and it is an alert.
  beat(w, waiting({ updatedAt: NOW + JITTER + 30_000 }))
  await w.clock.advance(HEARTBEAT_MS)
  expect(await conditionOf($)).toBe('Alert: api-service needs you: A plan waits for your approval.')

  // This session asks a question too: two sessions wait.
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'pnpm install' } })
  expect(await conditionOf($)).toBe('Alert: 2 sessions need you.')
  await $.classic.PostToolBatch({ tool_calls: [] })

  // The other session is answered, and the disk runs low: under 20 GB is a caution, under 10 GB an alert.
  beat(w, waiting({ state: 'working', waitingOn: null, updatedAt: NOW + JITTER + 90_000 }))
  w.freeKib = 18 * GB
  await w.clock.advance(HEARTBEAT_MS)
  expect(await conditionOf($)).toBe('Caution: CI failing on PR #41: lint. Also: the 5h limit is at 86%.')
  w.freeKib = 8.4 * GB
  await w.clock.advance(HEARTBEAT_MS)
  expect(await conditionOf($)).toBe('Alert: Disk 8.4 GB free, under 10 GB.')
})

test('an alert leads the band in red, with its reason; a caution follows in amber', async ($, on) => {
  const w = world(on, {}, 'starship')

  beat(w, waiting())
  w.answers.push(failingPr)
  await $.session.start(START)
  await w.clock.advance(JITTER)
  const first = await bandLead($)

  expect(first?.text).toBe('ALERT · 1 SESSION NEEDS YOU')
  expect(first?.props.backgroundColor).toBe(RED)

  // The other session is answered: the failing check is left, a caution in amber.
  beat(w, waiting({ state: 'idle', waitingOn: null, updatedAt: NOW + JITTER + 30_000 }))
  await w.clock.advance(HEARTBEAT_MS)
  expect((await bandLead($))?.props.backgroundColor).toBe(AMBER)
})

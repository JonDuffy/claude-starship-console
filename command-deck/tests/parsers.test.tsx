// What each host command's output is read as. The samples are the commands'
// real output on this Mac on 25 Nov 2026, shortened where long. The aws sts
// sample is its documented shape: no call was made to AWS to get one.

import { expect, test } from 'claude-code/testing'

import { awsTargets, parseIdentity } from '../hooks/features/aws-guard'
import { bandSegments, bandWords, isBandQuiet } from '../hooks/features/band'
import { judgeCondition } from '../hooks/features/condition'
import { heavyStep } from '../hooks/features/disk-guard'
import { createdPrUrl, exitOf, mentionsCi, spinnerWords } from '../hooks/features/extras'
import { IGNORE_MS, parseHeartbeat, rankFleet, STALE_MS } from '../hooks/features/fleet'
import { footerLine, isPersonPrompt } from '../hooks/features/footer'
import { checksLabel, fixPrompt, parseFailure, parsePrView, pollJitterMs, ringFor, summarizeChecks, tidyLog } from '../hooks/features/pr-strip'
import { usageParts } from '../hooks/features/usage-gauge'
import { clockTime, clockTimeFrom, formatDuration, formatGrowthKb, formatKb, parseUtcOffset } from '../hooks/lib/format'
import { parseDuKb, parseFreeGb } from '../hooks/lib/host'
import { readInvocations } from '../hooks/lib/shell'

import type { DeckAgent, DeckHeartbeat, DeckPrReadout, DeckUsage } from '../types'

const PR_VIEW =
  '{"number":37,"reviewDecision":"REVIEW_REQUIRED","state":"OPEN","statusCheckRollup":[{"__typename":"CheckRun","completedAt":"2026-11-24T14:24:50Z","conclusion":"SUCCESS","detailsUrl":"https://github.com/acme/home/actions/runs/1/job/2","name":"test-and-synth","startedAt":"2026-11-24T14:23:40Z","status":"COMPLETED","workflowName":"CI"},{"__typename":"CheckRun","completedAt":"2026-11-24T14:24:51Z","conclusion":"SKIPPED","detailsUrl":"","name":"deploy","startedAt":"2026-11-24T14:24:51Z","status":"COMPLETED","workflowName":"CI"},{"__typename":"StatusContext","context":"CodeRabbit","startedAt":"2026-11-24T14:23:23Z","state":"SUCCESS","targetUrl":""}],"url":"https://github.com/acme/home/pull/37"}'

test('gh pr view is read into a number, a review state and checks', () => {
  const pr = parsePrView(PR_VIEW)

  expect(pr?.number).toBe(37)
  expect(pr?.url).toBe('https://github.com/acme/home/pull/37')
  expect(pr?.review).toBe('REVIEW_REQUIRED')
  expect(pr?.checks).toEqual([
    { name: 'test-and-synth', state: 'pass' },
    { name: 'deploy', state: 'skipped' },
    { name: 'CodeRabbit', state: 'pass' },
  ])
  expect(summarizeChecks(pr?.checks ?? [])).toBe('pass')
  // A skipped check is not counted as one that could pass.
  expect(checksLabel(pr?.checks ?? [])).toBe('checks 2/2 pass')
  expect(parsePrView('no pull requests found for branch "x"')).toBe(null)
  expect(parsePrView('[]')).toBe(null)
})

test('a check that is queued runs, one that failed or was cancelled fails', () => {
  const pr = parsePrView(
    JSON.stringify({
      number: 1,
      url: 'https://github.com/acme/home/pull/1',
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: '' },
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'CheckRun', name: 'e2e', status: 'COMPLETED', conclusion: 'CANCELLED' },
        { __typename: 'StatusContext', context: 'review-bot', state: 'PENDING' },
        { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
    }),
  )

  expect(pr?.checks.map(check => check.state)).toEqual(['running', 'fail', 'fail', 'running', 'pass'])
  expect(summarizeChecks(pr?.checks ?? [])).toBe('fail')
  expect(checksLabel(pr?.checks ?? [])).toBe('checks 1/5 pass, 2 fail, 2 running')
  expect(summarizeChecks([{ name: 'build', state: 'running' }])).toBe('running')
  expect(summarizeChecks([])).toBe('none')
})

test('a ring is due only when the settled verdict moves between passing and failing', () => {
  const failing = parsePrView(
    JSON.stringify({ number: 9, url: 'https://github.com/a/b/pull/9', statusCheckRollup: [{ __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }] }),
  )

  if (failing === null) throw new Error('sample not read')
  expect(ringFor('pass', 'fail', failing)).toBe('PR #9: checks now failing (lint)')
  expect(ringFor('fail', 'pass', failing)).toBe('PR #9: checks passing again')
  expect(ringFor('fail', 'fail', failing)).toBe(null)
  expect(ringFor('pass', 'running', failing)).toBe(null)
  // The first reading has nothing to move from.
  expect(ringFor(null, 'fail', failing)).toBe(null)
})

test('the poll jitter is under fifteen seconds and fixed for a session', () => {
  expect(pollJitterMs('session-1')).toBe(pollJitterMs('session-1'))
  expect(pollJitterMs('session-1') === pollJitterMs('session-2')).toBe(false)
  for (const id of ['a', 'session-1', '8f14e45f-ceea-467f-a9c1-f5a8d1e2b3c4']) {
    expect(pollJitterMs(id)).toBeLessThan(15_000)
    expect(pollJitterMs(id)).toBeGreaterThanOrEqual(0)
  }
})

test('df and du are read, and a du that failed on one folder still gives its total', () => {
  const dfOutput =
    'Filesystem   1024-blocks      Used Available Capacity  Mounted on\n/dev/disk3s1   482797652 354662384  73305336    83%    /System/Volumes/Data\n'

  expect(parseFreeGb(dfOutput)?.toFixed(1)).toBe('75.1')
  expect(parseFreeGb('df: /nowhere: No such file or directory')).toBe(null)
  expect(parseDuKb('1789236\t/Users/x/code/home/.claude/worktrees\n')).toBe(1_789_236)
  expect(parseDuKb('du: /x/y: Permission denied\n5559024\t/Users/x/Library/Caches\n')).toBe(5_559_024)
  expect(parseDuKb('du: /nonexistent: No such file or directory\n')).toBe(null)
})

test('sizes, growth, durations and times are written plainly', () => {
  expect(formatKb(1_789_236)).toBe('1.8 GB')
  expect(formatKb(114_732)).toBe('117 MB')
  expect(formatKb(12)).toBe('12 kB')
  expect(formatGrowthKb(2_000_000)).toBe('+2.0 GB')
  expect(formatGrowthKb(-500_000)).toBe('-512 MB')
  expect(formatGrowthKb(0)).toBe('no change')
  expect(formatDuration(850)).toBe('850ms')
  expect(formatDuration(1_234)).toBe('1.2s')
  expect(formatDuration(125_000)).toBe('2m 05s')
  expect(formatDuration(3_780_000)).toBe('1h 03m')
  expect(parseUtcOffset('+0100\n')).toBe(60)
  expect(parseUtcOffset('-0530')).toBe(-330)
  expect(parseUtcOffset('GMT')).toBe(null)
  // 1_800_000_000_000 is 2027-01-15 08:00 UTC.
  expect(clockTime(1_800_000_000_000, 60)).toBe('09:00')
  expect(clockTime(1_800_000_000_000, null)).toBe('08:00 UTC')
  expect(clockTimeFrom(1_800_000_000_000 + 3 * 86_400_000, 1_800_000_000_000, 0)).toBe('Mon 08:00')
})

test('a command line is read into the programs it starts', () => {
  expect(readInvocations('cd infra && AWS_PROFILE=dev-admin npx cdk deploy --all')).toEqual([
    { env: {}, words: ['cd', 'infra'] },
    { env: { AWS_PROFILE: 'dev-admin' }, words: ['cdk', 'deploy', '--all'] },
  ])
  expect(readInvocations('pnpm exec next build | tee out.log').map(step => step.words[0])).toEqual(['next', 'tee'])
  expect(readInvocations('/opt/homebrew/bin/aws s3 ls')[0]?.words).toEqual(['aws', 's3', 'ls'])
  expect(readInvocations('sudo -n env FOO=1 terraform apply')[0]).toEqual({ env: { FOO: '1' }, words: ['terraform', 'apply'] })
})

test('heavy steps are npm, pnpm, yarn and bun installs, next build, docker build and cdk synth', () => {
  expect(heavyStep('npm install')).toBe('npm install')
  expect(heavyStep('cd app && pnpm i --frozen-lockfile')).toBe('pnpm i')
  expect(heavyStep('npm ci')).toBe('npm ci')
  expect(heavyStep('npx next build')).toBe('next build')
  expect(heavyStep('docker buildx build -t x .')).toBe('docker buildx build')
  expect(heavyStep('pnpm cdk synth')).toBe('cdk synth')
  expect(heavyStep('npm test')).toBe(null)
  expect(heavyStep('pnpm run lint')).toBe(null)
  expect(heavyStep('echo npm install')).toBe(null)
  expect(heavyStep('docker ps')).toBe(null)
  expect(heavyStep('constructor install')).toBe(null)
})

test('a command reaches AWS unless its subcommand works offline', () => {
  expect(awsTargets('aws s3 ls --profile sandbox-admin --region eu-west-2')).toEqual([
    { program: 'aws', profile: 'sandbox-admin', region: 'eu-west-2' },
  ])
  expect(awsTargets('AWS_PROFILE=dev-admin AWS_REGION=eu-west-1 pnpm cdk deploy')).toEqual([
    { program: 'cdk', profile: 'dev-admin', region: 'eu-west-1' },
  ])
  expect(awsTargets('terraform apply -auto-approve')).toEqual([{ program: 'terraform', profile: null, region: null }])
  expect(awsTargets('cdk --profile=x diff')[0]?.profile).toBe('x')
  // A program named like something every object has is no table entry: it is read as any other program.
  for (const offline of ['cdk synth', 'npx cdk --profile x synth', 'aws configure list', 'aws --version', 'terraform fmt', 'terraform validate', 'sst version', 'aws', 'git status', 'echo aws s3 ls', 'constructor deploy', 'toString apply']) {
    expect(awsTargets(offline), offline).toEqual([])
  }
})

test('the sts answer gives a twelve-digit account or nothing', () => {
  expect(parseIdentity('{"UserId":"AIDAEXAMPLE","Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/x"}')).toBe('123456789012')
  expect(parseIdentity('{"Account":"12345"}')).toBe(null)
  expect(parseIdentity('Unable to locate credentials. You can configure credentials by running "aws configure".')).toBe(null)
})

const beat = (more: Partial<DeckHeartbeat>): DeckHeartbeat => ({
  version: 1,
  sessionId: 's',
  repo: 'home',
  cwd: '/code/home',
  branch: 'main',
  state: 'idle',
  waitingOn: null,
  since: 0,
  updatedAt: 0,
  activeSubagents: 0,
  costUsd: null,
  ...more,
})

test('the fleet board puts sessions that need the person first, marks stale ones and drops old and ended ones', () => {
  const now = 10 * 3_600_000
  const ranked = rankFleet(
    [
      beat({ sessionId: 'idle', state: 'idle', updatedAt: now - 1_000 }),
      beat({ sessionId: 'stale-needs', state: 'needs-you', updatedAt: now - STALE_MS - 1 }),
      beat({ sessionId: 'working', state: 'working', updatedAt: now - 1_000 }),
      beat({ sessionId: 'needs', state: 'needs-you', updatedAt: now - 1_000 }),
      beat({ sessionId: 'ended', state: 'ended', updatedAt: now - 1_000 }),
      beat({ sessionId: 'old', state: 'working', updatedAt: now - IGNORE_MS }),
    ],
    now,
  )

  expect(ranked.map(row => row.sessionId)).toEqual(['needs', 'working', 'idle', 'stale-needs'])
  expect(ranked.map(row => row.isStale)).toEqual([false, false, false, true])
})

test('a heartbeat file that is not one is read as nothing', () => {
  expect(parseHeartbeat(JSON.stringify(beat({ sessionId: 'a' })))?.sessionId).toBe('a')
  expect(parseHeartbeat('{"version":2}')).toBe(null)
  expect(parseHeartbeat(JSON.stringify({ ...beat({}), state: 'napping' }))).toBe(null)
  expect(parseHeartbeat('not json')).toBe(null)
})

const row = (more: Partial<DeckAgent>): DeckAgent => ({
  id: 'a',
  description: 'Explore the auth flow',
  status: 'running',
  kind: 'local_agent',
  costUsd: null,
  ...more,
})

test('the footer counts what still runs and says nothing when nothing does', () => {
  expect(footerLine([], [])).toBe(null)
  expect(footerLine([row({ status: 'completed' })], null)).toBe(null)
  expect(footerLine([row({}), row({ id: 'b', description: 'Run the tests', status: 'waiting' })], null)).toBe(
    'Still running: 2 subagents (Explore the auth flow, Run the tests).',
  )
  // A subagent the engine also lists as a background task is counted once.
  expect(
    footerLine([row({})], [
      { type: 'subagent', description: 'Explore the auth flow' },
      { type: 'shell', description: 'pnpm dev' },
      { type: 'shell', description: 'tail -f log' },
      { type: 'monitor', description: 'CI' },
    ]),
  ).toBe('Still running: 1 subagent (Explore the auth flow), 2 background shells, 1 background monitor.')
})

test('only a typed prompt counts as the person\'s: not a command, a notification or a plugin', () => {
  expect(isPersonPrompt({ origin: { kind: 'composer' } })).toBe(true)
  expect(isPersonPrompt({ origin: { kind: 'sdk' } })).toBe(true)
  expect(isPersonPrompt({ origin: { kind: 'composer' }, command: { name: 'deck', args: 'bundle' } })).toBe(false)
  expect(isPersonPrompt({ origin: { kind: 'task-notification' } })).toBe(false)
  expect(isPersonPrompt({ origin: { kind: 'composer' }, isMeta: true })).toBe(false)
})

test('the usage gauge names each window with its reset time and labels cost an estimate', () => {
  const now = 1_800_000_000_000

  expect(
    usageParts(
      {
        contextPercent: 43.4,
        rateLimits: [
          { kind: 'five_hour', percentUsed: 12, resetsAt: '2027-01-15T10:30:00Z' },
          { kind: 'seven_day', percentUsed: 30.5, resetsAt: '2027-01-19T08:00:00Z' },
        ],
        costUsd: 1.234,
        topAgent: { description: 'Explore the auth flow in depth and report', costUsd: 0.4 },
      },
      now,
      0,
    ),
  ).toEqual([
    'context 43%',
    '5h 12%, resets 10:30',
    '7d 31%, resets Tue 08:00',
    'cost est. $1.23',
    'top subagent est. $0.40 (Explore the auth flow in dept…)',
  ])
  expect(usageParts({ contextPercent: null, rateLimits: [], costUsd: null, topAgent: null }, now, 0)).toEqual([])
})

test('a Bash failure gives its exit code, and gh pr create its pull request', () => {
  expect(exitOf('Exit code 2\nmake: *** [build] Error 1', false)).toBe('exit 2')
  expect(exitOf('Command timed out after 2m 0s', false)).toBe('failed')
  expect(exitOf('whatever', true)).toBe('interrupted')
  expect(createdPrUrl('gh pr create --fill', { stdout: 'Creating pull request\nhttps://github.com/acme/home/pull/38\n' })).toBe('https://github.com/acme/home/pull/38')
  expect(createdPrUrl('gh pr create', { stdout: '', gitOperation: { pr: { number: 39, url: 'https://github.com/acme/home/pull/39' } } })).toBe('https://github.com/acme/home/pull/39')
  // Only a create call gets the link, and only a github.com pull request is one.
  expect(createdPrUrl('gh pr view', { stdout: 'https://github.com/acme/home/pull/38' })).toBe(null)
  expect(createdPrUrl('gh pr create', { stdout: 'see https://evil.example/pull/1' })).toBe(null)
  expect(createdPrUrl('gh pr create', 'Exit code 1')).toBe(null)
})

test('@ci is a word of its own, and a CI log is tidied to its tail', () => {
  expect(mentionsCi('why did @ci fail?')).toBe(true)
  expect(mentionsCi('@ci')).toBe(true)
  expect(mentionsCi('fix it, see @ci.')).toBe(true)
  expect(mentionsCi('mail me@ci.example')).toBe(false)
  expect(mentionsCi('@cinema')).toBe(false)
  const log = 'test\tTest\t﻿2026-11-18T14:56:06.4728791Z ##[group]Run pnpm test\ntest\tTest\t2026-11-18T14:56:06.4729106Z \u001b[36;1mpnpm test\u001b[0m\n'

  expect(tidyLog(log)).toBe('test\tTest\t##[group]Run pnpm test\ntest\tTest\tpnpm test\n')
  expect(tidyLog('x'.repeat(50), 20)).toBe(`(the first 30 characters are left out)\n${'x'.repeat(20)}`)
})

test('the spinner keeps the desktop\'s own step words and names the mode elsewhere', () => {
  expect(spinnerWords({ word: 'Creating notes.md', suffix: '…', mode: 'tool-use' }, 'desktop', 0)).toEqual({ word: 'Creating notes.md', suffix: '…' })
  expect(spinnerWords({ word: 'Working', suffix: '…', mode: 'thinking' }, 'desktop', 2)).toEqual({ word: 'Thinking', suffix: ' · 2 subagents running…' })
  expect(spinnerWords({ word: 'Sauteing', suffix: '…', mode: 'requesting' }, 'terminal', 1)).toEqual({ word: 'Waiting for the model', suffix: ' · 1 subagent running…' })
})

// ---- The failure read, the condition and the band

// These lines are from a real failed run of this repository's CI, shortened.
const FAILED_LOG = [
  'test-and-synth\tTest\t﻿2026-11-18T14:56:06.4728791Z ##[group]Run pnpm test',
  'test-and-synth\tTest\t2026-11-18T14:56:06.4729106Z \u001b[36;1mpnpm test\u001b[0m',
  'test-and-synth\tTest\t2026-11-18T14:56:07.0000000Z [WARN] Failed to replace env in config: ${NODE_AUTH_TOKEN}',
  'test-and-synth\tTest\t2026-11-18T14:56:17.0000000Z  ❯ tests/links.test.ts (24 tests | 1 failed) 1845ms',
  'test-and-synth\tTest\t2026-11-18T14:56:17.1000000Z  FAIL  tests/links.test.ts > the prebuild links check > passes the committed links.json',
  "test-and-synth\tTest\t2026-11-18T14:56:17.2000000Z AssertionError: expected 'cart total: 15 items\\n' to contain '14 items'",
  "test-and-synth\tTest\t2026-11-18T14:56:18.1000000Z ##[error]AssertionError: expected 'cart total: 15 items\\n' to contain '14 items'",
  'test-and-synth\tTest\t2026-11-18T14:56:18.7534844Z [ELIFECYCLE] Test failed. See above for more details.',
  'test-and-synth\tTest\t2026-11-18T14:56:18.7793949Z ##[error]Process completed with exit code 1.',
].join('\n')

test('a failed log gives the job, the step and the first line that reads as the error', () => {
  expect(parseFailure(FAILED_LOG)).toEqual({
    job: 'test-and-synth',
    step: 'Test',
    line: "AssertionError: expected 'cart total: 15 items\\n' to contain '14 items'",
  })
  // With no annotation that says more than the exit code, the first line with an error word stands in.
  expect(parseFailure('build\tCompile\t2026-11-18T14:56:06.1Z src/a.ts(3,1): error TS2304: Cannot find name x.\nbuild\tCompile\t2026-11-18T14:56:07.1Z ##[error]Process completed with exit code 2.\n')).toEqual({
    job: 'build',
    step: 'Compile',
    line: 'src/a.ts(3,1): error TS2304: Cannot find name x.',
  })
  // Nothing reads as the error: the place is still named, and no line is made up.
  expect(parseFailure('deploy\tPush\t2026-11-18T14:56:07.1Z ##[error]Process completed with exit code 1.\n')).toEqual({ job: 'deploy', step: 'Push', line: null })
  expect(parseFailure('')).toBe(null)
})

test('the Fix it prompt names the check and the step, and promises a log only when one was read', () => {
  const found = parsePrView(
    JSON.stringify({ number: 41, url: 'https://github.com/a/b/pull/41', statusCheckRollup: [
      { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ] }),
  )

  if (found === null) throw new Error('sample not read')
  expect(fixPrompt(found, { runId: 1, url: 'u', job: 'lint', step: 'eslint', line: null })).toBe(
    'Fix the failing check lint on PR #41. The failed step is eslint. Its log is attached.',
  )
  expect(fixPrompt(found, null)).toBe('Fix the failing check lint on PR #41.')
  expect(fixPrompt({ ...found, checks: [...found.checks, { name: 'e2e', state: 'fail' }] }, null)).toBe('Fix the failing checks lint, e2e on PR #41.')
})

const NO_PR: DeckPrReadout = { branch: 'feature', pr: null, reason: null, fetchedAt: 1, failure: null }
const NO_USAGE: DeckUsage = { contextPercent: null, rateLimits: [], costUsd: null, topAgent: null }
const calm = {
  now: 10 * 3_600_000,
  ownSessionId: 'me',
  status: { isMainWorking: false, waitingOn: null, state: 'idle', since: 0 } as const,
  fleet: [] as DeckHeartbeat[],
  pr: NO_PR,
  usage: NO_USAGE,
  freeGb: 72.8 as number | null,
}
const failing: DeckPrReadout = {
  ...NO_PR,
  pr: { number: 41, url: 'https://github.com/a/b/pull/41', state: 'OPEN', review: 'REVIEW_REQUIRED', checks: [{ name: 'lint', state: 'fail' }, { name: 'unit', state: 'pass' }] },
}

test('the condition is alert when something waits or the disk is nearly full, caution for checks, limits and low disk', () => {
  expect(judgeCondition(calm)).toEqual({
    level: 'nominal',
    reason: 'Nothing waits on you, no pull request on this branch, 73 GB free.',
    brief: 'NOTHING WAITS',
  })
  // Nominal says what it could not read, and claims nothing about it.
  expect(judgeCondition({ ...calm, freeGb: null, pr: { ...NO_PR, reason: 'gh not found' } }).reason).toBe(
    'Nothing waits on you, pull request not read, disk not read.',
  )
  expect(judgeCondition({ ...calm, pr: failing })).toEqual({ level: 'caution', reason: 'CI failing on PR #41: lint.', brief: 'CI FAILING PR 41' })
  expect(judgeCondition({ ...calm, usage: { ...NO_USAGE, rateLimits: [{ kind: 'seven_day', percentUsed: 80, resetsAt: null }] } }).reason).toBe(
    'The 7d limit is at 80%.',
  )
  expect(judgeCondition({ ...calm, usage: { ...NO_USAGE, rateLimits: [{ kind: 'seven_day', percentUsed: 79.9, resetsAt: null }] } }).level).toBe('nominal')
  // A full context window is routine, not a condition.
  expect(judgeCondition({ ...calm, usage: { ...NO_USAGE, contextPercent: 97 } }).level).toBe('nominal')
  expect(judgeCondition({ ...calm, freeGb: 19.9 })).toEqual({ level: 'caution', reason: 'Disk 19.9 GB free, under 20 GB.', brief: 'DISK 19.9 GB FREE' })
  expect(judgeCondition({ ...calm, freeGb: 9.9, pr: failing })).toEqual({ level: 'alert', reason: 'Disk 9.9 GB free, under 10 GB.', brief: 'DISK 9.9 GB FREE' })

  const waiting = beat({ sessionId: 'other', repo: 'pomelo', state: 'needs-you', waitingOn: 'Claude asked: ship it?', updatedAt: calm.now - 1_000 })

  expect(judgeCondition({ ...calm, fleet: [waiting] })).toEqual({ level: 'alert', reason: 'pomelo needs you: Claude asked: ship it?.', brief: '1 SESSION NEEDS YOU' })
  // This session's own heartbeat is not a second session, and a stale one no longer counts.
  expect(judgeCondition({ ...calm, fleet: [{ ...waiting, sessionId: 'me' }] }).level).toBe('nominal')
  expect(judgeCondition({ ...calm, fleet: [{ ...waiting, updatedAt: calm.now - STALE_MS }] }).level).toBe('nominal')
  expect(judgeCondition({ ...calm, fleet: [waiting], status: { ...calm.status, waitingOn: 'A plan waits for your approval.' } })).toEqual({
    level: 'alert',
    reason: '2 sessions need you.',
    brief: '2 SESSIONS NEED YOU',
  })
  expect(judgeCondition({ ...calm, status: { ...calm.status, waitingOn: 'A plan waits for your approval.' } }).reason).toBe(
    'This session needs you: A plan waits for your approval.',
  )
})

test('the starship band names the condition first, and the failure where the checks are', () => {
  const inputs = {
    condition: { level: 'caution', reason: 'CI failing on PR #41: lint.', brief: 'CI FAILING PR 41' } as const,
    pr: { ...failing, failure: { runId: 1, url: 'u', job: 'lint', step: 'eslint', line: 'x' } },
    usage: { contextPercent: 43, rateLimits: [{ kind: 'five_hour', percentUsed: 86, resetsAt: null }], costUsd: 1.234, topAgent: { description: 'Explore', costUsd: 0.4 } },
    now: 0,
    offsetMinutes: 0,
  }

  expect(bandSegments(inputs).map(segment => segment.text)).toEqual([
    'CAUTION · CI FAILING PR 41',
    'PR 41',
    'REVIEW',
    'CI FAILED 1/2',
    'LINT › ESLINT',
    'CTX 43%',
    '5H 86%',
    'EST $1.23',
    'TOP AGENT EST $0.40',
  ])
  expect(bandWords(inputs)).toEqual([
    'review required',
    'checks 1/2 pass, 1 fail',
    'failed: lint › eslint',
    'context 43%',
    '5h 86%',
    'cost est. $1.23',
    'top subagent est. $0.40 (Explore)',
  ])
  expect(isBandQuiet(inputs)).toBe(false)
  // Before anything has been read there is nothing to say, and the band draws nothing.
  expect(isBandQuiet({ ...inputs, condition: { level: 'nominal', reason: 'r', brief: 'b' }, pr: NO_PR, usage: NO_USAGE })).toBe(true)
})

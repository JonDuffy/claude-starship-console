import { expect, test } from 'claude-code/testing'

import { consoleFeed } from '../hooks/features/condition'

import type { DeckHeartbeat } from '../types'

const NOW = 1_800_000_000_000

const beat = (sessionId: string, state: DeckHeartbeat['state'], ageMs: number, repo = sessionId): DeckHeartbeat => ({
  version: 1,
  sessionId,
  repo,
  cwd: `/code/${repo}`,
  branch: 'main',
  state,
  waitingOn: null,
  since: NOW - 600_000,
  updatedAt: NOW - ageMs,
  activeSubagents: 0,
  costUsd: null,
})

test('the console feed counts live sessions and the ones waiting, and carries checks and usage', () => {
  const feed = consoleFeed({
    now: NOW,
    status: { isMainWorking: false, waitingOn: null, state: 'idle', since: 0 },
    ownSessionId: 'own',
    fleet: [
      beat('own', 'idle', 10_000, 'home'),
      beat('a', 'needs-you', 20_000, 'api-service'),
      beat('b', 'working', 30_000),
      beat('old', 'needs-you', 600_000),
      beat('gone', 'ended', 1_000),
    ],
    pr: {
      branch: 'main',
      reason: null,
      fetchedAt: NOW,
      pr: { number: 41, url: 'https://example.test/41', state: 'OPEN', review: '', checks: [
        { name: 'lint', state: 'fail' },
        { name: 'unit', state: 'pass' },
        { name: 'deploy', state: 'running' },
      ] },
      failure: { runId: 1, url: 'https://example.test/run/1', job: 'lint', step: 'eslint', line: null },
    },
    usage: {
      contextPercent: 39,
      rateLimits: [{ kind: 'seven_day', percentUsed: 49, resetsAt: null }, { kind: 'five_hour', percentUsed: 12, resetsAt: null }],
      costUsd: 107.05,
      topAgent: null,
    },
  })

  // own + a + b are fresh; "old" is stale and "gone" has ended.
  expect(feed.liveSessions).toBe(3)
  expect(feed.needsYou).toBe(1)
  expect(feed.firstWaiting).toBe('api-service')
  expect(feed.prNumber).toBe(41)
  expect([feed.checksFailing, feed.checksPassing, feed.checksRunning]).toEqual([1, 1, 1])
  expect(feed.failedStep).toBe('lint / eslint')
  expect([feed.contextPercent, feed.fiveHourPercent, feed.sevenDayPercent, feed.costUsd]).toEqual([39, 12, 49, 107.05])
})

test('this session waiting counts too, and no PR reads as null', () => {
  const feed = consoleFeed({
    now: NOW,
    status: { isMainWorking: false, waitingOn: 'A plan waits.', state: 'needs-you', since: NOW },
    ownSessionId: 'own',
    fleet: [],
    pr: { branch: null, pr: null, reason: null, fetchedAt: null, failure: null },
    usage: { contextPercent: null, rateLimits: [], costUsd: null, topAgent: null },
  })

  expect(feed.liveSessions).toBe(1)
  expect(feed.needsYou).toBe(1)
  expect(feed.prNumber).toBe(null)
  expect(feed.fiveHourPercent).toBe(null)
})

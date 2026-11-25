import { expect, test } from 'claude-code/testing'

import { readDeckFeed, starshipScene } from '../hooks/starship-scene'
import { NO_READOUTS } from '../hooks/readouts'

const view = (deckFeed: unknown) => ({
  readouts: { ...NO_READOUTS, diskFreeGb: 70, diskTotalGb: 494, cpuPercent: 40, cpuCores: 10, scannedAt: '16:45' },
  isWorking: false,
  activeSubagents: 0,
  sweptAt: 0,
  now: 0,
  deckFeed: readDeckFeed(deckFeed),
})

const FEED = {
  liveSessions: 4,
  needsYou: 2,
  firstWaiting: 'api-service',
  prNumber: 41,
  checksFailing: 1,
  checksPassing: 2,
  checksRunning: 0,
  failedStep: 'lint / eslint',
  contextPercent: 39,
  fiveHourPercent: 12,
  sevenDayPercent: 49,
  costUsd: 107.05,
}

test('with command-deck loaded, the column adds sessions, branch checks and context', () => {
  const source = starshipScene(view(FEED))

  expect(source).toContain('>NEEDS YOU<')
  expect(source).toContain('>API-SERVICE<')
  expect(source).toContain('>BRANCH CHECKS<')
  expect(source).toContain('>#41<')
  expect(source).toContain('>1 FAILED<')
  expect(source).toContain('>LINT / ESLINT<')
  expect(source).toContain('>CONTEXT<')
  expect(source).toContain('>39%<')
  expect(source).toContain('>EST $107.05<')
  expect(source).toContain('>7D 49%<')
})

test('without command-deck, the column keeps its own six blocks only', () => {
  const source = starshipScene(view(undefined))

  expect(source).not.toContain('>BRANCH CHECKS<')
  expect(source).not.toContain('>SESSIONS<')
  expect(source).toContain('>DISK FREE<')
})

test('nothing waits: the sessions block counts live sessions; no PR reads as such', () => {
  const source = starshipScene(view({ ...FEED, needsYou: 0, firstWaiting: null, prNumber: null, checksFailing: 0, checksPassing: 0 }))

  expect(source).toContain('>SESSIONS<')
  expect(source).toContain('>LIVE, NONE WAIT<')
  expect(source).toContain('>NO PR<')
})

test('words from the other mod are cleaned before they reach the markup', () => {
  const feed = readDeckFeed({ ...FEED, firstWaiting: '<script>x</script>', failedStep: 'a&b"c', prNumber: 'nine' })

  expect(feed?.firstWaiting).toBe('SCRIPTX/SCRIPT')
  expect(feed?.failedStep).toBe('ABC')
  expect(feed?.prNumber).toBe(null)
  expect(readDeckFeed('nonsense')).toBe(null)
})

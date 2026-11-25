// Feature 1: the call light (one notification when the session waits on the
// person, taken back when the wait clears) and the fleet board.

import { expect, test } from 'claude-code/testing'

import { NEEDS_YOU_DELAY_MS } from '../hooks/features/call-lights'
import { HEARTBEAT_MS, parseHeartbeat } from '../hooks/features/fleet'

import { agent, COMMAND, DECK, NOW, SESSION, START, world } from './world'

import type { DeckHeartbeat } from '../types'

const BASH = { tool_name: 'Bash', tool_input: { command: 'pnpm install' } } as const
const heartbeat = (w: ReturnType<typeof world>) => parseHeartbeat(w.files.get(`${DECK}/fleet/${SESSION}.json`)?.text ?? '')

test('a permission prompt still open after 20 seconds raises one notification, labelled with the repository', async ($, on) => {
  const w = world(on)

  await $.session.start(START)
  await w.clock.settle()
  await $.classic.PermissionRequest(BASH)
  expect(heartbeat(w)?.state).toBe('needs-you')
  await w.clock.advance(NEEDS_YOU_DELAY_MS - 1_000)
  expect(w.notes).toEqual([])
  await w.clock.advance(1_000)
  expect(w.notes).toEqual([
    { text: 'A permission prompt for Bash is open: pnpm install', title: 'home needs you', key: 'needs-you' },
  ])
  // It stays one notification however long the prompt stands.
  await w.clock.advance(120_000)
  expect(w.notes.length).toBe(1)

  // When the call ends, the notification is taken back and the session is no longer waiting.
  await $.classic.PostToolUse({ ...BASH, tool_response: {}, tool_use_id: 'tu1', duration_ms: 900 })
  expect(w.cancels).toEqual(['needs-you'])
  expect(heartbeat(w)?.state).toBe('idle')
})

test('a prompt that clears inside 20 seconds raises nothing and has nothing to take back', async ($, on) => {
  const w = world(on)

  await $.session.start(START)
  await w.clock.settle()
  for (const clear of ['done', 'failed', 'denied', 'batch', 'prompt', 'turn', 'stop'] as const) {
    await $.classic.PermissionRequest(BASH)
    await w.clock.advance(5_000)
    if (clear === 'done') await $.classic.PostToolUse({ ...BASH, tool_response: {}, tool_use_id: 'tu1' })
    if (clear === 'failed') await $.classic.PostToolUseFailure({ ...BASH, tool_use_id: 'tu1', error: 'Exit code 1' })
    if (clear === 'denied') await $.classic.PermissionDenied({ ...BASH, tool_use_id: 'tu1', reason: 'no' })
    if (clear === 'batch') await $.classic.PostToolBatch({ tool_calls: [{ ...BASH, tool_use_id: 'tu1' }] })
    if (clear === 'prompt') await $.prompt.submit({ text: 'never mind', wait: false, origin: { kind: 'composer' } })
    if (clear === 'turn') await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1' })
    if (clear === 'stop') await $.session.stop({ isTurnRunning: true })
    await w.clock.advance(60_000)
    expect(w.notes, clear).toEqual([])
    expect(heartbeat(w)?.state, clear).toBe('idle')
  }
  expect(w.cancels).toEqual([])
})

test('a prompt raised in a subagent outlives the main turn, and clears with its own batch', async ($, on) => {
  const w = world(on)

  await $.session.start(START)
  await w.clock.settle()
  await $.classic.PermissionRequest({ ...BASH, agent_id: 'a1' })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1' })
  await $.prompt.submit({ text: 'and now?', wait: false, origin: { kind: 'composer' } })
  expect(heartbeat(w)?.state).toBe('needs-you')
  await w.clock.advance(NEEDS_YOU_DELAY_MS)
  expect(w.notes.length).toBe(1)
  await $.classic.PostToolBatch({ tool_calls: [{ ...BASH, tool_use_id: 'tu1' }], agent_id: 'a1' })
  expect(w.cancels).toEqual(['needs-you'])
  expect(heartbeat(w)?.state).toBe('idle')
})

test('where no notification can be sent, the call light falls back to a toast, and /deck notify says so', async ($, on) => {
  const w = world(on)

  w.canNotify = false
  await $.session.start(START)
  await w.clock.settle()
  await $.classic.PermissionRequest(BASH)
  await w.clock.advance(NEEDS_YOU_DELAY_MS)
  expect(w.toasts).toEqual(['home needs you: A permission prompt for Bash is open: pnpm install'])
  await $.classic.PostToolUse({ ...BASH, tool_response: {}, tool_use_id: 'tu1' })
  // Nothing was sent, so there is nothing to take back.
  expect(w.cancels).toEqual([])
  expect((await $.command.run({ ...COMMAND, command: 'deck', args: 'notify' })).text).toBe(
    'No notification was sent: no-surface. Here the call light falls back to a toast inside the app.',
  )
})

test('a question holds the session for the person until it is answered', async ($, on) => {
  const w = world(on)
  let answer: () => void = () => undefined

  w.held = new Promise<void>(resolve => {
    answer = resolve
  })
  await $.session.start(START)
  await w.clock.settle()
  const asked = $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Deploy to staging first?', header: 'Deploy', options: [{ label: 'Yes', description: 'y' }, { label: 'No', description: 'n' }], multiSelect: false }],
  })

  // The call was started and not awaited: let it reach the dialog before time moves.
  await w.clock.settle()
  expect(heartbeat(w)?.state).toBe('needs-you')
  await w.clock.advance(NEEDS_YOU_DELAY_MS)
  expect(w.notes.map(note => note.text)).toEqual(['Claude asked: Deploy to staging first?'])
  expect(heartbeat(w)?.waitingOn).toBe('Claude asked: Deploy to staging first?')
  answer()
  await asked
  expect(w.cancels).toEqual(['needs-you'])
  expect(heartbeat(w)?.state).toBe('idle')
})

test('the heartbeat follows the turn and its subagents, and says ended as the session closes', async ($, on) => {
  const w = world(on)

  w.usage = { ...w.usage, cost: { usd: 2.5 } }
  await $.session.start(START)
  await w.clock.settle()
  expect(heartbeat(w)).toMatchObject({ version: 1, sessionId: SESSION, repo: 'home', branch: 'feature', state: 'idle', costUsd: 2.5 })

  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(heartbeat(w)?.state).toBe('working')
  w.agents = [agent({ id: 'a1' })]
  await $.turn.start({ text: 'look', turnId: 't2', agentId: 'a1' })
  await $.turn.complete({ answer: 'started one', durationMs: 5, isAborted: false, reason: 'answer', turnId: 't1' })
  // The main turn ended and a subagent still runs: the session is still working.
  expect(heartbeat(w)).toMatchObject({ state: 'working', activeSubagents: 1 })
  w.agents = [agent({ id: 'a1', status: 'completed' })]
  await $.turn.complete({ answer: 'found it', durationMs: 5, isAborted: false, reason: 'answer', turnId: 't2', agentId: 'a1' })
  expect(heartbeat(w)).toMatchObject({ state: 'idle', activeSubagents: 0 })

  // It is written again each minute, so the board can tell a live session from a gone one.
  const before = heartbeat(w)?.updatedAt ?? 0

  await w.clock.advance(HEARTBEAT_MS)
  expect(heartbeat(w)?.updatedAt).toBe(before + HEARTBEAT_MS)
  await $.session.end({ reason: 'other', sessionId: SESSION, resume: { id: SESSION } })
  expect(heartbeat(w)?.state).toBe('ended')
})

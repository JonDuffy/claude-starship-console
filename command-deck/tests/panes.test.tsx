// What still runs from the first build without a pane: the usage gauge,
// subagent toasts and the end-of-turn footer.

import { expect, test } from 'claude-code/testing'

import { agent, BAND, CWD, HOME, NOW, ok, REPO, START, world } from './world'

const ENDED = { durationMs: 185_000, isAborted: false, reason: 'answer' } as const

test('the usage gauge follows what the engine measures, and labels cost an estimate', async ($, on) => {
  const w = world(on)

  w.usage = { ...w.usage, context: { window: 200_000, tokens: 20_000, percent: 10 }, cost: { usd: 0.5 } }
  await $.session.start(START)
  await w.clock.settle()
  const first = await $.ui.mount({ ...BAND, surface: 'desktop' })

  // Offset +0100 from `date +%z`: no reset time yet, so none is shown.
  expect((await first.find({ type: 'Text', text: /context/ }))?.text).toBe('context 10% · cost est. $0.50')
  await first.unmount()

  w.agents = [agent({ id: 'a1', description: 'Explore routes', cost: { usd: 0.31 } }), agent({ id: 'a2', description: 'Cheap one', cost: { usd: 0.02 } })]
  await $.turn.start({ text: 'look', turnId: 't2', agentId: 'a1' })
  await $.session.measure({
    context: { window: 200_000, tokens: 172_000, percent: 86 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 41.5, resetsAt: '2027-01-15T10:30:00Z' },
      { kind: 'seven_day', percentUsed: 12, resetsAt: '2027-01-20T08:00:00Z' },
    ],
    cost: { usd: 3.456 },
    changed: ['context', 'rateLimits', 'cost'],
  })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const row = await ui.find({ type: 'Text', text: /context/ })

    expect(row?.text).toBe(
      'context 86% · 5h 42%, resets 11:30 · 7d 12%, resets Wed 09:00 · cost est. $3.46 · top subagent est. $0.31 (Explore routes)',
    )
    // Nothing is wrong, so the line is dim: colour is kept for a condition.
    expect(row?.props.dimColor).toBe(true)
    await ui.unmount()
  }
})

test('a subagent that finishes or fails is toasted and listed; the footer says what still runs', async ($, on) => {
  const w = world(on)

  await $.session.start(START)
  await w.clock.settle()
  await $.prompt.submit({ text: 'review the auth flow', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'review the auth flow', turnId: 't1' })
  w.agents = [agent({ id: 'a1', description: 'Explore the auth flow' }), agent({ id: 'a2', description: 'Run the tests' })]
  await $.turn.start({ text: 'explore', turnId: 't2', agentId: 'a1' })
  await $.turn.start({ text: 'test', turnId: 't3', agentId: 'a2' })

  // The main turn ends while both still run, and a background shell with them.
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [
      { id: 'a1', type: 'subagent', status: 'running', description: 'Explore the auth flow' },
      { id: 'b1', type: 'shell', status: 'running', description: 'pnpm dev', command: 'pnpm dev' },
    ],
  })
  const ended = await $.turn.complete({ ...ENDED, answer: 'Two agents are on it.', turnId: 't1' })

  expect(ended.text).toBe('Still running: 2 subagents (Explore the auth flow, Run the tests), 1 background shell.')

  await w.clock.advance(60_000)
  w.agents = [agent({ id: 'a1', description: 'Explore the auth flow', status: 'completed' }), agent({ id: 'a2', description: 'Run the tests' })]
  await $.turn.complete({ ...ENDED, answer: 'done', turnId: 't2', agentId: 'a1' })
  w.agents = [agent({ id: 'a1', description: 'Explore the auth flow', status: 'completed' }), agent({ id: 'a2', description: 'Run the tests', status: 'failed' })]
  await $.turn.complete({ ...ENDED, reason: 'error', answer: '', turnId: 't3', agentId: 'a2' })
  await $.classic.PostToolUseFailure({ tool_name: 'Bash', tool_input: { command: 'pnpm test' }, tool_use_id: 'tu9', error: 'Exit code 1\n3 tests failed', agent_id: 'a2' })
  // An interrupt is the person's own doing, not news.
  await $.classic.PostToolUseFailure({ tool_name: 'Bash', tool_input: { command: 'sleep 99' }, tool_use_id: 'tu10', error: 'Interrupted', is_interrupt: true })
  expect(w.toasts).toEqual(['Subagent finished: Explore the auth flow', 'Subagent failed: Run the tests'])

})

test('with nothing still running the answer is left as it is, and a subagent\'s answer is never given a footer', async ($, on) => {
  const w = world(on)

  await $.session.start(START)
  await w.clock.settle()
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect((await $.turn.complete({ ...ENDED, answer: 'All done.', turnId: 't1' })).text).toBe('All done.')

  // A Stop heard in an earlier turn says nothing about this one.
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'pnpm dev' }] })
  await $.turn.start({ text: 'again', turnId: 't2' })
  expect((await $.turn.complete({ ...ENDED, answer: 'Done again.', turnId: 't2' })).text).toBe('Done again.')

  w.agents = [agent({ id: 'a1' }), agent({ id: 'a2' })]
  await $.turn.start({ text: 'sub', turnId: 't3', agentId: 'a1' })
  expect((await $.turn.complete({ ...ENDED, answer: 'sub answer', turnId: 't3', agentId: 'a1' })).text).toBe('sub answer')
})

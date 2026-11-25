// Feature 1a, call lights: when this session waits on the person, one native
// notification labelled with the repository, taken back if the wait clears.
//
// What is known exactly: a question or a plan approval, from the tool call
// that holds it open. What is known only roughly: a permission prompt. The
// engine says when one is raised, and when its tool call later ends, but not
// when the person answered it. A prompt answered quickly whose command then
// runs past the delay still raises the notification.

import type { EngineInterface, Timer } from 'claude-code'

import { cut } from '../lib/format'
import { currentPlace } from '../lib/host'
import { readAgents, readStatus, writeStatus } from '../state'
import { syncCondition } from './condition'
import { isActiveAgent, writeHeartbeat } from './fleet'

import type { DeckSessionState } from '../../types'

/** How long a wait must stand before the notification is raised. */
export const NEEDS_YOU_DELAY_MS = 20_000
const NOTIFY_KEY = 'needs-you'

type Wait = { label: string; timer: Timer | null; isNotified: boolean }

// Held by the module: a hot reload forgets the waits, and their timers stop.
const waits = new Map<string, Wait>()

export function stateOf(isMainWorking: boolean, activeSubagents: number, waitingOn: string | null): DeckSessionState {
  if (waitingOn !== null) {
    return 'needs-you'
  }

  return isMainWorking || activeSubagents > 0 ? 'working' : 'idle'
}

// Events arrive side by side (a turn starting while a subagent ends): each
// publish reads the state and writes it, so they go one at a time.
let publishing: Promise<void> = Promise.resolve()

/** Works the session's state out again, and writes the heartbeat when it moved. */
export function publishStatus($: EngineInterface, change: { isMainWorking?: boolean } = {}): Promise<void> {
  publishing = publishing.then(
    () => publishNow($, change),
    () => publishNow($, change),
  )

  return publishing
}

async function publishNow($: EngineInterface, change: { isMainWorking?: boolean }): Promise<void> {
  const waitingOn = [...waits.values()].at(-1)?.label ?? null
  const now = await $.clock.now()
  const active = (await readAgents($)).filter(agent => isActiveAgent(agent.status)).length
  const before = await readStatus($)
  const isMainWorking = change.isMainWorking ?? before.isMainWorking
  const state = stateOf(isMainWorking, active, waitingOn)

  if (state === before.state && waitingOn === before.waitingOn && isMainWorking === before.isMainWorking) {
    return
  }
  await writeStatus($, () => ({
    isMainWorking,
    waitingOn,
    state,
    since: state === before.state && before.since !== 0 ? before.since : now,
  }))
  await writeHeartbeat($)
  await syncCondition($)
}

async function raise($: EngineInterface, key: string, wait: Wait): Promise<void> {
  try {
    const place = await currentPlace($)

    if (waits.get(key) !== wait) {
      return
    }
    const title = `${place.repoName} needs you`
    const sent = await $.ui.notify(wait.label, { title, key: NOTIFY_KEY })

    wait.isNotified = sent.isSent
    if (!sent.isSent) {
      // No native notification here: say it in the app at least.
      $.ui.toast(`${title}: ${wait.label}`, { timeoutMs: 15_000 })
      $.ui.log(`command-deck: the call light was not sent as a notification (${sent.reason})`, { to: 'debug' })
    } else if (waits.get(key) !== wait) {
      // It cleared while the notification was on its way out.
      await takeBack($)
    }
  } catch {
    // A notification that cannot be raised must not fail the hook that asked.
  }
}

/** `/deck notify`: raises the call light's notification now, and says what the app answered. */
export async function testCallLight($: EngineInterface): Promise<string> {
  const place = await currentPlace($)
  const sent = await $.ui.notify('This is a test of the command-deck call light.', {
    title: `${place.repoName} needs you`,
    key: `${NOTIFY_KEY}-test`,
  })

  return sent.isSent
    ? `Notification handed to "${sent.channel}". If none appeared, the app or macOS did not show it.`
    : `No notification was sent: ${sent.reason}. Here the call light falls back to a toast inside the app.`
}

async function takeBack($: EngineInterface): Promise<void> {
  if ([...waits.values()].some(wait => wait.isNotified)) {
    return
  }
  try {
    await $.ui.cancelNotify(NOTIFY_KEY)
  } catch {
    // An engine without cancelNotify, or a host that holds nothing to cancel.
  }
}

export async function beginWait($: EngineInterface, key: string, label: string): Promise<void> {
  if (waits.has(key)) {
    return
  }
  const wait: Wait = { label, timer: null, isNotified: false }

  waits.set(key, wait)
  wait.timer = $.clock.after(NEEDS_YOU_DELAY_MS, () => void raise($, key, wait))
  await publishStatus($)
}

export async function endWait($: EngineInterface, key: string): Promise<void> {
  const wait = waits.get(key)

  if (wait === undefined) {
    return
  }
  waits.delete(key)
  wait.timer?.cancel()
  if (wait.isNotified) {
    await takeBack($)
  }
  await publishStatus($)
}

type PermissionEvent = { agent_id?: string; tool_name: string; tool_input: unknown }

// A permission request carries no call id, so it is known by its loop, tool and input.
export function permissionKey(e: PermissionEvent): string {
  let input = ''

  try {
    input = JSON.stringify(e.tool_input) ?? ''
  } catch {
    // An input that does not serialize is known by its loop and tool alone.
  }

  return `permission:${e.agent_id ?? 'main'}:${e.tool_name}:${input.slice(0, 2_000)}`
}

const isPermissionHeld = () => [...waits.keys()].some(key => key.startsWith('permission:'))

export function beginPermissionWait($: EngineInterface, e: PermissionEvent): Promise<void> {
  return beginWait($, permissionKey(e), permissionLabel(e.tool_name, e.tool_input))
}

/** Ends the wait of the prompt for this call, if one stands. Most calls raise no prompt, and cost nothing here. */
export async function endPermissionWait($: EngineInterface, e: PermissionEvent): Promise<void> {
  if (isPermissionHeld()) {
    await endWait($, permissionKey(e))
  }
}

/** Ends every permission wait of one loop, the main conversation's when no agent is named: its tool calls all resolved, its turn ended, or the person is typing to it. */
export async function endPermissionWaits($: EngineInterface, agentId?: string): Promise<void> {
  const prefix = `permission:${agentId ?? 'main'}:`

  for (const key of [...waits.keys()].filter(held => held.startsWith(prefix))) {
    await endWait($, key)
  }
}

export function permissionLabel(toolName: string, toolInput: unknown): string {
  const command =
    typeof toolInput === 'object' && toolInput !== null ? (toolInput as { command?: unknown }).command : undefined

  return typeof command === 'string'
    ? `A permission prompt for ${toolName} is open: ${cut(command, 100)}`
    : `A permission prompt for ${toolName} is open.`
}

export function questionLabel(tool: string, input: unknown): string {
  if (tool === 'ExitPlanMode') {
    return 'A plan waits for your approval.'
  }
  const questions = typeof input === 'object' && input !== null ? (input as { questions?: unknown }).questions : undefined
  const first: unknown = Array.isArray(questions) ? questions[0] : undefined
  const question =
    typeof first === 'object' && first !== null ? (first as { question?: unknown }).question : undefined

  return typeof question === 'string' ? `Claude asked: ${cut(question, 120)}` : 'Claude asked a question.'
}

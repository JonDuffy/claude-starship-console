// The end-of-turn footer: a factual line under the answer saying what is
// still running. No model is asked whether the work is done: these are counts.

import { cut, plural } from '../lib/format'
import { isActiveAgent } from './fleet'

import type { DeckAgent } from '../../types'

/** One piece of background work the engine listed as the turn stopped. */
export type BackgroundTask = { type: string; description: string }

// What the engine listed at the main turn's Stop, kept for that turn's
// footer; null when no Stop has been heard since the turn began.
let tasksAtStop: BackgroundTask[] | null = null

export function noteTurnStart(): void {
  tasksAtStop = null
}

export function noteStop(tasks: readonly BackgroundTask[] | undefined): void {
  tasksAtStop = (tasks ?? []).map(task => ({ type: task.type, description: task.description }))
}

/**
 * The footer's text: the subagents and background tasks still running as the
 * turn ends, or null when none are. Subagents come from the session's own
 * list, so a task the engine lists as a subagent is not counted twice.
 */
export function footerLine(rows: readonly DeckAgent[], tasks: readonly BackgroundTask[] | null): string | null {
  const running = rows.filter(row => isActiveAgent(row.status))
  const others = (tasks ?? []).filter(task => task.type !== 'subagent')
  const parts: string[] = []

  if (running.length > 0) {
    const names = running.slice(0, 3).map(row => cut(row.description, 40))
    const more = running.length > 3 ? `, and ${running.length - 3} more` : ''

    parts.push(`${plural(running.length, 'subagent')} (${names.join(', ')}${more})`)
  }
  for (const type of [...new Set(others.map(task => task.type))]) {
    parts.push(plural(others.filter(task => task.type === type).length, `background ${type}`))
  }

  return parts.length === 0 ? null : `Still running: ${parts.join(', ')}.`
}

export function currentFooter(rows: readonly DeckAgent[]): string | null {
  return footerLine(rows, tasksAtStop)
}

/** Whether a submitted prompt is the person's own typed prompt, not a command or a delivery. */
export function isPersonPrompt(e: { isMeta?: true; command?: unknown; origin: { kind: string } }): boolean {
  return (
    e.isMeta !== true && e.command === undefined && ['composer', 'bridge', 'sdk'].includes(e.origin.kind)
  )
}

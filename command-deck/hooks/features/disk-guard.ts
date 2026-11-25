// The disk guard: before a heavy command runs with little space free, the
// person is asked. It reads free space and nothing else, and deletes nothing.

import type { EngineInterface } from 'claude-code'

import { lookUp } from '../lib/format'
import { homeFolder, readFreeGb } from '../lib/host'
import { readInvocations } from '../lib/shell'

/** Under this much free space a heavy command is asked about first. */
export const LOW_DISK_GB = 20
const FREE_KEPT_MS = 60_000

const HEAVY: Record<string, (words: readonly string[]) => boolean> = {
  npm: words => ['install', 'i', 'ci', 'add'].includes(words[1] ?? ''),
  pnpm: words => ['install', 'i', 'add'].includes(words[1] ?? ''),
  yarn: words => words.length === 1 || ['install', 'add'].includes(words[1] ?? ''),
  bun: words => ['install', 'i', 'add'].includes(words[1] ?? ''),
  next: words => words[1] === 'build',
  docker: words => words[1] === 'build' || (['buildx', 'compose'].includes(words[1] ?? '') && words[2] === 'build'),
  cdk: words => ['synth', 'synthesize'].includes(words[1] ?? ''),
}

/** The heavy step a command line holds (`npm install`, `docker build`), or null. */
export function heavyStep(command: string): string | null {
  for (const { words } of readInvocations(command)) {
    if (lookUp(HEAVY, words[0] ?? '')?.(words) === true) {
      return words.slice(0, words[0] === 'docker' && words[1] !== 'build' ? 3 : 2).join(' ')
    }
  }

  return null
}

let keptFree: { at: number; gb: number | null } | null = null

export type GuardVerdict = { kind: 'pass' } | { kind: 'ask'; reason: string } | { kind: 'deny'; reason: string }

/** Asks before a heavy command when under 20 GB is free. Free space that cannot be read stops nothing. */
export async function judgeDisk($: EngineInterface, command: string): Promise<GuardVerdict> {
  const step = heavyStep(command)

  if (step === null) {
    return { kind: 'pass' }
  }
  const now = await $.clock.now()

  if (keptFree === null || now - keptFree.at >= FREE_KEPT_MS) {
    keptFree = { at: now, gb: await readFreeGb($, (await homeFolder($)) ?? (await $.session.cwd())) }
  }
  const free = keptFree.gb

  return free === null || free >= LOW_DISK_GB
    ? { kind: 'pass' }
    : {
        kind: 'ask',
        reason: `command-deck disk guard: ${free.toFixed(1)} GB free, under ${LOW_DISK_GB} GB. "${step}" can use several GB.`,
      }
}

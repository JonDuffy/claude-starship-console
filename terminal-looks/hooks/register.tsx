import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ThemeSetArgs, Timer } from 'claude-code'

import { catppuccin, colorProblems, starship, starshipSceneName, starshipSilent, starshipWithCuesAlone } from './looks'
import { countActiveSubagents, NO_READOUTS, scanGithub, scanMac } from './readouts'
import type { GithubScan } from './readouts'
import { describeConsole, readDeckCondition, readDeckFeed, starshipScene, TRACE_LENGTH } from './starship-scene'

// What the console scene draws from, kept in the session so it outlives a
// reload. Change the tag when a readout's fields change: it declines what an
// earlier version stored.
const readouts = atom({ plugin: 'terminal-looks', key: 'readouts' } as const, NO_READOUTS, {
  shape: 'readouts-2',
})
const isWorking = atom({ plugin: 'terminal-looks', key: 'isWorking' } as const, false)
const activeSubagents = atom({ plugin: 'terminal-looks', key: 'activeSubagents' } as const, 0)
const sweptAt = atom({ plugin: 'terminal-looks', key: 'sweptAt' } as const, 0)
// The look that is on, kept where another mod can read it.
const look = atom({ plugin: 'terminal-looks', key: 'look' } as const, null)

async function noteLook($: EngineInterface, name: string): Promise<void> {
  if ((await read($, look)) !== name) {
    await update($, look, () => name)
  }
}

// command-deck's condition, read from that mod's own value without its
// contract: this mod loads whether or not that one does, and reads nothing
// when it is absent.
async function readDeck($: EngineInterface): Promise<unknown> {
  const held: { value?: unknown } = await $.state.get({ plugin: 'command-deck', key: 'condition' } as never)

  return held.value
}

// command-deck's summary for the console's extra blocks, read the same way.
async function readDeckSummary($: EngineInterface): Promise<unknown> {
  const held: { value?: unknown } = await $.state.get({ plugin: 'command-deck', key: 'console' } as never)

  return held.value
}

// Each look, then what to set in its place when the app refuses it for its
// sound: the cues it took before, then no sound at all.
const LOOKS: Record<string, readonly ThemeSetArgs[]> = {
  catppuccin: [catppuccin],
  starship: [starship, starshipWithCuesAlone, starshipSilent],
}
const DEFAULT_LOOK = 'catppuccin'

async function applyLook($: EngineInterface, name: string): Promise<string> {
  const versions = LOOKS[name]

  if (versions === undefined) {
    return `No look called "${name}". Try: ${Object.keys(LOOKS).join(', ')}, or off.`
  }
  const unpainted = colorProblems[name as keyof typeof colorProblems].find(line =>
    line.startsWith("Desktop won't paint"),
  )

  if (unpainted !== undefined) {
    $.ui.toast(unpainted)
  }
  let set
  let refusal: unknown

  for (const version of versions) {
    try {
      set = await $.theme.set(version)
      break
    } catch (error) {
      refusal = error
      $.ui.log(`Look refused as set: ${String(error)}`)
    }
  }
  if (set === undefined) {
    throw refusal
  }
  await noteLook($, name)

  return set.isDrawn ? `Look set: ${name}.` : `Look set: ${name}, but nothing draws here: ${set.reason}`
}

// The console's readouts are read on timers while the starship look is on:
// the Mac's own every half minute, GitHub every three minutes.
const MAC_SCAN_MS = 30_000
const GITHUB_SCAN_MS = 180_000
// A click reads the Mac again at once, and GitHub if its answer is this old.
const GITHUB_RESCAN_MS = 60_000
const RESCAN_MS = 2_000

let scans: Timer[] = []
let githubScannedAt = 0

// Writes the count only when it changed, so an unchanged one draws nothing.
async function setActiveSubagents($: EngineInterface, active: number): Promise<void> {
  if ((await read($, activeSubagents)) !== active) {
    await update($, activeSubagents, () => active)
  }
}

// A scan that fails leaves the readouts as they were, and the scene with
// them, so neither of these throws.
async function scanMacNow($: EngineInterface): Promise<void> {
  try {
    const [mac, active] = await Promise.all([scanMac($), countActiveSubagents($)])

    await update($, readouts, last => ({
      ...last,
      ...mac,
      cpuTrace: mac.cpuPercent === null ? last.cpuTrace : [...last.cpuTrace, mac.cpuPercent].slice(-TRACE_LENGTH),
    }))
    await setActiveSubagents($, active)
  } catch (error) {
    $.ui.log(`Console scan of the Mac failed: ${String(error)}`, { to: 'debug' })
  }
}

// GitHub's answer is shared through the plugin's store, so every session on
// the starship look reuses one answer instead of each asking GitHub itself.
const GITHUB_CACHE_KEY = 'githubCache'
type GithubCache = { atMs: number; scan: GithubScan }
let isGithubScanRunning = false

function readGithubCache(value: unknown): GithubCache | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { atMs, scan } = value as Partial<GithubCache>

  return typeof atMs === 'number' && typeof scan === 'object' && scan !== null ? { atMs, scan } : null
}

// `maxAgeMs` is how old a shared answer may be and still be used.
async function scanGithubNow($: EngineInterface, maxAgeMs = GITHUB_SCAN_MS - 10_000): Promise<void> {
  if (isGithubScanRunning) {
    return
  }
  isGithubScanRunning = true
  try {
    const now = await $.clock.now()
    const cached = readGithubCache(await $.store.get(GITHUB_CACHE_KEY))
    let github: GithubScan

    if (cached !== null && now - cached.atMs < maxAgeMs) {
      github = cached.scan
    } else {
      github = await scanGithub($)
      if (github.reviewRequests !== null || github.openPullRequests !== null) {
        await $.store.set(GITHUB_CACHE_KEY, { atMs: await $.clock.now(), scan: github })
      }
    }
    // Counted as fresh only once an answer came back, so a failed scan is retried.
    if (github.reviewRequests !== null || github.openPullRequests !== null) {
      githubScannedAt = now
    }
    await update($, readouts, last => ({ ...last, ...github }))
  } catch (error) {
    $.ui.log(`Console scan of GitHub failed: ${String(error)}`, { to: 'debug' })
  } finally {
    isGithubScanRunning = false
  }
}

function stopScans(): void {
  for (const timer of scans) {
    timer.cancel()
  }
  scans = []
}

function startScans($: EngineInterface): void {
  stopScans()
  void scanMacNow($)
  void scanGithubNow($)
  scans = [
    $.clock.every(MAC_SCAN_MS, () => void scanMacNow($)),
    $.clock.every(GITHUB_SCAN_MS, () => void scanGithubNow($)),
  ]
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'look',
      description: 'Switch the desktop look: catppuccin, starship, or off',
      argumentHint: 'catppuccin | starship | off',
    })
    const saved = await $.store.get('look')
    const name = typeof saved === 'string' ? saved : DEFAULT_LOOK

    if (name !== 'off') {
      await applyLook($, name)
    } else {
      await noteLook($, 'off')
    }
    if (name === 'starship') {
      startScans($)
    }

    return next(e)
  })

  on('command.run', { command: 'look' }, async ($, e) => {
    const name = e.args.trim().toLowerCase()

    if (name === '') {
      const saved = await $.store.get('look')

      return { text: `Current look: ${typeof saved === 'string' ? saved : DEFAULT_LOOK}. Options: ${Object.keys(LOOKS).join(', ')}, off.` }
    }
    if (name === 'off') {
      await $.store.set('look', 'off')
      await $.theme.clear()
      await noteLook($, 'off')
      stopScans()

      return { text: 'Look off. The app is back to its own theme.' }
    }
    const text = await applyLook($, name)

    if (LOOKS[name] !== undefined) {
      await $.store.set('look', name)
      if (name === 'starship') {
        startScans($)
      } else {
        stopScans()
      }
    }

    return { text }
  })

  // The console shows whether Claude is at work, and how many subagents are.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, isWorking, () => true)
    } else {
      await setActiveSubagents($, await countActiveSubagents($, { started: e.agentId }))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, isWorking, () => false)
    } else {
      await setActiveSubagents($, await countActiveSubagents($, { ended: e.agentId }))
    }

    return next(e)
  })

  // A click on the bare backdrop sends a band down the column and reads the
  // readouts again.
  on('ui.pointer', async ($, e, next) => {
    const now = await $.clock.now()

    if (e.scene === starshipSceneName && now - (await read($, sweptAt)) >= RESCAN_MS) {
      await update($, sweptAt, () => now)
      void scanMacNow($)
      if (now - githubScannedAt >= GITHUB_RESCAN_MS) {
        void scanGithubNow($, GITHUB_RESCAN_MS)
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'Backdrop' }, async ($, e, next) => {
    if ((e.surface !== 'desktop' && e.surface !== 'mobile') || e.props.scene !== starshipSceneName) {
      return next(e)
    }
    const { Svg } = $.ui.resolve(e)
    const view = {
      readouts: await read($, readouts),
      isWorking: await read($, isWorking),
      activeSubagents: await read($, activeSubagents),
      sweptAt: await read($, sweptAt),
      deckCondition: readDeckCondition(await readDeck($)),
      deckFeed: readDeckFeed(await readDeckSummary($)),
      now: await $.clock.now(),
    }

    return <Svg source={starshipScene(view)} alt={describeConsole(view)} isInteractive />
  })
}

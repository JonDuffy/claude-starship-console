import { expect, mock, test } from 'claude-code/testing'
import type { On, ThemeSetArgs } from 'claude-code'

import { countLines, parseCpuPercent, parseDisk, parsePullRequestCount } from '../hooks/readouts'
import { consoleCondition, describeConsole, headCondition, readDeckCondition, starshipScene } from '../hooks/starship-scene'

import type { ConsoleReadouts } from '../types'

const BACKDROP = {
  plugin: 'terminal-looks',
  surface: 'desktop',
  component: 'Backdrop',
  requestId: 'backdrop',
  props: { scene: 'starship-frame', plugin: 'terminal-looks', glass: { blur: 2, opacity: 0.35 } },
} as const

const COMMAND = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

const DF = `Filesystem   1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1   482797652 354122052  73845668    83%    /System/Volumes/Data
`

const ran = (stdout: string, exitCode = 0) => ({
  exitCode,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

// The Mac beneath the mod: each command the console runs, answered from here.
type Mac = {
  df: string
  cpuShares: string
  claudePids: string
  isGhSignedIn: boolean
  runs: string[][]
  /** Each look the engine let through to the app. */
  looks: ThemeSetArgs[]
}

function mac(on: On, look: string, stored: Record<string, unknown> = {}): Mac {
  const host: Mac = {
    df: DF,
    cpuShares: ' 250.0\n 150.0\n   0.0\n',
    claudePids: '11\n12\n13\n',
    isGhSignedIn: true,
    runs: [],
    looks: [],
  }

  mock.store(on, { look, ...stored })
  on('command.register', () => ({ value: { command: 'look' } }))
  on('theme.set', (_, e) => {
    host.looks.push(e)

    return { value: { isDrawn: true, requestId: 'backdrop' } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', (_, e) => {
    const [command, ...args] = e.argv
    host.runs.push([...e.argv])

    if (command === '/bin/df') return { value: ran(host.df, host.df === '' ? 1 : 0) }
    if (command === '/bin/ps') return { value: ran(host.cpuShares) }
    if (command === '/usr/sbin/sysctl') return { value: ran('10\n') }
    if (command === '/usr/bin/pgrep') return { value: ran(host.claudePids, host.claudePids === '' ? 1 : 0) }
    if (command === '/bin/date') return { value: ran('14:32\n') }
    if (command === 'gh' && args[0] === '--version') return { value: ran('gh version 2.69.0\n') }
    if (command === 'gh' && !host.isGhSignedIn) return { value: ran('', 4) }
    if (command === 'gh' && args.includes('--review-requested=@me')) return { value: ran('[{"number":62},{"number":28}]') }
    if (command === 'gh' && args.includes('--author=@me')) return { value: ran('[{"number":1},{"number":2},{"number":3}]') }

    return { value: ran('', 127) }
  })

  return host
}

const START = { cwd: '/', surface: 'desktop', isInteractive: true } as const

test('each readout is read from its command', () => {
  const disk = parseDisk(DF)

  expect(disk?.freeGb.toFixed(1)).toBe('75.6')
  expect(disk?.totalGb.toFixed(1)).toBe('494.4')
  expect(parseDisk('df: no such volume\n')).toBe(null)
  expect(parseCpuPercent(' 250.0\n 150.0\n   0.0\n', 10)).toBe(40)
  expect(parseCpuPercent(' 900,5\n 900,5\n', 10)).toBe(100)
  expect(parseCpuPercent('', 10)).toBe(null)
  expect(countLines('11\n12\n\n')).toBe(2)
  expect(parsePullRequestCount('[{"number":62},{"number":28}]')).toBe(2)
  expect(parsePullRequestCount('[]')).toBe(0)
  expect(parsePullRequestCount('gh: not signed in')).toBe(null)
})

test('the condition follows the disk, and claims nothing with the disk unread', () => {
  const readouts: ConsoleReadouts = {
    diskFreeGb: 75.6,
    diskTotalGb: 494.4,
    cpuPercent: 40,
    cpuTrace: [40],
    cpuCores: 10,
    claudeProcesses: 3,
    reviewRequests: 2,
    openPullRequests: 3,
    scannedAt: '14:32',
    githubCheckedAt: '14:30',
  }

  expect(consoleCondition(readouts).level).toBe('NOMINAL')
  expect(consoleCondition({ ...readouts, cpuPercent: 95 })).toEqual({ level: 'CAUTION', reason: 'CPU AT 95%' })
  expect(consoleCondition({ ...readouts, diskFreeGb: 34.2 })).toEqual({ level: 'CAUTION', reason: 'DISK 34 GB FREE' })
  expect(consoleCondition({ ...readouts, diskFreeGb: 8.44 })).toEqual({ level: 'ALERT', reason: 'DISK 8.4 GB FREE' })
  expect(consoleCondition({ ...readouts, diskFreeGb: null })).toEqual({ level: 'UNKNOWN', reason: 'DISK NOT READ' })
})

test('the starship column shows what the Mac and GitHub answered', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const host = mac(on, 'starship')

  await $.session.start(START)
  await clock.settle()
  // The engine checks a look's sound before the app is handed it. One set,
  // with the hum and the click, means the first version passed that check.
  expect(host.looks.length).toBe(1)
  expect(host.looks[0]?.sound?.ambience?.layers.length).toBe(3)
  expect(host.looks[0]?.sound?.cues?.click === undefined).toBe(false)
  const ui = await $.ui.mount(BACKDROP)
  const source = String((await ui.find({ type: 'Svg' }))?.props.source)

  expect(source).toContain('>76 GB<')
  expect(source).toContain('>OF 494<')
  expect(source).toContain('>40%<')
  expect(source).toContain('>10 CORES<')
  expect(source).toContain('>CLAUDE PROCESSES<')
  expect(source).toContain('>3<')
  expect(source).toContain('>2<')
  // GitHub's answer carries its own time, apart from the Mac's scan.
  expect(source).toContain('>TO REVIEW AT 14:32<')
  expect(source).toContain('>NOMINAL<')
  expect(source).toContain('>LAST SCAN 14:32<')
  await ui.unmount()
})

test('the timers read the Mac every half minute and GitHub every three', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const host = mac(on, 'starship')
  const count = (command: string, arg?: string) =>
    host.runs.filter(run => run[0] === command && (arg === undefined || run.includes(arg))).length

  await $.session.start(START)
  await clock.settle()
  expect(count('/bin/df')).toBe(1)
  expect(count('gh', '--author=@me')).toBe(1)

  host.cpuShares = ' 950.0\n'
  host.df = DF.replace('73845668', '9000000')
  await clock.advance(30_000)
  expect(count('/bin/df')).toBe(2)
  expect(count('gh', '--author=@me')).toBe(1)

  const ui = await $.ui.mount(BACKDROP)
  const source = String((await ui.find({ type: 'Svg' }))?.props.source)

  expect(source).toContain('>ALERT<')
  expect(source).toContain('>DISK 9.2 GB FREE<')
  expect(source).toContain('>DISK LOW<')
  expect(source).toContain('>95%<')
  await ui.unmount()

  await clock.advance(150_000)
  expect(count('/bin/df')).toBe(7)
  expect(count('gh', '--author=@me')).toBe(2)
})

test('a readout that fails draws a dash, and the scene still draws', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const host = mac(on, 'starship')
  host.isGhSignedIn = false
  host.df = ''
  host.claudePids = ''

  await $.session.start(START)
  await clock.settle()
  const ui = await $.ui.mount(BACKDROP)
  const source = String((await ui.find({ type: 'Svg' }))?.props.source)

  expect(source).toContain('>UNKNOWN<')
  expect(source).toContain('>DISK NOT READ<')
  expect(source).toContain('>-<')
  expect(source).toContain('>NO DATA<')
  // pgrep with no match is a count of none, not a failure.
  expect(source).toContain('>ON THIS MAC<')
  expect(source).toContain('>40%<')
  await ui.unmount()
})

// The kit has no call that raises `ui.pointer`, so the click itself is not
// tested here: this seeds what the click's hook writes, and checks the drawing.
test('for 1.6 seconds after a click the scene holds one band, picked up where it was', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mac(on, 'starship')
  on('state.get', { plugin: 'terminal-looks', key: 'sweptAt' }, () => ({
    value: { value: 1_800_000_000_000 - 400, version: 1 },
  }))

  const ui = await $.ui.mount(BACKDROP)
  const source = String((await ui.find({ type: 'Svg' }))?.props.source)
  expect(source).toContain('class="sweep"')
  expect(source).toContain('animation-delay: -0.40s; }')
  await ui.unmount()

  await clock.advance(2_000)
  const later = await $.ui.mount(BACKDROP)
  expect(String((await later.find({ type: 'Svg' }))?.props.source)).not.toContain('class="sweep"')
  await later.unmount()
})

test('the console follows the turn and its subagents', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mac(on, 'starship')
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const drawn = async () => {
    const ui = await $.ui.mount(BACKDROP)
    const source = String((await ui.find({ type: 'Svg' }))?.props.source)
    await ui.unmount()

    return source
  }
  const ended = { answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as const

  await $.session.start(START)
  await clock.settle()
  expect(await drawn()).toContain('>STANDBY<')

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.start({ text: 'look', turnId: 't2', agentId: 'a1' })
  const working = await drawn()
  expect(working).toContain('>WORKING<')
  expect(working).toContain('chase k0')
  expect(working).toContain('>1<')

  await $.turn.complete({ ...ended, turnId: 't2', agentId: 'a1' })
  await $.turn.complete({ ...ended, turnId: 't1' })
  const resting = await drawn()
  expect(resting).toContain('>STANDBY<')
  expect(resting).not.toContain('chase k0')
  expect(resting).toContain('>0<')
})

test('no command runs under the catppuccin look, or once the look is switched', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const host = mac(on, 'catppuccin')
  on('command.run', () => ({ text: '' }))

  await $.session.start(START)
  await clock.advance(60_000)
  expect(host.runs.length).toBe(0)

  await $.command.run({ ...COMMAND, command: 'look', args: 'starship' })
  await clock.settle()
  expect(host.runs.length > 0).toBe(true)

  await $.command.run({ ...COMMAND, command: 'look', args: 'catppuccin' })
  await clock.settle()
  const before = host.runs.length
  await clock.advance(300_000)
  expect(host.runs.length).toBe(before)
})

test('the scene stays inside what a backdrop may hold', () => {
  const scene = starshipScene({
    readouts: {
      diskFreeGb: 8.4,
      diskTotalGb: 494.4,
      cpuPercent: 100,
      cpuTrace: Array.from({ length: 16 }, () => 100),
      cpuCores: 10,
      claudeProcesses: 400,
      reviewRequests: 100,
      openPullRequests: 100,
      scannedAt: '23:59',
      githubCheckedAt: '23:58',
    },
    isWorking: true,
    activeSubagents: 99,
    sweptAt: 1_800_000_000_000,
    now: 1_800_000_000_400,
  })

  expect(scene.length < 131_072).toBe(true)
  // What the engine and the app refuse in a backdrop, or hold a scene still for.
  for (const refused of ['<image', 'href', 'url(', 'data:', '@font-face', '@import', 'filter', '&', 'foreignObject']) {
    expect(scene.includes(refused), refused).toBe(false)
  }
  // A comment's words are read too.
  for (const [, comment = ''] of scene.matchAll(/<!--([^]*?)-->/g)) {
    expect(/<|--|\(|@|'/.test(comment), comment).toBe(false)
  }
})

test('one GitHub answer is shared: a fresh one in the store is used, not asked again', async ($, on) => {
  const now = 1_800_000_000_000
  const clock = mock.clock(on, { now })
  const shared = { reviewRequests: 7, openPullRequests: 4, githubCheckedAt: '14:29' }
  const host = mac(on, 'starship', { githubCache: { atMs: now - 60_000, scan: shared } })

  await $.session.start(START)
  await clock.settle()
  expect(host.runs.filter(run => run[0] === 'gh' && run[1] === 'search').length).toBe(0)

  const ui = await $.ui.mount(BACKDROP)
  const source = String((await ui.find({ type: 'Svg' }))?.props.source)

  expect(source).toContain('>TO REVIEW AT 14:29<')
  expect(source).toContain('>7<')
  await ui.unmount()

  // Once the shared answer is older than a scan period, this session asks GitHub.
  await clock.advance(180_000)
  expect(host.runs.filter(run => run[0] === 'gh' && run[1] === 'search').length).toBe(2)
})

test('the disk bar shows the free share, and an unread processor is said', () => {
  const readouts: ConsoleReadouts = {
    diskFreeGb: 100,
    diskTotalGb: 500,
    cpuPercent: null,
    cpuTrace: [],
    cpuCores: null,
    claudeProcesses: 1,
    reviewRequests: 0,
    openPullRequests: 0,
    scannedAt: '10:00',
    githubCheckedAt: null,
  }
  const source = starshipScene({ readouts, isWorking: false, activeSubagents: 0, sweptAt: 0, now: 0 })

  // 100 of 500 free: a fifth of the 170 point gauge.
  expect(source).toContain('<rect class="ink" x="10" y="68" width="34.0" height="8"/>')
  expect(consoleCondition(readouts)).toEqual({ level: 'NOMINAL', reason: 'CPU NOT READ' })
  expect(source).toContain('>TO REVIEW<')
})

// ---- The one condition, when command-deck is loaded beside this mod

const CALM: ConsoleReadouts = {
  diskFreeGb: 34.2,
  diskTotalGb: 494.4,
  cpuPercent: 40,
  cpuTrace: [40],
  cpuCores: 10,
  claudeProcesses: 3,
  reviewRequests: 0,
  openPullRequests: 0,
  scannedAt: '14:32',
  githubCheckedAt: '14:30',
}

test('command-deck\'s condition is read as data: a known level and plain capital words, or nothing', () => {
  expect(readDeckCondition({ level: 'alert', reason: '2 sessions need you.', brief: '2 SESSIONS NEED YOU' })).toEqual({
    level: 'alert',
    brief: '2 SESSIONS NEED YOU',
  })
  // The words go into the backdrop's markup: anything that is not a capital, a digit or plain punctuation is taken out, and they are cut to the head's room.
  expect(readDeckCondition({ level: 'caution', brief: 'ci <b>failing</b> & "pr" 41 with a very long tail of words' })).toEqual({
    level: 'caution',
    brief: 'CI BFAILING/B  PR 41 WIT',
  })
  for (const notOne of [undefined, null, 'alert', {}, { level: 'red', brief: 'X' }, { level: 'alert' }, { level: 'alert', brief: '<<<' }, { level: 'alert', brief: 7 }]) {
    expect(readDeckCondition(notOne), JSON.stringify(notOne)).toBe(null)
  }
})

test('the console head shows command-deck\'s condition when there is one, and its own reading when there is none', () => {
  const view = { readouts: CALM, isWorking: false, activeSubagents: 0, sweptAt: 0, now: 1_800_000_000_000 }

  // Alone, the console reads the disk: 34 GB free is its own caution.
  expect(headCondition(view)).toEqual({ level: 'CAUTION', reason: 'DISK 34 GB FREE' })
  expect(headCondition({ ...view, deckCondition: null })).toEqual({ level: 'CAUTION', reason: 'DISK 34 GB FREE' })
  // With command-deck, there is one condition: the deck's, with its reason.
  const alert = { ...view, deckCondition: { level: 'alert', brief: '2 SESSIONS NEED YOU' } as const }

  expect(headCondition(alert)).toEqual({ level: 'ALERT', reason: '2 SESSIONS NEED YOU' })
  expect(starshipScene(alert)).toContain('<path class="bad alarm"')
  expect(starshipScene(alert)).toContain('>2 SESSIONS NEED YOU<')
  expect(describeConsole(alert)).toStartWith('A sci-fi console frame of pastel bars with live readouts. Condition alert: 2 sessions need you,')
  const nominal = { ...view, deckCondition: { level: 'nominal', brief: 'NOTHING WAITS' } as const }

  expect(headCondition(nominal)).toEqual({ level: 'NOMINAL', reason: 'NOTHING WAITS' })
  expect(starshipScene(nominal)).toContain('<path class="c1"')
  // The disk's own block still shows its own low-disk tone: only the head follows the deck.
  expect(starshipScene(nominal)).toContain('>DISK LOW<')
  expect(starshipScene({ ...view, deckCondition: { level: 'caution', brief: 'CI FAILING PR 41' } })).toContain('<path class="warn"')
})

test('the drawn console follows command-deck\'s condition as that mod writes it', {
  // Stands for command-deck: it owns the value, and writes it as its condition changes.
  plugins: [
    {
      name: 'command-deck',
      register(on) {
        on('turn.start', async ($, e, next) => {
          await $.state.set({ plugin: 'command-deck', key: 'condition' } as never, { level: 'alert', reason: 'r', brief: '1 SESSION NEEDS YOU' } as never)

          return next(e)
        })
        on('turn.complete', async ($, e, next) => {
          await $.state.set({ plugin: 'command-deck', key: 'condition' } as never, { level: 'nominal', reason: 'r', brief: 'NOTHING WAITS' } as never)

          return next(e)
        })
      },
    },
  ],
}, async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })

  mac(on, 'starship')
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start(START)
  await clock.settle()
  const ui = await $.ui.mount(BACKDROP)
  const source = async () => String((await ui.find({ type: 'Svg' }))?.props.source)

  // Before command-deck has written anything, the console shows its own condition.
  expect(await source()).toContain('>ALL SYSTEMS<')
  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(await source()).toContain('>ALERT<')
  expect(await source()).toContain('>1 SESSION NEEDS YOU<')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1' })
  expect(await source()).toContain('>NOMINAL<')
  expect(await source()).toContain('>NOTHING WAITS<')
  await ui.unmount()
})

test('the look that is on is kept where another mod can read it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const looks: unknown[] = []

  // Registered ahead of the kit's own state, so this hook hears the write.
  on('state.set', { plugin: 'terminal-looks', key: 'look' }, (_, e) => {
    looks.push(e.value)

    return { value: { isSet: true, version: looks.length } }
  })
  mac(on, 'catppuccin')
  on('command.run', () => ({ text: '' }))
  on('theme.clear', () => ({ value: { isDrawn: true, requestId: 'backdrop' } }))
  await $.session.start(START)
  await clock.settle()
  await $.command.run({ ...COMMAND, command: 'look', args: 'starship' })
  await clock.settle()
  await $.command.run({ ...COMMAND, command: 'look', args: 'off' })
  await $.command.run({ ...COMMAND, command: 'look', args: 'nonsense' })
  expect(looks).toEqual(['catppuccin', 'starship', 'off'])
})

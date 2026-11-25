import type { ThemeSetArgs } from 'claude-code'

import { makeColors } from './make-colors.js'

// Catppuccin: Latte in light mode, Mocha in dark mode. Colours from the
// open Catppuccin palette (MIT).
const catppuccinColors = makeColors({
  label: 'Catppuccin',
  roles: { accent: '#8839ef', danger: '#d20f39', success: '#40a02b', warning: '#fe640b', pro: '#1e66f5' },
  codeTheme: { light: 'catppuccin-latte', dark: 'catppuccin-mocha' },
  light: {
    gray: {
      anchors: {
        'surface-0': '#e6e9ef',
        'surface-1': '#eff1f5',
        'surface-2': '#f6f7fa',
        'text-primary': '#4c4f69',
        'text-secondary': '#5c5f77',
        'text-muted': '#6c6f85',
      },
    },
  },
  dark: {
    roles: { accent: '#cba6f7', danger: '#f38ba8', success: '#a6e3a1', warning: '#fab387', pro: '#89b4fa' },
    gray: {
      anchors: {
        'surface-0': '#1e1e2e',
        'surface-1': '#25253a',
        'surface-2': '#2b2c40',
        'surface-3': '#313244',
        'text-primary': '#cdd6f4',
        'text-secondary': '#bac2de',
        'text-muted': '#a6adc8',
      },
    },
  },
})

// Starship console: an original sci-fi panel look. Pastel blocks on black by
// night, on warm console cream by day.
const starshipColors = makeColors({
  label: 'Starship console',
  roles: { accent: '#ff9966', danger: '#e05555', success: '#77bb77', warning: '#ffcc66', pro: '#9999ff' },
  light: {
    gray: {
      anchors: {
        'surface-0': '#e8e2d6',
        'surface-1': '#efeae0',
        'surface-2': '#f6f2ea',
        'surface-3': '#f6f2ea',
        'text-primary': '#2a2440',
        'text-secondary': '#4a4060',
        'text-muted': '#5f5575',
      },
    },
  },
  dark: {
    gray: {
      anchors: {
        'surface-0': '#000000',
        'surface-1': '#0d0a12',
        'surface-2': '#16111d',
        'surface-3': '#1d1726',
        'text-primary': '#ffcc99',
        'text-secondary': '#eebbdd',
        'text-muted': '#cc99cc',
      },
    },
  },
})

export const colorProblems = {
  catppuccin: catppuccinColors.problems,
  starship: starshipColors.problems,
}

// A terminal prompt sign drawn in the top-left corner of your message box.
const promptChevronBox = {
  backgroundColor: 'surface-1',
  paddingLeft: 26,
  paddingY: 8,
  paddingRight: 12,
  fill: {
    vector: {
      viewBox: 48,
      slice: 16,
      paths: [
        { d: 'M2 0H46Q48 0 48 2V46Q48 48 46 48H2Q0 48 0 46V2Q0 0 2 0Z', color: 'surface-1' },
        { d: 'M6 5L12 9L6 13', strokeWidth: 2, color: 'text-accent' },
      ],
    },
  },
} as const

export const catppuccin: ThemeSetArgs = {
  colors: catppuccinColors.theme,
  style: {
    Text: { fontFamily: ['mono'], fontSize: 14, lineHeight: 22 },
    Heading: { fontFamily: ['mono'], color: 'text-accent' },
    UserMessage: promptChevronBox,
    ToolUse: { fontFamily: ['code'], color: 'text-secondary', backgroundColor: 'surface-1', radius: 4, paddingX: 8 },
  },
}

// Your message: a solid console button with fully rounded ends. The words use
// surface-0 (black at night, cream by day) so they read on the solid colour.
const consoleButton = {
  color: 'surface-0',
  fontWeight: 'medium',
  radius: 24,
  paddingX: 24,
  paddingY: 10,
} as const

export const starshipSceneName = 'starship-frame'

// Short console tones. The desktop app plays them once you press the speaker
// button in the session's title bar.
const consoleCues = {
  send: { layers: [{ wave: 'triangle', notes: ['A5', 'E6'], step: 0.06, release: 0.12, gain: 0.25 }] },
  tool: { layers: [{ wave: 'sine', notes: ['C6'], release: 0.05, gain: 0.1 }] },
  done: { layers: [{ wave: 'triangle', notes: ['E5', 'A5', 'C#6'], step: 0.08, release: 0.2, gain: 0.25 }] },
  ask: { layers: [{ wave: 'triangle', notes: ['C6', 'C6'], step: 0.15, release: 0.08, gain: 0.2 }] },
  error: {
    layers: [
      { wave: 'square', notes: ['A3', 'F3'], step: 0.12, release: 0.15, gain: 0.12, filter: { type: 'lowpass', hz: 1200 } },
    ],
  },
} as const

// A click on the bare backdrop plays one key of the console: the app picks
// the note by where the click fell, the first at the left edge and the last
// at the right.
const consoleKey = {
  layers: [{ wave: 'triangle', notes: ['A4', 'C5', 'D5', 'E5', 'G5', 'A5', 'C6', 'D6', 'E6'], release: 0.15, gain: 0.15 }],
} as const

// A very quiet bridge: the air handling, a low engine fifth that swells and
// fades over ten seconds, and a far console chirp about twice a minute.
const bridgeHum = {
  layers: [
    { wave: 'brown', drone: true, gain: 0.1, filter: { type: 'lowpass', hz: 220 } },
    { wave: 'sine', notes: ['A2', 'E3'], drone: true, gain: 0.05, tremolo: { hz: 0.1, depth: 0.4 } },
    { wave: 'sine', notes: ['E6', 'A6', 'C#7'], scatter: 0.03, release: 0.3, gain: 0.03, pan: 0.5 },
  ],
} as const

const starshipLook = {
  colors: starshipColors.theme,
  // A light, thin frost so the console frame shows through the chat panels.
  backdrop: { scene: starshipSceneName, glass: { blur: 2, opacity: 0.35 } },
  style: {
    Text: { fontFamily: ['sans'], letterSpacing: 0.5 },
    Heading: { fontFamily: ['sans'], color: 'text-accent', fontWeight: 'bold', letterSpacing: 2 },
    UserMessage: [
      { ...consoleButton, backgroundColor: 'fill-accent' },
      { ...consoleButton, backgroundColor: 'fill-pro' },
    ],
    ToolUse: { color: 'surface-0', backgroundColor: 'fill-pro', radius: 14, paddingX: 12 },
  },
} satisfies ThemeSetArgs

export const starship: ThemeSetArgs = {
  ...starshipLook,
  sound: { ambience: bridgeHum, cues: { ...consoleCues, click: consoleKey } },
}
// The app refuses a whole look for one sound out of its range, and nothing
// but the app can check a sound. So the look has two quieter versions: with
// the cues the app has already taken, and silent.
export const starshipWithCuesAlone: ThemeSetArgs = { ...starshipLook, sound: { cues: consoleCues } }
export const starshipSilent: ThemeSetArgs = starshipLook

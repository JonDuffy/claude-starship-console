/**
 * What the starship console's column shows, as the last scan read it. A null
 * is a readout that could not be read, drawn as a dash.
 */
export type ConsoleReadouts = {
  /** Free space on the data volume, in decimal gigabytes. */
  diskFreeGb: number | null
  /** The size of the data volume's container, in decimal gigabytes. */
  diskTotalGb: number | null
  /** Processor use across all cores at the last scan, 0 to 100. */
  cpuPercent: number | null
  /** The scans before it that could be read, oldest first, 16 at most. */
  cpuTrace: number[]
  cpuCores: number | null
  /** Processes on this Mac named exactly `claude`. */
  claudeProcesses: number | null
  /** Open pull requests that ask for the person's review. */
  reviewRequests: number | null
  /** Open pull requests the person wrote. */
  openPullRequests: number | null
  /** The Mac's local time at the last scan, as HH:MM. */
  scannedAt: string | null
  /** The Mac's local time when GitHub last answered, as HH:MM. GitHub is read on its own timer. */
  githubCheckedAt: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'terminal-looks': {
      readouts: Shaped<ConsoleReadouts>
      /** A turn of the main conversation is running. */
      isWorking: boolean
      /** Subagents of this session that have started and not ended or gone idle. */
      activeSubagents: number
      /** When the person last clicked the backdrop, in epoch milliseconds. */
      sweptAt: number
      /**
       * The look that is on: `catppuccin`, `starship` or `off`; null before one
       * was set this session. Other mods may read it: command-deck draws its
       * panes to match.
       */
      look: string | null
    }
  }
}

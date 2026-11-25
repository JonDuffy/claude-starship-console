# Claude Starship Console

Two mods for the Claude desktop app:

- **terminal-looks**: two themes, switched with `/look`.
  - **Catppuccin**: Latte in light mode, Mocha in dark mode, monospace text.
  - **Starship console**: an original sci-fi panel inspired by LCARS. Pastel blocks on black (cream in light mode). The right-hand column shows live readouts: disk free, CPU, Claude processes, subagents, pull requests waiting on you. It has soft console sounds.
- **command-deck**: feeds three more blocks into that column (sessions that need you, this branch's checks, context and usage). It also adds a status band above the prompt, a notification when a session waits on you, an end-of-turn footer, Bash row badges, and guards before big installs and AWS commands.

terminal-looks works on its own. command-deck adds the extra blocks and features.

## Requirements

- **The Claude desktop app** (Code tab) on **macOS**. Themes draw only in the desktop and mobile apps, not in the terminal. The readouts run macOS commands: `df`, `ps`, `sysctl`, `pgrep` and `date`.
- **A recent Claude Code** that supports mods (built and tested on 2.1.330). The mod API is early access, so a future release may change it.
- **The GitHub CLI `gh`, signed in.** It's optional: without it, the pull request and checks readouts show a dash.

## Install

In the desktop app:

1. Click **+** next to the prompt box, then **Plugins**.
2. Choose **Add marketplace**, and enter `JonDuffy/claude-starship-console`.
3. Choose **Add plugin**, and add **terminal-looks**. Add **command-deck** too if you want the extra blocks.

Or, at the prompt of a terminal session:

```
/plugin install terminal-looks --marketplace JonDuffy/claude-starship-console
/plugin install command-deck --marketplace JonDuffy/claude-starship-console
```

Or from a shell:

```bash
claude plugin install terminal-looks --marketplace JonDuffy/claude-starship-console
claude plugin install command-deck --marketplace JonDuffy/claude-starship-console
```

## Turn it on

1. **New sessions** load installed plugins by themselves. In a session that was already open, type `/reload-plugins`.
2. Type `/look starship` for the console, or `/look catppuccin` for the calm theme. Your choice is saved for later sessions.
3. Flip the app between light and dark mode to see both versions.
4. For sound, press the speaker button in the session's title bar.

## Commands

| Command | What it does |
|---|---|
| `/look starship` | The console theme with live readouts |
| `/look catppuccin` | Catppuccin Latte and Mocha |
| `/look off` | Back to the app's own theme |
| `/look` | Says which look is on |
| `/deck` | Short help for command-deck |
| `/deck bundle` | Size of the newest build zip (and an OpenNext server function), against the last recorded size |
| `/deck notify` | Sends a test notification, to check that call lights reach you |
| `/deck aws list` | This repo's AWS account allow-list |
| `/deck aws allow <12-digit id>` / `/deck aws remove <id>` | Edits that list (only when you type it yourself) |

Click the bare backdrop to rescan the readouts at once.

## What runs by itself

- **Console readouts.** The Mac's readouts refresh every 30 seconds, and GitHub every 3 minutes. Sessions share one GitHub answer, so many sessions don't multiply the calls.
- **Needs you.** Counts the sessions that are waiting on you. It counts only sessions that run command-deck. Once the mod is installed, that's every new session.
- **Status band** above the prompt: the condition, this branch's PR and checks, context, rate limits and estimated cost. When a check fails, a **Fix it** button fills the prompt with the failing step and its log. It never sends the prompt for you.
- **Call light.** A notification, labelled with the repo, when a session has waited on you for 20 seconds. Where notifications can't be sent, it shows a toast.
- **Footer.** A line under an answer that says what's still running, shown only when something is.
- **Guards.** They ask first before installs and builds when disk is under 20 GB free. They also ask before AWS commands, and deny AWS accounts outside the repo's allow-list once you've set one.
- **Extras:**
  - Bash rows show duration and exit status.
  - Right-click a selection for "Ask Codex to review this" or "Explain this".
  - `@ci` in a prompt attaches the branch's latest failed CI log.

## Good to know

- **The guards read only the command text.** They're a safety net, not a security boundary. A command hidden inside a script isn't seen.
- **The AWS guard runs one read-only call.** It runs `aws sts get-caller-identity` to learn the account, but only when your own command already targets AWS.
- **Costs are estimates** from the client, not your bill.
- **Reduce motion.** With macOS Reduce motion on, the console holds still.
- **Files it writes.** command-deck keeps heartbeat and cache files in `~/.claude/command-deck/`. Delete that folder whenever you like.
- **Network.** Neither mod sends anything off your Mac except through `gh` and the AWS check above.

## Uninstall

```bash
claude plugin uninstall terminal-looks@claude-starship-console
claude plugin uninstall command-deck@claude-starship-console
```

## Develop

Each mod has tests:

```bash
claude plugin validate terminal-looks
claude plugin test terminal-looks
claude plugin test command-deck
```

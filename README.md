# pi-antigravity-usage

Google Antigravity / Google AI plan subscription usage monitor extension for [Pi coding agent](https://pi.dev).

Displays real-time Google Antigravity 5-hour rolling limits and weekly quota in Pi's footer. Also provides the `/antigravity` command for instant quota inspection.

## Features

- **Footer Integration**: Native-style footer showing session stats, context window %, and live `5h:xx% Wk:xx%` usage with `!` / `!!` consumption pace alerts.
- **Smart Pool Detection**: Automatically tracks the active model's quota pool:
  - **Gemini Pool**: Gemini 3.8 Flash, 3.7 Flash, 3.6 Flash, 3.1 Pro, etc.
  - **Claude & GPT Pool**: Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B.
- **`/antigravity` Command**: Shows a visual progress bar chart with exact usage, remaining quota %, and human-readable countdowns to reset.
- **Auto-Activate & Auto-Vacate**: Only mounts when using `google-antigravity` provider models; automatically vacates the footer when switching to other providers (e.g. Codex or Ollama) so other usage plugins take over seamlessly.
- **Zero Config**: Reads existing OAuth credentials directly from Pi's `auth.json` (configured via [pi-antigravity](https://github.com/inouemoby/pi-antigravity)). Refreshes expired access tokens automatically.

## Install

```bash
pi install git:github.com/inouemoby/pi-antigravity-usage
```

Restart Pi after installation, or run `/reload`.

## Setup

Authenticate with Google using the [pi-antigravity](https://github.com/inouemoby/pi-antigravity) provider:

```text
/login
→ Sign in with an account
→ Google Antigravity (OAuth)
```

No additional login or API keys required. `pi-antigravity-usage` automatically uses the authenticated session.

## Preview

```text
~/my-project (main) • session-name
↑1.2k ↓450 R3.4k W1.2k $0.005 12.5%/1.0M (auto) 5h:15.0% Wk:2.5%   (google-antigravity) gemini-3.8-flash • high
```

- Normal = consumption within expected burn rate
- `!` = consumption above expected pace for the current reset window
- `!!` = consumption exceeds 1.5× expected pace or quota exhausted

## Commands

| Command | Description |
|---|---|
| `/antigravity` | Show visual progress bars, remaining %, and reset countdowns |

### Command Output Example

```text
══ Google Antigravity Usage ══
Account: user@gmail.com

▸ Gemini Models (Flash, Pro):
  5h   [███░░░░░░░░░░░░░░░░░]  15.0% used (85.0% left)  resets in 4h 46m
  Wk   [█░░░░░░░░░░░░░░░░░░░]   2.5% used (97.5% left)  resets in 6d 23h

▸ Claude and GPT models (Sonnet, Opus, GPT-OSS):
  5h   [░░░░░░░░░░░░░░░░░░░░]   0.0% used (100.0% left)  resets in 4h 59m
  Wk   [░░░░░░░░░░░░░░░░░░░░]   0.0% used (100.0% left)  resets in 6d 23h

(Refreshed at: 15:20:12)
```

## Related

- [pi-antigravity](https://github.com/inouemoby/pi-antigravity) — Google Antigravity OAuth provider for Pi
- [pi-codex-usage](https://github.com/inouemoby/pi-codex-usage) — OpenAI Codex usage monitor
- [pi-ollama-usage](https://github.com/inouemoby/pi-ollama-usage) — Ollama Cloud usage monitor

## License

MIT

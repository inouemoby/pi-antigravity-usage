# pi-antigravity-usage

Google Antigravity / Google AI plan subscription usage monitor extension for [Pi coding agent](https://pi.dev).

Displays real-time Google Antigravity 5-hour rolling limits and weekly quota in Pi's footer. Also provides the `/antigravity` command for instant quota inspection.

## Features

- **Footer Integration**: Native-style footer showing session stats, context window %, and live `5h:xx% Wk:xx%` usage with `!` / `!!` consumption pace alerts.
- **Smart Pool Detection**: Automatically tracks the active model's quota pool:
  - **Gemini Pool**: Gemini 3.8 Flash, 3.7 Flash, 3.6 Flash, 3.1 Pro, etc.
  - **Claude & GPT Pool**: Claude Sonnet 5.5, Claude Opus 5.5, GPT-OSS 120B (when offered by the account).
- **`/antigravity` Command**: Shows a visual progress bar chart with exact usage, remaining quota %, and human-readable countdowns to reset.
- **Auto-Activate & Auto-Vacate**: Only mounts when using `google-antigravity` provider models; automatically vacates the footer when switching to other providers (e.g. Codex or Ollama) so other usage plugins take over seamlessly.
- **Shared Authentication**: Resolves access through Pi\'s registered [pi-antigravity](https://github.com/inouemoby/pi-antigravity) provider. Pi owns token refresh, file locking, and persistence; this extension never refreshes tokens or writes `auth.json` itself. Requires Pi 1.2+ and the provider extension.\n- **Consistent Quota Source**: Uses the current auth-core client identity and consumer gateway, with the account\'s managed project. Never substitutes an unrelated project or an enterprise quota view.\n- **Lifecycle**: Background polling and the custom footer are TUI-only. `PI_OFFLINE` disables quota requests. Failed refreshes show `AG:?`, and retained readings are marked stale. Cached readings are scoped to the account.

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
↑1.2k ↓450 R3.4k W1.2k 12.5%/1.0M (auto) 5h:15.0% Wk:2.5%   (google-antigravity) gemini-3.8-flash • high
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

## Development\n\n```sh\nnpm ci\nnpm run check\nnpm test\nnpm run build\n```\n\nThe displayed percentages are server-reported subscription quotas, not API dollar costs. Model availability is managed by `/antigravity-models` in the provider extension; `/antigravity` remains quota-only.\n\n## Related

- [pi-antigravity](https://github.com/inouemoby/pi-antigravity) — Google Antigravity OAuth provider for Pi
- [pi-codex-usage](https://github.com/inouemoby/pi-codex-usage) — OpenAI Codex usage monitor
- [pi-ollama-usage](https://github.com/inouemoby/pi-ollama-usage) — Ollama Cloud usage monitor

## License

MIT

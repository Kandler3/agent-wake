# App Server configuration and compatibility

Agent Wake attaches to an existing shared Codex Desktop App Server. Installing this repository does not create the required Desktop setup.

## Configuration lookup

The CLI and Windows launcher use this order:

1. The file named by `AGENT_WAKE_CONFIG`, when set.
2. `$CODEX_HOME/agent-wake/shared-desktop.json`.

When `CODEX_HOME` is unset, it defaults to `~/.codex`. An explicit configuration path is authoritative: if that file is missing or invalid, lookup fails rather than silently using another server. An invalid primary file also fails rather than falling back.

Minimal standalone configuration:

```json
{
  "port": 45000
}
```

`45000` is only an example. Use the actual port from your existing shared Desktop setup. The accepted range is 1024–65535. The CLI connects only to `ws://127.0.0.1:PORT/`; remote hosts, authentication in URLs, query parameters, and alternate paths are rejected.

Optional Windows launcher configuration:

```json
{
  "port": 45000,
  "node": "C:\\Program Files\\nodejs\\node.exe"
}
```

`node` is an absolute path to a Node.js 22+ executable. If omitted, the PowerShell launcher looks for `node.exe` on PATH. A `version` field may identify your local setup and is reported by `doctor`; it is not a compatibility check.

For a different configuration file:

```powershell
$env:AGENT_WAKE_CONFIG = 'C:\path\to\shared-desktop.json'
```

A producer and its worker must use the same configuration and captured `CODEX_THREAD_ID`. The registration receipt stores the selected endpoint; changing the file does not retarget an existing job.

## Required server behavior

- The server used by Desktop accepts a local WebSocket client and JSON-RPC initialization.
- `thread/loaded/list` reports the intended chat as loaded.
- `turn/start` accepts `input: []` with a `toolOutput` object containing `namespace`, `name`, and `output`.
- A tool output for a busy chat can be queued; an idle loaded chat can continue.

The [official App Server documentation](https://learn.chatgpt.com/docs/app-server) describes the protocol. This community tool uses an integration-specific `toolOutput` path; App Server documentation alone does not guarantee that every Desktop build or server supports it. `doctor` checks connectivity and loaded-thread membership; it does not dispatch an event or validate `turn/start.toolOutput`.

There is no universal Desktop version claim. Before relying on delivery, validate a harmless event in your intended chat with the human's authorization. Do not repoint Desktop, expose a remote endpoint, restart it, or change its permissions automatically to make the check pass.

## Troubleshooting

| Error or state | Meaning and next step |
| --- | --- |
| `shared_server_not_configured` | Verify the config location and your existing shared Desktop setup. Installing the CLI alone does not establish the server. |
| `invalid_shared_configuration` | Check JSON and the numeric `port`. |
| `invalid_endpoint` | Only the configured loopback WebSocket endpoint is supported. |
| `missing_thread_context` | Run inside the intended Codex chat environment; ordinary terminals usually lack `CODEX_THREAD_ID`. |
| `target_thread_not_loaded` | The chat is not loaded in this server. Inspect your Desktop setup; the CLI will not load or resume it. |
| `app_server_unavailable` / `app_server_timeout` | Check whether the existing server is running and reachable. |
| `app_server_rejected` | The server definitely refused the RPC; inspect protocol compatibility and the receipt. |
| `delivery_unknown` / `dispatching` | The event may already have arrived. Inspect the receiving chat with the human before considering a replacement. |
| Launcher reports a missing runtime | Install Node.js 22+ on PATH or correct the optional `node` path. |

Do not include personal configuration files, real chat IDs, credentials, or job logs in public issues. Report the error code and relevant runtime versions with sensitive details removed.

## Update

Pull the reviewed version and rerun the installer:

```powershell
git pull --ff-only
.\install.ps1
```

The installer replaces managed program files, launchers, and skill files. It preserves `shared-desktop.json` and existing `jobs/`. Inspect active jobs before updating worker code.

# Agent Wake — Codex Desktop background jobs and wake-up skill

**English** | [Русский](README.ru.md)

[![Tests](https://github.com/Kandler3/agent-wake/actions/workflows/test.yml/badge.svg)](https://github.com/Kandler3/agent-wake/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933)](package.json)
[![Windows / PowerShell](https://img.shields.io/badge/Windows-PowerShell-0078D4)](#requirements)

**Agent Wake** (`agent-wake`) is a local command-line tool and Codex agent skill that wakes the **same Codex Desktop chat** when a background command, CI job, benchmark, or external event finishes.

Let Codex start an authorized long-running task, return control to you, and continue from its result when the task completes. The worker waits outside the model; there is no need to keep asking the agent to check progress.

```text
Codex chat → background command → completion event → same Codex chat continues
```

Use it for **OpenAI Codex Desktop automation**, **asynchronous agent workflows**, **GitHub Actions CI monitoring**, **benchmark completion**, and **event-driven task continuation**.

## What it does

- Runs commands in the background and captures their exit status, stdout, and stderr.
- Delivers success, failure, and timeout results to the original loaded Codex chat.
- Accepts text or JSON events from a local producer.
- Provides job receipts, status inspection, cancellation, and guarded delivery retries.
- Shows a temporary ⏳ prefix on the chat title while background workers are active.
- Installs a discoverable `agent-wake` skill with instructions for Codex.

The CLI connects to your existing shared Codex App Server over loopback WebSocket. It sends a structured `agent_wake.event_completed` tool result through `turn/start.toolOutput`. This is a community integration; compatibility depends on the App Server used by your Desktop setup. See [configuration and compatibility](docs/configuration.md).

## Requirements

| Requirement | Details |
| --- | --- |
| Operating system | Windows; the supplied installer and launchers use PowerShell |
| Runtime | Node.js 22+ and PowerShell 7 (`pwsh`) |
| Codex | Codex Desktop using an **existing shared App Server** with the target chat loaded |
| Context | `CODEX_THREAD_ID` inherited from that Codex chat |
| App Server support | Loopback WebSocket, `thread/loaded/list`, and `turn/start.toolOutput` |
| Optional tools | Git for cloning; `gh`, Python, or other programs used by your commands |

No npm dependencies or separate API key are required by this CLI. Commands and subsequent Codex work use your existing access and account.

**A default Desktop installation is not enough unless it already exposes the required shared App Server.** This repository does not set up or restart Desktop or create that server.

## Installation

### 1. Clone and install the CLI and skill

Run in PowerShell 7:

```powershell
git clone https://github.com/Kandler3/agent-wake.git
Set-Location agent-wake
.\install.ps1
```

The installer copies:

- the CLI to `$env:CODEX_HOME\agent-wake`, or `~/.codex/agent-wake`;
- the skill to `$env:CODEX_HOME\skills\agent-wake`, or `~/.codex/skills/agent-wake`;
- the launchers to `~/.local/bin/agent-wake.ps1` and `agent-wake.cmd`.

It does not edit PATH or the App Server configuration. If `~/.local/bin` is absent from PATH, use the launcher by its full path:

```powershell
& "$env:USERPROFILE\.local\bin\agent-wake.ps1" help
```

To make `agent-wake` available in the current PowerShell session:

```powershell
$env:PATH = "$env:USERPROFILE\.local\bin;$env:PATH"
```

### 2. Configure the existing shared App Server

Create Agent Wake's configuration from the example:

```powershell
$codexDirectory = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$configPath = Join-Path $codexDirectory 'agent-wake\shared-desktop.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    Copy-Item .\examples\shared-desktop.example.json $configPath
}
```

Edit `port` to match the **already-running shared App Server** used by Desktop. The example's `45000` is a placeholder; copying it does not start or configure a server. Node is resolved from PATH unless you supply an absolute `node` path. See [configuration](docs/configuration.md).

### 3. Verify from the intended Codex chat

Ask Codex to run:

```powershell
agent-wake doctor
```

Run this inside a command environment belonging to the intended chat so it inherits `CODEX_THREAD_ID`. A successful result includes `"ok":true` and `"current_thread_loaded":true`. Ordinary terminals usually lack that context.

Start a new Codex chat if necessary for skill discovery, then invoke `$agent-wake`.

## Quick start: background commands

Allocate a UUID before registration and retain it:

```powershell
$jobId = [guid]::NewGuid().ToString()
agent-wake run --name benchmark --job-id $jobId --timeout 4h -- python benchmark.py
```

`run` detaches by default and immediately returns a JSON receipt containing `job_id`. Codex can end its current turn and continue when the result arrives.

Wait for an already-authorized GitHub Actions run:

```powershell
$jobId = [guid]::NewGuid().ToString()
agent-wake run --name ci --job-id $jobId --timeout 2h -- gh run watch 123456 --repo OWNER/REPO --exit-status
```

Replace the run ID and repository. `gh` must already be authenticated in that environment. Command approval and sandbox requirements still apply.

Commands execute directly, without an implicit shell. For a PowerShell script:

```powershell
$jobId = [guid]::NewGuid().ToString()
agent-wake run --name ci --job-id $jobId --timeout 2h -- pwsh -NoProfile -File .\wait-ci.ps1
```

Use a fresh UUID for a distinct job. After an uncertain registration response, reuse the original UUID and identical arguments; do not start a duplicate command.

## Send an external completion event

The event producer must inherit the target chat's `CODEX_THREAD_ID` and configuration. For example, a local process launched by Codex can send:

```powershell
$eventId = [guid]::NewGuid().ToString()
agent-wake emit --name build --event-id $eventId --text "Build finished"
```

For structured output:

```powershell
$eventId = [guid]::NewGuid().ToString()
agent-wake emit --name benchmark --event-id $eventId --json-file .\result.json --detach
```

These are alternatives: choose a fresh event ID for a different payload. `emit` accepts exactly one text or JSON payload, up to 32 KiB. Synchronous delivery attempts once; `--detach` enables background retries in safe delivery states. `emit` is a local CLI, not an HTTP webhook endpoint.

## Inspect and manage jobs

```powershell
agent-wake status $jobId
agent-wake jobs
agent-wake cancel $jobId
agent-wake deliver $jobId
```

Jobs are scoped to the current chat. Receipts and logs live under `~/.codex/agent-wake/jobs/UUID` (or `CODEX_HOME`). The receipt includes their exact directory.

`deliver` only attempts delivery of a completed event in an eligible state; it never reruns the original command. See [delivery states and recovery](docs/operations.md).

## Ask Codex in natural language

> Use $agent-wake to run the benchmark in the background and inspect the result when it finishes.

> Wait for GitHub Actions run 123456 in OWNER/REPO, then continue this task when CI finishes.

> Start the authorized test command, return control to me, and wake this chat on success, failure, or timeout.

The skill explains how to register a job, retain its ID, interpret the receipt, and continue within the original task's authorization.

## Limits

The computer and shared App Server must remain running. The target chat must be loaded at registration and delivery; a busy chat can queue tool output. The CLI does not load or fork chats, answer approvals, or recover a running command after an OS restart.

`accepted` confirms that the App Server accepted the event, not that Codex completed its follow-up work. A lost acknowledgment can produce `delivery_unknown`; automatic replay stops to avoid duplicate continuations. There is no exactly-once delivery guarantee.

Commands inherit the caller's permissions, working directory, and environment. Results and logs are untrusted tool data. A completion event does not authorize additional actions. See [operational details](docs/operations.md).

## Development and tests

```powershell
$env:AGENT_WAKE_TEST_ROOT = Join-Path (Get-Location) 'work\tests'
npm test
```

Tests use a fake App Server and short-lived local subprocesses. They do not send events to real chats. GitHub Actions runs the suite on Windows with Node.js 22 and 24.

```text
agent-wake/
├── cli.mjs                     CLI and job registration
├── rpc.mjs                     App Server connection
├── store.mjs                   Durable receipts and locks
├── worker.mjs                  Execution and delivery worker
├── install.ps1                 Windows CLI + skill installer
├── skills/agent-wake/SKILL.md   Discoverable Codex skill
├── docs/                       Configuration and operations
├── examples/                   Placeholder configuration
└── test/                       Isolated tests
```

## Related documentation

- [Configuration, compatibility, and troubleshooting](docs/configuration.md)
- [Delivery states, retries, logs, and cancellation](docs/operations.md)
- [Codex skill instructions](skills/agent-wake/SKILL.md)
- [OpenAI App Server protocol](https://learn.chatgpt.com/docs/app-server)

## License

[MIT](LICENSE) © 2026 Artem Kovalchuk.

Search terms: agent wake, agent awake, Codex wake up, Codex Desktop background tasks, Codex agent skill, async command completion, CI completion notification, background job runner, event-driven AI agent.

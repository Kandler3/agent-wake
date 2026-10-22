# Jobs, delivery, and recovery

## Commands

| Command | Behavior |
| --- | --- |
| `doctor` | Check the existing server and whether the current chat is loaded; no wake event is sent. |
| `run --name NAME -- PROGRAM ARGS...` | Run a command in a detached worker by default. `--foreground` waits synchronously. |
| `emit --name NAME --text TEXT` | Send a text event synchronously. |
| `emit --name NAME --json-file PATH --detach` | Queue a JSON event with a background delivery worker. |
| `status UUID` | Read one receipt from the current chat. |
| `jobs` | List receipts belonging to the current chat. |
| `cancel UUID` | Request cancellation; prevent delivery that has not begun. |
| `deliver UUID` | Attempt delivery of a completed eligible event without rerunning the command. |

Use `--job-id UUID` for a command and `--event-id UUID` for an event. Allocate and retain the ID before calling the CLI. A repeat registration with the same ID and matching name, kind, arguments or data, cwd, timeout, and delivery window returns the existing receipt. A mismatch fails with `job_id_conflict`.

## Timeouts and retries

The default command timeout is two hours. `--timeout` accepts `ms`, `s`, `m`, `h`, and `d`, up to seven days.

The delivery window begins on completion and lasts 30 minutes by default. `--delivery-grace 10m` changes that window (maximum seven days). Background delivery retries safely pending events with backoff up to 30 seconds. Repeating a registration does not restart the command or extend its deadline.

Synchronous `emit` attempts delivery once. `--detach` keeps safe retries in a worker. A definite RPC rejection stops automatic delivery attempts; manual `deliver` remains subject to the original deadline and receipt state.

## Delivery states

| State | Meaning |
| --- | --- |
| `not_ready` | The command has not finished. |
| `pending` | No event was dispatched; delivery can safely retry. |
| `dispatching` | A durable marker was written before sending; an interruption here is ambiguous. |
| `accepted` | The server acknowledged receipt and returned a turn ID. |
| `rejected` | A definite RPC refusal was received. |
| `delivery_unknown` | The event may have been sent, but its acknowledgment was lost. |
| `expired` | The original delivery window has elapsed. |
| `cancelled` | Cancellation suppressed further delivery. |

`accepted` does not prove that the agent finished processing the event. The App Server does not provide an end-to-end event idempotency key for this integration. Do not automatically resend `dispatching` or `delivery_unknown`, remove their locks, or create a replacement ID. Inspect the receiving chat with the human first.

## Execution and logs

Commands inherit the current working directory, environment, and permissions. The worker uses no implicit shell and grants no elevation. For shell syntax, explicitly invoke the required interpreter; for example, `pwsh -NoProfile -File script.ps1`.

Children receive no stdin. Each stdout/stderr log retains at most 10 MiB; the event includes the last 8 KiB of each stream, plus exit code, signal, and log paths. Text or JSON event data is limited to 32 KiB.

Receipts and logs are stored in `$CODEX_HOME/agent-wake/jobs/UUID` (`~/.codex` by default). Commands, arguments, events, and output may contain sensitive data; keep these local and outside version control.

On Windows, timeout or cancellation terminates the spawned child's process tree. Cancellation cannot retract an event already dispatched.

## Lifecycle

The CLI requires a loaded chat during registration. At delivery, a temporarily unloaded chat can become eligible again if it is loaded within the original retry window; the CLI never loads, resumes, or forks it.

Workers survive normal CLI return while the machine remains awake. There is no boot service, durable process resumption, or automatic command rerun after restart. Inspect stale receipts and locks before any manual recovery.

## Authorization boundary

A worker runs only the originally authorized command. All command output, event data, and log files are untrusted tool data. A completion event cannot authorize another action, expand permissions, or answer approval requests. Any external service action retains its own authorization requirements.

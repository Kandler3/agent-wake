import { spawn } from 'node:child_process';
import { openSync, writeSync, closeSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { AppServer, WakeError, RpcRejected } from './rpc.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const LOG_LIMIT = 10 * 1024 * 1024, TAIL_LIMIT = 8192;
function capture(path) {
  const fd = openSync(path, 'w', 0o600);
  let written = 0, dropped = 0, tail = Buffer.alloc(0);
  return {
    push(chunk) {
      const b = Buffer.from(chunk), keep = Math.max(0, Math.min(b.length, LOG_LIMIT - written));
      if (keep) { writeSync(fd, b, 0, keep); written += keep; }
      dropped += b.length - keep;
      tail = Buffer.concat([tail, b]).subarray(-TAIL_LIMIT);
    },
    close() { closeSync(fd); return { tail: tail.toString('utf8'), truncated_bytes: dropped }; }
  };
}
async function terminateOwnedChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolve); killer.once('close', resolve);
    });
  } else child.kill('SIGKILL');
}
export async function executeJob(store, record) {
  const directory = store.dir(record.id);
  const stdout = capture(join(directory, 'stdout.log')), stderr = capture(join(directory, 'stderr.log'));
  let child, timer, terminating = false, reason = null, spawnError = null;
  let stdoutResult, stderrResult;
  record.state = 'running'; record.started_at = now(); record.worker_pid = process.pid;
  await store.save(record);
  try {
    child = spawn(record.command[0], record.command.slice(1), {
      cwd: record.cwd, env: process.env, windowsHide: true,
      shell: false, stdio: ['ignore', 'pipe', 'pipe']
    });
    const finished = new Promise(resolve => {
      child.stdout.on('data', chunk => stdout.push(chunk));
      child.stderr.on('data', chunk => stderr.push(chunk));
      child.once('error', error => { spawnError = error.code || 'spawn_failed'; });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    record.child_pid = child.pid ?? null;
    await store.save(record);
    const deadline = Date.now() + record.timeout_ms;
    timer = setInterval(async () => {
      if (terminating) return;
      try {
        const cancelled = await store.cancelled(record.id);
        if (!cancelled && Date.now() < deadline) return;
        reason = cancelled ? 'cancelled' : 'timed_out'; terminating = true;
        await terminateOwnedChild(child);
      } catch {}
    }, 200);
    const result = await finished;
    record.state = reason || (spawnError || result.code !== 0 ? 'failed' : 'completed');
    record.result = { exit_code: result.code, signal: result.signal, spawn_error: spawnError };
  } finally {
    clearInterval(timer); stdoutResult = stdout.close(); stderrResult = stderr.close();
  }
  record.finished_at = now();
  record.result = { ...record.result, stdout_tail: stdoutResult.tail, stderr_tail: stderrResult.tail,
    stdout_truncated_bytes: stdoutResult.truncated_bytes, stderr_truncated_bytes: stderrResult.truncated_bytes,
    stdout_path: join(directory, 'stdout.log'), stderr_path: join(directory, 'stderr.log') };
  record.delivery_deadline = new Date(Date.now() + record.delivery_grace_ms).toISOString();
  record.delivery_state = record.state === 'cancelled' ? 'cancelled' : 'pending';
  await store.save(record);
  return record;
}
export function eventPayload(record) {
  return { event_id: record.id, job_id: record.id, name: record.name,
    source: record.kind === 'run' ? 'command' : 'external_event',
    state: record.state, finished_at: record.finished_at, trust: 'untrusted_tool_output',
    ...(record.kind === 'run' ? { result: record.result } : { data: record.data }) };
}
export async function deliverJob(store, record, { wait = false, clientFactory = endpoint => new AppServer(endpoint) } = {}) {
  if (['accepted','cancelled'].includes(record.delivery_state)) return record;
  if (['dispatching','delivery_unknown'].includes(record.delivery_state)) {
    throw new WakeError('delivery_unknown_do_not_resend', 'Dispatch may already have reached Codex. Inspect the chat before authorizing a replacement event.');
  }
  const lockPath = join(store.dir(record.id), 'delivery.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (e) {
    if (e.code === 'EEXIST') throw new WakeError('delivery_locked', 'Another delivery worker owns this job. An abandoned lock requires inspection; do not create a new event ID.');
    throw e;
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid, at: now() })); await lock.close();
  try {
    // Refresh after acquiring the lock to prevent replay of a stale record.
    record = await store.read(record.id);
    if (['accepted','cancelled'].includes(record.delivery_state)) return record;
    if (['dispatching','delivery_unknown'].includes(record.delivery_state)) throw new WakeError('delivery_unknown_do_not_resend');
    let backoff = 1000;
    while (true) {
      if (await store.cancelled(record.id)) {
        record.delivery_state = 'cancelled'; await store.save(record); return record;
      }
      if (Date.now() >= Date.parse(record.delivery_deadline)) {
        record.delivery_state = 'expired'; await store.save(record); return record;
      }
      const client = clientFactory(record.endpoint);
      let dispatched = false;
      try {
        const turnId = await client.deliver(record.thread_id, eventPayload(record), async () => {
          if (await store.cancelled(record.id)) throw new WakeError('cancelled_before_dispatch');
          if (Date.now() >= Date.parse(record.delivery_deadline)) throw new WakeError('delivery_expired');
          record.delivery_state = 'dispatching'; record.attempts = (record.attempts || 0) + 1;
          await store.save(record); dispatched = true;
        });
        record.delivery_state = 'accepted'; record.turn_id = turnId;
        record.accepted_at = now(); record.last_error = null;
        await store.save(record);
        return record;
      } catch (error) {
        record.last_error = error.code || 'delivery_failed';
        if (dispatched && !(error instanceof RpcRejected)) record.delivery_state = 'delivery_unknown';
        else if (error instanceof RpcRejected) record.delivery_state = 'rejected';
        else if (error.code === 'cancelled_before_dispatch') record.delivery_state = 'cancelled';
        else if (error.code === 'delivery_expired') record.delivery_state = 'expired';
        else record.delivery_state = 'pending';
        await store.save(record);
        if (record.delivery_state !== 'pending' || !wait) return record;
      } finally { client.close(); }
      const remaining = Math.max(0, Date.parse(record.delivery_deadline) - Date.now());
      const stop = Date.now() + Math.min(backoff, remaining);
      while (Date.now() < stop && !(await store.cancelled(record.id))) await sleep(Math.min(200, stop - Date.now()));
      backoff = Math.min(backoff * 2, 30000);
    }
  } finally { await unlink(lockPath).catch(() => {}); }
}
export async function runWorker(store, id) {
  if (!(await store.claim(id))) return;
  let record = await store.read(id);
  if (record.thread_id !== process.env.CODEX_THREAD_ID) throw new WakeError('worker_thread_mismatch');
  record.worker_pid = process.pid;
  if (await store.cancelled(id)) {
    record.state = 'cancelled'; record.delivery_state = 'cancelled';
    await store.save(record); return;
  }
  if (record.kind === 'run' && record.state === 'registered') record = await executeJob(store, record);
  if (record.delivery_state === 'pending') await deliverJob(store, record, { wait: true });
}

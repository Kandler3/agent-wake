import {mkdir, open, readFile, writeFile, rename, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {AppServer, WakeError} from './rpc.mjs';
import {validateId} from './store.mjs';

export const TITLE_PREFIX = '\u23f3 ';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

async function acquire(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const lock = await open(path, 'wx', 0o600);
      try { await lock.writeFile(JSON.stringify({pid:process.pid})); }
      catch (error) { await lock.close(); await unlink(path); throw error; }
      return lock;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new WakeError('title_lock_busy');
      await pause(25);
    }
  }
}

export async function syncBackgroundTitle(store, record, {
  clientFactory = endpoint => new AppServer(endpoint, {timeoutMs:1500}),
  isAlive = alive, lockTimeoutMs = 5000,
} = {}) {
  const threadId = validateId(record.thread_id);
  const directory = join(store.root, '.titles');
  await mkdir(directory, {recursive:true});
  const statePath = join(directory, threadId + '.json');
  const lockPath = join(directory, threadId + '.lock');
  const lock = await acquire(lockPath, lockTimeoutMs);
  let client;
  try {
    let saved = null;
    try { saved = JSON.parse(await readFile(statePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const active = (await store.list(threadId)).some(job =>
      job.background === true && job.indicator_active === true && isAlive(job.worker_pid));
    if (!active && !saved) return {active:false, changed:false};
    client = clientFactory(record.endpoint);
    await client.connect();
    const {thread} = await client.call('thread/read', {threadId, includeTurns:false});
    if (thread?.id !== threadId) throw new WakeError('title_thread_mismatch');
    const name = thread.name;
    if (active) {
      if (typeof name !== 'string' || !name.trim() || name.startsWith(TITLE_PREFIX)) {
        return {active:true, changed:false};
      }
      // Save ownership before the RPC: a lost reply must not lose the original name.
      const state = {base_name:name, marked_name:TITLE_PREFIX + name};
      await writeFile(statePath + '.tmp', JSON.stringify(state), {mode:0o600});
      await rename(statePath + '.tmp', statePath);
      await client.call('thread/name/set', {threadId, name:state.marked_name});
      return {active:true, changed:true};
    }
    // Preserve a manual rename, and never remove a prefix we did not add.
    let changed = false;
    if (name === saved.marked_name) {
      await client.call('thread/name/set', {threadId, name:saved.base_name});
      changed = true;
    }
    await unlink(statePath);
    return {active:false, changed};
  } finally {
    client?.close();
    await lock.close();
    await unlink(lockPath);
  }
}

export async function trySyncBackgroundTitle(store, record, options) {
  try { return await syncBackgroundTitle(store, record, options); }
  catch (error) {
    // A cosmetic failure must never stop a command or duplicate a completion event.
    console.error(JSON.stringify({warning:'background_title_update_failed', error:error.code || 'title_update_failed'}));
    return {changed:false, error:error.code || 'title_update_failed'};
  }
}

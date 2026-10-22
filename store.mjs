import { mkdir, readFile, writeFile, rename, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WakeError } from './rpc.mjs';

export function validateId(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')) throw new WakeError('invalid_job_id');
  return id.toLowerCase();
}
export function requireThread(env = process.env) {
  if (!env.CODEX_THREAD_ID) throw new WakeError('missing_thread_context', 'CODEX_THREAD_ID is required. Run this command from the intended Codex chat.');
  return validateId(env.CODEX_THREAD_ID);
}
export function duration(text) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(text || '');
  const n = m ? Number(m[1]) * {ms:1,s:1000,m:60000,h:3600000,d:86400000}[m[2]] : NaN;
  if (!Number.isFinite(n) || n < 1 || n > 7 * 86400000) throw new WakeError('invalid_timeout', 'Use a duration such as 30s, 20m or 2h (maximum 7d).');
  return n;
}
export class Store {
  constructor(root) { this.root = root; }
  dir(id) { return join(this.root, validateId(id)); }
  async create(record) {
    await mkdir(this.root, { recursive: true });
    try { await mkdir(this.dir(record.id)); }
    catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    await this.save(record);
    return true;
  }
  async save(record) {
    const file = join(this.dir(record.id), 'job.json');
    const tmp = file + '.' + randomUUID() + '.tmp';
    await writeFile(tmp, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, file);
  }
  async read(id) {
    let value;
    try { value = JSON.parse(await readFile(join(this.dir(id), 'job.json'), 'utf8')); }
    catch (e) { throw new WakeError('job_not_readable', 'Job receipt is missing or incomplete. The job will not be started again automatically.'); }
    if (value.id !== id || value.schema !== 1) throw new WakeError('invalid_job_receipt');
    return value;
  }
  async claim(id) {
    try {
      const handle = await open(join(this.dir(id), 'worker.lock'), 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      await handle.close();
      return true;
    } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  }
  async cancelled(id) {
    try { await readFile(join(this.dir(id), 'cancel.request')); return true; }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  }
  async cancel(id) { await writeFile(join(this.dir(id), 'cancel.request'), new Date().toISOString(), { mode: 0o600 }); }
  async list(threadId) {
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const rows = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const record = await this.read(validateId(entry.name));
        if (!threadId || record.thread_id === threadId) rows.push(record);
      } catch {}
    }
    return rows.sort((a,b) => b.created_at.localeCompare(a.created_at));
  }
}
export function publicStatus(record, directory) {
  return { job_id: record.id, name: record.name, state: record.state,
    delivery_state: record.delivery_state, thread_id: record.thread_id,
    created_at: record.created_at, finished_at: record.finished_at ?? null,
    worker_pid: record.worker_pid ?? null, exit_code: record.result?.exit_code ?? null,
    turn_id: record.turn_id ?? null, error: record.last_error ?? null, directory };
}

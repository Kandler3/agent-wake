#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AppServer, WakeError, sharedSettings } from './rpc.mjs';
import { Store, requireThread, validateId, duration, publicStatus } from './store.mjs';
import { runWorker, deliverJob } from './worker.mjs';
const base = dirname(fileURLToPath(import.meta.url));
const dataRoot = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'agent-wake', 'jobs');
const store = new Store(dataRoot);
const out = value => console.log(JSON.stringify(value));
const usage = [
'agent-wake: deliver command results to this Codex chat as tool output',
'',
'  agent-wake doctor',
'  agent-wake run --name NAME [--timeout 2h] [--foreground | --detach] [--job-id UUID] -- PROGRAM ARG...',
'  agent-wake emit --name NAME (--text TEXT | --json-file PATH) [--event-id UUID] [--detach]',
'  agent-wake status UUID',
'  agent-wake jobs',
'  agent-wake cancel UUID',
'  agent-wake deliver UUID',
'',
'Current chat: CODEX_THREAD_ID. Config: AGENT_WAKE_CONFIG or agent-wake/shared-desktop.json.',
'No login, user-message injection, automatic resume or elevation.',
'Default command timeout: 2h. Delivery retry window after completion: 30m.',
'Use --delivery-grace 10m to change the fixed delivery window (maximum 7d).',
'"accepted" means App Server acknowledged receipt; the agent may still be running.',
'A delivery_unknown/dispatching receipt must never be resent automatically.',
].join('\n');
function parse(argv) {
  const options = {}, rest = [];
  const booleans = new Set(['detach','foreground']);
  const values = new Set(['name','timeout','job-id','event-id','text','json-file','delivery-grace']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { rest.push(...argv.slice(i+1)); break; }
    if (!arg.startsWith('--')) { rest.push(arg); continue; }
    const key = arg.slice(2);
    if (key in options) throw new WakeError('duplicate_option', key);
    if (booleans.has(key)) options[key] = true;
    else if (values.has(key) && i+1 < argv.length) options[key] = argv[++i];
    else throw new WakeError('invalid_option', arg);
  }
  return { options, rest };
}
function nameValue(options) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(options.name || '')) throw new WakeError('invalid_name', '--name must contain 1-64 letters, digits, dot, underscore or dash.');
  return options.name;
}
function scoped(record) {
  if (record.thread_id !== requireThread()) throw new WakeError('wrong_thread', 'This job belongs to another chat.');
  return record;
}
async function launch(record) {
  const log = await open(join(store.dir(record.id), 'worker.log'), 'a', 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(base,'cli.mjs'), '--worker', record.id],
        { cwd: record.cwd, env: process.env, detached: true, windowsHide: true,
          stdio: ['ignore', log.fd, log.fd] });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  } finally { await log.close(); }
}
async function register(record, detached) {
  record.background = detached;
  if (!(await store.create(record))) {
    const existing = scoped(await store.read(record.id));
    const same = existing.kind === record.kind && existing.name === record.name &&
      JSON.stringify(existing.command || existing.data) === JSON.stringify(record.command || record.data) &&
      existing.cwd === record.cwd &&
      (record.kind !== 'run' || existing.timeout_ms === record.timeout_ms) &&
      existing.delivery_grace_ms === record.delivery_grace_ms;
    if (!same) throw new WakeError('job_id_conflict');
    out({ ...publicStatus(existing,store.dir(existing.id)), reused: true });
    return;
  }
  if (detached) {
    try { await launch(record); }
    catch (error) {
      record.state = 'launch_failed'; record.last_error = error.code || 'launch_failed';
      await store.save(record); throw new WakeError('launch_failed', 'Job was registered but the worker did not start. Inspect its receipt; do not start a duplicate command.');
    }
    out({ ...publicStatus(record,store.dir(record.id)), worker_started: true });
  } else {
    if (record.kind === 'run') await runWorker(store, record.id);
    else await deliverJob(store, record);
    const result = await store.read(record.id);
    out(publicStatus(result,store.dir(result.id)));
    if (!['accepted','cancelled'].includes(result.delivery_state)) process.exitCode = 2;
  }
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help','--help','-h'].includes(command)) { console.log(usage); return; }
  if (command === '--worker') { await runWorker(store,validateId(args[0])); return; }
  const { options, rest } = parse(args);
  if (command === 'doctor') {
    const settings = await sharedSettings(), thread = requireThread();
    const client = new AppServer(settings.endpoint);
    try {
      await client.preflight(thread);
      out({ ok:true, endpoint:settings.endpoint, thread_id:thread, current_thread_loaded:true,
        configured_version:settings.version, config_path:settings.configPath, transport:'turn/start.toolOutput', state_root:dataRoot });
    } finally { client.close(); }
    return;
  }
  if (command === 'jobs') {
    out((await store.list(requireThread())).map(r => publicStatus(r,store.dir(r.id)))); return;
  }
  if (['status','cancel','deliver'].includes(command)) {
    if (rest.length !== 1 || Object.keys(options).length) throw new WakeError('invalid_arguments');
    const id = validateId(rest[0]), record = scoped(await store.read(id));
    if (command === 'cancel') {
      await store.cancel(id);
      out({ ...publicStatus(record,store.dir(id)), cancellation_requested:true,
        already_dispatched:['accepted','dispatching','delivery_unknown'].includes(record.delivery_state) });
    } else if (command === 'deliver') {
      if (['registered','running','launch_failed'].includes(record.state)) throw new WakeError('job_not_completed');
      await deliverJob(store,record);
      const updated=await store.read(id); out(publicStatus(updated,store.dir(id)));
      if (updated.delivery_state !== 'accepted') process.exitCode=2;
    } else out(publicStatus(record,store.dir(id)));
    return;
  }
  if (!['run','emit'].includes(command)) throw new WakeError('unknown_command',command);
  const allowed = new Set(command === 'run'
    ? ['name','timeout','job-id','detach','foreground','delivery-grace']
    : ['name','text','json-file','event-id','detach','delivery-grace']);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new WakeError('invalid_option',key);
  if (options.detach && options.foreground) throw new WakeError('conflicting_options');
  const settings = await sharedSettings(), thread = requireThread();
  const deliveryGrace = duration(options['delivery-grace'] || '30m');
  const record = { schema:1, id:validateId(options['job-id'] || options['event-id'] || randomUUID()),
    name:nameValue(options), kind:command, thread_id:thread, endpoint:settings.endpoint,
    cwd:process.cwd(), created_at:new Date().toISOString(), state:command === 'run' ? 'registered' : 'completed',
    delivery_state:command === 'run' ? 'not_ready' : 'pending', delivery_grace_ms:deliveryGrace };
  if (command === 'run') {
    if (!rest.length) throw new WakeError('missing_command');
    record.command = rest; record.timeout_ms = duration(options.timeout || '2h');
  } else {
    if (rest.length || ('text' in options) === ('json-file' in options)) throw new WakeError('invalid_event', 'Supply exactly one of --text or --json-file.');
    if ('text' in options) record.data = { text:options.text };
    else {
      const handle = await open(options['json-file'],'r');
      let raw;
      try {
        const stat = await handle.stat();
        if (stat.size > 32768 || !stat.isFile()) throw new WakeError('event_too_large');
        raw = await handle.readFile('utf8');
      } finally { await handle.close(); }
      record.data = JSON.parse(raw.replace(/^\uFEFF/,''));
    }
    if (Buffer.byteLength(JSON.stringify(record.data),'utf8') > 32768) throw new WakeError('event_too_large', 'Event payload limit is 32 KiB.');
    record.finished_at = new Date().toISOString();
    record.delivery_deadline = new Date(Date.now()+deliveryGrace).toISOString();
  }
  // Only use chats loaded in this same server. No implicit resume or fork.
  const probe = new AppServer(record.endpoint);
  try { await probe.preflight(thread); } finally { probe.close(); }
  await register(record, command === 'run' ? !options.foreground : Boolean(options.detach));
}
main().catch(error => {
  console.error(JSON.stringify({ error:error.code || 'agent_wake_failed', message:error.message || 'Operation failed.' }));
  process.exitCode=1;
});

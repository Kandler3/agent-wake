import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export class WakeError extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}
export class RpcRejected extends WakeError {
  constructor(error) {
    super('app_server_rejected', 'App Server rejected the event.');
    this.rpcCode = error?.code;
  }
}
export function localEndpoint(value) {
  let u;
  try { u = new URL(value); } catch { throw new WakeError('invalid_endpoint'); }
  if (u.protocol !== 'ws:' || u.hostname !== '127.0.0.1' || !u.port ||
      u.username || u.password || u.search || u.hash || u.pathname !== '/') {
    throw new WakeError('invalid_endpoint', 'Only the configured loopback App Server is supported.');
  }
  return u.href;
}
export async function sharedSettings(home = process.env.CODEX_HOME || join(homedir(), '.codex'),
  explicitPath = process.env.AGENT_WAKE_CONFIG) {
  const path = explicitPath || join(home, 'agent-wake', 'shared-desktop.json');
  let raw;
  try { raw = await readFile(path, 'utf8'); }
  catch {
    throw new WakeError('shared_server_not_configured', 'Cannot read the Agent Wake App Server configuration. See docs/configuration.md. Desktop is not restarted automatically.');
  }
  let config;
  try { config = JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch { throw new WakeError('invalid_shared_configuration', 'The App Server configuration must be valid JSON.'); }
  if (!config || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw new WakeError('invalid_shared_configuration');
  }
  return { endpoint: localEndpoint('ws://127.0.0.1:' + config.port),
    version: config.version, node: config.node, configPath: path };
}
export class AppServer {
  constructor(endpoint, { timeoutMs = 12000, WebSocketClass = globalThis.WebSocket } = {}) {
    this.endpoint = localEndpoint(endpoint);
    this.timeoutMs = timeoutMs;
    this.WebSocketClass = WebSocketClass;
    this.pending = new Map();
    this.counter = 0;
    this.ws = null;
  }
  async connect() {
    const ws = this.ws = new this.WebSocketClass(this.endpoint);
    ws.addEventListener('message', event => {
      let msg;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      // This bridge never answers server requests, including approval requests.
      if ('method' in msg || !this.pending.has(msg.id)) return;
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if ('error' in msg) pending.reject(new RpcRejected(msg.error));
      else pending.resolve(msg.result);
    });
    const fail = () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new WakeError('app_server_disconnected'));
      }
      this.pending.clear();
    };
    ws.addEventListener('close', fail);
    ws.addEventListener('error', fail);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ws.close(); reject(new WakeError('app_server_unavailable')); }, this.timeoutMs);
        ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        ws.addEventListener('error', () => { clearTimeout(timer); reject(new WakeError('app_server_unavailable')); }, { once: true });
        ws.addEventListener('close', () => { clearTimeout(timer); reject(new WakeError('app_server_unavailable')); }, { once: true });
      });
      await this.call('initialize', { clientInfo: { name: 'agent_wake_bridge', version: '1.0.0' },
        capabilities: { experimentalApi: true } });
      ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    } catch (error) { this.close(); throw error; }
  }
  call(method, params) {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WakeError('app_server_timeout'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async requireLoaded(threadId) {
    let cursor = null;
    for (let page = 0; page < 100; page++) {
      const result = await this.call('thread/loaded/list', { cursor, limit: 100 });
      if (result.data?.includes(threadId)) return;
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    throw new WakeError('target_thread_not_loaded', 'The target chat is not loaded in this shared App Server. No resume or fork was attempted.');
  }
  async preflight(threadId) { await this.connect(); await this.requireLoaded(threadId); }
  async deliver(threadId, payload, beforeSend) {
    await this.preflight(threadId);
    await beforeSend();
    // The caller durably records "dispatching" before this call. A lost response
    // must not cause automatic replay; App Server has no event idempotency key.
    const response = await this.call('turn/start', { threadId, input: [],
      toolOutput: { name: 'event_completed', namespace: 'agent_wake', output: JSON.stringify(payload) } });
    if (!response?.turn?.id) throw new WakeError('invalid_dispatch_response');
    return response.turn.id;
  }
  close() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new WakeError('app_server_disconnected')); }
    this.pending.clear();
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
  }
}

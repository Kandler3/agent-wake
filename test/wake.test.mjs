import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppServer, WakeError, RpcRejected, localEndpoint, sharedSettings } from '../rpc.mjs';
import { Store, requireThread, duration } from '../store.mjs';
import { executeJob, deliverJob, eventPayload } from '../worker.mjs';

const thread='00000000-0000-4000-8000-000000000001';
const root=resolve(process.env.AGENT_WAKE_TEST_ROOT || 'work/tests');
await mkdir(root,{recursive:true});
async function fixture(t) {
  const path=await mkdtemp(join(root,'wake-test-'));
  t.after(async()=>{
    const target=resolve(path);
    if (!target.startsWith(root+sep) || !target.slice(root.length+1).startsWith('wake-test-')) throw new Error('Unsafe cleanup target');
    await rm(target,{recursive:true,force:true});
  });
  const store=new Store(path);
  const record={schema:1,id:randomUUID(),thread_id:thread,name:'test',kind:'emit',cwd:process.cwd(),
    endpoint:'ws://127.0.0.1:48963/',state:'completed',delivery_state:'pending',
    created_at:new Date().toISOString(),finished_at:new Date().toISOString(),
    delivery_grace_ms:1000,delivery_deadline:new Date(Date.now()+10000).toISOString(),data:{ok:true}};
  await store.create(record);
  return {store,record};
}
test('requires thread context, validates duration and loopback endpoint',()=>{
  assert.throws(()=>requireThread({}),{code:'missing_thread_context'});
  assert.equal(requireThread({CODEX_THREAD_ID:thread}),thread);
  assert.equal(duration('2h'),7200000);
  assert.throws(()=>duration('8d'));
  for(const endpoint of ['ws://example.com:80','ws://127.0.0.1:80/?token=a','http://127.0.0.1:80','ws://u:p@127.0.0.1:80'])
    assert.throws(()=>localEndpoint(endpoint));
});
test('RPC emits standalone tool output and ignores server approval requests',async()=>{
  const sent=[];
  class FakeSocket extends EventTarget {
    constructor() {super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
    send(raw) {
      const msg=JSON.parse(raw);sent.push(msg);
      if(!('id' in msg))return;
      const result=msg.method==='initialize'?{}:msg.method==='thread/loaded/list'?{data:[thread]}:{turn:{id:'turn-test'}};
      queueMicrotask(()=>{
        this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:900,method:'item/commandExecution/requestApproval',params:{}})}));
        this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:msg.id,result})}));
      });
    }
    close() {this.dispatchEvent(new Event('close'));}
  }
  const rpc=new AppServer('ws://127.0.0.1:48963',{WebSocketClass:FakeSocket,timeoutMs:1000});
  let committed=false;
  try {
    const turn=await rpc.deliver(thread,{event_id:'evt',data:'sample'},async()=>{committed=true;});
    assert.equal(turn,'turn-test');assert.equal(committed,true);
    const dispatch=sent.find(m=>m.method==='turn/start');
    assert.deepEqual(dispatch.params.input,[]);
    assert.equal(dispatch.params.toolOutput.namespace,'agent_wake');
    assert.equal(JSON.parse(dispatch.params.toolOutput.output).data,'sample');
    assert.equal(sent.some(m=>m.id===900),false);
    assert.equal(sent.some(m=>m.method==='thread/resume'),false);
  }finally{rpc.close();}
});
test('lost acknowledgment is persisted and cannot be replayed',async t=>{
  const {store,record}=await fixture(t);let calls=0;
  const clientFactory=()=>({close(){},async deliver(t,p,before){calls++;await before();throw new WakeError('app_server_disconnected');}});
  const result=await deliverJob(store,record,{clientFactory});
  assert.equal(result.delivery_state,'delivery_unknown');
  await assert.rejects(()=>deliverJob(store,result,{clientFactory}),{code:'delivery_unknown_do_not_resend'});
  assert.equal(calls,1);
});
test('unavailable server before send remains safely pending',async t=>{
  const {store,record}=await fixture(t);
  const result=await deliverJob(store,record,{clientFactory:()=>({close(){},async deliver(){throw new WakeError('app_server_unavailable');}})});
  assert.equal(result.delivery_state,'pending');assert.equal(result.attempts,undefined);
});
test('definite RPC rejection differs from unknown delivery',async t=>{
  const {store,record}=await fixture(t);
  const result=await deliverJob(store,record,{clientFactory:()=>({close(){},async deliver(t,p,before){await before();throw new RpcRejected({code:-1});}})});
  assert.equal(result.delivery_state,'rejected');
});
test('accepted event has receipt and is not sent twice',async t=>{
  const {store,record}=await fixture(t);let calls=0;
  const clientFactory=()=>({close(){},async deliver(t,p,before){calls++;await before();return 'turn-test';}});
  await deliverJob(store,record,{clientFactory});
  await deliverJob(store,await store.read(record.id),{clientFactory});
  assert.equal(calls,1);
  assert.equal((await store.read(record.id)).turn_id,'turn-test');
});
test('cancelled and expired events do not dispatch',async t=>{
  const {store,record}=await fixture(t);
  const clientFactory=()=>{throw new Error('Must not connect');};
  await store.cancel(record.id);
  assert.equal((await deliverJob(store,record,{clientFactory})).delivery_state,'cancelled');
  const next={...record,id:randomUUID(),delivery_state:'pending',delivery_deadline:new Date(0).toISOString()};
  await store.create(next);
  assert.equal((await deliverJob(store,next,{clientFactory})).delivery_state,'expired');
});
test('worker claim prevents starting same command twice',async t=>{
  const {store,record}=await fixture(t);
  assert.equal(await store.claim(record.id),true);
  assert.equal(await store.claim(record.id),false);
});
test('actual command success, failure, stdout tail and retained log',async t=>{
  const {store,record}=await fixture(t);
  record.kind='run';record.state='registered';record.timeout_ms=5000;
  record.command=[process.execPath,'-e','process.stdout.write("x".repeat(12000));process.stderr.write("failure detail");process.exitCode=7'];
  const result=await executeJob(store,record);
  assert.equal(result.state,'failed');assert.equal(result.result.exit_code,7);
  assert.equal(Buffer.byteLength(result.result.stdout_tail),8192);
  assert.equal((await readFile(result.result.stdout_path)).length,12000);
  assert.equal(eventPayload(result).trust,'untrusted_tool_output');
  assert.equal(eventPayload(result).result.stderr_tail,'failure detail');
});
test('timeout terminates only the started test child',async t=>{
  const {store,record}=await fixture(t);
  record.kind='run';record.state='registered';record.timeout_ms=150;
  record.command=[process.execPath,'-e','setInterval(()=>{},1000)'];
  const result=await executeJob(store,record);
  assert.equal(result.state,'timed_out');
  assert.equal(result.delivery_state,'pending');
});
test('cancel stops a running child and suppresses its wake event',async t=>{
  const {store,record}=await fixture(t);
  record.kind='run';record.state='registered';record.timeout_ms=5000;
  record.command=[process.execPath,'-e','setInterval(()=>{},1000)'];
  const timer=setTimeout(()=>store.cancel(record.id),100);
  try {
    const result=await executeJob(store,record);
    assert.equal(result.state,'cancelled');
    assert.equal(result.delivery_state,'cancelled');
  }finally{clearTimeout(timer);}
});


test('own config and explicit override use the selected file', async t => {
  const {store} = await fixture(t);
  await assert.rejects(() => sharedSettings(store.root, ''), {code:'shared_server_not_configured'});
  const primary = join(store.root, 'agent-wake', 'shared-desktop.json');
  await mkdir(join(store.root, 'agent-wake'), {recursive:true});
  await writeFile(primary, '\uFEFF' + JSON.stringify({port:45002}));
  assert.equal((await sharedSettings(store.root, '')).configPath, primary);
  assert.equal((await sharedSettings(store.root, '')).endpoint, 'ws://127.0.0.1:45002/');
  const custom = join(store.root, 'custom.json');
  await writeFile(custom, JSON.stringify({port:45001}));
  assert.equal((await sharedSettings(store.root, custom)).endpoint, 'ws://127.0.0.1:45001/');
});

test('missing explicit config and invalid own config fail without fallback', async t => {
  const {store} = await fixture(t);
  const primary = join(store.root, 'agent-wake', 'shared-desktop.json');
  await mkdir(join(store.root, 'agent-wake'), {recursive:true});
  await writeFile(primary, JSON.stringify({port:45002}));
  await assert.rejects(() => sharedSettings(store.root, join(store.root, 'missing.json')), {code:'shared_server_not_configured'});
  for (const value of ['{', 'null', '{"port":"45000"}', '{"port":80}', '{"port":65536}']) {
    await writeFile(primary, value);
    await assert.rejects(() => sharedSettings(store.root, ''), {code:'invalid_shared_configuration'});
  }
});

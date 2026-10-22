import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, readFile} from 'node:fs/promises';
import {join, resolve, sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../store.mjs';
import {TITLE_PREFIX, syncBackgroundTitle, trySyncBackgroundTitle} from '../title.mjs';

const threadId = '00000000-0000-4000-8000-000000000001';
const root = resolve(process.env.AGENT_WAKE_TEST_ROOT || 'work/tests');
async function fixture(t, name='Test chat') {
  await mkdir(root,{recursive:true});
  const path=await mkdtemp(join(root,'wake-title-'));
  t.after(async () => {
    const target=resolve(path);
    if (!target.startsWith(root+sep) || !target.slice(root.length+1).startsWith('wake-title-')) throw new Error('Unsafe cleanup target');
    await rm(target,{recursive:true,force:true});
  });
  const store=new Store(path);
  const record={schema:1,id:randomUUID(),thread_id:threadId,endpoint:'ws://127.0.0.1:45000/',
    kind:'run',state:'running',delivery_state:'not_ready',background:true,indicator_active:true,
    worker_pid:process.pid,created_at:new Date().toISOString()};
  await store.create(record);
  const calls=[];
  const clientFactory=()=>({
    async connect(){}, close(){},
    async call(method,params) {
      calls.push({method,params});
      if(method==='thread/read') return {thread:{id:threadId,name}};
      assert.equal(method,'thread/name/set');
      assert.deepEqual(Object.keys(params).sort(),['name','threadId']);
      name=params.name;
      return {};
    }
  });
  return {store,record,calls,options:{clientFactory},name:()=>name,rename:value=>{name=value;}};
}
async function finish(f, record=f.record) {
  record.indicator_active=false;
  await f.store.save(record);
  await syncBackgroundTitle(f.store,record,f.options);
}

test('adds one prefix, keeps it for two jobs, and removes it after the last job',async t=>{
  const f=await fixture(t);
  await syncBackgroundTitle(f.store,f.record,f.options);
  assert.equal(f.name(),TITLE_PREFIX+'Test chat');
  const second={...f.record,id:randomUUID()};
  await f.store.create(second);
  await Promise.all([
    syncBackgroundTitle(f.store,f.record,f.options),
    syncBackgroundTitle(f.store,second,f.options),
  ]);
  assert.equal(f.name(),TITLE_PREFIX+'Test chat');
  await finish(f);
  assert.equal(f.name(),TITLE_PREFIX+'Test chat');
  await finish(f,second);
  assert.equal(f.name(),'Test chat');
  assert.equal(f.calls.filter(c=>c.method==='thread/name/set').length,2);
  assert.ok(f.calls.every(c=>!['turn/start','thread/resume','thread/fork'].includes(c.method)));
});

test('preserves a manual chat rename while the job is running',async t=>{
  const f=await fixture(t);
  await syncBackgroundTitle(f.store,f.record,f.options);
  f.rename('My new title');
  await finish(f);
  assert.equal(f.name(),'My new title');
});

test('does not remove an original hourglass prefix',async t=>{
  const f=await fixture(t,TITLE_PREFIX+'Original title');
  await syncBackgroundTitle(f.store,f.record,f.options);
  await finish(f);
  assert.equal(f.name(),TITLE_PREFIX+'Original title');
  assert.equal(f.calls.filter(c=>c.method==='thread/name/set').length,0);
});

test('ignores jobs in another chat, foreground work and stale worker receipts',async t=>{
  const f=await fixture(t);
  f.record.background=false;
  await f.store.save(f.record);
  await f.store.create({...f.record,id:randomUUID(),background:true,thread_id:'00000000-0000-4000-8000-000000000002'});
  assert.equal((await syncBackgroundTitle(f.store,f.record,f.options)).active,false);
  f.record.background=true;
  await f.store.save(f.record);
  assert.equal((await syncBackgroundTitle(f.store,f.record,{...f.options,isAlive:()=>false})).active,false);
  assert.equal(f.calls.length,0);
});

test('a lost rename acknowledgment retains ownership and restores the title safely',async t=>{
  const f=await fixture(t);
  const normal=f.options.clientFactory;
  let loseReply=true;
  f.options.clientFactory=()=>{
    const client=normal();
    const call=client.call.bind(client);
    client.call=async(method,params)=>{
      const result=await call(method,params);
      if(method==='thread/name/set' && loseReply){loseReply=false;throw new Error('reply lost');}
      return result;
    };
    return client;
  };
  await assert.rejects(()=>syncBackgroundTitle(f.store,f.record,f.options));
  assert.equal(f.name(),TITLE_PREFIX+'Test chat');
  await finish(f);
  assert.equal(f.name(),'Test chat');
});

test('title failures are cosmetic and do not change a job receipt',async t=>{
  const f=await fixture(t);
  const before=await readFile(join(f.store.dir(f.record.id),'job.json'),'utf8');
  const result=await trySyncBackgroundTitle(f.store,f.record,{clientFactory:()=>({async connect(){throw Object.assign(new Error('offline'),{code:'offline'});},close(){}})});
  assert.equal(result.error,'offline');
  assert.equal(await readFile(join(f.store.dir(f.record.id),'job.json'),'utf8'),before);
});

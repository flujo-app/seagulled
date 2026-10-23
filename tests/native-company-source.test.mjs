import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,readdirSync,readFileSync,writeFileSync,lstatSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Controller} from '../upstream/swarm-teams/fleet/controller.mjs';
import {createNativeCompanySource} from '../src/native-company-source.mjs';

// Real Controller ownership and private transport; deterministic Source/provider
// edges. These tests do not qualify a provider, Fly image or live swarm.
async function equipment(t){
  const directory=mkdtempSync(path.join(tmpdir(),'seagulled-native-company-'));
  const stop=new AbortController();let calls=0,closed=false;
  const model={id:'owned-model',name:'gpt-6-luna',provider:'codex',adapter:'codex-cli',ApiKey:'',reasoningEffort:'medium'};
  const server=createServer((request,response)=>{
    const url=new URL(request.url,'http://source');
    assert.equal(url.searchParams.get('workspace'),'owned-workspace');
    const value=url.pathname==='/api/model'?[model]:{id:url.pathname.split('/').at(-1),nodes:[],edges:[]};
    response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(value));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const controller=new Controller({registryPath:path.join(directory,'registry.json'),operatorToken:randomBytes(32).toString('base64url'),publicUrl:origin,provisioner:{}});
  const goal=controller.registry.createGoal({text:'Offline assembly only'});
  const {worker,token}=controller.registry.reserve({goalId:goal.id,role:'supervisor'});
  controller.registry.enroll(worker.id,{kind:'external',origin,workspace:'owned-workspace',token:'synthetic-target'});
  const run=controller.registry.startRun({workerId:worker.id,startedBy:'operator',task:'Offline ownership only',flowName:'owned-flow'});
  controller.registry.bindRunTarget(run.id,worker.target);
  const claim={goalId:goal.id,runId:run.id,rootConversationId:run.conversationId,workspace:'owned-workspace'};
  const source=await createNativeCompanySource({controller,goalId:goal.id,dataDir:directory,modelName:model.name,reasoningEffort:'medium',
    scope:{signal:stop.signal,async assertCurrent(actor){stop.signal.throwIfAborted();assert.equal(actor.goalId,goal.id);},
      async commit(task,actor){stop.signal.throwIfAborted();assert.equal(actor.goalId,goal.id);return task();},async retainUncertainty(){stop.abort();}},
    sourceFactory:()=>({async source(){return {sourceOrigin:origin};},async requestWorker(input){calls++;assert.equal(input.workerAuthorization,`Bearer ${token}`);
      assert.deepEqual(input.claim,claim);return {status:200,body:{fixture:true}};},async close(){closed=true;}})});
  const input={workerAuthorization:`Bearer ${token}`,claim,flowId:'owned-flow',modelId:model.id,
    child:{parentNodeId:'owned-subflow',flowId:'owned-child'}};
  t.after(async()=>{
    await source.close();await controller.close();await new Promise(resolve=>server.close(resolve));
    const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));
    assert.match(path.basename(target),/^seagulled-native-company-/);assert.equal(lstatSync(target).isSymbolicLink(),false);
    rmSync(target,{recursive:true,force:true});
  });
  return {source,input,stop,calls:()=>calls,closed:()=>closed,token,
    record:()=>path.join(directory,'native-installations',goal.id,readdirSync(path.join(directory,'native-installations',goal.id))[0])};
}

test('assembly captures real installed plans under Controller ownership and dispatches each opaque handle once',async t=>{
  const e=await equipment(t);
  await assert.rejects(e.source.prepareWorker({...e.input,workerAuthorization:'Bearer synthetic-forged'}));
  const handle=await e.source.prepareWorker(e.input);
  const saved=readFileSync(e.record(),'utf8');assert.ok(!saved.includes(e.token));assert.ok(!saved.includes('Authorization'));
  assert.equal(JSON.parse(saved).children.length,1);
  await assert.rejects(e.source.prepareWorker(e.input));
  await assert.rejects(e.source.requestWorker({...handle},'offline'));
  assert.equal((await e.source.requestWorker(handle,'offline')).status,200);
  await assert.rejects(e.source.requestWorker(handle,'offline'));assert.equal(e.calls(),1);
  await e.source.close();assert.equal(e.closed(),true);await assert.rejects(e.source.requestWorker(handle,'offline'));
});

test('changed installation record blocks the original handle before Source dispatch',async t=>{
  const e=await equipment(t),handle=await e.source.prepareWorker(e.input);
  const saved=JSON.parse(readFileSync(e.record(),'utf8'));saved.children[0].flowDigest='f'.repeat(64);
  writeFileSync(e.record(),JSON.stringify(saved));
  await assert.rejects(e.source.requestWorker(handle,'offline'));assert.equal(e.calls(),0);
});

test('cancelled runtime scope blocks the original handle before Source dispatch',async t=>{
  const e=await equipment(t),handle=await e.source.prepareWorker(e.input);e.stop.abort(new Error('Synthetic pause'));
  await assert.rejects(e.source.requestWorker(handle,'offline'));assert.equal(e.calls(),0);
});

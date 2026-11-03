import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,lstatSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Controller} from '../upstream/swarm-teams/fleet/controller.mjs';
import {createNativeWorkerSourceClient} from '../src/native-worker-source-client.mjs';

// Actual existing Controller scheduling/authentication; deterministic Source
// edge only. No provider or cloud qualification is claimed by these tests.
function equipment(t) {
  const directory=mkdtempSync(path.join(tmpdir(),'seagulled-native-run-'));
  const stop=new AbortController(),calls=[];let client,response={status:200,body:{choices:[{message:{content:'offline result'}}]}};
  const controller=new Controller({registryPath:path.join(directory,'registry.json'),
    operatorToken:randomBytes(32).toString('base64url'),publicUrl:'http://127.0.0.1:1',
    provisioner:{async connect(){return {client,async close(){}};}}});
  const goal=controller.registry.createGoal({text:'Offline Controller dispatch'});
  const {worker,token}=controller.registry.reserve({goalId:goal.id,role:'team'});
  const target={kind:'workspace',origin:'http://127.0.0.1:1',workspace:'owned-workspace',token:'synthetic-target'};
  controller.registry.enroll(worker.id,target);
  const scope={signal:stop.signal,async assertCurrent(actor){stop.signal.throwIfAborted();assert.equal(actor.workerId,worker.id);}};
  const installation={flowName:'installed-lead',flowId:'owned-lead',modelId:'owned-luna',
    child:{parentNodeId:'owned-subflow',flowId:'owned-child'}};
  const source={async prepareWorker(input){calls.push(input);controller.resolveNativeOriginalRun({headers:{authorization:input.workerAuthorization}},input.claim);return {};},
    async requestWorker(_handle,prompt){calls.push(prompt);return response;}};
  const options={controller,source,scope,target,workerAuthorization:`Bearer ${token}`,installation};
  client=createNativeWorkerSourceClient(options);
  t.after(async()=>{await controller.close();const checked=path.resolve(directory);
    assert.equal(path.dirname(checked),path.resolve(tmpdir()));assert.match(path.basename(checked),/^seagulled-native-run-/);
    assert.equal(lstatSync(checked).isSymbolicLink(),false);rmSync(checked,{recursive:true,force:true});});
  return {controller,goal,worker,target,stop,client,calls,options,installation,setResponse(value){response=value;}};
}

test('existing Controller dispatch uses its original authenticated run and settles actual Source response',async t=>{
  const e=equipment(t);
  const run=e.controller.startRun({worker:e.worker,startedBy:'operator',task:'offline task',flowName:e.installation.flowName});
  await e.controller.waitRun('operator',{runId:run.id,timeoutMs:1000});
  const settled=e.controller.registry.run(run.id);
  assert.equal(settled.state,'completed');assert.equal(settled.output,'offline result');
  assert.equal(e.calls[0].claim.rootConversationId,run.conversationId);assert.equal(e.calls[0].claim.runId,run.id);
  assert.equal(e.calls[0].child.flowId,'owned-child');assert.equal(settled.usage.costUsd,null);
  assert.equal(settled.usage.tokenUsageAvailable,false);
  await assert.rejects(e.client.runFlow({flowName:e.installation.flowName,prompt:'replay',conversationId:run.conversationId}));
});

test('forged bearer, caller flow and unbound conversation cannot dispatch Source',async t=>{
  const e=equipment(t);
  assert.throws(()=>createNativeWorkerSourceClient({...e.options,workerAuthorization:'Bearer forged-token-xxxxxxxxxxxxxxxx'}));
  assert.throws(()=>createNativeWorkerSourceClient({...e.options,workerAuthorization:`Bearer ${e.controller.operatorToken}`}));
  await assert.rejects(e.client.runFlow({flowName:'caller-flow',prompt:'offline',conversationId:'foreign'}));
  await assert.rejects(e.client.runFlow({flowName:e.installation.flowName,prompt:'offline',conversationId:'foreign'}));
  assert.equal(e.calls.length,0);
});

test('Source refusal stays failed and cancellation prevents any dispatch',async t=>{
  const e=equipment(t);e.setResponse({status:500,body:{error:'offline refusal'}});
  const run=e.controller.startRun({worker:e.worker,startedBy:'operator',task:'offline',flowName:e.installation.flowName});
  await e.controller.waitRun('operator',{runId:run.id,timeoutMs:1000});assert.equal(e.controller.registry.run(run.id).state,'failed');
  e.stop.abort(new Error('Offline pause'));
  await assert.rejects(e.client.runFlow({flowName:e.installation.flowName,prompt:'offline',conversationId:'another'}));
  assert.equal(e.calls.length,2);
});

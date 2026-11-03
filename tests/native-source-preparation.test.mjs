import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRuntime} from '../src/runtime.mjs';

// Actual runtime and recovered coordinator; deterministic inspectors/fleet.
// This verifies admission order, never live provider or cloud qualification.
for (const cleanupFailure of [false,true]) test(`prepared Source scope fences its job and ${cleanupFailure?'retains unconfirmed cleanup':'closes on settlement'}`,async t=>{
  const dataDir=mkdtempSync(path.join(tmpdir(),'seagulled-source-preparation-'));
  const config=path.join(dataDir,'account');mkdirSync(config);
  const helper=path.join(config,'flyctl.exe');writeFileSync(helper,'offline helper only');
  writeFileSync(path.join(config,'config.yml'),'offline account only');
  const account={available:true,flyctlPath:helper,flyConfigDir:config,orgSlug:'offline-personal',
    scope:'private',accountRef:`fly-account-sha256:${'a'.repeat(64)}`};
  const binding={cloudSdkRoot:dataDir,sourceOrigin:'http://127.0.0.1:1',
    sourceInstanceDir:dataDir,sourceDataRoot:dataDir,sourceAppRoot:dataDir};
  const route={available:true,providerId:'codex',model:{name:'gpt-6-luna'},verification:'offline-only'};
  const providers={publicState:()=>[{id:'codex',available:true,connected:true}],
    async discover(){return this.publicState();},async flyFleetLease(){return account;},
    async fleetRoute(){return structuredClone(route);},async run(){return {text:JSON.stringify({done:false,tasks:[{task:'Offline fleet scope test'}]}),usage:{costKind:'subscription',costUsd:null}};}};
  let prepared,actor,effects=0,start,release,cleanupGoal;
  const started=new Promise(resolve=>{start=resolve;}),done=new Promise(resolve=>{release=resolve;});
  const sourceProvider=async input=>{
      prepared=input.nativeScope;actor={goalId:input.goal.id};
      assert.equal(input.goal.model,'gpt-6-luna');assert.equal(input.goal.reasoningEffort,'medium');
      await assert.rejects(Promise.resolve().then(()=>prepared.commit(()=>{effects++;},actor)),{code:'NATIVE_GOAL_SCOPE'});
      return binding;
    };
  sourceProvider.closeGoal=async goalId=>{
    cleanupGoal=goalId;
    await assert.rejects(prepared.assertCurrent(actor),{code:'NATIVE_GOAL_SCOPE'});
    if(cleanupFailure)throw new Error('PRIVATE_SOURCE_CLEANUP_DETAIL');
  };
  const app=createRuntime({dataDir,providers,sourceProvider,
    sourceInspector:async()=>({available:true,binding}),readyInspector:async()=>({available:true}),
    fleetRunner:async input=>{
      await prepared.assertCurrent(actor);await input.nativeScope.assertCurrent(actor);
      await assert.rejects(prepared.commit(()=>{effects++;},{goalId:'another-goal'}),{code:'NATIVE_GOAL_SCOPE'});
      await prepared.commit(()=>{effects++;},actor);start();await done;
      return {available:true,text:'Offline scope callback completed',usage:{costKind:'subscription',costUsd:null},
        sandbox:{kind:'fly',verification:'original-worker-hierarchy-v1',retired:true,cleanupConfirmed:true,
          bootCleanupConfirmed:true,relayCleanupConfirmed:true,relayUsed:false,
          workerCount:1,initialWorkerCount:1,localConversationCount:1,conversationCountVerified:2,teamLeadRuns:['offline-run']}};
    }});
  t.after(async()=>{release();await app.close();
    assert.equal(path.dirname(path.resolve(dataDir)),path.resolve(tmpdir()));
    assert.equal(lstatSync(dataDir).isSymbolicLink(),false);rmSync(dataDir,{recursive:true,force:true});});
  const goal=await app.chat('Offline Source preparation fence',{providerId:'codex',model:'gpt-6-luna',reasoningEffort:'medium',maxWorkers:1,conversationsPerWorker:2});
  await started;assert.equal(effects,1);
  await app.controlGoal(goal.id,'pause');
  await assert.rejects(prepared.commit(()=>{effects++;},actor),{code:'NATIVE_GOAL_SCOPE'});
  release();const result=await app.wait(goal.id);
  assert.equal(cleanupGoal,goal.id);
  assert.equal(result.status,cleanupFailure?'interrupted':'paused');
  if(cleanupFailure){
    assert.equal(result.recoveryHold,true);
    await assert.rejects(app.controlGoal(goal.id,'resume'),/reconciliation/);
  }
  await assert.rejects(Promise.resolve().then(()=>prepared.assertCurrent(actor)),{code:'NATIVE_GOAL_SCOPE'});
  assert.equal(effects,1);
  assert.ok(!readFileSync(path.join(dataDir,'state.json'),'utf8').includes('nativeScope'));
  assert.ok(!readFileSync(path.join(dataDir,'state.json'),'utf8').includes('PRIVATE_SOURCE_CLEANUP_DETAIL'));
});

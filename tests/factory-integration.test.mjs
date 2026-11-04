import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {FactoryControl} from 'flujo-factory';
import {createFactoryFleetRunner, installedFactory} from '../src/swarm/factory.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(),'seagulled-factory-public-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return {goal:{id:'goal-public',text:'Use the installed public SDK',budgetUsd:50,maxWorkers:2,
    conversationsPerWorker:2,providerId:'codex',model:'gpt-6-luna',reasoningEffort:'medium'},dataDir:path.join(root,'swarm')};
}

test('installed public FACTORY SDK owns dispatch, keeps its ledger and refuses replay',async t=>{
  const input=fixture(t);let calls=0;
  assert.equal((await installedFactory(input.dataDir)).FactoryControl,FactoryControl);
  const runner=createFactoryFleetRunner({fleetRunner:async()=>{calls++;return {available:true,text:'offline result'};}});
  assert.equal((await runner(input)).text,'offline result');
  const database=path.join(input.dataDir,'factory',input.goal.id,'control.sqlite');
  const control=new FactoryControl(database);
  try{assert.equal(control.effect('company-dispatch').state,'succeeded');assert.equal(control.status().control.status,'paused');}
  finally{control.close();}
  const original=readFileSync(database);
  await assert.rejects(runner(input),{code:'UNKNOWN'});
  assert.equal(calls,1);assert.deepEqual(readFileSync(database),original);
});

test('a readiness refusal keeps its own reason, and the goal can try again',async t=>{
  const input=fixture(t);let calls=0;
  const runner=createFactoryFleetRunner({fleetRunner:async()=>++calls===1
    ? {available:false,detail:'The selected provider model endpoint is unavailable (endpoint did not respond); local provider work remains available.'}
    : {available:true,text:'second attempt'}});
  await assert.rejects(runner(input),error=>error.code==='COMPANY_UNAVAILABLE'&&error.outcome==='not_applied'&&/endpoint did not respond/.test(error.message));
  assert.equal((await runner(input)).text,'second attempt');
  await assert.rejects(runner(input),{code:'UNKNOWN'},'a company that did start is still never replayed');
  assert.equal(calls,2);
});

test('cancellation pauses FACTORY authority while preserving the original fleet outcome',async t=>{
  const input=fixture(t),controller=new AbortController();
  input.signal=controller.signal;
  const runner=createFactoryFleetRunner({fleetRunner:async()=>{controller.abort();throw Object.assign(new Error('Cancelled'),{name:'AbortError'});}});
  await assert.rejects(runner(input),{name:'AbortError'});
  const control=new FactoryControl(path.join(input.dataDir,'factory',input.goal.id,'control.sqlite'));
  try{assert.equal(control.status().control.status,'paused');assert.equal(control.effect('company-dispatch').state,'unknown');}
  finally{control.close();}
  await assert.rejects(runner({...input,signal:undefined}),{code:'UNKNOWN'});
});

test('explicit unlimited intent reaches FACTORY without a hidden finite allowance',async t=>{
  const input=fixture(t);input.goal.budgetUsd=null;input.goal.unlimited=true;
  const runner=createFactoryFleetRunner({fleetRunner:async received=>{
    assert.equal(received.goal.budgetUsd,null);assert.equal(received.goal.unlimited,true);
    return {available:true,text:'offline unlimited admission'};
  }});
  assert.equal((await runner(input)).available,true);
});

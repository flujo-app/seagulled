import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {launchJourney} from './fixtures/journey-fixture.mjs';
import {ProviderManager} from '../src/providers/index.mjs';

test('UI saves and edits the exact model, effort and 25-by-2 goal intent',async t=>{
  const f=await launchJourney(t,{configured:true});
  await f.page.getByRole('button',{name:'New swarm'}).click();
  await f.page.getByLabel('Goal',{exact:true}).fill('close/implement/merge PRs in mario-andreschak/flujo');
  await f.page.getByLabel('Workers',{exact:true}).fill('25');
  await f.page.getByLabel('Agents per worker',{exact:true}).fill('2');
  await f.page.getByLabel('Model',{exact:true}).selectOption('gpt-6-luna');
  await f.page.getByLabel('Reasoning effort',{exact:true}).selectOption('medium');
  await f.page.getByRole('button',{name:'Save',exact:true}).click();
  await f.page.locator('#project-dialog').waitFor({state:'hidden'});
  await f.page.locator('.swarm-card').waitFor();
  const saved=JSON.parse(readFileSync(join(f.runtime.dataDir,'state.json'),'utf8')).goals[0];
  assert.equal(saved.maxWorkers,25);assert.equal(saved.conversationsPerWorker,2);
  assert.equal(saved.model,'gpt-6-luna');assert.equal(saved.reasoningEffort,'medium');
  assert.equal(saved.execution.verifiedWorkers,0); // This test is offline UI evidence.
  await f.page.getByRole('button',{name:'Swarm settings'}).click();
  assert.equal(await f.page.getByLabel('Model',{exact:true}).inputValue(),'gpt-6-luna');
  assert.equal(await f.page.getByLabel('Reasoning effort',{exact:true}).inputValue(),'medium');
  await f.page.getByLabel('Reasoning effort',{exact:true}).selectOption('high');
  await f.page.getByRole('button',{name:'Save',exact:true}).click();
  await f.page.locator('#project-dialog').waitFor({state:'hidden'});
  await f.page.locator('.swarm-card').waitFor();
  assert.equal(f.runtime.snapshot().goals[0].reasoningEffort,'high');
  assert.deepEqual(f.errors,[]);
});

test('explicit goal choices reach the native CLI without changing the saved connection',async()=>{
  const invocations=[];
  const commandRunner=async(_command,args)=>{
    if(args.includes('--version'))return {code:0,stdout:'version'};
    if(args.join(' ')==='login status')return {code:0,stdout:'Logged in using ChatGPT'};
    if(args.join(' ')==='auth status')return {code:1,stdout:''};
    if(args[0]==='exec'){
      invocations.push(args);
      return {code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Offline provider fixture'}})};
    }
    throw new Error('Unexpected command');
  };
  const manager=new ProviderManager({commandRunner,env:{}});
  await manager.connect({id:'codex',method:'subscription',model:'gpt-6-sol'});
  await manager.run({providerId:'codex',prompt:'Fixture',maxUsd:1,model:'gpt-6-luna',reasoningEffort:'medium'});
  assert.equal(invocations[0][invocations[0].indexOf('--model')+1],'gpt-6-luna');
  assert.ok(invocations[0].includes('model_reasoning_effort="medium"'));
  assert.deepEqual(manager.publicState().find(p=>p.id==='codex').models,['gpt-6-sol']);
  await assert.rejects(manager.run({providerId:'codex',prompt:'Fixture',maxUsd:1,model:'gpt-6-luna',reasoningEffort:'ultra'}),/does not support/);
  assert.equal(invocations.length,1);
});

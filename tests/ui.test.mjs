import test from 'node:test';
import assert from 'node:assert/strict';
import {launchJourney} from './fixtures/journey-fixture.mjs';
test('home keeps the continuous Todd loop and a plus; saving creates a truthful queued swarm card',async t=>{
  const f=await launchJourney(t,{configured:true}),{page}=f;
  await page.locator('#new-swarm').waitFor();
  await page.waitForFunction(()=>document.getElementById('movie').dataset.movieStatus==='playing');
  assert.equal(await page.locator('#movie button:visible').count(),2);
  const src=await page.locator('#movie-video').evaluate(v=>v.currentSrc);
  await page.getByRole('button',{name:'New swarm'}).click();
  await page.locator('#goal').fill('Build a useful example');
  await page.locator('#budget-slider').fill('4');
  await page.waitForFunction(()=>document.getElementById('workers').max==='100'&&!document.getElementById('project-save').disabled);
  await page.locator('#workers').fill('100');
  await page.locator('#agents').fill('10');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.locator('.swarm-card').waitFor();
  const goal=f.runtime.snapshot().goals[0];
  assert.equal(goal.maxWorkers,100);assert.equal(goal.conversationsPerWorker,10);assert.equal(goal.memoryMb,4096);
  assert.equal(goal.unlimited,true);assert.equal(goal.budgetUsd,null);
  assert.equal(goal.providerId,'codex');assert.equal(goal.execution.readiness,'blocked');
  assert.match(await page.locator('.status').innerText(),/Waiting/);
  assert.equal(await page.locator('.observatory circle.active').count(),0);
  assert.equal(await page.locator('#movie-video').evaluate(v=>v.currentSrc),src);
  await page.getByRole('button',{name:'Pause swarm'}).click();
  await page.waitForFunction(()=>document.querySelector('.swarm-card').dataset.status==='paused');
  assert.equal(f.runtime.snapshot().goals[0].status,'paused');
  await page.getByRole('button',{name:'Resume swarm'}).click();
  await page.waitForFunction(()=>document.querySelector('.swarm-card').dataset.status==='queued');
  assert.equal(f.runtime.snapshot().goals[0].execution.verifiedWorkers,0);
  await page.getByRole('button',{name:'Swarm settings'}).click();
  await page.locator('#budget-slider').fill('2');await page.locator('#agents').fill('2');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>!document.getElementById('project-dialog').open);
  assert.equal(f.runtime.snapshot().goals[0].memoryMb,1024);assert.equal(f.runtime.snapshot().goals[0].unlimited,false);
  await page.getByRole('button',{name:'Delete swarm'}).click();await page.waitForFunction(()=>!document.querySelector('.swarm-card'));
  assert.ok(f.runtime.snapshot().goals[0].deletedAt);assert.deepEqual(f.errors,[]);
});
test('cards paginate by three and never animate unverified worker capacity',async t=>{
  const f=await launchJourney(t,{configured:true});await f.page.locator('#new-swarm').waitFor();
  for(let i=0;i<4;i++)await f.runtime.chat(`Fixture goal ${i}`,{providerId:'codex',maxWorkers:10,conversationsPerWorker:10});
  await f.page.waitForFunction(()=>document.querySelectorAll('.swarm-card').length===3);
  assert.equal(await f.page.locator('.observatory circle.active').count(),0);
  await f.page.getByRole('button',{name:'Next swarms'}).click();assert.equal(await f.page.locator('.swarm-card').count(),1);
});

test('observatory draws the observed hierarchy and stops activity on retirement and completion',async t=>{
  let sink,release;const held=new Promise(resolve=>{release=resolve;});
  const swarm={setEventHandler:handler=>{sink=handler;},async prepareCompany(){return {};},async execute({goal,observationId,signal}){
    const send=worker=>sink({type:'worker',goalId:goal.id,observationId,worker});
    send({workerId:'w-observed-lead',parentId:null,depth:1,status:'ready'});
    send({workerId:'w-observed-child',parentId:'w-observed-lead',depth:2,status:'dispatching'});
    await Promise.race([held,new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))]);send({workerId:'w-observed-child',parentId:'w-observed-lead',depth:2,status:'retired'});
    return {text:'Offline observatory fixture.'};
  }};
  const f=await launchJourney(t,{configured:true,swarm}),{page}=f;t.after(release);
  const goal=await f.runtime.chat('Observe actual event wiring',{providerId:'codex'});
  await page.locator('[data-worker="w-observed-child"].active').waitFor();
  assert.equal(await page.locator('.worker-node').count(),2);assert.equal(await page.locator('.observatory line').count(),1);
  assert.match(await page.locator('.observatory').getAttribute('aria-label'),/1 worker requests in flight, 2 observed workers/);
  assert.equal(f.runtime.snapshot().goals[0].execution.verifiedWorkers,0);
  release();await f.runtime.wait(goal.id);await page.waitForFunction(()=>!document.querySelector('.observatory .active'));
  assert.equal(await page.locator('[data-worker="w-observed-child"]').getAttribute('data-status'),'retired');
  assert.match(await page.locator('.observatory').getAttribute('aria-label'),/historical activity/);assert.deepEqual(f.errors,[]);
});

test('late task metadata cannot animate a paused goal without worker observations',async t=>{
  let sink;const swarm={setEventHandler:handler=>{sink=handler;},async prepareCompany(){throw Object.assign(new Error('Offline source unavailable'),{code:'COMPANY_UNAVAILABLE',reasonCode:'source',outcome:'not_applied'});}};
  const f=await launchJourney(t,{configured:true,swarm});const goal=await f.runtime.chat('Historical task fixture',{providerId:'codex'});await f.runtime.wait(goal.id);await f.runtime.controlGoal(goal.id,'pause');
  sink({type:'task',goalId:goal.id,task:{id:'historical-task',role:'developer',status:'running'}});
  await f.page.waitForFunction(()=>document.querySelector('.observatory')?.getAttribute('aria-label')==='0 running tasks, 1 recorded tasks');
  assert.equal(await f.page.locator('.observatory .active').count(),0);assert.equal(f.runtime.snapshot().goals[0].status,'paused');assert.deepEqual(f.errors,[]);
});

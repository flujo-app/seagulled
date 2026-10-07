import test from 'node:test';
import assert from 'node:assert/strict';
import {launchJourney} from './fixtures/journey-fixture.mjs';
test('a held Save admits one goal while repeat submits remain fenced',async t=>{
 const f=await launchJourney(t,{configured:true});await f.page.locator('#new-swarm').waitFor();
 await f.page.getByRole('button',{name:'New swarm'}).click();await f.page.locator('#goal').fill('Exactly one goal');
 let release,requestSeen,posts=0;const received=new Promise(resolve=>{requestSeen=resolve;});await f.page.route('**/api/chat',async route=>{posts++;await new Promise(resolve=>{release=resolve;requestSeen();});await route.continue();});
 await f.page.getByRole('button',{name:'Save',exact:true}).click();
 await f.page.waitForFunction(()=>document.getElementById('project-save').disabled);
 await received;
 await f.page.locator('#project-form').evaluate(form=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
 assert.equal(posts,1);release();await f.page.locator('.swarm-card').waitFor();
 assert.equal(f.runtime.snapshot().goals.length,1);assert.deepEqual(f.errors,[]);
});
test('budget and agent changes bound manual workers before Save',async t=>{
 const f=await launchJourney(t,{configured:true}),{page}=f;await page.locator('#new-swarm').waitFor();
 await page.getByRole('button',{name:'New swarm'}).click();await page.locator('#goal').fill('Compute-bounded configuration');
 await page.locator('#budget-slider').fill('4');await page.waitForFunction(()=>document.getElementById('workers').max==='100');
 await page.locator('#workers').fill('100');await page.locator('#budget-slider').fill('0');
 await page.waitForFunction(()=>document.getElementById('workers').max==='30'&&!document.getElementById('project-save').disabled);
 assert.equal(await page.locator('#workers').inputValue(),'30');
 await page.locator('#agents').fill('1');await page.waitForFunction(()=>document.getElementById('workers').max==='100'&&!document.getElementById('project-save').disabled);
 assert.equal(await page.locator('#memory').inputValue(),'1024');
 await page.locator('#workers').fill('100');await page.locator('#agents').fill('10');
 await page.getByRole('button',{name:'Save',exact:true}).click();await page.locator('.swarm-card').waitFor();
 const goal=f.runtime.snapshot().goals[0];assert.equal(goal.budgetUsd,25);assert.equal(goal.maxWorkers,30);assert.equal(goal.memoryMb,4096);
 assert.equal(goal.execution.verifiedWorkers,0);assert.deepEqual(f.errors,[]);
});

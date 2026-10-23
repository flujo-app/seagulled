import test from 'node:test';
import assert from 'node:assert/strict';
import {launchJourney} from './fixtures/journey-fixture.mjs';

const idle=page=>page.waitForFunction(()=>document.getElementById('movie').dataset.loading==='false'&&document.getElementById('loading-video').paused&&getComputedStyle(document.getElementById('loading-video')).opacity==='0'&&getComputedStyle(document.getElementById('movie-video')).opacity==='1');
const loading=page=>page.waitForFunction(()=>document.getElementById('movie').dataset.loading==='true'&&getComputedStyle(document.getElementById('loading-video')).opacity==='1');

test('every dialog open and close crossfades the fullscreen loading screen without blocking controls',async t=>{
  const {page,errors,calls}=await launchJourney(t,{configured:true});await page.locator('#new-swarm').waitFor();await idle(page);
  const check=async()=>{await loading(page);assert.deepEqual(await page.locator('#loading-video').boundingBox(),{x:0,y:0,width:1280,height:850});assert.equal(await page.locator('#loading-video').evaluate(v=>v.muted&&!v.paused&&v.loop),true);assert.equal(await page.locator('#loading-video').evaluate(v=>getComputedStyle(v).transitionDuration),'0.18s');};
  await page.getByRole('button',{name:'New swarm'}).click();await check();await idle(page);
  await page.keyboard.press('Escape');await check();await idle(page);assert.equal(await page.locator('#project-dialog').isVisible(),false);
  await page.getByRole('button',{name:'New swarm'}).click();await check();await idle(page);
  await page.getByRole('button',{name:'Connect accounts'}).click();await check();await page.locator('#provider-step').waitFor();await idle(page);
  await page.getByRole('button',{name:'Close setup'}).click();await check();await idle(page);
  await page.getByRole('button',{name:'New swarm'}).click();await idle(page);
  await page.locator('#goal').fill('Offline transition test');await page.getByRole('button',{name:'Save',exact:true}).click();await check();await idle(page);
  assert.equal(await page.locator('#movie-video').evaluate(v=>getComputedStyle(v).opacity),'1');assert.deepEqual(errors,[]);assert.deepEqual(calls,[]);
});

test('closing and reopening a dialog cannot end the loading screen while account checks are pending',async t=>{
  const f=await launchJourney(t,{configured:true}),{page}=f;await page.locator('#new-swarm').waitFor();await idle(page);
  f.holdAccountChecks();await page.keyboard.press('Control+,');await loading(page);
  assert.equal(await page.locator('#provider-step').isVisible(),false);
  await page.getByRole('button',{name:'Close setup'}).click();await page.keyboard.press('Control+,');
  await page.waitForTimeout(1100);await loading(page);
  assert.equal(await page.locator('#provider-step').isVisible(),false);assert.equal(await page.locator('#movie-video').evaluate(v=>getComputedStyle(v).opacity),'0');
  const x=page.getByRole('button',{name:'Close app',exact:true});assert.equal(await x.evaluate(el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.x+24,r.y+24)===el;}),true);
  f.releaseChecks();await page.locator('#provider-step').waitFor();await idle(page);assert.deepEqual(f.calls,[]);assert.deepEqual(f.errors,[]);
});

test('native sign-in keeps loading past a dialog transition and cancellation restores Todd',async t=>{
  const f=await launchJourney(t,{holdLogin:true}),{page}=f;await page.locator('#provider-step').waitFor();await idle(page);
  await page.getByRole('button',{name:'Sign in Codex',exact:true}).click();await loading(page);await page.waitForTimeout(1000);
  assert.equal(await page.locator('#movie').getAttribute('data-loading'),'true');await page.getByRole('button',{name:'Close setup'}).click();f.releaseLogin();await idle(page);
  assert.equal(await page.locator('#setup-dialog').isVisible(),false);assert.equal(f.runtime.snapshot().setup,undefined);assert.deepEqual(f.errors,[]);
});

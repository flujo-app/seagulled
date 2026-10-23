import test from 'node:test';
import assert from 'node:assert/strict';
import {launchJourney} from './fixtures/journey-fixture.mjs';
test('first launch presents one two-step wizard and persists verified selected accounts',async t=>{
  const f=await launchJourney(t);const {page}=f;
  assert.equal(await page.locator('#new-swarm').isVisible(),false);
  await page.getByRole('dialog',{name:'Account setup'}).waitFor();
  assert.equal(await page.locator('#provider-step .logo').count(),3);
  assert.equal(await page.locator('#setup-confirm').isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'Codex',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Sign in Codex',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('[data-provider="codex"]').disabled);
  await page.getByRole('button',{name:'Codex',exact:true}).click();
  await page.waitForFunction(()=>!document.getElementById('setup-confirm').disabled);
  assert.deepEqual(f.calls,[{kind:'provider',id:'codex'}]);
  await page.getByRole('button',{name:'Confirm accounts'}).click();
  await page.waitForFunction(()=>document.getElementById('cue-video').currentSrc.endsWith('/confirmed.mp4'));
  assert.match(await page.locator('#cue-video').evaluate(video=>video.currentSrc),/\/confirmed\.mp4$/);
  await page.locator('#fly-step').waitFor();
  await page.getByRole('button',{name:'Connect Fly'}).click();
  await page.waitForFunction(()=>!document.getElementById('setup-dialog').open);
  assert.ok(f.runtime.snapshot().setup.completedAt);
  assert.deepEqual(f.runtime.snapshot().setup.providers,['codex']);
  assert.equal(await page.locator('#new-swarm').isVisible(),true);
  assert.equal(f.runtime.snapshot().goals.length,0);
  await page.reload();await page.locator('#new-swarm').waitFor();
  assert.equal(await page.locator('#setup-dialog').isVisible(),false);
  assert.deepEqual(f.errors,[]);
});

test('Modal sign-in is separate from activation and uses the second supplied confirmation clip',async t=>{
  const f=await launchJourney(t),{page}=f;await page.locator('#setup-dialog').waitFor();
  await page.getByRole('button',{name:'Sign in Modal',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[data-provider="modal"]').disabled);
  assert.equal(await page.getByRole('button',{name:'Modal',exact:true}).getAttribute('aria-pressed'),'false');
  await page.getByRole('button',{name:'Modal',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('setup-confirm').disabled);
  assert.deepEqual(f.calls,[{kind:'account',id:'modal'}]);await page.getByRole('button',{name:'Confirm accounts'}).click();
  await page.waitForFunction(()=>document.getElementById('cue-video').currentSrc.endsWith('/confirmed-alternate.mp4'));
  assert.match(await page.locator('#cue-video').evaluate(video=>video.currentSrc),/\/confirmed-alternate\.mp4$/);
  await page.locator('#fly-step').waitFor();await page.getByRole('button',{name:'Close setup'}).click();assert.deepEqual(f.errors,[]);
});
test('closing setup cancels native sign-in and fences its late completion',async t=>{
  const f=await launchJourney(t,{holdLogin:true});await f.page.locator('#setup-dialog').waitFor();
  await f.page.getByRole('button',{name:'Sign in Codex',exact:true}).click();
  await f.page.getByRole('button',{name:'Close setup'}).click();f.releaseLogin();
  await f.page.waitForFunction(()=>!document.getElementById('setup-dialog').open);
  assert.equal(f.runtime.snapshot().setup,undefined);assert.equal(f.runtime.snapshot().goals.length,0);
  assert.equal(await f.page.locator('#project-dialog').isVisible(),false);
});

test('all initial auth checks finish before activation buttons appear',async t=>{
  const f=await launchJourney(t,{accountReady:true,holdChecks:true}),{page}=f;
  await page.waitForFunction(()=>document.getElementById('movie-video').readyState>=2);
  assert.equal(await page.locator('#setup-dialog').isVisible(),false);
  await page.waitForFunction(()=>document.getElementById('loading-video').currentTime>.1);
  const loading=await page.evaluate(()=>({active:document.getElementById('movie').dataset.loading,opacity:getComputedStyle(document.getElementById('loading-video')).opacity,toddOpacity:getComputedStyle(document.getElementById('movie-video')).opacity,muted:document.getElementById('loading-video').muted,loop:document.getElementById('loading-video').loop}));
  assert.deepEqual(loading,{active:'true',opacity:'1',toddOpacity:'0',muted:true,loop:true});
  assert.deepEqual(f.checks.sort(),['accounts','providers']);assert.deepEqual(f.calls,[]);
  f.releaseChecks();await page.locator('#provider-step').waitFor();
  assert.equal(await page.getByRole('button',{name:'Modal',exact:true}).isEnabled(),true);
  assert.equal(await page.getByRole('button',{name:'Codex',exact:true}).isEnabled(),true);assert.deepEqual(f.calls,[]);
  await page.waitForFunction(()=>document.getElementById('movie').dataset.loading==='false'&&document.getElementById('loading-video').paused&&getComputedStyle(document.getElementById('movie-video')).opacity==='1');
  assert.equal(await page.locator('#movie-video').evaluate(v=>getComputedStyle(v).opacity),'1');
});

test('activation toggles are instant and Modal stays off through state updates and wizard completion',async t=>{
  const f=await launchJourney(t,{accountReady:true}),{page}=f;await page.locator('#provider-step').waitFor();
  const modal=page.getByRole('button',{name:'Modal',exact:true});assert.equal(await modal.getAttribute('aria-pressed'),'true');
  const checksBefore=f.checks.length;await modal.click();assert.equal(await modal.getAttribute('aria-pressed'),'false');assert.equal(await modal.isEnabled(),true);
  await f.runtime.discover();await page.waitForTimeout(100);assert.equal(await modal.getAttribute('aria-pressed'),'false');
  await modal.click();await modal.click();assert.equal(await modal.getAttribute('aria-pressed'),'false');assert.deepEqual(f.calls,[]);
  assert.equal(f.checks.length,checksBefore+1);
  const indicator=await modal.locator('i').evaluate(el=>getComputedStyle(el).backgroundColor);assert.equal(indicator,'rgb(137, 144, 150)');
  await page.getByRole('button',{name:'Confirm accounts'}).click();await page.locator('#fly-step').waitFor();await page.getByRole('button',{name:'Connect Fly'}).click();
  await page.waitForFunction(()=>!document.getElementById('setup-dialog').open);assert.deepEqual(f.runtime.snapshot().setup.providers,['codex']);
  await page.getByRole('button',{name:'New swarm'}).click();assert.equal(await page.locator('#goal-provider').inputValue(),'codex');
  assert.equal(await page.locator('#goal-provider option[value="modal"]').evaluate(el=>el.disabled),true);
  await page.getByRole('button',{name:'Connect accounts'}).click();await page.locator('#provider-step').waitFor();assert.equal(await modal.getAttribute('aria-pressed'),'false');assert.deepEqual(f.errors,[]);
});

test('dialogue video stays inside the modal and returns to the uninterrupted background loop',async t=>{
  const f=await launchJourney(t,{accountReady:true}),{page}=f;await page.locator('#provider-step').waitFor();
  await page.getByRole('button',{name:'Modal',exact:true}).click();
  assert.equal(await page.locator('#setup-dialog video').count(),1);
  assert.equal(await page.locator('#frame > #cue-video').count(),0);
  const bounds=await page.locator('#cue-video').boundingBox(),dialogBounds=await page.locator('#setup-dialog').boundingBox();assert.ok(bounds.x>dialogBounds.x&&bounds.y>dialogBounds.y&&bounds.width<dialogBounds.width);assert.ok(bounds.height<=240);
  await page.locator('#cue-video').evaluate(video=>video.dispatchEvent(new Event('ended')));
  assert.equal(await page.locator('#cue-video').isVisible(),true);
  assert.equal(await page.locator('#movie-video').evaluate(video=>video.paused),false);assert.deepEqual(f.errors,[]);
});

test('the app close X stays at the window corner and is clickable on home and above either dialog',async t=>{
  const f=await launchJourney(t,{configured:true}),{page}=f;await page.locator('#new-swarm').waitFor();
  const check=async()=>{assert.deepEqual(await page.locator('#app-close').boundingBox(),{x:1216,y:16,width:48,height:48});assert.equal(await page.locator('#app-close').evaluate(button=>{const r=button.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===button;}),true);};
  await check();await page.getByRole('button',{name:'New swarm'}).click();await page.locator('#project-dialog').waitFor();await check();
  await page.getByRole('button',{name:'Close swarm settings'}).click();await page.getByRole('button',{name:'New swarm'}).click();await page.getByRole('button',{name:'Connect accounts'}).click();await page.locator('#provider-step').waitFor();await check();assert.deepEqual(f.errors,[]);
});

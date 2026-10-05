import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {validateMovieManifest,MoviePlayer} from '../ui/movie-player.mjs';
import {createServer} from '../src/server.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const fixture={version:1,loops:Object.fromEntries(['idle','listening','work','headphones'].map(scene=>[scene,{src:'clips/frames.mp4',frames:8,fps:8}])),
  transitions:[{id:'headphones-on',from:'idle',to:'headphones',src:'clips/frames.mp4',frames:8,fps:8,reversible:true}]};

test('movie manifest accepts only local, bounded clips and leaves unapproved product empty',()=>{
  assert.deepEqual(validateMovieManifest({version:1,loops:{},transitions:[]}).loops,{});
  assert.equal(validateMovieManifest(fixture).transitions[0].reversible,true);
  assert.throws(()=>validateMovieManifest({...fixture,loops:{idle:{src:'https://example.com/a.webm',frames:8,fps:8}}}),/local video/);
  assert.throws(()=>validateMovieManifest({...fixture,loops:{idle:{src:'clips/../a.webm',frames:8,fps:8}}}),/local video/);
  assert.throws(()=>validateMovieManifest({...fixture,transitions:[{...fixture.transitions[0],frames:0}]}),/frame count/);
});

test('metadata stalls are bounded and do not announce playback',async()=>{
  const oldLocation=Object.getOwnPropertyDescriptor(globalThis,'location');
  Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'http://localhost/'}});
  try{
    const video=new EventTarget();Object.assign(video,{readyState:0,duration:NaN,muted:false,playsInline:false,preload:'',dataset:{},load(){},pause(){},removeAttribute(){}});
    const stage={dataset:{}};
    const player=new MoviePlayer({video,stage,manifestUrl:'/movie-manifest.json',fetchImpl:async()=>({ok:true,json:async()=>fixture}),metadataTimeoutMs:40});
    assert.equal(await player.load(),false);
    assert.equal(stage.dataset.movieStatus,'failed');
    assert.equal(video.dataset.ready,'false');
    player.destroy();
  }finally{if(oldLocation)Object.defineProperty(globalThis,'location',oldLocation);else delete globalThis.location;}
});

test('metadata readiness survives an event before the wait, a later readiness event, and the deadline boundary',async()=>{
  const oldLocation=Object.getOwnPropertyDescriptor(globalThis,'location');
  Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'http://localhost/'}});
  const short={version:1,loops:Object.fromEntries(['idle','listening','work'].map(scene=>[scene,{src:'clips/frames.mp4',frames:2,fps:30}])),transitions:[]};
  try{
    for(const order of ['before-wait','later-canplay','ready-before-deadline']){
      const video=new EventTarget();Object.assign(video,{readyState:0,duration:NaN,error:null,seeking:false,dataset:{},muted:false,playsInline:false,preload:'',pause(){},removeAttribute(){}});
      let mediaTime=0;Object.defineProperty(video,'currentTime',{get:()=>mediaTime,set(value){mediaTime=value;video.dispatchEvent(new Event('seeked'));}});
      video.load=()=>{const ready=()=>{video.readyState=4;video.duration=2/30;if(order!=='ready-before-deadline')video.dispatchEvent(new Event(order==='before-wait'?'loadedmetadata':'canplay'));};
        if(order==='before-wait')ready();else setTimeout(ready,10);};
      const stage={dataset:{}};
      const player=new MoviePlayer({video,stage,manifestUrl:'/movie-manifest.json',fetchImpl:async()=>({ok:true,json:async()=>short}),metadataTimeoutMs:40});
      assert.equal(await player.load(),true,`${order}: ${stage.dataset.movieStatus}`);
      assert.equal(stage.dataset.movieStatus,'playing');
      player.destroy();
    }
  }finally{if(oldLocation)Object.defineProperty(globalThis,'location',oldLocation);else delete globalThis.location;}
});

test('real local video seeks through transition frames forward and backward and cancels on interruption',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'seagulled-movie-'));
  await mkdir(join(dir,'clips'));
  await Promise.all([
    copyFile(join(root,'ui/movie-player.mjs'),join(dir,'movie-player.mjs')),
    copyFile(join(root,'ui/stage.mjs'),join(dir,'stage.mjs')),
    copyFile(join(root,'tests/fixtures/movie/frames.mp4'),join(dir,'clips/frames.mp4')),
    writeFile(join(dir,'movie-manifest.json'),JSON.stringify(fixture)),
    writeFile(join(dir,'index.html'),'<div id="stage"><video id="video" muted playsinline></video></div>'),
  ]);
  const server=await createServer({runtime:{snapshot:()=>({}),subscribe:()=>()=>{}},uiDir:dir});
  t.after(async()=>{await server.close();if(!dir.startsWith(join(tmpdir(),'seagulled-movie-')))throw new Error('Movie fixture directory escaped its temporary root.');await rm(dir,{recursive:true,force:true});});
  const ranged=await fetch(`${server.url}/clips/frames.mp4`,{headers:{Range:'bytes=0-3'}});
  assert.equal(ranged.status,206);assert.equal(ranged.headers.get('content-range')?.startsWith('bytes 0-3/'),true);
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();await page.goto(server.url);
  const loaded=await page.evaluate(async()=>{
    const {MoviePlayer}=await import('/movie-player.mjs');
    const video=document.getElementById('video'),stage=document.getElementById('stage');
    const frames=[];const player=new MoviePlayer({video,stage,manifestUrl:'/movie-manifest.json',onFrame:event=>frames.push(event),onStatus:({detail})=>{stage.dataset.detail=detail;}});
    window.testMovie={player,frames};return player.load();
  });
  assert.equal(loaded,true,await page.locator('#stage').evaluate(element=>JSON.stringify({status:element.dataset.movieStatus,detail:element.dataset.detail,video:document.getElementById('video').error?.message,time:document.getElementById('video').currentTime,duration:document.getElementById('video').duration,ready:document.getElementById('video').readyState})));
  assert.equal(await page.locator('#stage').getAttribute('data-movie-status'),'playing');
  assert.equal(await page.locator('#video').getAttribute('data-ready'),'true');
  await page.waitForFunction(()=>window.testMovie.frames.filter(frame=>frame.clipId==='idle').length>=9);
  assert.deepEqual((await page.evaluate(()=>window.testMovie.frames)).filter(frame=>frame.clipId==='idle').slice(0,9).map(frame=>frame.frame),[0,1,2,3,4,5,6,7,0]);
  const forward=await page.evaluate(()=>window.testMovie.player.setScene('headphones'));
  assert.equal(forward,true,await page.locator('#stage').evaluate(element=>JSON.stringify({status:element.dataset.movieStatus,detail:element.dataset.detail,time:document.getElementById('video').currentTime,ready:document.getElementById('video').readyState})));
  const backward=await page.evaluate(()=>window.testMovie.player.setScene('idle'));
  assert.equal(backward,true,await page.locator('#stage').evaluate(element=>JSON.stringify({status:element.dataset.movieStatus,detail:element.dataset.detail,time:document.getElementById('video').currentTime,ready:document.getElementById('video').readyState})));
  const frames=await page.evaluate(()=>window.testMovie.frames);
  assert.deepEqual(frames.filter(frame=>frame.clipId==='headphones-on'&&frame.direction==='forward').map(frame=>frame.frame),[0,1,2,3,4,5,6,7]);
  assert.deepEqual(frames.filter(frame=>frame.clipId==='headphones-on'&&frame.direction==='reverse').map(frame=>frame.frame),[7,6,5,4,3,2,1,0]);
  const forwardTimes=frames.filter(frame=>frame.clipId==='headphones-on'&&frame.direction==='forward').map(frame=>frame.mediaTime);
  const reverseTimes=frames.filter(frame=>frame.clipId==='headphones-on'&&frame.direction==='reverse').map(frame=>frame.mediaTime);
  assert.equal(forwardTimes.every((time,index)=>index===0||time>forwardTimes[index-1]),true);
  assert.equal(reverseTimes.every((time,index)=>index===0||time<reverseTimes[index-1]),true);
  assert.equal(frames.some(frame=>frame.via==='presented'),true);
  const cancel=await page.evaluate(async()=>{
    const {player,frames}=window.testMovie;
    const pending=player.setScene('headphones');
    while(frames.filter(frame=>frame.clipId==='headphones-on'&&frame.epoch===player.epoch).length<2)await new Promise(resolve=>setTimeout(resolve,10));
    const oldEpoch=player.epoch;player.interrupt();const count=frames.filter(frame=>frame.epoch===oldEpoch).length;
    await pending;await player.setScene('listening');
    return {count,after:frames.filter(frame=>frame.epoch===oldEpoch).length,status:document.getElementById('stage').dataset.movieStatus};
  });
  assert.equal(cancel.after,cancel.count);
  assert.equal(cancel.status,'playing');
  await page.waitForFunction(()=>window.testMovie.frames.filter(frame=>frame.clipId==='listening').length>=9);
  assert.deepEqual((await page.evaluate(()=>window.testMovie.frames)).filter(frame=>frame.clipId==='listening').slice(0,9).map(frame=>frame.frame),[0,1,2,3,4,5,6,7,0]);
  await page.evaluate(()=>window.testMovie.player.setScene('work'));
  await page.waitForFunction(()=>window.testMovie.frames.filter(frame=>frame.clipId==='work').length>=9);
  assert.deepEqual((await page.evaluate(()=>window.testMovie.frames)).filter(frame=>frame.clipId==='work').slice(0,9).map(frame=>frame.frame),[0,1,2,3,4,5,6,7,0]);
  const reverseCancel=await page.evaluate(async()=>{
    const {player,frames}=window.testMovie;
    await player.setScene('idle');await player.setScene('headphones');
    const pending=player.setScene('idle');
    while(frames.filter(frame=>frame.clipId==='headphones-on'&&frame.direction==='reverse'&&frame.epoch===player.epoch).length<2)await new Promise(resolve=>setTimeout(resolve,10));
    const oldEpoch=player.epoch;player.interrupt();const count=frames.filter(frame=>frame.epoch===oldEpoch).length;
    await pending;await player.setScene('work');
    return {count,after:frames.filter(frame=>frame.epoch===oldEpoch).length,scene:player.settledScene};
  });
  assert.equal(reverseCancel.after,reverseCancel.count);
  assert.equal(reverseCancel.scene,'work');
  await page.evaluate(()=>window.testMovie.player.destroy());
});

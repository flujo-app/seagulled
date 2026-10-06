import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
import {validateMovieManifest,MoviePlayer} from '../ui/movie-player.mjs';
import {createServer} from '../src/server.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const asset=join(root,'ui','clips','todd-loop.mp4');
const approvedHash='db6e387edc51c82d5e9a462b8ee0963800fc48bbfa6ae7a9fdc8af4a9d556419';
const background={version:1,background:{src:'clips/todd-loop.mp4'},loops:{},transitions:[]};

test('approved background manifest accepts one bundled local video and exact media bytes',async()=>{
  assert.equal(validateMovieManifest(background).background.src,'clips/todd-loop.mp4');
  assert.throws(()=>validateMovieManifest({...background,background:{src:'https://example.com/movie.mp4'}}),/bundled local video/);
  assert.throws(()=>validateMovieManifest({...background,background:{src:'clips/../private.mp4'}}),/bundled local video/);
  assert.throws(()=>validateMovieManifest({...background,loops:{idle:{src:'clips/todd-loop.mp4',frames:96,fps:8}}}),/cannot include scene clips/);
  const installed=JSON.parse(await readFile(join(root,'ui','movie-manifest.json'),'utf8'));
  assert.equal(installed.background.src,background.background.src);
  assert.equal(createHash('sha256').update(await readFile(asset)).digest('hex'),approvedHash);
});

test('continuous background ignores scene changes and interruption but reports a media error',async()=>{
  const oldLocation=Object.getOwnPropertyDescriptor(globalThis,'location');
  Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'http://localhost/'}});
  try{
    const video=new EventTarget();const stage={dataset:{}};const status=[];
    let loads=0,plays=0,pauses=0,seeks=0,position=2;
    Object.assign(video,{readyState:0,duration:NaN,error:null,dataset:{},muted:false,playsInline:false,autoplay:false,loop:false,preload:'',paused:true,
      load(){loads++;this.readyState=4;this.duration=12;this.dispatchEvent(new Event('loadedmetadata'));},
      async play(){plays++;this.paused=false;},pause(){pauses++;this.paused=true;},removeAttribute(){}});
    Object.defineProperty(video,'currentTime',{get(){return position;},set(value){seeks++;position=value;}});
    const player=new MoviePlayer({video,stage,manifest:background,manifestUrl:'/movie-manifest.json',onStatus:event=>status.push(event)});
    assert.equal(await player.load(),true);
    assert.equal(stage.dataset.movieStatus,'playing');
    for(const scene of ['idle','listening','speaking','headphones','work','critique','golf','away']){
      assert.equal(await player.setScene(scene),true);
      player.interrupt();
    }
    assert.deepEqual({loads,plays,pauses,seeks,loop:video.loop,autoplay:video.autoplay,muted:video.muted,ready:video.dataset.ready},
      {loads:1,plays:1,pauses:0,seeks:0,loop:true,autoplay:true,muted:true,ready:'true'});
    video.error=new Error('decode');video.dispatchEvent(new Event('error'));
    assert.equal(stage.dataset.movieStatus,'failed');
    assert.match(status.at(-1).detail,/could not be decoded/);
    player.destroy();
    assert.equal(pauses,1);
  }finally{if(oldLocation)Object.defineProperty(globalThis,'location',oldLocation);else delete globalThis.location;}
});

test('approved video plays continuously, survives state changes, loops, and exposes real media failure',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'seagulled-background-'));
  await mkdir(join(dir,'clips'));
  await Promise.all([
    copyFile(join(root,'ui','movie-player.mjs'),join(dir,'movie-player.mjs')),
    copyFile(join(root,'ui','stage.mjs'),join(dir,'stage.mjs')),
    copyFile(asset,join(dir,'clips','todd-loop.mp4')),
    writeFile(join(dir,'movie-manifest.json'),JSON.stringify(background)),
    writeFile(join(dir,'index.html'),'<main id="stage"><video id="video" muted playsinline></video><section id="advanced"><p id="movie-status"></p></section></main>'),
  ]);
  const server=await createServer({runtime:{snapshot:()=>({}),subscribe:()=>()=>{}},uiDir:dir});
  t.after(async()=>{await server.close();if(!dir.startsWith(join(tmpdir(),'seagulled-background-')))throw new Error('Movie fixture directory escaped its temporary root.');await rm(dir,{recursive:true,force:true});});
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();await page.goto(server.url);
  const loaded=await page.evaluate(async()=>{
    const {MoviePlayer}=await import('/movie-player.mjs');
    const video=document.getElementById('video'),stage=document.getElementById('stage'),advanced=document.getElementById('movie-status');
    window.backgroundTrace={loadStarts:0,seeks:0,pauses:0};
    video.addEventListener('loadstart',()=>window.backgroundTrace.loadStarts++);
    video.addEventListener('seeking',()=>window.backgroundTrace.seeks++);
    video.addEventListener('pause',()=>window.backgroundTrace.pauses++);
    const player=new MoviePlayer({video,stage,manifestUrl:'/movie-manifest.json',metadataTimeoutMs:12000,
      onStatus:({status,detail})=>{advanced.textContent=status==='failed'?detail:status;}});
    window.backgroundPlayer=player;
    return player.load();
  });
  assert.equal(loaded,true,await page.locator('#advanced').innerText());
  const before=await page.evaluate(()=>({src:document.getElementById('video').currentSrc,time:document.getElementById('video').currentTime,
    trace:{...window.backgroundTrace}}));
  await page.evaluate(async()=>{
    const player=window.backgroundPlayer;
    for(const scene of ['listening','speaking','headphones','work','critique','golf','away','idle']){
      await player.setScene(scene);player.interrupt();
    }
  });
  await page.waitForTimeout(350);
  const after=await page.evaluate(()=>{const video=document.getElementById('video');return {
    src:video.currentSrc,time:video.currentTime,paused:video.paused,muted:video.muted,loop:video.loop,autoplay:video.autoplay,
    status:document.getElementById('stage').dataset.movieStatus,trace:{...window.backgroundTrace}};});
  assert.equal(after.src,before.src);
  assert.equal(after.time>before.time,true,JSON.stringify({before,after}));
  assert.deepEqual(after.trace,before.trace);
  assert.deepEqual([after.paused,after.muted,after.loop,after.autoplay,after.status],[false,true,true,true,'playing']);
  await page.evaluate(()=>{const video=document.getElementById('video');video.currentTime=video.duration-0.3;});
  await page.waitForFunction(()=>{const video=document.getElementById('video');return video.currentTime<0.5&&video.currentTime>=0&&!video.paused;},null,{timeout:5000});
  assert.equal(await page.locator('#video').evaluate(video=>video.loop&&video.currentSrc.endsWith('/clips/todd-loop.mp4')),true);
  await page.evaluate(()=>{const video=document.getElementById('video');video.src='/clips/missing.mp4';video.load();});
  await page.waitForFunction(()=>document.getElementById('stage').dataset.movieStatus==='failed',null,{timeout:5000});
  assert.match(await page.locator('#movie-status').innerText(),/could not be decoded/);
  await page.evaluate(()=>window.backgroundPlayer.destroy());
});

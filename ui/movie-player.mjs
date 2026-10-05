import {SCENES} from './stage.mjs';

const scenes=new Set(SCENES);
const localClip=/^clips\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9._-]+\.(?:webm|mp4)$/;
const aborted=()=>new DOMException('Movie request changed.','AbortError');

function clip(value,label){
  if(!value||typeof value!=='object'||Array.isArray(value)||!localClip.test(value.src)||value.src.split('/').includes('..')||
    !Number.isInteger(value.frames)||value.frames<2||value.frames>600||!Number.isInteger(value.fps)||value.fps<1||value.fps>30)
    throw new Error(`${label} needs a local video, frame count and frame rate.`);
  return Object.freeze({src:value.src,frames:value.frames,fps:value.fps});
}

/** Manifest paths are limited to bundled, local clips. No URL or foreign footage is accepted. */
export function validateMovieManifest(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.version!==1||!raw.loops||typeof raw.loops!=='object'||Array.isArray(raw.loops)||!Array.isArray(raw.transitions))
    throw new Error('Movie manifest version 1 is required.');
  const loops={};
  for(const [scene,value] of Object.entries(raw.loops)){
    if(!scenes.has(scene))throw new Error(`Unknown movie scene: ${scene}.`);
    loops[scene]=clip(value,scene);
  }
  if(Object.keys(loops).length&&['idle','listening','work'].some(scene=>!loops[scene]))
    throw new Error('Approved movie clips need idle, listening and work loops.');
  const transitions=raw.transitions.map((value,index)=>{
    if(!value||typeof value!=='object'||Array.isArray(value)||!name(value.id)||!scenes.has(value.from)||!scenes.has(value.to)||value.from===value.to||typeof value.reversible!=='boolean')
      throw new Error(`Movie transition ${index} is invalid.`);
    return Object.freeze({id:value.id,from:value.from,to:value.to,reversible:value.reversible,...clip(value,`Transition ${value.id}`)});
  });
  if(new Set(transitions.map(value=>value.id)).size!==transitions.length)throw new Error('Movie transition IDs must be unique.');
  return Object.freeze({version:1,loops:Object.freeze(loops),transitions:Object.freeze(transitions)});
}
function name(value){return typeof value==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(value);}

function waitForMedia(video,{event,predicate,signal,timeoutMs}){
  if(signal.aborted)return Promise.reject(aborted());
  if(video.error)return Promise.reject(new Error('Movie video could not be decoded.'));
  if(predicate())return Promise.resolve();
  return new Promise((resolve,reject)=>{
    let timer;
    const cleanup=()=>{clearTimeout(timer);video.removeEventListener(event,check);video.removeEventListener('error',fail);signal.removeEventListener('abort',cancel);};
    const done=()=>{cleanup();resolve();};
    const fail=()=>{cleanup();reject(new Error('Movie video could not be decoded.'));};
    const cancel=()=>{cleanup();reject(aborted());};
    const check=()=>{if(predicate())done();};
    video.addEventListener(event,check);video.addEventListener('error',fail);signal.addEventListener('abort',cancel,{once:true});
    timer=setTimeout(()=>{cleanup();reject(new Error(`Movie ${event} stalled.`));},timeoutMs);
    check();
  });
}
function delay(ms,signal){
  if(signal.aborted)return Promise.reject(aborted());
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},ms);
    const cancel=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);reject(aborted());};
    signal.addEventListener('abort',cancel,{once:true});
  });
}

/** Silent pre-rendered film. Speech audio is independent and is never called lip-sync. */
export class MoviePlayer {
  constructor({video,stage,manifest=null,manifestUrl='./movie-manifest.json',fetchImpl=fetch,onStatus=()=>{},onFrame=()=>{},metadataTimeoutMs=4000,seekTimeoutMs=1500}={}){
    if(!video||!stage)throw new Error('Movie stage and video are required.');
    this.video=video;this.stage=stage;this.manifestInput=manifest;this.manifestUrl=manifestUrl;this.fetchImpl=fetchImpl;this.onStatus=onStatus;this.onFrame=onFrame;
    this.metadataTimeoutMs=metadataTimeoutMs;this.seekTimeoutMs=seekTimeoutMs;
    this.manifest=null;this.requestedScene='idle';this.settledScene=null;this.loadedSrc=null;this.active=null;this.epoch=0;this.destroyed=false;this.lastStatus=null;
    video.muted=true;video.playsInline=true;video.preload='auto';this.#status('loading');
  }
  #status(value,detail=''){
    this.stage.dataset.movieStatus=value;
    if(this.lastStatus===value&&this.lastDetail===detail)return;
    this.lastStatus=value;this.lastDetail=detail;this.onStatus({status:value,detail});
  }
  async load(){
    try{
      let raw=this.manifestInput;
      if(!raw){const response=await this.fetchImpl.call(globalThis,this.manifestUrl,{cache:'no-store'});
        if(!response.ok)throw new Error('Movie manifest could not be loaded.');raw=await response.json();}
      this.manifest=validateMovieManifest(raw);
      if(this.destroyed)return false;
      if(!Object.keys(this.manifest.loops).length){this.#status('missing','No approved Todd movie clips are installed.');return false;}
      this.#status('ready');
      return this.setScene(this.requestedScene,{interrupt:true});
    }catch(error){if(!this.destroyed)this.#status('missing',error.message||'Movie clips are unavailable.');return false;}
  }
  setScene(scene,{interrupt=false}={}){
    if(!scenes.has(scene))throw new Error(`Unknown movie scene: ${scene}.`);
    this.requestedScene=scene;
    if(this.destroyed||!this.manifest||!Object.keys(this.manifest.loops).length)return Promise.resolve(false);
    if(!interrupt&&this.active?.scene===scene)return this.active.ready;
    this.#cancelActive();
    const controller=new AbortController(),epoch=++this.epoch;
    let resolveReady;const ready=new Promise(resolve=>{resolveReady=resolve;});
    this.active={scene,controller,ready,resolveReady};
    void this.#run(scene,epoch,controller.signal,resolveReady);
    return ready;
  }
  interrupt(){this.#cancelActive();this.epoch++;if(this.manifest&&Object.keys(this.manifest.loops).length)this.#status('interrupted');}
  destroy(){this.destroyed=true;this.interrupt();this.video.removeAttribute('src');this.video.load();this.video.dataset.ready='false';}
  #cancelActive(){
    const active=this.active;if(!active)return;
    active.controller.abort();active.resolveReady(false);this.video.pause();this.active=null;
  }
  #transition(from,to){
    if(!from)return null;
    for(const edge of this.manifest.transitions){
      if(edge.from===from&&edge.to===to)return {clip:edge,direction:'forward'};
      if(edge.reversible&&edge.to===from&&edge.from===to)return {clip:edge,direction:'reverse'};
    }
    return null;
  }
  async #run(scene,epoch,signal,resolveReady){
    let resolved=false;const ready=value=>{if(!resolved){resolved=true;resolveReady(value);}};
    try{
      const transition=this.#transition(this.settledScene,scene);
      if(transition)await this.#sequence(transition.clip,transition.direction,epoch,signal);
      if(signal.aborted)throw aborted();
      const loop=this.manifest.loops[scene];
      if(!loop){this.#status('missing-scene',`No approved ${scene} clip is installed.`);ready(false);return;}
      while(!signal.aborted){await this.#sequence({...loop,id:scene},'loop',epoch,signal,()=>{this.settledScene=scene;ready(true);});}
    }catch(error){
      if(error?.name!=='AbortError'&&epoch===this.epoch){this.video.dataset.ready='false';this.#status('failed',error?.message||'Movie playback failed.');}
      ready(false);
    }
  }
  async #sequence(clip,direction,epoch,signal,onFirstFrame){
    await this.#ensureClip(clip,signal);
    const indices=Array.from({length:clip.frames},(_,index)=>direction==='reverse'?clip.frames-1-index:index);
    for(const frame of indices){
      if(signal.aborted||epoch!==this.epoch)throw aborted();
      const via=await this.#presentFrame(clip,frame,signal);
      if(signal.aborted||epoch!==this.epoch)throw aborted();
      this.video.dataset.ready='true';this.video.dataset.clip=clip.id||clip.src;this.video.dataset.frame=String(frame);
      this.video.dataset.direction=direction;this.#status('playing');
      this.onFrame({clipId:clip.id||clip.src,frame,direction,via,mediaTime:this.video.currentTime,epoch});
      onFirstFrame?.();onFirstFrame=null;
      await delay(1000/clip.fps,signal);
    }
  }
  async #ensureClip(clip,signal){
    if(this.loadedSrc!==clip.src){
      this.loadedSrc=clip.src;this.video.dataset.ready='false';
      this.video.src=new URL(clip.src,new URL(this.manifestUrl,location.href)).href;
      this.video.load();
    }
    await waitForMedia(this.video,{event:'loadedmetadata',predicate:()=>this.video.readyState>=1&&Number.isFinite(this.video.duration)&&this.video.duration>0,signal,timeoutMs:this.metadataTimeoutMs});
    const end=(clip.frames-1)/clip.fps;
    if(this.video.duration+0.04<end||this.video.duration>clip.frames/clip.fps+0.5)
      throw new Error('Movie clip duration does not match its frame manifest.');
  }
  async #presentFrame(clip,frame,signal){
    const target=Math.min(this.video.duration-0.005,frame/clip.fps+0.001);
    const same=this.video.readyState>=2&&!this.video.seeking&&Math.abs(this.video.currentTime-target)<0.003;
    let presented=false,callbackId=null,confirmationTimer=null,resolveConfirmation;
    const confirmation=typeof this.video.requestVideoFrameCallback==='function'&&!same?new Promise(resolve=>{
      resolveConfirmation=resolve;
      callbackId=this.video.requestVideoFrameCallback((_time,metadata)=>{if(Math.abs(metadata.mediaTime-target)<=1/clip.fps)presented=true;resolve();});
      confirmationTimer=setTimeout(resolve,Math.min(250,this.seekTimeoutMs));
    }):Promise.resolve();
    try{
      if(!same){
        this.video.currentTime=target;
        await waitForMedia(this.video,{event:'seeked',predicate:()=>!this.video.seeking&&this.video.readyState>=2&&Math.abs(this.video.currentTime-target)<0.04,signal,timeoutMs:this.seekTimeoutMs});
      }
      await confirmation;
      if(signal.aborted)throw aborted();
      if(this.video.readyState<2)throw new Error('Movie frame is not decoded.');
      return presented?'presented':'seeked';
    }finally{
      clearTimeout(confirmationTimer);resolveConfirmation?.();
      if(callbackId!==null&&typeof this.video.cancelVideoFrameCallback==='function')this.video.cancelVideoFrameCallback(callbackId);
    }
  }
}

import {mkdtempSync,cpSync,mkdirSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {createRuntime} from '../../src/runtime.mjs';
import {createServer} from '../../src/server.mjs';

export async function launchJourney(t,{configured=false,holdLogin=false,accountReady=false,holdChecks=false,swarm:customSwarm}={}){
  const root=mkdtempSync(join(tmpdir(),'seagulled-journey-ui-'));
  const uiDir=join(root,'ui');cpSync(fileURLToPath(new URL('../../ui/',import.meta.url)),uiDir,{recursive:true});
  mkdirSync(join(uiDir,'journey-media'),{recursive:true});
  for(const id of ['intro','selected','removed','confirmed','fly-complete','confirmed-alternate','starfield-loading'])copyFileSync(fileURLToPath(new URL('./movie/frames.mp4',import.meta.url)),join(uiDir,'journey-media',`${id}.mp4`));
  const auth={fly:{id:'fly',connected:configured,available:true},modal:{id:'modal',connected:accountReady,available:true}};
  const calls=[],errors=[],checks=[];let connected=configured||accountReady,releaseLogin,releaseChecks,checkGate;const holdAccountChecks=()=>{checkGate=new Promise(resolve=>{releaseChecks=resolve;});};holdAccountChecks();if(!holdChecks)releaseChecks();
  const providers={
    publicState:()=>[{id:'codex',name:'Codex',connected,available:connected,methods:['subscription']},{id:'claude',name:'Claude',connected:false,available:false}],
    async discover(){checks.push('providers');await checkGate;return this.publicState();},async authState(){checks.push('accounts');await checkGate;return structuredClone(auth);},
    async authConnect({id,signal}){calls.push({kind:'account',id});if(signal?.aborted)throw Object.assign(new Error('Cancelled'),{name:'AbortError'});auth[id].connected=true;return auth[id];},
    async connect({id,signal}){calls.push({kind:'provider',id});if(holdLogin)await new Promise((resolve,reject)=>{releaseLogin=resolve;signal.addEventListener('abort',()=>reject(Object.assign(new Error('Cancelled'),{name:'AbortError'})),{once:true});});if(signal?.aborted)throw Object.assign(new Error('Cancelled'),{name:'AbortError'});connected=true;},
    async disconnect(id){calls.push({kind:'disconnect',id});connected=false;}
  };
  const swarm=customSwarm||{async prepareCompany(){throw Object.assign(new Error('Offline fixture source unavailable'),{code:'COMPANY_UNAVAILABLE',reasonCode:'source',outcome:'not_applied'});}};
  const runtime=createRuntime({dataDir:join(root,'data'),providers,swarm,voice:{async close(){}}});
  if(configured)await runtime.completeSetup({providers:['codex']});
  const service=await createServer({runtime,uiDir});
  const browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage({viewport:{width:1280,height:850}});page.on('pageerror',error=>errors.push(error.message));
  t.after(async()=>{await browser.close();await service.close();await runtime.close();rmSync(root,{recursive:true,force:true});});
  const url=`${service.url}/#token=${service.token}`;await page.goto(url);
  return {page,runtime,calls,checks,auth,errors,browser,url,releaseLogin:()=>releaseLogin?.(),releaseChecks:()=>releaseChecks(),holdAccountChecks};
}

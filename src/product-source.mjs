import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdirSync, openSync, closeSync, statSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {productOperatorSecret} from './product-secret.mjs';
import {createNativeSourceAdmissionClient} from './native-source-client.mjs';
import {installedProductRuntime, productNodeBinary} from './product-runtime.mjs';

const refused = () => Object.assign(new Error('The private product Source installation is incomplete.'), {code:'COMPANY_UNAVAILABLE', reasonCode:'source', outcome:'not_applied'});
const cancelled = () => Object.assign(new Error('Cancelled'), {name:'AbortError', outcome:'not_applied'});
const file = value => {try{return statSync(value).isFile();}catch{return false;}};
async function loopbackPort(){
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  return port;
}

/** One private Source per runtime. Paths and process authority never enter public state. */
export function createProductSource({dataDir,env=process.env,spawnImpl=spawn,fetchImpl=fetch,nativeTransport,nativeGoalId,sourceInstallation}={}){
  // Only the owning Parent assembly supplies this private binding. It enables
  // neither provider availability nor cloud/Worker creation on its own.
  if(nativeTransport!==undefined)createNativeSourceAdmissionClient(nativeTransport);
  if(nativeTransport!==undefined&&!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(nativeGoalId??''))throw refused();
  const native=nativeTransport===undefined?undefined:Object.freeze({url:nativeTransport.url,token:nativeTransport.token});
  const requesterAuthorization=native?`Bearer ${randomBytes(32).toString('base64url')}`:undefined;
  const attempts=new Set();
  const productRoot=path.join(dataDir,'product');
  const installed=sourceInstallation===undefined?installedProductRuntime():null;
  const sourceAppRoot=sourceInstallation??installed?.sourceAppRoot??path.join(productRoot,'source-app');
  const cloudSdkRoot=installed?.cloudSdkRoot??path.join(productRoot,'cloud-sdk');
  const instanceRoot=native?path.join(productRoot,'native-source',nativeGoalId):productRoot;
  const sourceDataRoot=path.join(instanceRoot,'source-data'),sourceInstanceDir=path.join(instanceRoot,'source-instances');
  const nodePath=productNodeBinary(productRoot);
  const entry=path.join(sourceAppRoot,'bin','flujo.mjs');
  let child,pending,binding,closing=false;
  async function stop(){
    const owned=child;child=undefined;binding=undefined;
    if(!owned||owned.exitCode!==null)return;
    if(process.platform==='win32'){
      await new Promise(resolve=>{const killer=spawnImpl('taskkill',['/pid',String(owned.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.once('exit',resolve);killer.once('error',resolve);});
    }else owned.kill('SIGTERM');
  }
  async function start(){
    if(closing)throw cancelled();
    if(![nodePath,entry,path.join(sourceAppRoot,'.next','BUILD_ID'),path.join(cloudSdkRoot,'lib','managed.mjs')].every(file))throw refused();
    mkdirSync(productRoot,{recursive:true,mode:0o700});
    const relative=path.relative(realpathSync(productRoot),realpathSync(sourceAppRoot));
    if(!installed&&(!relative||relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative)))throw refused();
    for(const directory of [sourceDataRoot,sourceInstanceDir,path.join(instanceRoot,'source-bootstrap')])mkdirSync(directory,{recursive:true,mode:0o700});
    const port=await loopbackPort(),sourceOrigin=`http://127.0.0.1:${port}`;
    const childEnv={};
    for(const key of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','CODEX_HOME','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS'])if(typeof env[key]==='string')childEnv[key]=env[key];
    Object.assign(childEnv,{NODE_ENV:'production',FLUJO_DATA_DIR:sourceDataRoot,FLUJO_LOCAL_INSTANCE_DIR:sourceInstanceDir,FLUJO_BOOTSTRAP_DIR:path.join(instanceRoot,'source-bootstrap'),FLUJO_ENCRYPTION_SECRET_FILE:productOperatorSecret(instanceRoot),FLUJO_EXPOSURE_MODE:'localhost',FLUJO_BASE_URL:sourceOrigin,NEXT_TELEMETRY_DISABLED:'1'});
    if(native)Object.assign(childEnv,{FLUJO_EXECUTION_ADAPTER_MODULE:'seagulled-native-source',
      SEAGULLED_NATIVE_PARENT_URL:native.url,SEAGULLED_NATIVE_PARENT_TOKEN:native.token,
      SEAGULLED_NATIVE_REQUESTER_AUTHORIZATION:requesterAuthorization});
    const log=openSync(path.join(instanceRoot,'source.log'),'a',0o600);
    try{child=spawnImpl(nodePath,[entry,'--port',String(port),'--no-open'],{cwd:sourceAppRoot,env:childEnv,windowsHide:true,stdio:['ignore',log,log]});}finally{closeSync(log);}
    let startupError;child.once('error',error=>{startupError=error;});
    const deadline=Date.now()+90_000;
    while(Date.now()<deadline){
      if(closing){await stop();throw cancelled();}
      if(startupError||child?.exitCode!==null){await stop();throw refused();}
      try{
        const response=await fetchImpl(sourceOrigin+'/api/workspaces',{signal:AbortSignal.timeout(2500)});
        if(response.status===200){
          if(native){
            // An ordinary build cannot be relabeled as a native build. Probe
            // the compiled requester's exact browser refusal before readiness.
            const probe=await fetchImpl(sourceOrigin+'/v1/chat/completions',{method:'POST',
              headers:{Authorization:requesterAuthorization,'content-type':'application/json',Origin:sourceOrigin},
              body:'{}',signal:AbortSignal.timeout(2500)});
            const evidence=await probe.text();
            if(probe.status!==403||evidence.length>1024||JSON.parse(evidence)?.error!=='controller_native_source_refused'){
              await stop();throw refused();
            }
          }
          binding={cloudSdkRoot,sourceOrigin,sourceInstanceDir,sourceDataRoot,sourceAppRoot};return binding;
        }
      }catch{}
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    await stop();throw refused();
  }
  return {
    async source({signal}={}){
      if(signal?.aborted||closing)throw cancelled();
      if(binding&&child?.exitCode===null)return {...binding};
      if(!pending)pending=start().finally(()=>{pending=undefined;});
      if(!signal)return {...await pending};
      let cancel;
      const abort=new Promise((_,reject)=>{cancel=()=>reject(cancelled());signal.addEventListener('abort',cancel,{once:true});});
      try{return {...await Promise.race([pending,abort])};}finally{signal.removeEventListener('abort',cancel);}
    },
    async requestWorker({workerAuthorization,claim,prompt,signal,timeoutMs=180_000}={}){
      if(!native||closing||typeof workerAuthorization!=='string'||workerAuthorization.length>4096
        ||typeof prompt!=='string'||!prompt.trim()||Buffer.byteLength(prompt)>16*1024
        ||!claim||Object.keys(claim).sort().join()!=='goalId,rootConversationId,runId,workspace'
        ||Object.values(claim).some(value=>typeof value!=='string'||!value||value.length>160)
        ||!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>3_000_000)throw refused();
      signal?.throwIfAborted();
      const source=await this.source({signal});
      const key=JSON.stringify([claim.goalId,claim.runId,claim.rootConversationId]);
      if(attempts.has(key)||attempts.size>=1000)throw refused();
      const packet=JSON.stringify({workerAuthorization,claim:structuredClone(claim),prompt});
      attempts.add(key); // A lost response is not permission to issue again.
      const response=await fetchImpl(source.sourceOrigin+'/v1/chat/completions',{method:'POST',redirect:'error',
        headers:{Authorization:requesterAuthorization,'content-type':'application/json'},body:packet,
        signal:AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)].filter(Boolean))});
      const reader=response.body?.getReader();if(!reader)throw refused();
      const chunks=[];let bytes=0;
      try{
        while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;
          if(bytes>1024*1024)throw refused();chunks.push(Buffer.from(next.value));}
        signal?.throwIfAborted();return {status:response.status,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))};
      }finally{await reader.cancel();reader.releaseLock();}
    },
    async close(){closing=true;await stop();await pending?.catch(()=>{});await stop();},
  };
}

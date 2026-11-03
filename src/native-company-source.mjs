import {createHash} from 'node:crypto';
import {mkdirSync,lstatSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {Controller} from '../upstream/swarm-teams/fleet/controller.mjs';
import {createNativeSourceAdmissionTransport} from './native-source-transport.mjs';
import {createNativeSourcePlanReader,nativeSourcePlanDigest} from './native-source-plan.mjs';
import {createProductSource} from './product-source.mjs';
import {createNativeSourceAdmissionClient} from './native-source-client.mjs';
import {installNativeCompanyFlows} from './native-company-flows.mjs';
import {FlujoClient} from '../upstream/swarm-teams/lib/flujo-client.mjs';

const refused=()=>Object.assign(new Error('The native company Source installation is unavailable or changed.'),{code:'NATIVE_COMPANY_SOURCE'});
const ownerKey=actor=>createHash('sha256').update(JSON.stringify(actor)).digest('hex');

/** Parent assembly for a real runtime scope and existing Controller. Source
 * account state stays on this computer. Installation records contain only
 * identities and plan hashes; Worker bearers and request handles stay in RAM.
 * This composition does not qualify a provider, image or fleet by itself. */
export async function createNativeCompanySource({controller,scope,dataDir,goalId,sourceInstallation,
  modelName,reasoningEffort,sourceFactory=createProductSource}={}) {
  if(!(controller instanceof Controller)||typeof scope?.assertCurrent!=='function'
    ||typeof scope?.commit!=='function'||typeof scope?.retainUncertainty!=='function'
    ||!scope.signal||typeof dataDir!=='string'||!path.isAbsolute(dataDir)
    ||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(goalId??'')
    ||modelName!=='gpt-6-luna'||reasoningEffort!=='medium')throw refused();
  const directory=path.join(dataDir,'native-installations',goalId);
  mkdirSync(directory,{recursive:true,mode:0o700});
  const records=new Map(),handles=new WeakMap(),attempts=new Set(),installations=new Map();
  let source,closed=false;
  const read=actor=>{
    if(closed||actor.goalId!==goalId)throw refused();
    scope.signal.throwIfAborted();
    const selected=records.get(ownerKey(actor));if(!selected)throw refused();
    const stat=lstatSync(selected.file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>16384)throw refused();
    const record=JSON.parse(readFileSync(selected.file,'utf8'));
    if(record.version!==1||JSON.stringify(record.actor)!==JSON.stringify(actor)
      ||nativeSourcePlanDigest(record)!==selected.digest)throw refused();
    return record;
  };
  const transport=await createNativeSourceAdmissionTransport({controller,scope,workerTools:true,
    readPlan:async actor=>read(actor).plan,readChildren:async actor=>read(actor).children});
  try{source=sourceFactory({dataDir,nativeTransport:transport,nativeGoalId:goalId,sourceInstallation});}
  catch(error){await transport.close();throw error;}
  return Object.freeze({
    source:options=>source.source(options),
    async installWorkerWorkspace(workspace){
      if(closed||typeof workspace!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(workspace))throw refused();
      const actor={goalId};await scope.assertCurrent(actor);
      if(installations.has(workspace))return installations.get(workspace);
      if(installations.size>=100)throw refused();
      const pending=scope.commit(async()=>{
        const binding=await source.source({signal:scope.signal});
        const client=new FlujoClient({origin:binding.sourceOrigin,workspace,signal:scope.signal});
        const {toolConfig}=createNativeSourceAdmissionClient({url:transport.url,token:transport.token,signal:scope.signal});
        return installNativeCompanyFlows({client,toolConfig});
      },actor);
      installations.set(workspace,pending);
      return pending;
    },
    async prepareWorker({workerAuthorization,claim,flowId,modelId,child}={}){
      if(closed||typeof workerAuthorization!=='string'||!claim||claim.goalId!==goalId
        ||!child||typeof child.parentNodeId!=='string'||!child.parentNodeId
        ||typeof child.flowId!=='string'||!child.flowId)throw refused();
      const request={headers:{authorization:workerAuthorization}};
      const actor=controller.resolveNativeOriginalRun(request,claim);
      await scope.assertCurrent(actor);
      const key=ownerKey(actor);if(attempts.has(key)||attempts.size>=100)throw refused();
      attempts.add(key);
      const capture=selectedFlow=>createNativeSourcePlanReader({source,workspace:actor.workspace,
        flowId:selectedFlow,modelId,modelName,reasoningEffort,signal:scope.signal})(actor);
      const plan=await capture(flowId),childPlan=await capture(child.flowId);
      const record={version:1,actor,plan,children:[{parentNodeId:child.parentNodeId,...childPlan}]};
      const file=path.join(directory,`${key}.json`);
      await scope.commit(async()=>{
        await scope.assertCurrent(actor);
        if(JSON.stringify(controller.resolveNativeOriginalRun(request,claim))!==JSON.stringify(actor))throw refused();
        writeFileSync(file,JSON.stringify(record),{flag:'wx',mode:0o600});
        records.set(key,{file,digest:nativeSourcePlanDigest(record)});
      },actor);
      const handle=Object.freeze({});
      handles.set(handle,{workerAuthorization,claim:structuredClone(claim),actor,requested:false});
      return handle;
    },
    async requestWorker(handle,prompt,{timeoutMs=3_000_000}={}){
      const selected=handles.get(handle);
      if(closed||!selected||selected.requested)throw refused();
      await scope.assertCurrent(selected.actor);read(selected.actor);
      selected.requested=true;
      return source.requestWorker({workerAuthorization:selected.workerAuthorization,claim:selected.claim,
        prompt,timeoutMs,signal:scope.signal});
    },
    async close(){if(closed)return;closed=true;await source.close();await transport.close();records.clear();},
  });
}

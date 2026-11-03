import {createHash} from 'node:crypto';

const refused=()=>Object.assign(new Error('The installed native Source plan is unavailable or changed.'),{code:'NATIVE_SOURCE_PLAN'});
// This is Source's native receipt format, including undefined omission and
// sorted object keys. JSON insertion order cannot identify a native Original.
function canonical(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value)??'null';
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).filter(([,item])=>item!==undefined).sort(([a],[b])=>a.localeCompare(b))
    .map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}
export const nativeSourcePlanDigest=value=>createHash('sha256').update(canonical(value)).digest('hex');

/** Capture after installation, before executing Source mutations. Persist the
 * result in the Parent's private installation record and reread that record
 * during admission. Calling Source HTTP from an active Source mutation can
 * invert its workspace lock. Source still checks its live snapshot/model.
 * This capture grants no provider availability, admission or cloud authority. */
export function createNativeSourcePlanReader({source,workspace,flowId,modelId,modelName,reasoningEffort,signal,fetchImpl=fetch}={}){
  if(typeof source?.source!=='function'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(workspace??'')
    ||[flowId,modelId,modelName,reasoningEffort].some(value=>typeof value!=='string'||!value||value.length>160))throw refused();
  return async actor=>{
    signal?.throwIfAborted();if(actor?.workspace!==workspace)throw refused();
    const binding=await source.source({signal}),origin=new URL(binding.sourceOrigin);
    if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||!origin.port||origin.pathname!=='/'
      ||origin.search||origin.hash||origin.username||origin.password)throw refused();
    const read=async route=>{
      const url=new URL(route,origin);url.searchParams.set('workspace',workspace);
      const response=await fetchImpl(url,{redirect:'error',headers:{'x-flujo-workspace':workspace},
        signal:AbortSignal.any([signal,AbortSignal.timeout(10000)].filter(Boolean))});
      if(!response.ok||!response.body)throw refused();
      const reader=response.body.getReader(),chunks=[];let bytes=0;
      try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>1024*1024)throw refused();chunks.push(Buffer.from(next.value));}
        signal?.throwIfAborted();return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }finally{await reader.cancel();reader.releaseLock();for(const chunk of chunks)chunk.fill(0);}
    };
    const flow=await read(`/api/flow/${encodeURIComponent(flowId)}`),models=await read('/api/model');
    const model=Array.isArray(models)?models.find(value=>value.id===modelId):undefined;
    if(flow?.id!==flowId||!Array.isArray(flow.nodes)||!Array.isArray(flow.edges)||!model
      ||model.name!==modelName||model.reasoningEffort!==reasoningEffort||model.adapter!=='codex-cli'
      ||model.provider!=='codex'||model.ApiKey?.trim()||model.fallbackPolicy)throw refused();
    const modelPlan={id:model.id,name:model.name,adapter:model.adapter,provider:model.provider,maxTurns:model.maxTurns,
      temperature:model.temperature,reasoningEffort:model.reasoningEffort,fallbackPolicy:model.fallbackPolicy};
    return Object.freeze({flowId,flowDigest:nativeSourcePlanDigest(flow),modelId,modelDigest:nativeSourcePlanDigest(modelPlan)});
  };
}

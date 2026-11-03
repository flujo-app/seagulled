import {Controller} from '../upstream/swarm-teams/fleet/controller.mjs';

const refused=()=>Object.assign(new Error('The original Worker Source dispatch is unavailable or changed.'),{code:'NATIVE_WORKER_SOURCE'});

/** Adapt the existing Controller runFlow contract to the private local Source.
 * The caller supplies its installed plan and enrolled Worker bearer privately.
 * Scheduling, target binding and settlement remain owned by the Controller.
 * This adapter neither provisions a Worker nor qualifies a fleet route. */
export function createNativeWorkerSourceClient({controller,source,scope,target,workerAuthorization,installation}={}) {
  if(!(controller instanceof Controller)||typeof source?.prepareWorker!=='function'
    ||typeof source?.requestWorker!=='function'||typeof scope?.assertCurrent!=='function'
    ||!scope.signal||typeof workerAuthorization!=='string'
    ||!target?.workspace||!installation?.flowName||!installation.flowId||!installation.modelId
    ||!installation.child?.parentNodeId||!installation.child.flowId)throw refused();
  const selected=structuredClone(installation),enrolled=JSON.stringify(target);
  const request={headers:{authorization:workerAuthorization}};
  const original=controller.authenticate(request);
  if(!original||original==='operator'||JSON.stringify(original.target)!==enrolled)throw refused();
  const workerId=original.id,attempted=new Set();
  return Object.freeze({
    async runFlow({flowName,prompt,conversationId,timeoutMs}={}) {
      scope.signal.throwIfAborted();
      if(flowName!==selected.flowName||typeof prompt!=='string'||!prompt.trim()
        ||typeof conversationId!=='string'||attempted.has(conversationId))throw refused();
      const worker=controller.authenticate(request);
      if(!worker||worker==='operator'||worker.id!==workerId||JSON.stringify(worker.target)!==enrolled)throw refused();
      const runs=Object.values(controller.registry.state.runs).filter(run=>
        run.workerId===workerId&&run.conversationId===conversationId&&run.flowName===flowName&&run.state==='running');
      if(runs.length!==1)throw refused();
      const run=runs[0],claim={goalId:run.goalId,runId:run.id,rootConversationId:conversationId,workspace:target.workspace};
      const actor=controller.resolveNativeOriginalRun(request,claim);
      await scope.assertCurrent(actor);
      attempted.add(conversationId);
      const prepared=await source.prepareWorker({workerAuthorization,claim,flowId:selected.flowId,
        modelId:selected.modelId,child:selected.child});
      const response=await source.requestWorker(prepared,prompt,{...(timeoutMs?{timeoutMs}:{})});
      await scope.assertCurrent(actor);
      controller.resolveNativeOriginalRun(request,claim);
      const content=response?.body?.choices?.[0]?.message?.content;
      if(response?.status!==200||typeof content!=='string')return {status:'failed',conversationId,output:'',
        error:'The admitted Source did not return a completed Worker flow.'};
      const usage=response.body.usage;
      return {status:'completed',conversationId,output:content,
        usage:{inputTokens:Number.isFinite(usage?.prompt_tokens)?usage.prompt_tokens:0,
          outputTokens:Number.isFinite(usage?.completion_tokens)?usage.completion_tokens:0,
          costUsd:null,costKind:'subscription',billingPending:false,
          tokenUsageAvailable:Boolean(Number.isFinite(usage?.prompt_tokens)&&Number.isFinite(usage?.completion_tokens))}};
    },
  });
}

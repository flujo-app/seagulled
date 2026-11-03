import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createNativeSourcePlanReader} from '../src/native-source-plan.mjs';

async function equipment(task){
  const flow={id:'owned-flow',nodes:[],edges:[]};
  const model={id:'swarm-model',name:'gpt-6-luna',adapter:'codex-cli',provider:'codex',maxTurns:1,reasoningEffort:'medium',ApiKey:''};
  let requests=0;
  const server=createServer((request,response)=>{
    requests++;const url=new URL(request.url,'http://127.0.0.1');
    assert.equal(url.searchParams.get('workspace'),'owned-workspace');
    assert.equal(request.headers['x-flujo-workspace'],'owned-workspace');
    response.setHeader('content-type','application/json');
    response.end(JSON.stringify(url.pathname==='/api/model'?[model]:flow));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const source={async source(){return {sourceOrigin:`http://127.0.0.1:${server.address().port}`};}};
  const options={source,workspace:'owned-workspace',flowId:flow.id,modelId:model.id,modelName:model.name,reasoningEffort:model.reasoningEffort};
  try{await task({flow,model,options,requests:()=>requests});}
  finally{await new Promise(resolve=>server.close(resolve));}
}

test('saved plan matches the digest observed from real production Source native ownership',()=>equipment(async e=>{
  const plan=await createNativeSourcePlanReader(e.options)({workspace:'owned-workspace'});
  // Recorded by Source's nativeWorkerRoot in production qualification. This
  // fixed value detects a cross-boundary hash format change independently.
  assert.equal(plan.modelDigest,'945d47564e3d4d8ba08db038ff0205bf9bf7875f954c5f2f97bc7ea750650b20');
  assert.equal(Object.isFrozen(plan),true);assert.equal(e.requests(),2);
}));

test('foreign actor workspace or non-owned origin cannot inspect the saved plan',()=>equipment(async e=>{
  await assert.rejects(createNativeSourcePlanReader(e.options)({workspace:'foreign'}));assert.equal(e.requests(),0);
  await assert.rejects(createNativeSourcePlanReader({...e.options,source:{async source(){return {sourceOrigin:'https://foreign.invalid'};}}})({workspace:'owned-workspace'}));
  assert.equal(e.requests(),0);
}));

test('changed provider choice, key or fallback policy refuses a native plan',()=>equipment(async e=>{
  const read=createNativeSourcePlanReader(e.options),actor={workspace:'owned-workspace'};
  for(const [field,value] of [['reasoningEffort','high'],['name','other-model'],['ApiKey','synthetic'],['fallbackPolicy',{modelIds:['foreign']}]] ){
    const previous=e.model[field];e.model[field]=value;await assert.rejects(read(actor));e.model[field]=previous;
  }
}));

import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createProductSource} from '../src/product-source.mjs';

async function equipment(task,{native=true,compiled=true,platform,stopGraceMs,kill}={}){
  const directory=mkdtempSync(path.join(tmpdir(),'seagulled-product-native-'));
  const product=path.join(directory,'product');
  for(const name of ['node/node.exe','node/node','source-app/bin/flujo.mjs','source-app/.next/BUILD_ID','cloud-sdk/lib/managed.mjs']){
    const filename=path.join(product,name);mkdirSync(path.dirname(filename),{recursive:true});writeFileSync(filename,'fixture');
  }
  const calls=[],launches=[],children=[];
  const source=createProductSource({dataDir:directory,sourceInstallation:path.join(product,'source-app'),
    ...(native?{nativeTransport:{url:'http://127.0.0.1:1/native-source/admission',token:'A'.repeat(43)},nativeGoalId:'test-owned-goal'}:{}),
    ...(platform?{platform}:{}),...(stopGraceMs?{stopGraceMs}:{}),
    env:{PATH:process.env.PATH,UNRELATED_ACCOUNT_SECRET:'must not inherit'},
    spawnImpl(command,args,options){
      const child=new EventEmitter();child.pid=123456;child.exitCode=null;
      child.signals=[];child.end=signal=>{child.signalCode=signal;child.emit('exit',null,signal);};
      child.kill=signal=>{child.signals.push(signal);(kill??((target,sent)=>queueMicrotask(()=>target.end(sent))))(child,signal);return true;};
      if(command==='taskkill'){queueMicrotask(()=>child.emit('exit',0));}else{launches.push({command,args,options});children.push(child);}
      return child;
    },
    async fetchImpl(url,options){calls.push({url,options});
      if(url.endsWith('/api/workspaces'))return Response.json({workspaces:[]});
      if(options.headers.Origin)return Response.json({error:compiled?'controller_native_source_refused':'ordinary_refusal'},{status:403});
      return Response.json({choices:[{message:{content:'fixture'}}]});
    },
  });
  try{await task({source,calls,launches,product,children});}finally{
    await source.close();const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));
    assert.match(path.basename(target),/^seagulled-product-native-/);assert.equal(lstatSync(target).isSymbolicLink(),false);
    rmSync(target,{recursive:true,force:true});
  }
}

test('native Source keeps its controller credential in the child and returns no private binding',()=>equipment(async e=>{
  const binding=await e.source.source();const env=e.launches[0].options.env;
  assert.equal(env.SEAGULLED_NATIVE_PARENT_TOKEN,'A'.repeat(43));assert.equal(env.UNRELATED_ACCOUNT_SECRET,undefined);
  assert.equal(env.FLUJO_BASE_URL,binding.sourceOrigin);assert.match(env.SEAGULLED_NATIVE_REQUESTER_AUTHORIZATION,/^Bearer [A-Za-z0-9_-]{43}$/);
  assert.match(binding.sourceDataRoot,/native-source[\\/]test-owned-goal[\\/]source-data$/);
  assert.equal(Object.keys(binding).sort().join(),'cloudSdkRoot,sourceAppRoot,sourceDataRoot,sourceInstanceDir,sourceOrigin');
  assert.equal(e.calls[1].options.headers.Origin,binding.sourceOrigin);
}));

test('ordinary compiled Source cannot satisfy native requester readiness',()=>equipment(async e=>{
  await assert.rejects(e.source.source(),/incomplete/);assert.equal(e.calls.length,2);
},{compiled:false}));

test('Worker request uses the owned origin once and preserves an unknown response without replay',()=>equipment(async e=>{
  const input={workerAuthorization:'Bearer synthetic-worker',claim:{goalId:'goal',runId:'run',rootConversationId:'conversation',workspace:'workspace'},prompt:'fixture only'};
  const result=await e.source.requestWorker(input);assert.equal(result.status,200);
  const delivered=e.calls[2];assert.equal(delivered.options.redirect,'error');
  assert.equal(JSON.parse(delivered.options.body).workerAuthorization,input.workerAuthorization);
  assert.notEqual(delivered.options.headers.Authorization,input.workerAuthorization);
  await assert.rejects(e.source.requestWorker(input));assert.equal(e.calls.length,3);
  await assert.rejects(e.source.requestWorker({...input,claim:{...input.claim,origin:'http://foreign'}}));
}));

test('ordinary Source neither inherits native credentials nor dispatches Worker requests',()=>equipment(async e=>{
  await e.source.source();assert.equal(e.launches[0].options.env.SEAGULLED_NATIVE_PARENT_TOKEN,undefined);
  await assert.rejects(e.source.requestWorker({}));assert.equal(e.calls.length,1);
},{native:false}));

test('POSIX stop returns only after the child has exited',()=>equipment(async e=>{
  await e.source.source();let closed=false;
  const closing=e.source.close().then(()=>{closed=true;});
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(closed,false);assert.deepEqual(e.children[0].signals,['SIGTERM']);
  e.children[0].end('SIGTERM');await closing;assert.equal(closed,true);
},{platform:'linux',kill(){}}));

test('POSIX stop escalates once and never hangs on a child that ignores signals',()=>equipment(async e=>{
  await e.source.source();await e.source.close();
  assert.deepEqual(e.children[0].signals,['SIGTERM','SIGKILL']);
},{platform:'linux',stopGraceMs:5,kill(){}}));

test('a Source ended by a signal is replaced instead of reusing its stale binding',()=>equipment(async e=>{
  await e.source.source();e.children[0].end('SIGKILL');
  await e.source.source();assert.equal(e.launches.length,2);
},{platform:'linux'}));

import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {collectFlyArtifacts,remoteCollector,collectorCommand} from '../src/artifacts/fly.mjs';

const target={kind:'fly',app:'seagulled-fixture',machineId:'machine-123',outputRoot:'/data/results'};
async function setup(t){
  // Windows hosted runners expose TEMP through an 8.3 alias. The collector
  // deliberately rejects noncanonical roots, so resolve the fixture root first.
  const directory=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'seagulled-artifacts-')));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const output=path.join(directory,'remote','results');
  await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'proof.txt'),'proof café');
  const script=`(${remoteCollector.toString()})(${JSON.stringify(output)}).then(x=>process.stdout.write(JSON.stringify(x))).catch(()=>process.exit(1))`;
  const payload={...JSON.parse(execFileSync(process.execPath,['-e',script],{encoding:'utf8'})),root:target.outputRoot};
  const calls=[];
  const journal={app:target.app,machineId:target.machineId,outputRoot:target.outputRoot};
  const bridge={fly:{run:async args=>{calls.push(args);return JSON.stringify({exit_code:0,stdout:JSON.stringify(payload)});}}};
  const options={target,goalId:'goal-proof',workerId:'worker-proof',dataDir:path.join(directory,'private'),run:(...args)=>bridge.fly.run(...args)};
  return {directory,output,payload,calls,bridge,journal,options,script};
}

test('actual output bytes are captured before retirement and cached receipts never execute again',async t=>{
  const f=await setup(t);
  const receipts=await collectFlyArtifacts(f.options);
  assert.equal(receipts.length,1);assert.equal(receipts[0].kind,'worker-file');
  assert.equal(await fs.readFile(receipts[0].path,'utf8'),'proof café');
  assert.equal(f.calls[0][2],target.machineId);assert.equal(f.calls[0][3],collectorCommand('/data/results'));
  await fs.rm(f.output,{recursive:true,force:true});
  assert.deepEqual(await collectFlyArtifacts(f.options),receipts);assert.equal(f.calls.length,1);
  await fs.writeFile(receipts[0].path,'modified');
  await assert.rejects(collectFlyArtifacts(f.options),/changed after capture/);
  assert.equal(f.calls.length,1);
});

test('another folder and tampered file bytes produce no artifact commit',async t=>{
  const f=await setup(t);
  f.payload.files[0].data=Buffer.from('tampered').toString('base64');
  await assert.rejects(collectFlyArtifacts(f.options),/integrity mismatch/);
  await assert.rejects(fs.access(path.join(f.options.dataDir,'artifacts','goal-proof','worker-proof')));
  f.payload.files[0].data=Buffer.from('proof café').toString('base64');f.payload.root='/data/other';
  await assert.rejects(collectFlyArtifacts(f.options),/Invalid owned output receipt/);
});

test('Fly CLI omitted zero exit code is supported while explicit bad exit codes never commit output',async t=>{
  const f=await setup(t);
  for(const exit_code of [1,-1,null,'0']){
    f.bridge.fly.run=async()=>JSON.stringify({exit_code,stdout:JSON.stringify(f.payload)});
    await assert.rejects(collectFlyArtifacts(f.options),/complete receipt/);
    await assert.rejects(fs.access(path.join(f.options.dataDir,'artifacts','goal-proof','worker-proof')));
  }
  f.bridge.fly.run=async()=>JSON.stringify({stdout:JSON.stringify(f.payload)});
  const [receipt]=await collectFlyArtifacts(f.options);
  assert.equal(await fs.readFile(receipt.path,'utf8'),'proof café');
});

test('trusted collector rejects credential files and hard links rather than copying a workspace snapshot',async t=>{
  const f=await setup(t);
  await fs.writeFile(path.join(f.output,'auth.json'),'not-a-secret-fixture');
  assert.throws(()=>execFileSync(process.execPath,['-e',f.script],{stdio:'pipe'}));
  await fs.rm(path.join(f.output,'auth.json'));await fs.link(path.join(f.output,'proof.txt'),path.join(f.output,'linked.txt'));
  assert.throws(()=>execFileSync(process.execPath,['-e',f.script],{stdio:'pipe'}));
  for(const root of ['../other','/data/../etc','/etc','/data/a/b'])assert.throws(()=>collectorCommand(root),/Invalid owned/);
});

test('missing remote output never becomes a cached successful capture',async t=>{
  const f=await setup(t);
  f.payload.missingOutput=true;f.payload.files=[];
  await assert.rejects(collectFlyArtifacts(f.options),/directory is missing/);
  await assert.rejects(fs.access(path.join(f.options.dataDir,'artifacts','goal-proof','worker-proof')));
});

test('damaged or missing cached files preserve their original receipt without remote replay',async t=>{
  const f=await setup(t);
  const [receipt]=await collectFlyArtifacts(f.options);
  const manifest=path.join(path.dirname(receipt.path),'.seagulled-receipt.json');
  const original=await fs.readFile(manifest,'utf8');
  await fs.rm(receipt.path);
  await assert.rejects(collectFlyArtifacts(f.options),{code:'ENOENT'});
  assert.equal(await fs.readFile(manifest,'utf8'),original);assert.equal(f.calls.length,1);
  await fs.writeFile(manifest,'null');
  await assert.rejects(collectFlyArtifacts(f.options),/ownership mismatch/);
  assert.equal(f.calls.length,1);
});

test('common credential directories and dotfiles are rejected in the designated output tree',async t=>{
  const f=await setup(t);
  for(const name of ['.npmrc','.netrc','credentials','id_ed25519']){
    await fs.writeFile(path.join(f.output,name),'fixture');
    assert.throws(()=>execFileSync(process.execPath,['-e',f.script],{stdio:'pipe'}));
    await fs.rm(path.join(f.output,name));
  }
  await fs.mkdir(path.join(f.output,'.ssh'));
  assert.throws(()=>execFileSync(process.execPath,['-e',f.script],{stdio:'pipe'}));
});

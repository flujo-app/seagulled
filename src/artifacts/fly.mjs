import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { importCloudSdk } from '../swarm/cloud-sdk.mjs';
import { safeReceipt } from '@flujo-app/factory-receipts';

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const APP = /^[a-z][a-z0-9-]{2,62}$/;
const LIMIT = 4 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const forbidden = name => /^(?:auth\.json|credentials?(?:\.json)?|\.seagulled-receipt\.json|\.env(?:\..*)?|\.codex|\.claude|\.git|\.ssh|\.aws|\.azure|\.kube|\.npmrc|\.netrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|node_modules|db)$/i.test(name)
  || /\.(?:pem|key|p12|pfx)$/i.test(name);
const safeName = name => typeof name === 'string' && /^[A-Za-z0-9._ /-]{1,240}$/.test(name)
  && name.split('/').every(part => part && !['.','..'].includes(part) && !forbidden(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) && !/[. ]$/.test(part));

/** Fixed output tree only. This function runs as trusted operator code, not model code. */
export async function remoteCollector(workspace, parentRoot = '/data/flujo') {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const { createHash } = require('node:crypto');
  const root = path.join(parentRoot, 'workspaces', workspace, 'seagulled-output');
  const files = [];
  let rootFound = false;
  let total = 0, directories = 0;
  try {
    const stat = await fs.lstat(root);
    rootFound = true;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('unsafe output root');
    const canonical = await fs.realpath(root);
    if (canonical !== path.resolve(root)) throw Error('output root crosses a link');
    const visit = async (directory, depth) => {
      if (depth > 12 || ++directories > 200) throw Error('output tree limit');
      for (const name of await fs.readdir(directory)) {
        if (/^(?:auth\.json|credentials?(?:\.json)?|\.seagulled-receipt\.json|\.env(?:\..*)?|\.codex|\.claude|\.git|\.ssh|\.aws|\.azure|\.kube|\.npmrc|\.netrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|node_modules|db)$/i.test(name)
          || /\.(?:pem|key|p12|pfx)$/i.test(name)) throw Error('credential or dependency entry in output');
        const filename = path.join(directory,name), stat = await fs.lstat(filename);
        if (stat.isSymbolicLink() || stat.nlink > 1 && stat.isFile()) throw Error('linked output entry');
        if (stat.isDirectory()) { await visit(filename,depth+1); continue; }
        if (!stat.isFile() || stat.size > 2*1024*1024 || files.length >= 100 || total+stat.size > 4*1024*1024) throw Error('output file limit');
        if (!(await fs.realpath(filename)).startsWith(canonical+path.sep)) throw Error('output path escaped');
        const bytes = await fs.readFile(filename), after = await fs.lstat(filename);
        if (stat.ino!==after.ino || stat.size!==after.size || stat.mtimeMs!==after.mtimeMs || bytes.length!==stat.size) throw Error('output changed during capture');
        total+=bytes.length;
        files.push({relativePath:path.relative(root,filename).split(path.sep).join('/'),bytes:bytes.length,
          sha256:createHash('sha256').update(bytes).digest('hex'),data:bytes.toString('base64')});
      }
    };
    await visit(root,0);
    return {version:1,workspace,files};
  } catch(error) {
    if(error.code==='ENOENT' && !rootFound) return {version:1,workspace,files:[],missingOutput:true};
    throw Error('Owned output capture failed; credentials and command output are withheld.');
  }
}

export function collectorCommand(workspace) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(workspace)) throw Error('Invalid owned workspace.');
  const source = `(${remoteCollector.toString()})(${JSON.stringify(workspace)}).then(value=>process.stdout.write(JSON.stringify(value))).catch(()=>process.exit(1))`;
  const encoded = Buffer.from(source).toString('base64');
  return `node -e 'eval(Buffer.from("${encoded}","base64").toString())'`;
}

function validateFiles(value, workspace) {
  if (value?.version!==1 || value.workspace!==workspace || !Array.isArray(value.files) || value.files.length>100) throw Error('Invalid owned output receipt.');
  if (value.missingOutput) throw Error('The owned output directory is missing; deliverables have not been captured.');
  let total=0;
  const names=new Set();
  return value.files.map(file=>{
    if (!safeName(file.relativePath) || names.has(file.relativePath.toLowerCase()) || !Number.isInteger(file.bytes)
      || file.bytes<0 || file.bytes>2*1024*1024 || !/^[a-f0-9]{64}$/.test(file.sha256)
      || typeof file.data!=='string' || file.data.length>3*1024*1024) throw Error('Invalid owned output entry.');
    names.add(file.relativePath.toLowerCase());
    const bytes=Buffer.from(file.data,'base64'); total+=bytes.length;
    if (total>LIMIT || bytes.length!==file.bytes || bytes.toString('base64')!==file.data || digest(bytes)!==file.sha256) throw Error('Owned output integrity mismatch.');
    return {...file,content:bytes};
  });
}

/** Harvest before retirement, using the managed journal's exact app and Machine. */
export async function collectFlyArtifacts({target,goalId,workerId,dataDir,flujoCloudPath,managed}={}) {
  if (!ID.test(goalId??'') || !ID.test(workerId??'') || !APP.test(target?.app??'')
    || !ID.test(target.machineId??'') || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(target.workspace??'')
    || typeof dataDir!=='string') throw Error('A valid owned Fly output target is required.');
  const group=path.join(dataDir,'artifacts',goalId,workerId);
  const receiptPath=path.join(group,'.seagulled-receipt.json');
  const identity={app:target.app,machineId:target.machineId,workspace:target.workspace};
  const project=entries=>entries.map(file=>({...safeReceipt({path:path.join(group,...file.relativePath.split('/')),sha256:file.sha256,state:'ready'}),
    bytes:file.bytes,relativePath:file.relativePath,workerId,kind:'worker-file'}));
  let cached, hasReceipt = false;
  try {
    const stat = await fs.lstat(receiptPath);
    hasReceipt = true;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64*1024
      || await fs.realpath(receiptPath) !== path.resolve(receiptPath)) throw Error('Saved output receipt is unsafe.');
    cached=JSON.parse(await fs.readFile(receiptPath,'utf8'));
  }
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(hasReceipt){
    if (cached?.version!==1 || cached.goalId!==goalId || cached.workerId!==workerId
      || Object.keys(identity).some(key=>cached.target?.[key]!==identity[key])
      || !Array.isArray(cached.files) || cached.files.length>100) throw Error('Saved output ownership mismatch.');
    const names = new Set();
    let total = 0;
    for (const file of cached.files) {
      if(!safeName(file?.relativePath) || names.has(file.relativePath.toLowerCase())
        || !Number.isInteger(file.bytes) || file.bytes<0 || file.bytes>2*1024*1024
        || !/^[a-f0-9]{64}$/.test(file.sha256) || (total+=file.bytes)>LIMIT) throw Error('Invalid saved output entry.');
      names.add(file.relativePath.toLowerCase());
      const actual=path.join(group,...file.relativePath.split('/'));
      const stat=await fs.lstat(actual);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || stat.size>2*1024*1024 || await fs.realpath(actual)!==path.resolve(actual)) throw Error('Saved output path changed.');
      const bytes=await fs.readFile(actual);
      if(bytes.length!==file.bytes || digest(bytes)!==file.sha256) throw Error('Saved output changed after capture.');
    }
    return project(cached.files);
  }
  try {await fs.lstat(group);throw Error('Output folder exists without its receipt; preserve it for reconciliation.');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if (!managed) {
    const {ManagedCloud}=await importCloudSdk('.', flujoCloudPath);
    managed=new ManagedCloud();
  }
  const files=await managed.operation(target.app,'collect-output',async()=>{
    const {metadata,journal}=await managed.deployment(target.app);
    if(metadata.phase!=='ready' || journal.app!==target.app || journal.machineId!==target.machineId || journal.workspace!==target.workspace) throw Error('Output target does not match its ready journal.');
    const bridge=await managed.runtime();
    if(!await bridge.ownedApp(journal)) throw Error('The owned output app is absent.');
    await bridge.waitForMachine(journal,15_000);
    const raw=await bridge.fly.run(['machine','exec',target.machineId,collectorCommand(target.workspace),'--app',target.app,'--json'],{timeoutMs:30_000});
    if(raw.length>8*1024*1024) throw Error('Owned output response is too large.');
    let execution,payload;
    try {
      execution=JSON.parse(raw);
      // fly-go MachineExecResponse uses omitempty for a zero ExitCode; flyctl
      // re-serializes that response. Explicit nonzero/malformed codes still fail.
      if (!execution || typeof execution !== 'object' || Array.isArray(execution)
        || Object.hasOwn(execution,'exit_code') && execution.exit_code!==0
        || typeof execution.stdout!=='string') throw Error();
      payload=JSON.parse(execution.stdout);
    }
    catch { throw Error('Owned output command did not produce a complete receipt.'); }
    return validateFiles(payload,target.workspace);
  });
  await fs.mkdir(path.dirname(group),{recursive:true,mode:0o700});
  if(await fs.realpath(path.dirname(group))!==path.resolve(path.dirname(group))) throw Error('Owned output folder crosses a link.');
  const temporary=`${group}.${randomUUID()}.tmp`;
  await fs.mkdir(temporary,{mode:0o700});
  try {
    for(const file of files){
      const destination=path.join(temporary,...file.relativePath.split('/'));
      await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});
      const handle=await fs.open(destination,'wx',0o600);
      try { await handle.writeFile(file.content); await handle.sync(); } finally {await handle.close();}
    }
    const handle=await fs.open(path.join(temporary,'.seagulled-receipt.json'),'wx',0o600);
    try {await handle.writeFile(JSON.stringify({version:1,goalId,workerId,target:identity,files:files.map(({data,content,...file})=>file)})); await handle.sync();} finally {await handle.close();}
    await fs.rename(temporary,group);
  } catch(error){
    if(!path.resolve(temporary).startsWith(path.resolve(path.dirname(group))+path.sep)) throw Error('Unsafe temporary output cleanup target.');
    await fs.rm(temporary,{recursive:true,force:true});throw error;
  }
  return project(files);
}

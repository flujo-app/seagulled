import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderManager} from '../src/providers/index.mjs';

test('unqueried Fly Apps.Nodes requires fresh bounded org inventory and rechecks continuation',async()=>{
  const root=mkdtempSync(join(tmpdir(),'seagulled-null-inventory-'));
  const dataDir=join(root,'providers'),helperRoot=join(root,'helpers');
  const binary=join(helperRoot,'fly',process.platform==='win32'?'flyctl.exe':'flyctl');
  mkdirSync(join(binary,'..'),{recursive:true});writeFileSync(binary,'fixture');
  mkdirSync(join(dataDir,'auth','fly'),{recursive:true});writeFileSync(join(dataDir,'auth','fly','config.yml'),'fixture');
  let apps=[{Name:'unrelated-existing-app',Organization:{Slug:'personal'}}],code=0;
  const calls=[];
  const manager=new ProviderManager({dataDir,helperRoot,env:{},ptyCheck:async()=>false,
    commandRunner:async(command,args,options)=>{
      assert.equal(command,binary);const text=args.join(' ');calls.push(text);
      if(text==='--version')return {code:0,stdout:'fixture'};
      if(text==='auth whoami --json')return {code:0,stdout:'{"email":"person@example.com"}'};
      if(text==='orgs list --json')return {code:0,stdout:'{"personal":"Personal"}'};
      if(text==='orgs show personal --json')return {code:0,stdout:'{"Slug":"personal","Type":"PERSONAL","Apps":{"Nodes":null}}'};
      assert.equal(text,'apps list --org personal --json');assert.equal(options.maxBytes,8*1024*1024);
      return {code,stdout:JSON.stringify(apps)};
    }});
  try{
    const lease=await manager.flyFleetLease();assert.equal(lease.available,true);
    assert.equal(await manager.assertFlyAccountLeaseCurrent(lease),true);
    assert.equal(calls.filter(x=>x==='apps list --org personal --json').length,2);
    apps=[{Name:'foreign-app',Organization:{Slug:'another'}}];
    assert.equal((await manager.flyFleetLease()).available,false);
    await assert.rejects(manager.assertFlyAccountLeaseCurrent(lease));
    apps={Nodes:[]};assert.equal((await manager.flyFleetLease()).available,false);
    apps=[];code=1;assert.equal((await manager.flyFleetLease()).available,false);
  }finally{rmSync(root,{recursive:true,force:true});}
});

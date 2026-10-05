import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCredentialStore} from '../electron/credentials.mjs';

test('desktop credentials are encrypted outside source and can be removed',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'seagulled-ui-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const safeStorage={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),decryptString:buffer=>Buffer.from(buffer.toString().slice(10),'base64').toString()};
  const store=createCredentialStore({dataDir,safeStorage});
  await store.set('openai','test-private-key');
  const bytes=await readFile(join(dataDir,'credentials','openai.bin'));
  assert.equal(bytes.includes(Buffer.from('test-private-key')),false);
  assert.equal(await store.get('openai'),'test-private-key');
  await store.delete('openai');
  assert.equal(await store.get('openai'),null);
  await assert.rejects(()=>store.set('../other','key'),/Invalid provider ID/);
});

test('desktop refuses plaintext credential persistence',async()=>{
  const store=createCredentialStore({dataDir:tmpdir(),safeStorage:{isEncryptionAvailable:()=>false}});
  await assert.rejects(()=>store.set('openai','key'),/Secure credential storage is unavailable/);
});

test('desktop refuses plaintext fallback even when encryption API is available',async()=>{
  const store=createCredentialStore({dataDir:tmpdir(),safeStorage:{isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'basic_text'}});
  await assert.rejects(()=>store.set('openai','key'),/Secure credential storage is unavailable/);
});

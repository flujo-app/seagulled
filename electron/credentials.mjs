import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';

const validId=id=>typeof id==='string' && /^[a-z0-9_-]{1,50}$/.test(id);

export function createCredentialStore({dataDir,safeStorage}) {
  const directory=join(dataDir,'credentials');
  const file=id=>{if(!validId(id))throw new Error('Invalid provider ID.');return join(directory,`${id}.bin`);};
  const available=()=>{
    if(!safeStorage?.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.()==='basic_text')throw new Error('Secure credential storage is unavailable on this device. Sign in again when needed.');
  };
  return {
    async set(id,secret) {
      available();
      if(typeof secret!=='string'||!secret)throw new Error('A key is required.');
      await mkdir(directory,{recursive:true,mode:0o700});
      await writeFile(file(id),safeStorage.encryptString(secret),{mode:0o600});
    },
    async get(id) {
      available();
      try{return safeStorage.decryptString(await readFile(file(id)));}
      catch(error){if(error?.code==='ENOENT')return null;throw new Error('Saved provider key could not be unlocked.');}
    },
    async delete(id) {await unlink(file(id)).catch(error=>{if(error?.code!=='ENOENT')throw error;});}
  };
}

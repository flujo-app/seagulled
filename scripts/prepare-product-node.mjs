import {readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
const lock=JSON.parse(readFileSync(new URL('../docs/product-node-lock.json',import.meta.url)));
if(process.platform!== 'win32'||process.arch!=='x64')throw new Error('The desktop product runtime currently targets Windows x64.');
const root=path.resolve('.private/product-node');
mkdirSync(root,{recursive:true});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const file of lock.files){
  const target=path.join(root,file.name);
  if(existsSync(target)){
    if(!lstatSync(target).isFile()||lstatSync(target).isSymbolicLink()||hash(readFileSync(target))!==file.sha256)throw new Error(`Product Node integrity mismatch: ${file.name}`);
  }else{
    const response=await fetch(file.url,{signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw new Error(`Product Node download failed: ${file.name}`);
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.length>128*1024*1024||hash(bytes)!==file.sha256)throw new Error(`Product Node download integrity mismatch: ${file.name}`);
    writeFileSync(target,bytes,{flag:'wx'});
  }
}
writeFileSync(path.join(root,'manifest.json'),JSON.stringify(lock,null,2)+'\n');
console.log(`Verified official Node ${lock.version} and license for the Windows product runtime.`);

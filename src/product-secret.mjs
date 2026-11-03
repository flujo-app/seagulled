import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {lstatSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const aclScript = `
$ErrorActionPreference='Stop'
$target=[Environment]::GetEnvironmentVariable('SEAGULLED_PRIVATE_SECRET_PATH')
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
if([Environment]::GetEnvironmentVariable('SEAGULLED_PRIVATE_SECRET_CREATE') -eq '1') {
  $acl=[Security.AccessControl.FileSecurity]::new()
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true,$false)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))
  [IO.File]::SetAccessControl($target,$acl)
}
$actual=[IO.File]::GetAccessControl($target)
if(-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {throw 'Private secret ACL unavailable'}
$rules=$actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
if($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl') {throw 'Private secret ACL unavailable'}
`;

/** Source-only operator mount, outside its data/snapshot tree. Never returned publicly. */
export function productOperatorSecret(productRoot) {
  const root=path.resolve(productRoot), directory=path.join(root,'source-secrets');
  mkdirSync(directory,{recursive:true,mode:0o700});
  if(realpathSync(directory)!==directory)throw new Error('Private Source secret directory must be link-free.');
  const filename=path.join(directory,'operator-secret');
  let created=false;
  try {const descriptor=openSync(filename,'wx',0o600);closeSync(descriptor);created=true;}
  catch(error){if(error.code!=='EEXIST')throw error;}
  const stats=lstatSync(filename);
  if(!stats.isFile()||stats.isSymbolicLink()||stats.nlink!==1||realpathSync(filename)!==filename)throw new Error('Private Source secret must be a regular owned file.');
  if(process.platform==='win32') {
    try {execFileSync(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
      ['-NoProfile','-NonInteractive','-Command',aclScript],{windowsHide:true,stdio:'pipe',env:{...process.env,SEAGULLED_PRIVATE_SECRET_PATH:filename,SEAGULLED_PRIVATE_SECRET_CREATE:created?'1':'0'}});
    } catch {throw new Error('Private Source secret ACL could not be verified.');}
  } else if((stats.mode&0o077)!==0||stats.uid!==process.getuid())throw new Error('Private Source secret permissions are unavailable.');
  // Protect the empty file first. Failed or interrupted setup never exposes key bytes.
  if(created)writeFileSync(filename,randomBytes(32).toString('base64url'),{flag:'r+',mode:0o600});
  const value=readFileSync(filename,'utf8');
  if(!/^[A-Za-z0-9_-]{43}$/.test(value))throw new Error('Private Source secret is incomplete; preserve it for recovery.');
  return filename;
}

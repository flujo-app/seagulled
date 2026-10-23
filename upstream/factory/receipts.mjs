import { isAbsolute } from 'node:path';

/** Only operational metadata belongs in the ledger. Model output is a separate private artifact. */
export function safeReceipt(input={}) {
  const output={};
  for(const key of ['worker','app']) if(typeof input[key]==='string' && /^[a-z][a-z0-9-]{2,62}$/.test(input[key]))output[key]=input[key];
  for(const key of ['head','previousHead','sha256','outputSha256']) if(typeof input[key]==='string' && new RegExp('^[a-f0-9]{'+(key.endsWith('Sha256')||key==='sha256'?64:40)+'}$').test(input[key]))output[key]=input[key];
  for(const key of ['path','outputPath']) if(typeof input[key]==='string' && isAbsolute(input[key]))output[key]=input[key];
  if(typeof input.ref==='string' && /^refs\/heads\/[a-zA-Z0-9/_-]+$/.test(input.ref))output.ref=input.ref;
  if(typeof input.contentType==='string' && /^[a-z-]+\/[a-z0-9.+-]+(?:;\s*charset=[a-z0-9-]+)?$/i.test(input.contentType))output.contentType=input.contentType;
  if(['ready','destroyed','not_applied','unknown'].includes(input.state))output.state=input.state;
  if(['cloud-confirmed','local-preparation','local-capture'].includes(input.retirement))output.retirement=input.retirement;
  if(typeof input.reconciled==='boolean')output.reconciled=input.reconciled;
  if(input.reason==='External outcome requires reconciliation.')output.reason=input.reason;
  return output;
}

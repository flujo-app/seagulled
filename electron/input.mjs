function requiredString(value,label,max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} is invalid.`);
  return value;
}

export function validateConnectPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Connection details are invalid.');
  const payload = {
    id: requiredString(value.id,'ID',128),
    method: requiredString(value.method,'Connection method',100)
  };
  if (value.key !== undefined) payload.key=requiredString(value.key,'API key',10000);
  if (value.model !== undefined) payload.model=requiredString(value.model,'Model',200);
  if (value.fleetAllowed !== undefined) {
    if (typeof value.fleetAllowed !== 'boolean') throw new Error('Worker permission is invalid.');
    payload.fleetAllowed=value.fleetAllowed;
  }
  return payload;
}

export function validateGoalOptions(value={}) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Goal settings are invalid.');
  if(value.privateH100!==undefined&&typeof value.privateH100!=='boolean')throw new Error('Private H100 choice is invalid.');
  const maxWorkers=Number(value.maxWorkers??10),conversationsPerWorker=Number(value.conversationsPerWorker??10);
  if(!Number.isInteger(maxWorkers)||maxWorkers<1||maxWorkers>100)throw new Error('Workers must be between 1 and 100.');
  if(!Number.isInteger(conversationsPerWorker)||conversationsPerWorker<1||conversationsPerWorker>10)throw new Error('Conversations per worker must be between 1 and 10.');
  const options={maxWorkers,conversationsPerWorker};
  if(value.unlimited!==undefined){if(typeof value.unlimited!=='boolean')throw new Error('Unlimited choice is invalid.');options.unlimited=value.unlimited;}
  if(value.budgetUsd!==undefined){if(value.unlimited===true&&value.budgetUsd===null)options.budgetUsd=null;else{if(typeof value.budgetUsd!=='number'||!Number.isFinite(value.budgetUsd)||value.budgetUsd<=0)throw new Error('Budget is invalid.');options.budgetUsd=value.budgetUsd;}}
  if(value.memoryMb!==undefined){if(![1024,2048,4096].includes(value.memoryMb))throw new Error('Machine size is invalid.');options.memoryMb=value.memoryMb;}
  if(value.memoryOverride!==undefined){if(typeof value.memoryOverride!=='boolean')throw new Error('Memory choice is invalid.');options.memoryOverride=value.memoryOverride;}
  if(value.executionMode!==undefined) {
    if(value.executionMode!=='company')throw new Error('Company execution mode is invalid.');
    options.executionMode='company';
  }
  if(value.providerId!==undefined) {
    if(typeof value.providerId!=='string'||!['codex','claude','openai','anthropic'].includes(value.providerId))
      throw new Error('Goal provider is invalid.');
    if(value.privateH100===true)throw new Error('Choose one inference route.');
    options.providerId=value.providerId;
  }
  if(value.privateH100!==undefined)options.privateH100=value.privateH100;
  if(value.budget!==undefined){
    if(!value.budget||typeof value.budget!=='object'||Array.isArray(value.budget))throw new Error('Budget is invalid.');
    const amount=Number(value.budget.amount),currency=value.budget.currency;
    if(!Number.isFinite(amount)||amount<=0||typeof currency!=='string'||!/^[A-Z]{3}$/.test(currency))throw new Error('Budget is invalid.');
    options.budget={amount,currency};
  }
  return options;
}

export function validateVoiceInput(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||value.mimeType!=='audio/wav'||typeof value.dataBase64!=='string'||value.dataBase64.length>2_800_000||!/^[A-Za-z0-9+/]*={0,2}$/.test(value.dataBase64))throw new Error('Recording is invalid.');
  const result={mimeType:'audio/wav',dataBase64:value.dataBase64};
  if(value.language!==undefined){if(typeof value.language!=='string'||!(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/).test(value.language))throw new Error('Voice language is invalid.');result.language=value.language;}
  return result;
}

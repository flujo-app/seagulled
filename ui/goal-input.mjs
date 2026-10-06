export function oneSentence(text) {
  if(typeof text!=='string')return null;
  const value=text.trim().replace(/\s+/g,' ');
  if(!value || value.length>4000)return null;
  const sentences=value.match(/[^.!?。！？]+[.!?。！？]+(?:\s+|$)/g) || [];
  if(sentences.length>1)return null;
  if(sentences.length===1 && value.slice(sentences[0].length).trim())return null;
  return value;
}

export function budgetOptions({amount,currency,workers,conversations,privateH100=false}) {
  const maxWorkers=Number(workers),conversationsPerWorker=Number(conversations);
  if(!Number.isInteger(maxWorkers)||maxWorkers<1||maxWorkers>10)throw new Error('Workers must be between 1 and 10.');
  if(!Number.isInteger(conversationsPerWorker)||conversationsPerWorker<1||conversationsPerWorker>10)throw new Error('Conversations per worker must be between 1 and 10.');
  if(typeof privateH100!=='boolean')throw new Error('Private H100 choice is invalid.');
  const options={maxWorkers,conversationsPerWorker,privateH100};
  if(String(amount).trim()) {
    const value=Number(amount);
    if(!Number.isFinite(value)||value<=0)throw new Error('Enter a positive budget.');
    if(!/^[A-Z]{3}$/.test(currency))throw new Error('Choose a currency.');
    options.budget={amount:value,currency};
  }
  return options;
}

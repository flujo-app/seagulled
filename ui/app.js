import {VoiceCapture} from './voice-capture.mjs';
import {oneSentence,budgetOptions} from './goal-input.mjs';
import {sceneFor} from './stage.mjs';
import {MoviePlayer} from './movie-player.mjs';
import movieManifest from './movie-manifest.json' with {type:'json'};

const $=id=>document.getElementById(id);
const elements=Object.fromEntries(['movie','frame','movie-video','movie-status','narration-status','action','action-icon','voice-level','advanced-toggle','live-status','todd-audio','setup-dialog','advanced-dialog','fly-state','modal-state','fly-connect','modal-connect','inference-state','provider-setup','setup-error','setup-continue','budget-amount','budget-currency','budget-note','goal-provider','goal-provider-note','workers','workers-value','conversations','conversations-value','private-h100','private-h100-status','text-fallback','fallback-goal','fallback-go','pause-all','resume-all','stop-all','work-details','goal-details','provider-details','spend-details','provider-connect-details','provider-choice','provider-guidance','provider-model-row','provider-model','provider-key-row','provider-key','provider-storage-note','provider-worker-row','provider-worker-consent','provider-connect','provider-disconnect','advanced-error'].map(id=>[id,$(id)]));
const allowedCurrencies=new Set(['USD','EUR','GBP','COP','CAD','AUD']);
const providerModels={openai:['gpt-6.1-sol','gpt-6-luna','gpt-6-astra'],anthropic:['claude-sonnet-5-5']};
const supportedProviders=new Set(['codex','claude','openai','anthropic']);
const terminal=new Set(['completed','stopped','failed','interrupted','cancelled']);
let state={version:1,conversation:[],goals:[],spend:{},swarm:{status:'idle'}};
let auth={fly:{connected:false,available:false,detail:'Checking…'},modal:{connected:false,available:false,detail:'Checking…'}};
let voice={transcribe:false,speak:false,reason:'Voice is not ready.'};
let mode='ready',started=false,authBusy=false,goalSubmitting=false,goalPostStarted=false,pendingGoal=null,goTimer=null,workingSince=0,workingKey='',voiceWait=null,capturePending=false,inputEpoch=0,suppressTodd=false;
let knownMessages=null,speechQueue=Promise.resolve(),speechEpoch=0,audioUrl=null,activeSpeechFinish=null,refreshTimer=null;
let budgetWait=null,budgetQuote=null,budgetCustom=false,budgetEpoch=0,currencySwitch=null,selectedPreset=50,quoteExpiryTimer=null;
let providerBusy=false,providerSetupPending=false,providerWait=null,displayedProvider='';
const capture=new VoiceCapture({onLevel:level=>{elements['voice-level'].style.setProperty('--level',String(Math.max(.2,level*3)));},onHeard:()=>announce('Listening to your goal.'),onReady:()=>{setMode('listening');announce('Listening. Speak one sentence.');}});
const moviePlayer=new MoviePlayer({video:elements['movie-video'],stage:elements.movie,manifest:movieManifest,onStatus:({status,detail})=>{
  elements['movie-status'].textContent=status==='missing'||status==='missing-scene'||status==='failed'
    ? `${detail||'Approved movie footage is unavailable.'} Narration is separate from the film; lip movement is not synchronized.`
    : status==='playing'?'Local silent film is playing. Narration is separate; lip movement is not synchronized.':'Checking approved local movie clips.';
}});

function browserBridge() {
  const hash=new URLSearchParams(location.hash.slice(1));const fresh=hash.get('token');
  if(fresh){sessionStorage.setItem('seagulled-bootstrap',fresh);history.replaceState(null,'',location.pathname+location.search);}
  const token=sessionStorage.getItem('seagulled-bootstrap');
  async function request(path,method='GET',body) {
    const headers={Authorization:`Bearer ${token||''}`};if(body!==undefined)headers['Content-Type']='application/json';
    const response=await fetch(path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});
    const raw=await response.text();let data;try{data=raw?JSON.parse(raw):null;}catch{data=null;}
    if(!response.ok)throw new Error(data?.error||data?.message||`Request failed (${response.status}).`);
    return data;
  }
  let notify=()=>{};
  async function events() {
    while(true){
      try{
        const response=await fetch('/api/events',{headers:{Authorization:`Bearer ${token||''}`},cache:'no-store'});
        if(!response.ok||!response.body)throw new Error('Live updates are unavailable.');
        const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
        while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true}).replace(/\r/g,'');let cut;
          while((cut=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,cut);buffer=buffer.slice(cut+2);const line=block.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');if(line){try{notify(JSON.parse(line));}catch{}}}
        }
      }catch{announce('Live updates are interrupted.');}
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
  }
  return {
    state:()=>request('/api/state'),chat:(text,options)=>request('/api/chat','POST',{text,...options}),
    defaultBudget:currency=>request(`/api/budget/default?currency=${encodeURIComponent(currency)}`),
    updateGoal:(id,patch)=>request(`/api/goals/${encodeURIComponent(id)}`,'PATCH',patch),
    controlSwarm:action=>request(`/api/swarm/${encodeURIComponent(action)}`,'POST',{}),
    discover:()=>request('/api/providers/discover','POST',{}),connect:payload=>request('/api/providers/connect','POST',payload),
    disconnect:id=>request(`/api/providers/${encodeURIComponent(id)}`,'DELETE'),
    authState:()=>request('/api/auth/state'),authConnect:payload=>request('/api/auth/connect','POST',payload),authCancel:()=>request('/api/auth/cancel','POST',{}),
    voiceCapabilities:()=>request('/api/voice/capabilities'),transcribeAudio:payload=>request('/api/voice/transcribe','POST',payload),
    speak:text=>request('/api/voice/speak','POST',{text}),stopSpeaking:()=>request('/api/voice/stop','POST',{}),
    onEvent:callback=>{notify=callback;void events();return()=>{notify=()=>{};}}
  };
}
const bridge=window.seagulled||browserBridge();

function announce(message){elements['live-status'].textContent=message;}
function renderNarration(){const source=voice.narration,status=voice.narrationStatus;
  elements['narration-status'].textContent=source==='kokoro'?`Narration: ${voice.voiceName||'Michael (preset)'} local preset.`
    :source==='system'?status==='preparing'?'Narration: installed system voice while the local preset prepares.':'Narration: installed system voice.'
    :'Narration is unavailable.';
}
async function refreshVoiceCapabilities(){try{voice=await bridge.voiceCapabilities();}catch(error){voice={transcribe:false,speak:false,ready:false,reason:errorMessage(error)};}renderNarration();}
function errorMessage(error){return error?.message||String(error||'That action could not be completed.');}
function showError(message,target='advanced'){
  const box=target==='setup'?elements['setup-error']:elements['advanced-error'];box.textContent=message;box.hidden=false;announce(message);
  if(target==='advanced'&&!elements['advanced-dialog'].open)elements['advanced-dialog'].showModal();
}
function clearError(target){const box=target==='setup'?elements['setup-error']:elements['advanced-error'];box.hidden=true;box.textContent='';}
function iconFor(action){
  if(action==='start'||action==='go')return '<path d="M8 5.7v12.6L18.2 12 8 5.7Z"/>';
  if(action==='listen')return '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 10a6 6 0 0 0 12 0M12 16v5M8 21h8"/>';
  if(action==='stop-listening'||action==='stop-speaking')return '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>';
  return '<circle cx="12" cy="12" r="7"/><path d="M12 8v4l3 2"/>';
}
function setAction(action,label,disabled=false){elements.action.dataset.action=action;elements.action.setAttribute('aria-label',label);elements.action.disabled=disabled;elements['action-icon'].innerHTML=iconFor(action);}
function setMode(next){mode=next;elements.movie.dataset.mode=next;elements['voice-level'].classList.toggle('active',next==='listening');
  if(next==='listening')setAction('stop-listening','Stop listening');
  else if(next==='transcribing'||next==='preparing-listen'||next==='submitting'||next==='setup')setAction('busy','Working',true);
  else if(next==='go')setAction('go','Go');
  else if(next==='speaking')setAction('stop-speaking','Stop Todd speaking');
  else setAction(started?'listen':'start',started?'Speak a goal':'Start');
  updateScene();
}
function latestGoal(){return state.goals?.at(-1)||null;}
function updateScene(){
  const goal=latestGoal();const key=goal?.status==='running'&&goal?.tasks?.some(task=>task.status==='running')?`${goal.id}:${goal.tasks.filter(task=>task.status==='running').map(task=>task.id).join(',')}`:'';
  if(key!==workingKey){workingKey=key;workingSince=key?performance.now():0;}
  const scene=sceneFor({mode,goal,workingMs:workingSince?performance.now()-workingSince:0});
  if(elements.movie.dataset.scene!==scene){elements.movie.dataset.scene=scene;elements.frame.dataset.scene=scene;void moviePlayer.setScene(scene);}
}
setInterval(updateScene,350);

function node(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
function budgetLine(goal){const budget=goal.budget;if(!budget)return `${Number(goal.budgetUsd||0).toFixed(2)} USD allowance`;
  const amount=new Intl.NumberFormat(undefined,{maximumFractionDigits:2}).format(budget.amount);
  return `${amount} ${budget.currency} allowance · ${Number(budget.allowanceUsd).toFixed(2)} USD limit`;
}
function appendGoalEditor(card,goal){
  const details=node('details',undefined,'goal-editor');details.append(node('summary','Edit goal'));
  const form=node('form');form.className='goal-edit-form';
  const textLabel=node('label','Goal');const textInput=node('textarea');textInput.value=goal.text||'';textInput.rows=3;textInput.maxLength=4000;textInput.required=true;textLabel.append(textInput);
  const budgetLabel=node('label','Budget');const amount=node('input');amount.type='number';amount.min='0.01';amount.step='any';amount.required=true;amount.value=String(goal.budget?.amount??goal.budgetUsd??5);amount.setAttribute('aria-label','Edit budget amount');
  const currency=node('select');currency.setAttribute('aria-label','Edit budget currency');for(const code of allowedCurrencies){const option=node('option',code);option.value=code;currency.append(option);}currency.value=goal.budget?.currency||'USD';budgetLabel.append(amount,currency);
  const workerLabel=node('label','Workers');const workers=node('input');workers.type='number';workers.min='1';workers.max='6';workers.step='1';workers.required=true;workers.value=String(goal.maxWorkers??5);workerLabel.append(workers);
  const conversationLabel=node('label','Conversations per worker');const conversations=node('input');conversations.type='number';conversations.min='1';conversations.max='10';conversations.step='1';conversations.required=true;conversations.value=String(goal.conversationsPerWorker??(goal.agentsPerWorker===undefined?5:goal.agentsPerWorker+1));conversationLabel.append(conversations);
  const save=node('button','Save changes','line-button');save.type='submit';form.append(textLabel,budgetLabel,workerLabel,conversationLabel,save);
  form.addEventListener('submit',async event=>{event.preventDefault();const sentence=oneSentence(textInput.value);if(!sentence){showError('Enter one sentence for Todd.');return;}
    let options;try{const {privateH100:_route,...limits}=budgetOptions({amount:amount.value,currency:currency.value,workers:workers.value,conversations:conversations.value});options=limits;}catch(error){showError(errorMessage(error));return;}
    save.disabled=true;clearError('advanced');try{await bridge.updateGoal(goal.id,{text:sentence,...options});details.open=false;await refresh();announce('Goal changes saved.');}catch(error){save.disabled=false;showError(errorMessage(error));}
  });details.append(form);details.addEventListener('toggle',()=>{if(!details.open&&details.isConnected)renderDetails();});card.append(details);
}
function providerState(id){return state.providers?.find(item=>item.id===id)||null;}
function eligibleProviders(){return state.providers?.filter(item=>supportedProviders.has(item.id)&&item.connected===true&&item.available===true)||[];}
function ordinaryInference(){return eligibleProviders()[0]||null;}
function renderGoalProvider(){
  const select=elements['goal-provider'],previous=select.value,eligible=eligibleProviders();
  select.replaceChildren();const empty=node('option','Choose a connected provider');empty.value='';select.append(empty);
  for(const provider of eligible){const option=node('option',provider.name||provider.id);option.value=provider.id;select.append(option);}
  select.value=eligible.some(provider=>provider.id===previous)?previous
    :eligible.some(provider=>provider.id===state.preferredProviderId)?state.preferredProviderId
    :eligible.length===1?eligible[0].id:'';
  select.disabled=elements['private-h100'].checked||eligible.length===0;
  elements['goal-provider-note'].textContent=elements['private-h100'].checked?'Private H100 is selected for this goal; no ordinary provider is sent.'
    :select.value?`${eligible.find(provider=>provider.id===select.value)?.name||select.value} is connected locally. Company readiness is checked separately.`
    :'Choose a connected provider. The goal can be saved while company readiness is checked.';
}
function companyStatus(goal){
  const execution=goal.execution;if(execution?.requested!=='company')return null;
  if(terminal.has(goal.status))return `Company goal ${goal.status}.`;
  if(execution.readiness==='blocked')return `Company waiting: ${typeof execution.reason==='string'&&execution.reason.trim()?execution.reason:'A required worker route is unavailable.'}`;
  if(execution.readiness==='working'){
    const counts=[];
    if(Number.isInteger(execution.verifiedWorkers)&&execution.verifiedWorkers>0)counts.push(`${execution.verifiedWorkers} completed worker run${execution.verifiedWorkers===1?'':'s'} verified`);
    if(Number.isInteger(execution.verifiedChildConversations)&&execution.verifiedChildConversations>0)counts.push(`${execution.verifiedChildConversations} completed child conversation${execution.verifiedChildConversations===1?'':'s'} verified`);
    return `Company is working.${counts.length?` ${counts.join(' · ')}.`:''}`;
  }
  if(execution.readiness==='ready')return 'Company is ready for admission. Worker count is not verified yet.';
  return 'Company readiness is being checked. Worker count is not verified yet.';
}
const quoteMaxAgeMs=48*60*60*1000;
function validSpendQuote(quote,currency){
  if(currency==='USD'||quote?.currency!==currency||quote?.quoteSource!=='https://www.exchangerate-api.com'||!Number.isFinite(quote.usdPerUnit)||quote.usdPerUnit<=0)return false;
  const dated=Date.parse(quote.quoteAsOf);
  return Number.isFinite(dated)&&dated<=Date.now()+5*60*1000&&Date.now()-dated<=quoteMaxAgeMs;
}
function renderSpend(){
  clearTimeout(quoteExpiryTimer);quoteExpiryTimer=null;
  const spend=elements['spend-details'];spend.replaceChildren();
  const amounts=['reportedUsd','estimatedUsd','pendingUsd'].map(field=>{
    const spendData=state.spend;
    if(spendData===undefined)return 0;
    if(!spendData||typeof spendData!=='object'||Array.isArray(spendData))return null;
    if(!Object.hasOwn(spendData,field))return 0;
    const value=spendData[field];return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
  });
  const usd=value=>value===null?'unavailable':`${value.toFixed(2)} USD`;
  spend.append(node('p',`${usd(amounts[0])} provider-reported · ${usd(amounts[1])} estimated · ${usd(amounts[2])} pending. These figures are not a bill.`));
  const currency=elements['budget-currency'].value;
  if(currency!=='USD'){
    if(validSpendQuote(budgetQuote,currency)&&amounts.every(value=>value!==null)){
      const digits=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
      const formatted=value=>`${new Intl.NumberFormat(undefined,{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(value/budgetQuote.usdPerUnit)} ${currency}`;
      const date=new Date(budgetQuote.quoteAsOf).toLocaleString();
      spend.append(node('p',`Estimated ${currency} equivalents: ${formatted(amounts[0])} of provider-reported USD · ${formatted(amounts[1])} of estimated USD · ${formatted(amounts[2])} of pending USD. FX quote ${date} (ExchangeRate-API); conversions are not billed amounts.`));
      const until=Date.parse(budgetQuote.quoteAsOf)+quoteMaxAgeMs-Date.now()+1;
      quoteExpiryTimer=setTimeout(renderSpend,Math.max(1,until));
    }else{
      const reason=validSpendQuote(budgetQuote,currency)?'the USD spend figures are unavailable':'a current dated quote is required';
      spend.append(node('p',`${currency} conversion unavailable: ${reason}. Available spend remains shown in USD.`));
    }
  }
  if(Number(state.spend?.unknownCalls)>0||Number(state.spend?.subscriptionCalls)>0)spend.append(node('p',`${Number(state.spend.unknownCalls||0)} calls without a price · ${Number(state.spend.subscriptionCalls||0)} subscription calls.`));
}
function renderProviderForm(){
  const id=elements['provider-choice'].value,item=providerState(id),native=id==='codex'||id==='claude',api=Object.hasOwn(providerModels,id),connected=item?.connected===true;
  if(id!==displayedProvider){
    displayedProvider=id;elements['provider-key'].value='';elements['provider-worker-consent'].checked=item?.fleetEligible===true;
    const model=elements['provider-model'];model.replaceChildren();for(const name of providerModels[id]||[]){const option=node('option',name);option.value=name;model.append(option);}
    const saved=item?.models?.[0];if(providerModels[id]?.includes(saved))model.value=saved;
  }
  elements['provider-model-row'].hidden=!api;elements['provider-key-row'].hidden=!api;elements['provider-storage-note'].hidden=!api;
  elements['provider-worker-row'].hidden=!api;elements['provider-key'].required=api&&!connected;
  const nativeMissing=native&&/CLI not installed/i.test(item?.detail||'');
  if(!id)elements['provider-guidance'].textContent='Choose a supported provider to connect inference.';
  else if(!authReady())elements['provider-guidance'].textContent='Finish Fly and Modal sign-in before connecting inference.';
  else if(nativeMissing)elements['provider-guidance'].textContent=`${item?.name||id} is not installed; choose an API provider.`;
  else if(native&&connected)elements['provider-guidance'].textContent=`${item?.name||id} is connected locally; remote five-by-five staffing remains unverified.`;
  else if(native)elements['provider-guidance'].textContent=`Connect ${item?.name||id} through its native account flow.`;
  else if(connected&&item?.fleetEligible)elements['provider-guidance'].textContent='This API key may be used by isolated Workers; remote capacity is verified at run time.';
  else if(connected)elements['provider-guidance'].textContent='This API key is connected locally; worker use needs your separate choice.';
  else elements['provider-guidance'].textContent='Enter an API key to connect this model.';
  elements['provider-connect'].textContent=providerBusy?'Connecting…':native?'Connect account':connected?'Update connection':'Connect API';
  elements['provider-connect'].disabled=providerBusy||!authReady()||!supportedProviders.has(id)||nativeMissing||(api&&!connected&&!elements['provider-key'].value.trim());
  elements['provider-disconnect'].hidden=!connected;elements['provider-disconnect'].disabled=providerBusy;
}
function renderDetails(){
  renderGoalProvider();
  const privateRoute=state.providers?.find(provider=>provider.id==='private-h100');
  elements['private-h100-status'].textContent=elements['private-h100'].checked
    ? privateRoute?.ready===true&&privateRoute?.connected===true&&privateRoute?.available===true
      ? 'At Go, this uses paid H100 resources and permits isolated Workers to use the newly owned bearer; execution is verified when work starts.'
      : 'At Go, this may create paid H100 resources and permit isolated Workers to use the newly owned bearer; this route is not verified yet.'
    :'Off. Enabling it at Go may create paid H100 resources and permit isolated Workers to use the newly owned bearer.';
  const providers=elements['provider-details'];providers.replaceChildren();
  const ready=state.providers?.filter(provider=>provider.available&&provider.connected&&(provider.id!=='private-h100'||elements['private-h100'].checked))||[];
  providers.append(node('p',ready.length?`${ready.map(provider=>provider.name||provider.id).join(', ')} connected locally. Company readiness is checked separately.`:'No inference provider is ready. A goal may remain queued.'));
  for(const provider of state.providers||[]){if(provider.id!=='modal'&&provider.id!=='private-h100'&&!provider.connected)continue;providers.append(node('p',`${provider.name||provider.id}: ${provider.detail||'Status unknown.'}`));}
  renderSpend();
  const host=elements['goal-details'];const editing=host.querySelector('.goal-editor[open]');
  if(!editing){host.replaceChildren();for(const goal of [...(state.goals||[])].reverse().slice(0,12)){
    const card=node('section',undefined,'goal-detail');card.append(node('strong',goal.text||'Goal'),node('small',`${goal.status||'queued'}${goal.privateH100===true?' · private H100 + Qwen requested':''} · ${budgetLine(goal)} · ${Number(goal.spentUsd||0).toFixed(2)} USD tracked${Number(goal.pendingUsd)>0?` · ${Number(goal.pendingUsd).toFixed(2)} USD pending`:''}`));
    const executionStatus=companyStatus(goal);if(executionStatus)card.append(node('p',executionStatus,'company-status'));
    if(goal.budget?.quoteSource==='https://www.exchangerate-api.com'&&goal.budget?.quoteAsOf){const source=node('small',`FX quote ${new Date(goal.budget.quoteAsOf).toLocaleString()} · Source: `);const link=node('a','ExchangeRate-API');link.href=goal.budget.quoteSource;link.target='_blank';link.rel='noopener noreferrer';source.append(link);card.append(source);}
    if(!terminal.has(goal.status))appendGoalEditor(card,goal);
    if(goal.error)card.append(node('p',goal.error));
    const tasks=Array.isArray(goal.tasks)?goal.tasks:[];
    if(tasks.length){const details=node('details');details.append(node('summary',`${tasks.length} work item${tasks.length===1?'':'s'}`));for(const task of tasks){const item=node('p',`${task.role||'Task'} · ${task.status||'queued'}${task.text?` — ${task.text}`:''}`);details.append(item);if(task.result){const result=node('details');result.append(node('summary','Result'),node('p',task.result));details.append(result);}}card.append(details);}
    host.append(card);
  }
  if(!state.goals?.length)host.append(node('p','No goals yet.'));}
  const active=state.goals?.some(goal=>['running','queued','pausing','stopping'].includes(goal.status));
  const paused=state.goals?.some(goal=>goal.status==='paused')||state.swarm?.admissionPaused;
  elements['pause-all'].hidden=!active||Boolean(state.swarm?.admissionPaused);
  elements['resume-all'].hidden=!paused;
  elements['stop-all'].hidden=!active&&!paused;
  renderProviderForm();
}
function applyState(next){
  if(!next||!Array.isArray(next.conversation)||!Array.isArray(next.goals))return;
  const first=knownMessages===null;if(first)knownMessages=new Set(next.conversation.map(message=>message.id));
  const newTodd=first?[]:next.conversation.filter(message=>{const fresh=!knownMessages.has(message.id);knownMessages.add(message.id);return fresh&&message.role==='todd'&&message.text;});
  state=next;renderDetails();renderAuth();updateScene();
  if(newTodd.length){announce('Todd responded.');if(!suppressTodd&&voice.speak&&mode!=='listening'){const epoch=speechEpoch;for(const message of newTodd.slice(-3))speechQueue=speechQueue.then(()=>epoch===speechEpoch?speakTodd(message.text):undefined).catch(error=>{if(!/Voice stopped|aborted|canceled/i.test(errorMessage(error)))showError(errorMessage(error));});}}
}
async function refresh(){const data=await bridge.state();applyState(data?.state||data);}
function normalizeAuth(raw){
  const source=raw?.accounts||raw?.auth||raw||{};
  return Object.fromEntries(['fly','modal'].map(id=>{const item=Array.isArray(source)?source.find(value=>value?.id===id):source[id];const detail=String(item?.detail||'Sign-in is unavailable.');return [id,{connected:item?.connected===true,available:item?.loginAvailable===true||item?.available===true,detail:/terminal helper/i.test(detail)?`${id==='fly'?'Fly':'Modal'} browser sign-in is unavailable in this build.`:detail}];}));
}
async function refreshAuth(){try{auth=normalizeAuth(await bridge.authState());}catch(error){auth=normalizeAuth({});showError(errorMessage(error),'setup');}renderAuth();return auth;}
function authReady(){return auth.fly.connected&&auth.modal.connected;}
function renderAuth(){for(const id of ['fly','modal']){const item=auth[id];$(`${id}-state`).textContent=item.connected?'Connected':item.detail;$(`${id}-connect`).disabled=item.connected||!item.available||authBusy;$(`${id}-connect`).textContent=item.connected?'Connected':'Connect';}
  const provider=ordinaryInference();
  elements['inference-state'].textContent=!authReady()?'Finish Fly and Modal sign-in first.'
    : elements['private-h100'].checked?'Private H100 is requested; inference is checked at Go.'
    : provider?`${provider.name||provider.id} is connected locally; company readiness is checked separately.`
    :'Connect a supported inference provider, or continue with a queued goal.';
  elements['setup-continue'].disabled=!authReady()||authBusy;
  elements['setup-continue'].textContent=authReady()&&!provider&&!elements['private-h100'].checked?'Continue with queued goal':'Continue';
  elements['provider-setup'].disabled=!authReady()||authBusy;
  renderProviderForm();
}
function showSetup(){setMode('setup');clearError('setup');renderAuth();if(!elements['setup-dialog'].open)elements['setup-dialog'].showModal();void refreshAuth();}
async function connectAccount(id){if(authBusy||!auth[id]?.available)return;authBusy=true;renderAuth();$(`${id}-state`).textContent='Opening browser sign-in…';clearError('setup');try{await bridge.authConnect({id});await refreshAuth();}catch(error){showError(errorMessage(error),'setup');await refreshAuth();}finally{authBusy=false;renderAuth();}}
async function refreshProviders(){if(providerWait)return providerWait;providerWait=(async()=>{try{await bridge.discover();await refresh();}catch(error){announce(errorMessage(error));}})().finally(()=>{providerWait=null;});return providerWait;}
async function connectProvider(){
  if(providerBusy||!authReady())return;
  const id=elements['provider-choice'].value;if(!supportedProviders.has(id))return;
  const native=id==='codex'||id==='claude';let payload;
  if(native)payload={id,method:'subscription'};
  else{
    const model=elements['provider-model'].value;if(!providerModels[id]?.includes(model)){showError('Choose a supported model.');return;}
    payload={id,method:'key',model,fleetAllowed:elements['provider-worker-consent'].checked};
    const key=elements['provider-key'].value.trim();if(key)payload.key=key;
    if(!key&&!providerState(id)?.connected){showError('Enter an API key.');return;}
  }
  providerBusy=true;renderProviderForm();clearError('advanced');
  try{await bridge.connect(payload);await refresh();announce(`${providerState(id)?.name||id} connection saved.`);
    if(providerSetupPending&&ordinaryInference()){providerSetupPending=false;elements['advanced-dialog'].close();void enterExperience();}
  }catch(error){showError(errorMessage(error));}
  finally{elements['provider-key'].value='';providerBusy=false;renderProviderForm();renderAuth();}
}
async function disconnectProvider(){const id=elements['provider-choice'].value;if(providerBusy||!providerState(id)?.connected)return;
  providerBusy=true;renderProviderForm();clearError('advanced');try{await bridge.disconnect(id);await refresh();announce(`${id} disconnected.`);}catch(error){showError(errorMessage(error));}finally{providerBusy=false;renderProviderForm();renderAuth();}
}

function fallbackAvailable(){return voice.transcribe!==true||!navigator.mediaDevices?.getUserMedia||!window.AudioWorkletNode;}
function openFallback(message){elements['text-fallback'].hidden=false;if(message)showError(message);else if(!elements['advanced-dialog'].open)elements['advanced-dialog'].showModal();elements['fallback-goal'].focus();}
async function enterExperience(){started=true;await refreshAuth();if(!authReady()||(!ordinaryInference()&&!elements['private-h100'].checked)){showSetup();return;}if(fallbackAvailable()){openFallback(voice.reason||'Voice capture is unavailable.');return;}beginListening();}
async function ensureVoiceReady(epoch){
  if(voice.ready===true)return true;
  if(voice.transcribe!==true)return false;
  if(voiceWait)return voiceWait;
  voiceWait=(async()=>{setMode('transcribing');announce('Preparing local speech recognition.');const until=Date.now()+180000;
    while(Date.now()<until){if(epoch!==inputEpoch)return false;await new Promise(resolve=>setTimeout(resolve,1200));if(epoch!==inputEpoch)return false;
      try{voice=await bridge.voiceCapabilities();}catch(error){voice={transcribe:false,speak:false,ready:false,reason:errorMessage(error)};}renderNarration();
      if(epoch!==inputEpoch)return false;
      if(voice.ready===true)return true;
      if(voice.transcribe!==true||voice.status==='unavailable')return false;
    }
    voice={...voice,transcribe:false,ready:false,reason:'Local speech recognition did not become ready.'};return false;
  })().finally(()=>{voiceWait=null;});
  return voiceWait;
}
async function beginListening(){if(goalSubmitting||mode==='listening'||voiceWait||capturePending)return;if(!authReady()){showSetup();return;}if(fallbackAvailable()){openFallback(voice.reason||'Voice capture is unavailable.');return;}
  const epoch=++inputEpoch;suppressTodd=false;
  moviePlayer.interrupt();
  capturePending=true;
  const ready=await ensureVoiceReady(epoch);if(epoch!==inputEpoch){capturePending=false;return;}
  if(!ready){capturePending=false;setMode('ready');openFallback(voice.reason||'Voice capture is unavailable.');return;}
  void stopTodd();setMode('preparing-listen');announce('Opening microphone.');
  capture.start().then(async audio=>{
    if(epoch!==inputEpoch)return;
    setMode('transcribing');announce('Understanding your goal.');
    const result=await bridge.transcribeAudio({...audio,language:navigator.language||'en-US'});
    if(epoch!==inputEpoch)return;
    const sentence=oneSentence(result?.text);
    if(!sentence){setMode('ready');openFallback('Please give Todd one sentence.');if(typeof result?.text==='string')elements['fallback-goal'].value=result.text.slice(0,4000);return;}
    pendingGoal=sentence;setMode('go');announce('Goal understood. Saving it for the company.');
    clearTimeout(goTimer);goTimer=setTimeout(()=>void submitGoal(),350);
  }).catch(error=>{if(epoch!==inputEpoch||errorMessage(error)==='Listening canceled.')return;setMode('ready');openFallback(errorMessage(error));}).finally(()=>{if(epoch===inputEpoch)capturePending=false;});
}
function goalOptions(){
  if(!elements['budget-amount'].value.trim())throw new Error('Enter a budget amount.');
  const options=budgetOptions({amount:elements['budget-amount'].value,currency:elements['budget-currency'].value,workers:elements.workers.value,conversations:elements.conversations.value,privateH100:elements['private-h100'].checked});
  options.executionMode='company';
  const providerId=elements['goal-provider'].value;
  if(!options.privateH100&&eligibleProviders().some(provider=>provider.id===providerId))options.providerId=providerId;
  return options;
}
async function submitGoal(){if(goalSubmitting||!pendingGoal)return;if(!authReady()){showSetup();return;}
  clearTimeout(goTimer);const text=pendingGoal,epoch=inputEpoch,requestedCurrency=elements['budget-currency'].value;
  goalSubmitting=true;elements['fallback-go'].disabled=true;setMode('submitting');
  try{
    if(currencySwitch)await currencySwitch;if(budgetWait)await budgetWait;
    if(epoch!==inputEpoch){setMode('go');return;}
    if(elements['budget-currency'].value!==requestedCurrency||(requestedCurrency!=='USD'&&!validSpendQuote(budgetQuote,requestedCurrency)))throw new Error('Currency allowance is unavailable. Review the budget and press Go again.');
    const options=goalOptions();
    if(epoch!==inputEpoch){setMode('go');return;}
    goalPostStarted=true;suppressTodd=false;
    await bridge.chat(text,options);
    if(pendingGoal===text)pendingGoal=null;
    if(elements['fallback-goal'].value.trim()===text)elements['fallback-goal'].value='';
    try{await refresh();elements['advanced-dialog'].close();}catch{showError('Goal was accepted, but its latest status could not load.');}
    announce('Todd saved your goal.');setMode('ready');
  }catch(error){setMode('go');if(goalPostStarted||epoch===inputEpoch)showError(errorMessage(error));}
  finally{goalPostStarted=false;goalSubmitting=false;elements['fallback-go'].disabled=false;}
}

function clearAudio(){const audio=elements['todd-audio'];audio.pause();audio.removeAttribute('src');audio.load();if(audioUrl){URL.revokeObjectURL(audioUrl);audioUrl=null;}audio.onplaying=audio.onended=audio.onerror=null;}
async function stopTodd(){speechEpoch++;activeSpeechFinish?.();activeSpeechFinish=null;clearAudio();if(mode==='speaking')setMode('ready');try{await bridge.stopSpeaking?.();}catch{}}
function speechChunks(text){const sentence=String(text).trim().match(/^.{1,1000}?[.!?。！？](?=\s|$)/s)?.[0]||String(text).trim().slice(0,900);return sentence?[sentence]:[];}
async function speakTodd(text){if(!voice.speak||!text)return;const epoch=speechEpoch;
  for(const chunk of speechChunks(text)){
    if(epoch!==speechEpoch)return;
    const result=await bridge.speak(chunk);if(epoch!==speechEpoch)return;
    if(result?.mimeType!=='audio/wav'||typeof result.dataBase64!=='string')throw new Error('Todd voice returned unsupported audio.');
    const raw=atob(result.dataBase64);if(raw.length<44||raw.length>10*1024*1024)throw new Error('Todd voice returned invalid audio.');
    const bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
    clearAudio();audioUrl=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));const audio=elements['todd-audio'];audio.src=audioUrl;
    await new Promise((resolve,reject)=>{activeSpeechFinish=resolve;audio.onplaying=()=>{if(epoch===speechEpoch){setMode('speaking');announce('Todd is speaking.');}};audio.onended=resolve;audio.onerror=()=>reject(new Error('Todd voice could not be played.'));void audio.play().catch(reject);});
    activeSpeechFinish=null;if(epoch===speechEpoch)clearAudio();
  }
  if(epoch===speechEpoch){setMode('ready');announce('Todd finished speaking.');}
}

async function controlTeam(action){
  const interrupt=action==='pause'||action==='stop';let movieEpoch,confirmed=false;
  if(interrupt){suppressTodd=true;inputEpoch++;clearTimeout(goTimer);capture.cancel();void stopTodd();if(!goalPostStarted)setMode(pendingGoal?'go':'ready');moviePlayer.interrupt();movieEpoch=moviePlayer.epoch;}
  try{await bridge.controlSwarm(action);await refresh();confirmed=true;if(action==='resume')suppressTodd=false;announce(`Team ${action} requested.`);}
  catch(error){showError(errorMessage(error));}
  finally{if(interrupt&&confirmed&&moviePlayer.epoch===movieEpoch)void moviePlayer.setScene(elements.movie.dataset.scene,{interrupt:true});}
}
function amountForUsd(usd,quote){const digits=new Intl.NumberFormat('en',{style:'currency',currency:quote.currency}).resolvedOptions().maximumFractionDigits;const scale=10**digits;return Math.max(1/scale,Math.round(usd/quote.usdPerUnit*scale)/scale);}
function markPreset(usd){for(const button of document.querySelectorAll('[data-budget-usd]'))button.setAttribute('aria-pressed',String(Number(button.dataset.budgetUsd)===usd));}
function budgetNote(quote,usd=selectedPreset??50){const amount=amountForUsd(usd,quote);elements['budget-note'].textContent=quote.currency==='USD'?`${usd} USD allowance selected.`:`${amount} ${quote.currency} ≈ ${usd} USD · rate ${new Date(quote.quoteAsOf).toLocaleDateString()}`;}
function loadBudget(currency,{convertCustom=false}={}){
  const generation=++budgetEpoch;
  const previous=budgetQuote,previousAmount=Number(elements['budget-amount'].value),wasCustom=budgetCustom;
  elements['budget-note'].textContent='Checking currency allowance…';renderSpend();
  const pending=(async()=>{try{
      const quote=await bridge.defaultBudget(currency);
      if(generation!==budgetEpoch)return;
      if(!quote||quote.currency!==currency||!Number.isFinite(quote.usdPerUnit)||quote.usdPerUnit<=0||(currency!=='USD'&&!validSpendQuote(quote,currency)))throw new Error('Currency allowance is unavailable.');
      budgetQuote=quote;elements['budget-currency'].value=currency;
      if(convertCustom&&wasCustom&&selectedPreset!==null){elements['budget-amount'].value=String(amountForUsd(selectedPreset,quote));budgetNote(quote);}
      else if(convertCustom&&wasCustom&&previous&&Number.isFinite(previousAmount)&&previousAmount>0){
        const digits=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
        elements['budget-amount'].value=String(Math.max(1/10**digits,Math.round(previousAmount*previous.usdPerUnit/quote.usdPerUnit*10**digits)/10**digits));
        budgetCustom=true;elements['budget-note'].textContent=`Converted your allowance using the ${new Date(quote.quoteAsOf||Date.now()).toLocaleDateString()} rate.`;
      }else if(!convertCustom&&budgetCustom){elements['budget-note'].textContent='Your chosen allowance will be checked before work starts.';}
      else{elements['budget-amount'].value=String(amountForUsd(50,quote));budgetCustom=false;selectedPreset=50;markPreset(50);budgetNote(quote,50);}renderSpend();
    }catch(error){if(generation!==budgetEpoch)return;if(previous&&convertCustom){elements['budget-currency'].value=previous.currency;budgetQuote=previous;showError(errorMessage(error));}
      else{elements['budget-currency'].value='USD';elements['budget-amount'].value='50.00';budgetQuote={amount:50,currency:'USD',allowanceUsd:50,usdPerUnit:1};budgetCustom=false;selectedPreset=50;markPreset(50);elements['budget-note'].textContent='50 USD allowance selected. Local currency is unavailable.';}renderSpend();
    }})();
  budgetWait=pending;void pending.finally(()=>{if(budgetWait===pending)budgetWait=null;});
  return budgetWait;
}
function chooseCurrency(){let region;try{region=new Intl.Locale(navigator.language||'en-US').region;}catch{region='US';}const byRegion={CO:'COP',US:'USD',GB:'GBP',CA:'CAD',AU:'AUD',DE:'EUR',FR:'EUR',ES:'EUR',IT:'EUR'};const choice=byRegion[region]||'USD';elements['budget-currency'].value=allowedCurrencies.has(choice)?choice:'USD';return loadBudget(elements['budget-currency'].value);}

elements.action.addEventListener('click',()=>{const action=elements.action.dataset.action;if(action==='start')void enterExperience();else if(action==='listen')beginListening();else if(action==='stop-listening')capture.stop();else if(action==='go')void submitGoal();else if(action==='stop-speaking')void stopTodd();});
elements['advanced-toggle'].addEventListener('click',()=>{renderDetails();clearError('advanced');if(!elements['advanced-dialog'].open)elements['advanced-dialog'].showModal();void refreshVoiceCapabilities();});
for(const button of document.querySelectorAll('[data-close]'))button.addEventListener('click',()=>$(button.dataset.close).close());
elements['setup-dialog'].addEventListener('close',()=>{if(authBusy)void bridge.authCancel?.();if(mode==='setup')setMode('ready');});
elements['advanced-dialog'].addEventListener('close',()=>{providerSetupPending=false;});
elements['setup-continue'].addEventListener('click',()=>{if(!authReady())return;elements['setup-dialog'].close();if(pendingGoal)void submitGoal();else if(fallbackAvailable())openFallback(voice.reason||'Voice capture is unavailable.');else beginListening();});
elements['provider-setup'].addEventListener('click',()=>{if(!authReady())return;providerSetupPending=true;elements['setup-dialog'].close();renderDetails();if(!elements['advanced-dialog'].open)elements['advanced-dialog'].showModal();elements['provider-connect-details'].open=true;elements['provider-choice'].focus();void refreshProviders();});
for(const id of ['fly','modal'])$(`${id}-connect`).addEventListener('click',()=>void connectAccount(id));
elements['provider-choice'].addEventListener('change',renderProviderForm);
elements['goal-provider'].addEventListener('change',renderGoalProvider);
elements['provider-key'].addEventListener('input',renderProviderForm);
elements['provider-worker-consent'].addEventListener('change',renderProviderForm);
elements['provider-connect'].addEventListener('click',()=>void connectProvider());
elements['provider-disconnect'].addEventListener('click',()=>void disconnectProvider());
elements['fallback-go'].addEventListener('click',()=>{if(goalSubmitting)return;const sentence=oneSentence(elements['fallback-goal'].value);if(!sentence){showError('Enter one sentence for Todd.');return;}pendingGoal=sentence;void submitGoal();});
for(const id of ['workers','conversations'])elements[id].addEventListener('input',()=>{$(`${id}-value`).value=elements[id].value;$(`${id}-value`).textContent=elements[id].value;});
elements['private-h100'].addEventListener('change',()=>{renderDetails();renderAuth();});
elements['budget-amount'].addEventListener('input',()=>{budgetCustom=true;selectedPreset=null;markPreset(null);elements['budget-note'].textContent='Your chosen allowance will be checked before work starts.';});
for(const button of document.querySelectorAll('[data-budget-usd]'))button.addEventListener('click',()=>{const usd=Number(button.dataset.budgetUsd);void (async()=>{if(currencySwitch)await currencySwitch;if(budgetWait)await budgetWait;if(!budgetQuote){showError('Currency allowance is unavailable.');return;}selectedPreset=usd;budgetCustom=true;elements['budget-amount'].value=String(amountForUsd(usd,budgetQuote));markPreset(usd);budgetNote(budgetQuote,usd);})();});
elements['budget-currency'].addEventListener('change',()=>{const selected=elements['budget-currency'].value;const prior=budgetWait;const switchJob=(async()=>{if(prior)await prior;await loadBudget(selected,{convertCustom:true});})();currencySwitch=switchJob;void switchJob.finally(()=>{if(currencySwitch===switchJob)currencySwitch=null;});});
for(const action of ['pause','resume','stop'])$(`${action}-all`).addEventListener('click',()=>void controlTeam(action));
window.addEventListener('beforeunload',()=>{capture.cancel();moviePlayer.destroy();clearAudio();clearTimeout(goTimer);clearTimeout(quoteExpiryTimer);});
bridge.onEvent(event=>{if(event?.type==='state')applyState(event.state);else if(!refreshTimer)refreshTimer=setTimeout(()=>{refreshTimer=null;void refresh().catch(()=>{});},150);});
void moviePlayer.load();void chooseCurrency();setMode('ready');
void (async()=>{try{await refresh();}catch(error){announce(errorMessage(error));}
  await refreshVoiceCapabilities();
  await refreshAuth();void refreshProviders();setMode('ready');})();

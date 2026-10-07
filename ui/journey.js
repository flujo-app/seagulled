import {MoviePlayer} from './movie-player.mjs';
import {LoadingScreen} from './loading-screen.mjs';
import movieManifest from './movie-manifest.json' with {type:'json'};
const $=id=>document.getElementById(id),presets=[25,50,100,500,null],ids=['modal','claude','codex'];
let state={goals:[],providers:[],conversation:[],spend:{}},accounts={},selected=new Set(),busy=new Set();
let step=1,setupEpoch=0,cueEpoch=0,editId=null,planEpoch=0,formBusy=false,page=0,booted=false,autoWorkers=true,manualMemory=false,authChecking=false;
function browserBridge(){
  const hash=new URLSearchParams(location.hash.slice(1)),fresh=hash.get('token');
  if(fresh){sessionStorage.setItem('seagulled-bootstrap',fresh);history.replaceState(null,'',location.pathname+location.search);}
  const token=sessionStorage.getItem('seagulled-bootstrap');
  async function request(path,method='GET',body){
    const response=await fetch(path,{method,headers:{Authorization:`Bearer ${token||''}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});
    const data=await response.json();if(!response.ok)throw new Error(data?.error||'Request failed.');return data;
  }
  const goalPath=id=>`/api/goals/${encodeURIComponent(id)}`;
  return {state:()=>request('/api/state'),discover:()=>request('/api/providers/discover','POST',{}),
    closeApp:()=>window.close(),
    authState:()=>request('/api/auth/state'),authConnect:body=>request('/api/auth/connect','POST',body),authCancel:()=>request('/api/auth/cancel','POST',{}),
    connect:body=>request('/api/providers/connect','POST',body),disconnect:id=>request(`/api/providers/${encodeURIComponent(id)}`,'DELETE'),
    planSwarm:body=>request('/api/budget/plan','POST',body),chat:(text,options)=>request('/api/chat','POST',{text,...options}),
    updateGoal:(id,body)=>request(goalPath(id),'PATCH',body),controlGoal:(id,action)=>request(`${goalPath(id)}/${action}`,'POST',{}),deleteGoal:id=>request(goalPath(id),'DELETE'),
    completeSetup:body=>request('/api/setup','POST',body),
    onEvent:callback=>{let closed=false;const controller=new AbortController();void(async()=>{while(!closed){try{
      const response=await fetch('/api/events',{headers:{Authorization:`Bearer ${token||''}`},signal:controller.signal,cache:'no-store'});
      if(!response.ok||!response.body)throw new Error();
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
      while(!closed){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true}).replace(/\r/g,'');let cut;
        while((cut=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,cut);buffer=buffer.slice(cut+2);try{const data=block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');if(data)callback(JSON.parse(data));}catch{}}}
    }catch{if(!closed)announce('Live connection interrupted.');}if(!closed)await new Promise(resolve=>setTimeout(resolve,2000));}})();return()=>{closed=true;controller.abort();};}
  };
}
const bridge=window.seagulled||browserBridge();
const loading=new LoadingScreen({stage:$('movie'),video:$('loading-video')});
function openDialog(dialog){if(!dialog.open){loading.pulse();dialog.showModal();}syncWindowControls();}
function syncWindowControls(){const controls=$('app-window-controls'),host=[$('setup-dialog'),$('project-dialog')].find(dialog=>dialog.open)||$('movie');if(controls.matches(':popover-open'))controls.hidePopover();if(controls.parentElement!==host)host.append(controls);controls.showPopover();}
$('app-close').addEventListener('click',()=>{void bridge.closeApp();});for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('close',()=>{loading.pulse();syncWindowControls();});syncWindowControls();
const movie=new MoviePlayer({video:$('movie-video'),stage:$('movie'),manifest:movieManifest,onStatus:({status,detail})=>{if(status==='failed'||status==='missing')announce(detail||'Todd footage unavailable.');}});
void movie.load();
function announce(text){$('live-status').textContent=text;}
function error(id,reason){const element=$(id);element.textContent=reason?.message||String(reason);element.hidden=false;announce(element.textContent);}
function clearError(id){$(id).hidden=true;$(id).textContent='';}
function node(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
function provider(id){return state.providers?.find(item=>item.id===id);}
function connected(id){return id==='modal'?accounts.modal?.connected===true:provider(id)?.connected===true&&provider(id)?.available===true;}
function authenticated(id){return id==='modal'?accounts.modal?.connected===true:provider(id)?.available===true;}
async function refresh(){state=await bridge.state();render();return state;}
async function refreshAccounts(){await loading.during(async()=>{accounts=await bridge.authState();renderSetup();});}
async function checkAccounts(){await loading.during(async()=>{const results=await Promise.allSettled([bridge.discover(),bridge.authState()]);const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;state.providers=results[0].value;accounts=results[1].value;});}
let finishCue=()=>{};
function playCue(id,{audible=true}={}){
  finishCue();const epoch=++cueEpoch,video=$('cue-video');video.pause();video.src=`journey-media/${id}.mp4`;video.currentTime=0;video.muted=!audible;video.load();$('cue-replay').hidden=true;
  video.hidden=false;let resolveCue;const completed=new Promise(resolve=>{resolveCue=resolve;});const finish=()=>{if(epoch===cueEpoch)$('cue-replay').hidden=true;resolveCue();};finishCue=finish;
  const done=()=>{if(epoch===cueEpoch)finish();};video.onended=done;video.onerror=()=>{if(epoch===cueEpoch){announce('Dialogue clip unavailable.');finish();}};
  const timeout=setTimeout(finish,10000);
  void video.play().catch(()=>{if(epoch===cueEpoch){video.muted=true;void video.play().catch(done);$('cue-replay').hidden=!audible;}});
  return completed.finally(()=>clearTimeout(timeout));
}
$('cue-replay').addEventListener('click',()=>{const video=$('cue-video');video.muted=false;void video.play().then(()=>{$('cue-replay').hidden=true;}).catch(()=>{});});
function renderSetup(){
  $('setup-checking').hidden=!authChecking;$('provider-step').hidden=step!==1||authChecking;$('fly-step').hidden=step!==2||authChecking;
  [...document.querySelectorAll('.dots i')].forEach((dot,index)=>dot.classList.toggle('selected',index===step-1));
  for(const button of document.querySelectorAll('[data-provider]')){const id=button.dataset.provider;button.setAttribute('aria-pressed',String(selected.has(id)));button.dataset.connected=String(authenticated(id));button.dataset.busy=String(busy.has(id));button.disabled=authChecking||busy.size>0||!authenticated(id);}
  for(const button of document.querySelectorAll('[data-signin]')){button.hidden=authenticated(button.dataset.signin);button.disabled=authChecking||busy.size>0;}
  $('setup-confirm').disabled=authChecking||busy.size>0||selected.size===0||[...selected].some(id=>!authenticated(id));$('fly-connect').disabled=authChecking||busy.size>0;$('setup-back').disabled=busy.size>0;
}
async function showSetup({checked=false}={}){const epoch=++setupEpoch;step=1;clearError('setup-error');authChecking=!checked;renderSetup();openDialog($('setup-dialog'));
  try{if(!checked)await checkAccounts();if(epoch!==setupEpoch)return;selected=new Set((state.setup?.providers??ids.filter(connected)).filter(authenticated));}
  catch(reason){if(epoch===setupEpoch)error('setup-error',reason);}
  finally{if(epoch===setupEpoch){authChecking=false;renderSetup();void playCue('intro');}}
}
function closeSetup(){setupEpoch++;finishCue();cueEpoch++;$('cue-video').pause();$('cue-video').hidden=true;$('setup-dialog').close();authChecking=false;void bridge.authCancel();$('new-swarm').hidden=false;}
$('setup-close').addEventListener('click',closeSetup);$('setup-dialog').addEventListener('cancel',event=>{event.preventDefault();closeSetup();});
for(const button of document.querySelectorAll('[data-provider]'))button.addEventListener('click',()=>{
  const id=button.dataset.provider;if(authChecking||busy.size||!authenticated(id))return;clearError('setup-error');
  const removing=selected.has(id);if(removing)selected.delete(id);else selected.add(id);renderSetup();void playCue(removing?'removed':'selected');
});
for(const button of document.querySelectorAll('[data-signin]'))button.addEventListener('click',async()=>{
  const id=button.dataset.signin,epoch=setupEpoch;if(authChecking||busy.size)return;busy.add(id);renderSetup();clearError('setup-error');
  try{await loading.during(async()=>{if(id==='modal')await bridge.authConnect({id});else await bridge.connect({id,method:'subscription'});if(epoch!==setupEpoch)return;await checkAccounts();});}
  catch(reason){if(epoch===setupEpoch)error('setup-error',reason);}finally{busy.delete(id);if(epoch===setupEpoch)renderSetup();}
});
$('setup-confirm').addEventListener('click',async()=>{
  if($('setup-confirm').disabled)return;const epoch=setupEpoch;busy.add('confirm');renderSetup();
  try{const cue=playCue(selected.has('modal')?'confirmed-alternate':'confirmed');for(const id of selected){if(id!=='modal'&&!connected(id))await loading.during(()=>bridge.connect({id,method:'subscription'}));if(epoch!==setupEpoch)return;}await cue;
    if(epoch!==setupEpoch||!$('setup-dialog').open)return;step=2;void playCue('intro',{audible:false});
  }catch(reason){if(epoch===setupEpoch)error('setup-error',reason);}finally{busy.delete('confirm');if(epoch===setupEpoch)renderSetup();}
});
$('setup-back').addEventListener('click',()=>{step=1;renderSetup();void playCue('intro',{audible:false});});
$('fly-connect').addEventListener('click',async()=>{
  if(busy.size)return;const epoch=setupEpoch;busy.add('fly');renderSetup();clearError('setup-error');
  try{if(!accounts.fly?.connected){await loading.during(async()=>{await bridge.authConnect({id:'fly'});await refreshAccounts();});}if(epoch!==setupEpoch)return;if(!accounts.fly?.connected)throw new Error('Fly sign-in could not be verified.');
    await bridge.completeSetup({providers:[...selected]});await refresh();await playCue('fly-complete');if(epoch!==setupEpoch)return;closeSetup();
  }catch(reason){if(epoch===setupEpoch)error('setup-error',reason);}finally{busy.delete('fly');renderSetup();}
});
function formOptions(){const budgetUsd=presets[Number($('budget-slider').value)],id=$('goal-provider').value;
  return {budgetUsd:budgetUsd??null,unlimited:budgetUsd===null,maxWorkers:Number($('workers').value),conversationsPerWorker:Number($('agents').value),memoryMb:Number($('memory').value),...(id==='modal'?{privateH100:true}:{providerId:id,privateH100:false})};}
async function updatePlan(){
  const epoch=++planEpoch,options=formOptions();$('project-save').disabled=true;$('budget-value').textContent=options.unlimited?'∞':`$${options.budgetUsd}`;$('budget-slider').setAttribute('aria-valuetext',options.unlimited?'Unlimited':`$${options.budgetUsd}`);
  $('workers-value').textContent=options.maxWorkers;$('agents-value').textContent=options.conversationsPerWorker;
  if(!manualMemory)$('memory').value=String(options.conversationsPerWorker<=2?1024:options.conversationsPerWorker<=5?2048:4096);$('memory-value').textContent=`${Number($('memory').value)/1024} GB`;
  try{const plan=await bridge.planSwarm({budgetUsd:options.budgetUsd??50,unlimited:options.unlimited,workers:autoWorkers?undefined:options.maxWorkers,agents:options.conversationsPerWorker,memoryMb:Number($('memory').value)});
    if(epoch!==planEpoch)return false;
    const workerLimit=Math.max(1,Math.min(100,plan.affordableWorkers));$('workers').max=String(workerLimit);
    const workers=autoWorkers?Math.min(plan.workers,workerLimit):Math.min(options.maxWorkers,workerLimit);
    $('workers').value=String(workers);$('workers-value').textContent=workers;
    $('compute-price').textContent=`~$${(workers*plan.estimate.workerHourlyUsd).toFixed(3)}/h compute`;$('compute-price').title='Estimated running Fly compute in iad over 24 hours. Inference, storage and egress are additional.';
    return true;
  }catch(reason){if(epoch===planEpoch){$('compute-price').textContent='Price unavailable';error('project-error',reason);}return false;}
  finally{if(epoch===planEpoch)$('project-save').disabled=formBusy;}
}
function showProject(goal=null){
  editId=goal?.id??null;autoWorkers=!goal;manualMemory=Boolean(goal?.memoryOverride);$('project-title').textContent=goal?'Swarm settings':'New swarm';$('goal').value=goal?.text??'';
  $('budget-slider').value=String(goal?.unlimited?4:Math.max(0,presets.indexOf(goal?.budgetUsd??50)));$('workers').value=String(goal?.maxWorkers??10);$('agents').value=String(goal?.conversationsPerWorker??10);
  $('memory').value=String(goal?.memoryMb??4096);$('memory-edit-row').hidden=!goal;const currentProvider=goal?.privateH100?'modal':goal?.providerId;
  for(const option of $('goal-provider').options)option.disabled=Boolean(state.setup?.providers)&&!state.setup.providers.includes(option.value)&&option.value!==currentProvider;
  $('goal-provider').value=currentProvider??state.setup?.providers?.[0]??'modal';
  clearError('project-error');void updatePlan();openDialog($('project-dialog'));$('goal').focus();
}
for(const id of ['budget-slider','agents'])$(id).addEventListener('input',()=>{if(id==='agents')manualMemory=false;void updatePlan();});$('workers').addEventListener('input',()=>{autoWorkers=false;void updatePlan();});$('memory').addEventListener('change',()=>{manualMemory=true;void updatePlan();});
$('new-swarm').addEventListener('click',()=>{if(!state.setup?.completedAt)showSetup();else showProject();});$('manage-accounts').addEventListener('click',()=>{$('project-dialog').close();showSetup();});
for(const button of document.querySelectorAll('[data-close]'))button.addEventListener('click',()=>$(button.dataset.close).close());
$('project-form').addEventListener('submit',async event=>{
  event.preventDefault();if(formBusy||!$('goal').value.trim())return;formBusy=true;$('project-save').disabled=true;clearError('project-error');
  try{if(!await updatePlan())return;const options=formOptions();options.memoryOverride=manualMemory;if(editId)await bridge.updateGoal(editId,{text:$('goal').value.trim(),...options});else await bridge.chat($('goal').value.trim(),options);$('project-dialog').close();await refresh();}
  catch(reason){error('project-error',reason);}finally{formBusy=false;$('project-save').disabled=false;}
});
function renderBrain(goal){
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 240 250');svg.setAttribute('class','observatory');svg.setAttribute('role','img');const tasks=goal.tasks||[];
  const workers=(goal.workerActivity?.workers||[]).slice(0,200);
  if(workers.length){
    const current=goal.workerActivity.current===true&&['running','pausing'].includes(goal.status);
    const inFlight=workers.filter(worker=>current&&worker.status==='dispatching').length;
    svg.setAttribute('aria-label',`${inFlight} worker requests in flight, ${workers.length} observed workers${current?'':', historical activity'}`);
    const points=new Map(workers.map((worker,index)=>{const a=index*2.39996,r=workers.length===1?0:16+Math.sqrt(index/workers.length)*90;return [worker.id,[120+Math.cos(a)*r,125+Math.sin(a)*r]];}));
    for(const worker of workers){const [x,y]=points.get(worker.id),parent=points.get(worker.parentId);
      if(parent){const line=document.createElementNS(svg.namespaceURI,'line');for(const [key,value] of Object.entries({x1:x,y1:y,x2:parent[0],y2:parent[1]}))line.setAttribute(key,value);svg.append(line);}
      const circle=document.createElementNS(svg.namespaceURI,'circle');circle.setAttribute('cx',x);circle.setAttribute('cy',y);circle.setAttribute('r',workers.length>60?2.5:4);circle.setAttribute('data-worker',worker.id);circle.setAttribute('data-status',worker.status);
      circle.setAttribute('class',`worker-node${current&&worker.status==='dispatching'?' active':''}`);const title=document.createElementNS(svg.namespaceURI,'title');title.textContent=`Worker ${worker.status}`;circle.append(title);svg.append(circle);
    }return svg;
  }
  const taskActive=task=>['running','pausing'].includes(goal.status)&&task?.status==='running';
  svg.setAttribute('aria-label',`${tasks.filter(taskActive).length} running tasks, ${tasks.length} recorded tasks`);
  const count=Math.min(36,Math.max(12,tasks.length)),points=Array.from({length:count},(_,i)=>{const a=i*2.39996,r=24+Math.sqrt(i/count)*86;return [120+Math.cos(a)*r,125+Math.sin(a)*r*.9];});
  points.forEach(([x,y],i)=>{if(i){const line=document.createElementNS(svg.namespaceURI,'line'),parent=points[Math.floor((i-1)/2)];for(const [key,value] of Object.entries({x1:x,y1:y,x2:parent[0],y2:parent[1]}))line.setAttribute(key,value);svg.append(line);}
    const circle=document.createElementNS(svg.namespaceURI,'circle');circle.setAttribute('cx',x);circle.setAttribute('cy',y);circle.setAttribute('r',tasks[i]?4:2);if(taskActive(tasks[i]))circle.setAttribute('class','active');svg.append(circle);});return svg;
}
function render(){
  if(!booted)return;const goals=(state.goals||[]).filter(goal=>!goal.deletedAt),pages=Math.ceil(goals.length/3);page=Math.min(page,Math.max(0,pages-1));const host=$('swarm-cards');host.replaceChildren();
  for(const goal of goals.slice(page*3,page*3+3)){
    const card=node('article',undefined,'swarm-card');card.dataset.goal=goal.id;card.dataset.status=goal.status;card.append(node('h2',goal.text));
    const status=node('div',undefined,'status');status.append(node('i'),node('span',goal.execution?.readiness==='blocked'&&goal.status==='queued'?'Waiting':goal.status));card.append(status,renderBrain(goal));
    card.append(node('div',`$${Number(goal.spentUsd||0).toFixed(2)} / ${goal.unlimited?'∞':`$${goal.budgetUsd}`} estimated + reported`,'card-spend'));
    if(goal.error||goal.execution?.readiness==='blocked')card.append(node('p',goal.error||goal.execution.reason||'Waiting for readiness.','card-error'));
    if(goal.result){const detail=node('details',undefined,'card-detail');detail.append(node('summary','Result'),node('p',goal.result));card.append(detail);}
    const actions=node('div',undefined,'card-actions');
    for(const [action,label,symbol] of [['pause',goal.status==='paused'?'Resume swarm':'Pause swarm',goal.status==='paused'?'▶':'Ⅱ'],['edit','Swarm settings','⋯'],['delete','Delete swarm','×']]){
      const button=node('button',symbol,'icon');button.type='button';button.setAttribute('aria-label',label);if(action==='pause'&&['completed','stopped','failed','interrupted'].includes(goal.status))button.disabled=true;
      button.addEventListener('click',async()=>{if(action==='edit'){showProject(goal);return;}button.disabled=true;try{if(action==='delete')await bridge.deleteGoal(goal.id);else await bridge.controlGoal(goal.id,goal.status==='paused'?'resume':'pause');await refresh();}catch(reason){button.disabled=false;const box=card.querySelector('.card-error')||node('p',undefined,'card-error');box.textContent=reason.message;card.insertBefore(box,actions);announce(reason.message);}});actions.append(button);
    }card.append(actions);host.append(card);
  }
  if(pages>1){const controls=node('nav',undefined,'pages');controls.setAttribute('aria-label','Swarm pages');for(const [symbol,label,delta] of [['←','Previous swarms',-1],['→','Next swarms',1]]){const button=node('button',symbol,'icon');button.setAttribute('aria-label',label);button.disabled=page+delta<0||page+delta>=pages;button.addEventListener('click',()=>{page+=delta;render();});controls.append(button);}controls.append(node('output',`${page+1} / ${pages}`));host.append(controls);}renderSetup();
}
const unsubscribe=bridge.onEvent(event=>{if(event?.type==='state'&&event.state){state=event.state;render();}});
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key===','){event.preventDefault();showSetup();}});window.addEventListener('beforeunload',()=>{unsubscribe?.();loading.destroy();movie.destroy();});
void(async()=>{try{await checkAccounts();await refresh();booted=true;render();if(state.setup?.completedAt)$('new-swarm').hidden=false;else void showSetup({checked:true});}catch(reason){booted=true;$('new-swarm').hidden=false;void showSetup({checked:true});error('setup-error',reason);}finally{loading.ready();}})();

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const dom = Object.fromEntries(['goals','goal-count','conversation','prompt','composer','send','notice','presence','spend-label','provider-label','provider-light','provider-dialog','provider-list','provider-error','connect-panel','connect-title','connect-detail','connect-form','connect-method','connect-key','connect-model','key-field','model-field','connect-submit','edit-dialog','edit-form','goal-text','goal-budget'].map(id => [id, $(id)]));
  let state = {version:1, conversation:[], goals:[], providers:[], spend:{usd:0,unknownCalls:0,subscriptionCalls:0}, swarm:{status:'idle'}};
  let selectedGoalId = null;
  let selectedProvider = null;
  let connecting = false;
  let sending = false;
  let eventTimer = null;
  const money = value => `$${Number(value || 0).toFixed(2)}`;
  const terminal = new Set(['completed','done','stopped','failed','error','cancelled','interrupted']);

  function browserBridge() {
    const hash = new URLSearchParams(location.hash.slice(1));
    const tokenFromUrl = hash.get('token');
    if (tokenFromUrl) {
      sessionStorage.setItem('seagulled-bootstrap', tokenFromUrl);
      history.replaceState(null, '', location.pathname + location.search);
    }
    const token = sessionStorage.getItem('seagulled-bootstrap');
    async function request(path, method = 'GET', body) {
      const headers = {'Authorization': `Bearer ${token || ''}`};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(path, {method,headers,body:body === undefined ? undefined : JSON.stringify(body),cache:'no-store'});
      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
      if (!response.ok) throw new Error(data?.error || data?.message || `Request failed (${response.status})`);
      return data;
    }
    let notify = () => {};
    async function listen() {
      while (true) {
        try {
          const response = await fetch('/api/events', {headers:{Authorization:`Bearer ${token || ''}`},cache:'no-store'});
          if (!response.ok || !response.body) throw new Error(`Live updates unavailable (${response.status})`);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const {value,done} = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, {stream:true});
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) !== -1) {
              const block = buffer.slice(0,boundary).replace(/\r/g,'');
              buffer = buffer.slice(boundary + 2);
              const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
              if (data) { try { notify(JSON.parse(data)); } catch { /* Ignore malformed event. */ } }
            }
          }
        } catch (error) { showNotice(error.message); }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    return {
      state: () => request('/api/state'),
      chat: (text,options={}) => request('/api/chat','POST',{text,...options}),
      updateGoal: (id,patch) => request(`/api/goals/${encodeURIComponent(id)}`,'PATCH',patch),
      controlGoal: (id,action) => request(`/api/goals/${encodeURIComponent(id)}/${encodeURIComponent(action)}`,'POST',{}),
      controlSwarm: action => request(`/api/swarm/${encodeURIComponent(action)}`,'POST',{}),
      readArtifact: (goalId,taskId,index) => request(`/api/goals/${encodeURIComponent(goalId)}/artifacts/${encodeURIComponent(taskId)}/${index}`),
      discover: () => request('/api/providers/discover','POST',{}),
      connect: payload => request('/api/providers/connect','POST',payload),
      disconnect: id => request(`/api/providers/${encodeURIComponent(id)}`,'DELETE'),
      onEvent: callback => { notify = callback; listen(); return () => { notify = () => {}; }; }
    };
  }
  const bridge = window.seagulled || browserBridge();

  function showNotice(message) { dom.notice.textContent = message; dom.notice.hidden = false; }
  function clearNotice() { dom.notice.hidden = true; dom.notice.textContent = ''; }
  function errorText(error) { return error?.message || String(error || 'Something went wrong.'); }
  function node(tag, className, text) { const el=document.createElement(tag); if(className) el.className=className; if(text !== undefined) el.textContent=text; return el; }
  function formattedTime(at) { const date=new Date(at); return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}); }
  function budgetText(goal) { return Number(goal.pendingUsd)>0 ? `${money(goal.spentUsd)} tracked · ${money(goal.pendingUsd)} pending / ${money(goal.budgetUsd)} cap` : `${money(goal.spentUsd)} used of ${money(goal.budgetUsd)}`; }

  function renderConversation() {
    const pane = dom.conversation;
    const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 140;
    pane.replaceChildren();
    const messages=state.conversation.filter(item=>item.role!=='team' && item.role!=='system' && item.role!=='status');
    if (!messages.length) {
      const intro=node('section','intro');
      intro.append(node('div','intro-kicker','A BUSY MAN WITH A PLAN'));
      const heading=node('h1','', 'Tell me what you want done.');
      const copy=node('p','', 'I’ll find the right people, keep an eye on the work, and drop back in when there’s something worth seeing.');
      intro.append(heading,copy);
      const suggestions=node('div','suggestions');
      for (const value of ['Plan my next project','Research an idea','Build a small app']) {
        const button=node('button','',value); button.type='button'; button.addEventListener('click',()=>{dom.prompt.value=value; dom.prompt.focus(); resizePrompt();}); suggestions.append(button);
      }
      intro.append(suggestions); pane.append(intro);
      return;
    }
    for (const item of messages) {
      const isUser=item.role==='user';
      const row=node('div',`message ${isUser?'user':'assistant'}`);
      if (!isUser) row.append(node('div','message-avatar','TH'));
      const bubble=node('div','message-bubble');
      bubble.append(document.createTextNode(item.text || ''));
      const at=formattedTime(item.at); if(at) bubble.append(node('span','message-meta',at));
      row.append(bubble); pane.append(row);
    }
    if (nearBottom) pane.scrollTop=pane.scrollHeight;
  }

  function renderGoals() {
    const openDetails=new Set([...dom.goals.querySelectorAll('.goal-details[open]')].map(element=>element.dataset.goalId));
    const openResults=new Set([...dom.goals.querySelectorAll('.task-result[open]')].map(element=>element.dataset.taskId));
    dom.goals.replaceChildren();
    dom['goal-count'].textContent=String(state.goals.length);
    if (!state.goals.length) { dom.goals.append(node('p','empty-goals','Your goals will appear here after you ask Todd to get started.')); return; }
    for (const goal of [...state.goals].reverse()) {
      const card=node('article',`goal-card ${goal.status==='running'?'active':''}`);
      const top=node('div','goal-top'); top.append(node('p','goal-title',goal.text || 'Untitled goal'),node('span',`goal-status ${goal.status || ''}`,goal.status || 'queued')); card.append(top);
      if(goal.status==='pausing')card.append(node('p','goal-helper','Finishing the current task before pausing.'));
      const meta=node('div','goal-meta'); meta.append(node('span','',budgetText(goal)),node('span','',goal.providerId || 'Waiting for provider')); card.append(meta);
      const bar=node('div','budget-bar'); const pending=Number(goal.pendingUsd)||0;const fill=node('div',`budget-fill ${pending>0?'pending':''} ${Number(goal.spentUsd)+pending>=Number(goal.budgetUsd)?'limit':''}`); fill.style.width=`${Math.min(100,Math.max(0,((Number(goal.spentUsd)||0)+pending)/(Number(goal.budgetUsd)||1)*100))}%`;bar.append(fill);card.append(bar);
      const actions=node('div','goal-actions');
      const edit=actionButton('Edit',()=>openEdit(goal)); actions.append(edit);
      if (goal.status==='paused') actions.append(actionButton('Resume',()=>control(goal.id,'resume')));
      else if (!terminal.has(goal.status)) actions.append(actionButton('Pause',()=>control(goal.id,'pause')));
      if (!terminal.has(goal.status)) actions.append(actionButton('Stop',()=>control(goal.id,'stop')));
      card.append(actions);
      const tasks=Array.isArray(goal.tasks)?goal.tasks:[];
      if (tasks.length || goal.error) {
        const details=node('details','goal-details');details.dataset.goalId=goal.id;details.open=openDetails.has(goal.id);
        const summary=node('summary','',`Work details${tasks.length?` · ${tasks.length}`:''}`); details.append(summary);
        if(goal.error) details.append(node('p','field-help',goal.error));
        const list=node('ul','task-list'); for(const task of tasks){
          const li=node('li','');li.append(node('span','task-role',task.role || 'Task'),document.createTextNode(` · ${task.status || 'queued'}${task.text ? ` — ${task.text}` : ''}`));
          if(task.result){const result=node('details','task-result');result.dataset.taskId=task.id;result.open=openResults.has(task.id);result.append(node('summary','','Result'),node('pre','',task.result));li.append(result);}
          if(Array.isArray(task.artifacts))task.artifacts.forEach((artifact,index)=>{
            const name=String(artifact.path || `Artifact ${index+1}`).split(/[\\/]/).pop();
            const button=actionButton(`↓ ${name}`,()=>downloadArtifact(goal.id,task.id,index));button.className='artifact-button';li.append(button);
          });
          list.append(li);
        } details.append(list); card.append(details);
      }
      dom.goals.append(card);
    }
  }
  function actionButton(label, handler) { const button=node('button','',label); button.type='button';button.addEventListener('click',handler);return button; }
  function renderStatus() {
    const connected=state.providers.filter(p=>p.connected);
    dom['provider-light'].classList.toggle('connected',connected.length>0);
    dom['provider-label'].textContent=connected.length ? `${connected.length} provider${connected.length===1?'':'s'} connected` : 'Connect a provider';
    const running=state.goals.filter(g=>g.status==='running').length;
    const finishing=state.goals.some(g=>g.status==='pausing');
    dom.presence.textContent=finishing?'Finishing current task':state.swarm?.admissionPaused ? 'Team paused' : running ? `Supervising ${running} goal${running===1?'':'s'}` : connected.length ? 'Ready to delegate' : 'Waiting for a provider';
    const spend=state.spend || {};
    const notes=[];
    if(Number(spend.pendingUsd)>0)notes.push(`Pending ${money(spend.pendingUsd)}`);
    if(spend.unknownCalls) notes.push(`${spend.unknownCalls} unpriced call${spend.unknownCalls===1?'':'s'}`);
    if(spend.subscriptionCalls) notes.push(`${spend.subscriptionCalls} subscription call${spend.subscriptionCalls===1?'':'s'}`);
    const tracked=spend.reportedUsd !== undefined || spend.estimatedUsd !== undefined
      ? `Reported ${money(spend.reportedUsd)} · Estimated ${money(spend.estimatedUsd)}`
      : `Tracked usage ${money(spend.usd)}`;
    dom['spend-label'].textContent=`${tracked}${notes.length ? ` · ${notes.join(', ')}` : ''}`;
    const active=state.goals.filter(g=>['running','queued','pausing','stopping'].includes(g.status)).length;
    const paused=state.goals.filter(g=>g.status==='paused').length;
    const admissionPaused=Boolean(state.swarm?.admissionPaused);
    $('swarm-controls').hidden=!active && !paused && !admissionPaused;
    $('swarm-status').textContent=finishing?'TEAM · PAUSING':admissionPaused?'TEAM · PAUSED':active?`TEAM · ${active} ACTIVE`:`TEAM · ${paused} PAUSED`;
    $('swarm-pause').hidden=!active || admissionPaused;
    $('swarm-resume').hidden=finishing || (!admissionPaused && (!!active || !paused));
    $('swarm-stop').hidden=!active && !paused;
  }
  function applyState(next) {
    if (!next || !Array.isArray(next.conversation) || !Array.isArray(next.goals)) return;
    state=next; renderConversation();renderGoals();renderStatus();
    if (dom['provider-dialog'].open) renderProviderList();
  }
  async function refresh() { const result=await bridge.state();applyState(result?.state || result); }
  async function control(id,action) { try {clearNotice();await bridge.controlGoal(id,action);await refresh();} catch(error){showNotice(errorText(error));} }
  async function controlTeam(action) {try{clearNotice();await bridge.controlSwarm(action);await refresh();}catch(error){showNotice(errorText(error));}}
  async function downloadArtifact(goalId,taskId,index) {
    try {
      const artifact=await bridge.readArtifact(goalId,taskId,index);
      if(!artifact || typeof artifact.data!=='string')throw new Error('Artifact is unavailable.');
      const raw=atob(artifact.data);const bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
      const name=String(artifact.name || 'artifact').split(/[\\/]/).pop().replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,160) || 'artifact';
      const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));
      const link=node('a','');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
    } catch(error) { showNotice(errorText(error)); }
  }
  function openEdit(goal) {selectedGoalId=goal.id;dom['goal-text'].value=goal.text || '';dom['goal-budget'].value=Number(goal.budgetUsd || 5).toFixed(2);dom['edit-dialog'].showModal();dom['goal-text'].focus();}
  function methodId(method) {return typeof method==='string'?method:String(method?.id || method?.method || method?.name || '');}
  function methodLabel(method) {const id=methodId(method);return ({'api-key':'API key','key':'API key','oauth':'Sign in','native':'Use native login','native-login':'Use native login','cli':'Use native login','subscription':'Use native login'})[id] || id.replace(/[-_]/g,' ');}
  function supportedMethods(provider) {return (Array.isArray(provider.methods)?provider.methods:[]).filter(method=>methodId(method));}
  function providerDetail(provider) {
    const detail=provider.detail || (provider.available?'Ready to connect':'Unavailable on this device');
    if(detail==='CLI not installed.')return 'Native provider client not installed on this device.';
    if(detail.includes('Sign in through the native app or CLI first.'))return 'Choose Connect to finish sign-in in your browser.';
    return detail.replaceAll('CLI subscriptions','native subscriptions').replaceAll('CLI found;','Native client found;').replaceAll('CLI not found;','Native client not found;');
  }
  function renderProviderList() {
    dom['provider-list'].replaceChildren();
    if(!state.providers.length) {dom['provider-list'].append(node('p','field-help','No supported providers were found. Check again after installing or signing in to a supported provider.'));return;}
    for(const provider of state.providers){
      const methods=supportedMethods(provider);
      const choice=node('button','provider-choice'); choice.type='button';choice.disabled=!provider.connected && !methods.length;
      const left=node('span','');left.append(node('strong','',provider.name || provider.id));
      let description=providerDetail(provider);
      if(provider.id.toLowerCase().includes('modal')) description=`${description} Modal runs isolated workers after connection.`;
      left.append(node('small','',description));choice.append(left,node('span',provider.connected?'connected-tag':'',provider.connected?'Connected':'→'));
      choice.addEventListener('click',()=>selectProvider(provider.id));dom['provider-list'].append(choice);
    }
  }
  function selectProvider(id) {
    selectedProvider=state.providers.find(p=>p.id===id);if(!selectedProvider)return;
    dom['provider-error'].hidden=true;dom['provider-list'].hidden=true;$('refresh-providers').hidden=true;dom['connect-panel'].hidden=false;
    dom['connect-title'].textContent=selectedProvider.name || selectedProvider.id;
    dom['connect-detail'].textContent=providerDetail(selectedProvider)+(selectedProvider.id.toLowerCase().includes('modal')?' In Modal, create an inference Proxy Token. Paste that combined token below; an ordinary account token will not work. Todd will find an available endpoint model after connecting.':'');
    $('connect-key-label').textContent=selectedProvider.id.toLowerCase().includes('modal')?'Modal inference Proxy Token':'API key';
    const methods=supportedMethods(selectedProvider);
    dom['connect-method'].replaceChildren();for(const method of methods){const option=node('option','',methodLabel(method));option.value=methodId(method);dom['connect-method'].append(option);}
    dom['connect-model'].replaceChildren();const defaultOption=node('option','','Provider default');defaultOption.value='';dom['connect-model'].append(defaultOption);
    for(const model of selectedProvider.models || []) {const id=typeof model==='string'?model:String(model.id||model.name);const option=node('option','',id);option.value=id;dom['connect-model'].append(option);}
    dom['model-field'].hidden=!selectedProvider.models?.length;
    dom['connect-submit'].textContent=selectedProvider.connected?'Disconnect':'Connect';
    dom['connect-key'].value='';updateMethodFields();
  }
  function updateMethodFields(){const id=dom['connect-method'].value;dom['key-field'].hidden=!['key','api-key'].includes(id);dom['connect-key'].required=!dom['key-field'].hidden;}
  function openProviders(){dom['provider-error'].hidden=true;dom['provider-list'].hidden=false;$('refresh-providers').hidden=false;dom['connect-panel'].hidden=true;renderProviderList();if(!dom['provider-dialog'].open)dom['provider-dialog'].showModal();}
  function resizePrompt(){dom.prompt.style.height='auto';dom.prompt.style.height=Math.min(dom.prompt.scrollHeight,150)+'px';}
  function scheduleRefresh(){if(eventTimer)return;eventTimer=setTimeout(async()=>{eventTimer=null;try{await refresh();}catch(error){showNotice(errorText(error));}},160);}

  dom.composer.addEventListener('submit',async event=>{
    event.preventDefault();const text=dom.prompt.value.trim();if(!text||sending)return;
    const budgetUsd=Number($('compose-budget').value);
    if(!Number.isFinite(budgetUsd)||budgetUsd<=0||budgetUsd>100000){showNotice('Choose a budget between $0.01 and $100,000.');$('compose-budget').focus();return;}
    sending=true;dom.send.disabled=true;clearNotice();dom.prompt.value='';resizePrompt();
    try{await bridge.chat(text,{budgetUsd});$('compose-budget').value='5.00';await refresh();}catch(error){dom.prompt.value=text;resizePrompt();showNotice(errorText(error));}finally{sending=false;dom.send.disabled=false;dom.prompt.focus();}
  });
  dom.prompt.addEventListener('input',resizePrompt);
  dom.prompt.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();dom.composer.requestSubmit();}});
  dom['edit-form'].addEventListener('submit',async event=>{event.preventDefault();const text=dom['goal-text'].value.trim();const budgetUsd=Number(dom['goal-budget'].value);if(!text||!Number.isFinite(budgetUsd)||budgetUsd<=0)return;try{await bridge.updateGoal(selectedGoalId,{text,budgetUsd});dom['edit-dialog'].close();await refresh();clearNotice();}catch(error){showNotice(errorText(error));}});
  dom['connect-method'].addEventListener('change',updateMethodFields);
  dom['connect-form'].addEventListener('submit',async event=>{
    event.preventDefault();if(!selectedProvider||connecting)return;
    connecting=true;dom['connect-submit'].disabled=true;dom['connect-submit'].textContent=selectedProvider.connected?'Disconnecting…':dom['connect-method'].value==='subscription'?'Waiting for sign-in…':'Connecting…';dom['provider-error'].hidden=true;
    try{
      if(selectedProvider.connected)await bridge.disconnect(selectedProvider.id);
      else {const payload={id:selectedProvider.id,method:dom['connect-method'].value};if(!dom['key-field'].hidden)payload.key=dom['connect-key'].value.trim();if(!dom['model-field'].hidden && dom['connect-model'].value)payload.model=dom['connect-model'].value;await bridge.connect(payload);}
      dom['connect-key'].value='';await refresh();dom['provider-dialog'].close();clearNotice();
    }catch(error){dom['provider-error'].textContent=errorText(error);dom['provider-error'].hidden=false;}
    finally{connecting=false;dom['connect-submit'].disabled=false;dom['connect-submit'].textContent=selectedProvider?.connected?'Disconnect':'Connect';}
  });
  $('provider-back').addEventListener('click',()=>{dom['connect-panel'].hidden=true;dom['provider-list'].hidden=false;$('refresh-providers').hidden=false;dom['connect-key'].value='';});
  for(const action of ['pause','resume','stop'])$(`swarm-${action}`).addEventListener('click',()=>controlTeam(action));
  $('refresh-providers').addEventListener('click',async()=>{try{const discovered=await bridge.discover();if(discovered?.providers)applyState({...state,providers:discovered.providers});else await refresh();dom['provider-error'].hidden=true;}catch(error){dom['provider-error'].textContent=errorText(error);dom['provider-error'].hidden=false;}});
  $('providers-button').addEventListener('click',openProviders);
  $('new-chat').addEventListener('click',()=>{dom.prompt.focus();dom.prompt.scrollIntoView({block:'nearest'});});
  function toggleSidebar(open){document.querySelector('.sidebar').classList.toggle('open',open);$('sidebar-backdrop').hidden=!open;}
  $('mobile-goals').addEventListener('click',()=>toggleSidebar(!document.querySelector('.sidebar').classList.contains('open')));
  $('sidebar-backdrop').addEventListener('click',()=>toggleSidebar(false));
  document.addEventListener('keydown',event=>{if(event.key==='Escape')toggleSidebar(false);});
  document.addEventListener('click',event=>{const target=event.target.closest('[data-close]');if(target)$(target.dataset.close)?.close();});
  dom['provider-dialog'].addEventListener('close',()=>{dom['connect-key'].value='';});
  bridge.onEvent(event=>{if(event?.type==='state')applyState(event.state);else scheduleRefresh();});
  (async()=>{try{await refresh();try{const discovered=await bridge.discover();if(discovered?.providers)applyState({...state,providers:discovered.providers});else await refresh();}catch(error){showNotice(`Provider check: ${errorText(error)}`);}if(!state.providers.some(p=>p.connected))openProviders();}catch(error){showNotice(errorText(error));openProviders();}})();
})();

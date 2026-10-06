import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {wavFromPcm} from '../ui/voice-capture.mjs';

const ui=join(dirname(fileURLToPath(import.meta.url)),'..','ui');
const token='ui-movie-test';
const speechWav=Buffer.from(wavFromPcm([new Float32Array(16000).fill(.12)],16000)).toString('base64');
async function readJson(request){let raw='';for await(const chunk of request)raw+=chunk;return raw?JSON.parse(raw):{};}

test('fullscreen stage keeps text in dialogs and sends one bounded goal after account sign-in',async t=>{
  const state={version:1,conversation:[],goals:[],providers:[
    {id:'modal',name:'Modal inference',connected:false,available:false,detail:'Inference needs a separate Proxy Token.'},
    {id:'codex',name:'Codex',connected:false,available:false,methods:['subscription'],detail:'Sign in through the native app first.'},
    {id:'claude',name:'Claude',connected:false,available:false,methods:['subscription'],detail:'Sign in through the native app first.'},
    {id:'openai',name:'OpenAI API',connected:false,available:false,methods:['key'],fleetSupported:true,fleetEligible:false,detail:'Requires an API key.'},
    {id:'anthropic',name:'Anthropic API',connected:false,available:false,methods:['key'],fleetSupported:true,fleetEligible:false,detail:'Requires an API key.'},
  ],spend:{usd:0,reportedUsd:0,estimatedUsd:0},swarm:{status:'idle',admissionPaused:false}};
  const auth={fly:{id:'fly',connected:false,loginAvailable:true,detail:'Fly browser sign-in is ready.'},modal:{id:'modal',connected:false,loginAvailable:true,detail:'Modal browser sign-in is ready.'}};
  const streams=new Set(),heldSpeech=[];const authCalls=[],providerCalls=[];let goalCall,editCall,voiceCapabilityCalls=0,voiceTranscribe=false,voiceReady=false,speechRequests=0,fxQuoteAsOf=new Date(Date.now()-3600000).toISOString();
  const publish=()=>{for(const client of streams)client.write(`data: ${JSON.stringify({type:'state',state})}\n\n`);};
  const server=createServer(async(req,res)=>{
    const route=new URL(req.url,'http://localhost').pathname;
    const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json'}).end(JSON.stringify(data));};
    if(route==='/favicon.ico'){res.writeHead(204).end();return;}
    if(route.startsWith('/api/')&&req.headers.authorization!==`Bearer ${token}`){send(401,{error:'Unauthorized'});return;}
    if(route==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': ready\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;}
    if(route==='/api/state'){send(200,state);return;}
    if(route==='/api/budget/default'){const currency=new URL(req.url,'http://localhost').searchParams.get('currency');send(200,currency==='COP'?{amount:200000,currency:'COP',allowanceUsd:50,usdPerUnit:0.00025,quoteAsOf:fxQuoteAsOf,quoteSource:'https://www.exchangerate-api.com'}:{amount:50,currency:'USD',allowanceUsd:50,usdPerUnit:1,quoteAsOf:null,quoteSource:null});return;}
    if(route==='/api/test/state'&&req.method==='POST'){const next=await readJson(req);if(next.spend)state.spend=next.spend;if(next.quoteAsOf)fxQuoteAsOf=next.quoteAsOf;if(next.execution&&state.goals[0])state.goals[0].execution=next.execution;if(next.voice){voiceTranscribe=next.voice.transcribe;voiceReady=next.voice.ready;}if(next.todd)state.conversation.push({id:`t${state.conversation.length}`,role:'todd',text:next.todd,at:new Date().toISOString()});publish();send(200,{ok:true});return;}
    if(route==='/api/test/speech-state'){send(200,{requests:speechRequests,voiceCapabilityCalls});return;}
    if(route==='/api/test/release-speech'&&req.method==='POST'){const held=heldSpeech.shift();if(!held){send(409,{error:'No speech request is pending.'});return;}held.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({mimeType:'audio/wav',dataBase64:speechWav}));send(200,{released:true});return;}
    if(route==='/api/auth/state'){send(200,auth);return;}
    if(route==='/api/voice/capabilities'){voiceCapabilityCalls++;send(200,{transcribe:voiceTranscribe,speak:true,ready:voiceReady,status:voiceTranscribe?(voiceReady?'ready':'preparing'):'unavailable',narration:voiceCapabilityCalls>1?'kokoro':'system',narrationStatus:voiceCapabilityCalls>1?'ready':'preparing',voiceName:voiceCapabilityCalls>1?'Michael (preset)':'Installed system voice',reason:'Voice capture is unavailable in this test browser.'});return;}
    if(route==='/api/voice/speak'){speechRequests++;heldSpeech.push(res);return;}
    if(route==='/api/voice/stop'){send(200,{stopped:true});return;}
    if(route==='/api/auth/connect'){const {id}=await readJson(req);authCalls.push(id);auth[id].connected=true;auth[id].detail=`${id} account sign-in verified; inference remains separate.`;send(200,auth[id]);return;}
    if(route==='/api/auth/cancel'){send(200,{cancelled:true});return;}
    if(route==='/api/providers/discover'){send(200,state.providers);return;}
    if(route==='/api/providers/connect'){const input=await readJson(req);providerCalls.push(input);const item=state.providers.find(provider=>provider.id===input.id);item.connected=true;item.available=true;item.fleetEligible=input.fleetAllowed===true;item.models=input.model?[input.model]:[];publish();send(200,item);return;}
    if(route.startsWith('/api/providers/')&&req.method==='DELETE'){const id=route.split('/').at(-1),item=state.providers.find(provider=>provider.id===id);item.connected=false;item.available=false;item.fleetEligible=false;publish();send(200,item);return;}
    if(route==='/api/chat'){
      goalCall=await readJson(req);state.conversation.push({id:'u1',role:'user',text:goalCall.text,at:new Date().toISOString()});
      state.goals.push({id:'g1',text:goalCall.text,status:'running',privateH100:goalCall.privateH100,execution:{requested:'company',readiness:'working',verifiedWorkers:2,verifiedChildConversations:3},spentUsd:0,budgetUsd:5,budget:{amount:25000,currency:'COP',allowanceUsd:5,usdPerUnit:0.0002,quoteAsOf:'2026-10-05T00:00:00.000Z',quoteSource:'https://www.exchangerate-api.com'},tasks:[{id:'t1',role:'developer',status:'running',text:'Building the prototype'}]});
      state.swarm.status='working';publish();send(202,state.goals[0]);return;
    }
    if(route==='/api/goals/g1'&&req.method==='PATCH'){editCall=await readJson(req);Object.assign(state.goals[0],editCall);publish();send(200,state.goals[0]);return;}
    if(route==='/api/swarm/pause'){state.goals[0].status='paused';state.swarm={status:'paused',admissionPaused:true};publish();send(200,state);return;}
    if(route==='/api/swarm/resume'){state.goals[0].status='running';state.swarm={status:'working',admissionPaused:false};publish();send(200,state);return;}
    if(route==='/api/swarm/stop'){state.goals[0].status='stopped';state.swarm={status:'idle',admissionPaused:false};publish();send(200,state);return;}
    if(route==='/clips/todd-loop.mp4'){
      const bytes=await readFile(join(ui,'clips','todd-loop.mp4'));
      const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');
      if(match){const start=Number(match[1]),end=match[2]?Math.min(Number(match[2]),bytes.length-1):bytes.length-1;
        res.writeHead(206,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Length':end-start+1}).end(bytes.subarray(start,end+1));return;}
      res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':bytes.length}).end(bytes);return;
    }
    const file={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/styles.css':'styles.css','/stage.mjs':'stage.mjs','/movie-player.mjs':'movie-player.mjs','/movie-manifest.json':'movie-manifest.json','/goal-input.mjs':'goal-input.mjs','/voice-capture.mjs':'voice-capture.mjs'}[route];
    if(file){const type=file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':file.endsWith('.json')?'application/json':'text/javascript';res.writeHead(200,{'Content-Type':type}).end(await readFile(join(ui,file)));return;}
    res.writeHead(404).end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{for(const stream of streams)stream.end();server.close();});
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:800},locale:'es-CO'});
  await page.addInitScript(()=>{window.fixtureMicrophoneRequests=0;Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{window.fixtureMicrophoneRequests++;throw new Error('Fixture microphone must stay unused.');}}});});
  await page.goto(`http://127.0.0.1:${server.address().port}/#token=${token}`);
  assert.equal(new URL(page.url()).hash,'');
  await page.locator('#movie[data-scene="idle"]').waitFor();
  await page.locator('#movie[data-movie-status="playing"]').waitFor();
  await page.waitForFunction(()=>document.getElementById('budget-amount').value==='200000');
  assert.equal(await page.locator('#budget-currency').inputValue(),'COP');
  const background=await page.locator('#frame').evaluate(element=>getComputedStyle(element).backgroundImage);
  assert.equal(background.includes('todd-stopmotion.png'),false);
  assert.equal(await page.locator('#movie').getByRole('heading').count(),0);
  if(process.env.UI_MOVIE_SCREENSHOT)await page.screenshot({path:process.env.UI_MOVIE_SCREENSHOT});
  await page.getByRole('button',{name:'Start'}).click();
  await page.getByRole('heading',{name:'Get the team ready'}).waitFor();
  await page.locator('#fly-connect').click();await page.locator('#modal-connect').click();
  assert.deepEqual(authCalls,['fly','modal']);
  await page.getByRole('dialog',{name:'Advanced'}).waitFor();
  assert.equal(await page.locator('#setup-dialog').isVisible(),false);
  assert.equal(await page.locator('#setup-continue').count(),0);
  assert.equal(goalCall,undefined);
  await page.locator('#provider-connect-details summary').click();
  await page.getByText('Narration: installed system voice while the local preset prepares.').waitFor();
  await page.getByLabel('Provider',{exact:true}).selectOption('openai');
  assert.equal(await page.getByLabel('Allow isolated Workers to use this API key for goals with this provider; desktop saves it encrypted outside Git.').isChecked(),false);
  await page.locator('#provider-key').fill('fixture-openai-only');
  await page.getByRole('button',{name:'Connect API'}).click();
  await page.waitForFunction(()=>document.getElementById('provider-key').value==='');
  await page.getByLabel('Voice is unavailable. Enter one sentence here.').waitFor();
  assert.deepEqual(providerCalls[0],{id:'openai',method:'key',model:'gpt-6.1-sol',fleetAllowed:false,key:'fixture-openai-only'});
  assert.equal(await page.locator('#provider-key').inputValue(),'');
  await page.getByLabel('Provider',{exact:true}).selectOption('anthropic');
  await page.locator('#provider-key').fill('fixture-anthropic-only');
  await page.getByLabel('Allow isolated Workers to use this API key for goals with this provider; desktop saves it encrypted outside Git.').check();
  await page.getByRole('button',{name:'Connect API'}).click();
  await page.getByText('This API key may be used by isolated Workers; remote capacity is verified at run time.').waitFor();
  assert.deepEqual(providerCalls[1],{id:'anthropic',method:'key',model:'claude-sonnet-5-5',fleetAllowed:true,key:'fixture-anthropic-only'});
  await page.getByLabel('Provider',{exact:true}).selectOption('codex');
  await page.getByRole('button',{name:'Connect account'}).click();
  await page.getByText('Codex is connected locally; remote five-by-five staffing remains unverified.').waitFor();
  assert.deepEqual(providerCalls[2],{id:'codex',method:'subscription'});
  await page.getByLabel('Goal provider').selectOption('codex');
  await page.getByText('Codex is connected locally. Company readiness is checked separately.').waitFor();
  await page.locator('#budget-amount').fill('321000');
  await page.request.post(`http://127.0.0.1:${server.address().port}/api/test/state`,{headers:{Authorization:`Bearer ${token}`},data:{spend:{reportedUsd:1.25,estimatedUsd:0.5,pendingUsd:0.75}}});
  await page.waitForFunction(()=>document.getElementById('spend-details').textContent.includes('Estimated COP equivalents: 5.000 COP of provider-reported USD · 2.000 COP of estimated USD · 3.000 COP of pending USD.'));
  assert.equal(await page.locator('#budget-amount').inputValue(),'321000');
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'budget-amount');
  await page.request.post(`http://127.0.0.1:${server.address().port}/api/test/state`,{headers:{Authorization:`Bearer ${token}`},data:{spend:{reportedUsd:null,estimatedUsd:'0.5',pendingUsd:-1}}});
  await page.waitForFunction(()=>document.getElementById('spend-details').textContent.includes('unavailable provider-reported · unavailable estimated · unavailable pending.'));
  assert.equal((await page.locator('#spend-details').textContent()).includes('Estimated COP equivalents:'),false);
  await page.waitForFunction(()=>document.getElementById('spend-details').textContent.includes('COP conversion unavailable: the USD spend figures are unavailable.'));
  await page.request.post(`http://127.0.0.1:${server.address().port}/api/test/state`,{headers:{Authorization:`Bearer ${token}`},data:{spend:{reportedUsd:1.25,estimatedUsd:0.5,pendingUsd:0.75}}});
  await page.waitForFunction(()=>document.getElementById('spend-details').textContent.includes('Estimated COP equivalents: 5.000 COP of provider-reported USD'));
  if(process.env.UI_ADVANCED_SCREENSHOT)await page.screenshot({path:process.env.UI_ADVANCED_SCREENSHOT});
  await page.getByLabel('Budget currency').selectOption('COP');
  await page.getByRole('button',{name:'$100',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('budget-amount').value==='400000');
  await page.locator('#budget-currency').selectOption('USD');
  await page.waitForFunction(()=>document.getElementById('budget-amount').value==='100');
  await page.locator('#budget-currency').selectOption('COP');
  await page.waitForFunction(()=>document.getElementById('budget-amount').value==='400000');
  await page.getByLabel('Goal budget amount').fill('25000');
  await page.getByLabel('Workers 5').fill('4');
  await page.getByLabel('Conversations per worker 5').fill('2');
  await page.getByLabel('Private H100 + Qwen').check();
  assert.equal(await page.getByLabel('Goal provider').isDisabled(),true);
  await page.getByText("At Go, private H100 may start paid inference within this goal's allowance; availability is checked then.").waitFor();
  await page.getByLabel('Voice is unavailable. Enter one sentence here.').fill('Build the game. Then ship it.');
  await page.getByRole('button',{name:'Go',exact:true}).click();
  assert.equal(await page.locator('#advanced-error').innerText(),'Enter one sentence for Todd.');
  assert.equal(goalCall,undefined);
  await page.getByLabel('Voice is unavailable. Enter one sentence here.').fill('Build the game.');
  await page.getByRole('button',{name:'Go',exact:true}).click();
  await page.locator('#movie[data-scene="work"]').waitFor();
  assert.deepEqual(goalCall,{text:'Build the game.',budget:{amount:25000,currency:'COP'},maxWorkers:4,conversationsPerWorker:2,privateH100:true,executionMode:'company'});
  await page.getByRole('button',{name:'Open advanced controls'}).click();
  await page.getByText('Local silent film is playing continuously.',{exact:false}).waitFor();
  await page.getByText('Narration: Michael (preset) local preset.').waitFor();
  await page.getByText('Provider and spend').click();
  await page.getByText('Codex, OpenAI API, Anthropic API connected locally. Company readiness is checked separately.').waitFor();
  await page.getByText('1.25 USD provider-reported · 0.50 USD estimated · 0.75 USD pending.', {exact:false}).waitFor();
  await page.getByText('Work details').click();
  await page.getByText('Company is working. 2 completed worker runs verified · 3 completed child conversations verified.').waitFor();
  await page.request.post(`http://127.0.0.1:${server.address().port}/api/test/state`,{headers:{Authorization:`Bearer ${token}`},data:{execution:{requested:'company',readiness:'blocked',reason:'Native worker gateway is unavailable.'}}});
  await page.getByText('Company waiting: Native worker gateway is unavailable.').waitFor();
  await page.request.post(`http://127.0.0.1:${server.address().port}/api/test/state`,{headers:{Authorization:`Bearer ${token}`},data:{execution:{requested:'company',readiness:'working',verifiedWorkers:0,verifiedChildConversations:0}}});
  await page.getByText('Company is working.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('link',{name:'ExchangeRate-API'}).getAttribute('href'),'https://www.exchangerate-api.com');
  await page.getByText('Edit goal').click();
  await page.locator('.goal-edit-form textarea').fill('Build the improved game.');
  await page.locator('.goal-edit-form input[aria-label="Edit budget amount"]').fill('30000');
  await page.request.post(`http://127.0.0.1:${server.address().port}/api/test/state`,{headers:{Authorization:`Bearer ${token}`},data:{spend:{reportedUsd:2.5,estimatedUsd:0.5,pendingUsd:0.75}}});
  await page.getByText('Estimated COP equivalents: 10.000 COP of provider-reported USD', {exact:false}).waitFor();
  assert.equal(await page.locator('.goal-edit-form textarea').inputValue(),'Build the improved game.');
  assert.equal(await page.locator('.goal-edit-form input[aria-label="Edit budget amount"]').inputValue(),'30000');
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Edit budget amount');
  await page.locator('.goal-edit-form button').click();
  await page.getByText('Build the improved game.').waitFor();
  assert.equal(state.goals[0].privateH100,true);
  assert.equal(Object.hasOwn(editCall,'privateH100'),false);
  await page.getByText('1 work item').click();
  await page.getByText('Building the prototype').waitFor();
  await page.getByRole('button',{name:'Pause'}).click();
  await page.locator('#movie[data-scene="idle"]').waitFor();
  await page.getByRole('button',{name:'Resume'}).click();
  await page.locator('#movie[data-scene="work"]').waitFor();
  await page.locator('#budget-currency').selectOption('USD');
  await page.waitForFunction(()=>!document.getElementById('budget-note').textContent.includes('Checking'));
  await page.request.post(`http://127.0.0.1:${server.address().port}/api/test/state`,{headers:{Authorization:`Bearer ${token}`},data:{quoteAsOf:new Date(Date.now()-(48*60*60*1000)+5000).toISOString()}});
  await page.locator('#budget-currency').selectOption('COP');
  await page.getByText('Estimated COP equivalents:',{exact:false}).waitFor();
  await page.getByText('COP conversion unavailable: a current dated quote is required. Available spend remains shown in USD.').waitFor();
  await page.getByText('2.50 USD provider-reported · 0.50 USD estimated · 0.75 USD pending.',{exact:false}).waitFor();
  const fixtureUrl=`http://127.0.0.1:${server.address().port}`;
  const fixturePost=data=>page.request.post(`${fixtureUrl}/api/test/state`,{headers:{Authorization:`Bearer ${token}`},data});
  const speechState=async()=>{const response=await page.request.get(`${fixtureUrl}/api/test/speech-state`,{headers:{Authorization:`Bearer ${token}`}});return response.json();};
  const waitForSpeech=count=>page.waitForFunction(async expected=>{const response=await fetch('/api/test/speech-state',{headers:{Authorization:'Bearer ui-movie-test'}});return (await response.json()).requests>=expected;},count);
  const releaseSpeech=()=>page.request.post(`${fixtureUrl}/api/test/release-speech`,{headers:{Authorization:`Bearer ${token}`},data:{}});
  await fixturePost({todd:'The team is working.'});await waitForSpeech(1);
  await page.getByRole('button',{name:'Pause'}).click();
  await page.locator('#movie[data-scene="idle"]').waitFor();
  await releaseSpeech();
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#todd-audio').getAttribute('src'),null);
  assert.equal(await page.locator('#movie').getAttribute('data-mode'),'ready');
  await fixturePost({todd:'A late note while paused.'});
  await page.waitForFunction(()=>document.getElementById('live-status').textContent==='Todd responded.');
  assert.equal((await speechState()).requests,1);
  await page.getByRole('button',{name:'Resume'}).click();
  await page.locator('#movie[data-scene="work"]').waitFor();
  await fixturePost({voice:{transcribe:true,ready:false}});
  const priorCapabilities=(await speechState()).voiceCapabilityCalls;
  await page.getByRole('button',{name:'Close advanced controls'}).click();
  await page.getByRole('button',{name:'Open advanced controls'}).click();
  await page.waitForFunction(async prior=>{const response=await fetch('/api/test/speech-state',{headers:{Authorization:'Bearer ui-movie-test'}});return (await response.json()).voiceCapabilityCalls>prior;},priorCapabilities);
  await page.getByRole('button',{name:'Close advanced controls'}).click();
  await page.getByRole('button',{name:'Speak a goal'}).click();
  await page.locator('#movie[data-mode="transcribing"]').waitFor();
  await page.getByRole('button',{name:'Open advanced controls'}).click();
  await page.getByRole('button',{name:'Pause'}).click();
  await fixturePost({voice:{transcribe:true,ready:true}});
  await page.locator('#movie[data-scene="idle"]').waitFor();
  await page.waitForTimeout(1400);
  assert.equal(await page.evaluate(()=>window.fixtureMicrophoneRequests),0);
  assert.equal(await page.locator('#movie').getAttribute('data-mode'),'ready');
  await page.getByRole('button',{name:'Resume'}).click();
  await page.locator('#movie[data-scene="work"]').waitFor();
  await fixturePost({todd:'Another update before stop.'});await waitForSpeech(2);
  await page.getByRole('button',{name:'Stop'}).click();
  await page.locator('#movie[data-scene="idle"]').waitFor();
  await releaseSpeech();
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#todd-audio').getAttribute('src'),null);
  const visibleStageText=await page.locator('#movie').evaluate(stage=>{const walker=document.createTreeWalker(stage,NodeFilter.SHOW_TEXT),visible=[];while(walker.nextNode()){const text=walker.currentNode.textContent.trim(),parent=walker.currentNode.parentElement;if(!text||!parent||parent.closest('.sr-only,[hidden]'))continue;const style=getComputedStyle(parent);if(style.display!=='none'&&style.visibility!=='hidden')visible.push(text);}return visible;});
  assert.deepEqual(visibleStageText,[]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';

const ui=join(dirname(fileURLToPath(import.meta.url)),'..','ui');
const token='ui-movie-test';
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
  const streams=new Set();const authCalls=[],providerCalls=[];let goalCall,editCall,voiceCapabilityCalls=0;
  const publish=()=>{for(const client of streams)client.write(`data: ${JSON.stringify({type:'state',state})}\n\n`);};
  const server=createServer(async(req,res)=>{
    const route=new URL(req.url,'http://localhost').pathname;
    const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json'}).end(JSON.stringify(data));};
    if(route==='/favicon.ico'){res.writeHead(204).end();return;}
    if(route.startsWith('/api/')&&req.headers.authorization!==`Bearer ${token}`){send(401,{error:'Unauthorized'});return;}
    if(route==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': ready\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;}
    if(route==='/api/state'){send(200,state);return;}
    if(route==='/api/budget/default'){const currency=new URL(req.url,'http://localhost').searchParams.get('currency');send(200,currency==='COP'?{amount:200000,currency:'COP',allowanceUsd:50,usdPerUnit:0.00025,quoteAsOf:'2026-10-05T00:00:00.000Z',quoteSource:'https://www.exchangerate-api.com'}:{amount:50,currency:'USD',allowanceUsd:50,usdPerUnit:1,quoteAsOf:null,quoteSource:null});return;}
    if(route==='/api/auth/state'){send(200,auth);return;}
    if(route==='/api/voice/capabilities'){voiceCapabilityCalls++;send(200,{transcribe:false,speak:true,ready:false,status:'unavailable',narration:voiceCapabilityCalls>1?'kokoro':'system',narrationStatus:voiceCapabilityCalls>1?'ready':'preparing',voiceName:voiceCapabilityCalls>1?'Michael (preset)':'Installed system voice',reason:'Voice capture is unavailable in this test browser.'});return;}
    if(route==='/api/auth/connect'){const {id}=await readJson(req);authCalls.push(id);auth[id].connected=true;auth[id].detail=`${id} account sign-in verified; inference remains separate.`;send(200,auth[id]);return;}
    if(route==='/api/auth/cancel'){send(200,{cancelled:true});return;}
    if(route==='/api/providers/discover'){send(200,state.providers);return;}
    if(route==='/api/providers/connect'){const input=await readJson(req);providerCalls.push(input);const item=state.providers.find(provider=>provider.id===input.id);item.connected=true;item.available=true;item.fleetEligible=input.fleetAllowed===true;item.models=input.model?[input.model]:[];publish();send(200,item);return;}
    if(route.startsWith('/api/providers/')&&req.method==='DELETE'){const id=route.split('/').at(-1),item=state.providers.find(provider=>provider.id===id);item.connected=false;item.available=false;item.fleetEligible=false;publish();send(200,item);return;}
    if(route==='/api/chat'){
      goalCall=await readJson(req);state.conversation.push({id:'u1',role:'user',text:goalCall.text,at:new Date().toISOString()});
      state.goals.push({id:'g1',text:goalCall.text,status:'running',privateH100:goalCall.privateH100,spentUsd:0,budgetUsd:5,budget:{amount:25000,currency:'COP',allowanceUsd:5,usdPerUnit:0.0002,quoteAsOf:'2026-10-05T00:00:00.000Z',quoteSource:'https://www.exchangerate-api.com'},tasks:[{id:'t1',role:'developer',status:'running',text:'Building the prototype'}]});
      state.swarm.status='working';publish();send(202,state.goals[0]);return;
    }
    if(route==='/api/goals/g1'&&req.method==='PATCH'){editCall=await readJson(req);Object.assign(state.goals[0],editCall);publish();send(200,state.goals[0]);return;}
    if(route==='/api/swarm/pause'){state.goals[0].status='paused';state.swarm={status:'paused',admissionPaused:true};publish();send(200,state);return;}
    if(route==='/api/swarm/resume'){state.goals[0].status='running';state.swarm={status:'working',admissionPaused:false};publish();send(200,state);return;}
    const file={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/styles.css':'styles.css','/stage.mjs':'stage.mjs','/movie-player.mjs':'movie-player.mjs','/movie-manifest.json':'movie-manifest.json','/goal-input.mjs':'goal-input.mjs','/voice-capture.mjs':'voice-capture.mjs'}[route];
    if(file){const type=file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':file.endsWith('.json')?'application/json':'text/javascript';res.writeHead(200,{'Content-Type':type}).end(await readFile(join(ui,file)));return;}
    res.writeHead(404).end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{for(const stream of streams)stream.end();server.close();});
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:800},locale:'es-CO'});
  await page.goto(`http://127.0.0.1:${server.address().port}/#token=${token}`);
  assert.equal(new URL(page.url()).hash,'');
  await page.locator('#movie[data-scene="idle"]').waitFor();
  await page.locator('#movie[data-movie-status="missing"]').waitFor();
  await page.waitForFunction(()=>document.getElementById('budget-amount').value==='200000');
  assert.equal(await page.locator('#budget-currency').inputValue(),'COP');
  const background=await page.locator('#frame').evaluate(element=>getComputedStyle(element).backgroundImage);
  assert.equal(background.includes('todd-stopmotion.png'),false);
  assert.equal(await page.locator('#movie').getByRole('heading').count(),0);
  if(process.env.UI_MOVIE_SCREENSHOT)await page.screenshot({path:process.env.UI_MOVIE_SCREENSHOT});
  await page.getByRole('button',{name:'Start'}).click();
  await page.getByRole('heading',{name:'Get the team ready'}).waitFor();
  assert.equal(await page.locator('#provider-setup').isDisabled(),true);
  await page.locator('#fly-connect').click();await page.locator('#modal-connect').click();
  assert.deepEqual(authCalls,['fly','modal']);
  await page.getByText('Connect a supported inference provider, or continue with a queued goal.').waitFor();
  await page.locator('#provider-setup').click();
  await page.getByRole('dialog',{name:'Advanced'}).waitFor();
  await page.getByText('Narration: installed system voice while the local preset prepares.').waitFor();
  await page.getByLabel('Provider',{exact:true}).selectOption('openai');
  assert.equal(await page.getByLabel('Allow isolated Workers to use this API key for goals with this provider; desktop saves it encrypted outside Git.').isChecked(),false);
  await page.locator('#provider-key').fill('fixture-openai-only');
  await page.getByRole('button',{name:'Connect API'}).click();
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
  if(process.env.UI_ADVANCED_SCREENSHOT)await page.screenshot({path:process.env.UI_ADVANCED_SCREENSHOT});
  await page.getByLabel('Budget currency').selectOption('COP');
  await page.getByRole('button',{name:'$100',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('budget-amount').value==='400000');
  await page.getByLabel('Budget currency').selectOption('USD');
  await page.waitForFunction(()=>document.getElementById('budget-amount').value==='100');
  await page.getByLabel('Budget currency').selectOption('COP');
  await page.waitForFunction(()=>document.getElementById('budget-amount').value==='400000');
  await page.getByLabel('Goal budget amount').fill('25000');
  await page.getByLabel('Workers 5').fill('4');
  await page.getByLabel('Conversations per worker 5').fill('2');
  await page.getByLabel('Private H100 + Qwen').check();
  await page.getByText('At Go, this may create paid H100 resources and permit isolated Workers to use the newly owned bearer; this route is not verified yet.').waitFor();
  await page.getByLabel('Voice is unavailable. Enter one sentence here.').fill('Build the game. Then ship it.');
  await page.getByRole('button',{name:'Go',exact:true}).click();
  assert.equal(await page.locator('#advanced-error').innerText(),'Enter one sentence for Todd.');
  assert.equal(goalCall,undefined);
  await page.getByLabel('Voice is unavailable. Enter one sentence here.').fill('Build the game.');
  await page.getByRole('button',{name:'Go',exact:true}).click();
  await page.locator('#movie[data-scene="work"]').waitFor();
  assert.deepEqual(goalCall,{text:'Build the game.',budget:{amount:25000,currency:'COP'},maxWorkers:4,conversationsPerWorker:2,privateH100:true});
  await page.getByRole('button',{name:'Open advanced controls'}).click();
  await page.getByText('No approved Todd movie clips are installed.',{exact:false}).waitFor();
  await page.getByText('Narration: Michael (preset) local preset.').waitFor();
  await page.getByText('Provider and spend').click();
  await page.getByText('Codex, OpenAI API, Anthropic API available. First execution still needs verification.').waitFor();
  await page.getByText('0.00 USD provider-reported', {exact:false}).waitFor();
  await page.getByText('Work details').click();
  assert.equal(await page.getByRole('link',{name:'ExchangeRate-API'}).getAttribute('href'),'https://www.exchangerate-api.com');
  await page.getByText('Edit goal').click();
  await page.locator('.goal-edit-form textarea').fill('Build the improved game.');
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
});

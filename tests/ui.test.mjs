import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const ui=join(root,'ui');
const token='ui-test-token';
const state={version:1,conversation:[],goals:[],providers:[{id:'claude',name:'Claude',available:true,connected:false,methods:['subscription'],detail:'Native sign-in found'},{id:'openai',name:'OpenAI API',available:false,connected:false,methods:['key'],detail:'Requires an API key'},{id:'modal',name:'Modal inference',available:false,connected:false,methods:['key'],detail:'Requires a Modal inference Proxy Token'}],spend:{usd:1.2,pendingUsd:1.25,unknownCalls:1,subscriptionCalls:0},swarm:{status:'idle'}};
const clients=new Set();
let lastConnection;
let lastChat;
function sendState(){for(const client of clients)client.write(`data: ${JSON.stringify({type:'state',state})}\n\n`);}
async function readJson(req){let body='';for await(const chunk of req)body+=chunk;return body?JSON.parse(body):{};}

test('browser fallback connects, chats, edits goals, and controls work',async t=>{
  const server=createServer(async(req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname;
    if(path==='/favicon.ico'){res.writeHead(204).end();return;}
    if(path.startsWith('/api/') && req.headers.authorization!==`Bearer ${token}`){res.writeHead(401,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Unauthorized'}));return;}
    if(path==='/api/events'){
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});res.write(': connected\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;
    }
    if(path==='/api/state'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(state));return;}
    if(path==='/api/providers/discover'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(state.providers));return;}
    if(path==='/api/providers/connect'){
      lastConnection=await readJson(req);const provider=state.providers.find(item=>item.id===lastConnection.id);provider.connected=true;provider.available=true;sendState();res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(provider));return;
    }
    if(path==='/api/chat'){
      lastChat=await readJson(req);const {text,budgetUsd}=lastChat;state.conversation.push({id:'m1',role:'user',text,at:new Date().toISOString()},{id:'m2',role:'todd',text:'Consider it delegated. I will keep watch.',at:new Date().toISOString()},{id:'m3',role:'team',text:'INTERNAL TASK STATUS',at:new Date().toISOString()});state.goals.push({id:'g1',text,status:'running',budgetUsd,spentUsd:0.4,pendingUsd:1.25,billingPending:true,providerId:'claude',tasks:[{id:'t1',role:'developer',status:'running',text:'Working',result:'Made the requested draft.',artifacts:[{path:'result.txt',sha256:'fixture',bytes:17}]}]});sendState();res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(state));return;
    }
    const swarmMatch=path.match(/^\/api\/swarm\/(pause|resume|stop)$/);
    if(swarmMatch){const action=swarmMatch[1];state.swarm.admissionPaused=action!=='resume';state.goals[0].status={pause:'paused',resume:'running',stop:'stopped'}[action];sendState();res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(state));return;}
    if(path==='/api/goals/g1/artifacts/t1/0'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({name:'result.txt',data:Buffer.from('artifact contents').toString('base64'),bytes:17,sha256:'fixture'}));return;}
    const goalMatch=path.match(/^\/api\/goals\/([^/]+)(?:\/(pause|resume|stop))?$/);
    if(goalMatch){
      if(req.method==='PATCH')Object.assign(state.goals[0],await readJson(req));
      else state.goals[0].status={pause:'paused',resume:'running',stop:'stopped'}[goalMatch[2]];
      sendState();res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(state.goals[0]));return;
    }
    const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/styles.css':'styles.css'};
    if(files[path]){const type=path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html';res.writeHead(200,{'Content-Type':type}).end(await readFile(join(ui,files[path])));return;}
    res.writeHead(404).end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{for(const client of clients)client.end();server.close();});
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  await page.goto(`http://127.0.0.1:${server.address().port}/#token=${token}`);
  await assert.doesNotReject(()=>page.getByRole('heading',{name:'Choose a provider'}).waitFor());
  assert.equal(new URL(page.url()).hash,'');
  await page.getByRole('button',{name:/Claude Native sign-in found/}).click();
  await page.getByRole('button',{name:'Connect',exact:true}).click();
  await page.getByText('1 provider connected').waitFor();
  assert.deepEqual(lastConnection,{id:'claude',method:'subscription'});
  await page.getByRole('textbox',{name:'Message Todd'}).fill('Build my app');
  await page.getByRole('spinbutton',{name:'New goal budget in USD'}).fill('7.25');
  await page.getByRole('textbox',{name:'Message Todd'}).press('Enter');
  await page.getByText('Consider it delegated. I will keep watch.').waitFor();
  assert.deepEqual(lastChat,{text:'Build my app',budgetUsd:7.25});
  assert.equal(state.goals[0].budgetUsd,7.25);
  assert.equal((await page.locator('#conversation').innerText()).includes('INTERNAL TASK STATUS'),false);
  if(process.env.UI_SCREENSHOT)await page.screenshot({path:process.env.UI_SCREENSHOT,fullPage:true});
  await page.getByText('Tracked usage $1.20 · Pending $1.25, 1 unpriced call').waitFor();
  await page.getByText('$0.40 tracked · $1.25 pending / $7.25 cap').waitFor();
  state.goals[0].status='pausing';state.swarm.admissionPaused=true;sendState();
  await page.getByText('Finishing the current task before pausing.').waitFor();
  assert.equal(await page.getByRole('button',{name:'Resume all'}).isVisible(),false);
  state.goals[0].status='running';state.swarm.admissionPaused=false;sendState();
  await page.getByText('Supervising 1 goal').waitFor();
  await page.getByRole('button',{name:'Pause all'}).click();
  await page.getByText('Team paused').waitFor();
  await page.getByRole('button',{name:'Resume all'}).click();
  await page.getByText('Supervising 1 goal').waitFor();
  await page.getByRole('button',{name:'Edit'}).click();
  await page.getByLabel('What should Todd do?').fill('Build a better app');
  await page.getByLabel('Budget in USD',{exact:true}).fill('7.50');
  await page.getByRole('button',{name:'Save changes'}).click();
  await page.getByText('Build a better app').waitFor();
  assert.equal(state.goals[0].budgetUsd,7.5);
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await page.getByText('paused',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Resume',exact:true}).click();
  await page.getByText('running',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await page.getByText('stopped',{exact:true}).waitFor();
  await page.getByText('Work details · 1').click();
  await page.getByText('developer · running — Working').waitFor();
  await page.getByText('Result',{exact:true}).click();
  await page.getByText('Made the requested draft.').waitFor();
  state.spend.pendingUsd=1.5;sendState();
  await page.getByText('Pending $1.50',{exact:false}).waitFor();
  assert.equal(await page.getByText('Made the requested draft.').isVisible(),true);
  const downloadPromise=page.waitForEvent('download');
  await page.getByRole('button',{name:'↓ result.txt'}).click();
  const download=await downloadPromise;
  assert.equal(download.suggestedFilename(),'result.txt');
  assert.equal(await readFile(await download.path(),'utf8'),'artifact contents');
  await page.getByRole('button',{name:/provider connected/}).click();
  await page.getByRole('button',{name:/OpenAI API Requires an API key/}).click();
  await page.getByLabel('API key').fill('test-key-not-a-secret');
  await page.getByRole('button',{name:'Connect',exact:true}).click();
  await page.getByText('2 providers connected').waitFor();
  assert.deepEqual(lastConnection,{id:'openai',method:'key',key:'test-key-not-a-secret'});
  assert.equal((await page.locator('body').innerText()).includes('test-key-not-a-secret'),false);
  await page.getByRole('button',{name:/providers connected/}).click();
  await page.getByRole('button',{name:/Modal inference Requires a Modal inference Proxy Token/}).click();
  await page.getByText(/ordinary account token will not work/).waitFor();
  await page.getByLabel('Modal inference Proxy Token').waitFor();
  await page.getByRole('button',{name:'Close'}).click();
  await page.setViewportSize({width:390,height:760});
  await page.getByRole('button',{name:'Show goals'}).click();
  assert.equal(await page.locator('.sidebar').evaluate(element=>element.classList.contains('open')),true);
  if(process.env.UI_MOBILE_SCREENSHOT){await page.waitForTimeout(250);await page.screenshot({path:process.env.UI_MOBILE_SCREENSHOT,fullPage:true});}
});

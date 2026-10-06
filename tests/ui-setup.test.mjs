import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';

const ui=join(dirname(fileURLToPath(import.meta.url)),'..','ui');
const token='setup-fixture';
async function body(request){let raw='';for await(const chunk of request)raw+=chunk;return JSON.parse(raw||'{}');}

test('verified Fly and Modal sign-ins advance once; a closed setup ignores a late sign-in',async t=>{
  const auth={fly:{id:'fly',connected:false,loginAvailable:true},modal:{id:'modal',connected:false,loginAvailable:true}};
  const calls=[];let heldModal,resolveModalRequested,cancels=0,goalPosts=0;
  const modalRequest=new Promise(resolve=>{resolveModalRequested=resolve;});
  const streams=new Set();
  const server=createServer(async(request,response)=>{
    const route=new URL(request.url,'http://localhost').pathname;
    const send=(code,value)=>response.writeHead(code,{'Content-Type':'application/json'}).end(JSON.stringify(value));
    if(route==='/favicon.ico'){response.writeHead(204).end();return;}
    if(route.startsWith('/api/')&&request.headers.authorization!==`Bearer ${token}`){send(401,{error:'Unauthorized'});return;}
    if(route==='/api/events'){response.writeHead(200,{'Content-Type':'text/event-stream'});streams.add(response);request.on('close',()=>streams.delete(response));return;}
    if(route==='/api/state'){send(200,{version:1,conversation:[],goals:[],providers:[],spend:{},swarm:{status:'idle'}});return;}
    if(route==='/api/budget/default'){send(200,{amount:50,currency:'USD',allowanceUsd:50,usdPerUnit:1});return;}
    if(route==='/api/voice/capabilities'){send(200,{transcribe:false,speak:false,ready:false,reason:'Voice is unavailable.'});return;}
    if(route==='/api/providers/discover'){send(200,[]);return;}
    if(route==='/api/auth/state'){send(200,auth);return;}
    if(route==='/api/auth/cancel'){cancels++;send(200,{cancelled:true});return;}
    if(route==='/api/auth/connect'){
      const {id}=await body(request);calls.push(id);
      if(id==='modal'&&heldModal===true){heldModal=response;resolveModalRequested();return;}
      auth[id].connected=true;send(200,auth[id]);return;
    }
    if(route==='/api/chat'){goalPosts++;send(202,{id:'unexpected'});return;}
    const file={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/styles.css':'styles.css','/stage.mjs':'stage.mjs','/movie-player.mjs':'movie-player.mjs','/movie-manifest.json':'movie-manifest.json','/goal-input.mjs':'goal-input.mjs','/voice-capture.mjs':'voice-capture.mjs'}[route];
    if(file){response.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':file.endsWith('.json')?'application/json':'text/javascript'}).end(await readFile(join(ui,file)));return;}
    response.writeHead(404).end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{for(const stream of streams)stream.end();server.close();});
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const url=`http://127.0.0.1:${server.address().port}/#token=${token}`;
  const page=await browser.newPage();
  await page.goto(url);
  await page.getByRole('button',{name:'Start'}).click();
  await page.getByRole('heading',{name:'Get the team ready'}).waitFor();
  await page.locator('#fly-connect').click();
  assert.equal(await page.locator('#setup-dialog').isVisible(),true);
  await page.locator('#modal-connect').click();
  await page.getByRole('dialog',{name:'Advanced'}).waitFor();
  assert.equal(await page.locator('#setup-dialog').isVisible(),false);
  assert.equal(await page.locator('#setup-continue').count(),0);
  assert.deepEqual(calls,['fly','modal']);
  assert.equal(goalPosts,0);

  auth.fly.connected=false;auth.modal.connected=false;heldModal=true;
  const late=await browser.newPage();
  await late.goto(url);
  await late.getByRole('button',{name:'Start'}).click();
  await late.getByRole('heading',{name:'Get the team ready'}).waitFor();
  await late.locator('#fly-connect').click();
  await late.locator('#modal-connect').click();
  await modalRequest;
  await late.getByRole('button',{name:'Close setup'}).click();
  auth.modal.connected=true;sendHeld();
  await late.waitForFunction(()=>!document.getElementById('setup-dialog').open);
  await late.waitForTimeout(100);
  assert.equal(await late.locator('#advanced-dialog').isVisible(),false);
  assert.equal(cancels,1);
  assert.deepEqual(calls,['fly','modal','fly','modal']);
  assert.equal(goalPosts,0);

  function sendHeld(){const response=heldModal;heldModal=undefined;response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(auth.modal));}
});

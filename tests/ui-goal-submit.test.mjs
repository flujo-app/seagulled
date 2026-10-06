import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';

const ui=join(dirname(fileURLToPath(import.meta.url)),'..','ui');
const files=new Set(['index.html','app.js','styles.css','stage.mjs','movie-player.mjs','movie-manifest.json','goal-input.mjs','voice-capture.mjs']);

test('a held quote admits one Go while Pause, Stop, or quote failure preserves intent without a late POST',async t=>{
  const server=createServer(async(req,res)=>{
    const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
    if(!files.has(name)){res.writeHead(404).end();return;}
    const type=name.endsWith('.css')?'text/css':name.endsWith('.json')?'application/json':name.endsWith('.html')?'text/html':'text/javascript';
    res.writeHead(200,{'Content-Type':type}).end(await readFile(join(ui,name)));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>server.close());
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  async function pageForScenario(){
    const page=await browser.newPage({locale:'en-US'});
    await page.addInitScript(()=>{
      const state={version:1,conversation:[],goals:[{id:'existing',text:'Existing work.',status:'running',budget:{amount:50,currency:'USD',allowanceUsd:50},tasks:[{id:'task',status:'running'}]}],providers:[{id:'openai',name:'OpenAI API',connected:true,available:true,detail:'Fixture provider.'}],spend:{reportedUsd:0,estimatedUsd:0,pendingUsd:0},swarm:{status:'working',admissionPaused:false}};
      let notify=()=>{};
      const fixture={pendingQuotes:[],chatCalls:[],controls:[],releaseQuote(){this.pendingQuotes.shift()?.resolve({amount:200000,currency:'COP',allowanceUsd:50,usdPerUnit:0.00025,quoteAsOf:new Date(Date.now()-3600000).toISOString(),quoteSource:'https://www.exchangerate-api.com'});},rejectQuote(){this.pendingQuotes.shift()?.reject(new Error('Fixture quote unavailable.'));}};
      window.fixture=fixture;
      window.seagulled={
        state:async()=>structuredClone(state),
        defaultBudget:currency=>currency==='USD'?Promise.resolve({amount:50,currency:'USD',allowanceUsd:50,usdPerUnit:1,quoteAsOf:null,quoteSource:null}):new Promise((resolve,reject)=>fixture.pendingQuotes.push({resolve,reject})),
        voiceCapabilities:async()=>({transcribe:false,speak:false,ready:false,status:'unavailable',reason:'Fixture voice unavailable.'}),
        authState:async()=>({fly:{connected:true,available:true},modal:{connected:true,available:true}}),
        discover:async()=>state.providers,
        chat:async(text,options)=>{fixture.chatCalls.push({text,options});return {id:'new'};},
        controlSwarm:async action=>{fixture.controls.push(action);state.goals[0].status=action==='pause'?'paused':action==='stop'?'stopped':'running';state.swarm.status=action==='pause'?'paused':action==='stop'?'idle':'working';state.swarm.admissionPaused=action==='pause';notify({type:'state',state:structuredClone(state)});return structuredClone(state);},
        stopSpeaking:async()=>({stopped:true}),onEvent:callback=>{notify=callback;return()=>{notify=()=>{};}}
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(()=>document.getElementById('budget-amount').value==='50');
    await page.getByRole('button',{name:'Start'}).click();
    await page.getByLabel('Voice is unavailable. Enter one sentence here.').waitFor();
    return page;
  }
  for(const action of [null,'pause','stop','quote-error']){
    const page=await pageForScenario();
    await page.locator('#budget-currency').selectOption('COP');
    await page.waitForFunction(()=>window.fixture.pendingQuotes.length===1);
    await page.locator('#fallback-goal').fill('Build the next game.');
    await page.evaluate(()=>{const go=document.getElementById('fallback-go');go.click();go.click();});
    assert.equal(await page.locator('#fallback-go').isDisabled(),true);
    if(action==='pause'||action==='stop'){await page.getByRole('button',{name:action==='pause'?'Pause':'Stop'}).click();await page.waitForFunction(expected=>window.fixture.controls.includes(expected),action);}
    await page.evaluate(fail=>fail?window.fixture.rejectQuote():window.fixture.releaseQuote(),action==='quote-error');
    await page.waitForFunction(()=>!document.getElementById('fallback-go').disabled);
    await page.waitForTimeout(100);
    const calls=await page.evaluate(()=>window.fixture.chatCalls);
    assert.equal(calls.length,action?0:1,`${action||'Go'} must not duplicate or submit after interruption`);
    if(action){assert.equal(await page.locator('#fallback-goal').inputValue(),'Build the next game.');assert.equal(await page.locator('#action').getAttribute('data-action'),'go');}
    else {
      assert.equal(calls[0].text,'Build the next game.');
      assert.equal(calls[0].options.executionMode,'company');
      assert.equal(calls[0].options.providerId,'openai');
      assert.equal(Object.hasOwn(calls[0].options,'modelId'),false);
    }
    await page.close();
  }
});

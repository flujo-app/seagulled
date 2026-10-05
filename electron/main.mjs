import {app, BrowserWindow, ipcMain, shell, safeStorage} from 'electron';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdirSync} from 'node:fs';
import {createRuntime, defaultDataDir} from '../src/runtime.mjs';
import {createServer} from '../src/server.mjs';
import {ProviderManager} from '../src/providers/index.mjs';
import {createCredentialStore} from './credentials.mjs';
import {validateConnectPayload,validateGoalOptions,validateVoiceInput} from './input.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const externalHosts = new Set(['modal.com','www.modal.com','auth.modal.com','anthropic.com','console.anthropic.com','claude.ai','openai.com','platform.openai.com','chatgpt.com','github.com','accounts.google.com','www.exchangerate-api.com']);
let runtime;
let serverHandle;
let mainWindow;
let unsubscribe;
let quitting=false;

function allowExternal(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && externalHosts.has(url.hostname);
  } catch { return false; }
}
function assertString(value, label, max = 20000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} is invalid.`);
  return value;
}
function assertId(value) { return assertString(value, 'ID', 128); }
async function invoke(_event, method, args = []) {
  if (_event.sender !== mainWindow?.webContents || _event.sender.isDestroyed()) throw new Error('Request came from an unknown window.');
  if (!Array.isArray(args)) throw new Error('Request is invalid.');
  switch(method) {
    case 'state': return runtime.snapshot();
    case 'defaultBudget': {
      const currency=assertString(args[0] ?? 'USD','Currency',3).toUpperCase();
      if(!/^[A-Z]{3}$/.test(currency))throw new Error('Currency is invalid.');
      return runtime.defaultBudget(currency);
    }
    case 'chat': {
      return runtime.chat(assertString(args[0], 'Message'),validateGoalOptions(args[1] || {}));
    }
    case 'authState': return runtime.authState();
    case 'authConnect': {
      const id=args[0]?.id;if(id!=='fly'&&id!=='modal')throw new Error('Unknown sign-in.');
      return runtime.authConnect({id});
    }
    case 'authCancel': return runtime.authCancel();
    case 'voiceCapabilities': return runtime.voiceCapabilities();
    case 'transcribeAudio': return runtime.transcribeAudio(validateVoiceInput(args[0]));
    case 'speak': return runtime.speak(assertString(args[0],'Speech',1200));
    case 'stopSpeaking': return runtime.stopSpeaking();
    case 'updateGoal': {
      const patch=args[1];
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Goal changes are invalid.');
      const text=assertString(patch.text,'Goal text',4000);
      return runtime.updateGoal(assertId(args[0]),{text,...validateGoalOptions(patch)});
    }
    case 'controlGoal': {
      const action=args[1];
      if (!['pause','resume','stop'].includes(action)) throw new Error('Goal action is invalid.');
      return runtime.controlGoal(assertId(args[0]),action);
    }
    case 'controlSwarm': {
      const action=args[0];
      if (!['pause','resume','stop'].includes(action)) throw new Error('Team action is invalid.');
      return runtime.controlSwarm(action);
    }
    case 'readArtifact': {
      const index=args[2];
      if (!Number.isInteger(index) || index<0 || index>99) throw new Error('Artifact number is invalid.');
      return runtime.readArtifact(assertId(args[0]),assertId(args[1]),index);
    }
    case 'discover': return runtime.discover();
    case 'connect': return runtime.connect(validateConnectPayload(args[0]));
    case 'disconnect': return runtime.disconnect(assertId(args[0]));
    default: throw new Error('Unknown request.');
  }
}
function createWindow() {
  const window = new BrowserWindow({
    width:1190,height:780,minWidth:750,minHeight:540,
    backgroundColor:'#f8f7f3',
    show:false,
    webPreferences:{
      preload:join(here,'preload.cjs'),
      contextIsolation:true,
      sandbox:true,
      nodeIntegration:false,
      webSecurity:true,
      devTools:!app.isPackaged
    }
  });
  const ownAudio=(contents,permission,details)=>contents===window.webContents && permission==='media' && Array.isArray(details?.mediaTypes) && details.mediaTypes.length>0 && details.mediaTypes.every(type=>type==='audio');
  window.webContents.session.setPermissionRequestHandler((contents,permission,callback,details)=>callback(ownAudio(contents,permission,details)));
  window.webContents.session.setPermissionCheckHandler((contents,permission,_origin,details)=>contents===window.webContents && permission==='media' && details?.mediaType!=='video');
  window.once('ready-to-show',()=>window.show());
  window.webContents.setWindowOpenHandler(({url})=>{if(allowExternal(url))void shell.openExternal(url);return {action:'deny'};});
  window.webContents.on('will-navigate',(event,url)=>{if(url!==window.webContents.getURL()){event.preventDefault();if(allowExternal(url))void shell.openExternal(url);}});
  window.on('closed',()=>{if(mainWindow===window)mainWindow=null;});
  window.loadFile(join(here,'../ui/index.html'));
  return window;
}
async function start() {
  const dataDir=defaultDataDir();
  mkdirSync(join(dataDir,'providers'),{recursive:true,mode:0o700});
  const helpers=process.env.SEAGULLED_HELPERS_DIR
    ? resolve(process.env.SEAGULLED_HELPERS_DIR)
    : app.isPackaged&&process.platform==='win32'&&process.arch==='x64'
      ? join(process.resourcesPath,'helpers') : null;
  const providers=new ProviderManager({dataDir:join(dataDir,'providers'),credentialStore:createCredentialStore({dataDir,safeStorage}),...(helpers?{helperRoot:helpers}:{})});
  runtime=createRuntime({dataDir,providers});
  serverHandle=await createServer({runtime});
  ipcMain.handle('seagulled:invoke',invoke);
  unsubscribe=runtime.subscribe(event=>{
    if(mainWindow && !mainWindow.isDestroyed())mainWindow.webContents.send('seagulled:event',event);
  });
  mainWindow=createWindow();
}
app.whenReady().then(start).catch(error=>{
  console.error('Seagulled could not start:',error?.message || error);
  app.quit();
});
app.on('activate',()=>{if(!mainWindow && runtime)mainWindow=createWindow();});
app.on('before-quit',event=>{
  if (quitting) return;
  event.preventDefault();quitting=true;
  try{unsubscribe?.();}catch{}
  Promise.resolve().then(async()=>{
    try{await serverHandle?.close?.();}catch{}
    try{await runtime?.close?.();}catch{}
  }).finally(()=>app.quit());
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});

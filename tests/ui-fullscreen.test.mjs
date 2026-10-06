import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../electron/main.mjs',import.meta.url),'utf8');
const html=readFileSync(new URL('../ui/index.html',import.meta.url),'utf8');
const match=source.match(/function createWindow\(\) \{[\s\S]*?\n\}\nasync function start\(\)/);
assert.ok(match,'Electron createWindow source remains available for isolated behavior test');
const createWindowSource=match[0].replace(/\nasync function start\(\)$/,'');

function fixture(platform='win32'){
  const created=[];
  let quits=0;
  class BrowserWindow {
    constructor(options){
      this.options=options;this.fullscreen=options.fullscreen;this.events=new Map();this.shown=false;
      this.webContents={events:new Map(),session:{setPermissionRequestHandler(){},setPermissionCheckHandler(){}},
        on:(name,handler)=>this.webContents.events.set(name,handler),
        setWindowOpenHandler(){},getURL:()=> 'file:///seagulled/ui/index.html'};
      created.push(this);
    }
    once(name,handler){this.events.set(name,handler);}
    on(name,handler){this.events.set(name,handler);}
    show(){this.shown=true;}
    isFullScreen(){return this.fullscreen;}
    setFullScreen(value){this.fullscreen=value;}
    loadFile(path){this.loadedFile=path;}
  }
  const context={BrowserWindow,join,here:'C:/app/electron',
    app:{isPackaged:true,quit:()=>{quits++;}},
    shell:{openExternal(){}},allowExternal:()=>false,
    process:{platform},mainWindow:null};
  const createWindow=runInNewContext(`${createWindowSource}\ncreateWindow`,context);
  const window=createWindow();
  const send=(key,modifiers={})=>{
    let prevented=false;
    window.webContents.events.get('before-input-event')({preventDefault(){prevented=true;}},
      {type:'keyDown',key,isAutoRepeat:false,control:false,meta:false,shift:false,alt:false,...modifiers});
    return prevented;
  };
  return {window,send,quits:()=>quits,created};
}

test('desktop starts fullscreen and offers F11 window mode without consuming dialog Escape',()=>{
  const f=fixture();
  assert.equal(f.created.length,1);
  assert.equal(f.window.options.fullscreen,true);
  assert.equal(f.window.options.show,false);
  assert.equal(f.window.options.webPreferences.contextIsolation,true);
  assert.equal(f.window.options.webPreferences.sandbox,true);
  assert.equal(f.window.options.webPreferences.nodeIntegration,false);
  assert.equal(f.window.options.webPreferences.webSecurity,true);
  f.window.events.get('ready-to-show')();
  assert.equal(f.window.shown,true);
  assert.equal(f.send('Escape'),false);
  assert.equal(f.window.isFullScreen(),true);
  assert.equal(f.send('F11'),true);
  assert.equal(f.window.isFullScreen(),false);
  assert.equal(f.send('F11',{isAutoRepeat:true}),false);
  assert.equal(f.window.isFullScreen(),false);
  assert.equal(f.send('F11'),true);
  assert.equal(f.window.isFullScreen(),true);
  assert.match(html,/F11 toggles fullscreen\. Ctrl\+Q quits/);
});

test('window-scoped quit shortcut uses the platform modifier',()=>{
  const win=fixture('win32');
  assert.equal(win.send('q',{control:true}),true);
  assert.equal(win.quits(),1);
  assert.equal(win.send('q',{meta:true}),false);
  assert.equal(win.quits(),1);
  const mac=fixture('darwin');
  assert.equal(mac.send('q',{meta:true}),true);
  assert.equal(mac.quits(),1);
  assert.equal(mac.send('q',{control:true}),false);
  assert.equal(mac.quits(),1);
  assert.equal(mac.send('Escape'),false);
});

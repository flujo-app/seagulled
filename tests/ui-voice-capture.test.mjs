import test from 'node:test';
import assert from 'node:assert/strict';
import {wavFromPcm,UtteranceGate,VoiceCapture} from '../ui/voice-capture.mjs';

test('capture encodes bounded mono PCM16 at 16 kHz',()=>{
  const samples=new Float32Array(48000);samples.fill(.25);
  const wav=wavFromPcm([samples],48000);
  const view=new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.subarray(0,4)),'RIFF');
  assert.equal(view.getUint16(22,true),1);
  assert.equal(view.getUint32(24,true),16000);
  assert.equal(view.getUint16(34,true),16);
  assert.equal(wav.length,44+16000*2);
  assert.throws(()=>wavFromPcm([new Float32Array(48000*31)],48000),/30 seconds/);
});

test('one voiced utterance ends after silence; silence alone never completes',()=>{
  const gate=new UtteranceGate(16000);
  const quiet=new Float32Array(1600),voiced=new Float32Array(1600).fill(.2);
  for(let i=0;i<20;i++)assert.equal(gate.push(quiet).done,false);
  assert.equal(gate.push(voiced).heardVoice,false);
  assert.equal(gate.push(voiced).heardVoice,true);
  for(let i=0;i<10;i++)assert.equal(gate.push(quiet).done,false);
  assert.equal(gate.push(voiced).done,false);
  for(let i=0;i<19;i++)assert.equal(gate.push(quiet).done,false);
  assert.equal(gate.push(quiet).done,true);
  gate.clear();assert.equal(gate.samples,0);
});

test('cancel during microphone permission releases a late stream',async()=>{
  const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  const oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
  let grant,stopped=false;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:()=>new Promise(resolve=>{grant=resolve;})}}});
  Object.defineProperty(globalThis,'window',{configurable:true,value:{AudioWorkletNode:class {}}});
  try{
    const capture=new VoiceCapture();const listening=capture.start();
    capture.cancel();grant({getTracks:()=>[{stop(){stopped=true;}}]});
    await assert.rejects(listening,/Listening canceled/);
    assert.equal(stopped,true);
  }finally{
    if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else delete globalThis.navigator;
    if(oldWindow)Object.defineProperty(globalThis,'window',oldWindow);else delete globalThis.window;
  }
});

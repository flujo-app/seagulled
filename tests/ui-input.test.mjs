import test from 'node:test';
import assert from 'node:assert/strict';
import {validateConnectPayload,validateGoalOptions,validateVoiceInput} from '../electron/input.mjs';

test('native bridge preserves explicit worker permission and rejects ambiguous values',()=>{
  assert.deepEqual(validateConnectPayload({id:'openai',method:'key',key:'test-key',fleetAllowed:true}),{id:'openai',method:'key',key:'test-key',fleetAllowed:true});
  assert.deepEqual(validateConnectPayload({id:'openai',method:'key',fleetAllowed:false}),{id:'openai',method:'key',fleetAllowed:false});
  assert.deepEqual(validateConnectPayload({id:'modal',method:'key',key:'test-token'}),{id:'modal',method:'key',key:'test-token'});
  assert.throws(()=>validateConnectPayload({id:'openai',method:'key',fleetAllowed:'true'}),/Worker permission is invalid/);
});

test('native bridge preserves bounded team and currency settings',()=>{
  assert.deepEqual(validateGoalOptions({budget:{amount:25000,currency:'COP'},maxWorkers:4,conversationsPerWorker:2,privateH100:true}),{budget:{amount:25000,currency:'COP'},maxWorkers:4,conversationsPerWorker:2,privateH100:true});
  assert.deepEqual(validateGoalOptions({maxWorkers:2,conversationsPerWorker:3}),{maxWorkers:2,conversationsPerWorker:3});
  assert.deepEqual(validateGoalOptions(),{maxWorkers:5,conversationsPerWorker:5});
  assert.deepEqual(validateGoalOptions({executionMode:'company',providerId:'codex'}),{maxWorkers:5,conversationsPerWorker:5,executionMode:'company',providerId:'codex'});
  assert.throws(()=>validateGoalOptions({maxWorkers:100}),/Workers/);
  assert.throws(()=>validateGoalOptions({budget:{amount:1,currency:'US$'}}),/Budget/);
  assert.throws(()=>validateGoalOptions({privateH100:'true'}),/Private H100/);
  assert.throws(()=>validateGoalOptions({executionMode:'local'}),/Company execution mode/);
  assert.throws(()=>validateGoalOptions({providerId:'native-unverified'}),/Goal provider/);
  assert.throws(()=>validateGoalOptions({providerId:'openai',privateH100:true}),/one inference route/);
});

test('native bridge accepts only bounded WAV payloads',()=>{
  const recording={mimeType:'audio/wav',dataBase64:'UklGRg==',language:'en-US'};
  assert.deepEqual(validateVoiceInput(recording),recording);
  assert.throws(()=>validateVoiceInput({...recording,mimeType:'audio/webm'}),/Recording/);
  assert.throws(()=>validateVoiceInput({...recording,dataBase64:'x'.repeat(2_800_001)}),/Recording/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {validateConnectPayload} from '../electron/input.mjs';

test('native bridge preserves explicit worker permission and rejects ambiguous values',()=>{
  assert.deepEqual(validateConnectPayload({id:'openai',method:'key',key:'test-key',fleetAllowed:true}),{id:'openai',method:'key',key:'test-key',fleetAllowed:true});
  assert.deepEqual(validateConnectPayload({id:'openai',method:'key',fleetAllowed:false}),{id:'openai',method:'key',fleetAllowed:false});
  assert.deepEqual(validateConnectPayload({id:'modal',method:'key',key:'test-token'}),{id:'modal',method:'key',key:'test-token'});
  assert.throws(()=>validateConnectPayload({id:'openai',method:'key',fleetAllowed:'true'}),/Worker permission is invalid/);
});

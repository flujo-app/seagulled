import test from 'node:test';
import assert from 'node:assert/strict';
import {oneSentence,budgetOptions} from '../ui/goal-input.mjs';

test('spoken goal accepts one sentence without silently truncating another',()=>{
  assert.equal(oneSentence(' Build a game. '),'Build a game.');
  assert.equal(oneSentence('Build a game. Then deploy it.'),null);
  assert.equal(oneSentence(''),null);
});

test('user currency is sent as entered; no client-side FX is invented',()=>{
  assert.deepEqual(budgetOptions({amount:'25000',currency:'COP',workers:'5',conversations:'5',privateH100:true}),{budget:{amount:25000,currency:'COP'},maxWorkers:5,conversationsPerWorker:5,privateH100:true});
  assert.deepEqual(budgetOptions({amount:'',currency:'COP',workers:5,conversations:5}),{maxWorkers:5,conversationsPerWorker:5,privateH100:false});
  assert.throws(()=>budgetOptions({amount:'-5',currency:'USD',workers:5,conversations:5}),/positive budget/);
  assert.throws(()=>budgetOptions({amount:'5',currency:'USD',workers:5,conversations:5,privateH100:'true'}),/Private H100/);
});

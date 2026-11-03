import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {productOperatorSecret} from '../src/product-secret.mjs';

test('private Source mount persists a random secret across restarts',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'seagulled-operator-test-'));
  const file=productOperatorSecret(root),before=readFileSync(file,'utf8');
  assert.match(before,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(productOperatorSecret(root),file);
  assert.equal(readFileSync(file,'utf8'),before);
  assert.equal(path.relative(root,file),path.join('source-secrets','operator-secret'));
});

test('incomplete secret is preserved rather than silently replaced',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'seagulled-operator-test-'));
  const file=productOperatorSecret(root);
  writeFileSync(file,'');
  assert.throws(()=>productOperatorSecret(root),/incomplete/);
  assert.equal(readFileSync(file,'utf8'),'');
});

test('hard-linked mounts cannot initialize Source',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'seagulled-operator-test-'));
  const file=productOperatorSecret(root);
  linkSync(file,path.join(root,'second-link'));
  assert.throws(()=>productOperatorSecret(root),/regular owned file/);
});

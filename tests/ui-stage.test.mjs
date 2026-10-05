import test from 'node:test';
import assert from 'node:assert/strict';
import {sceneFor} from '../ui/stage.mjs';

test('movie moods follow interaction and real task state',()=>{
  assert.equal(sceneFor(), 'idle');
  assert.equal(sceneFor({mode:'listening'}),'listening');
  assert.equal(sceneFor({mode:'speaking',goal:{status:'running'}}),'speaking');
  assert.equal(sceneFor({goal:{status:'queued'}}),'headphones');
  const running={status:'running',tasks:[{status:'running'}]};
  assert.equal(sceneFor({goal:running,workingMs:1000}),'work');
  assert.equal(sceneFor({goal:running,workingMs:9000}),'golf');
  assert.equal(sceneFor({goal:running,workingMs:15000}),'away');
  assert.equal(sceneFor({goal:{status:'paused',tasks:[{status:'running'}]},workingMs:15000}),'idle');
  assert.equal(sceneFor({goal:{status:'completed'}}),'critique');
});

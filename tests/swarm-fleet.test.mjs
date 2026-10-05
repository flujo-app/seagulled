import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fleetStatus, runFleetLeaf } from '../src/swarm/fleet.mjs';
import { buildSpecs } from '../upstream/swarm-teams/template/flows.mjs';

test('Seagulled can install a bounded Fly team without changing upstream defaults', () => {
  const [agent, team] = buildSpecs({ model: 'fictional', availableServers: [], limits: { agentTurns: 6, leadTurns: 12, concurrency: 1 } });
  const [agentDefault, teamDefault] = buildSpecs({ model: 'fictional', availableServers: [] });
  assert.equal(team.nodes.find((node) => node.key === 'lead').maxTurns, 12);
  assert.equal(agent.nodes.find((node) => node.key === 'agent').maxTurns, 6);
  assert.equal(team.nodes.find((node) => node.key === 'agents').concurrencyLimit, 1);
  assert.equal(agentDefault.nodes.find((node) => node.key === 'agent').maxTurns, 200);
  assert.equal(teamDefault.nodes.find((node) => node.key === 'agents').concurrencyLimit, 10);
});

test('disabled model preflight makes no boot workspace or Fly intent', async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url.startsWith('/api/workspaces')) {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"workspaces":[]}');
    } else {
      response.writeHead(404); response.end('{"error":"workspace disabled"}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = mkdtempSync(path.join(tmpdir(), 'seagulled-fleet-preflight-'));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = path.join(root, 'profile.json');
  writeFileSync(profile, JSON.stringify({ supervisor: { origin }, provisioner: { kind: 'fly', flujoCloudPath: root },
    model: { name: 'fictional', baseUrl: `${origin}/v1`, apiKey: 'fictional' } }));
  const previous = process.env.SEAGULLED_FLEET_PROFILE;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.SEAGULLED_FLEET_PROFILE = profile;
  delete process.env.OPENAI_API_KEY;
  try {
    const status = await fleetStatus();
    assert.equal(status.available, false);
    assert.match(status.detail, /HTTP 404/);
    assert.equal('config' in status, false, 'private profile never enters public state');
    const result = await runFleetLeaf({ goal: { id: 'fictional-goal', text: 'fictional' }, task: 'fictional',
      dataDir: root, maxUsd: 2 });
    assert.equal(result.available, false);
    assert.equal(existsSync(path.join(root, 'fleet', 'fictional-goal')), false);
    assert.deepEqual(requests, ['/api/workspaces', '/v1/models', '/api/workspaces', '/v1/models']);
    const fingerprint = createHash('sha256').update(origin).digest('hex').slice(0, 24);
    const holds = path.join(root, 'fleet'); mkdirSync(holds);
    writeFileSync(path.join(holds, `source-admission-${fingerprint}.json`), JSON.stringify({ state: 'held' }));
    const held = await fleetStatus({ dataDir: root });
    assert.equal(held.available, false);
    assert.match(held.detail, /held after a confirmed failure/);
    assert.equal((await runFleetLeaf({ goal: { id: 'another-goal', text: 'fictional' }, task: 'fictional',
      dataDir: root, maxUsd: 2 })).available, false);
    assert.equal(requests.length, 4, 'a held source is not re-probed or mutated');
  } finally {
    if (previous === undefined) delete process.env.SEAGULLED_FLEET_PROFILE;
    else process.env.SEAGULLED_FLEET_PROFILE = previous;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

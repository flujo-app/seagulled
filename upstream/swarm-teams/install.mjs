// Installs the swarm-team template into one FLUJO workspace. Idempotent and additive:
// it creates or updates only its own model row, its `fleet` MCP server and its three flows.
import { bootSpec, buildSpecs, FLOW_NAMES } from './template/flows.mjs';
import { validateSpecialists } from './template/specialists.mjs';

export const MODEL_ID = 'swarm-model';

/**
 * @param client   FlujoClient bound to the target workspace
 * @param model    { baseUrl, apiKey, name, contextWindow } of an OpenAI-compatible endpoint,
 *                 or { id } to bind the flows to a model that already exists in the workspace
 * @param fleet    { url, token } of the fleet controller's MCP endpoint, so agents can reach the swarm
 */
export async function installTemplate(client, { model, fleet, browser = true, bootOnly = false, enableBundled = false, limits, specialists } = {}) {
  if (specialists) validateSpecialists(specialists, model?.id || MODEL_ID);
  const created = await client.ensureWorkspace();
  if (enableBundled) {
    // A cloned Worker arrives with its bundled tool servers switched off; start the Worker's own.
    // Cloned entries keep the source machine's paths and environment. Point each at the
    // copy that ships inside the worker image; FLUJO injects the runtime environment itself.
    const wanted = ['flujo', 'filesystem', 'bash', ...(browser ? ['browser'] : [])];
    for (const server of (await client.servers()).filter((entry) => wanted.includes(entry.name))) {
      const root = `/app/mcp-servers/${server.name}`;
      await client.expect('PUT', `/api/mcp/servers/${server.name}`, { ...server, disabled: false, env: {}, cwd: root, rootPath: root });
    }
  }
  let modelId = model.id;
  if (!modelId) {
    modelId = MODEL_ID;
    await client.upsertModel({
      id: MODEL_ID, name: model.name, displayName: 'swarm-model', description: 'Model for the swarm-team template.',
      ApiKey: model.apiKey, baseUrl: model.baseUrl, provider: model.provider ?? 'ollama', adapter: model.adapter ?? 'openai',
      contextWindow: model.contextWindow, supportsTools: true,
      ...((model.adapter === 'codex-cli' || model.provider === 'codex') ? {} : { temperature: '0.2' }),
    });
  }
  if (bootOnly) {
    const flow = await client.saveFlowSpec(bootSpec(modelId));
    return { workspace: client.workspace, workspaceCreated: created, modelId, flows: { [flow.name]: flow.id } };
  }
  if (fleet) {
    await client.upsertServer({
      name: 'fleet', transport: 'streamable', serverUrl: fleet.url,
      headers: { Authorization: { value: `Bearer ${fleet.token}`, metadata: { isSecret: true } } },
      disabled: false, exposeAsMcpServer: false, enableMcpApps: false,
    });
  }
  let servers = await client.servers();
  const browserServer = servers.find((server) => server.name === 'browser');
  if (browser && browserServer?.disabled) {
    await client.upsertServer({ ...browserServer, disabled: false }).catch(() => undefined);
    servers = await client.servers();
  }
  const availableServers = servers.filter((server) => !server.disabled).map((server) => server.name);
  const flows = [];
  for (const spec of buildSpecs({ model: modelId, availableServers, limits, specialists })) flows.push(await client.saveFlowSpec(spec));
  return { workspace: client.workspace, workspaceCreated: created, modelId, availableServers,
    flows: Object.fromEntries(flows.map((flow) => [flow.name, flow.id])), names: FLOW_NAMES };
}

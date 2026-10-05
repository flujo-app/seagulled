// Bounded, authenticated Machines API inventory for product-owned 6PN checks.
// A Fly CLI app-create JSON response does not attest the selected network.
const API = 'https://api.machines.dev/v1';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_APPS = 2048;
const ORG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const APP = /^[a-z][a-z0-9-]{2,62}$/;
const APP_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PRODUCT_NETWORK = /^[a-z][a-z0-9-]{2,62}$/;
const API_NETWORK = /^[A-Za-z][A-Za-z0-9-]{0,62}$/;
const validOwnerMarker = (kind, marker) => typeof marker === 'string'
  && (kind === 'relay' ? /^SEAGULLED_RELAY_OWNER_[A-F0-9]{16,64}$/
    : /^FLUJO_CLOUD_OWNER_[A-F0-9]{16,64}$/).test(marker);
const membershipError = (message, code = 'NETWORK_MEMBERSHIP') =>
  Object.assign(new Error(message), { code });

export function assertProductNetwork(network) {
  if (typeof network !== 'string' || !PRODUCT_NETWORK.test(network) || network === 'default') {
    throw new Error('A valid explicit product-private Fly network is required.');
  }
  return network;
}

async function boundedJson(response) {
  if (response.status !== 200 || response.redirected || !response.body) {
    throw new Error('Fly organization network inventory is unavailable.');
  }
  const contentLength = response.headers.get('content-length');
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
  const identityEncoding = !encoding || encoding === 'identity';
  if (identityEncoding && contentLength !== null && !/^\d+$/.test(contentLength)) {
    throw new Error('Fly organization network inventory length is invalid.');
  }
  const length = contentLength === null ? null : Number(contentLength);
  if (identityEncoding && length !== null && length > MAX_BYTES) {
    throw new Error('Fly organization network inventory is oversized.');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('Fly organization network inventory is oversized.');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  if (identityEncoding && length !== null && length !== bytes) {
    throw new Error('Fly organization network inventory length changed.');
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
  catch { throw new Error('Fly organization network inventory is malformed.'); }
  return value;
}

export async function readFlyOrgApps({ org, token, fetchImpl = fetch }) {
  if (typeof org !== 'string' || !ORG.test(org) || typeof token !== 'string'
    || token.length < 20 || token.length > 16_384 || /[\x00-\x1F\x7F]/.test(token)) {
    throw new Error('The selected Fly organization and token are required for network readback.');
  }
  const response = await fetchImpl(`${API}/apps?org_slug=${encodeURIComponent(org)}`, {
    method: 'GET', headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'identity' },
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  const inventory = await boundedJson(response);
  if (!Number.isSafeInteger(inventory?.total_apps) || inventory.total_apps < 0
    || inventory.total_apps > MAX_APPS || !Array.isArray(inventory.apps)
    || inventory.apps.length !== inventory.total_apps) {
    throw new Error('Fly organization network inventory is incomplete.');
  }
  const names = new Set();
  const ids = new Set();
  for (const app of inventory.apps) {
    if (typeof app?.name !== 'string' || !APP.test(app.name)
      || typeof app.id !== 'string' || !APP_ID.test(app.id)
      || typeof app.network !== 'string'
      || !API_NETWORK.test(app.network)
      || names.has(app.name) || ids.has(app.id)) {
      throw new Error('Fly organization network inventory has ambiguous app identity.');
    }
    names.add(app.name);
    ids.add(app.id);
  }
  return inventory.apps;
}

export function assertNetworkVacant(apps, network) {
  assertProductNetwork(network);
  if (!Array.isArray(apps) || apps.some((app) => app.network === network)) {
    throw new Error('The proposed product Fly network already has apps; preserve the goal intent.');
  }
}

export function assertAppNetwork(apps, { app, appId, network }) {
  assertProductNetwork(network);
  if (typeof app !== 'string' || !APP.test(app)
    || typeof appId !== 'string' || !APP_ID.test(appId) || !Array.isArray(apps)) {
    throw new Error('Product Fly app network identity is incomplete.');
  }
  const matches = apps.filter((item) => item.name === app || item.id === appId);
  if (matches.length !== 1 || matches[0].name !== app || matches[0].id !== appId
    || matches[0].network !== network) {
    throw new Error('Product Fly app network identity changed; preserve its private intent.');
  }
  return matches[0];
}

// A goal may have several Worker app creations in flight. Their exact random
// names are durably planned before mutation; only confirmed app IDs count as
// ownership. Pending siblings may coexist during provisioning, but a final
// gate must require every observed member to have its own confirmed receipt.
export function assertPlannedNetworkMembers(apps, network, plans, { allowPending = false } = {}) {
  assertProductNetwork(network);
  if (!Array.isArray(apps) || !plans || typeof plans !== 'object' || Array.isArray(plans)
    || Object.keys(plans).length > 128) throw new Error('Product Fly network membership intent is invalid.');
  const members = apps.filter((app) => app.network === network);
  for (const app of members) {
    const plan = plans[app.name];
    if (!plan || !['relay', 'worker'].includes(plan.kind)
      || !['planned', 'confirmed', 'retired'].includes(plan.state)
      || plan.state === 'retired'
      || plan.state === 'confirmed' && (plan.appId !== app.id
        || !validOwnerMarker(plan.kind, plan.ownerMarker))
      || plan.state === 'planned' && plan.appId) {
      throw membershipError('The product Fly network has an unverified app; preserve the goal intent.');
    }
    if (plan.state === 'planned' && !allowPending) {
      throw membershipError('The product Fly network still has an unconfirmed app plan.', 'NETWORK_PENDING');
    }
  }
  for (const [name, plan] of Object.entries(plans)) {
    if (!APP.test(name) || !plan || !['relay', 'worker'].includes(plan.kind)
      || !['planned', 'confirmed', 'retired'].includes(plan.state)
      || plan.state === 'confirmed' && (!validOwnerMarker(plan.kind, plan.ownerMarker)
        || !members.some((app) => app.name === name && app.id === plan.appId))) {
      throw membershipError('The product Fly network has an incomplete owned app receipt.');
    }
    if (plan.state === 'planned' && !allowPending) {
      throw membershipError('The product Fly network still has an unconfirmed app plan.', 'NETWORK_PENDING');
    }
  }
  return { confirmed: members.filter((app) => plans[app.name].state === 'confirmed').length,
    pending: members.filter((app) => plans[app.name].state === 'planned').length };
}

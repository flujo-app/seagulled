// A replacement sandbox is permitted only after the prior attempt's cleanup is known.
export async function cleanupAttempt(managed, app) {
  try {
    const result = await managed.down(app);
    if (result.state !== 'destroyed') throw new Error(`retirement returned ${result.state ?? 'no state'}`);
    return { confirmed: true, app };
  } catch (error) {
    return { confirmed: false, app, error: error.message };
  }
}

export function attemptError(error, cleanup) {
  return Object.assign(new Error(`${error.message} (${cleanup.app}: ${cleanup.confirmed ? 'retired' : `cleanup unconfirmed: ${cleanup.error}`})`), { cleanup });
}

export async function provisionWithCleanup({ managed, worker, options, turn, retries = 8,
  appName = () => `swarm-${worker.id}-${Date.now().toString(36)}` }) {
  for (let attempt = 0; ; attempt++) {
    const app = appName();
    await turn();
    try { return await managed.up({ ...options, app }); }
    catch (error) {
      const cleanup = await cleanupAttempt(managed, app);
      if (!cleanup.confirmed || attempt >= retries || !/busy|unavailable|snapshot begin failed|HTTP 409/i.test(error.message)) {
        throw attemptError(error, cleanup);
      }
    }
  }
}

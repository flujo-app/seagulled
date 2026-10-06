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

export async function provisionWithCleanup({ managed, worker, options, turn,
  beforeUp, beforeCleanup, onCleanup, retries = 8,
  appName = () => `swarm-${worker.id}-${Date.now().toString(36)}` }) {
  for (let attempt = 0; ; attempt++) {
    await turn();
    const app = await appName();
    await beforeUp?.(app);
    try {
      const result = await managed.up({ ...options, app });
      if (result?.worker !== app || options.org !== undefined && result.org !== options.org) {
        throw new Error('Provisioned Worker identity does not match its exact app plan.');
      }
      return result;
    }
    catch (error) {
      try { await beforeCleanup?.(app); }
      catch (fenceError) {
        throw attemptError(error, { confirmed: false, app, error: fenceError.message });
      }
      const cleanup = await cleanupAttempt(managed, app);
      if (cleanup.confirmed) {
        try { await onCleanup?.(app); }
        catch (journalError) {
          throw attemptError(error, { confirmed: false, app, error: journalError.message });
        }
      }
      if (!cleanup.confirmed || attempt >= retries || !/busy|unavailable|snapshot begin failed|HTTP 409/i.test(error.message)) {
        throw attemptError(error, cleanup);
      }
    }
  }
}

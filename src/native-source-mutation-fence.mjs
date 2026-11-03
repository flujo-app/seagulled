import { randomUUID } from 'node:crypto';

const refused = () => Object.assign(new Error('Native Source mutation fence refused.'), { code: 'NATIVE_SOURCE_MUTATION' });
const unknown = () => Object.assign(new Error('Native Source mutation completion is unconfirmed.'), { code: 'UNKNOWN', unknown: true, outcome: 'unknown' });

/** Keeps the actual Parent commit callback open across a private Source RPC.
 * Losing a grant never implies rollback or safe replay. The owning runtime
 * must durably retain uncertainty before this fence permits that callback to
 * finish. This is not an inference/tool endpoint or a fleet qualification. */
export function createNativeSourceMutationFence({ admission, retainUncertainty, timeoutMs = 30_000, maxPending = 100 } = {}) {
  if (typeof admission?.commit !== 'function' || typeof retainUncertainty !== 'function'
      || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120_000
      || !Number.isInteger(maxPending) || maxPending < 1 || maxPending > 100) throw refused();
  const pending = new Map();
  let closed = false;
  let persistenceFailed = false;
  let uncertain = false;

  const lose = async (item, reason) => {
    if (item.resolved || item.losing) return item.losing;
    item.losing = (async () => {
      if (item.entered) {
        uncertain = true;
        try { await retainUncertainty(item.context, Object.freeze({ ticket: item.ticket, reason })); }
        catch {
          // Do not release a granted fence when its durable hold failed.
          // Admission remains blocked; the owner must recover this pending
          // callback rather than treating a broken persistence path as cleanup.
          persistenceFailed = true; return;
        }
      }
      item.resolved = true; clearTimeout(item.timer);
      item.rejectGrant(unknown()); item.rejectDone(unknown());
    })();
    return item.losing;
  };

  return Object.freeze({
    assertAvailable() { if (closed || uncertain || persistenceFailed) throw unknown(); },
    async begin(context) {
      if (closed || uncertain || persistenceFailed || pending.size >= maxPending) throw refused();
      const ticket = randomUUID();
      let resolveGrant, rejectGrant, resolveDone, rejectDone;
      const grant = new Promise((resolve, reject) => { resolveGrant = resolve; rejectGrant = reject; });
      const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
      // A slow admission may expire before the owning callback starts.
      done.catch(() => {});
      const item = { context, ticket, resolveGrant, rejectGrant, resolveDone, rejectDone,
        entered: false, finishing: false, resolved: false, losing: undefined, timer: undefined, job: undefined };
      pending.set(ticket, item);
      item.timer = setTimeout(() => { void lose(item, 'deadline'); }, timeoutMs);
      item.job = (async () => {
        try {
          await admission.commit(context, async () => {
            if (closed || uncertain || item.resolved || item.losing) throw refused();
            item.entered = true; resolveGrant(ticket);
            await done;
          }, {
            afterCheck() { if (uncertain || item.resolved || item.losing) throw unknown(); },
            async uncertain() {
              await lose(item, 'parent-fence-refused');
              if (persistenceFailed) await new Promise(() => {});
            },
          });
          item.resolved = true; clearTimeout(item.timer);
          return true;
        } catch (error) {
          if (item.entered && !item.losing) {
            // Completion can race OFF or an immutable-owner recheck. It is
            // still possible that Source applied the mutation.
            await lose(item, 'parent-fence-refused');
          }
          rejectGrant(error); throw error;
        } finally {
          if (!persistenceFailed || !item.entered) { clearTimeout(item.timer); pending.delete(ticket); }
        }
      })();
      item.job.catch(() => {});
      return grant;
    },
    async finish(context, ticket, outcome) {
      const item = pending.get(ticket);
      if (closed || !item || item.context !== context || !item.entered || item.finishing || item.resolved || item.losing
          || !['completed', 'failed'].includes(outcome)) throw refused();
      if (outcome === 'failed') {
        await lose(item, 'source-callback-failed');
        throw unknown();
      }
      item.finishing = true; item.resolveDone();
      await item.job;
    },
    async close() {
      if (closed) { if (persistenceFailed) throw unknown(); return; }
      closed = true;
      await Promise.all([...pending.values()].map(item => lose(item, 'transport-closed')));
      if (persistenceFailed) throw unknown();
    },
  });
}

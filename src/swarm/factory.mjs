import path from 'node:path';
import {existsSync, rmSync} from 'node:fs';
import {runFleetLeaf} from './fleet.mjs';

const unavailable = (detail='The FACTORY SDK is unavailable.') => Object.assign(new Error(detail),
  {code:'COMPANY_UNAVAILABLE', reasonCode:'factory', outcome:'not_applied'});
const held = () => Object.assign(new Error('FACTORY retains the original company dispatch. Reconcile it before another run.'),
  {code:'UNKNOWN', unknown:true});

/** Reuse the public, versioned SDK included in the installed application. */
export async function installedFactory(dataDir) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw unavailable();
  try {
    const sdk = await import('flujo-factory');
    if (typeof sdk.FactoryControl !== 'function' || typeof sdk.executeEffect !== 'function') throw unavailable();
    return {FactoryControl:sdk.FactoryControl, executeEffect:sdk.executeEffect, packFactorySdk:sdk.packFactorySdk};
  } catch {throw unavailable();}
}

/** FACTORY owns durable task/effect admission here, and the fleet itself in fleet.mjs. */
export function createFactoryFleetRunner({loadFactory=installedFactory, fleetRunner=runFleetLeaf}={}) {
  return async input => {
    const {goal, dataDir, signal} = input;
    if (!goal || typeof goal.id !== 'string' || !/^[\w-]{1,100}$/.test(goal.id)
      || typeof dataDir !== 'string' || !path.isAbsolute(dataDir)
      || !(goal.unlimited === true && goal.budgetUsd === null || Number.isFinite(goal.budgetUsd) && goal.budgetUsd >= 0)) throw unavailable();
    signal?.throwIfAborted();
    const {FactoryControl, executeEffect} = await loadFactory(dataDir);
    const database = path.join(dataDir, 'factory', goal.id, 'control.sqlite');
    // Retain the original task and effect after restart, including an unknown
    // outcome. Opening another effect must not replay the same company.
    if (existsSync(database)) throw held();
    const control = new FactoryControl(database);
    const stop = () => control.pause();
    let result, failure, nothingStarted = false;
    try {
      control.initialize({mission:goal.text, budgetCents:goal.unlimited === true ? 0 : Math.floor(goal.budgetUsd * 100),
        ...(goal.unlimited === true ? {growthMode:'budget-only'} : {maxCells:goal.maxWorkers + 1, maxDepth:2})});
      control.createTask({taskId:goal.id, projectId:'seagulled', branch:`codex/${goal.id}`,
        specification:{problem:goal.text, acceptance:'Verified requested Worker and child conversation receipts, captured outputs and confirmed owned retirement.',
          baseline:'factory-cloud-lite-fleet',
          goal:goal.text, workers:goal.maxWorkers, conversationsPerWorker:goal.conversationsPerWorker,
          providerId:goal.providerId, model:goal.model, reasoningEffort:goal.reasoningEffort}});
      // Keep Factory authority valid through provisioning, the monitored
      // execution window and exact Worker retirement. Stop still pauses it.
      const lease = control.claimTask(goal.id, 'root', 120 * 60_000);
      signal?.addEventListener('abort', stop, {once:true});
      signal?.throwIfAborted();
      const dispatch = await executeEffect(control, lease, {key:'company-dispatch', kind:'flow_call',
        request:{goalId:goal.id, workers:goal.maxWorkers, conversationsPerWorker:goal.conversationsPerWorker,
          providerId:goal.providerId, model:goal.model, reasoningEffort:goal.reasoningEffort}}, async () => {
        signal?.throwIfAborted();
        try {
          result = await fleetRunner(input);
          // A readiness refusal is not a completed company operation.
          if (result?.available !== true) { nothingStarted = true; throw unavailable(result?.detail); }
          return {state:'ready'};
        } catch (error) {failure=error; throw error;}
      });
      if (failure) throw failure;
      if (!dispatch.dispatched || dispatch.effect.state !== 'succeeded' || !result) throw held();
      return result;
    } finally {
      signal?.removeEventListener('abort', stop);
      control.pause();
      control.close();
      // A refusal starts nothing, so there is nothing to reconcile and the goal can try again once the route is back.
      if (nothingStarted) {
        try { rmSync(path.dirname(database), {recursive:true, force:true, maxRetries:5, retryDelay:200}); }
        catch { /* The refusal stands; a held goal can still be reconciled. */ }
      }
    }
  };
}

export const runFactoryFleet = createFactoryFleetRunner();

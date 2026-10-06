import { CASE_SPECIALISTS_V1 } from '@flujo-app/swarm-teams/template/specialists.mjs';

// Reuse the recovered specialist catalog and its single shared subflow gate.
export const TODD_SPECIALISTS_V1 = Object.freeze({
  ...CASE_SPECIALISTS_V1,
  id: 'todd_specialists_v1',
  roles: CASE_SPECIALISTS_V1.roles.map(role => Object.freeze({
    ...role,
    instructions: role.instructions.replaceAll('Savia', 'the goal owner'),
    mission: role.mission.replaceAll('Savia', 'the goal owner'),
    evidence: role.evidence.replaceAll('Savia', 'the goal owner'),
  })),
});

export function teamProfile(goal) {
  return goal?.workerTopologyVersion === 3 && (goal.conversationsPerWorker ?? 10) === 10
    ? TODD_SPECIALISTS_V1 : undefined;
}

export function specialistStaffingBrief(childCount) {
  if (childCount !== 9) return '';
  return '\nAssign exactly one child to each of these nine roles, with CASE_ID, AGENT_ID, ROLE_ID, ANGLE, TASK and DONE_WHEN in each brief:\n'
    + TODD_SPECIALISTS_V1.roles.map(role => `${role.id}: ${role.mission} ${role.instructions} Evidence: ${role.evidence}`).join('\n')
    + '\nThe verifier must perform a reproducible check against the goal; the adversarial reviewer must seek counterexamples. '
    + 'Preserve their evidence and unresolved findings in the final report. A reviewer agreeing is not independent proof.\n';
}

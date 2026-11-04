// Reuse FACTORY's specialist catalog and its single shared subflow gate.
export function toddSpecialists(catalog) {
  return Object.freeze({
    ...catalog,
    id: 'todd_specialists_v1',
    roles: catalog.roles.map(role => Object.freeze({
      ...role,
      instructions: role.instructions.replaceAll('Savia', 'the goal owner'),
      mission: role.mission.replaceAll('Savia', 'the goal owner'),
      evidence: role.evidence.replaceAll('Savia', 'the goal owner'),
    })),
  });
}

export function teamProfile(goal, catalog) {
  return goal?.workerTopologyVersion === 3 && (goal.conversationsPerWorker ?? 10) === 10 && catalog
    ? toddSpecialists(catalog) : undefined;
}

export function specialistStaffingBrief(childCount, profile) {
  if (childCount !== 9 || !profile) return '';
  return '\nAssign exactly one child to each of these nine roles, with CASE_ID, AGENT_ID, ROLE_ID, ANGLE, TASK and DONE_WHEN in each brief:\n'
    + profile.roles.map(role => `${role.id}: ${role.mission} ${role.instructions} Evidence: ${role.evidence}`).join('\n')
    + '\nThe verifier must perform a reproducible check against the goal; the adversarial reviewer must seek counterexamples. '
    + 'Preserve their evidence and unresolved findings in the final report. A reviewer agreeing is not independent proof.\n';
}

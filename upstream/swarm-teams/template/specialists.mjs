// Optional role briefs for the existing swarm_agent / swarm_team / swarm_supervisor
// FlowSpecs. One subflow node per team remains the aggregate local concurrency gate.
const ID = /^[a-z][a-z0-9_]{0,39}$/;
const SERVER = new Set(['bash', 'filesystem', 'browser', 'flujo', 'fleet']);

export const CASE_SPECIALISTS_V1 = Object.freeze({
  id: 'case_specialists_v1',
  logicalAgentTarget: 100,
  // Each Worker has one team lead and nine specialist subflow conversations.
  topologyTarget: { workers: 10, specialistSubflowsPerWorker: 9 },
  binding: {
    model: 'installed',
    requiredAgentServers: ['filesystem'],
    optionalAgentServers: ['bash', 'browser', 'flujo', 'fleet'],
  },
  roles: [
    { id: 'context_mapper', mission: 'Map the problem and its constraints.',
      instructions: 'Separate reported facts from assumptions. Carry forward Savia\'s intent, urgency and mood assessment without overriding it.',
      evidence: 'List the facts, their source references, uncertainties and missing inputs.' },
    { id: 'evidence_retriever', mission: 'Find primary evidence relevant to one assigned angle.',
      instructions: 'Read the relevant data, logs or sources. Record provenance and the exact observation; do not infer a solution from one source.',
      evidence: 'Provide source or artifact references, method and observed result.' },
    { id: 'hypothesis_builder', mission: 'Develop a distinct explanation or approach.',
      instructions: 'State a falsifiable hypothesis and the smallest discriminating check. Compare it with findings already on the board.',
      evidence: 'Provide the hypothesis, predicted observation, check result and remaining uncertainty.' },
    { id: 'solution_designer', mission: 'Design a resolution for a verified cause.',
      instructions: 'Describe the action, prerequisites, reversibility, expected outcome and possible side effects. Do not execute without authority.',
      evidence: 'Link the cause evidence to the proposed action and acceptance check.' },
    { id: 'execution_operator', mission: 'Perform an authorized, bounded solution step.',
      instructions: 'Check the assigned authority and stop conditions before acting. Preserve receipts and never repeat an UNKNOWN action.',
      evidence: 'Record exact action identity, result, artifacts and rollback or hold state.' },
    { id: 'independent_verifier', mission: 'Verify another agent\'s proposed result.',
      instructions: 'Use independent evidence or a reproducible check. Identify unsupported claims and unfinished work.',
      evidence: 'Report pass, fail or unknown with the check and source references.' },
    { id: 'adversarial_reviewer', mission: 'Challenge the proposed conclusion.',
      instructions: 'Seek counterexamples, conflicting evidence, privacy or safety defects, and mistaken status or spend claims.',
      evidence: 'Report each challenge, its evidence and whether it was resolved.' },
    { id: 'synthesizer', mission: 'Compare reviewed findings for Savia.',
      instructions: 'Prefer verified findings and preserve disagreement. Do not describe queued work as completed.',
      evidence: 'Give a claim-to-evidence table, review outcomes, open questions and recommended next action.' },
    { id: 'handoff_writer', mission: 'Prepare context if human help is required.',
      instructions: 'Prepare a ticket dossier for Savia; do not open a ticket or contact the customer yourself.',
      evidence: 'Include impact, verified facts, attempted actions, holds, owner needed and next status checkpoint.' },
  ],
});

const shortText = (value, label, max = 1200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must be nonempty text under ${max} characters.`);
  return value.trim();
};
const serverList = (value, label) => {
  if (!Array.isArray(value) || value.some((name) => !SERVER.has(name)) || new Set(value).size !== value.length) {
    throw new Error(`${label} must list distinct supported server names.`);
  }
  return value;
};

/** Validate before the installer mutates a workspace. Model/tool binding is shared. */
export function validateSpecialists(profile, model) {
  if (!profile || !ID.test(profile.id ?? '') || profile.binding?.model !== 'installed'
    || !Number.isInteger(profile.logicalAgentTarget) || profile.logicalAgentTarget < 1 || profile.logicalAgentTarget > 100
    || !Number.isInteger(profile.topologyTarget?.workers) || profile.topologyTarget.workers < 1
    || !Number.isInteger(profile.topologyTarget?.specialistSubflowsPerWorker)
    || profile.topologyTarget.specialistSubflowsPerWorker < 1 || profile.topologyTarget.specialistSubflowsPerWorker > 9
    || profile.topologyTarget.workers * (1 + profile.topologyTarget.specialistSubflowsPerWorker) !== profile.logicalAgentTarget) {
    throw new Error('Invalid specialist profile or unsupported model binding.');
  }
  if (typeof model !== 'string' || !model) throw new Error('Specialist profiles require an installed model id.');
  const required = serverList(profile.binding.requiredAgentServers, 'requiredAgentServers');
  const optional = serverList(profile.binding.optionalAgentServers, 'optionalAgentServers');
  if (required.some((name) => optional.includes(name))) throw new Error('Required and optional specialist servers overlap.');
  if (!Array.isArray(profile.roles) || profile.roles.length < 2 || profile.roles.length > 16) {
    throw new Error('A specialist profile needs 2 to 16 roles.');
  }
  const names = new Set();
  for (const role of profile.roles) {
    if (!ID.test(role?.id ?? '') || names.has(role.id)) throw new Error('Specialist role IDs must be unique safe names.');
    names.add(role.id);
    shortText(role.mission, `${role.id} mission`, 300);
    shortText(role.instructions, `${role.id} instructions`);
    shortText(role.evidence, `${role.id} evidence`, 500);
    if (role.model !== undefined || role.servers !== undefined) {
      throw new Error('Per-role model or tool bindings need a shared scheduler; use the installed team binding.');
    }
  }
  for (const id of ['independent_verifier', 'adversarial_reviewer']) {
    if (!names.has(id)) throw new Error(`Specialist profile requires ${id}.`);
  }
  return profile;
}

export function specialistAgentServers(profile, model, availableServers) {
  validateSpecialists(profile, model);
  const required = profile.binding.requiredAgentServers;
  const missing = required.filter((name) => !availableServers.includes(name));
  if (missing.length) throw new Error(`Specialist profile requires connected server(s): ${missing.join(', ')}.`);
  const wanted = new Set([...required, ...profile.binding.optionalAgentServers]);
  return availableServers.filter((name) => wanted.has(name));
}

export function specialistInstructions(profile, model) {
  validateSpecialists(profile, model);
  const catalog = profile.roles.map((role) => `- ${role.id}: ${role.mission} ${role.instructions} Evidence: ${role.evidence}`).join('\n');
  return `SPECIALIST PROFILE ${profile.id}\n` +
    `Target: ${profile.logicalAgentTarget} total conversations across ${profile.topologyTarget.workers} Workers, ` +
    `with one team lead and at most ${profile.topologyTarget.specialistSubflowsPerWorker} specialist subflows per Worker. Savia is separate. ` +
    'This is a planning target, not available capacity; check fleet_info and budget.\n' +
    `All specialist agents use installed model ${model} and one shared connected-tool binding. Role instructions narrow their task; they are not separate tool permissions.\n` +
    `${catalog}\n` +
    'Every agent brief must name CASE_ID, AGENT_ID, ROLE_ID, ANGLE, TASK and DONE_WHEN. Assign one distinct angle per agent. ' +
    'Include an independent verifier and an adversarial reviewer before accepting a synthesis. ' +
    'Post findings with claim, source or artifact reference, method, uncertainty and agent identity. ' +
    'Savia or the customer-facing owner handles human tickets and customer updates; agents only prepare evidence.';
}

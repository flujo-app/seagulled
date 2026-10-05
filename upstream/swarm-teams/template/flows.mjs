// FlowSpecs for the swarm-team template. Compiled by FLUJO's own /api/flow/compile,
// so they stay valid FLUJO flows that can be opened and edited in the FlowBuilder.
import { specialistAgentServers, specialistInstructions } from './specialists.mjs';

export const FLOW_NAMES = Object.freeze({ agent: 'swarm_agent', team: 'swarm_team', supervisor: 'swarm_supervisor' });

const AGENT_TOOLS = {
  bash: ['run', 'start', 'status', 'wait', 'kill', 'write_stdin', 'list_sessions'],
  filesystem: ['read_file', 'write_file', 'edit_file', 'list_dir', 'search', 'create_directory', 'get_allowed_directories'],
  browser: ['browser_open', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_scroll', 'browser_close'],
  flujo: ['kv_get', 'kv_set', 'list_mcp_servers', 'list_mcp_server_tools', 'call_mcp_tool', 'find_best_mcp_server',
    'install_mcp_server', 'install_best_mcp_server', 'restart_mcp_server', 'get_flow_authoring_guide', 'validate_flow_spec',
    'create_flow', 'list_flows', 'read_flow', 'update_flow', 'list_flow_versions', 'revert_flow', 'execute_flow'],
  fleet: ['fleet_info', 'board_post', 'board_read'],
};

const LEAD_TOOLS = {
  filesystem: ['read_file', 'write_file', 'list_dir', 'search', 'create_directory', 'get_allowed_directories'],
  flujo: ['kv_get', 'kv_set', 'list_flows', 'read_flow', 'get_flow_authoring_guide', 'validate_flow_spec',
    'create_flow', 'update_flow', 'list_flow_versions', 'revert_flow', 'list_conversations', 'read_conversation'],
  fleet: ['fleet_info', 'fleet_delegate', 'fleet_start_task', 'fleet_wait', 'fleet_message', 'fleet_retire_worker',
    'board_post', 'board_read'],
};

const SUPERVISOR_TOOLS = {
  ...LEAD_TOOLS,
  flujo: [...LEAD_TOOLS.flujo, 'list_planned_executions', 'create_planned_execution', 'update_planned_execution', 'delete_planned_execution'],
  fleet: [...LEAD_TOOLS.fleet, 'goal_finish'],
};

const servers = (tools, available, availableTools = {}) => Object.entries(tools)
  .filter(([name]) => available.includes(name))
  .map(([name, list]) => ({ name, tools: Array.isArray(availableTools[name])
    ? list.filter((tool) => availableTools[name].includes(tool)) : list }))
  .filter((server) => server.tools.length);

const AGENT_PROMPT = `You are one agent in a swarm team. You work inside a sandbox that is yours to use and to improve.

YOUR SANDBOX
- Use only tools attached to this flow in the installed Worker. A named tool in these instructions may be unavailable; report that limit instead of claiming its result.
- bash: run any command, install packages, start background processes.
- filesystem: read and write files. Keep your work under a directory named after your task.
- browser: open and read real web pages when the task needs research. (Only if the browser tools are offered.)
- flujo: this FLUJO instance itself.
  - kv_get / kv_set: durable notes that survive this conversation. Names use letters, digits, _ and - only; start yours with "swarm_".
  - Missing a capability? find_best_mcp_server or install_best_mcp_server installs a new MCP server; then use list_mcp_server_tools and call_mcp_tool to call its tools at once. With bash you can also write your own tool or script.
  - For a reusable procedure, read get_flow_authoring_guide, validate its FlowSpec, then call create_flow. To change an existing flow, read_flow first and use update_flow with a complete replacement FlowSpec. Check the tool result before claiming a saved change; list_flow_versions and revert_flow help recover a previous definition. Use execute_flow to test it.
- fleet: board_read / board_post is the team's shared board across all Workers. fleet_info shows the goal, the tree and where you are in it.

NETWORK
- This conversation runs inside one Worker Machine. Local subflows share this Machine's workspace; a child Worker has a different Machine and filesystem.
- The fleet board is shared through the controller and its owned relay. Post concise findings there with source and artifact references; another Worker cannot read your local file directly.
- Your team lead owns child Worker assignment and messaging. You may ask your parent through subflow_send_message. Do not treat a queued assignment or a timed-out wait as completed work.
- Write clear technical findings. The external supervisor owns the customer voice and humor.

HOW YOU WORK
1. Read your task. If it names an angle or approach, stay on that angle: other agents cover the others.
2. Check the board (board_read) for findings that already exist. Do not redo them.
3. Do the work for real: run it, test it, read the source. Never report something you did not check.
   Use relative paths inside your working directory. If a command fails, change something before you run it again; never repeat the same failing command.
4. Post each finding that others need on the board as soon as you have it: one fact, its evidence, and the file path if there is one.
5. Your parent can send you messages while you work, and you can ask it a question with subflow_send_message (target "parent"). Ask only when blocked.
6. Before you finish, record under kv "swarm_lessons" one line on what would make the next agent faster (a tool you installed, a dead end, a command that worked).

YOUR FINAL ANSWER
State the result first. Then what you verified and how, what failed, and the paths of files you produced. Say plainly what is unverified. No filler.`;

const TEAM_BODY = `HOW A TEAM NODE WORKS
You never do the hands-on work yourself. You split it, staff it, steer it, compare the results and decide.

Your workforce:
- LOCAL AGENTS in this Worker. The tool whose name starts with start_subflow_ starts one agent in the background and returns at once; call it once per agent, up to 10 at a time. Each call takes a "task". subflow_wait waits for messages and results, subflow_send_message steers an agent (target = its child conversation id), subflow_list shows them all.
- CHILD WORKERS, each a separate sandbox with its own team of up to 10 agents. fleet_delegate {name, task} creates one and starts its team on the task; it returns a runId. fleet_wait {runId} reads progress or the result; fleet_message {runId, message} steers it. Use child Workers when approaches must not share a filesystem, when a branch needs its own team, or when you need more than 10 agents. fleet_info shows remaining capacity; when the tree is full, use local agents.

NETWORK AND OWNERSHIP
- This lead runs in one Worker Machine. Local agents share its workspace. Child Workers are separate Machines with separate filesystems and model conversations. The external supervisor is not a Worker Machine.
- Fleet tools contact the controller through the owned relay. fleet_delegate returns a runId only after admission; use that original runId with fleet_wait and fleet_message. A timeout leaves it running, and an unknown result must be reconciled before any repeat.
- The board is the cross-Worker evidence channel. Post source or artifact references and author identity; never claim another Machine can read a path in your workspace.
- Keep team updates technical and direct. The external supervisor handles the customer voice and jokes.

THE CYCLE
1. EXPLORE. Name 3 to 10 genuinely different approaches or angles (not the same plan reworded). Give each to one agent or one child Worker. Every task must be self-contained: goal, the specific angle, what "done" means, where to write files, and that findings go on the board.
2. CONSOLIDATE. Wait for results (subflow_wait, fleet_wait; a timeout is not a failure, wait again). Read the board. Write the consolidated findings to a file and post a summary under topic "consolidated".
3. COMPARE. Judge approaches against the goal on evidence: what was actually run, tested or cited. An approach nobody verified ranks below one that was.
4. BUILD. Take the best approach, or a merge of the best parts, and staff the real work: split it into parts, one agent or Worker per part, plus at least one independent agent whose only task is to check the others' output.
5. PICK. Accept the result only when the checker's evidence supports it. If not, send the specific defect back to the agent that owns it and repeat. Stop after three failed rounds and report what is still wrong.
6. CHECK THE CLAIM. Before you answer, give your draft conclusion and the evidence table to one fresh agent and ask only: does the conclusion follow from these numbers? If it says no, correct the conclusion. A winner must be the best on the measured values, not the one that sounds best.

RULES
- Agents in this Worker share its filesystem. Child Workers do NOT: each is a separate sandbox. Never tell two Workers to use "the same file". Give each the exact recipe to produce its own input (a command or a seeded script), or put the data itself in the task or on the board if it is small.
- Give every task a time budget and say it in the task. A child still running at twice its budget counts as did-not-finish: stop waiting, record it as DNF and move on with the results you have.
- Steer early. If an agent drifts or duplicates another, message it now.
- Keep a short state line in kv "swarm_state" after every phase so the work can be resumed: phase, who is running what, open questions.
- Retire child Workers you no longer need with fleet_retire_worker.`;

const TEAM_PROMPT = `You lead a team in a swarm. Your parent gave you one branch of a larger goal; your final answer goes back to it.

${TEAM_BODY}

YOUR FINAL ANSWER
Write it as plain text before you finish. The result of your branch first, then the evidence for it, the approaches you rejected and why, file paths, and anything unverified.`;

const SUPERVISOR_PROMPT = `You supervise a swarm towards one goal. You are the root of the tree. fleet_info gives you the goal text, the limits and the current tree.

${TEAM_BODY}

SUPERVISION
- Start every turn with fleet_info and kv_get "swarm_state". If work is already running, do not start it again: wait on it, read the board, steer.
- The goal can take hours. You are done only when the goal is met or you can say exactly why it cannot be. A quiet period is not done.
- When the goal is met, call goal_finish with the final result: what was delivered, where it is, the evidence, and what is unverified. Then retire the child Workers and write the same result as plain text: that text is your final answer.`;

export const BOOT_FLOW = 'swarm_boot';

/** A tool-free flow. A Fly clone selected by this flow carries no tool-server runtime pins. */
export function bootSpec(model) {
  return { name: BOOT_FLOW, description: 'Boot flow for cloning a swarm Worker. Uses no tools.',
    nodes: [{ key: 'start', type: 'start', label: 'Start', prompt: 'Reply with the single word READY.' },
      { key: 'reply', type: 'process', label: 'Reply', description: 'Confirms the model answers.', model, prompt: 'Reply with the single word READY.' },
      { key: 'finish', type: 'finish' }],
    edges: [{ from: 'start', to: 'reply' }, { from: 'reply', to: 'finish' }] };
}

/** Build the three specs for the servers that are actually connected in the target workspace. */
export function buildSpecs({ model, availableServers, availableTools = {}, limits = {}, specialists } = {}) {
  const agentTurns = Number.isInteger(limits.agentTurns) ? Math.min(Math.max(limits.agentTurns, 1), 200) : 200;
  const leadTurns = Number.isInteger(limits.leadTurns) ? Math.min(Math.max(limits.leadTurns, 1), 600) : 600;
  const requestedConcurrency = Number.isInteger(limits.concurrency) ? Math.min(Math.max(limits.concurrency, 0), 10) : 10;
  if (!model) throw new Error('A model id is required.');
  const roleGuide = specialists ? specialistInstructions(specialists, model) : '';
  const agentAvailable = specialists ? specialistAgentServers(specialists, model, availableServers) : availableServers;
  // One existing subflow gate controls all local role briefs. Team leads
  // count as one of each Worker's ten total conversations.
  const concurrency = specialists
    ? Math.min(requestedConcurrency, specialists.topologyTarget.specialistSubflowsPerWorker)
    : requestedConcurrency;
  const teamBody = concurrency === 10 && !specialists ? TEAM_BODY
    : TEAM_BODY.replace(/^- LOCAL AGENTS[^\n]*/m, concurrency
      ? `- LOCAL AGENTS in this Worker share one subflow gate. Start at most ${concurrency} at once; subflow_wait and subflow_send_message track their real conversation ids.`
      : '- LOCAL AGENTS are disabled in this Worker. Do not start a subflow; the team lead is its only conversation.')
      .replace('team of up to 10 agents', concurrency
        ? `team of up to ${concurrency} ${specialists ? 'specialists' : 'agents'}` : 'lead conversation and no local agents')
      .replace('more than 10 agents', `more than ${concurrency} local agents`)
      .replace('Name 3 to 10 genuinely different approaches', `Name up to ${Math.max(1, concurrency)} genuinely different approaches`);
  const flowTools = availableTools.flujo;
  const authoringReady = !Array.isArray(flowTools) || ['get_flow_authoring_guide', 'validate_flow_spec',
    'create_flow', 'read_flow', 'update_flow'].every((name) => flowTools.includes(name));
  const authoringNote = authoringReady ? ''
    : '\nFlow authoring tools are not verified in this Worker. Report the limitation; do not claim a flow was created or updated.';
  const capacityNote = concurrency === 10 && !specialists ? '' : concurrency === 0
    ? '\nThis Worker has one lead conversation and no local agent subflows. If no child Worker capacity remains, report the limit.'
    : `\nThe shared local gate permits ${concurrency} agent conversations at once; it does not prove that any have started.`;
  const agentPrompt = specialists
    ? `${AGENT_PROMPT}\n\n${roleGuide}\nIf your brief has an unknown or missing ROLE_ID, ask your parent before using tools.`
    : AGENT_PROMPT;
  const boundedAgentPrompt = authoringReady ? agentPrompt : agentPrompt.replace(/^  - For a reusable procedure.*$/m,
    '  - Flow authoring is unavailable here. Report the missing tools instead of claiming a saved flow.');
  const teamPrompt = `${TEAM_PROMPT.replace(TEAM_BODY, teamBody)}${specialists ? `\n\n${roleGuide}` : ''}${capacityNote}${authoringNote}`;
  const supervisorPrompt = `${SUPERVISOR_PROMPT.replace(TEAM_BODY, teamBody)}${specialists ? `\n\n${roleGuide}` : ''}${capacityNote}${authoringNote}`;
  const agent = {
    name: FLOW_NAMES.agent,
    description: 'Generic self-improving swarm agent: one sandboxed worker conversation with bash, filesystem, browser, FLUJO self-management and the team board.',
    nodes: [
      { key: 'start', type: 'start', label: 'Start', prompt: boundedAgentPrompt },
      { key: 'agent', type: 'process', label: 'Agent', description: 'Does one self-contained task hands-on and reports evidence.',
        model, prompt: 'Do the task you were given. Follow your operating rules.', servers: servers(AGENT_TOOLS, agentAvailable, availableTools), maxTurns: agentTurns },
      { key: 'finish', type: 'finish' },
    ],
    edges: [{ from: 'start', to: 'agent' }, { from: 'agent', to: 'finish' }],
  };
  const team = (name, description, prompt, tools) => ({
    name, description,
    nodes: [
      { key: 'start', type: 'start', label: 'Start', prompt },
      { key: 'lead', type: 'process', label: 'Lead', description: 'Splits the work, staffs agents and child Workers, steers, compares and decides.',
        model, prompt: 'Run the cycle for the task you were given.', servers: servers(tools, availableServers, availableTools), maxTurns: leadTurns },
      ...(concurrency ? [{ key: 'agents', type: 'subflow', label: 'agent', flow: FLOW_NAMES.agent, concurrencyLimit: concurrency,
        inputMode: 'isolated', prompt: 'Ask your parent for your task with subflow_send_message.', outputMode: 'final-only' }] : []),
      { key: 'finish', type: 'finish' },
    ],
    edges: [{ from: 'start', to: 'lead' }, ...(concurrency ? [{ from: 'lead', to: 'agents' }] : []),
      { from: 'lead', to: 'finish' }],
  });
  return [
    agent,
    team(FLOW_NAMES.team, `Swarm team lead: runs up to ${concurrency} collaborating agents in this Worker and can delegate branches to child Workers.`, teamPrompt, LEAD_TOOLS),
    team(FLOW_NAMES.supervisor, 'Swarm supervisor: root of the Worker tree; builds the swarm for a goal and steers it to a verified result.', supervisorPrompt, SUPERVISOR_TOOLS),
  ];
}

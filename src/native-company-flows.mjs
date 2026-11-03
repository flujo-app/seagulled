import {FlujoClient} from '../upstream/swarm-teams/lib/flujo-client.mjs';
import {installTemplate,MODEL_ID} from '../upstream/swarm-teams/install.mjs';
import {bootSpec} from '../upstream/swarm-teams/template/flows.mjs';
import {NATIVE_WORKER_TOOLS,NATIVE_WORKER_SERVER} from './native-worker-tools.mjs';

const refused=()=>Object.assign(new Error('The native company flow installation is unavailable.'),{code:'NATIVE_COMPANY_SOURCE'});

/** Install the proven lead/attached-child graph in the private local Source.
 * This workspace is never a Worker snapshot source: its protected gateway
 * bearer stays here, while tools address the Controller's enrolled Fly target. */
export async function installNativeCompanyFlows({client,toolConfig}={}) {
  if(!(client instanceof FlujoClient)||!client.workspace||toolConfig?.name!==NATIVE_WORKER_SERVER
    ||toolConfig.transport!=='streamable'||Object.keys(toolConfig.headers??{}).join()!=='Authorization')throw refused();
  const address=new URL(toolConfig.serverUrl);
  if(address.protocol!=='http:'||address.hostname!=='127.0.0.1'||!address.port
    ||address.pathname!=='/native-source/tools/mcp'||address.search||address.hash
    ||address.username||address.password||!/^Bearer [A-Za-z0-9_-]{43}$/.test(toolConfig.headers.Authorization))throw refused();
  await client.ensureWorkspace();
  for(const server of await client.servers()) {
    if(server.name!==NATIVE_WORKER_SERVER&&!server.disabled)await client.upsertServer({...server,disabled:true});
  }
  await installTemplate(client,{model:{name:'gpt-6-luna',apiKey:'',baseUrl:'',provider:'codex',
    adapter:'codex-cli',reasoningEffort:'medium'},bootOnly:true,browser:false});
  await client.upsertServer({...toolConfig,
    headers:{Authorization:{value:toolConfig.headers.Authorization,metadata:{isSecret:true}}},
    disabled:false,exposeAsMcpServer:false,enableMcpApps:false,enableMcpSkills:false});
  const attached=[{name:NATIVE_WORKER_SERVER,tools:NATIVE_WORKER_TOOLS.map(tool=>tool.name)}];
  const childSpec=bootSpec(MODEL_ID);
  childSpec.name='seagulled_native_agent';
  childSpec.nodes=childSpec.nodes.filter(node=>node.type!=='finish');
  childSpec.edges=childSpec.edges.filter(edge=>edge.to!=='finish');
  childSpec.nodes.find(node=>node.type==='start').prompt='Implement your assigned part of the company goal in your owned Worker. Use the attached Worker tools to inspect source, make changes and run relevant checks. Save deliverables and a patch under the allowed working directory. Report actual changes, check results and relative artifact paths. Preserve concurrent work and do not claim a PR was published without its returned URL.';
  Object.assign(childSpec.nodes.find(node=>node.type==='process'),{servers:attached,
    prompt:'Complete the task you received using your owned Worker tools. Report the result and remaining limits.'});
  const child=await client.saveFlowSpec(childSpec);
  const lead=await client.saveFlowSpec({name:'seagulled_native_team',nodes:[
    {key:'start',type:'start',prompt:'You lead one owned Worker with one attached agent. Read the assignment and hand off one concrete implementation task to your installed child.'},
    {key:'lead',type:'process',label:'Lead',model:MODEL_ID,
      prompt:'Call the offered handoff_to tool exactly once for your one installed child. Give it the complete assigned task, a focused useful change, relevant checks and required patch/artifact outputs.'},
    {key:'child',type:'subflow',label:'Agent',flow:child.name,concurrencyLimit:1,inputMode:'isolated',
      prompt:'Complete the implementation task from your parent. Use only the attached Worker tools.',outputMode:'final-only'},
    {key:'finish',type:'finish'}],edges:[{from:'start',to:'lead'},{from:'lead',to:'child'},{from:'child',to:'finish'}]});
  const parentNodeId=lead.nodes?.find(node=>node.data?.type==='subflow')?.id;
  if(!lead.id||!child.id||!parentNodeId)throw refused();
  return Object.freeze({flowName:lead.name,flowId:lead.id,modelId:MODEL_ID,
    child:Object.freeze({parentNodeId,flowId:child.id})});
}

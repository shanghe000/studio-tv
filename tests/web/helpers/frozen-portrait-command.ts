import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const native=readFileSync(new URL('../../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const seed=JSON.parse(readFileSync(new URL('../../../apps/api-go/internal/modules/execution/application/seed/portrait-recipes.json',import.meta.url),'utf8'));
const functions=['_M','dw','vEr','cEt','o_','Qye','lEt','qp','M_e','zer','S9e','C9e','rye','iSr',
 'jd','xTe','mS','xEr','E9e','fEt','IUe','nv','qwr','Kwr','kpe','qc','rit'];
function frozenFunction(name:string){
 const sync=native.indexOf('function '+name+'(');
 if(sync<0)throw Error('Missing native portrait function '+name);
 const start=native.slice(sync-6,sync)==='async '?sync-6:sync;
 const end=native.slice(start).search(/}(?=(?:async )?function |const |class |var )/);
 if(end<0)throw Error('Missing native function boundary '+name);
 return native.slice(start,start+end+1);
}
const builder=native.slice(native.indexOf('async function zU('),native.indexOf('async function LEr('));
const declarations=functions.map(frozenFunction).join('\n')+'\n'+builder+';zU';
function constant(name:string){return JSON.parse(native.match(new RegExp('\\b'+name+'=("(?:[^"\\\\]|\\\\.)*")'))![1]);}

/** Run zU (person panel), zer (selection), qp (node and edge), then the native
 * o_ → cEt command. Only the catalog response, Yjs transport, selection focus
 * and network are substituted. The returned graph and command are separate. */
export async function frozenPortraitRequest(panel:string,presetKey:string,presetId:string){
 const byGroup:Record<string,any>={};
 for(const {definition:d,prop} of seed.items){
  const group=byGroup[prop.group]??={byKey:{}};
  group.byKey[prop.key]={key:prop.key,id:d.id,promptCode:d.promptCode,name:d.label,prefixPrompt:d.prefixPrompt,group:prop.group};
 }
 const choice=seed.items.find((row:any)=>row.definition.id===presetId);
 const modelCode=constant('hxt');
 const model={modelCode,config:[{type:'PROMPT',paramName:'prompt'},{type:'IMAGE_URLS',paramName:'imageUrls'}]};
 const source={id:'ref',type:'rh-image',position:{x:0,y:0},data:{isUpload:true,sourceObjects:['rhtv-asset:owned']}};
 const graph={nodes:[source] as any[],edges:[] as any[]};
 const selected={touched:{[presetKey]:true},[presetKey]:panel==='makeup'?{
  id:presetId,promptCode:presetId,label:choice.definition.label,prompt:choice.definition.prefixPrompt
 }:choice.prop.key,protection:{}};
 let command:any;
 const submit=runInNewContext(declarations,{
  hxt:modelCode,x9e:constant('x9e'),Wwr:constant('Wwr'),rn:{IMAGE_IMAGE:'image-image'},
  _t:{PROMPT:'PROMPT',IMAGE_URLS:'IMAGE_URLS',IMAGE_URL:'IMAGE_URL',WH_ASPECT_RATIO:'WH_ASPECT_RATIO'},
  $f:()=>{},bxt:async()=>({byGroup}),ZSt:null,
  Et:{getState:()=>({markLocalRunning:()=>{},unmarkLocalRunning:()=>{}})},
  Ln:()=>({pasteGraph:(nodes:any[],edges:any[])=>{graph.nodes.push(...structuredClone(nodes));graph.edges.push(...structuredClone(edges));}}),
  sn:{t:(key:string)=>key},Ie:{error:(message:string)=>{throw Error(message);},warning:(message:string)=>{throw Error(message);}},
  $m:(request:any)=>{command=JSON.parse(JSON.stringify(request.canvas));return {taskId:'test'};}
 });
 const ok=await submit({canvasId:'p',canvasName:'test',nodes:graph.nodes,models:{'image-image':[model]}},source,'rhtv-asset:owned',{panel,selection:selected,generateNum:1});
 if(!ok||!command)throw Error('Native portrait tool did not create a command.');
 return{graph,command,owner:graph.nodes[1]};
}

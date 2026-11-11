import type {TerminalNodeUpdate} from './execution';
import {scriptTerminalFields} from './storyboard-output';

interface Receipt {update:TerminalNodeUpdate;identity:any}
const terminalStatus={SUCCESS:'finished',FAILED:'failed',CANCELLED:'idle'};
const inspectedComponents=new WeakMap<Function,boolean>();

/** Rjr/Eg retain a render copy of native stage fields after the authoritative
 * graph and hx are already clean. Project only the inspected stage fields for
 * the exact task whose applied terminal receipt this session observed. */
export function scriptTerminalDisplayProps(props:any,node:any){
 const patch=scriptTerminalFields(props?.data);
 if(!Object.keys(patch).length)return props;
 if(patch.customBadgeText!==undefined){
  if(node.data?.testMode===true)patch.customBadgeText='TEST MODE';
  else if(typeof node.data?.customBadgeText==='string'&&!Object.hasOwn(scriptTerminalFields({customBadgeText:node.data.customBadgeText}),'customBadgeText'))patch.customBadgeText=node.data.customBadgeText;
 }
 return{...props,data:{...props.data,...patch}};
}

function component(type:any):{render:Function;memo:boolean}|undefined{
 const memo=type?.$$typeof===Symbol.for('react.memo'),render=memo?type.type:type;
 if(typeof render!=='function'||!['Rjr','Eg'].includes(render.name))return;
 let exact=inspectedComponents.get(render);
 if(exact===undefined){const source=Function.prototype.toString.call(render);exact=render.name==='Rjr'?source.includes('pendingOutputScene')&&source.includes('rh-script-node'):source.includes('fct(')&&source.includes('rh-node-card-stack');inspectedComponents.set(render,exact);}
 if(exact)return{render,memo};
}

export function installScriptTerminalDisplay(runtime:any,native:any){
 const react=native?.r,jsx=native?.j;
 if(typeof react?.useSyncExternalStore!=='function'||typeof react?.memo!=='function'||typeof jsx?.jsx!=='function'||typeof runtime.execution?.onTerminal!=='function')return()=>{};
 let active=true,version=0;const receipts=new Map<string,Receipt>(),listeners=new Set<()=>void>(),wrappers=new WeakMap<object,any>(),installed:{name:string;original:Function;wrapper:Function}[]=[];
 const emit=()=>{version++;for(const listener of [...listeners])listener();};
 const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},snapshot=()=>version;
 const current=(receipt:Receipt)=>{
  const {update,identity}=receipt;
  if(!active||!identity||runtime.auth.user!==identity||native.bt?.()!==update.manager||runtime.inspect().id!==update.projectId)return;
  const node=update.manager.getRemoteData()?.nodes.find((value:any)=>value.id===update.nodeId);
  if(node?.type==='rh-script'&&node.data?.taskId===update.taskId&&node.data.status===terminalStatus[update.status])return node;
 };
 const project=(props:any)=>{
  if(props?.type!=='rh-script'||typeof props.id!=='string')return props;
  const receipt=receipts.get(props.id),node=receipt&&current(receipt);
  if(!node||props.data?.taskId!==receipt!.update.taskId||props.data?.status!==node.data.status)return props;
  return scriptTerminalDisplayProps(props,node);
 };
 for(const name of ['jsx','jsxs'])if(typeof jsx[name]==='function'){
  const original=jsx[name],wrapper=function(this:any,type:any,props:any,...args:any[]){
   const inspected=active&&component(type);
   if(inspected){let adapted=wrappers.get(type);if(!adapted){
    const render=inspected.render,view=function ScriptTerminalDisplay(props:any){react.useSyncExternalStore(subscribe,snapshot,snapshot);return render(project(props));};
    adapted=inspected.memo?react.memo(view,type.compare):view;wrappers.set(type,adapted);
   }type=adapted;}
   return original.call(this,type,props,...args);
  };jsx[name]=wrapper;installed.push({name,original,wrapper});
 }
 const release=runtime.execution.onTerminal((update:TerminalNodeUpdate)=>{
  const receipt={update,identity:runtime.auth.user};if(!current(receipt))return;
  receipts.set(update.nodeId,receipt);emit();
 });
 return()=>{if(!active)return;active=false;release?.();receipts.clear();emit();listeners.clear();for(const row of installed)if(jsx[row.name]===row.wrapper)jsx[row.name]=row.original;};
}

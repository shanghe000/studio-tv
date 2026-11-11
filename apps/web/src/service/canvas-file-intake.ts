import {optimizeCanvasImage,shouldOptimizeCanvasImage} from './optimize-canvas-image';

type Intake = Event & {dataTransfer?:DataTransfer|null;clipboardData?:DataTransfer|null};
type Capture = ()=>undefined|(()=>boolean);
const MiB=1024*1024;
const canvasArea='.rh-canvas-board,.rh-canvas-flow,.react-flow,.rh-canvas-asset-library,.rh-add-node-panel__list,.asset-library-upload-modal,.rh-node-context-menu,.rh-style-create,.config-panel-wrap,.ce-node-toolbar,.home-agent-input-bar';
const exceedsImportLimit=(file:File)=>/^(image|audio)\//.test(file.type)&&file.size>50*MiB;

// Some native controls check the selected File before they call the storage
// service. Give those controls the prepared files through their usual events.
export function installCanvasFileIntake(capture:Capture,notice:(message:string)=>void,win:Window=window){
 const replay=new WeakSet<Event>();
 const picks=new WeakMap<HTMLInputElement,Event>();
 let active=true;
 const intake=(event:Intake)=>{
  if(replay.has(event)||event.defaultPrevented||!(event.target instanceof Node))return;
  const target=event.target;
  const input=event.type==='change'&&target instanceof HTMLInputElement&&target.type==='file'?target:null;
  const transfer=event.clipboardData??event.dataTransfer;
  const element=target instanceof Element?target:target.parentElement;
  if(!element?.closest(canvasArea)&&!(event.type==='paste'&&(target===win.document.body||target===win.document)))return;
  if(!input&&!transfer)return;
  // Text, pasted canvas nodes, and drags with app-specific payloads follow
  // their original route. Do not replace browser editing/paste behavior.
  if(transfer&&Array.from(transfer.items).some(item=>item.kind!=='file'))return;
  if(event.type==='paste'&&(target instanceof Element?target:target.parentElement)?.closest('input,textarea,[contenteditable]:not([contenteditable="false"])'))return;
  const files=Array.from(input?.files??transfer?.files??[]);
  // The earliest native bound in these image controls is 10 MiB. Smaller
  // files already go through the shared optimizer on their way to storage.
  const ordinary=input?!!input.closest('.rh-add-node-panel__list,.rh-node-context-menu'):
   event.type==='paste'||!!element?.matches('.react-flow__pane,.react-flow__viewport,.rh-canvas-board');
  if(!files.some(file=>file.size>10*MiB&&shouldOptimizeCanvasImage(file)||ordinary&&exceedsImportLimit(file)))return;
  const current=capture();
  if(!current)return;
  let data:DataTransfer, next:Event;
  try{
   data=new DataTransfer();
   const init={bubbles:event.bubbles,cancelable:event.cancelable,composed:event.composed};
   if(input)next=new Event('change',init);
   else if(event.type==='drop'){
    const e=event as DragEvent;
    next=new DragEvent('drop',{...init,dataTransfer:data,clientX:e.clientX,clientY:e.clientY,screenX:e.screenX,screenY:e.screenY,
     ctrlKey:e.ctrlKey,altKey:e.altKey,shiftKey:e.shiftKey,metaKey:e.metaKey,button:e.button,buttons:e.buttons});
    if((next as DragEvent).dataTransfer!==data)return;
   }else{
    next=new ClipboardEvent('paste',{...init,clipboardData:data});
    if((next as ClipboardEvent).clipboardData!==data)return;
   }
  }catch{return;} // Let the original control run on browsers without file transfer support.
  if(input)picks.set(input,event);
  const selected=input?.files;
  event.stopImmediatePropagation();
  event.preventDefault();
  void (async()=>{
   const rejected:File[]=[];
   for(const source of files){
    const file=await optimizeCanvasImage(source);
    if(ordinary&&exceedsImportLimit(file))rejected.push(file);
    else data.items.add(file);
   }
   if(!active||!current()||!target.isConnected)return;
   if(input){
    if(picks.get(input)!==event||input.files!==selected)return;
    input.files=data.files;
   }
   if(rejected.length){
    const first=rejected[0],size=Math.ceil(first.size/MiB*100)/100;
    notice(`“${first.name}”为 ${size} MiB，超过画布图片和音频的 50 MiB 导入上限。${rejected.length>1?'本次共有 '+rejected.length+' 个文件超限。':''}`);
   }
   if(!data.files.length)return;
   replay.add(next);
   target.dispatchEvent(next);
  })().catch(()=>{if(active&&current())notice('浏览器未能传入所选素材，请重新选择文件。');});
 };
 const events=['change','drop','paste'] as const;
 for(const name of events)win.addEventListener(name,intake,true);
 return ()=>{active=false;for(const name of events)win.removeEventListener(name,intake,true);};
}

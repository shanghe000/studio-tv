interface Bounds {left:number;right:number;top:number;bottom:number;width:number;height:number}

/** Image panels live inside the scaled canvas. Their native inverse transform
 * preserves control size, but does not keep the panel's anchor on screen. */
export function imageToolViewportShift(rect:Bounds,width:number,height:number){
 const margin=12;
 return{
  x:rect.width>width-2*margin?margin-rect.left:Math.max(margin-rect.left,Math.min(0,width-margin-rect.right)),
  y:rect.height>height-2*margin?margin-rect.top:Math.max(margin-rect.top,Math.min(0,height-margin-rect.bottom)),
 };
}

const marker='data-studio-image-tool-viewport';
const dialogs='.rh-character-emotion-dialog,.rh-character-appearance-dialog,.rh-character-makeup-dialog,.rh-pose-control-panel--modal';
interface Panel {dialog:HTMLElement;translate:string;priority:string;localX:number;localY:number;written:string|null;marker:string|null}

/** Preserve native placement, transforms, callbacks and graph data. Only the
 * four inspected image portrait panels receive viewport fitting and scrolling.
 * The floating companion yields while an image tool menu is open. */
export function installImageToolViewport(root:Document=document){
 const view=root.defaultView;if(!view||!root.body||typeof MutationObserver==='undefined')return()=>{};
 const style=root.createElement('style');
 style.textContent=`[${marker}]{max-width:calc(100vw - 24px)!important;max-height:calc(100vh - 24px)!important;min-width:0!important;min-height:0!important;overflow-y:auto!important;overscroll-behavior:contain}
body.rh-canvas-route-active:has(.rh-image-toolbar-popup)>.agent-fab{visibility:hidden!important;pointer-events:none!important}`;
 root.head.append(style);
 const panels=new Map<HTMLElement,Panel>();let disposed=false,scheduled=false;
 const restore=(anchor:HTMLElement,state:Panel)=>{
  if(state.written!==null&&anchor.style.getPropertyValue('translate')===state.written){
   if(state.translate)anchor.style.setProperty('translate',state.translate,state.priority);else anchor.style.removeProperty('translate');
  }
  if(state.dialog.getAttribute(marker)==='true'){if(state.marker===null)state.dialog.removeAttribute(marker);else state.dialog.setAttribute(marker,state.marker);}
  panels.delete(anchor);
 };
 const refresh=()=>{
  scheduled=false;if(disposed)return;
  const active=new Set<HTMLElement>();
  for(const dialog of root.querySelectorAll<HTMLElement>(dialogs)){
   const local=dialog.closest<HTMLElement>('.react-flow__node-rh-image .rh-image-node-local-ui');if(!local)continue;
   let anchor=dialog;while(anchor.parentElement&&anchor.parentElement!==local)anchor=anchor.parentElement;
   if(anchor.parentElement!==local)continue;
   const computed=view.getComputedStyle(dialog);if(computed.display==='none'||computed.visibility==='hidden')continue;
   const rect=dialog.getBoundingClientRect();if(!rect.width||!rect.height)continue;
   active.add(anchor);let state=panels.get(anchor);
   if(state&&state.dialog!==dialog){restore(anchor,state);state=undefined;}
   if(!state){
    // Native panels use transform, not individual translate. Do not take over
    // an independently translated third-party extension's placement.
    const translate=anchor.style.getPropertyValue('translate');if(translate&&translate!=='none')continue;
    state={dialog,translate,priority:anchor.style.getPropertyPriority('translate'),localX:0,localY:0,written:null,marker:dialog.getAttribute(marker)};panels.set(anchor,state);
    dialog.setAttribute(marker,'true');
   }
   const raw=Number.parseFloat(view.getComputedStyle(anchor.closest<HTMLElement>('.rh-node-shell-body')??local).getPropertyValue('--rh-node-ui-inverse-scale'));
   const inverse=Number.isFinite(raw)&&raw>0&&raw<32?raw:1;
   // Individual translate is in the parent's scaled coordinates; divide its
   // previous local displacement by the current inverse before remeasuring.
   const current=dialog.getBoundingClientRect(),x=state.localX/inverse,y=state.localY/inverse;
   const shift=imageToolViewportShift({left:current.left-x,right:current.right-x,top:current.top-y,bottom:current.bottom-y,width:current.width,height:current.height},view.innerWidth,view.innerHeight);
   state.localX=shift.x*inverse;state.localY=shift.y*inverse;
   const value=`${state.localX}px ${state.localY}px`;
   const prior=anchor.style.getPropertyValue('translate').trim().split(/\s+/).map(Number.parseFloat);
   if(prior.length!==2||Math.abs(prior[0]-state.localX)>.001||Math.abs(prior[1]-state.localY)>.001||anchor.style.getPropertyPriority('translate')!=='important')anchor.style.setProperty('translate',value,'important');
   // CSSOM may round fractional pixel declarations. Track its actual value so
   // future measurements and cleanup use the displacement the browser kept.
   state.written=anchor.style.getPropertyValue('translate');
   const written=state.written.trim().split(/\s+/).map(Number.parseFloat);
   if(written.length===2&&written.every(Number.isFinite)){state.localX=written[0];state.localY=written[1];}
  }
  for(const [anchor,state]of panels)if(!active.has(anchor))restore(anchor,state);
 };
 const schedule=()=>{if(!disposed&&!scheduled){scheduled=true;view.requestAnimationFrame(refresh);}};
 const animated=(event:Event)=>{if((event.target as Element|null)?.matches?.(dialogs))schedule();};
 const observer=new MutationObserver(schedule);observer.observe(root.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style','role']});
 root.addEventListener('animationend',animated,true);view.addEventListener('resize',schedule);view.addEventListener('scroll',schedule,true);refresh();
 return()=>{disposed=true;observer.disconnect();root.removeEventListener('animationend',animated,true);view.removeEventListener('resize',schedule);view.removeEventListener('scroll',schedule,true);for(const [anchor,state]of panels)restore(anchor,state);style.remove();};
}

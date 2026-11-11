const marker='data-studio-companion-yielding';
const controls=[
 '.config-panel-wrap','.config-panel-modal-content','.rh-canvas-compact-input-panel','.group-params-root','.group-toolbar',
 '.rh-canvas-image-toolbar','.rh-canvas-video-toolbar','.rh-image-toolbar-popup','.rh-node-fail-overlay',
 '.react-flow__controls','.react-flow__node.selected .react-flow__handle','[data-studio-generation-readiness]',
 '[role="dialog"]',
].join(',');

/** The native companion retains its drag position and assistant state. Yield
 * only while a visible editing surface intersects it; never relocate it onto
 * another control or change the canvas to make room. */
export function installCanvasCompanionAvoidance(root:Document=document){
 const view=root.defaultView;if(!view||!root.body)return()=>{};
 const style=root.createElement('style');style.textContent=`.agent-fab[${marker}],.agent-fab[${marker}] *{visibility:hidden!important;pointer-events:none!important}`;root.head.append(style);
 let disposed=false,frame=0;const yielded=new Set<HTMLElement>();
 const intersects=(a:DOMRect,b:DOMRect)=>a.width>0&&a.height>0&&b.width>0&&b.height>0&&a.left<b.right+4&&a.right>b.left-4&&a.top<b.bottom+4&&a.bottom>b.top-4;
 const refresh=()=>{
  frame=0;if(disposed)return;
  const active=root.body.classList.contains('rh-canvas-route-active'),panels=active?[...root.querySelectorAll<HTMLElement>(controls)].filter(panel=>!panel.closest('.agent-fab')&&!panel.hidden):[];
  const bounds=panels.flatMap(panel=>{const rect=panel.getBoundingClientRect();if(!rect.width||!rect.height)return[];const css=view.getComputedStyle(panel);return css.display==='none'||css.visibility==='hidden'||css.opacity==='0'?[]:[rect];});
  const live=new Set(root.querySelectorAll<HTMLElement>('.agent-fab'));
  for(const pet of new Set([...yielded,...live])){
   // visibility:hidden keeps geometry, so this does not oscillate between
   // hidden/visible while the same form still overlaps the companion.
   const areas=[pet,...pet.querySelectorAll<HTMLElement>('.agent-fab__motion,.studio-pet-overlay')].map(part=>part.getBoundingClientRect());
   const covered=active&&live.has(pet)&&areas.some(area=>bounds.some(rect=>intersects(area,rect)));
   if(covered){if(!pet.hasAttribute(marker))pet.setAttribute(marker,'');yielded.add(pet);}
   else{pet.removeAttribute(marker);yielded.delete(pet);}
  }
 };
 const schedule=()=>{if(!disposed&&!frame)frame=view.requestAnimationFrame(refresh);};
 const observer=new MutationObserver(records=>{
  // Decorative gaze animation writes CSS variables every frame; only the
  // native root's placement can alter its collision with editing controls.
  if(records.some(record=>!(record.target instanceof Element)||!record.target.closest('.agent-fab')||record.target.matches('.agent-fab')))schedule();
 });
 observer.observe(root.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style','hidden','aria-hidden']});
 view.addEventListener('resize',schedule);view.addEventListener('scroll',schedule,true);root.addEventListener('transitionend',schedule,true);root.addEventListener('animationend',schedule,true);refresh();
 return()=>{disposed=true;if(frame)view.cancelAnimationFrame(frame);observer.disconnect();view.removeEventListener('resize',schedule);view.removeEventListener('scroll',schedule,true);root.removeEventListener('transitionend',schedule,true);root.removeEventListener('animationend',schedule,true);for(const pet of yielded)pet.removeAttribute(marker);yielded.clear();style.remove();};
}

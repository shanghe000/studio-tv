import {minimapDragViewport, type Point, type ScreenToFlowMatrix, type Viewport} from './minimap-geometry';
import './minimap-navigation.css';

interface FlowState {
 transform: [number, number, number];
 width: number;
 height: number;
 domNode: HTMLElement;
 translateExtent: [[number, number], [number, number]];
 panZoom: {setViewportConstrained(viewport: Viewport, extent: [[number, number], [number, number]], translateExtent: FlowState['translateExtent']): unknown};
}
interface FlowStore {getState(): FlowState; setState: unknown; subscribe: unknown}
interface Fiber {return?: Fiber; memoizedProps?: {value?: Partial<FlowStore>}}

/** The frozen editor owns its React Flow store. Keep this compatibility boundary
 * structural and fail open to native controls if its store shape ever changes. */
function flowStore(svg: SVGSVGElement): FlowStore | null {
 const fiberKey=Object.keys(svg).find(key=>key.startsWith('__reactFiber$'));
 if(!fiberKey)return null;
 let fiber=(svg as unknown as Record<string,Fiber>)[fiberKey];
 for(let depth=0;fiber&&depth<100;depth++,fiber=fiber.return!){
  const store=fiber.memoizedProps?.value;
  if(typeof store?.getState!=='function'||typeof store.setState!=='function'||typeof store.subscribe!=='function')continue;
  const state=store.getState();
  if(state.domNode?.contains(svg)&&Array.isArray(state.transform)&&state.transform.length===3&&
   state.transform.every(Number.isFinite)&&state.transform[2]>0&&Number.isFinite(state.width)&&Number.isFinite(state.height)&&state.width>0&&state.height>0&&
   typeof state.panZoom?.setViewportConstrained==='function')return store as FlowStore;
 }
 return null;
}

interface Gesture {
 svg: SVGSVGElement;
 pointerId: number;
 start: Point;
 viewport: Viewport;
 matrix: ScreenToFlowMatrix;
 store: FlowStore;
 moved: boolean;
 viewBox: string;
 latestViewBox: string;
 observer: MutationObserver;
}

/** Preserve the native minimap appearance, click navigation and wheel zoom.
 * Only dragging uses a stable SVG mapping instead of a changing bounds estimate. */
export function installMinimapNavigation(){
 let active: Gesture|null=null;
 let suppressedClick: {svg:SVGSVGElement;until:number}|null=null;
 const hosts=new Set<Element>();
 const stop=(event:Event)=>{event.preventDefault();event.stopImmediatePropagation();};
 const finish=()=>{
  const gesture=active;if(!gesture)return;
  active=null;
  // React may have committed a new viewBox since the last observer delivery.
  const current=gesture.svg.getAttribute('viewBox');
  if(current&&current!==gesture.viewBox)gesture.latestViewBox=current;
  gesture.observer.disconnect();
  if(gesture.svg.isConnected)gesture.svg.setAttribute('viewBox',gesture.latestViewBox);
  if(gesture.svg.hasPointerCapture(gesture.pointerId))gesture.svg.releasePointerCapture(gesture.pointerId);
  if(gesture.moved)suppressedClick={svg:gesture.svg,until:performance.now()+800};
 };
 const down=(event:Event)=>{
  const pointer=event as PointerEvent;
  if(active||!pointer.isPrimary||pointer.button!==0||!(pointer.target instanceof Element))return;
  const svg=pointer.target.closest<SVGSVGElement>('.react-flow__minimap-svg');
  if(!svg)return;
  const store=flowStore(svg),ctm=svg.getScreenCTM(),viewBox=svg.getAttribute('viewBox');
  if(!store||!ctm||!viewBox)return;
  let inverse:DOMMatrix;
  try{inverse=ctm.inverse();}catch{return;}
  const matrix={a:inverse.a,b:inverse.b,c:inverse.c,d:inverse.d,e:inverse.e,f:inverse.f};
  if(!Object.values(matrix).every(Number.isFinite))return;
  const [x,y,zoom]=store.getState().transform;
  const gesture:Gesture={svg,pointerId:pointer.pointerId,start:{x:pointer.clientX,y:pointer.clientY},viewport:{x,y,zoom},matrix,store,moved:false,viewBox,latestViewBox:viewBox,observer:null!};
  gesture.observer=new MutationObserver(()=>{
   const next=svg.getAttribute('viewBox');
   if(active!==gesture||!next||next===gesture.viewBox)return;
   gesture.latestViewBox=next;
   svg.setAttribute('viewBox',gesture.viewBox);
  });
  gesture.observer.observe(svg,{attributes:true,attributeFilter:['viewBox']});
  active=gesture;suppressedClick=null;
  try{svg.setPointerCapture(pointer.pointerId);}catch{finish();return;}
  // Host capture runs AFTER the canvas has flushed any pending wheel gesture.
  pointer.stopImmediatePropagation();
 };
 const compatibilityStart=(event:Event)=>{if(active)stop(event);};
 const apply=(point:Point)=>{
  const gesture=active;if(!gesture)return;
  if(!gesture.moved&&Math.hypot(point.x-gesture.start.x,point.y-gesture.start.y)<3)return;
  gesture.moved=true;
  const next=minimapDragViewport(gesture.viewport,gesture.start,point,gesture.matrix);
  if(!next)return;
  const state=gesture.store.getState();
  state.panZoom.setViewportConstrained(next,[[0,0],[state.width,state.height]],state.translateExtent);
 };
 const move=(event:PointerEvent)=>{
  if(!active||event.pointerId!==active.pointerId)return;
  stop(event);apply({x:event.clientX,y:event.clientY});
 };
 const up=(event:PointerEvent)=>{
  if(!active||event.pointerId!==active.pointerId)return;
  apply({x:event.clientX,y:event.clientY});finish();
  // Let ancestor controls complete their own pointer bookkeeping.
 };
 const cancel=(event:PointerEvent)=>{if(active?.pointerId===event.pointerId)finish();};
 const click=(event:MouseEvent)=>{
  if(suppressedClick&&performance.now()<suppressedClick.until&&event.target instanceof Node&&suppressedClick.svg.contains(event.target)){
   suppressedClick=null;stop(event);
  }
 };
 const wheel=(event:WheelEvent)=>{if(active)stop(event);};
 const mount=(root:Element)=>{
  const selector='.rh-canvas-minimap-host';
  for(const host of [...(root.matches(selector)?[root]:[]),...root.querySelectorAll(selector)]){
   if(hosts.has(host))continue;hosts.add(host);
   host.addEventListener('pointerdown',down,true);
   host.addEventListener('mousedown',compatibilityStart,true);
   host.addEventListener('touchstart',compatibilityStart,{capture:true,passive:false});
  }
 };
 const unmount=(host:Element)=>{
  host.removeEventListener('pointerdown',down,true);host.removeEventListener('mousedown',compatibilityStart,true);
  host.removeEventListener('touchstart',compatibilityStart,true);hosts.delete(host);
 };
 const observer=new MutationObserver(records=>{
  for(const record of records)for(const node of record.addedNodes)if(node instanceof Element)mount(node);
  for(const host of hosts)if(!host.isConnected)unmount(host);
  if(active&&!active.svg.isConnected)finish();
 });
 observer.observe(document.body,{childList:true,subtree:true});mount(document.body);
 document.addEventListener('pointermove',move,true);
 document.addEventListener('pointerup',up,true);
 document.addEventListener('pointercancel',cancel,true);
 document.addEventListener('lostpointercapture',cancel,true);
 document.addEventListener('click',click,true);
 document.addEventListener('wheel',wheel,{capture:true,passive:false});
 window.addEventListener('blur',finish);
 const disconnect=()=>{
  finish();observer.disconnect();for(const host of hosts)unmount(host);
  document.removeEventListener('pointermove',move,true);document.removeEventListener('pointerup',up,true);
  document.removeEventListener('pointercancel',cancel,true);document.removeEventListener('lostpointercapture',cancel,true);
  document.removeEventListener('click',click,true);document.removeEventListener('wheel',wheel,true);
  window.removeEventListener('blur',finish);
  window.removeEventListener('pagehide',finish);
 };
 // BFCache restores this document without rerunning bootstrap.
 window.addEventListener('pagehide',finish);
 return{disconnect};
}

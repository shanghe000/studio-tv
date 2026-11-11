/** Transient ownership of one video's generation controls. This never changes
 * the canvas, model choice or readiness of another node. */
export const h3LongformModeEvent='studiotv:h3-longform-mode';
const activeModes=new WeakMap<Document,Map<string,Set<symbol>>>();
const key=(canvasId:string,nodeId:string)=>JSON.stringify([canvasId,nodeId]);
export function h3LongformOwnsGeneration(doc:Document,canvasId:string,nodeId:string){return!!activeModes.get(doc)?.get(key(canvasId,nodeId))?.size;}
export function createH3LongformMode(doc:Document,canvasId:string,nodeId:string){
 const identity=Symbol('h3-longform'),scope=key(canvasId,nodeId);let active=false;
 const set=(next:boolean)=>{if(next===active)return;active=next;let modes=activeModes.get(doc);if(!modes){modes=new Map();activeModes.set(doc,modes);}let owners=modes.get(scope);if(next){if(!owners){owners=new Set();modes.set(scope,owners);}owners.add(identity);}else{owners?.delete(identity);if(!owners?.size)modes.delete(scope);}doc.defaultView?.dispatchEvent(new Event(h3LongformModeEvent));};
 return{set,dispose:()=>set(false)};
}

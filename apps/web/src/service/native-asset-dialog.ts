/** CanvasEditorShell and nested SketchStudio both mount the exact same
 * global-store asset dialog. Elect one mounted renderer; preserve its actual
 * component, inputs and save action rather than hiding a duplicate modal. */
export function installNativeAssetDialog(native:any,Dialog:any){
 const react=native?.r,jsx=native?.j;
 if(typeof Dialog!=='function'||typeof react?.useRef!=='function'||typeof react.useLayoutEffect!=='function'||typeof react.useSyncExternalStore!=='function'||typeof jsx?.jsx!=='function')return()=>{};
 const owners=new Set<object>(),listeners=new Set<()=>void>(),emit=()=>{for(const listener of [...listeners])listener();};
 const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},snapshot=()=>owners.values().next().value??null;
 const originalJsx=jsx.jsx;
 function SingleAssetDialog(props:any){
  const identity=react.useRef(null);if(!identity.current)identity.current={};const owner=identity.current;
  react.useLayoutEffect(()=>{owners.add(owner);emit();return()=>{owners.delete(owner);emit();};},[]);
  const current=react.useSyncExternalStore(subscribe,snapshot,()=>null);
  return current===owner?originalJsx(Dialog,props):null;
 }
 const installed:{name:string;original:Function;wrapper:Function}[]=[];
 for(const name of ['jsx','jsxs'])if(typeof jsx[name]==='function'){
  const original=jsx[name],wrapper=function(this:any,...args:any[]){if(args[0]===Dialog)args[0]=SingleAssetDialog;return Reflect.apply(original,this,args);};jsx[name]=wrapper;installed.push({name,original,wrapper});
 }
 // Already mounted wrappers retain their one owner until they unmount, so
 // disposing integration cannot remove an active form or replay its save.
 return()=>{for(const {name,original,wrapper}of installed)if(jsx[name]===wrapper)jsx[name]=original;};
}

/** Service canvases already keep local Yjs undo transactions. The frozen menu
 * and hotkeys read a separate snapshot-history store which older copy actions
 * never populate. Project only journal counts into that UI store and route all
 * history actions through the existing permission/lease guarded manager.
 * No second graph history or remote snapshot is created. */
export function installNativeEditHistory(runtime:any,native:any,surface:Window=window){
 const history=native.fA;if(!history?.getState||!history?.setState)return()=>{};
 let disposed=false,owner:any,release:(()=>void)|undefined;
 const keys=['saveHistory','clearHistory','undo','redo','canUndo','canRedo'];
 const attach=()=>{
  const next=runtime.canvasAttachment?.()?.client;if(next===owner)return;
  release?.();release=undefined;owner=next;
  if(next?.localOnly!==true||!next.undoManager||typeof next.subscribe!=='function')return;
  const original=Object.fromEntries(keys.map(key=>[key,history.getState()[key]]));
  const current=()=>!disposed&&owner===next&&runtime.canvasAttachment?.()?.client===next;
  const project=()=>{
   if(!current())return;
   const undo=next.canUndo()?next.undoManager.undoStack.length:0,redo=next.canRedo()?next.undoManager.redoStack.length:0,state=history.getState();
   // The native menu reads index/length only. Entries deliberately contain no
   // graph; save/undo/redo below never consume the legacy snapshot format.
   if(state.historyIndex!==undo||state.historyStack?.length!==undo+redo+1)history.setState({historyIndex:undo,historyStack:Array(undo+redo+1).fill(null),isHistoryAction:false});
  };
  const actions={saveHistory:project,clearHistory:()=>{if(current()){next.undoManager.clear();project();}},
   undo:()=>{if(current())return next.undo();},redo:()=>{if(current())return next.redo();},
   canUndo:()=>current()&&next.canUndo(),canRedo:()=>current()&&next.canRedo()};
  history.setState(actions);const unsubscribe=next.subscribe(project);project();
  release=()=>{unsubscribe?.();const restore:Record<string,any>={};for(const key of keys)if(history.getState()[key]===(actions as any)[key])restore[key]=original[key];history.setState({...restore,historyIndex:-1,historyStack:[],isHistoryAction:false});};
 };
 surface.addEventListener('rhtv:canvas-attachment',attach);attach();
 return()=>{disposed=true;release?.();surface.removeEventListener('rhtv:canvas-attachment',attach);};
}

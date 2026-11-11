// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {installNativeEditHistory} from '../../apps/web/src/service/native-edit-history';
const cleanups:(()=>void)[]=[];
afterEach(()=>{for(const dispose of cleanups.splice(0))dispose();});
function setup(){
 const callbacks=new Set<()=>void>(),state:any={historyIndex:-1,historyStack:[],undo:vi.fn(),redo:vi.fn(),saveHistory:vi.fn(),clearHistory:vi.fn(),canUndo:()=>false,canRedo:()=>false};
 const journal:any={undoStack:[],redoStack:[],clear:vi.fn(()=>{journal.undoStack=[];journal.redoStack=[];})};
 let readOnly=false;
 const manager:any={localOnly:true,undoManager:journal,subscribe:(fn:()=>void)=>{callbacks.add(fn);return()=>callbacks.delete(fn);},canUndo:()=>!readOnly&&journal.undoStack.length>0,canRedo:()=>!readOnly&&journal.redoStack.length>0,
  undo:vi.fn(()=>{if(manager.canUndo()){journal.redoStack.push(journal.undoStack.pop());emit();}}),redo:vi.fn(()=>{if(manager.canRedo()){journal.undoStack.push(journal.redoStack.pop());emit();}})};
 const emit=()=>{for(const fn of callbacks)fn();},runtime:any={canvasAttachment:()=>({client:manager})},native={fA:{getState:()=>state,setState:(patch:any)=>Object.assign(state,patch)}};
 const originals={...state},dispose=installNativeEditHistory(runtime,native);cleanups.push(dispose);
 return{state,manager,journal,emit,runtime,originals,dispose,readonly:()=>{readOnly=true;emit();}};
}
it('makes native menu and hotkeys use the same existing edit journal',()=>{
 const f=setup(),copy={kind:'pasteGraph'};f.journal.undoStack.push(copy);f.emit();expect(f.state.historyIndex).toBe(1);expect(f.state.historyStack).toHaveLength(2);expect(f.state.canUndo()).toBe(true);
 f.state.undo([],[]);expect(f.manager.undo).toHaveBeenCalledTimes(1);expect(f.journal.redoStack).toEqual([copy]);expect(f.state.historyIndex).toBe(0);expect(f.state.canRedo()).toBe(true);
 f.state.redo([],[]);expect(f.manager.redo).toHaveBeenCalledTimes(1);expect(f.journal.undoStack).toEqual([copy]);expect(f.state.historyIndex).toBe(1);
});
it('never saves a second graph history and projects permission loss into native controls',()=>{
 const f=setup();f.journal.undoStack.push({});f.state.saveHistory([{id:'node',data:{prompt:'private'}}],[]);expect(f.state.historyStack).toEqual([null,null]);expect(f.originals.saveHistory).not.toHaveBeenCalled();f.readonly();expect(f.state.canUndo()).toBe(false);expect(f.state.historyIndex).toBe(0);expect(f.state.historyStack).toHaveLength(1);
});
it('uses the latest guarded manager action instead of retaining an unguarded callback',()=>{
 const f=setup(),guarded=vi.fn();f.manager.undo=guarded;f.state.undo();expect(guarded).toHaveBeenCalledTimes(1);
});
it('clears only the attached journal and restores hooks on detach',()=>{
 const f=setup();f.journal.undoStack.push({});f.state.clearHistory();expect(f.journal.clear).toHaveBeenCalledTimes(1);expect(f.state.historyIndex).toBe(0);const stale=f.state.undo;f.runtime.canvasAttachment=()=>null;window.dispatchEvent(new Event('rhtv:canvas-attachment'));stale();expect(f.manager.undo).not.toHaveBeenCalled();expect(f.state.undo).toBe(f.originals.undo);expect(f.state.historyStack).toEqual([]);
});
it('does not replace native collaboration history when the service journal is absent',()=>{
 const state={undo:vi.fn()},setState=vi.fn();cleanups.push(installNativeEditHistory({canvasAttachment:()=>({client:{localOnly:false}})},{fA:{getState:()=>state,setState}}));expect(setState).not.toHaveBeenCalled();
});

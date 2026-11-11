import {describe,it,expect,vi} from 'vitest';
import {recoverBootstrapChunk,completeBootstrapRecovery} from '../../apps/web/src/runtime/bootstrap-recovery';

describe('initial bootstrap release recovery',()=>{
 const surface=()=>{const values=new Map<string,string>();return{sessionStorage:{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)},location:{reload:vi.fn()}} as any;};
 it('revalidates a stale history document once and stops a permanent missing-chunk loop',()=>{
  const tab=surface(),error=new Error('Failed to fetch dynamically imported module: /assets/runtime-old.js');
  expect(recoverBootstrapChunk(error,tab,()=>true)).toBe(true);
  expect(recoverBootstrapChunk(error,tab,()=>true)).toBe(false);
  expect(tab.location.reload).toHaveBeenCalledOnce();
  completeBootstrapRecovery(tab);
  expect(recoverBootstrapChunk(error,tab,()=>true)).toBe(true);
 });
 it('preserves ordinary bootstrap failures for the error view',()=>{
  const tab=surface();expect(recoverBootstrapChunk(new Error('Invalid public runtime configuration'),tab)).toBe(false);expect(tab.location.reload).not.toHaveBeenCalled();
 });
 it('does not reload without a usable loop guard',()=>{
  const tab=surface();tab.sessionStorage.getItem=()=>{throw new Error('storage blocked');};expect(recoverBootstrapChunk(new Error('Importing a module script failed.'),tab,()=>true)).toBe(false);expect(tab.location.reload).not.toHaveBeenCalled();
 });
 it('does not automatically reload unless the caller proves there is no mounted or editable document',()=>{
  const tab=surface(),error=new Error('Failed to fetch dynamically imported module');expect(recoverBootstrapChunk(error,tab)).toBe(false);expect(recoverBootstrapChunk(error,tab,()=>false)).toBe(false);expect(tab.location.reload).not.toHaveBeenCalled();expect(recoverBootstrapChunk(error,tab,()=>true)).toBe(true);
 });
});

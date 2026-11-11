import {expect,it,vi} from 'vitest';
import {installNativeAssetDialog} from '../../apps/web/src/service/native-asset-dialog';

/** React hook harness with separate stable instance refs and explicit layout
 * mount/cleanup replay. It exercises ownership without replacing native save. */
function setup(){
 let active:any;const instances=new Map<string,any>(),jsx=vi.fn((type:any,props:any)=>({type,props})),Dialog=vi.fn((props:any)=>({save:props.onSave}));
 const native:any={j:{jsx,jsxs:jsx},r:{useRef:()=>active.ref,useLayoutEffect:(effect:Function)=>{active.effect=effect;},useSyncExternalStore:(_subscribe:Function,snapshot:Function)=>snapshot()}};
 const release=installNativeAssetDialog(native,Dialog),Single=native.j.jsx(Dialog,{teamId:'team'}).type;
 const render=(id:string,props:any={})=>{let instance=instances.get(id);if(!instance){instance={ref:{current:null},effect:null,cleanup:null,props};instances.set(id,instance);}active=instance;const result=Single(instance.props);active=null;return result;};
 const mount=(id:string,props:any={})=>{render(id,props);const instance=instances.get(id);instance.cleanup=instance.effect();return render(id);};
 const unmount=(id:string)=>{instances.get(id).cleanup?.();};
 const replay=(id:string)=>{unmount(id);const instance=instances.get(id);instance.cleanup=instance.effect();return render(id);};
 return{native,Dialog,jsx,release,Single,render,mount,unmount,replay};
}

it('wraps only the exact imported CreateAssetDialog component identity in both native JSX paths',()=>{
 const s=setup(),other=function OtherDialog(){};
 expect(s.Single).not.toBe(s.Dialog);expect(s.native.j.jsx(other,{}).type).toBe(other);expect(s.native.j.jsxs(s.Dialog,{}).type).toBe(s.Single);expect(s.native.j.jsx('div',{}).type).toBe('div');s.release();
});

it('mounts a single actual asset form for two global-store subscribers and keeps one native save action',()=>{
 const s=setup(),save=vi.fn();s.mount('canvas',{teamId:'team',onSave:save});s.mount('sketch',{teamId:'team',onSave:save});const first=s.render('canvas'),second=s.render('sketch');expect(first.type).toBe(s.Dialog);expect(second).toBeNull();const form=first.type(first.props);form.save();expect(s.Dialog).toHaveBeenCalledOnce();expect(save).toHaveBeenCalledOnce();s.unmount('canvas');s.unmount('sketch');s.release();
});

it('keeps one owner across StrictMode layout cleanup/remount replay and repeated registration',()=>{
 const s=setup();s.mount('canvas');s.mount('sketch');s.replay('canvas');expect([s.render('canvas'),s.render('sketch')].filter(Boolean)).toHaveLength(1);s.replay('sketch');expect([s.render('canvas'),s.render('sketch')].filter(Boolean)).toHaveLength(1);s.mount('canvas');expect([s.render('canvas'),s.render('sketch')].filter(Boolean)).toHaveLength(1);s.unmount('canvas');s.unmount('sketch');s.release();
});

it('hands ownership to the remaining mounted renderer when the original canvas owner unmounts',()=>{
 const s=setup();s.mount('canvas',{teamId:'canvas-team'});s.mount('sketch',{teamId:'sketch-team'});expect(s.render('sketch')).toBeNull();s.unmount('canvas');const remaining=s.render('sketch');expect(remaining).toMatchObject({type:s.Dialog,props:{teamId:'sketch-team'}});s.unmount('sketch');s.release();
});

it('restores the JSX seam without closing an active form or replaying save on cleanup',()=>{
 const s=setup(),save=vi.fn();s.mount('canvas',{onSave:save});s.mount('sketch',{onSave:save});s.release();expect(s.native.j.jsx).toBe(s.jsx);expect(s.native.j.jsxs).toBe(s.jsx);const first=s.render('canvas');expect(s.render('sketch')).toBeNull();first.type(first.props).save();expect(save).toHaveBeenCalledOnce();s.unmount('canvas');s.unmount('sketch');
});

it('does not overwrite a later integration when this singleton adapter is disposed',()=>{
 const s=setup(),later=vi.fn();s.native.j.jsx=later;s.release();expect(s.native.j.jsx).toBe(later);expect(s.native.j.jsxs).toBe(s.jsx);
});

it('leaves unsupported native runtimes and unrelated components unchanged',()=>{
 const jsx=vi.fn(),native={j:{jsx},r:{useRef:vi.fn()}};installNativeAssetDialog(native,()=>null)();expect(native.j.jsx).toBe(jsx);
});

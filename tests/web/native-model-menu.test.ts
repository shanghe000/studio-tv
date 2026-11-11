import {afterEach,expect,it,vi} from 'vitest';
import {installNativeModelMenuViewport,modelMenuShift} from '../../apps/web/src/service/native-model-menu';

const rect=(left:number,top:number,width:number,height:number)=>({left,top,width,height,right:left+width,bottom:top+height});
const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
function fixture(assistant=true){
 const properties=new Map<string,[string,string]>([['z-index',['2100','']]]),attributes=new Map<string,string>(),cols=[rect(1577,638,310,118)],listeners=new Map<string,Function[]>(),windowListeners=new Map<string,Function[]>();let callback!:Function,shown=true;
 const style={getPropertyValue:(key:string)=>properties.get(key)?.[0]||'',getPropertyPriority:(key:string)=>properties.get(key)?.[1]||'',setProperty:(key:string,value:string,priority='')=>properties.set(key,[value,priority]),removeProperty:(key:string)=>properties.delete(key)};
 const panel={zIndex:'10000'},trigger={isConnected:true,closest:()=>assistant?panel:null},button={closest:(selector:string)=>selector==='.hcp-inline-video-model .glass-dropdown-trigger'?trigger:null};
 const offset=()=>{const [x,y]=(style.getPropertyValue('translate')||'0px 0px').split(' ').map(parseFloat);return{x,y};};
 const popup={style,setAttribute:(key:string,value:string)=>attributes.set(key,value),removeAttribute:(key:string)=>attributes.delete(key),getBoundingClientRect:()=>rect(1572,633,320,128),querySelectorAll:()=>cols.map(bounds=>({getBoundingClientRect:()=>{const {x,y}=offset();return rect(bounds.left+x,bounds.top+y,bounds.width,bounds.height);}}))};
 const view={requestAnimationFrame:(fn:Function)=>queueMicrotask(()=>fn()),innerWidth:1908,innerHeight:830,getComputedStyle:(element:any)=>element===panel?panel:{display:shown?'block':'none',visibility:'visible'},addEventListener:(name:string,fn:Function)=>windowListeners.set(name,fn),removeEventListener:vi.fn()};
 const documentRoot={body:{},defaultView:view,querySelectorAll:()=>[popup],addEventListener:(name:string,fn:Function)=>listeners.set(name,fn),removeEventListener:vi.fn()};
 const disconnect=vi.fn();vi.stubGlobal('MutationObserver',class{constructor(fn:Function){callback=fn;}observe(){}disconnect=disconnect;});
 return{documentRoot:documentRoot as unknown as Document,style,attributes,cols,view,popup,disconnect,listeners,windowListeners,open:()=>listeners.get('click')!({target:button}),change:()=>callback([]),hide:()=>{shown=false;callback([]);}};
}
afterEach(()=>vi.unstubAllGlobals());
it('measures flyout bounds beyond the native root and shifts the entire cascade within the viewport',()=>{
 expect(modelMenuShift([rect(1577,638,310,118),rect(1891,645,258,70)],1908,830)).toEqual({x:-249,y:0});expect(modelMenuShift([rect(700,80,310,118),rect(1014,87,258,70)],1908,830)).toEqual({x:0,y:0});expect(modelMenuShift([rect(-20,-40,310,118)],1908,830)).toEqual({x:28,y:48});
});
it('raises only the active assistant video portal and reclamps the actual expanded leaf without altering native callbacks or inset',async()=>{
 const f=fixture(),dispose=installNativeModelMenuViewport(f.documentRoot);f.open();await flush();expect(f.style.getPropertyValue('z-index')).toBe('10001');expect(f.style.getPropertyPriority('z-index')).toBe('important');expect(f.style.getPropertyValue('translate')).toBe('0px 0px');
 f.cols.push(rect(1891,645,258,70));f.change();await flush();expect(f.style.getPropertyValue('translate')).toBe('-249px 0px');expect(f.cols[1].right-249).toBe(1900);f.change();await flush();expect(f.style.getPropertyValue('translate')).toBe('-249px 0px');expect(f.style.getPropertyValue('inset')).toBe('');f.cols.pop();f.change();await flush();expect(f.style.getPropertyValue('translate')).toBe('0px 0px');
 f.hide();await flush();expect(f.style.getPropertyValue('z-index')).toBe('2100');expect(f.style.getPropertyPriority('z-index')).toBe('');expect(f.style.getPropertyValue('translate')).toBe('');expect(f.attributes.size).toBe(0);dispose();expect(f.disconnect).toHaveBeenCalledOnce();expect(f.documentRoot.removeEventListener).toHaveBeenCalledTimes(2);
});
it('leaves non-assistant model portals unchanged and restores the original styles on disposal',async()=>{
 const outside=fixture(false),release=installNativeModelMenuViewport(outside.documentRoot);outside.open();await flush();expect(outside.style.getPropertyValue('z-index')).toBe('2100');expect(outside.attributes.size).toBe(0);release();
 const f=fixture(),dispose=installNativeModelMenuViewport(f.documentRoot);f.open();await flush();expect(f.attributes.get('data-studio-assistant-model-menu')).toBe('true');dispose();expect(f.style.getPropertyValue('z-index')).toBe('2100');expect(f.style.getPropertyValue('translate')).toBe('');
});

it('does not rewrite a browser-normalized one-axis CSS translation',async()=>{
 const f=fixture(),dispose=installNativeModelMenuViewport(f.documentRoot);f.cols.push(rect(1891,645,258,70));f.open();await flush();
 f.style.setProperty('translate','-249px','important');const spy=vi.spyOn(f.style,'setProperty');
 // Real CSSOM omits a zero y component. Layout still has the same offset.
 const original=f.popup.querySelectorAll;f.popup.querySelectorAll=()=>[{getBoundingClientRect:()=>rect(1328,638,310,118)},{getBoundingClientRect:()=>rect(1642,645,258,70)}];f.change();await flush();expect(spy).not.toHaveBeenCalled();f.popup.querySelectorAll=original;dispose();
});

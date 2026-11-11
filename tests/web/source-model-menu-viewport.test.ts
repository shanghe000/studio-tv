// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {installSourceModelMenuViewport,sourceModelMenuColumnHeight} from '../../apps/web/src/service/native-model-menu';

let stop:(()=>void)|undefined;
afterEach(()=>{stop?.();stop=undefined;document.body.replaceChildren();vi.restoreAllMocks();});
const bounds=(left:number,top:number,width:number,height:number)=>({left,top,width,height,right:left+width,bottom:top+height});
function fixture(scale=1){
 document.body.innerHTML='<div class="canvas-bottom-controls-row"></div><div class="mg-cascade-overlay"><div class="studio-model-source-menu"><div class="mg-cascade-panel"><div class="mg-cascade-panel__col mg-cascade-panel__col--root"></div><div class="mg-cascade-panel__col mg-cascade-panel__col--flyout"><button>First</button><button>Last model</button></div></div></div></div><div class="mg-cascade-panel__col mg-cascade-panel__col--flyout" id="unrelated"></div>';
 const root=document.querySelector<HTMLElement>('.mg-cascade-panel__col--root')!,flyout=document.querySelector<HTMLElement>('.studio-model-source-menu .mg-cascade-panel__col--flyout')!,chrome=document.querySelector<HTMLElement>('.canvas-bottom-controls-row')!,state={top:475,height:420,content:421};
 for(const column of [root,flyout]){column.style.boxSizing='border-box';Object.defineProperty(column,'offsetWidth',{value:260/scale,configurable:true});Object.defineProperty(column,'scrollHeight',{get:()=>state.content});Object.defineProperty(column,'clientHeight',{get:()=>Math.min(state.height/scale,Number.parseFloat(column.style.maxHeight)||420/scale)});vi.spyOn(column,'getBoundingClientRect').mockImplementation(()=>bounds(column===root?76:404,state.top,260,Math.min(state.height,(Number.parseFloat(column.style.maxHeight)||420/scale)*scale)) as DOMRect);}
 vi.spyOn(chrome,'getBoundingClientRect').mockReturnValue(bounds(16,707,379,38) as DOMRect);Object.defineProperty(window,'innerHeight',{value:757,configurable:true});return{root,flyout,chrome,state};
}

it('makes the last API model reachable inside the real475px-top flyout instead of clipping the fixed420px list',()=>{
 const f=fixture();stop=installSourceModelMenuViewport();expect(f.flyout.style.maxHeight).toBe('220px');expect(f.flyout.getBoundingClientRect().bottom).toBe(695);expect(getComputedStyle(f.flyout).overflowY).toBe('auto');expect(f.flyout.scrollHeight-f.flyout.clientHeight).toBe(201);f.flyout.scrollTop=f.flyout.scrollHeight-f.flyout.clientHeight;expect(f.flyout.scrollTop+f.flyout.clientHeight).toBe(f.flyout.scrollHeight);expect(document.querySelector('#unrelated')?.hasAttribute('data-studio-source-menu-scroll')).toBe(false);
});

it('recomputes self-hosted flyout room on an anchor move and converts screen room through actual scale',async()=>{
 const f=fixture(.4);stop=installSourceModelMenuViewport();expect(f.flyout.style.maxHeight).toBe('550px');expect(f.flyout.getBoundingClientRect().bottom).toBe(695);f.state.top=575;f.flyout.classList.add('new-category');await vi.waitFor(()=>expect(f.flyout.style.maxHeight).toBe('300px'));expect(f.flyout.getBoundingClientRect().bottom).toBe(695);expect(sourceModelMenuColumnHeight(575,695,.4)).toBe(300);
 f.chrome.style.display='none';await vi.waitFor(()=>expect(f.flyout.style.maxHeight).toBe('425px'));expect(f.flyout.getBoundingClientRect().bottom).toBe(745);
});

it('restores prior styles when the portal closes and preserves a later extension override on disposal',async()=>{
 const f=fixture();f.flyout.style.setProperty('max-height','420px');f.flyout.style.overflowY='scroll';stop=installSourceModelMenuViewport();f.flyout.style.display='none';await vi.waitFor(()=>expect(f.flyout.style.maxHeight).toBe('420px'));expect(f.flyout.style.overflowY).toBe('scroll');expect(f.flyout.hasAttribute('data-studio-source-menu-scroll')).toBe(false);f.flyout.style.display='';await vi.waitFor(()=>expect(f.flyout.style.maxHeight).toBe('220px'));f.flyout.style.setProperty('max-height','200px');stop();stop=undefined;expect(f.flyout.style.maxHeight).toBe('200px');expect(f.flyout.style.overflowY).toBe('scroll');
});

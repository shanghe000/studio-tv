// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {imageToolViewportShift,installImageToolViewport} from '../../apps/web/src/service/image-tool-viewport';

let stop:(()=>void)|undefined;
afterEach(()=>{stop?.();stop=undefined;document.body.innerHTML='';vi.restoreAllMocks();});
const bounds=(left:number,top:number,width:number,height:number)=>({left,top,right:left+width,bottom:top+height,width,height});
it('keeps portrait actions inside each viewport edge without moving an already fitting panel',()=>{
 expect(imageToolViewportShift(bounds(400,402,680,600),1908,830)).toEqual({x:0,y:-184});
 expect(imageToolViewportShift(bounds(-30,-20,680,600),1000,830)).toEqual({x:42,y:32});
 expect(imageToolViewportShift(bounds(800,100,680,600),1000,830)).toEqual({x:-492,y:0});
 expect(imageToolViewportShift(bounds(100,100,680,600),1908,830)).toEqual({x:0,y:0});
 expect(imageToolViewportShift(bounds(100,200,680,600),400,300)).toEqual({x:-88,y:-188});
});

function panel(inverse=1.5){
 document.body.innerHTML='<div class="react-flow__node-rh-image"><div class="rh-node-shell-body"><div class="rh-image-node-local-ui"><div class="rh-character-emotion-anchor"><div class="rh-character-emotion-dialog" role="dialog"><button>Generate</button></div></div></div></div></div><div class="rh-character-emotion-dialog" id="unrelated" role="dialog"></div>';
 const body=document.querySelector<HTMLElement>('.rh-node-shell-body')!,anchor=document.querySelector<HTMLElement>('.rh-character-emotion-anchor')!,dialog=anchor.firstElementChild as HTMLElement;
 body.style.setProperty('--rh-node-ui-inverse-scale',String(inverse));anchor.style.transform='translateX(-50%) scale(var(--rh-node-ui-inverse-scale))';
 Object.defineProperty(window,'innerWidth',{value:1908,configurable:true});Object.defineProperty(window,'innerHeight',{value:830,configurable:true});
 const rect=vi.spyOn(dialog,'getBoundingClientRect').mockImplementation(()=>{const [x,y]=anchor.style.translate.split(' ').map(Number.parseFloat);return bounds(500+(x||0)/inverse,402+(y||0)/inverse,680,600) as DOMRect;});
 return{body,anchor,dialog,rect};
}
it('compensates the actual canvas scale, keeps the native transform and only fits owned image dialogs',async()=>{
 const p=panel();stop=installImageToolViewport();
 expect(p.anchor.style.translate).toBe('0px -276px');expect(p.anchor.style.transform).toContain('translateX(-50%)');
 expect(p.dialog.getAttribute('data-studio-image-tool-viewport')).toBe('true');expect(document.querySelector('#unrelated')?.hasAttribute('data-studio-image-tool-viewport')).toBe(false);
 // An observer refresh must not add the offset repeatedly.
 p.dialog.classList.add('repaint');await vi.waitFor(()=>expect(p.anchor.style.translate).toBe('0px -276px'));
 expect(p.rect().bottom).toBe(818);stop();stop=undefined;expect(p.anchor.style.translate).toBe('');expect(p.dialog.hasAttribute('data-studio-image-tool-viewport')).toBe(false);
});
it('does not replace another extension translate and preserves later external changes on cleanup',()=>{
 const p=panel();p.anchor.style.translate='8px 9px';stop=installImageToolViewport();expect(p.anchor.style.translate).toBe('8px 9px');expect(p.dialog.hasAttribute('data-studio-image-tool-viewport')).toBe(false);stop();
 p.anchor.style.removeProperty('translate');stop=installImageToolViewport();p.anchor.style.translate='22px 44px';stop();stop=undefined;expect(p.anchor.style.translate).toBe('22px 44px');
});
it('restores a replaced anchor and fits the new dialog on the next mutation',async()=>{
 const p=panel(1);stop=installImageToolViewport();p.anchor.remove();
 await vi.waitFor(()=>expect(p.anchor.style.translate).toBe(''));expect(p.dialog.hasAttribute('data-studio-image-tool-viewport')).toBe(false);
});
it('uses the browser serialized fractional displacement without creating a style mutation loop',async()=>{
 const p=panel(1.4483370917680864),write=p.anchor.style.setProperty.bind(p.anchor.style);
 const writes=vi.spyOn(p.anchor.style,'setProperty').mockImplementation((name,value,priority)=>write(name,name==='translate'?String(value).split(' ').map(x=>Number.parseFloat(x).toFixed(3)+'px').join(' '):value,priority));
 stop=installImageToolViewport();
 await new Promise<void>(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(()=>resolve())));
 expect(writes).toHaveBeenCalledTimes(1);expect(Math.abs(p.rect().bottom-818)).toBeLessThan(.001);
 stop();stop=undefined;expect(p.anchor.style.translate).toBe('');
});

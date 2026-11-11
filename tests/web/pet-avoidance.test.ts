// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {installCanvasCompanionAvoidance} from '../../apps/web/src/brand/pet-avoidance';
let dispose:(()=>void)|undefined;
afterEach(()=>{dispose?.();dispose=undefined;document.body.innerHTML='';document.body.className='';vi.useRealTimers();});
const rect=(x:number,y:number,w:number,h:number)=>new DOMRect(x,y,w,h);
function fixture(){
 document.body.className='rh-canvas-route-active';document.body.innerHTML='<div class="agent-fab" style="left:1380px;top:640px"><button class="agent-fab__motion" aria-label="Studio 画布伙伴"><span class="studio-pet-overlay"></span></button></div><div class="config-panel-wrap"><button class="generate-action-button">生成</button></div>';
 const pet=document.querySelector<HTMLElement>('.agent-fab')!,motion=document.querySelector<HTMLElement>('.agent-fab__motion')!,panel=document.querySelector<HTMLElement>('.config-panel-wrap')!,run=document.querySelector<HTMLElement>('.generate-action-button')!;
 let panelRect=rect(1320,600,220,110);
 pet.getBoundingClientRect=()=>rect(1380,640,80,80);motion.getBoundingClientRect=pet.getBoundingClientRect;panel.getBoundingClientRect=()=>panelRect;run.getBoundingClientRect=()=>rect(1372,661,100,30);
 dispose=installCanvasCompanionAvoidance();return{pet,motion,panel,run,move:(value:DOMRect)=>{panelRect=value;panel.style.left=value.left+'px';}};
}
const painted=()=>new Promise(resolve=>setTimeout(resolve,35));
it('yields the hit area over the reported right-side Run button, restores it when the composer moves, and never moves another control',async()=>{
 const {pet,motion,run,move}=fixture(),before=pet.style.cssText,onRun=vi.fn();run.addEventListener('click',onRun);
 expect(getComputedStyle(motion).visibility).toBe('hidden');expect(getComputedStyle(motion).pointerEvents).toBe('none');expect(pet.style.cssText).toBe(before);
 document.body.append(document.createElement('span'));await painted();expect(getComputedStyle(motion).visibility).toBe('hidden');
 run.click();expect(onRun).toHaveBeenCalledOnce();move(rect(100,100,220,110));await painted();expect(pet.hasAttribute('data-studio-companion-yielding')).toBe(false);expect(getComputedStyle(motion).visibility).not.toBe('hidden');expect(pet.style.cssText).toBe(before);
});
it('restores the same companion when an overlapping composer closes or becomes hidden, including a mounted replacement',async()=>{
 const {pet,panel}=fixture();panel.hidden=true;await painted();expect(pet.hasAttribute('data-studio-companion-yielding')).toBe(false);
 panel.hidden=false;await painted();expect(pet.hasAttribute('data-studio-companion-yielding')).toBe(true);
 panel.remove();await painted();expect(pet.hasAttribute('data-studio-companion-yielding')).toBe(false);
 const next=document.createElement('div');next.className='group-toolbar';next.getBoundingClientRect=()=>rect(1370,630,140,60);document.body.append(next);await painted();expect(pet.hasAttribute('data-studio-companion-yielding')).toBe(true);
});
it('does not hide for an offscreen, zero-size or unrelated panel and cleans up on route/disposal',async()=>{
 const {pet,panel,move}=fixture();move(rect(-800,600,220,110));await painted();expect(pet.hasAttribute('data-studio-companion-yielding')).toBe(false);
 move(rect(1380,640,0,0));await painted();expect(pet.hasAttribute('data-studio-companion-yielding')).toBe(false);
 move(rect(1320,600,220,110));panel.style.visibility='hidden';await painted();expect(pet.hasAttribute('data-studio-companion-yielding')).toBe(false);
 panel.style.visibility='visible';await painted();expect(pet.hasAttribute('data-studio-companion-yielding')).toBe(true);
 document.body.className='';await painted();expect(pet.hasAttribute('data-studio-companion-yielding')).toBe(false);
 document.body.className='rh-canvas-route-active';await painted();expect(pet.hasAttribute('data-studio-companion-yielding')).toBe(true);dispose!();dispose=undefined;expect(pet.hasAttribute('data-studio-companion-yielding')).toBe(false);
});

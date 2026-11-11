// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {imageComposerBounds,installCanvasComposerViewport,videoComposerViewportShift,videoComposerUsableBounds,videoComposerToolbarBounds} from '../../apps/web/src/service/video-composer-viewport';
import {h3LongformStyles} from '../../apps/web/src/service/h3-longform-controls';

let stop:(()=>void)|undefined;
afterEach(()=>{stop?.();stop=undefined;document.body.innerHTML='';vi.restoreAllMocks();});
const bounds=(left:number,top:number,width:number,height:number)=>({left,top,right:left+width,bottom:top+height,width,height});

it('keeps the real 30% zoom acceptance composer and its bottom actions on screen',()=>{
 expect(videoComposerViewportShift(bounds(479,556,880,280),1500,745)).toEqual({x:0,y:-103});
 expect(videoComposerViewportShift(bounds(-40,-20,880,280),1500,745)).toEqual({x:52,y:32});
 expect(videoComposerViewportShift(bounds(100,100,880,280),1500,745)).toEqual({x:0,y:0});
 expect(videoComposerViewportShift(bounds(100,300,880,900),500,745)).toEqual({x:-88,y:-288});
});

function composer(zoom=.3,contentHeight=280){
 const inverse=Math.min(8,1/zoom),effective=zoom*inverse;
 document.body.innerHTML='<div class="react-flow__viewport"><div class="react-flow__node react-flow__node-rh-video" data-id="video"><div class="rh-canvas-node has-node-plus"><div class="rh-node-shell-body"><div class="rh-node-local-selection-ui"><div class="config-panel-wrap rh-canvas-compact-input-panel rh-canvas-video-params" data-testid="canvas-video-params" data-target-node-id="video"><button class="config-panel-wrap__expand-btn"></button><div class="config-panel-wrap__basic"><div class="video-input-wrap"><button>Model</button></div><div class="config-row"><button class="generate-action-button">Generate</button></div></div></div></div></div></div></div></div><div class="config-panel-modal-content rh-canvas-video-params"></div><div class="config-panel-wrap rh-canvas-compact-input-panel rh-canvas-video-params" data-testid="canvas-video-params" data-target-node-id="unrelated" id="unrelated"></div>';
 const viewport=document.querySelector<HTMLElement>('.react-flow__viewport')!,shell=document.querySelector<HTMLElement>('.rh-node-shell-body')!,panel=document.querySelector<HTMLElement>('[data-target-node-id="video"]')!,basic=panel.querySelector<HTMLElement>('.config-panel-wrap__basic')!;
 viewport.style.transform=`translate(100px, 20px) scale(${zoom})`;shell.style.setProperty('--rh-node-ui-inverse-scale',String(inverse));panel.style.transform='translateX(-50%) scale(var(--rh-node-ui-inverse-scale))';
 Object.defineProperty(window,'innerWidth',{value:1500,configurable:true});Object.defineProperty(window,'innerHeight',{value:745,configurable:true});
 const native={left:479,top:556,contentHeight};
 Object.defineProperty(basic,'scrollHeight',{get:()=>native.contentHeight,configurable:true});
 vi.spyOn(basic,'getBoundingClientRect').mockImplementation(()=>bounds(479,556,880*effective,Math.min(native.contentHeight,Math.max(1,window.innerHeight-24)/effective)*effective) as DOMRect);
 const rect=vi.spyOn(panel,'getBoundingClientRect').mockImplementation(()=>{const [x,y]=panel.style.translate.split(' ').map(Number.parseFloat),height=panel.hasAttribute('data-studio-video-composer-viewport')?Math.min(native.contentHeight*effective,(Number.parseFloat(panel.style.getPropertyValue('--studio-video-composer-max-height'))||Math.max(1,window.innerHeight-24)/effective)*effective):native.contentHeight*effective;return bounds(native.left+(x||0)*zoom,native.top+(y||0)*zoom,880*effective,height) as DOMRect;});
 return{viewport,shell,panel,basic,native,rect};
}

it('preserves native placement and callbacks while compensating the actual canvas zoom',async()=>{
 const p=composer();stop=installCanvasComposerViewport();
 expect(p.panel.style.translate).toBe('0px -343.33333333333337px');expect(p.rect().bottom).toBeCloseTo(733);expect(p.panel.style.transform).toBe('translateX(-50%) scale(var(--rh-node-ui-inverse-scale))');expect(p.panel.getAttribute('data-studio-video-composer-viewport')).toBe('true');expect(document.querySelector('#unrelated')?.hasAttribute('data-studio-video-composer-viewport')).toBe(false);expect(document.querySelector('.config-panel-modal-content')?.hasAttribute('data-studio-video-composer-viewport')).toBe(false);
 p.basic.classList.add('repaint');await new Promise<void>(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(()=>resolve())));expect(p.rect().bottom).toBeCloseTo(733);
 stop();stop=undefined;expect(p.panel.style.translate).toBe('');expect(p.panel.hasAttribute('data-studio-video-composer-viewport')).toBe(false);
});

it('uses actual canvas zoom after native inverse scale reaches its cap',()=>{
 const p=composer(.05);p.native.contentHeight=1000;stop=installCanvasComposerViewport();
 expect(p.panel.style.translate).toBe('0px -4460px');expect(p.rect().bottom).toBeCloseTo(733);expect(Number.parseFloat(p.panel.style.getPropertyValue('--studio-video-composer-max-height'))).toBeCloseTo(1802.5);
});

it('scrolls the basic and advanced content without clipping the model portal host',async()=>{
 const p=composer(.3,1100),flyout=document.createElement('div');flyout.className='mg-cascade-overlay';p.panel.append(flyout);Object.defineProperty(flyout,'scrollHeight',{value:2000});
 stop=installCanvasComposerViewport();expect(p.panel.getAttribute('data-studio-video-composer-scroll')).toBe('true');expect(window.getComputedStyle(p.panel).overflow).toBe('visible');expect(window.getComputedStyle(p.basic).overflow).toBe('auto');expect(Number.parseFloat(window.getComputedStyle(p.basic).minHeight)).toBe(0);expect(p.rect().top).toBeCloseTo(12);expect(p.rect().bottom).toBeCloseTo(733);
 p.native.contentHeight=280;p.basic.textContent='shorter content';await vi.waitFor(()=>expect(p.panel.hasAttribute('data-studio-video-composer-scroll')).toBe(false));expect(p.rect().bottom).toBeCloseTo(733);expect(p.panel.querySelector('.mg-cascade-overlay')).toBe(flyout);
});

it('keeps a model flyout from changing the content scroll mode',()=>{
 const p=composer(),flyout=document.createElement('div');flyout.className='mg-cascade-overlay';p.panel.append(flyout);Object.defineProperty(flyout,'scrollHeight',{value:2000});vi.spyOn(flyout,'getBoundingClientRect').mockReturnValue(bounds(500,100,900,1400) as DOMRect);
 stop=installCanvasComposerViewport();expect(p.panel.hasAttribute('data-studio-video-composer-scroll')).toBe(false);expect(window.getComputedStyle(p.panel).overflow).toBe('visible');
});

it('fits an opened advanced section without changing its parameter content',async()=>{
 const p=composer(),advanced=document.createElement('div');advanced.className='config-panel-wrap__advanced';advanced.textContent='Subject mapping and output controls';Object.defineProperty(advanced,'scrollHeight',{value:900});vi.spyOn(advanced,'getBoundingClientRect').mockReturnValue(bounds(479,836,880,900) as DOMRect);stop=installCanvasComposerViewport();p.panel.append(advanced);
 await vi.waitFor(()=>expect(p.panel.getAttribute('data-studio-video-composer-scroll')).toBe('true'));expect(window.getComputedStyle(advanced).overflow).toBe('auto');expect(advanced.textContent).toBe('Subject mapping and output controls');
});

it('responds to viewport resize, restores disconnected panels and preserves other extension placement',async()=>{
 const p=composer();p.panel.style.translate='8px 9px';stop=installCanvasComposerViewport();expect(p.panel.style.translate).toBe('8px 9px');expect(p.panel.hasAttribute('data-studio-video-composer-viewport')).toBe(false);stop();p.panel.style.removeProperty('translate');
 stop=installCanvasComposerViewport();Object.defineProperty(window,'innerHeight',{value:900,configurable:true});window.dispatchEvent(new Event('resize'));await vi.waitFor(()=>expect(p.panel.style.translate).toBe('0px 0px'));
 p.panel.remove();await vi.waitFor(()=>expect(p.panel.style.translate).toBe(''));expect(p.panel.hasAttribute('data-studio-video-composer-viewport')).toBe(false);
});

it('keeps the scroll variant stable when removing the native minimum changes the content height',async()=>{
 const p=composer();Object.defineProperty(window,'innerHeight',{value:270,configurable:true});p.native.contentHeight=240;p.basic.style.minHeight='278px';Object.defineProperty(p.basic,'scrollHeight',{get:()=>p.panel.hasAttribute('data-studio-video-composer-scroll')?240:278,configurable:true});const writes=vi.spyOn(p.panel,'setAttribute');stop=installCanvasComposerViewport();
 await new Promise<void>(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(()=>resolve())));expect(p.panel.getAttribute('data-studio-video-composer-scroll')).toBe('true');expect(writes.mock.calls.filter(([name])=>name==='data-studio-video-composer-scroll')).toHaveLength(1);expect(p.rect().bottom).toBeCloseTo(258);
});

it('restores prior owned markers and does not overwrite later external limit values on cleanup',()=>{
 const p=composer();p.panel.setAttribute('data-studio-video-composer-scroll','true');p.panel.style.setProperty('--studio-video-composer-max-width','920px');stop=installCanvasComposerViewport();expect(p.panel.hasAttribute('data-studio-video-composer-scroll')).toBe(false);p.panel.style.setProperty('--studio-video-composer-max-width','1200px');stop();stop=undefined;
 expect(p.panel.getAttribute('data-studio-video-composer-scroll')).toBe('true');expect(p.panel.style.getPropertyValue('--studio-video-composer-max-width')).toBe('1200px');expect(p.panel.style.getPropertyValue('--studio-video-composer-max-height')).toBe('');expect(p.panel.style.translate).toBe('');
});

it('raises only a failed card input/output handle above its failure overlay',()=>{
 composer();const shell=document.querySelector('.rh-node-shell-body')!;shell.insertAdjacentHTML('afterbegin','<div class="rh-node-handle"></div><div class="rh-node-card-stack"><div class="rh-node-card"><div class="rh-node-fail-overlay"></div></div></div>');document.body.insertAdjacentHTML('beforeend','<div class="rh-canvas-node has-node-plus"><div class="rh-node-shell-body"><div class="rh-node-handle" id="healthy-handle"></div><div class="rh-node-card-stack"><div class="rh-node-card"></div></div></div></div>');stop=installCanvasComposerViewport();const handle=shell.querySelector('.rh-node-handle')!;
 expect(window.getComputedStyle(handle).zIndex).toBe('13');expect(window.getComputedStyle(handle).pointerEvents).toBe('');expect(window.getComputedStyle(document.querySelector('#healthy-handle')!).zIndex).toBe('');
});

it('keeps the real lower-left model action clear of the side toolbar and bottom reset controls',async()=>{
 const p=composer(.3,277);p.native.left=42;p.native.top=467;document.body.insertAdjacentHTML('beforeend','<aside class="canvas-toolbar"></aside><div class="canvas-bottom-controls-row"><div class="canvas-bottom-pill"><button class="reset-btn"></button></div></div>');const side=document.querySelector<HTMLElement>('.canvas-toolbar')!,bottom=document.querySelector<HTMLElement>('.canvas-bottom-controls-row')!;
 vi.spyOn(side,'getBoundingClientRect').mockReturnValue(bounds(16,186,48,383) as DOMRect);vi.spyOn(bottom,'getBoundingClientRect').mockReturnValue(bounds(16,707,379,38) as DOMRect);
 stop=installCanvasComposerViewport();expect(p.rect().left).toBeCloseTo(76);expect(p.rect().bottom).toBeCloseTo(695);expect(p.rect().right).toBeLessThan(window.innerWidth-12);expect(p.panel.style.transform).toBe('translateX(-50%) scale(var(--rh-node-ui-inverse-scale))');expect(p.panel.querySelector('button')?.textContent).not.toContain('reset');
 p.native.contentHeight=1100;p.basic.append(document.createElement('p'));await vi.waitFor(()=>expect(p.panel.getAttribute('data-studio-video-composer-scroll')).toBe('true'));expect(p.rect().top).toBeCloseTo(12);expect(p.rect().bottom).toBeCloseTo(695);expect(Number.parseFloat(p.panel.style.getPropertyValue('--studio-video-composer-max-height'))).toBeCloseTo(683);
 bottom.style.display='none';side.style.display='none';await vi.waitFor(()=>expect(p.rect().bottom).toBeCloseTo(733));expect(p.rect().left).toBeCloseTo(42);
});

it('uses reserved control bands when computing scroll room, including at capped inverse zoom',()=>{
 const area=videoComposerUsableBounds(1500,745,{side:bounds(16,186,48,383),bottom:bounds(16,707,379,38)});expect(area).toEqual({left:76,right:1488,top:12,bottom:695,width:1412,height:683});
 expect(videoComposerViewportShift(bounds(42,467,880,277),1500,745,area)).toEqual({x:34,y:-49});
 const p=composer(.05,2000);document.body.insertAdjacentHTML('beforeend','<div class="canvas-bottom-controls-row"></div>');vi.spyOn(document.querySelector('.canvas-bottom-controls-row')!,'getBoundingClientRect').mockReturnValue(bounds(16,707,379,38) as DOMRect);stop=installCanvasComposerViewport();expect(p.rect().top).toBeCloseTo(12);expect(p.rect().bottom).toBeCloseTo(695);expect(Number.parseFloat(p.panel.style.getPropertyValue('--studio-video-composer-max-height'))).toBeCloseTo(1707.5);
});

it('chooses a fitting side of the owning toolbar, then scroll room or smaller movement',()=>{
 const area=bounds(12,12,1476,669),toolbar=bounds(201,364,925,40);
 expect(videoComposerToolbarBounds(bounds(224,378,880,303),area,toolbar)).toEqual(bounds(12,12,1476,340));
 expect(videoComposerToolbarBounds(bounds(224,12,880,669),area,toolbar)).toEqual(bounds(12,12,1476,340));
 expect(videoComposerToolbarBounds(bounds(224,120,880,303),area,bounds(201,100,925,40))).toEqual(bounds(12,152,1476,529));
 const middle=bounds(201,300,925,40);
 expect(videoComposerToolbarBounds(bounds(224,200,880,200),area,middle)).toEqual(bounds(12,12,1476,276));
 expect(videoComposerToolbarBounds(bounds(224,280,880,100),area,middle)).toEqual(bounds(12,352,1476,329));
 expect(videoComposerToolbarBounds(bounds(224,378,880,303),area,bounds(1200,364,200,40))).toBe(area);
});

function owningToolbar(p:ReturnType<typeof composer>,rect= bounds(201,364,925,40)){
 const toolbar=document.createElement('div');toolbar.className='rh-canvas-video-toolbar';p.panel.closest('.react-flow__node')!.append(toolbar);vi.spyOn(toolbar,'getBoundingClientRect').mockReturnValue(rect as DOMRect);return toolbar;
}
function acceptanceBottomControls(){
 const bottom=document.createElement('div');bottom.className='canvas-bottom-controls-row';document.body.append(bottom);vi.spyOn(bottom,'getBoundingClientRect').mockReturnValue(bounds(16,693,379,52) as DOMRect);
}

it('keeps the captured 30% composer hint clear of its own higher toolbar without changing native placement or callbacks',async()=>{
 const p=composer(.3,303);p.native.left=224;p.native.top=378;const toolbar=owningToolbar(p);acceptanceBottomControls();const button=p.panel.querySelector('button')!,callback=vi.fn();button.onclick=callback;const write=vi.spyOn(p.panel.style,'setProperty');
 stop=installCanvasComposerViewport();expect(p.rect().top).toBeCloseTo(49);expect(p.rect().bottom).toBeCloseTo(352);expect(p.rect().bottom).toBeLessThan(toolbar.getBoundingClientRect().top);expect(p.panel.hasAttribute('data-studio-video-composer-scroll')).toBe(false);expect(Number.parseFloat(p.panel.style.getPropertyValue('--studio-video-composer-max-height'))).toBeCloseTo(340);
 expect(p.panel.style.transform).toBe('translateX(-50%) scale(var(--rh-node-ui-inverse-scale))');expect(button.onclick).toBe(callback);expect(toolbar.style.zIndex).toBe('');
 p.basic.classList.add('repaint');await new Promise<void>(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(()=>resolve())));expect(p.rect().bottom).toBeCloseTo(352);expect(write.mock.calls.filter(([name])=>name==='--studio-video-composer-max-height')).toHaveLength(1);
});

it('moves below an owning toolbar when that side fits the whole composer',()=>{
 const p=composer(.3,303);p.native.left=224;p.native.top=120;const toolbar=owningToolbar(p,bounds(201,100,925,40));stop=installCanvasComposerViewport();
 expect(p.rect().top).toBeCloseTo(152);expect(p.rect().top).toBeGreaterThan(toolbar.getBoundingClientRect().bottom);expect(p.panel.hasAttribute('data-studio-video-composer-scroll')).toBe(false);
});

it('limits tall content to the larger toolbar-free side and keeps popup portals outside the scroller',async()=>{
 const p=composer(.3,1100);p.native.left=224;p.native.top=378;const toolbar=owningToolbar(p);acceptanceBottomControls();const flyout=document.createElement('div');flyout.className='mg-cascade-overlay';p.panel.append(flyout);Object.defineProperty(flyout,'scrollHeight',{value:2000});
 stop=installCanvasComposerViewport();expect(p.rect().top).toBeCloseTo(12);expect(p.rect().bottom).toBeCloseTo(352);expect(p.panel.getAttribute('data-studio-video-composer-scroll')).toBe('true');expect(window.getComputedStyle(p.basic).overflow).toBe('auto');expect(window.getComputedStyle(p.panel).overflow).toBe('visible');expect(flyout.parentElement).toBe(p.panel);
 toolbar.style.display='none';await vi.waitFor(()=>expect(p.rect().bottom).toBeCloseTo(681));expect(Number.parseFloat(p.panel.style.getPropertyValue('--studio-video-composer-max-height'))).toBeCloseTo(669);
});

it('ignores unrelated and invisible node toolbars instead of reserving a global band',()=>{
 const p=composer(.3,303);p.native.left=224;p.native.top=378;owningToolbar(p).style.visibility='hidden';acceptanceBottomControls();
 const other=document.createElement('div');other.className='react-flow__node';other.setAttribute('data-id','another-video');other.innerHTML='<div class="rh-canvas-video-toolbar"></div>';document.body.append(other);vi.spyOn(other.firstElementChild!,'getBoundingClientRect').mockReturnValue(bounds(201,364,925,40) as DOMRect);
 stop=installCanvasComposerViewport();expect(p.rect().top).toBeCloseTo(378);expect(p.rect().bottom).toBeCloseTo(681);expect(p.panel.hasAttribute('data-studio-video-composer-scroll')).toBe(false);
});

it('converts toolbar-free screen height correctly after inverse canvas scaling reaches its cap',()=>{
 const p=composer(.05,2000);p.native.left=224;p.native.top=378;owningToolbar(p);acceptanceBottomControls();stop=installCanvasComposerViewport();
 expect(p.rect().top).toBeCloseTo(12);expect(p.rect().bottom).toBeCloseTo(352);expect(Number.parseFloat(p.panel.style.getPropertyValue('--studio-video-composer-max-height'))).toBeCloseTo(850);expect(p.panel.getAttribute('data-studio-video-composer-scroll')).toBe('true');expect(p.viewport.style.transform).toBe('translate(100px, 20px) scale(0.05)');
});

it('reserves the measured fixed logo before selecting space around the owning toolbar',()=>{
 const area=videoComposerUsableBounds(1500,745,{top:bounds(0,0,389,64),bottom:bounds(16,693,379,52)});
 expect(area).toEqual(bounds(12,76,1476,605));
 expect(videoComposerToolbarBounds(bounds(224,76,880,332.38),area,bounds(201,364.98,925,40))).toEqual(bounds(12,76,1476,276.98));
});

function visibleCanvasLogo(){
 const logo=document.createElement('div');logo.className='canvas-editor-logo';logo.textContent='Studio TV · 验收作品';document.body.append(logo);vi.spyOn(logo,'getBoundingClientRect').mockReturnValue(bounds(0,0,389,64) as DOMRect);return logo;
}

it('keeps the measured 37 hint and composer below the fixed logo and above its own toolbar',async()=>{
 const p=composer(.3,332.38);p.native.left=224;p.native.top=20.598;const toolbar=owningToolbar(p,bounds(201,364.98,925,40)),logo=visibleCanvasLogo();acceptanceBottomControls();const hint=document.createElement('div');hint.className='studio-motion-source-hint';hint.textContent='人物图 + 动作视频，无需提示词';p.basic.prepend(hint);const flyout=document.createElement('div');flyout.className='mg-cascade-overlay';p.panel.append(flyout);
 stop=installCanvasComposerViewport();expect(p.rect().top).toBeCloseTo(76);expect(p.rect().top).toBeGreaterThan(logo.getBoundingClientRect().bottom);expect(p.rect().bottom).toBeCloseTo(352.98);expect(p.rect().bottom).toBeLessThan(toolbar.getBoundingClientRect().top);expect(p.panel.getAttribute('data-studio-video-composer-scroll')).toBe('true');expect(Number.parseFloat(p.panel.style.getPropertyValue('--studio-video-composer-max-height'))).toBeCloseTo(276.98);expect(window.getComputedStyle(p.basic).overflow).toBe('auto');expect(window.getComputedStyle(p.panel).overflow).toBe('visible');expect(hint.textContent).toBe('人物图 + 动作视频，无需提示词');expect(flyout.parentElement).toBe(p.panel);expect(p.panel.style.transform).toBe('translateX(-50%) scale(var(--rh-node-ui-inverse-scale))');
 logo.style.display='none';await vi.waitFor(()=>expect(p.rect().top).toBeCloseTo(20.598));expect(p.panel.hasAttribute('data-studio-video-composer-scroll')).toBe(false);expect(Number.parseFloat(p.panel.style.getPropertyValue('--studio-video-composer-max-height'))).toBeCloseTo(669);
});

it('retains the fixed-logo boundary at capped inverse zoom',()=>{
 const p=composer(.05,2000);p.native.left=224;p.native.top=20.598;owningToolbar(p,bounds(201,364.98,925,40));visibleCanvasLogo();acceptanceBottomControls();stop=installCanvasComposerViewport();
 expect(p.rect().top).toBeCloseTo(76);expect(p.rect().bottom).toBeCloseTo(352.98);expect(Number.parseFloat(p.panel.style.getPropertyValue('--studio-video-composer-max-height'))).toBeCloseTo(692.45);expect(p.panel.getAttribute('data-studio-video-composer-scroll')).toBe('true');
});

it('keeps expanded H3 result actions stationary across repeated clamp measurements and pointer entry or exit',async()=>{
 const callbacks:ResizeObserverCallback[]=[],OriginalResizeObserver=globalThis.ResizeObserver;
 globalThis.ResizeObserver=class {constructor(callback:ResizeObserverCallback){callbacks.push(callback);}observe(){}unobserve(){}disconnect(){}} as any;
 const p=composer(.3,551);p.native.top=405;p.native.left=224;owningToolbar(p,bounds(201,364.98,925,40));visibleCanvasLogo();acceptanceBottomControls();p.basic.dataset.studioLongformHost='';p.basic.classList.add('studio-longform-host-open');p.basic.innerHTML='<details class="studio-h3-longform" data-studio-h3-longform open><summary>H3 分段长片</summary><div class="studio-longform-content"><p>三个已完成分段与多个候选</p><button>保存设置</button><button>导出合片原规格</button></div></details>';const css=document.createElement('style');css.textContent=h3LongformStyles;document.head.append(css);const detail=p.basic.querySelector<HTMLElement>('details')!,summary=detail.querySelector('summary')!,content=detail.querySelector<HTMLElement>('.studio-longform-content')!,button=content.querySelector<HTMLButtonElement>('button')!,clicked=vi.fn();button.addEventListener('click',clicked);
 // Model the real nested scroller: its scrollHeight stays intrinsic, while
 // the parent sees only the H3 box reduced by the last written height limit.
 const renderedHeight=()=>Math.min(551,Math.max(55,(parseFloat(p.panel.style.getPropertyValue('--studio-video-composer-max-height'))||745)-1));Object.defineProperty(content,'scrollHeight',{configurable:true,get:()=>2400});Object.defineProperty(p.basic,'scrollHeight',{configurable:true,get:renderedHeight});vi.spyOn(summary,'getBoundingClientRect').mockImplementation(()=>bounds(224,0,880,34) as DOMRect);vi.spyOn(p.basic,'getBoundingClientRect').mockImplementation(()=>bounds(224,405,880,renderedHeight()) as DOMRect);vi.spyOn(p.panel,'getBoundingClientRect').mockImplementation(()=>{const [x,y]=p.panel.style.translate.split(' ').map(parseFloat);return bounds(224+(x||0)*.3,405+(y||0)*.3,880,renderedHeight()) as DOMRect;});vi.spyOn(button,'getBoundingClientRect').mockImplementation(()=>{const rect=p.panel.getBoundingClientRect();return bounds(rect.left+24,rect.bottom-42,90,32) as DOMRect;});const writes=vi.spyOn(p.panel.style,'setProperty'),frame=()=>new Promise<void>(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(()=>resolve())));
 try{stop=installCanvasComposerViewport();const target=button.getBoundingClientRect(),point={x:target.left+target.width/2,y:target.top+target.height/2};for(let round=0;round<4;round++){content.scrollTop=content.scrollHeight;callbacks[0]([],{} as ResizeObserver);await frame();p.panel.dispatchEvent(new MouseEvent(round%2?'pointerleave':'pointerenter',{bubbles:true,clientX:point.x,clientY:point.y}));p.panel.classList.toggle('pointer-inside',round%2===0);callbacks[0]([],{} as ResizeObserver);await frame();const current=button.getBoundingClientRect(),panel=p.rect();expect(current.top+current.height/2).toBeCloseTo(point.y);expect(point.y).toBeGreaterThanOrEqual(panel.top);expect(point.y).toBeLessThanOrEqual(panel.bottom);expect(Number.parseFloat(p.panel.style.getPropertyValue('--studio-video-composer-max-height'))).toBeCloseTo(276.98);}expect(new Set(writes.mock.calls.filter(([name])=>name==='--studio-video-composer-max-height').map(([,value])=>value)).size).toBe(1);button.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:point.x,clientY:point.y}));expect(clicked).toHaveBeenCalledOnce();}
 finally{stop?.();stop=undefined;css.remove();globalThis.ResizeObserver=OriginalResizeObserver;}
});

it('fits the image result composer at the reported bottom-right position without moving the selected picture or camera',async()=>{
 const zoom=.777278,inverse=1/zoom,p=composer(zoom,240);
 Object.defineProperty(window,'innerWidth',{configurable:true,value:1512});Object.defineProperty(window,'innerHeight',{configurable:true,value:757});
 const owner=p.panel.closest<HTMLElement>('.react-flow__node')!;
 owner.className='react-flow__node react-flow__node-rh-image selected';owner.dataset.id='portrait-result';
 p.panel.parentElement!.className='rh-image-node-local-ui nodrag nopan nowheel';
 p.panel.classList.replace('rh-canvas-video-params','rh-canvas-image-params');p.panel.dataset.testid='canvas-image-params';p.panel.dataset.targetNodeId=owner.dataset.id;
 const picture=bounds(1063,475,280,158),tools=bounds(968,407,470,39);
 const toolbar=document.createElement('div');toolbar.className='rh-canvas-image-toolbar';owner.append(toolbar);
 vi.spyOn(owner,'getBoundingClientRect').mockImplementation(()=>picture as DOMRect);
 vi.spyOn(toolbar,'getBoundingClientRect').mockReturnValue(tools as DOMRect);
 vi.spyOn(p.basic,'getBoundingClientRect').mockReturnValue(bounds(763,645,880,240) as DOMRect);
 vi.spyOn(p.panel,'getBoundingClientRect').mockImplementation(()=>{
  const [tx,ty]=p.panel.style.translate.split(' ').map(parseFloat);
  return bounds(763+(tx||0)*zoom,645+(ty||0)*zoom,880,240) as DOMRect;
 });
 const run=p.panel.querySelector<HTMLButtonElement>('.generate-action-button')!,submit=vi.fn();
 run.addEventListener('click',submit);
 const camera=p.viewport.style.transform,native=p.panel.style.transform;
 stop=installCanvasComposerViewport();
 const panel=p.panel.getBoundingClientRect(),button={x:1526+panel.left-763,y:843+panel.top-645};
 expect(p.panel.hasAttribute('data-studio-image-composer-viewport')).toBe(true);
 expect(button.x).toBeGreaterThanOrEqual(0);expect(button.x+100).toBeLessThan(1512);expect(button.y+30).toBeLessThan(757);
 expect(panel.bottom<=tools.top-12||panel.right<=tools.left-12||panel.left>=tools.right+12).toBe(true);
 expect(p.viewport.style.transform).toBe(camera);expect(p.panel.style.transform).toBe(native);expect(owner.style.translate).toBe('');
 expect(Number.parseFloat(p.shell.style.getPropertyValue('--rh-node-ui-inverse-scale'))).toBeCloseTo(inverse);
 run.click();expect(submit).toHaveBeenCalledOnce();
});

it('leaves a draggable portion of a large picture on a phone when no full side fits and pins controls above the canvas footer',()=>{
 const usable=bounds(12,42,366,548),picture=bounds(-8,45,408,520),panel=bounds(12,382,366,208);
 const dock=imageComposerBounds(panel,usable,picture);
 expect(dock.bottom).toBe(590);expect(dock.width).toBe(366);
 expect(dock.height).toBeGreaterThan(100);expect(dock.top).toBeGreaterThan(picture.top+picture.height/2);
 expect(imageComposerBounds(bounds(20,430,300,140),usable,bounds(60,100,200,200))).toBe(usable);
});

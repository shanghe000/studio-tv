// @vitest-environment happy-dom
import {readFileSync} from 'node:fs';
import {URL as FileURL} from 'node:url';
import {afterEach,expect,it,vi} from 'vitest';
import catalog from './fixtures/canvas-catalog-audit-20261104.json';
import {canvasToolUnavailable,installCanvasToolAvailability} from '../../apps/web/src/service/canvas-tool-availability';
import {nodeToolReason,toolbarContracts} from '../../apps/web/src/service/node-tool-contract';
const entry=readFileSync(new FileURL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const cap=(kind:string)=>structuredClone(catalog.find(c=>c.kind===kind&&c.model)!);
const mount=(html:string)=>{document.body.innerHTML=html;return document.querySelector('button')!;};
afterEach(()=>{document.body.innerHTML='';});
it('covers every selectable action registered in both frozen configurable toolbars',()=>{
 const source=entry.match(/eir=\{(.*?)\},tir=\{(.*?)\};function _ye/)!.slice(1,3);
 for(const [i,variant]of (['image','video']as const).entries()){
  const actions=[...source[i].matchAll(/\{id:"([^"]+)"/g)].map(match=>match[1]);expect(actions.sort()).toEqual(Object.keys(toolbarContracts[variant]).sort());
  const blocked=variant==='image'?['editElement']:['clipReshoot','quality','depthCapture','analyze','repair'];
  for(const id of actions){
   const b=mount('<div class="rh-media-toolbar-more-portal '+variant+'-toolbar"><button role="menuitem">ローカライズ名</button></div>');
   Object.assign(b,{'__reactFiber$tool':{key:id}});
   expect(Boolean(canvasToolUnavailable(b,()=>[],catalog)),variant+':'+id).toBe(blocked.includes(id));
  }
 }
});
it('honors actual native selected-text callbacks even for portals without node props, and responds to account catalog changes',()=>{
 const b=mount('<div class="rh-text-selection-menu"><button class="rh-text-selection-item">🎬文字生视频创建视频生成节点</button></div>'),onVideo=vi.fn(),onImage=vi.fn(),native=vi.fn(),notice=vi.fn(),menu={selectedText:'选段',onImage,onVideo};
 const props=()=>[{className:'rh-text-selection-item',onClick:onVideo},menu];b.addEventListener('click',native);
 let rows=structuredClone(catalog),notify!:()=>void;
 const stop=installCanvasToolAvailability(notice,props,document,{read:()=>rows,subscribe:cb=>(notify=cb,()=>{})});
 try{
  expect(b.getAttribute('aria-disabled')).toBe('true');b.click();expect(native).not.toHaveBeenCalled();
  rows=rows.map(row=>row.kind==='TEXT_TO_VIDEO'&&row.model?{...row,available:true}:row);notify();b.click();expect(native).toHaveBeenCalledOnce();expect(b.hasAttribute('aria-disabled')).toBe(false);
  expect(canvasToolUnavailable(b,()=>[{className:'rh-text-selection-item',onClick:onImage},menu],catalog)).toBeNull();
 }finally{stop();}
});
it('does not treat generic image editing, placeholder rows or an unrelated video capability as a specialized tool',()=>{
 const edit=cap('IMAGE_TO_IMAGE');
 expect(nodeToolReason('region',[{...edit,capabilityRef:'other'}])).toBeTruthy();
 expect(nodeToolReason('region',[{...edit,capabilityRef:'codex-image-edit-v1',version:'2'}])).toBeTruthy();
 expect(nodeToolReason('text-video',catalog.filter(c=>c.available))).toBeTruthy();
 expect(nodeToolReason('edit',[])).toBeTruthy();expect(nodeToolReason('local',[])).toBeNull();
});
it.each(['rh-ai','rh-video-remake','audio-to-text','audio-lip-sync','audio-to-video'])('blocks unsupported selector action %s before graph mutation, without a targetNode prop',id=>{
 const b=mount('<button class="rh-add-node-panel__item" data-panel-key="'+id+'">显示名和说明</button>'),open=vi.fn();b.addEventListener('click',open);
 const stop=installCanvasToolAvailability(()=>{},()=>[]);try{b.click();expect(open).not.toHaveBeenCalled();expect(b.title).toContain('暂不可用');}finally{stop();}
});
it('validates speed presets, slider and derived target duration before starting a local video job',()=>{
 const b=mount('<div class="rh-video-speed-panel"><input class="rh-video-speed-panel__slider" type="range" min=".1" max="10" step=".01" value="2"><input class="rh-video-speed-panel__duration-input" value="00:05.00"><button class="rh-video-speed-panel__btn is-submit"></button></div>');
 const props=()=>[{durationSec:10,onSubmit:vi.fn()}];expect(canvasToolUnavailable(b,props)).toBeNull();
 const slider=document.querySelector<HTMLInputElement>('input[type=range]')!,duration=document.querySelector<HTMLInputElement>('.rh-video-speed-panel__duration-input')!;
 for(const [rate,target,ok]of [['5','00:02.00',false],['2','2',false],['2','2.5',true],['2','40',true],['2','50',false],['.1','01:40.00',false],['4','00:02.50',true],['2','bad',false]]as const){
  slider.value=rate;duration.value=target;expect(canvasToolUnavailable(b,props)===null,rate+'/'+target).toBe(ok);
 }
 b.className='rh-video-speed-panel__preset';b.textContent='10x';expect(canvasToolUnavailable(b,()=>[])).toContain('0.25');
});
it('grays upscale on large current source assets without blocking a different selected history image or local operations',()=>{
 const b=mount('<div class="rh-canvas-image-toolbar"><div class="rh-image-toolbar-popup--quality"><button role="menuitem"></button></div></div>');
 Object.assign(b,{'__reactFiber$tool':{key:'image-hd'}});
 const node={type:'rh-image',data:{output:[{url:'big',historyOutputId:'a'},{url:'small',historyOutputId:'b'}],selectedHistoryOutputId:'a'}};
 const asset=(ref:string)=>({id:ref,kind:'IMAGE',state:'READY',width:ref==='big'?1025:1024,height:512,byteSize:4096} as any);
 expect(canvasToolUnavailable(b,()=>[{node}],catalog,asset)).toContain('1025');node.data.selectedHistoryOutputId='b';expect(canvasToolUnavailable(b,()=>[{node}],catalog,asset)).toBeNull();
});
it('intercepts legacy remake submission and world generation retry, retaining upload retry and read-only results',()=>{
 for(const [html,props,blocked] of [
  ['<button class="world-3d-retry-btn">retry</button>',[{id:'world',data:{status:'failed'},onNodeDataPatch:vi.fn()}],true],
  ['<button class="world-3d-retry-btn">retry</button>',[{id:'world',data:{status:'upload_error'},onNodeDataPatch:vi.fn()}],false],
  ['<button class="video-analysis-result__action is-primary"></button>',[],true],
  ['<button class="video-analysis-fullscreen-button"></button>',[],false],
  ['<div class="rh-video-remake-wb__shell"><div class="xyq-launch__confirm"><button class="storyboard-fullscreen-step-bar__action"></button></div></div>',[],true],
  ['<div class="rh-video-remake-wb__modal"><button class="rh-video-remake-wb__primary"></button></div>',[],true],
  ['<div class="storyboard-fullscreen-step-bar"><button class="storyboard-fullscreen-step-bar__action"></button></div>',[],false],
 ]as const){
  const b=mount(html),post=vi.fn();b.addEventListener('click',post);
  const stop=installCanvasToolAvailability(()=>{},()=>[...props]);try{b.click();expect(post.mock.calls.length).toBe(blocked?0:1);expect(b.getAttribute('aria-disabled')==='true').toBe(blocked);}finally{stop();}
 }
});

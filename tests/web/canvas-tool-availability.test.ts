// @vitest-environment happy-dom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {canvasToolUnavailable,installCanvasToolAvailability} from '../../apps/web/src/service/canvas-tool-availability';
import motionCatalog from './fixtures/router-motion-capabilities.json';
import {capabilityModel} from '../../apps/web/src/service/execution';
let stop:(()=>void)|undefined;
afterEach(()=>{stop?.();stop=undefined;document.body.innerHTML='';});
const button=(text:string)=>{const b=document.createElement('button');b.textContent=text;document.body.append(b);return b;};
const context=(type:string,data:any={})=>[{targetNode:{type,data}}];
describe('confirmed unavailable canvas tools',()=>{
 it('leaves mode navigation reachable even when the initial text model is unavailable',()=>{
  const chooser=button('文生视频');chooser.className='video-input-mode-btn video-input-mode-btn--active';chooser.setAttribute('data-video-mode','text-video');
  expect(canvasToolUnavailable(chooser,()=>context('rh-video'))).toBeNull();
  expect(canvasToolUnavailable(button('文生视频'),()=>context('rh-video'))).toContain('图片参考');
 });
 it('enables motion transfer only for actual available real motion catalog entries',()=>{
  for(const raw of motionCatalog){
   const props=(available:boolean,testMode=false)=>[...context('rh-video'),{toolbarContext:{models:{'video-motion-transfer':[capabilityModel({...raw,available,testMode} as any)]}}}];
   expect(canvasToolUnavailable(button('动作模仿'),()=>props(true))).toBeNull();
   expect(canvasToolUnavailable(button('Motion Transfer'),()=>props(true))).toBeNull();
   expect(canvasToolUnavailable(button('动作模仿'),()=>props(false))).toContain('尚未接入');
   expect(canvasToolUnavailable(button('动作模仿'),()=>props(true,true))).toContain('尚未接入');
   for(const label of ['视频编辑','视频延长','文生视频'])expect(canvasToolUnavailable(button(label),()=>props(true))).toBeTruthy();
  }
 });
 it('does not disable working controls with the same label or mixed menu parents',()=>{
  for(const label of ['解析','画质','增强','重绘','抠图','旋转'])expect(canvasToolUnavailable(button(label),()=>context('rh-image'))).toBeNull();
  for(const label of ['音频分离','捕捉帧','剪辑','裁剪','旋转','2x','首帧','首尾帧','全能参考'])expect(canvasToolUnavailable(button(label),()=>context('rh-video'))).toBeNull();
  for(const label of ['解析','画质','视频重拍','人声分离','环境音分离','视频修复','5x'])expect(canvasToolUnavailable(button(label),()=>context('rh-video'))).toBeTruthy();
  const quality=document.createElement('div');quality.className='rh-image-toolbar-popup--quality';document.body.append(quality);
  for(const label of ['放大','高清']){const b=button(label);quality.append(b);expect(canvasToolUnavailable(b,()=>context('rh-image'))).toBeTruthy();}
  expect(canvasToolUnavailable(button('编辑元素'),()=>context('rh-image'))).toBeTruthy();
  expect(canvasToolUnavailable(button('高清'),()=>context('rh-image'))).toBeNull();
  expect(canvasToolUnavailable(button('解析'),()=>[])).toBeNull();
  expect(canvasToolUnavailable(button('生成'),()=>context('rh-text'))).toBeNull();
 });
 it('keeps available layer models enabled, but not test/placeholder rows',()=>{
  const b=button('编辑元素');
  for(const testMode of [true,false])expect(Boolean(canvasToolUnavailable(b,()=>[...context('rh-image'),{toolbarContext:{models:{'image-layer-decomposition':[{available:true,testMode}]}}}]))).toBe(testMode);
 });
 it('unlocks real image enhancement without advertising unrelated video repair tools',()=>{
  const quality=document.createElement('div');quality.className='rh-image-toolbar-popup--quality';document.body.append(quality);
  const b=button('放大');quality.append(b);
  const props=(testMode:boolean)=>[...context('rh-image'),{toolbarContext:{models:{'image-gigapixel':[{kind:'IMAGE_ENHANCE',available:true,testMode}]}}}];
  expect(canvasToolUnavailable(b,()=>props(false))).toBeNull();expect(canvasToolUnavailable(b,()=>props(true))).toBeTruthy();
  expect(canvasToolUnavailable(button('降噪'),()=>[...context('rh-video'),...props(false)])).toBeTruthy();
 });
 it('blocks mouse and keyboard commands before node creation, preserving native disabled',()=>{
  const b=button('解析'),native=vi.fn(),notice=vi.fn();b.addEventListener('click',native);
  stop=installCanvasToolAvailability(notice,()=>context('rh-video'));
  expect(b.disabled).toBe(false);expect(b.getAttribute('aria-disabled')).toBe('true');expect(b.title).toContain('暂不可用');
  b.click();expect(native).not.toHaveBeenCalled();expect(notice).toHaveBeenCalledOnce();
  const enter=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});b.dispatchEvent(enter);expect(enter.defaultPrevented).toBe(true);
  const tab=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});b.dispatchEvent(tab);expect(tab.defaultPrevented).toBe(false);
 });
 it('restores owned attributes on context switch and guards using fresh context',async()=>{
  let type='rh-video';const b=button('解析'),native=vi.fn();b.title='原说明';b.addEventListener('click',native);
  stop=installCanvasToolAvailability(()=>{},()=>context(type));
  type='rh-image';b.className='changed';await new Promise(resolve=>setTimeout(resolve,0));
  expect(b.hasAttribute('data-studiotv-unavailable')).toBe(false);expect(b.title).toBe('原说明');expect(b.hasAttribute('aria-disabled')).toBe(false);
  b.click();expect(native).toHaveBeenCalledOnce();
  type='rh-video';b.click();expect(native).toHaveBeenCalledOnce();
 });
 it('marks newly rendered items and does not overwrite native changes during cleanup',async()=>{
  stop=installCanvasToolAvailability(()=>{},()=>context('rh-video'));
  const b=button('解析');b.disabled=true;await new Promise(resolve=>setTimeout(resolve,0));expect(b.getAttribute('aria-disabled')).toBe('true');
  b.title='新说明';stop();stop=undefined;
  expect(b.title).toBe('新说明');expect(b.disabled).toBe(true);expect(b.hasAttribute('data-studiotv-unavailable')).toBe(false);
 });
 it('does not suppress H3 generation, explicit new capabilities or image-to-audio references',()=>{
  for(const subType of ['start-video','start-end-video','multimodal-video'])expect(canvasToolUnavailable(button('开始生成'),()=>context('rh-video',{subType}))).toBeNull();
  expect(canvasToolUnavailable(button('开始生成'),()=>context('rh-video',{subType:'text-video',capabilityRef:'new-real-model'}))).toBeNull();
  expect(canvasToolUnavailable(button('生成'),()=>context('rh-video',{subType:'text-video'}))).toContain('纯文');
  expect(canvasToolUnavailable(button('生成'),()=>[...context('rh-video',{subType:'text-video'}),{currentModel:{available:true,testMode:false}}])).toBeNull();
  expect(canvasToolUnavailable(button('上传音频'),()=>context('rh-audio'))).toBeNull();
 });
});

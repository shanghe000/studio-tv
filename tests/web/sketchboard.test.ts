// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {SketchProgress,installSketchboardUi} from '../../apps/web/src/service/sketchboard';
afterEach(()=>{document.body.innerHTML='';vi.useRealTimers();});
it('shows actual pending work before the first result and isolates stale responses',async()=>{
 document.body.innerHTML='<div class="sketch-studio"><div class="sketch-studio__preview-empty-meta"><span class="sketch-studio__preview-empty-time">4–6s</span></div><div class="sketch-studio__generation-status">等待绘制</div><div class="sketch-studio__generation-mode is-live"><button class="sketch-studio__generation-mode-option is-active" aria-checked="true"></button></div></div>';
 const progress=new SketchProgress(),release=installSketchboardUi(progress,()=>'p');
 try{
  expect(document.querySelector('.studio-sketch-hint')?.textContent).toContain('数分钟');
  const first=progress.start('p','live');expect(document.querySelector('.studio-sketch-status')?.textContent).toContain('上传草图');
  const latest=progress.start('p','live');progress.update(first,{phase:'done'});expect(progress.value?.token).toBe(latest);
  progress.update(latest,{phase:'running'});expect(document.querySelector('.studio-sketch-status')?.textContent).toContain('生成中');
  progress.update(latest,{phase:'done'});expect(document.querySelector('.studio-sketch-status')).toBeNull();expect(document.querySelector('.sketch-studio__generation-status')?.textContent).toBe('等待绘制');
  progress.start('other','live');expect(document.querySelector('.studio-sketch-status')).toBeNull();
  document.body.innerHTML='';await new Promise(resolve=>setTimeout(resolve,0));expect(progress.value).toBeNull();
 }finally{release();}
});

it('keeps pending status visible on the nested sketchboard route without a canvas manager',()=>{
 window.history.replaceState({},'', '/project/canvas/prj-test/sketchboard');
 document.body.innerHTML='<div class="sketch-studio"><div class="sketch-studio__generation-status">等待绘制</div><div class="sketch-studio__generation-mode is-live"><button class="sketch-studio__generation-mode-option is-active" aria-checked="true"></button></div></div>';
 const progress=new SketchProgress(),release=installSketchboardUi(progress,()=>undefined);
 try{progress.start('prj-test','live');expect(document.querySelector('.studio-sketch-status')?.textContent).toContain('上传草图');expect(document.querySelector('[data-studio-busy="true"]')).not.toBeNull();}finally{release();window.history.replaceState({},'','/');}
});

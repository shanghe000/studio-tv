// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {ApiError} from '../../apps/web/src/api/client';
import {installCanvasToolAvailability} from '../../apps/web/src/service/canvas-tool-availability';
import {selectedCanvasAssets} from '../../apps/web/src/service/selected-canvas-asset';
import catalog from './fixtures/canvas-catalog-audit-20261104.json';

afterEach(()=>{vi.useRealTimers();document.body.replaceChildren();});

it('blocks a cold image tool until its chosen result is checked, then updates the actual button and ignores the other history',async()=>{
 document.body.innerHTML='<div class="rh-canvas-image-toolbar"><div class="rh-image-toolbar-popup--quality"><button role="menuitem"></button></div></div>';
 const button=document.querySelector('button')!;Object.assign(button,{'__reactFiber$tool':{key:'image-hd'}});
 const outputs=['big','small','private-history'].map(id=>({historyOutputId:id,url:'projected/'+id}));
 const node={type:'rh-image',data:{output:outputs,selectedHistoryOutputId:'big'}};
 const load=vi.fn((id:string)=>Promise.resolve({id,kind:'IMAGE',state:'READY',width:id==='big'?1025:512,height:512,byteSize:4096} as any));
 const native=vi.fn();button.addEventListener('click',native);
 const stop=installCanvasToolAvailability(()=>{},()=>[{node}],document,{read:()=>catalog as any,subscribe:()=>()=>{},selectedAsset:{
  scope:()=>'me/p',idOf:ref=>ref.split('/')[1],cached:()=>undefined,resolve:load,
 }});
 try{
  expect(button.getAttribute('aria-disabled')).toBe('true');button.click();expect(native).not.toHaveBeenCalled();
  await vi.waitFor(()=>expect(button.title).toContain('1025'));
  node.data.selectedHistoryOutputId='small';button.click();expect(native).not.toHaveBeenCalled();
  await vi.waitFor(()=>expect(button.hasAttribute('aria-disabled')).toBe(false));
  button.click();expect(native).toHaveBeenCalledOnce();
  expect(load.mock.calls.map(c=>c[0])).toEqual(['big','small']);
 }finally{stop();}
});

it('fences old identities and removed selection, retries a transient error a bounded number of times, and keeps permanent denials local',async()=>{
 vi.useFakeTimers();let scope='A',fail!:()=>void;
 const changed=vi.fn(),load=vi.fn((id:string):Promise<any>=>{
  if(id==='slow')return new Promise((_,reject)=>{fail=()=>reject(new TypeError('offline'));});
  return Promise.reject(id==='missing'?new ApiError(404,'ASSET_NOT_FOUND','missing'):new TypeError('network'));
 });
 const probe=selectedCanvasAssets({scope:()=>scope,idOf:x=>x,cached:()=>undefined,resolve:load},changed);
 probe.read('slow');scope='B';fail();await Promise.resolve();expect(changed).not.toHaveBeenCalled();
 probe.begin();probe.read('missing');probe.read('current');probe.end();await vi.advanceTimersByTimeAsync(2000);
 expect(load.mock.calls.map(c=>c[0])).toEqual(['slow','missing','current','current','current']);
 expect(probe.read('missing')).toContain('重新选择');expect(probe.read('current')).toContain('重试');
 probe.begin();probe.end();probe.read('current');await Promise.resolve();probe.begin();probe.end();
 await vi.advanceTimersByTimeAsync(5000);expect(load).toHaveBeenCalledTimes(6);probe.reset();
});

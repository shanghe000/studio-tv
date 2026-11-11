// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {ApiError} from '../../apps/web/src/api/client';
import {installProviderCredentialSettings,credentialsChangedEvent,openCredentialSettingsEvent} from '../../apps/web/src/service/model-provider-credentials';

const disposers:Array<()=>void>=[];
afterEach(()=>{for(const dispose of disposers.splice(0))dispose();document.body.replaceChildren();vi.restoreAllMocks();});
function setup(configurable=true){
 document.body.innerHTML='<div class="canvas-header-account-area"><div role="button" class="userInfoBox" tabindex="0">个人账号</div></div><div class="ant-drawer ant-drawer-open canvas-user-profile-drawer"><div class="userInfo-content--new-home"><div class="nh-controls"><button>原有用户设置</button></div></div></div>';
 const callbacks=new Set<()=>void>(),auth={user:{id:'fixture-actor'} as {id:string}|null,onClear:(listener:()=>void)=>{callbacks.add(listener);return()=>callbacks.delete(listener);},clear(){auth.user=null;for(const listener of callbacks)listener();}};
 const items=['minimax-official','volcengine-official'].map(providerRef=>({providerRef,configured:false,maskedKey:'',updatedAt:null as string|null,configurable,...(providerRef==='minimax-official'?{region:'global'}:{})}));
 const requestV2=vi.fn(async(path:string,options:any={})=>{if(options.method==='PUT')return{data:{...items.find(item=>path.endsWith(item.providerRef)),configured:true,maskedKey:'********test',updatedAt:'2026-11-01T00:00:00Z',...(options.body.region?{region:options.body.region}:{})}};if(options.method==='DELETE')return{data:items.find(item=>path.endsWith(item.providerRef))};return{data:{items,schemaVersion:'1'}};});
 const account=document.querySelector<HTMLElement>('.userInfoBox')!,originalClick=vi.fn();account.onclick=originalClick;
 disposers.push(installProviderCredentialSettings({auth,api:{requestV2}}));
 const details=document.querySelector<HTMLDetailsElement>('[data-studio-provider-settings]')!;details.open=true;details.dispatchEvent(new Event('toggle'));
 return{auth,items,requestV2,account,originalClick,details};
}
const field=(label:string)=>document.querySelector<HTMLInputElement>('[aria-label="'+label+'"]')!;
const button=(row:Element,label:string)=>[...row.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent===label)!;
async function ready(){await vi.waitFor(()=>expect(field('MiniMax API Key').disabled).toBe(false));}

it('writes a key once per provider, clears it after save and preserves the native account controls',async()=>{
 const f=setup();await ready();const input=field('MiniMax API Key'),row=input.closest('section')!,changed=vi.fn();window.addEventListener(credentialsChangedEvent,changed);disposers.push(()=>window.removeEventListener(credentialsChangedEvent,changed));
 input.value='fixture-write-only-secret';input.dispatchEvent(new Event('input'));field('MiniMax Key 所属地区').value='cn';
 expect(document.body.innerHTML).not.toContain('fixture-write-only-secret');button(row,'保存 Key').click();button(row,'保存 Key').click();
 await vi.waitFor(()=>expect(input.value).toBe(''));
 expect(f.requestV2.mock.calls.filter(([,options])=>options.method==='PUT')).toEqual([['/me/model-provider-credentials/minimax-official',{method:'PUT',body:{apiKey:'fixture-write-only-secret',region:'cn'},cache:'no-store'}]]);
 expect(row.textContent).toContain('已保存 · ********test');expect(row.textContent).not.toContain('验证通过');expect(changed).toHaveBeenCalledOnce();
 f.account.click();expect(f.originalClick).toHaveBeenCalledOnce();expect(document.querySelector('.nh-controls button')?.textContent).toBe('原有用户设置');
 const seedance=field('Seedance · 火山引擎 API Key');seedance.value='fixture-seed-key';seedance.dispatchEvent(new Event('input'));button(seedance.closest('section')!,'保存 Key').click();await vi.waitFor(()=>expect(seedance.value).toBe(''));
 expect(f.requestV2.mock.calls.at(-1)?.[1].body).toEqual({apiKey:'fixture-seed-key'});
});

it('requires a second remove action and warns about unfinished API tasks',async()=>{
 const f=setup();f.items[0].configured=true;f.items[0].maskedKey='********old';await ready();const row=field('MiniMax API Key').closest('section')!;
 button(row,'移除').click();expect(row.textContent).toContain('未完成的 API 任务可能无法继续查询');expect(f.requestV2.mock.calls.some(([,options])=>options.method==='DELETE')).toBe(false);
 button(row,'取消').click();expect(button(row,'移除')).toBeTruthy();button(row,'移除').click();button(row,'确认移除').click();await vi.waitFor(()=>expect(f.requestV2.mock.calls.some(([,options])=>options.method==='DELETE')).toBe(true));
});

it('never echoes raw provider errors and clears sensitive fields when the drawer closes or auth changes',async()=>{
 const f=setup();await ready();const input=field('MiniMax API Key'),row=input.closest('section')!;f.requestV2.mockRejectedValueOnce(new ApiError(500,'UNKNOWN','echo-fixture-secret'));
 input.value='fixture-input-secret';input.dispatchEvent(new Event('input'));button(row,'保存 Key').click();await vi.waitFor(()=>expect(row.textContent).toContain('暂时无法保存 API Key'));
 expect(document.body.textContent).not.toContain('echo-fixture-secret');document.querySelector('.ant-drawer')!.classList.remove('ant-drawer-open');await vi.waitFor(()=>expect(input.value).toBe(''));
 input.value='second-private-value';f.auth.clear();expect(input.value).toBe('');expect(document.querySelector('[data-studio-provider-settings]')).toBeNull();
});

it('keeps unavailable configuration explicit and gives no-key model menus a usable settings entry',async()=>{
 const f=setup(false);await vi.waitFor(()=>expect(f.details.textContent).toContain('暂未开放'));expect(field('MiniMax API Key').disabled).toBe(true);expect(button(field('MiniMax API Key').closest('section')!,'保存 Key').disabled).toBe(true);
 f.details.open=false;window.dispatchEvent(new CustomEvent(openCredentialSettingsEvent,{detail:{providerRef:'minimax-official'}}));expect(f.details.open).toBe(true);
});

it('keeps settings typing and keyup away from canvas shortcuts while preserving input defaults',async()=>{
 const f=setup();await ready();const globalKey=vi.fn(),globalUp=vi.fn();document.addEventListener('keydown',globalKey);document.addEventListener('keyup',globalUp);disposers.push(()=>{document.removeEventListener('keydown',globalKey);document.removeEventListener('keyup',globalUp);});const input=field('MiniMax API Key');
 for(const key of ['n','Tab','ArrowLeft',' ']){const down=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}),up=new KeyboardEvent('keyup',{key,bubbles:true,cancelable:true});input.dispatchEvent(down);input.dispatchEvent(up);expect(down.defaultPrevented).toBe(false);expect(up.defaultPrevented).toBe(false);}
 expect(globalKey).not.toHaveBeenCalled();expect(globalUp).not.toHaveBeenCalled();expect(f.requestV2.mock.calls.every(([,options])=>!options.method)).toBe(true);
});

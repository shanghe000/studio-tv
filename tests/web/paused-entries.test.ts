// @vitest-environment happy-dom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {installPausedEntries,pausedEntryReason,pausedHomeSubmission,pausedAgentSubmission} from '../../apps/web/src/features/paused-entries';
let stop:(()=>void)|undefined;
afterEach(()=>{stop?.();stop=undefined;document.body.innerHTML='';});
const setup=()=>{document.body.innerHTML='<a href="/projects/skill">技能</a><a href="/projects/plugin">插件</a><a href="/projects/canvas">项目</a><button class="canvas-toolbar-btn" data-toolbar-icon="workflow" aria-label="工作流"></button><button class="canvas-toolbar-btn" data-toolbar-icon="sketchboard">画板</button><button class="generate-action-button">生成</button>';return [...document.querySelectorAll('a,button')];};
describe('temporarily paused product entries',()=>{
 it('only pauses exact owned navigation, workflow and skillbook controls',()=>{
  const elements=setup();expect(elements.map(e=>!!pausedEntryReason(e))).toEqual([true,true,false,true,false,false]);
  const userLink=document.createElement('a');userLink.href='https://example.com/projects/skill';expect(pausedEntryReason(userLink)).toBeNull();
  const label=document.createElement('button');label.textContent='工作流';expect(pausedEntryReason(label)).toBeNull();
 });
 it('blocks click, middle click and keyboard while leaving enabled actions intact',()=>{
  const elements=setup(),notice=vi.fn(),handler=vi.fn();elements.forEach(e=>e.addEventListener('click',handler));stop=installPausedEntries(notice);
  for(const index of [0,1,3]){elements[index].dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));expect(elements[index].getAttribute('aria-disabled')).toBe('true');}
  expect(handler).not.toHaveBeenCalled();expect(notice).toHaveBeenCalledTimes(3);
  for(const event of [new MouseEvent('auxclick',{button:1,bubbles:true,cancelable:true}),new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})]){elements[0].dispatchEvent(event);expect(event.defaultPrevented).toBe(true);}
  elements[5].dispatchEvent(new MouseEvent('click',{bubbles:true}));expect(handler).toHaveBeenCalledOnce();
 });
 it('handles lazy-rendered entries and restores attributes on reuse/cleanup',async()=>{
  stop=installPausedEntries(()=>{});const elements=setup();elements[0].title='技能库';await new Promise(r=>setTimeout(r,0));expect(elements[0].title).toBe('技能暂未开放。');
  elements[0].setAttribute('href','/projects/canvas');await new Promise(r=>setTimeout(r,0));expect(elements[0].title).toBe('技能库');expect(elements[0].hasAttribute('aria-disabled')).toBe(false);
  stop();stop=undefined;expect(elements[1].hasAttribute('data-studio-paused-entry')).toBe(false);
 });
});

const fiber=(element:Element,props:any={},key:string|null=null)=>{(element as any).__reactFiber$test={key,memoizedProps:props};};
it('pauses only unavailable mode keys, retaining Agent/images and unrelated buttons',()=>{
 for(const key of ['agent','image','video','motion-transfer']){
  const button=document.createElement('button');button.className='home-mode-dropdown-item';button.textContent='任意语言';fiber(button,{},key);
  expect(!!pausedEntryReason(button)).toBe(['video','motion-transfer'].includes(key));
 }
 const button=document.createElement('button');button.textContent='视频生成';fiber(button,{},'video');expect(pausedEntryReason(button)).toBeNull();
});
it('blocks stale home mode submission by click and Enter without blocking mode recovery or typing',()=>{
 document.body.innerHTML='<div class="home-agent-input-bar"><button class="home-mode-pill">视频生成</button><div contenteditable="true"></div><button class="home-send-btn">开始创作</button></div>';
 const mode=document.querySelector('.home-mode-pill')!,input=document.querySelector('[contenteditable]')!,send=document.querySelector('.home-send-btn')!;
 const props={mode:'video',onModeChange:()=>{}};fiber(mode,props);const action=vi.fn();send.addEventListener('click',action);stop=installPausedEntries(()=>{});
 send.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));expect(action).not.toHaveBeenCalled();expect(send.getAttribute('aria-disabled')).toBe('true');expect(pausedEntryReason(mode)).toBeNull();
 const enter=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});input.dispatchEvent(enter);expect(enter.defaultPrevented).toBe(true);
 for(const options of [{key:' '},{key:'Enter',shiftKey:true},{key:'Enter',isComposing:true}]){const event=new KeyboardEvent('keydown',{...options,bubbles:true,cancelable:true});input.dispatchEvent(event);expect(event.defaultPrevented).toBe(false);}
 props.mode='image';expect(pausedHomeSubmission(input)).toBeNull();send.dispatchEvent(new MouseEvent('click',{bubbles:true}));expect(action).toHaveBeenCalledOnce();expect(send.hasAttribute('aria-disabled')).toBe(false);
});
it('pauses AI app creation/selection/running but retains existing node management and real H3 actions',()=>{
 document.body.innerHTML='<button data-panel-key="rh-ai">AI应用</button><button data-panel-key="rh-video">视频</button><button class="ai-app-params__model-btn">选择</button><div class="canvas-ai-app-params"><button class="run-price-btn">运行</button><button>关闭</button><textarea></textarea></div><div class="react-flow__node-rh-ai"><button class="generate-action-button">生成</button><button>删除</button></div><div class="rh-video-node"><button class="generate-action-button">H3生成</button></div>';
 const buttons=[...document.querySelectorAll('button')];expect(buttons.map(e=>!!pausedEntryReason(e))).toEqual([true,false,true,true,false,true,false,false]);
 stop=installPausedEntries(()=>{});const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});document.querySelector('textarea')!.dispatchEvent(event);expect(event.defaultPrevented).toBe(true);
});

it('pauses independent Agent menus, SkillHub and remakes without disabling image mode',()=>{
 for(const key of ['agent','image','video','motion-transfer']){const b=document.createElement('button');b.className='ap-mode-dropdown-item';fiber(b,{},key);expect(!!pausedEntryReason(b)).toBe(key==='motion-transfer');}
 document.body.innerHTML='<div class="agent-chat-panel"><button aria-label="SkillHub"></button><button class="ap-one-click-remake-trigger"></button><button class="ap-trending-hit-btn"></button><button>关闭面板</button></div><button aria-label="SkillHub">unrelated</button>';
 expect([...document.querySelectorAll('button')].map(e=>!!pausedEntryReason(e))).toEqual([true,true,true,false,false]);
});
it('blocks independent Agent stale mode submits but preserves stop, text, images and IME',()=>{
 document.body.innerHTML='<div class="agent-chat-panel"><div contenteditable="true"></div><button class="ap-send-btn">发送</button></div>';
 const send=document.querySelector('.ap-send-btn')!,input=document.querySelector('[contenteditable]')!,props={chatMode:'motion-transfer',onChatModeChange:()=>{},isLoading:false,isTrendingHitMode:false};fiber(send,props);const submit=vi.fn();send.addEventListener('click',submit);stop=installPausedEntries(()=>{});
 expect(send.getAttribute('aria-disabled')).toBe('true');send.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));expect(submit).not.toHaveBeenCalled();
 const enter=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});input.dispatchEvent(enter);expect(enter.defaultPrevented).toBe(true);
 for(const options of [{key:'Escape'},{key:'Enter',shiftKey:true},{key:'Enter',isComposing:true}]){const e=new KeyboardEvent('keydown',{...options,bubbles:true,cancelable:true});input.dispatchEvent(e);expect(e.defaultPrevented).toBe(false);}
 props.isLoading=true;send.classList.add('stopping');send.dispatchEvent(new MouseEvent('click',{bubbles:true}));expect(submit).toHaveBeenCalledOnce();expect(send.hasAttribute('aria-disabled')).toBe(false);
 props.isLoading=false;send.classList.remove('stopping');for(const mode of ['agent','image']){props.chatMode=mode;expect(pausedAgentSubmission(input)).toBeNull();send.dispatchEvent(new MouseEvent('click',{bubbles:true}));}expect(submit).toHaveBeenCalledTimes(3);
 props.isTrendingHitMode=true;expect(pausedAgentSubmission(input)).toContain('复刻');
});

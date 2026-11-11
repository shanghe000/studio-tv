// @vitest-environment happy-dom
import {afterAll,afterEach,beforeAll,expect,it} from 'vitest';
import {installFeatureUi} from '../../apps/web/src/features/internal-ui';
import {resolveFeatures} from '../../apps/web/src/features/policy';

let dispose:()=>void;
const original={open:window.open,push:history.pushState,replace:history.replaceState};
beforeAll(()=>{dispose=installFeatureUi(resolveFeatures(),()=>{}).disconnect;});
afterEach(()=>document.body.replaceChildren());
afterAll(()=>{dispose();window.open=original.open;history.pushState=original.push;history.replaceState=original.replace;document.getElementById('rhtv-feature-styles')?.remove();});

it('hides only the native header entry while preserving the avatar and adjacent operations',()=>{
 document.body.innerHTML='<header><button class="hyperframes-btn" title="HyperFrames"><svg class="hyperframes-icon"></svg></button><button aria-label="用户头像"><img alt="当前用户"></button><button aria-label="画布设置">设置</button></header>';
 const entry=document.querySelector<HTMLButtonElement>('.hyperframes-btn')!;
 expect(getComputedStyle(entry).display).toBe('none');expect(entry.isConnected).toBe(true);expect(entry.querySelector('.hyperframes-icon')).not.toBeNull();
 for(const control of document.querySelectorAll<HTMLButtonElement>('button:not(.hyperframes-btn)'))expect(getComputedStyle(control).display).not.toBe('none');
});
it('keeps asynchronously mounted and replaced entries hidden after native or brand updates',()=>{
 const nativeStyle=document.createElement('style');nativeStyle.textContent='.hyperframes-btn{display:inline-flex!important}';document.head.append(nativeStyle);
 try{
  const first=document.createElement('button');document.body.append(first);first.className='hyperframes-btn';first.setAttribute('aria-label','Studio Frames');
  expect(getComputedStyle(first).display).toBe('none');
  const replacement=first.cloneNode(true)as HTMLButtonElement;first.replaceWith(replacement);replacement.title='Studio Frames';
  expect(getComputedStyle(replacement).display).toBe('none');
 }finally{nativeStyle.remove();}
});
it('preserves existing editor links, embedded players and content bearing a HyperFrames title',()=>{
 document.body.innerHTML='<a href="/labs/rhhyperframes/">已有编辑器地址</a><a href="/hyperframes-studio/">已有工作室地址</a><iframe src="about:blank" title="Studio Frames"></iframe><hyperframes-player></hyperframes-player><button title="HyperFrames">用户自定义内容</button>';
 for(const control of document.body.children)expect(getComputedStyle(control).display).not.toBe('none');
 expect([...document.querySelectorAll('a')].map(link=>link.getAttribute('href'))).toEqual(['/labs/rhhyperframes/','/hyperframes-studio/']);expect(document.querySelector('iframe')?.getAttribute('src')).toBe('about:blank');
});

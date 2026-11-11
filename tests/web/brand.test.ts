import {afterEach,describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {brandTitle,brandPageTitle,brandStaticDescription,framesTitle,emptyFramesGreeting,nativeEditorBrand,translateBrandColor} from '../../apps/web/src/brand/palette';
import {decorateFramesMark,framesFavicon} from '../../apps/web/src/brand/frames-mark';
import {nativeBrandDescriptions,nativeBrandPageTitles} from '../../apps/web/src/brand/native-metadata';
import {decorateAgentMark} from '../../apps/web/src/brand/agent-mark';
import {decorateToolbarMark,toolbarMarkSelector} from '../../apps/web/src/brand/toolbar-mark';
const themeStyles=readFileSync(new URL('../../apps/web/src/brand/theme.css',import.meta.url),'utf8');
afterEach(()=>vi.unstubAllGlobals());

describe('Studio brand translation',()=>{
 it('preserves alpha in the former brand accent',()=>{
  expect(translateBrandColor('linear-gradient(90deg,#cf03,#CCFF0073)')).toBe('linear-gradient(90deg,#b6a2ce33,#b6a2ce73)');
  expect(translateBrandColor('rgba(204,255,0,.45)')).toBe('rgba(182, 162, 206,.45)');
  expect(translateBrandColor('rgb(204 255 0 / 20%)')).toBe('rgb(182 162 206 / 20%)');
 });
 it('leaves semantic green and neutral colours alone',()=>{
  expect(translateBrandColor('color-mix(in srgb,#22c55e 20%,#a0a4ab)')).toBe('color-mix(in srgb,#22c55e 20%,#a0a4ab)');
 });
 it('keeps route and project captions in the page title',()=>{
  expect(brandPageTitle('Untitled丨RHTV')).toBe('Untitled丨Studio TV');
  expect(brandPageTitle('RunningHub RHTV ｜ AI创意工作流')).toBe('Studio TV ｜ AI创意工作流');
  expect(brandPageTitle('我的分镜 ｜ Studio TV')).toBe('我的分镜 ｜ Studio TV');
  expect(brandPageTitle('我的项目 ｜ RunningHub RHTV AI 创作画布')).toBe('我的项目 ｜ Studio TV AI 创作画布');
  expect(brandPageTitle('RunningHub 的故事 ｜ RunningHub RHTV AI 创作画布')).toBe('RunningHub 的故事 ｜ Studio TV AI 创作画布');
  expect(brandPageTitle('RunningHub 的故事｜RunningHub')).toBe('RunningHub 的故事｜Studio TV');
  expect(brandPageTitle('RHTV 的角色与 HyperFrames')).toBe('RHTV 的角色与 HyperFrames');
  expect(brandPageTitle('RunningHub 的故事')).toBe('RunningHub 的故事');
 });
 it('renames only known Frames page chrome and preserves composed work captions',()=>{
  expect(brandPageTitle('HyperFrames - Video Workspace')).toBe('Studio Frames - Video Workspace');
  expect(brandPageTitle('HyperFrames Agent')).toBe('Studio Frames Agent');
  expect(brandPageTitle('HyperFrames Studio')).toBe('Studio Frames Studio');
  expect(framesTitle('正在加载 HyperFrames…')).toBe('正在加载 Studio Frames…');
  expect(brandTitle('RunningHub-RHTV 3D Bridge')).toBe('Studio TV 3D Bridge');
  expect(brandPageTitle('用户的 HyperFrames 动画')).toBe('用户的 HyperFrames 动画');
 });
 it('fills only the empty built-in greeting from an already authenticated profile',()=>{
  expect(emptyFramesGreeting('你好，！','维护者')).toBe('你好，维护者！');
  expect(emptyFramesGreeting('你好，！')).toBe('你好');
  expect(emptyFramesGreeting('Hi, !','Alice')).toBe('Hi, Alice!');
  expect(emptyFramesGreeting('你好，RunningHub！','维护者')).toBe('你好，RunningHub！');
 });
 it('rebrands the known static shell description while retaining authored work descriptions',()=>{
  expect(brandStaticDescription('RunningHub RHTV 首页复刻预览')).toBe('Studio TV 创意工作流与视频创作画布');
  expect(brandStaticDescription('在 RunningHub 与 HyperFrames 相遇的图形故事')).toBe('在 RunningHub 与 HyperFrames 相遇的图形故事');
  for(const title of nativeBrandPageTitles)expect(brandPageTitle(title)).not.toMatch(/RunningHub|RHTV|rhTV/);
  for(const description of nativeBrandDescriptions)expect(brandStaticDescription(description)).not.toMatch(/RunningHub|RHTV|rhTV/);
  expect(brandStaticDescription('RunningHub RHTV is the title of my story, not the application description.')).toBe('RunningHub RHTV is the title of my story, not the application description.');
 });
 it('limits embedded presentation to exact native application documents',()=>{
  for(const path of ['/labs/rhhyperframes','/labs/rhhyperframes/','/labs/rhhyperframes/index.html','/hyperframes-studio','/hyperframes-studio/index.html'])expect(nativeEditorBrand(path)).toBe('frames');
  for(const path of ['/opencut','/opencut/','/opencut/index.html'])expect(nativeEditorBrand(path)).toBe('tv');
  for(const path of ['/labs/rhhyperframes/my-story','/hyperframes-studio/projects/p/preview','/studio-api/projects/p/preview/index.html','/api/v2/studio/preview/signed/p/index.html','/opencut/composition.html','/projects/'])expect(nativeEditorBrand(path)).toBeNull();
 });
 it('decorates the existing SVG without replacing its native node or handlers and remounts after native children change',()=>{
  class SvgNode extends EventTarget {
   attrs=new Map<string,string>();children:SvgNode[]=[];innerHTML='';textContent='';
   getAttribute(name:string){return this.attrs.get(name)??null;}
   setAttribute(name:string,value:string){this.attrs.set(name,value);}
   querySelector(){return this.children.find(child=>child.attrs.has('data-studio-frame-art'))??null;}
   append(...nodes:SvgNode[]){this.children.push(...nodes);}
  }
  vi.stubGlobal('document',{createElementNS:()=>new SvgNode()});
  const svg=new SvgNode(),nativePath=new SvgNode(),click=vi.fn();svg.append(nativePath);svg.addEventListener('click',click);
  decorateFramesMark(svg,true);const mounted=svg.children[1];decorateFramesMark(svg,true);
  expect(svg.children).toEqual([nativePath,mounted]);expect(svg.getAttribute('viewBox')).toBe('0 0 530 530');expect(svg.getAttribute('aria-label')).toBe('Studio Frames');
  expect(mounted.innerHTML).toContain('#5364a7');expect(mounted.getAttribute('pointer-events')).toBe('none');svg.dispatchEvent(new Event('click'));expect(click).toHaveBeenCalledOnce();
  svg.children=[nativePath];decorateFramesMark(svg,true);expect(svg.children).toHaveLength(2);expect(svg.children[0]).toBe(nativePath);
  expect(decodeURIComponent(framesFavicon)).toContain('M220 170L365 265L220 360Z');
 });
 it('keeps native orb nodes, event handlers, size/animation and blink state while adding the same Studio artwork',()=>{
  class OrbNode extends EventTarget {
   attrs=new Map<string,string>();children:OrbNode[]=[];innerHTML='';ancestorClasses=new Set<string>();
   getAttribute(name:string){return this.attrs.get(name)??null;}
   hasAttribute(name:string){return this.attrs.has(name);}
   setAttribute(name:string,value:string){this.attrs.set(name,value);}
   closest(selector:string){return selector.split(',').some(item=>this.ancestorClasses.has(item))?this:null;}
   querySelector(selector:string){return selector.includes('__inner')?this.children.find(node=>node.getAttribute('class')?.endsWith('__inner'))??null:this.children.find(node=>node.hasAttribute('data-studio-agent-art'))??null;}
   append(...nodes:OrbNode[]){this.children.push(...nodes);}
  }
  vi.stubGlobal('document',{createElementNS:()=>new OrbNode()});
  for(const variant of ['agent-orb-icon','storyboard-agent-orb-icon']){
   const orb=new OrbNode(),inner=new OrbNode(),eye=new OrbNode(),click=vi.fn();orb.setAttribute('class',variant);inner.setAttribute('class',variant+'__inner');inner.setAttribute('style','width:var(--orb-size);animation:native-orb-float 4.8s ease-in-out infinite');eye.setAttribute('class',variant+'__eye is-blink');inner.append(eye);orb.append(inner);orb.addEventListener('click',click);
   orb.ancestorClasses=new Set(['.hf-chat__msg','.hf-chat__msg-meta']);
   expect(decorateAgentMark(orb as unknown as Element)).toBe(true);const art=inner.children[1];decorateAgentMark(orb as unknown as Element);
   expect(orb.children).toEqual([inner]);expect(inner.children).toEqual([eye,art]);expect(inner.getAttribute('style')).toContain('4.8s');expect(eye.getAttribute('class')).toContain('is-blink');expect(art.getAttribute('pointer-events')).toBe('none');expect(art.getAttribute('aria-hidden')).toBe('true');expect(art.innerHTML).toContain('#5364a7');orb.dispatchEvent(new Event('click'));expect(click).toHaveBeenCalledOnce();
   inner.children=[eye];decorateAgentMark(orb as unknown as Element);expect(inner.children).toHaveLength(2);expect(inner.children[0]).toBe(eye);
   for(const protectedArea of ['.hf-chat__msg-content','.hf-chat__msg-text','.hf-chat__msg-attachments','.hf-preview']){
    const authored=new OrbNode();authored.ancestorClasses=new Set(['.hf-chat__msg',protectedArea]);authored.append(inner);expect(decorateAgentMark(authored as unknown as Element)).toBe(false);expect(authored.hasAttribute('data-studio-agent-mark')).toBe(false);
   }
  }
 });
 it('changes only the native bubble colours while retaining its angle animation and respecting reduced motion for the fox',()=>{
  const normal=themeStyles.slice(0,themeStyles.indexOf('@media(prefers-reduced-motion:reduce)'));
  expect(normal).toContain('[data-studio-brand] .hf-chat .hf-chat__input-bubble::before');expect(normal).toContain('conic-gradient(from var(--hf-bubble-angle)');expect(normal).not.toMatch(/#(?:ccff00|06e3fa|00ffaa)\b/i);
  expect(normal).not.toMatch(/\banimation(?:-[\w-]+)?\s*:/);expect(normal).toContain('.is-blink');expect(themeStyles).toContain('@media(prefers-reduced-motion:reduce)');expect(themeStyles).toMatch(/\[data-studio-agent-mark\][^{]+__inner[^}]+animation:none!important/);
 });
 it('replaces the shared image/video toolbar R artwork without replacing native event nodes or presentation',()=>{
  class NativeImage extends EventTarget {
   attrs=new Map<string,string>([['class','toolbar-agent-r-icon'],['width','15'],['height','15'],['alt',''],['aria-hidden','true'],['draggable','false'],['src','data:image/svg+xml,original-runninghub-r']]);
   writes=0;toolbar='rh-canvas-image-toolbar';agentEntry=true;authored=false;
   getAttribute(name:string){return this.attrs.get(name)??null;}
   setAttribute(name:string,value:string){this.writes++;this.attrs.set(name,value);}
   matches(selector:string){return selector===toolbarMarkSelector&&this.agentEntry&&['rh-canvas-image-toolbar','rh-canvas-video-toolbar'].includes(this.toolbar);}
   closest(){return this.authored?this:null;}
  }
  for(const toolbar of ['rh-canvas-image-toolbar','rh-canvas-video-toolbar']){
   const image=new NativeImage(),click=vi.fn();image.toolbar=toolbar;image.addEventListener('click',click);
   const nativeAttrs=[...image.attrs].filter(([name])=>name!=='src');
   expect(decorateToolbarMark(image as unknown as Element)).toBe(true);expect([...image.attrs].filter(([name])=>name!=='src')).toEqual(nativeAttrs);
   expect(decodeURIComponent(image.getAttribute('src')!)).toContain('#5364a7');image.dispatchEvent(new Event('click'));expect(click).toHaveBeenCalledOnce();
   decorateToolbarMark(image as unknown as Element);expect(image.writes).toBe(1);
   image.attrs.set('src','native-react-rerender');decorateToolbarMark(image as unknown as Element);expect(image.getAttribute('src')).toBe(framesFavicon);
  }
  for(const override of [{toolbar:'user-preview'},{agentEntry:false},{authored:true}]){
   const image=Object.assign(new NativeImage(),override);expect(decorateToolbarMark(image as unknown as Element)).toBe(false);expect(image.writes).toBe(0);
  }
 });
});

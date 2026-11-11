import {nativeBrandDescriptions,nativeBrandPageTitles} from './native-metadata';

export const BRAND_NAME='Studio TV';
export const FRAMES_NAME='Studio Frames';
export const ACCENT='#b6a2ce';
export const ACCENT_RGB='182 162 206';

// Replace the former brand lime only. Green in photographs, uploads and semantic
// status palettes is intentionally outside this translation.
export function translateBrandColor(value:string):string {
 return value
  .replace(/#ccff00([\da-f]{2})?\b/gi,(_,alpha:string|undefined)=>ACCENT+(alpha||''))
  .replace(/#cf0([\da-f])?\b/gi,(_,alpha:string|undefined)=>ACCENT+(alpha?alpha+alpha:''))
  .replace(/\b204\s*,\s*255\s*,\s*0\b/g,'182, 162, 206')
  .replace(/\b204\s+255\s+0\b/g,ACCENT_RGB);
}

export function brandTitle(title:string):string {
 return title.replace(/RunningHub[\s-]+(?:RHTV|rhTV)(?:\.ai)?/gi,BRAND_NAME)
  .replace(/\b(?:RunningHub|RHTV|rhTV)(?:\.ai)?\b/gi,BRAND_NAME);
}

// A project/skill name may itself contain an old brand. Only the application's
// suffix is replaced; arbitrary user captions are never translated.
export function brandPageTitle(title:string):string {
 if(nativeBrandPageTitles.has(title))return brandTitle(title);
 if(/([丨｜|]\s*)RunningHub RHTV AI 创作画布$/.test(title))return title.replace(/([丨｜|]\s*)RunningHub RHTV AI 创作画布$/,`$1${BRAND_NAME} AI 创作画布`);
 if(/^HyperFrames(?: Agent| Studio| - Video Workspace)?$/.test(title))return title.replace('HyperFrames',FRAMES_NAME);
 if(/^(?:RunningHub[\s-]+)?(?:RHTV|rhTV)(?:\.ai)?$/i.test(title)||/^RunningHub(?:\.ai)?$/i.test(title))return BRAND_NAME;
 if(/^(?:RunningHub\s+)?(?:RHTV|rhTV)(?:\s+(?:Plugins|for Figma|插件)|\s*[｜|—]\s*AI创意工作流)/i.test(title))return brandTitle(title);
 return title.replace(/([丨｜|]\s*)(?:RunningHub|RHTV|rhTV)(?:\.ai)?\s*$/i,`$1${BRAND_NAME}`);
}

export function framesTitle(title:string):string{return title.replace(/\bHyperFrames\b/g,FRAMES_NAME);}

export function brandStaticDescription(description:string):string {
 if(nativeBrandDescriptions.has(description))return brandTitle(description);
 return description==='RunningHub RHTV 首页复刻预览'?'Studio TV 创意工作流与视频创作画布':description;
}

export function nativeEditorBrand(pathname:string):'frames'|'tv'|null {
 if(/^\/(?:labs\/rhhyperframes|hyperframes-studio)(?:\/|\/index\.html)?$/.test(pathname))return 'frames';
 if(/^\/opencut(?:\/|\/index\.html)?$/.test(pathname))return 'tv';
 return null;
}

export function emptyFramesGreeting(text:string,displayName?:string):string {
 const name=displayName?.trim();
 const greetings:Record<string,string>={
  '你好，！':name?`你好，${name}！`:'你好',
  'Hi, !':name?`Hi, ${name}!`:'Hi!',
  'Hi !':name?`Hi ${name}!`:'Hi!',
  'こんにちは、！':name?`こんにちは、${name}！`:'こんにちは',
  '안녕하세요, 님!':name?`안녕하세요, ${name}님!`:'안녕하세요!',
 };
 return greetings[text]??text;
}

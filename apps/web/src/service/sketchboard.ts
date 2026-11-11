import {installSketchboardModels} from './sketchboard-models';
import {installSketchboardDirector} from './sketchboard-director';
/** STUDIO-owned sketch presets. These are prompt conditions for the configured
 * image editor, not claims that an upstream realtime/style model exists. */
export const sketchStyles=[
 {code:'anime',name:'二次元动漫',nameEn:'Anime',category:'illustrationArt',prompt:'Clean anime illustration, expressive shapes, coherent cel shading.'},
 {code:'line-art',name:'线稿插画',nameEn:'Line art',category:'illustrationArt',prompt:'Clean line art, deliberate contours, restrained flat colors.'},
 {code:'watercolor',name:'水彩绘画',nameEn:'Watercolor',category:'digitalCreative',prompt:'Watercolor washes, soft pigment edges and subtle paper texture.'},
 {code:'chinese-ink',name:'水墨国风',nameEn:'Chinese ink',category:'chineseCulture',prompt:'Chinese ink painting, expressive brushwork, ink washes and negative space.'},
 {code:'3d-render',name:'3D 质感',nameEn:'3D render',category:'3dEffect',prompt:'Stylized three-dimensional rendering, dimensional materials and soft studio lighting.'},
 {code:'product-design',name:'产品设计',nameEn:'Product design',category:'productDesign',prompt:'Polished product design visualization with readable materials and controlled studio lighting.'},
];
export const sketchDictionaryKeys=['sketchboard_style_live','sketchboard_style_manual'];
export function sketchDictionaries(keys:string[]){return keys.filter(key=>sketchDictionaryKeys.includes(key)).map(key=>({detailId:'studio-'+key,detailName:key,detailValue:JSON.stringify(sketchStyles.map(({prompt,...style},sort)=>({...style,sort,default:sort===0})))}));}
export interface SketchActivity {token:number;projectId:string;mode:string;phase:'submitting'|'running'|'failed'|'done';taskId?:string;message?:string}
export class SketchProgress {
 private sequence=0;
 value:SketchActivity|null=null;
 private listeners=new Set<()=>void>();
 subscribe(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 private emit(){for(const listener of this.listeners)listener();}
 start(projectId:string,mode:string){const token=++this.sequence;this.value={token,projectId,mode,phase:'submitting'};this.emit();return token;}
 update(token:number,patch:Partial<SketchActivity>){if(this.value?.token!==token)return;this.value={...this.value,...patch};this.emit();}
 clear(){this.sequence++;this.value=null;this.emit();}
}
/** Native first-render status says "waiting" until a result exists. Add a
 * scoped status sibling so React still owns all original content/actions. */
export function installSketchboardUi(progress:SketchProgress,project:()=>string|undefined,root:Document=document,models?:import('./sketchboard-models').SketchModelPort){
 const style=root.createElement('style');style.textContent='.sketch-studio__preview-empty-time{display:none!important}.studio-sketch-hint{font-size:12px;color:#aaa;line-height:1.5}.studio-sketch-status{font-size:13px;color:#e7e7e7}.sketch-studio__generation-status[data-studio-busy="true"]{display:none!important}';root.head.append(style);
 let board:Element|null=null;
 const render=()=>{
  const current=root.querySelector('.sketch-studio');
  if(board&&!current){board=null;progress.clear();return;}board=current;if(!board)return;
  const meta=board.querySelector('.sketch-studio__preview-empty-meta');
  if(meta&&!meta.querySelector('.studio-sketch-hint')){const hint=root.createElement('span');hint.className='studio-sketch-hint';hint.textContent='草图变化后自动提交图片生成，可能需要数分钟。';meta.append(hint);}
  const native=board.querySelector('.sketch-studio__generation-status'),anchor=native??board.querySelector('.sketch-studio__generation-mode');if(!anchor)return;
  const activity=progress.value,mode=board.querySelector('.sketch-studio__generation-mode-option[aria-checked="true"]')?.className.includes('is-active')?board.querySelector('.sketch-studio__generation-mode')?.className.includes('is-manual')?'manual':'live':null;
  // The nested sketchboard route releases the canvas manager; use its own route scope.
  const projectId=project()??root.location?.pathname.match(/^\/project\/canvas\/([^/]+)\/sketchboard\/?$/)?.[1];
  const busy=activity&&activity.projectId===projectId&&activity.mode===mode&&['submitting','running'].includes(activity.phase);
  const paused=!!board.querySelector('.sketch-studio__generation-submit button[aria-label="恢复实时生成"]');
  const message=busy?(paused?'已暂停自动更新，已提交任务仍在后台处理。':activity.message??(activity.phase==='submitting'?'正在上传草图并提交生成…':'图片生成中，请稍候；可能需要数分钟。')):'';
  if(native&&native.getAttribute('data-studio-busy')!==String(!!message))native.setAttribute('data-studio-busy',String(!!message));
  let status=board.querySelector('.studio-sketch-status');
  if(message){if(!status){status=root.createElement('span');status.className='studio-sketch-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');anchor.after(status);}if(status.textContent!==message)status.textContent=message;}else status?.remove();
 };
 const observer=new MutationObserver(render);observer.observe(root.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','aria-checked','aria-label']});const release=progress.subscribe(render);render();
 const releaseModels=models?installSketchboardModels(models,project,root):()=>{};
 const releaseDirector=models?installSketchboardDirector(models,project,root):()=>{};
 return()=>{releaseDirector();releaseModels();observer.disconnect();release();style.remove();root.querySelectorAll('.studio-sketch-status,.studio-sketch-hint').forEach(node=>node.remove());root.querySelectorAll('[data-studio-busy]').forEach(node=>node.removeAttribute('data-studio-busy'));};
}

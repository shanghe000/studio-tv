import {ApiError} from '../api/client';
import {sketchModel,sketchModelOptions,type SketchModelPort} from './sketchboard-models';
import type {Capability} from './model-catalog';

/** Exact immutable DirectorMode2D imperative seam. Capture its own drawing,
 * never a screenshot of toolbars, DOM overlays or the result preview. */
export function sketchDirectorPort(element:any){
 const key=Object.keys(element??{}).find(key=>key.startsWith('__reactFiber$'));let fiber=key?element[key]:null;
 for(let depth=0;fiber&&depth<25;depth++,fiber=fiber.return){
  const handle=fiber.ref?.current,props=fiber.memoizedProps;
  if(handle&&typeof handle.capture==='function'&&typeof handle.getSchema==='function'&&typeof props?.onSave==='function'&&Object.hasOwn(props,'initialImageUrl')&&Object.hasOwn(props,'initialSchema'))return{capture:()=>handle.capture(),schema:()=>handle.getSchema(),apply:(payload:any)=>props.onSave(payload)};
 }
 return null;
}
const projectScope=(project:()=>string|undefined,root:Document)=>root.location?.pathname.match(/^\/project\/canvas\/([^/]+)\/sketchboard\/?$/)?.[1]??project();
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,16));
/** Reuse the native manual preview and actual generate button after applying
 * the full 2D editor's export through its existing save callback. */
export async function generateFromSketchDirector(director:Element,board:Element,projectId:string,prompt:string,cap:Capability,port:SketchModelPort,project:()=>string|undefined,root:Document=document){
 const current=()=>board.isConnected&&projectScope(project,root)===projectId&&port.canRun?.(projectId)!==false;
 if(!current())throw new ApiError(409,'STALE_CANVAS_SESSION','画板或项目权限已变化，请重新打开。');
 const text=prompt.trim()||(cap.kind==='IMAGE_TO_IMAGE'?'根据草图生成完整画面，保留主体、轮廓和空间布局。':'');
 if(!text)throw new ApiError(422,'SKETCH_PROMPT_REQUIRED','文字创作需要填写画面描述；画笔不作为文字模型的约束。');
 const native=sketchDirectorPort(director);if(!native)throw new ApiError(501,'SKETCH_EXPORT_UNAVAILABLE','当前2D画板无法导出，请通过截屏将草图应用到生成预览。');
 const dataURL=await native.capture();
 if(!current()||!director.isConnected)throw new ApiError(409,'STALE_CANVAS_SESSION','画板已关闭，本次生成未提交。');
 if(typeof dataURL!=='string'||!dataURL.startsWith('data:image/png;base64,'))throw new ApiError(422,'INVALID_IMAGE','2D画板没有返回可用的PNG草图。');
 const schema=await native.schema();
 if(!current()||!director.isConnected)throw new ApiError(409,'STALE_CANVAS_SESSION','画板已关闭，本次生成未提交。');
 port.selections.set(projectId,'manual',{capabilityRef:cap.capabilityRef,capabilityVersion:cap.version});
 await native.apply({dataURL,schema,mode:'2d',direct:true,keepOpen:false});
 if(!current())throw new ApiError(409,'STALE_CANVAS_SESSION','画板或登录状态已变化，本次生成未提交。');
 const modes=board.querySelectorAll<HTMLButtonElement>('.sketch-studio__generation-mode-option');
 if(modes.length!==2)throw new ApiError(501,'SKETCH_PREVIEW_UNAVAILABLE','已应用草图，请在生成预览中切换手动模式后生成。');
 modes[1].click();await tick();
 const input=board.querySelector<HTMLTextAreaElement|HTMLInputElement>('.sketch-studio__prompt textarea,.sketch-studio__prompt input');
 if(!input)throw new ApiError(501,'SKETCH_PREVIEW_UNAVAILABLE','已应用草图，请在生成预览填写描述后生成。');
 const view=root.defaultView!,prototype=input.tagName==='TEXTAREA'?view.HTMLTextAreaElement.prototype:view.HTMLInputElement.prototype;
 Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(input,text);input.dispatchEvent(new view.Event('input',{bubbles:true}));input.dispatchEvent(new view.Event('change',{bubbles:true}));
 for(let attempt=0;attempt<8;attempt++){
  await tick();if(!current())throw new ApiError(409,'STALE_CANVAS_SESSION','画板已切换，本次生成未提交。');
  const send=board.querySelector<HTMLButtonElement>('.sketch-studio__generation-submit button');
  if(board.querySelector('.sketch-studio__generation-mode.is-manual')&&send&&!send.disabled){send.click();return;}
 }
 throw new ApiError(409,'SKETCH_PREVIEW_NOT_READY','草图已应用，请在手动生成预览中点击生成。');
}

export function installSketchboardDirector(port:SketchModelPort,project:()=>string|undefined,root:Document=document){
 const css=root.createElement('style');css.textContent='.studio-sketch-director{position:absolute;right:14px;top:12px;z-index:30;width:min(330px,calc(100% - 28px));padding:12px;border:1px solid #525252;border-radius:10px;background:rgba(30,30,30,.96);color:#eee;font-size:12px;box-shadow:0 4px 20px #0003}.studio-sketch-director summary{cursor:pointer;font-weight:600}.studio-sketch-director label{display:flex;flex-direction:column;gap:5px;margin-top:10px}.studio-sketch-director select,.studio-sketch-director textarea{box-sizing:border-box;width:100%;border:1px solid #555;border-radius:5px;padding:7px;background:#272727;color:#eee;font:inherit}.studio-sketch-director textarea{resize:vertical;min-height:64px}.studio-sketch-director p{margin:8px 0;color:#bbb;line-height:1.5}.studio-sketch-director button{width:100%;border:1px solid #8170dc;border-radius:6px;background:#6550b7;color:#fff;padding:8px;cursor:pointer}.studio-sketch-director button:disabled{opacity:.5;cursor:default}';root.head.append(css);
 let director:Element|null=null,panel:HTMLDetailsElement|null=null,request=0,disposed=false;
 const render=()=>{
  const board=root.querySelector('.sketch-studio'),next=board?root.querySelector('.director-shell.is-2d .director-2d-root'):null;
  if(next===director)return;director=next;request++;panel?.remove();panel=null;if(!director||!board)return;
  const projectId=projectScope(project,root);if(!projectId)return;
  const active=director,generation=request;panel=root.createElement('details');panel.className='studio-sketch-director';panel.open=true;
  const summary=root.createElement('summary');summary.textContent='生成图像';
  const label=root.createElement('label');label.textContent='生成模型';const select=root.createElement('select');select.setAttribute('aria-label','纯2D画板生成模型');select.disabled=true;label.append(select);
  const description=root.createElement('label');description.textContent='画面描述';const prompt=root.createElement('textarea');prompt.rows=3;prompt.setAttribute('aria-label','纯2D画板画面描述');prompt.value=board.querySelector<HTMLTextAreaElement|HTMLInputElement>('.sketch-studio__prompt textarea,.sketch-studio__prompt input')?.value??'';description.append(prompt);
  const hint=root.createElement('p');hint.setAttribute('role','status');hint.textContent='正在读取模型…';const button=root.createElement('button');button.type='button';button.textContent='应用草图并生成';button.setAttribute('aria-label','应用2D草图并生成');button.disabled=true;
  panel.append(summary,label,description,hint,button);active.append(panel);
  let caps:Capability[]=[],selected:Capability|undefined,busy=false;
  const choose=()=>{
   const cap=caps.find(cap=>cap.capabilityRef===select.value);selected=cap;if(cap)port.selections.set(projectId,'manual',{capabilityRef:cap.capabilityRef,capabilityVersion:cap.version});
   hint.textContent=cap?.kind==='TEXT_TO_IMAGE'?'文字创作：只使用描述与预览中所选风格，画笔不作为约束；单张输出。':'参考草图：使用当前2D绘画和预览中所选风格；单张输出。';
   button.disabled=!cap||port.canRun?.(projectId)===false||!sketchDirectorPort(active);select.disabled=busy||port.canRun?.(projectId)===false;
  };
  select.addEventListener('change',choose);
  button.addEventListener('click',()=>{if(busy||!selected)return;busy=true;button.disabled=true;select.disabled=true;button.textContent='正在打开生成预览…';void generateFromSketchDirector(active,board,projectId,prompt.value,selected,port,project,root).catch((error:unknown)=>{const message=error instanceof Error?error.message:'草图生成未提交。';hint.textContent=message;port.notice?.(message);}).finally(()=>{busy=false;if(active.isConnected){button.textContent='应用草图并生成';button.disabled=!selected||port.canRun?.(projectId)===false;select.disabled=port.canRun?.(projectId)===false;}});});
  void port.catalog().then(items=>{
   if(disposed||request!==generation||director!==active||!active.isConnected)return;caps=items;const options=sketchModelOptions(caps,'manual');
   for(const [kind,name]of [['IMAGE_TO_IMAGE','参考草图'],['TEXT_TO_IMAGE','文字创作']]){const group=root.createElement('optgroup');group.label=name;for(const cap of options.filter(cap=>cap.kind===kind)){const option=root.createElement('option');option.value=cap.capabilityRef;option.textContent=cap.title||cap.model?.title||cap.capabilityRef;group.append(option);}if(group.children.length)select.append(group);}
   try{const cap=sketchModel(caps,projectId,'manual',port.selections,{}, {allowTestMode:false});if(!options.some(option=>option.capabilityRef===cap.capabilityRef))throw new Error('没有可用的图片生成模型。');select.value=cap.capabilityRef;choose();}catch(error){const invalid=root.createElement('option');invalid.value='';invalid.textContent='请选择可用的模型';invalid.disabled=true;select.prepend(invalid);select.value='';select.disabled=!options.length||port.canRun?.(projectId)===false;hint.textContent=error instanceof Error?error.message:'请选择可用模型。';}
  }).catch((error:unknown)=>{if(!disposed&&generation===request)hint.textContent=error instanceof Error?error.message:'模型目录读取失败。';});
 };
 const observer=new MutationObserver(render);observer.observe(root.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});render();
 return()=>{disposed=true;request++;observer.disconnect();panel?.remove();css.remove();};
}

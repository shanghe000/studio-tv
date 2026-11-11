import {ApiError} from '../api/client';
import {menuCapabilities,modelChoice,selectCapability,type Capability,type ModelChoice,type ModelPolicy} from './model-catalog';

/** A 2D preview consumes one image. Text models create from the written
 * description; only image editors receive the drawing as conditioning. */
export class SketchModelSelections {
 private choices=new Map<string,ModelChoice>();
 get(projectId:string,mode:string){return this.choices.get(projectId+':'+mode);}
 set(projectId:string,mode:string,choice:ModelChoice){this.choices.set(projectId+':'+mode,{...choice,explicit:true});}
 clear(){this.choices.clear();}
}
export function sketchModelOptions(caps:Capability[],mode:string,policy:ModelPolicy={allowTestMode:false}){
 const usable=(cap:Capability)=>cap.testMode===false&&!!cap.model&&cap.outputKinds?.includes('IMAGE');
 const edits=menuCapabilities(caps,'IMAGE_TO_IMAGE',['IMAGE'],policy).filter(usable);
 const text=mode==='manual'?menuCapabilities(caps,'TEXT_TO_IMAGE',[],policy).filter(usable):[];
 return [...edits,...text];
}
export function sketchModel(caps:Capability[],projectId:string,mode:string,selections:SketchModelSelections,body:any={},policy:ModelPolicy={}){
 const choice=modelChoice(body)??selections.get(projectId,mode);
 const known=choice?caps.find(cap=>cap.capabilityRef===choice.capabilityRef):undefined;
 if(known?.kind==='TEXT_TO_IMAGE'&&mode!=='manual')throw new ApiError(422,'SKETCH_TEXT_REQUIRES_MANUAL','文字创作模型请切换到手动模式，避免绘画变化自动生成。');
 const kind=known?.kind==='TEXT_TO_IMAGE'?'TEXT_TO_IMAGE':'IMAGE_TO_IMAGE';
 const preferred=!choice?menuCapabilities(caps,kind,['IMAGE'],policy).find(cap=>cap.capabilityRef==='qwen-image-edit-2511-v1'):undefined;
 return selectCapability(caps,kind,kind==='IMAGE_TO_IMAGE'?['IMAGE']:[],choice??(preferred?{capabilityRef:preferred.capabilityRef,capabilityVersion:preferred.version}:undefined),policy);
}
export interface SketchModelPort {
 catalog:()=>Promise<Capability[]>;
 selections:SketchModelSelections;
 canRun?:(projectId:string)=>boolean;
 notice?:(message:string)=>void;
}
function currentMode(board:Element){return board.querySelector('.sketch-studio__generation-mode')?.classList.contains('is-manual')?'manual':'live';}
function scope(project:()=>string|undefined,root:Document){return root.location?.pathname.match(/^\/project\/canvas\/([^/]+)\/sketchboard\/?$/)?.[1]??project();}
function outputHint(cap?:Capability){
 const value=cap?.parameterSchema?.properties?.outputPreset?.default,rows=cap?.parameterSchema?.['x-output-presets'];
 const preset=Array.isArray(rows)?rows.find(row=>row?.value===value):undefined;
 return preset&&Number.isSafeInteger(preset.width)&&Number.isSafeInteger(preset.height)?`单张输出 · ${preset.width}×${preset.height}`:'单张输出 · 模型默认尺寸';
}
/** The frozen sketch editor has no model selector. Add a STUDIO-owned sibling,
 * keeping its drawing controls, style picker and generate action intact. */
export function installSketchboardModels(port:SketchModelPort,project:()=>string|undefined,root:Document=document){
 const css=root.createElement('style');css.textContent='.studio-sketch-models{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid #393939;font-size:12px;color:#c8c8c8}.studio-sketch-models select{max-width:min(420px,100%);min-width:210px;background:#252525;color:#eee;border:1px solid #515151;border-radius:6px;padding:6px}.studio-sketch-model-hint{flex-basis:100%;line-height:1.5;color:#aaa}.studio-sketch-model-error{color:#f3b4a7}';root.head.append(css);
 let board:Element|null=null,control:HTMLDivElement|null=null,select:HTMLSelectElement|null=null,hint:HTMLSpanElement|null=null,caps:Capability[]=[],key='',request=0,disposed=false;
 const message=(text:string,error=false)=>{if(hint&&hint.textContent!==text)hint.textContent=text;hint?.classList.toggle('studio-sketch-model-error',error);};
 const render=()=>{
  const next=root.querySelector('.sketch-studio');
  if(next!==board){request++;board=next;control?.remove();control=null;select=null;hint=null;key='';caps=[];}
  if(!board)return;
  const projectId=scope(project,root),mode=currentMode(board),nextKey=(projectId??'')+':'+mode;
  if(!control){
   const anchor=board.querySelector('.sketch-studio__preview-topbar')??board.querySelector('.sketch-studio__generation-mode')?.parentElement;
   if(!anchor)return;
   control=root.createElement('div');control.className='studio-sketch-models';
   const label=root.createElement('label');label.textContent='生成模型';select=root.createElement('select');select.setAttribute('aria-label','2D画板生成模型');label.append(select);
   hint=root.createElement('span');hint.className='studio-sketch-model-hint';hint.setAttribute('role','status');control.append(label,hint);anchor.after(control);
   select.addEventListener('change',()=>{
    if(!board||!select)return;const id=scope(project,root),mode=currentMode(board),cap=caps.find(cap=>cap.capabilityRef===select!.value);
    if(!id||!cap)return;
    port.selections.set(id,mode,{capabilityRef:cap.capabilityRef,capabilityVersion:cap.version});renderOptions(id,mode);
   });
  }
  if(nextKey===key)return;key=nextKey;
  select!.disabled=true;message('正在读取可用模型…');
  if(!projectId){message('请先打开作品。',true);return;}
  const generation=++request;
  void port.catalog().then(items=>{if(disposed||generation!==request||!board||scope(project,root)!==projectId||currentMode(board)!==mode)return;caps=items;renderOptions(projectId,mode);}).catch((error:unknown)=>{if(disposed||generation!==request)return;message(error instanceof Error?error.message:'模型目录读取失败。',true);});
 };
 const renderOptions=(projectId:string,mode:string)=>{
  if(!select)return;select.replaceChildren();const options=sketchModelOptions(caps,mode),choice=port.selections.get(projectId,mode);
  for(const [kind,label]of [['IMAGE_TO_IMAGE','参考草图'],['TEXT_TO_IMAGE','文字创作（仅手动）']]){
   const rows=options.filter(cap=>cap.kind===kind);if(!rows.length)continue;const group=root.createElement('optgroup');group.label=label;
   for(const cap of rows){const option=root.createElement('option');option.value=cap.capabilityRef;option.textContent=cap.title||cap.model?.title||cap.capabilityRef;group.append(option);}select.append(group);
  }
  try{
   const cap=sketchModel(caps,projectId,mode,port.selections,{}, {allowTestMode:false});
   if(!options.some(row=>row.capabilityRef===cap.capabilityRef))throw new ApiError(501,'MODEL_UNAVAILABLE','此入口暂无可用的真实图片模型。');
   select.value=cap.capabilityRef;
   if(!choice)port.selections.set(projectId,mode,{capabilityRef:cap.capabilityRef,capabilityVersion:cap.version});
   select.disabled=port.canRun?.(projectId)===false;
   message(cap.kind==='TEXT_TO_IMAGE'?`文字创作：只读取下方描述与所选风格，画笔不作为约束。${outputHint(cap)}。`:`参考草图：保留绘画布局并应用所选风格。${outputHint(cap)}。${mode==='live'?'手动模式还可选择文字创作模型。':''}`);
   const emptyHint=board?.querySelector('.studio-sketch-hint');if(emptyHint)emptyHint.textContent=mode==='manual'?'填写描述后手动提交图片生成，完成时间取决于模型和队列。':'草图变化后自动提交图片编辑，完成时间取决于模型和队列。';
  }catch(error){
   const missing=root.createElement('option');missing.value=choice?.capabilityRef??'';missing.textContent=choice?'已选模型不可用，请重新选择':'没有可用的图片模型';missing.disabled=true;select.prepend(missing);select.value=missing.value;select.disabled=options.length===0||port.canRun?.(projectId)===false;
   message(error instanceof Error?error.message:'请选择可用模型。',true);
  }
 };
 const observer=new MutationObserver(render);observer.observe(root.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','aria-checked']});render();
 return()=>{disposed=true;request++;observer.disconnect();control?.remove();css.remove();};
}

/** Explain the actual operation at the native image-toolbar boundary. Frozen
 * controls remain intact; unavailable decomposition cannot start partial work. */
export function installImageToolNotices(notice:(message:string)=>void,propsOf:(element:any)=>any[],root:Document=document){
 const listener=(event:Event)=>{
  const button=(event.target as Element|null)?.closest?.('button,[role="menuitem"]');if(!button)return;
  const label=(button.getAttribute('aria-label')||button.textContent||'').trim(),props=propsOf(button);
  const image=props.find(p=>p.targetNode?.type==='rh-image'||p.node?.type==='rh-image');if(!image)return;
  if(['编辑元素','Edit elements','Edit Elements'].includes(label)){
   const context=props.find(p=>p.toolbarContext?.models)?.toolbarContext;
   const rows=context?.models?.['image-layer-decomposition']??context?.models?.IMAGE_LAYER_DECOMPOSITION;
   if(Array.isArray(rows)&&rows.some((row:any)=>row.available===true&&!row.testMode))return;
   event.preventDefault();event.stopImmediatePropagation();notice('编辑元素需要图片分层模型，目前尚未接入。可以先用重绘、擦除或透明抠图编辑画面。');return;
  }
  const message:Record<string,string>={
   '人物调节':'按人物选项生成调整结果，其他细节也可能变化；输出尺寸由模型决定。',
   '全景图':'生成可用于全景预览的图片；可能存在接缝或极区变形，输出尺寸由模型决定，不保证固定 2K 或 4K。',
   '重绘':'按原图和标记区域生成修改结果；区域外的内容也可能变化。',
   '擦除':'按标记区域移除内容并补全背景；区域外的内容也可能变化。',
   '扩图':'按扩展画布生成新内容，原图细节也可能变化；所选尺寸用于画布参考，输出像素尺寸由模型决定。',
   '角度':'按所选角度生成新视图，人物和细节可能变化。',
   '打光':'按所选方向、强度和颜色生成光照效果。',
  };
  if(message[label])notice(message[label]);
 };
 root.addEventListener('click',listener,true);return()=>root.removeEventListener('click',listener,true);
}

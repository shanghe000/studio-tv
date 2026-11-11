const reviewed=new Map([
 ['codex-image-edit-v1', {version:'3',provider:'codex',model:'codex-image'}],
 ['qwen-image-edit-2511-v1', {version:'1',provider:'comfy',model:'qwen-image-edit-2511'}],
]);

/** Frozen Hir/J1t/whr displays an intensity field as value*10 followed by %.
 * STUDIO semantic light controls instead use a 0..100 intent scale. Only the
 * reviewed live model/schema pair may receive this display correction. */
export function semanticLightIntensityValue(model:any,cfg:any,value:any):string|undefined {
 const known=reviewed.get(model?.capabilityRef),fields=Array.isArray(model?.config)?model.config:[],field=fields.find((row:any)=>row.paramName==='light_intensity');
 if(!known||model.available!==true||model.testMode!==false||model.kind!=='IMAGE_TO_IMAGE'
  ||model.capabilityVersion!==known.version||model.model?.providerRef!==known.provider||model.model?.modelRef!==known.model
  ||!['light_azimuth','light_elevation','light_color_hex','imageUrls'].every(name=>fields.some((row:any)=>row.paramName===name))
  ||!field||field.min!==0||field.max!==100||!['int','float'].includes(field.type)
  ||cfg?.paramName!=='light_intensity'||cfg.min!==0||cfg.max!==100||cfg.type!==field.type
  ||typeof value!=='number'||!Number.isFinite(value)||value<0||value>100)return;
 return String(value);
}

/** Change only the exact native row's text; keep its input, React props,
 * current value, preview calculation and inference callbacks untouched. */
export function installSemanticLightIntensityDisplay(propsOf:(element:any)=>any[],root:Document=document){
 let active=true,scheduled=false;const owned=new Map<Text,{original:string;written:string}>(),titles=new Map<Element,{original:string|null;written:string}>();
 const restore=(text:Text,state:{original:string;written:string})=>{if(text.data===state.written)text.data=state.original;};
 const write=(text:Text,value:string,seen:Set<Text>)=>{seen.add(text);const prior=owned.get(text);if(text.data!==prior?.written)owned.set(text,{original:text.data,written:value});else if(prior)prior.written=value;if(text.data!==value)text.data=value;};
 const refresh=()=>{
  scheduled=false;if(!active)return;const seen=new Set<Text>(),seenTitles=new Set<Element>();
  for(const row of root.querySelectorAll('.rh-lighting-panel .rh-tool-panel__control-row')){
   const props=propsOf(row),field=props.find(p=>p.cfg?.paramName==='light_intensity'),model=props.find(p=>p.currentModel)?.currentModel;
   const value=semanticLightIntensityValue(model,field?.cfg,field?.value);if(value===undefined)continue;
   const display=row.querySelector('.rh-tool-panel__control-value'),first=display?.firstChild,unit=display?.querySelector('.rh-tool-panel__control-unit');
   if(!display||display.childNodes.length!==2||first?.nodeType!==3||unit?.childNodes.length!==1||unit.firstChild?.nodeType!==3)continue;
   write(first as Text,value,seen);write(unit.firstChild as Text,' / 100',seen);
   const title='生成式光照强度刻度：0–100（不是物理光学百分比）',prior=titles.get(display),current=display.getAttribute('title');
   if(current!==prior?.written)titles.set(display,{original:current,written:title});seenTitles.add(display);if(current!==title)display.setAttribute('title',title);
  }
  for(const[text,state]of owned)if(!seen.has(text)){restore(text,state);owned.delete(text);}
  for(const[element,state]of titles)if(!seenTitles.has(element)){if(element.getAttribute('title')===state.written){if(state.original===null)element.removeAttribute('title');else element.setAttribute('title',state.original);}titles.delete(element);}
 };
 const schedule=()=>{if(!active||scheduled)return;scheduled=true;if(root.defaultView?.requestAnimationFrame)root.defaultView.requestAnimationFrame(refresh);else queueMicrotask(refresh);};
 const observer=new MutationObserver(schedule);if(root.body)observer.observe(root.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class']});refresh();
 return()=>{if(!active)return;active=false;observer.disconnect();for(const[text,state]of owned)restore(text,state);owned.clear();for(const[element,state]of titles)if(element.getAttribute('title')===state.written){if(state.original===null)element.removeAttribute('title');else element.setAttribute('title',state.original);}titles.clear();};
}

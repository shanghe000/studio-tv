interface Bounds {left:number;right:number;top:number;bottom:number;width:number;height:number}
/** The native portal measures only its root; its absolute flyouts extend past it. */
export function modelMenuShift(bounds:Bounds[],width:number,height:number){
 const visible=bounds.filter(rect=>rect.width>0&&rect.height>0);if(!visible.length)return{x:0,y:0};
 const left=Math.min(...visible.map(rect=>rect.left)),right=Math.max(...visible.map(rect=>rect.right)),top=Math.min(...visible.map(rect=>rect.top)),bottom=Math.max(...visible.map(rect=>rect.bottom)),margin=8;
 return{x:right-left>width-2*margin?margin-left:Math.max(margin-left,Math.min(0,width-margin-right)),y:bottom-top>height-2*margin?margin-top:Math.max(margin-top,Math.min(0,height-margin-bottom))};
}
interface Menu {x:number;y:number;z:string;zPriority:string;translate:string;translatePriority:string}
interface SourceColumn {styles:{name:string;value:string;priority:string;written:string|null}[];marker:string|null}
export function sourceModelMenuColumnHeight(top:number,bottom:number,scale=1){return Math.max(1,bottom-top)/(Number.isFinite(scale)&&scale>0?scale:1);}
/** Native absolute flyouts retain a fixed420px maximum even when their top
 * is close to the viewport edge. Limit each actual column, rather than the
 * root portal, so every last model can be reached by scrolling that column. */
export function installSourceModelMenuViewport(root:Document=document):()=>void{
 const view=root.defaultView;if(!root.body||!view?.HTMLElement||typeof MutationObserver==='undefined')return()=>{};
 const columns=new Map<HTMLElement,SourceColumn>();let disposed=false,scheduled=false;
 const restore=(column:HTMLElement,state:SourceColumn)=>{for(const property of state.styles)if(column.style.getPropertyValue(property.name)===property.written){if(property.value)column.style.setProperty(property.name,property.value,property.priority);else column.style.removeProperty(property.name);}if(state.marker===null)column.removeAttribute('data-studio-source-menu-scroll');else column.setAttribute('data-studio-source-menu-scroll',state.marker);resize?.unobserve(column);columns.delete(column);};
 const refresh=()=>{
  scheduled=false;if(disposed)return;const active=new Set<HTMLElement>();let bottom=view.innerHeight-12;
  for(const chrome of root.querySelectorAll<HTMLElement>('.canvas-bottom-controls-row,.canvas-bottom-pill')){const css=view.getComputedStyle(chrome),rect=chrome.getBoundingClientRect();if(css.display!=='none'&&css.visibility!=='hidden'&&rect.width>0&&rect.height>0&&rect.top>0&&rect.top<view.innerHeight){bottom=Math.min(bottom,rect.top-12);resize?.observe(chrome);}}
  for(const column of root.querySelectorAll<HTMLElement>('.studio-model-source-menu .mg-cascade-panel__col')){
   const css=view.getComputedStyle(column),rect=column.getBoundingClientRect();if(css.display==='none'||css.visibility==='hidden'||!rect.width||!rect.height)continue;
   active.add(column);let state=columns.get(column);if(!state){state={styles:['max-height','overflow-y','overscroll-behavior'].map(name=>({name,value:column.style.getPropertyValue(name),priority:column.style.getPropertyPriority(name),written:null})),marker:column.getAttribute('data-studio-source-menu-scroll')};columns.set(column,state);column.setAttribute('data-studio-source-menu-scroll','true');resize?.observe(column);}
   const scale=column.offsetWidth>0?rect.width/column.offsetWidth:1,box=css.boxSizing==='border-box'?0:['paddingTop','paddingBottom','borderTopWidth','borderBottomWidth'].reduce((sum,name)=>sum+(Number.parseFloat((css as any)[name])||0),0),height=Math.max(1,sourceModelMenuColumnHeight(rect.top,bottom,scale)-box);
   for(const [index,value]of [height+'px','auto','contain'].entries()){const property=state.styles[index];if(column.style.getPropertyValue(property.name)!==value||column.style.getPropertyPriority(property.name)!=='important')column.style.setProperty(property.name,value,'important');property.written=column.style.getPropertyValue(property.name);}
  }
  for(const [column,state]of columns)if(!active.has(column))restore(column,state);
 };
 const schedule=()=>{if(!disposed&&!scheduled){scheduled=true;view.requestAnimationFrame(refresh);}},resize=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(schedule),observer=new MutationObserver(schedule);observer.observe(root.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style']});view.addEventListener('resize',schedule);view.addEventListener('scroll',schedule,true);refresh();
 return()=>{disposed=true;observer.disconnect();resize?.disconnect();view.removeEventListener('resize',schedule);view.removeEventListener('scroll',schedule,true);for(const [column,state]of columns)restore(column,state);};
}
/** Keep the native video cascade clickable above its own Agent panel. No model
 * controls, native callbacks or portals outside that active composer change. */
export function installNativeModelMenuViewport(documentRoot:Document=document):()=>void {
 const view=documentRoot.defaultView;if(!documentRoot.body||!view||typeof MutationObserver==='undefined')return()=>{};
 const releaseSourceMenus=installSourceModelMenuViewport(documentRoot);
 let trigger:HTMLElement|null=null,disposed=false,scheduled=false;const menus=new Map<HTMLElement,Menu>();
 const restore=(popup:HTMLElement,menu:Menu)=>{for(const [name,value,priority]of [['z-index',menu.z,menu.zPriority],['translate',menu.translate,menu.translatePriority]])if(value)popup.style.setProperty(name,value,priority);else popup.style.removeProperty(name);popup.removeAttribute('data-studio-assistant-model-menu');menus.delete(popup);};
 const refresh=()=>{
  scheduled=false;if(disposed)return;const panel=trigger?.isConnected?trigger.closest<HTMLElement>('.agent-chat-panel'):null,visible=new Set<HTMLElement>();
  if(panel)for(const popup of documentRoot.querySelectorAll<HTMLElement>('.mg-cascade-overlay')){
   const style=view.getComputedStyle(popup),rect=popup.getBoundingClientRect();if(style.display==='none'||style.visibility==='hidden'||!rect.width||!rect.height)continue;
   visible.add(popup);let menu=menus.get(popup);if(!menu){menu={x:0,y:0,z:popup.style.getPropertyValue('z-index'),zPriority:popup.style.getPropertyPriority('z-index'),translate:popup.style.getPropertyValue('translate'),translatePriority:popup.style.getPropertyPriority('translate')};menus.set(popup,menu);popup.setAttribute('data-studio-assistant-model-menu','true');}
   const z=String(Math.max(2101,(Number(view.getComputedStyle(panel).zIndex)||10000)+1));if(popup.style.getPropertyValue('z-index')!==z||popup.style.getPropertyPriority('z-index')!=='important')popup.style.setProperty('z-index',z,'important');
   const columns=[...popup.querySelectorAll<HTMLElement>('.mg-cascade-panel__col,.mg-cascade-panel__item')].map(column=>column.getBoundingClientRect()),bounds=(columns.length?columns:[rect]).map(rect=>({left:rect.left-menu!.x,right:rect.right-menu!.x,top:rect.top-menu!.y,bottom:rect.bottom-menu!.y,width:rect.width,height:rect.height})),shift=modelMenuShift(bounds,view.innerWidth,view.innerHeight);menu.x=shift.x;menu.y=shift.y;
   const translate=menu.x+'px '+menu.y+'px',currentTranslate=popup.style.getPropertyValue('translate').trim().split(/\s+/),sameTranslate=parseFloat(currentTranslate[0])===menu.x&&parseFloat(currentTranslate[1]??'0')===menu.y;if(!sameTranslate||popup.style.getPropertyPriority('translate')!=='important')popup.style.setProperty('translate',translate,'important');
  }
  for(const [popup,menu]of menus)if(!visible.has(popup))restore(popup,menu);
 };
 const schedule=()=>{if(!disposed&&!scheduled){scheduled=true;view.requestAnimationFrame(refresh);}},activate=(event:Event)=>{
  const target=event.target as Element,next=target?.closest<HTMLElement>('.hcp-inline-video-model .glass-dropdown-trigger');
  if(next?.closest('.agent-chat-panel'))trigger=next;else if(!target?.closest('[data-studio-assistant-model-menu]'))trigger=null;schedule();
 };
 const observer=new MutationObserver(()=>{if(trigger||menus.size)schedule();});observer.observe(documentRoot.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style']});
 documentRoot.addEventListener('pointerdown',activate,true);documentRoot.addEventListener('click',activate,true);view.addEventListener('resize',schedule);view.addEventListener('scroll',schedule,true);
 return()=>{disposed=true;releaseSourceMenus();observer.disconnect();documentRoot.removeEventListener('pointerdown',activate,true);documentRoot.removeEventListener('click',activate,true);view.removeEventListener('resize',schedule);view.removeEventListener('scroll',schedule,true);for(const [popup,menu]of menus)restore(popup,menu);};
}

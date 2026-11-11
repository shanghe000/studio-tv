interface Bounds {left:number;right:number;top:number;bottom:number;width:number;height:number}

export function videoComposerViewportShift(rect:Bounds,width:number,height:number,usable?:Bounds){
 const margin=12,area=usable??{left:margin,right:width-margin,top:margin,bottom:height-margin,width:width-2*margin,height:height-2*margin};
 return{
  x:rect.width>area.width?area.left-rect.left:Math.max(area.left-rect.left,Math.min(0,area.right-rect.right)),
  y:rect.height>area.height?area.top-rect.top:Math.max(area.top-rect.top,Math.min(0,area.bottom-rect.bottom)),
 };
}

/** These inspected canvas controls sit above the scaled node UI. Reserve
 * their edge bands so a visible model button cannot be covered by them. */
export function videoComposerUsableBounds(width:number,height:number,chrome:{side?:Bounds;bottom?:Bounds;top?:Bounds}={}):Bounds{
 const left=Math.max(12,chrome.side?chrome.side.right+12:12),top=Math.max(12,chrome.top?chrome.top.bottom+12:12),right=Math.max(left+1,width-12),bottom=Math.max(top+1,Math.min(height-12,chrome.bottom?chrome.bottom.top-12:height-12));
 return{left,right,top,bottom,width:Math.max(1,right-left),height:Math.max(1,bottom-top)};
}

/** Keep only this node's toolbar clear. Prefer a side that fits the full
 * composer, then the larger scrollable space, with the least movement as tie. */
export function videoComposerToolbarBounds(clamped:Bounds,area:Bounds,toolbar?:Bounds):Bounds{
 if(!toolbar||clamped.right<=toolbar.left||clamped.left>=toolbar.right||clamped.bottom<=toolbar.top||clamped.top>=toolbar.bottom)return area;
 const gap=12,aboveBottom=Math.max(area.top,Math.min(area.bottom,toolbar.top-gap)),belowTop=Math.min(area.bottom,Math.max(area.top,toolbar.bottom+gap));
 const above={...area,bottom:aboveBottom,height:aboveBottom-area.top},below={...area,top:belowTop,height:area.bottom-belowTop};
 const distance=(space:Bounds)=>Math.abs(Math.max(space.top,Math.min(clamped.top,space.bottom-Math.min(clamped.height,space.height)))-clamped.top);
 const choices=[above,below].filter(space=>space.height>0).sort((a,b)=>Number(b.height>=clamped.height)-Number(a.height>=clamped.height)||(a.height<clamped.height&&b.height<clamped.height?b.height-a.height:0)||distance(a)-distance(b));
 return choices[0]??area;
}

/** Choose where the selected picture's composer can be used without covering
 * the picture or its native toolbar. All coordinates here are screen pixels. */
export function imageComposerBounds(panel:Bounds, area:Bounds, picture:Bounds, toolbar?:Bounds):Bounds {
 const intersects = (a:Bounds, b:Bounds) =>
  a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
 if (!intersects(panel, picture) && (!toolbar || !intersects(panel, toolbar))) return area;

 const gap = 12;
 const left = Math.min(picture.left, toolbar?.left ?? picture.left);
 const top = Math.min(picture.top, toolbar?.top ?? picture.top);
 const right = Math.max(picture.right, toolbar?.right ?? picture.right);
 const bottom = Math.max(picture.bottom, toolbar?.bottom ?? picture.bottom);
 const bounds = (left:number, top:number, right:number, bottom:number):Bounds =>
  ({left, top, right, bottom, width:right-left, height:bottom-top});
 const above = bounds(area.left, area.top, area.right, Math.min(area.bottom, top-gap));
 const below = bounds(area.left, Math.max(area.top, bottom+gap), area.right, area.bottom);
 const sides = [
  below, above,
  bounds(area.left, area.top, Math.min(area.right, left-gap), area.bottom),
  bounds(Math.max(area.left, right+gap), area.top, area.right, area.bottom),
 ];
 const distance = (option:Bounds) => {
  const x = Math.max(option.left, Math.min(panel.left, option.right-panel.width));
  const y = Math.max(option.top, Math.min(panel.top, option.bottom-panel.height));
  return Math.hypot(x-panel.left, y-panel.top);
 };
 const full = sides.filter(side => side.width >= panel.width && side.height >= panel.height);
 if (full.length) return full.sort((a,b) => distance(a)-distance(b))[0];

 const vertical = above.height >= below.height ? above : below;
 if (vertical.height >= Math.min(136, area.height*.4)) return vertical;
 // The picture itself can fill a phone viewport. Reserve its upper part for
 // dragging and pin the actions in a short, scrollable panel at the bottom.
 const dockHeight = Math.min(area.height, Math.max(88, area.height*.38));
 return bounds(area.left, area.bottom-dockHeight, area.right, area.bottom);
}

function composerProfile(type:'video'|'image'){
 return {
  selector:`.config-panel-wrap.rh-canvas-compact-input-panel.rh-canvas-${type}-params[data-testid="canvas-${type}-params"][data-target-node-id]`,
  marker:`data-studio-${type}-composer-viewport`,scrollMarker:`data-studio-${type}-composer-scroll`,
  widthLimit:`--studio-${type}-composer-max-width`,heightLimit:`--studio-${type}-composer-max-height`,
 };
}
const video=composerProfile('video'),image=composerProfile('image');
const selector=[video.selector,image.selector].join(',');
interface Panel {profile:typeof video;translate:string;priority:string;localX:number;localY:number;written:string|null;marker:string|null;scroll:string|null;scrollWritten:string|null;basicMinHeight:number;limits:{name:string;value:string;priority:string;written:string|null}[]}

export const videoComposerViewportStyles=[video,image].map(({selector,marker,scrollMarker,widthLimit,heightLimit})=>`
 ${selector}[${marker}]{min-width:0!important;max-width:var(${widthLimit},calc(100vw - 24px))!important;min-height:0!important;max-height:var(${heightLimit},calc(100vh - 24px))!important;overflow:visible!important}
 ${selector}[${marker}]>.config-panel-wrap__basic{overflow:auto!important;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--canvas-border-default,#3a3a3a) transparent}
 ${selector}[${scrollMarker}="true"]>.config-panel-wrap__basic{flex:1 1 auto!important;height:auto!important;min-height:0!important}
 ${selector}[${scrollMarker}="true"]>.config-panel-wrap__basic>*{flex-shrink:0!important}
 ${selector}[${scrollMarker}="true"]>.config-panel-wrap__advanced{flex:0 1 auto!important;min-height:0!important;overflow:auto!important;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--canvas-border-default,#3a3a3a) transparent}
`).join('')+`
 ${image.selector}[${image.marker}] .rh-image-params-config-left{min-width:0;flex:1 1 0;overflow-x:auto;scrollbar-width:thin}
 ${image.selector}[${image.marker}] .rh-image-params-config-right{flex:0 0 auto}
 ${image.selector}[${image.scrollMarker}="true"] .rh-image-params-config-row{position:sticky;bottom:0;z-index:1;background:var(--canvas-bg-tertiary,#1f1f1f)}
 .rh-canvas-node.has-node-plus:has(.rh-node-fail-overlay)>.rh-node-shell-body>.rh-node-handle{z-index:13!important}
`;

function canvasScale(panel:HTMLElement,view:Window){
 const viewport=panel.closest<HTMLElement>('.react-flow__viewport'),transform=viewport&&(viewport.style.transform||view.getComputedStyle(viewport).transform)||'';
 const scale=transform.match(/scale\(\s*([-+\d.eE]+)/);if(scale){const value=Number(scale[1]);if(Number.isFinite(value)&&value>0)return value;}
 const matrix=transform.match(/^matrix(?:3d)?\(\s*([-+\d.eE]+)\s*,\s*([-+\d.eE]+)/);if(matrix){const value=Math.hypot(Number(matrix[1]),Number(matrix[2]));if(Number.isFinite(value)&&value>0)return value;}
 const inverse=Number.parseFloat(view.getComputedStyle(panel.closest('.rh-node-shell-body')!).getPropertyValue('--rh-node-ui-inverse-scale'));
 return Number.isFinite(inverse)&&inverse>0?1/inverse:1;
}

/** Placement must use the H3 scroller's intrinsic content, not the box already
 * shortened by the previous placement's inherited height limit. Otherwise a
 * short box fits below the toolbar, expands, overlaps it, and flips back. */
function expandedLongformHeight(panel:HTMLElement,view:Window,effectiveScale:number){
 const details=panel.querySelector<HTMLElement>('[data-studio-longform-host].studio-longform-host-open>[data-studio-h3-longform][open]'),content=details?.querySelector<HTMLElement>('.studio-longform-content'),summary=details?.querySelector<HTMLElement>(':scope>summary');if(!details||!content||!summary)return;
 const pixels=(css:CSSStyleDeclaration,...names:string[])=>names.reduce((total,name)=>total+(Number.parseFloat(css.getPropertyValue(name))||0),0),detailCss=view.getComputedStyle(details),contentCss=view.getComputedStyle(content),summaryCss=view.getComputedStyle(summary);
 const preferred=Math.min(view.innerHeight*(view.innerWidth<=600?.58:.66),Math.max(0,view.innerHeight-60)),body=Math.min(content.scrollHeight,preferred+pixels(contentCss,'padding-top','padding-bottom'))+pixels(contentCss,'border-top-width','border-bottom-width');
 const chrome=Math.max(summary.getBoundingClientRect().height/effectiveScale,Number.parseFloat(summaryCss.minHeight)||0)+pixels(detailCss,'padding-top','padding-bottom','border-top-width','border-bottom-width');
 return (body+chrome)*effectiveScale;
}

/** Fit the native image and video composers. Its model cascade is portalled
 * into the outer wrap, so scrolling belongs to basic/advanced content siblings,
 * never to that portal host. Native transforms, graph anchors and callbacks stay
 * intact, including at zoom levels where native inverse scale is capped. */
export function installCanvasComposerViewport(root:Document=document){
 const view=root.defaultView;if(!view||!root.body||typeof MutationObserver==='undefined')return()=>{};
 const style=root.createElement('style');style.id='studio-canvas-composer-viewport';style.textContent=videoComposerViewportStyles;root.head.append(style);
 const panels=new Map<HTMLElement,Panel>();let disposed=false,scheduled=false;
 const restore=(panel:HTMLElement,state:Panel)=>{
  const {marker,scrollMarker}=state.profile;
  if(state.written!==null&&panel.style.getPropertyValue('translate')===state.written){if(state.translate)panel.style.setProperty('translate',state.translate,state.priority);else panel.style.removeProperty('translate');}
  for(const limit of state.limits)if(panel.style.getPropertyValue(limit.name)===limit.written){if(limit.value)panel.style.setProperty(limit.name,limit.value,limit.priority);else panel.style.removeProperty(limit.name);}
  if(panel.getAttribute(marker)==='true'){if(state.marker===null)panel.removeAttribute(marker);else panel.setAttribute(marker,state.marker);}
  if(panel.getAttribute(scrollMarker)===state.scrollWritten){if(state.scroll===null)panel.removeAttribute(scrollMarker);else panel.setAttribute(scrollMarker,state.scroll);}
  resize?.unobserve(panel);for(const child of panel.children)resize?.unobserve(child);panels.delete(panel);
 };
 const refresh=()=>{
  scheduled=false;if(disposed)return;const active=new Set<HTMLElement>();
  const visibleBounds=(selector:string)=>{for(const element of root.querySelectorAll<HTMLElement>(selector)){const css=view.getComputedStyle(element),rect=element.getBoundingClientRect();if(css.display!=='none'&&css.visibility!=='hidden'&&rect.width>0&&rect.height>0&&rect.right>0&&rect.bottom>0&&rect.left<view.innerWidth&&rect.top<view.innerHeight){resize?.observe(element);return rect;}}};
  const area=videoComposerUsableBounds(view.innerWidth,view.innerHeight,{side:visibleBounds('.canvas-toolbar'),bottom:visibleBounds('.canvas-bottom-controls-row,.canvas-bottom-pill'),top:visibleBounds('.canvas-editor-logo')});
  for(const panel of root.querySelectorAll<HTMLElement>(selector)){
   const profile=panel.matches(image.selector)?image:video;
   const {marker,scrollMarker,widthLimit,heightLimit}=profile;
   const shell=panel.closest<HTMLElement>('.rh-node-shell-body'),node=shell?.closest<HTMLElement>('.react-flow__node[data-id]');
   if(!node||node.getAttribute('data-id')!==panel.getAttribute('data-target-node-id'))continue;
   const computed=view.getComputedStyle(panel);if(computed.display==='none'||computed.visibility==='hidden')continue;
   let rect=panel.getBoundingClientRect();if(!rect.width||!rect.height)continue;
   active.add(panel);let state=panels.get(panel);
   if(!state){
    const translate=panel.style.getPropertyValue('translate');if(translate&&translate!=='none')continue;
    state={profile,translate,priority:panel.style.getPropertyPriority('translate'),localX:0,localY:0,written:null,marker:panel.getAttribute(marker),scroll:panel.getAttribute(scrollMarker),scrollWritten:panel.getAttribute(scrollMarker),basicMinHeight:Number.parseFloat(view.getComputedStyle(panel.querySelector('.config-panel-wrap__basic')??panel).minHeight)||0,limits:[widthLimit,heightLimit].map(name=>({name,value:panel.style.getPropertyValue(name),priority:panel.style.getPropertyPriority(name),written:null}))};panels.set(panel,state);panel.setAttribute(marker,'true');resize?.observe(panel);
   }
   // Ignore the outer wrap's portal children when measuring natural content.
   // A model flyout must not turn its own host into a clipped scrolling box.
   const content=[...panel.children].filter((child):child is HTMLElement=>child instanceof view.HTMLElement&&child.matches('.config-panel-wrap__basic,.config-panel-wrap__advanced'));
   const scale=canvasScale(panel,view),inverse=Number.parseFloat(view.getComputedStyle(shell!).getPropertyValue('--rh-node-ui-inverse-scale'))||1,effectiveScale=scale*inverse;
   const writeLimit=(index:number,pixels:number)=>{const limit=state!.limits[index],value=pixels/effectiveScale+'px';if(panel.style.getPropertyValue(limit.name)!==value)panel.style.setProperty(limit.name,value);limit.written=panel.style.getPropertyValue(limit.name);};
   writeLimit(0,area.width);
   // Retain the native minimum in this measurement after the scroll variant
   // removes it; otherwise a short viewport could toggle variants every frame.
   const contentHeight=content.reduce((height,child)=>{resize?.observe(child);const css=view.getComputedStyle(child);return height+Math.max(child.scrollHeight,child.getBoundingClientRect().height/effectiveScale,child.matches('.config-panel-wrap__basic')?state!.basicMinHeight:0)+(Number.parseFloat(css.marginTop)||0)+(Number.parseFloat(css.marginBottom)||0);},0)*effectiveScale;
   const policyInputHeight=(profile===video?expandedLongformHeight(panel,view,effectiveScale):undefined)??contentHeight;
   rect=panel.getBoundingClientRect();const x=state.localX*scale,y=state.localY*scale,naturalHeight=Math.min(policyInputHeight||rect.height,area.height);
   const natural={left:rect.left-x,right:rect.right-x,top:rect.top-y,bottom:rect.top-y+naturalHeight,width:rect.width,height:naturalHeight},globalShift=videoComposerViewportShift(natural,view.innerWidth,view.innerHeight,area);
   const clamped={...natural,left:natural.left+globalShift.x,right:natural.right+globalShift.x,top:natural.top+globalShift.y,bottom:natural.bottom+globalShift.y};
   const toolbarSelector=profile===image?'.rh-canvas-image-toolbar':'.rh-canvas-video-toolbar';
   const toolbar=[...node.querySelectorAll<HTMLElement>(toolbarSelector)].map(element=>{
    if(element.closest('.react-flow__node[data-id]')!==node)return;
    const css=view.getComputedStyle(element),bounds=element.getBoundingClientRect();
    if(css.display==='none'||css.visibility==='hidden'||Number.parseFloat(css.opacity)===0||bounds.width<=0||bounds.height<=0||bounds.right<=0||bounds.bottom<=0||bounds.left>=view.innerWidth||bounds.top>=view.innerHeight)return;
    resize?.observe(element);return bounds;
   }).find((bounds):bounds is DOMRect=>!!bounds&&(profile===image||clamped.right>bounds.left&&clamped.left<bounds.right&&clamped.bottom>bounds.top&&clamped.top<bounds.bottom));
   const placement=profile===image
    ? imageComposerBounds(clamped,area,node.getBoundingClientRect(),toolbar)
    : videoComposerToolbarBounds(clamped,area,toolbar);
   writeLimit(1,placement.height);
   const scroll=policyInputHeight>placement.height+.5;
   if(scroll&&panel.getAttribute(scrollMarker)!=='true')panel.setAttribute(scrollMarker,'true');else if(!scroll&&panel.hasAttribute(scrollMarker))panel.removeAttribute(scrollMarker);
   state.scrollWritten=panel.getAttribute(scrollMarker);
   rect=panel.getBoundingClientRect();
   const shift=videoComposerViewportShift({left:rect.left-x,right:rect.right-x,top:rect.top-y,bottom:rect.bottom-y,width:rect.width,height:rect.height},view.innerWidth,view.innerHeight,placement);
   state.localX=shift.x/scale;state.localY=shift.y/scale;
   const prior=panel.style.getPropertyValue('translate').trim().split(/\s+/).map(Number.parseFloat);
   if(prior.length!==2||Math.abs(prior[0]-state.localX)>.001||Math.abs(prior[1]-state.localY)>.001||panel.style.getPropertyPriority('translate')!=='important')panel.style.setProperty('translate',`${state.localX}px ${state.localY}px`,'important');
   state.written=panel.style.getPropertyValue('translate');const written=state.written.trim().split(/\s+/).map(Number.parseFloat);if(written.length===2&&written.every(Number.isFinite)){state.localX=written[0];state.localY=written[1];}
  }
  for(const [panel,state]of panels)if(!active.has(panel))restore(panel,state);
 };
 const schedule=()=>{if(!disposed&&!scheduled){scheduled=true;view.requestAnimationFrame(refresh);}};
 const resize=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(schedule);
 const observer=new MutationObserver(schedule);observer.observe(root.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','style','data-target-node-id']});
 view.addEventListener('resize',schedule);view.addEventListener('scroll',schedule,true);refresh();
 return()=>{disposed=true;observer.disconnect();resize?.disconnect();view.removeEventListener('resize',schedule);view.removeEventListener('scroll',schedule,true);for(const [panel,state]of panels)restore(panel,state);style.remove();};
}

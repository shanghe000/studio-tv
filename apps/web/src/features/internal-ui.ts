import type {Features,Feature} from './policy';
import {blockedRoute,externalNavigationFeature,controlFeature,disabledFeature,INTERNAL_FEATURE_MESSAGE} from './policy';
import {billingUiStyles,decorateBillingUi} from './billing-ui';
import {internalGenerationStyles,decorateGenerationActions} from './generation-labels';
import {installPausedEntries} from './paused-entries';
import {hyperframesEntryStyles} from './hyperframes-entry';
const styles=`
 ${hyperframesEntryStyles}
 [data-rhtv-feature-disabled]{display:none!important}
 body[data-rhtv-community="false"] .glass-navbar__slot:has(a[href^="/projects/canvas/camp"]),
 body[data-rhtv-community="false"] .glass-navbar__slot:has(a[href^="/projects/canvas/recommend"]),
 body[data-rhtv-community="false"] .home-inspirations,
 body[data-rhtv-community="false"] .home-inspiration-feed,
 body[data-rhtv-community="false"] .project-home-showcase{display:none!important}
 body[data-rhtv-marketing="false"] .home-activity-section,
 body[data-rhtv-marketing="false"] .home-activity-carousel,
 body[data-rhtv-marketing="false"] .home-highlights-track,
 body[data-rhtv-marketing="false"] [aria-labelledby="home-highlights-title"]{display:none!important}
 ${billingUiStyles}
 ${internalGenerationStyles}
 body[data-rhtv-public-sharing="false"] .share-btn,
 body[data-rhtv-public-sharing="false"] .canvas-share-popover,
 body[data-rhtv-public-sharing="false"] .rh-share-popover,
 body[data-rhtv-public-sharing="false"] .rh-publish-work-modal,
 body[data-rhtv-public-sharing="false"] .rh-publish-workflow-modal,
 body[data-rhtv-public-sharing="false"] .rh-canvas-workflow__item-mask-btn--publish,
 body[data-rhtv-public-sharing="false"] .viral-remix-share-menu{display:none!important}
 body[data-rhtv-external-links="false"] .canvas-main-site-entry,
 body[data-rhtv-external-links="false"] .qqMsgBox,
 body[data-rhtv-external-links="false"] .nh-team-switch-card,
 body[data-rhtv-external-links="false"] .nh-action-btn--primary,
 body[data-rhtv-external-links="false"] .project-home-footer{display:none!important}
 #rhtv-feature-blocked{position:fixed;inset:0;z-index:200000;display:flex;align-items:center;justify-content:center;background:#111;color:#eee;font:14px system-ui}
 #rhtv-feature-blocked section{max-width:360px;padding:32px;border:1px solid #333;border-radius:16px;background:#191919;text-align:center}
 #rhtv-feature-blocked h1{font-size:20px;margin:0 0 12px}
 #rhtv-feature-blocked p{color:#aaa;line-height:1.6;margin:0 0 24px}
 #rhtv-feature-blocked button{padding:10px 20px;border:0;border-radius:8px;background:var(--studio-primary,#725e8f);color:#eee9f2;cursor:pointer;font:inherit}
`;
export function installFeatureUi(features:Features,notice:(text:string)=>void){
 const pausedEntries=installPausedEntries(notice);
 const names:Record<Feature,string>={community:'community',billing:'billing',publicSharing:'public-sharing',marketing:'marketing',externalLinks:'external-links'};
 for(const [feature,name]of Object.entries(names))document.body.setAttribute('data-rhtv-'+name,String(features[feature as Feature]));
 const style=document.createElement('style');style.id='rhtv-feature-styles';style.textContent=styles;document.head.append(style);
 const mark=(element:Element)=>{
  const candidate=element.closest('a,button,[role="menuitem"],[role="button"]');
  if(!candidate)return;
  if(candidate.closest('[data-studio-collaboration]')){candidate.removeAttribute('data-rhtv-feature-disabled');return;}
  let blocked:Feature|null=null;
  if(candidate instanceof HTMLAnchorElement){try{const url=new URL(candidate.href,location.href);blocked=blockedRoute(url,features)||disabledFeature(externalNavigationFeature(url,location.origin),features);}catch{}}
  if(!blocked){const label=candidate.getAttribute('aria-label')||candidate.getAttribute('title')||candidate.textContent||'';blocked=disabledFeature(controlFeature(label),features);}
  const slot=candidate.closest('.glass-navbar__slot');
  if(blocked){candidate.setAttribute('data-rhtv-feature-disabled',blocked);slot?.setAttribute('data-rhtv-feature-disabled',blocked);}
  else{candidate.removeAttribute('data-rhtv-feature-disabled');slot?.removeAttribute('data-rhtv-feature-disabled');}
 };
 const decorate=(root:Element)=>{decorateBillingUi(root,features.billing);decorateGenerationActions(root,features.billing);};
 const inspect=(root:Element)=>{mark(root);root.querySelectorAll('a,button,[role="menuitem"],[role="button"]').forEach(mark);decorate(root);};
 inspect(document.body);
 const observer=new MutationObserver(records=>{for(const record of records){const target=record.target instanceof Element?record.target:record.target.parentElement;if(target){mark(target);decorate(target);}for(const node of record.addedNodes)if(node instanceof Element)inspect(node);}});
 observer.observe(document.body,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['href','title','aria-label','class']});
 document.addEventListener('click',event=>{const target=event.target instanceof Element?event.target.closest('[data-rhtv-feature-disabled],a'):null;if(!target)return;let blocked=target.getAttribute('data-rhtv-feature-disabled');if(target instanceof HTMLAnchorElement){try{const url=new URL(target.href,location.href);blocked||=blockedRoute(url,features)||disabledFeature(externalNavigationFeature(url,location.origin),features);}catch{}}if(blocked){event.preventDefault();event.stopImmediatePropagation();notice(INTERNAL_FEATURE_MESSAGE);}},true);
 const open=window.open.bind(window);
 window.open=((url?:string|URL,target?:string,windowFeatures?:string)=>{if(url){const value=new URL(String(url),location.href);if(blockedRoute(value,features)||disabledFeature(externalNavigationFeature(value,location.origin),features)){notice(INTERNAL_FEATURE_MESSAGE);return null;}}return open(url,target,windowFeatures);}) as typeof window.open;
 const routeCheck=()=>{
  const feature=blockedRoute(new URL(location.href),features),existing=document.getElementById('rhtv-feature-blocked');
  if(!feature){existing?.remove();return false;}if(existing)return true;
  const overlay=document.createElement('aside');overlay.id='rhtv-feature-blocked';overlay.setAttribute('role','alert');
  const panel=document.createElement('section'),title=document.createElement('h1'),text=document.createElement('p'),button=document.createElement('button');title.textContent='此功能未启用';text.textContent=INTERNAL_FEATURE_MESSAGE;button.textContent='返回项目';button.onclick=()=>location.assign('/projects/');panel.append(title,text,button);overlay.append(panel);document.body.append(overlay);return true;
 };
 for(const method of ['pushState','replaceState']as const){const original=history[method].bind(history);history[method]=((data:any,unused:string,url?:string|URL|null)=>{const result=original(data,unused,url);queueMicrotask(routeCheck);return result;}) as History[typeof method];}
 window.addEventListener('popstate',routeCheck);window.addEventListener('hashchange',routeCheck);
 return{blocked:routeCheck(),routeCheck,disconnect:()=>{observer.disconnect();pausedEntries();}};
}

/** Keep the maintained guide reachable without changing the native application bundle. */
export function installUserGuideEntry(){
 const update=()=>{
  for(const menu of document.querySelectorAll('.canvas-page-header.is-home .glass-navbar__items')){
   if(menu.querySelector('[data-studio-user-guide]'))continue;
   const slot=document.createElement('span'),link=document.createElement('a');
   slot.className='glass-navbar__slot';slot.dataset.studioUserGuide='';
   link.className='glass-navbar__item';link.dataset.active='false';
   link.href='/guide/';link.target='_blank';link.rel='noopener noreferrer';
   link.textContent='使用指南';link.title='使用指南（新标签页打开）';
   slot.append(link);
   const assets=menu.querySelector('a[href="/projects/canvas/assetLibrary"]')?.closest('.glass-navbar__slot');
   if(assets)assets.after(slot);else menu.append(slot);
  }
 };
 const observer=new MutationObserver(update);
 observer.observe(document.body,{subtree:true,childList:true});
 update();
 return()=>{observer.disconnect();document.querySelectorAll('[data-studio-user-guide]').forEach(slot=>slot.remove());};
}

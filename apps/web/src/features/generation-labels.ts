// Internal execution has no user-facing price. Keep the native semantic button
// and callback, and put its action name into the space previously used by price.
const actionSelector='.generate-btn-container .generate-action-button,.run-price-btn';
const labelAttribute='data-studio-action-label';
const containerAttribute='data-studio-action-container';
const busyLabels:Record<string,string>={
 '生成':'生成中…','运行':'运行中…','執行':'執行中…','生成する':'生成中…',
 'Generate':'Generating…','Run':'Running…','생성':'생성 중…','실행':'실행 중…',
};

export function internalGenerationLabel(label:string,busy:boolean):string {
 const value=label.trim();
 // Cancel, retry and specialised actions retain their actual native meaning.
 return busy?(busyLabels[value]??value):value;
}

export function decorateGenerationActions(root:Element,billingEnabled:boolean){
 if(billingEnabled)return;
 const own=root.closest(actionSelector);
 for(const element of new Set([...(own?[own]:[]),...root.querySelectorAll(actionSelector)])){
  if(element.closest('.home-agent-input-bar'))continue;
  const label=element.getAttribute('aria-label')?.trim();
  if(!label)continue;
  const busy=!!element.querySelector('.rh-loading,.ant-spin,.btn-loading,.home-send-loading');
  const text=internalGenerationLabel(label,busy);
  if(element.getAttribute(labelAttribute)!==text)element.setAttribute(labelAttribute,text);
  const container=element.closest('.generate-btn-container');
  if(container&&!container.hasAttribute(containerAttribute))container.setAttribute(containerAttribute,'');
 }
}

export const internalGenerationStyles=`
 /* Compact image/text/video cards own stronger frozen rules and token-billing
    widths. Override only annotated internal actions, never generic buttons. */
 body[data-rhtv-billing="false"] .generate-btn-container[data-studio-action-container]{width:max-content!important;min-width:0!important;max-width:none!important;padding:4px!important;gap:0!important;height:38px!important;min-height:38px!important;border-radius:999px!important;overflow:visible!important}
 body[data-rhtv-billing="false"] .generate-btn-container .generate-action-button[data-studio-action-label]{position:static!important;display:flex!important;align-items:center!important;flex:0 0 auto!important;width:auto!important;min-width:96px!important;height:30px!important;padding:0 12px 0 0!important;gap:10px!important;border-radius:999px!important;background:transparent!important;color:#fff!important;box-shadow:none!important}
 body[data-rhtv-billing="false"] .generate-action-button[data-studio-action-label]::after,
 body[data-rhtv-billing="false"] .run-price-btn[data-studio-action-label]::after{content:attr(data-studio-action-label);font-size:12px;font-weight:500;line-height:18px;white-space:nowrap;pointer-events:none}
 body[data-rhtv-billing="false"] .generate-btn-container .generate-action-button[data-studio-action-label] .btn-arrow{box-sizing:border-box;width:30px!important;height:30px!important;padding:3px;border-radius:50%;background:#fff;color:#000}
 body[data-rhtv-billing="false"] .run-price-btn[data-studio-action-label]{min-width:96px;padding:4px 12px 4px 4px}
 body[data-rhtv-billing="false"] .run-price-btn[data-studio-action-label] .run-price-btn__meta{display:none}
 body[data-rhtv-billing="false"] .generate-action-button[data-studio-action-label]:focus-visible,
 body[data-rhtv-billing="false"] .run-price-btn[data-studio-action-label]:focus-visible{outline:2px solid #fff;outline-offset:4px}
 @media (prefers-reduced-motion:reduce){
  body[data-rhtv-billing="false"] .generate-btn-container[data-studio-action-container],
  body[data-rhtv-billing="false"] .run-price-btn[data-studio-action-label]{transition:none!important;transform:none!important}
 }
`;

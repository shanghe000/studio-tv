// These are billing leaves in the immutable native components. Never target a
// generator's container/action, generic "token" classes, or user-authored text.
const billingDisplays=[
 '.rh-coin-balance','.wallet-item','.nh-vip-card','.nh-balance-card',
 '.nh-balance-divider','.nh-vip-btn','.nh-balance-recharge','.nh-balance-alert',
 '.balance-alert-popover','.balance-alert-tooltip','.canvas-ai-pay-modal-wrap',
 '.balance-alert-modal-wrap','.canvas-vip-dialog','.canvas-ai-pay',
 '.canvas-ai-payment-modal','.canvas-ai-payment-mobile','.canvas-cn-payment-mobile',
 '.canvas-ai-payment-result-modal','.canvas-ai-cancel-subscription-modal','.canvas-plan-modal',
 '.home-price-tag','.home-price-tip-trigger','.home-token-price-tip','.home-token-price-tip-overlay',
 '.cost-display','.generate-btn-cost-tip-trigger','.generate-token-price-tip','.generate-price-skeleton','.generate-price-tip-icon',
 '.llm-token-billing-trigger','.llm-token-billing-popover',
 '.ap-price-tag','.ap-send-cost','.canvas-ai-app-params__price',
 '.hf-chat__send-badge','.hf-user-menu__balances',
 '.llm-card__billing-note','.llm-card__price-unit','.llm-card__price-grid',
 '.llm-card__cache-price','.llm-card__tier-price','.llm-card__price-panel',
 '.llm-price-unit-toggle','.llm-params__kv:has(.llm-params__value--price)',
 '.llm-params__cache','.llm-search-options__estimate',
 '.model-item-points','.points-cost-display','.size-points','.card-price-hint',
 '.token-billing-display','.token-billing-tooltip','.token-billing-tooltip__content','.canvas-points-cost',
 '.canvas-points-display','.canvas-points-remaining','.qc-editor-generate__price',
 '.run-price-btn__amount-group','.run-price-btn__currency','.run-price-btn__pricing-tip',
 '.run-price-btn__dynamic-billing','.run-price-btn__free-tag','.run-price-btn__free-count',
 '.run-price-btn__price:not(.is-placeholder):not(.run-price-btn__action-text)',
 '.run-price-tip','.run-price-detail-modal',
 '.ai-tip-content:has(.model-price-list)',
 '.rh-image-enhance-card__price-hint','.rh-video-params-card__price-hint',
 '.rh-prompt-enhance-menu__price-tip','[data-testid="prompt-enhance-model-price"]',
 '.rh-style-create__billing-info','.director-recognize-price-action__tip',
 '.sketch-studio__wallet','.sketch-studio__generation-cost','.sketch-studio__preview-empty-free',
 '.mg-cascade__member-badge','.mg-cascade__promo-badge',
 // Standalone billing leaves can outlive their price wrappers during rerenders.
 // run-price-btn__icon is the execution arrow, not a currency icon: retain it.
 '.home-price-icon','.home-price-value','.home-price-free-tag','.home-price-free-count',
 '.ap-price-icon','.ap-price-value','.ap-price-free-tag','.ap-price-free-count',
 '.cost-icon','.cost-value','.cost-display .free-tag','.cost-display .free-count',
 '.rh-prompt-enhance-menu__price-skeleton','.rh-prompt-enhance-menu__price--loading',
 '.script-table-entity-batch-btn__price','.storyboard-entity-batch-bar__generate-price',
 '.storyboard-fullscreen-step-bar__action-price','.xyq-setup-drawer__price',
 '.xyq-setup-edit__price','.xyq-studio__generate-price','.xyq-dialog__credit',
 '.xyq-studio__clip-head > small',
 // Hide each billing modal's portal root too, so its mask cannot block the editor.
 '.ant-modal-root:has(.canvas-vip-dialog)',
 '.ant-modal-root:has(.canvas-ai-payment-modal)',
 '.ant-modal-root:has(.canvas-ai-payment-result-modal)',
 '.ant-modal-root:has(.canvas-ai-cancel-subscription-modal)',
 '.ant-modal-root:has(.canvas-plan-modal)',
 '.ant-modal-root:has(.run-price-detail-modal)',
];
export const billingUiStyles=billingDisplays.map(selector=>`body[data-rhtv-billing="false"] ${selector}`).join(',\n')+'{display:none!important}';

// This native modal is also used for deleting styles and other confirmations.
// Only its exact built-in fee sentences are changed; user text is untouched.
const cancellationMessages=new Map<string,string>([
 ['Generation in progress. Stopping will not refund the credits already consumed.','Generation in progress.'],
 ['生成中です。停止しても、すでに消費したクレジットは返金されません。','生成中です。'],
 ['생성 중입니다. 중지해도 이미 소모된 크레딧은 환불되지 않습니다.','생성 중입니다.'],
 ['正在生成中，停止将不退还已消耗钱包。','正在生成中。'],
 ['Generation in progress. After cancelling, your request will keep running in the background and can be viewed later in History. Already consumed credits will not be refunded.','Generation in progress. After cancelling, your request will keep running in the background and can be viewed later in History.'],
 ['生成中です。キャンセル後もリクエストはバックグラウンドで続き、後から履歴で確認できます。すでに消費したクレジットは返金されません。','生成中です。キャンセル後もリクエストはバックグラウンドで続き、後から履歴で確認できます。'],
 ['생성 중입니다. 취소한 후에도 요청은 백그라운드에서 계속 실행되며 나중에 기록에서 확인할 수 있습니다. 이미 소모된 크레딧은 환불되지 않습니다.','생성 중입니다. 취소한 후에도 요청은 백그라운드에서 계속 실행되며 나중에 기록에서 확인할 수 있습니다.'],
 ['正在生成中。取消后，您的生成请求仍将在后台运行，可在历史记录中查看。已消耗费用不予退还。','正在生成中。取消后，您的生成请求仍将在后台运行，可在历史记录中查看。'],
 ['If you cancel now, credits already deducted for this run will not be refunded.','Cancel the current generation?'],
 ['今キャンセルすると、この実行ですでに差し引かれたクレジットは返金されません。','現在の生成をキャンセルしますか？'],
 ['지금 취소하면 이번 실행에서 이미 차감된 크레딧은 환불되지 않습니다.','현재 생성을 취소할까요?'],
 ['当前状态下取消任务，将不返还创作所扣除的金额。','确认取消当前生成任务？'],
]);
export function billingCancellationText(text:string):string{return cancellationMessages.get(text)??text;}

export function decorateBillingUi(root:Element,billingEnabled:boolean){
 if(billingEnabled)return;
 const selector='.rh-modal-confirm-cancel-generation .ant-modal-confirm-content';
 const ancestor=root.closest(selector);
 for(const content of new Set([...(ancestor?[ancestor]:[]),...root.querySelectorAll(selector)])){
  const old=content.textContent||'',next=billingCancellationText(old);if(old===next)continue;
  const walker=document.createTreeWalker(content,NodeFilter.SHOW_TEXT);let node:Node|null;
  while((node=walker.nextNode()))if(node.textContent===old){node.textContent=next;break;}
 }
}

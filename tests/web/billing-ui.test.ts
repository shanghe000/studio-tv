import {afterEach,describe,expect,it,vi} from 'vitest';
import {billingCancellationText,decorateBillingUi,billingUiStyles} from '../../apps/web/src/features/billing-ui';
afterEach(()=>vi.unstubAllGlobals());

describe('billing display boundaries',()=>{
 it('retains the actual background-generation behavior in cancellation confirmation',()=>{
  expect(billingCancellationText('正在生成中。取消后，您的生成请求仍将在后台运行，可在历史记录中查看。已消耗费用不予退还。')).toBe('正在生成中。取消后，您的生成请求仍将在后台运行，可在历史记录中查看。');
  expect(billingCancellationText('Generation in progress. Stopping will not refund the credits already consumed.')).toBe('Generation in progress.');
  expect(billingCancellationText('当前状态下取消任务，将不返还创作所扣除的金额。')).toBe('确认取消当前生成任务？');
  for(const userText of ['删除风格“钱包与积分的故事”？','生成 10 个有积分颜色的角色','Already consumed credits will not be refunded. This is the character’s dialogue.','输入 Token 100 / 输出 Token 80 / 上下文 32K'])expect(billingCancellationText(userText)).toBe(userText);
 });
 it('rewrites only the built-in message node in the known cancellation modal and leaves external billing enabled',()=>{
  const text={textContent:'正在生成中，停止将不退还已消耗钱包。'},content={get textContent(){return text.textContent;}};
  const node={closest:vi.fn(()=>content),querySelectorAll:vi.fn(()=>[])} as any;
  vi.stubGlobal('NodeFilter',{SHOW_TEXT:4});vi.stubGlobal('document',{createTreeWalker:vi.fn(()=>{let visited=false;return{nextNode:()=>visited?null:(visited=true,text)};})});
  decorateBillingUi(node,true);expect(text.textContent).toBe('正在生成中，停止将不退还已消耗钱包。');
  decorateBillingUi(node,false);expect(text.textContent).toBe('正在生成中。');expect(node.closest).toHaveBeenCalledWith('.rh-modal-confirm-cancel-generation .ant-modal-confirm-content');
  text.textContent='删除风格“钱包与积分的故事”？';decorateBillingUi(node,false);expect(text.textContent).toBe('删除风格“钱包与积分的故事”？');
 });
 it('covers native price leaves while leaving generation actions, model names and token context visible',()=>{
  for(const leaf of ['.cost-display','.generate-price-skeleton','.hf-chat__send-badge','.llm-card__price-panel','.points-cost-display','.rh-prompt-enhance-menu__price-tip','.script-table-entity-batch-btn__price','.xyq-dialog__credit'])expect(billingUiStyles).toContain(`body[data-rhtv-billing="false"] ${leaf}`);
  for(const action of ['.run-price-btn,','.ap-send-btn,','.hf-chat__send,','.llm-msg__usage,','.llm-card__model-name,','.rh-modal-confirm-cancel-generation .ant-modal-confirm-content'])expect(billingUiStyles).not.toContain(action);
  expect(billingUiStyles).toContain('.run-price-btn__price:not(.is-placeholder):not(.run-price-btn__action-text)');
 });
});

// @vitest-environment happy-dom
import {afterEach,expect,it} from 'vitest';
import {billingUiStyles} from '../../apps/web/src/features/billing-ui';
afterEach(()=>{document.body.innerHTML='';document.body.removeAttribute('data-rhtv-billing');document.head.innerHTML='';});
it('hides native billing leaves including icons while retaining board tools and user content',()=>{
 document.body.setAttribute('data-rhtv-billing','false');
 const style=document.createElement('style');style.textContent=billingUiStyles;document.head.append(style);
 document.body.innerHTML='<div class="sketch-studio__preview-empty-meta"><svg class="clock"></svg><span>平均生成时间 4–6s</span><span class="sketch-studio__preview-empty-free">限时免费</span></div><div class="sketch-studio__generation-submit"><span class="sketch-studio__generation-cost">价格暂不可用</span><button class="sketch-studio__send">生成画面<svg></svg></button></div><span class="mg-cascade__member-badge">VIP</span><span class="mg-cascade__promo-badge">免费</span><svg class="home-price-icon"></svg><img class="ap-price-icon"><button class="run-price-btn"><svg class="run-price-btn__icon"></svg></button><div contenteditable="true">我想画一个限时免费的广告，带积分和会员图标</div><button>保存工程</button>';
 for(const cls of ['sketch-studio__preview-empty-free','sketch-studio__generation-cost','mg-cascade__member-badge','mg-cascade__promo-badge','home-price-icon','ap-price-icon'])expect(getComputedStyle(document.querySelector('.'+cls)!).display).toBe('none');
 for(const selector of ['.clock','.sketch-studio__send','.sketch-studio__send svg','.run-price-btn','.run-price-btn__icon','[contenteditable]','button:last-child'])expect(getComputedStyle(document.querySelector(selector)!).display).not.toBe('none');
 expect(document.querySelector('[contenteditable]')!.textContent).toBe('我想画一个限时免费的广告，带积分和会员图标');
});
it('leaves billing visible when enabled at startup',()=>{
 document.body.setAttribute('data-rhtv-billing','true');
 const style=document.createElement('style');style.textContent=billingUiStyles;document.head.append(style);
 document.body.innerHTML='<span class="sketch-studio__preview-empty-free">限时免费</span>';
 expect(getComputedStyle(document.querySelector('.sketch-studio__preview-empty-free')!).display).not.toBe('none');
});

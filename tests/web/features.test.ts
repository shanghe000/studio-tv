import {describe,it,expect,vi} from 'vitest';
import {resolveFeatures,blockedApi,apiFeature,routeFeature,disabledFeature,blockedRoute,controlFeature,externalNavigationFeature} from '../../apps/web/src/features/policy';
import {ApiClient} from '../../apps/web/src/api/client';
describe('internal product policy',()=>{
 it('defaults to internal, can restore external and selectively override features',()=>{
  expect(Object.values(resolveFeatures())).toEqual([false,false,false,false,false]);
  expect(Object.values(resolveFeatures('external'))).toEqual([true,true,true,true,true]);
  expect(resolveFeatures('internal',{publicSharing:true}).publicSharing).toBe(true);
  expect(resolveFeatures('internal',{billing:true}).billing).toBe(false);
  expect(resolveFeatures('external',{billing:false}).billing).toBe(false);
  expect(resolveFeatures('external',{billing:true}).billing).toBe(true);
  expect(blockedApi('/canvas/community/composition/publish',resolveFeatures('internal',{community:true}))).toBe('publicSharing');
  expect(blockedApi('/canvas/community/composition/publish',resolveFeatures('internal',{publicSharing:true}))).toBe('community');
  expect(()=>resolveFeatures('internal',{community:'true' as any})).toThrow('configuration');
 });
 it('blocks public routes and calls without blocking projects, assets and editor APIs',()=>{
  for(const path of ['/projects/canvas/camp','/projects/canvas/recommend','/projects/remix/12','/camp/view/123','/buy-history','/pricing','/vip-rights/2','/projects/subscriptions'])expect(routeFeature(path)).not.toBeNull();
  for(const path of ['/projects/','/projects/canvas','/projects/canvas/me','/projects/canvas/assetLibrary','/projects/skill','/project/canvas/p','/opencut/index.html','/labs/rhhyperframes'])expect(routeFeature(path)).toBeNull();
  for(const path of ['/canvas/community/composition/list','/canvas/share/link','/canvas/workflow/publish','/api/product/v2/list','/pay/createOrder','/api/v1/projects/p/share-links','/api/v1/wallet','/api/v1/orders','/api/member/plan-swap/execute','/uc/team/membership/products','/canvas/incentive/activity/register','/canvas/common-workflow/submit','/canvas/skill/publish'])expect(disabledFeature(apiFeature(path),resolveFeatures())).not.toBeNull();
  for(const path of ['/canvas/create','/canvas/rename','/canvas/asset/user/folder/create','/api/v1/projects/p/snapshot','/api/v1/asset-uploads','/api/v1/assets/a','/canvas/task/run','/canvas/model/list'])expect(apiFeature(path)).toBeNull();
 });
 it('blocks native billing estimates and account alerts even when internal billing is overridden',()=>{
  const features=resolveFeatures('internal',{billing:true});
  for(const path of ['/canvas/price/calculate','/canvas/price/estimate','/canvas/price/llm-sku-price','/api/area/price/calculate','/api/area/price/factor/detail','/api/workflow/webapp-price-estimate','/api/balanceAlert/get','/api/balanceAlert/set','/api/v1/generation-quotes','/api/v1/generation-quotes/q','/api/v1/generations/quote','/api/v1/generations/g/quote','/api/v1/generations/g/confirm'])expect(blockedApi(path,features)).toBe('billing');
  for(const path of ['/api/v1/generations','/api/v1/generations/g','/api/v1/generations/g/cancel','/canvas/task/run','/canvas/agent/session','/api/v1/auth/me'])expect(blockedApi(path,features)).toBeNull();
 });
 it('does not expose shared query routes internally and preserves external edition routes',()=>{
  const url=new URL('https://internal.example/project/canvas/p?shared=1');
  expect(blockedRoute(url,resolveFeatures())).toBe('publicSharing');expect(blockedRoute(url,resolveFeatures('external'))).toBeNull();
 });
 it('hides billing and public controls without hiding export/edit operations or stored text',()=>{
  expect(controlFeature('充值')).toBe('billing');expect(controlFeature('发布到社区')).toBe('publicSharing');
  expect(controlFeature('反馈')).toBe('externalLinks');expect(controlFeature('按Token计费')).toBe('billing');
  for(const label of ['余额预警','余额预警设置','Balance Alert','Wallet Balance Alert','按 Token 计费','RH 币余额','创作套餐管理','取消订阅','价格详情','Order payment'])expect(controlFeature(label)).toBe('billing');
  for(const label of ['导出到画布','下载','撤销','编辑文本','保存工作流','素材库','余额不足的角色设定','生成','运行','升级','输入 Token','输出 Token','上下文 32K','全部 tokens'])expect(controlFeature(label)).toBeNull();
 });
 it('blocks original marketing/social navigation while allowing Feishu and object-storage media',()=>{
  const own='https://internal.example';
  expect(externalNavigationFeature(new URL('https://www.runninghub.ai/pricing'),own)).toBe('externalLinks');
  expect(externalNavigationFeature(new URL('https://discord.com/invite/test'),own)).toBe('externalLinks');
  expect(externalNavigationFeature(new URL('https://alidocs.dingtalk.com/notable/share/form/test'),own)).toBe('externalLinks');
  expect(externalNavigationFeature(new URL('https://assets.example.invalid/removed'),own)).toBeNull();
  expect(externalNavigationFeature(new URL('https://media.example/video.mp4?signature=abc'),own)).toBeNull();
 });
 it('rejects disabled new APIs before transport rather than returning preview success',async()=>{
  const transport=vi.fn();const api=new ApiClient('/api/v1',transport,resolveFeatures('internal',{billing:true}));
  await expect(api.request('/orders',{method:'POST',body:{}})).rejects.toMatchObject({status:403,code:'FEATURE_DISABLED'});
  expect(transport).not.toHaveBeenCalled();
 });
 it('keeps legacy team routes disabled while allowing the separately implemented STUDIO membership probe',()=>{
  for(const label of ['选择账户','团队项目','团队资产'])expect(disabledFeature(controlFeature(label),resolveFeatures())).toBe('externalLinks');
  for(const path of ['/projects/canvas/team','/projects/canvas/team/']){
   const url=new URL(path,'https://studio.test');expect(blockedRoute(url,resolveFeatures())).toBe('externalLinks');expect(blockedRoute(url,resolveFeatures('external'))).toBeNull();
  }
  expect(blockedRoute(new URL('https://studio.test/projects/canvas/me/'),resolveFeatures())).toBeNull();expect(controlFeature('我的项目')).toBeNull();
  expect(blockedApi('/uc/team/my-teams',resolveFeatures())).toBeNull();
  expect(blockedApi('/uc/team/my-teams',resolveFeatures('external'))).toBeNull();expect(blockedApi('/uc/team/another-operation',resolveFeatures())).toBeNull();
 });
});

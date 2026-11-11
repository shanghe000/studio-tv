export type Edition='internal'|'external';
export type Feature='community'|'billing'|'publicSharing'|'marketing'|'externalLinks';
export type Features=Readonly<Record<Feature,boolean>>;
const featureNames:Feature[]=['community','billing','publicSharing','marketing','externalLinks'];
export const INTERNAL_FEATURE_MESSAGE='公司内部版本未启用此功能。';
export function resolveFeatures(edition:Edition='internal',overrides:Partial<Record<Feature,boolean>>={}):Features {
 const enabled=edition==='external';
 for(const [key,value]of Object.entries(overrides))if(!featureNames.includes(key as Feature)||typeof value!=='boolean')throw new Error('Invalid public feature configuration');
 return Object.freeze({...Object.fromEntries(featureNames.map(name=>[name,enabled])),...overrides,...(edition==='internal'?{billing:false}:{})}) as Features;
}
const normalize=(path:string)=>path.replace(/\/+$/,'')||'/';
export function routeFeature(path:string):Feature|null {
 const value=normalize(path);
 if(value==='/projects/canvas/team')return 'externalLinks';
 if(/^\/(?:projects\/)?(?:camp\/view|community)(?:\/|$)/.test(value)||/^\/projects\/canvas\/(?:camp|recommend|inspiration|wk3n7)(?:\/|$)/.test(value)||/^\/projects\/remix(?:\/|$)/.test(value))return 'community';
 if(/^\/(?:projects\/)?(?:pricing|price|recharge|pay|wallet|membership|subscriptions?|orders?|buy-history|billing|invoice|vip-rights)(?:\/|$)/.test(value))return 'billing';
 if(/^\/(?:projects\/)?(?:share|project-shares)(?:\/|$)/.test(value))return 'publicSharing';
 if(/^\/(?:projects\/)?(?:activity|activities|incentive|promotion|creation-camp)(?:\/|$)/.test(value)||value==='/project/creation-camp')return 'marketing';
 return null;
}
export function apiFeature(path:string):Feature|null {
 const value=normalize(path);
 if(/^\/canvas\/(?:community|inspiration|admin\/composition)(?:\/|$)/.test(value)||/^\/api\/v1\/(?:compositions|categories)(?:\/|$)/.test(value))return 'community';
 if(/^\/(?:pay|api\/(?:product|member|balanceAlert)|canvas\/price|api\/area\/price)(?:\/|$)/.test(value)||value==='/api/workflow/webapp-price-estimate'||/^\/api\/v1\/(?:catalog\/products|membership|wallet|orders|billing|generation-quotes)(?:\/|$)/.test(value)||/^\/api\/v1\/generations\/(?:quote|[^/]+\/(?:quote|confirm))(?:\/|$)/.test(value)||/^\/uc\/(?:recharge|invoice|wallet|member|balance|team\/(?:membership|wallet))/i.test(value)||/\/(?:createOrder|payment|checkout|recharge|buy-history)(?:\/|$)/i.test(value))return 'billing';
 if(value==='/canvas/common-workflow/submit'||/^\/canvas\/(?:share|publish)(?:\/|$)/.test(value)||/\/(?:share-links|project-shares|share-link)(?:\/|$)/.test(value)||/\/(?:publish|publishWork|publishWorkflow)(?:\/|$)/i.test(value))return 'publicSharing';
 if(/^\/canvas\/(?:home\/highlight|activity|campaign|incentive)(?:\/|$)/.test(value)||/^\/api\/v1\/(?:campaigns|activities)(?:\/|$)/.test(value))return 'marketing';
 return null;
}
export function disabledFeature(feature:Feature|null,features:Features):Feature|null{return feature&&!features[feature]?feature:null;}
export function blockedApi(path:string,features:Features):Feature|null {
 const primary=disabledFeature(apiFeature(path),features);if(primary)return primary;
 if(!features.publicSharing&&/\/(?:share|share-links|share-link|publish|publishWork|publishWorkflow)(?:\/|$)/i.test(path))return 'publicSharing';
 return null;
}
export function blockedRoute(url:URL,features:Features):Feature|null {
 if(!features.publicSharing&&(url.searchParams.has('shared')||url.searchParams.has('shareId')||/^\/(?:projects\/)?camp\/view(?:\/|$)/.test(url.pathname)))return 'publicSharing';
 return disabledFeature(routeFeature(url.pathname),features);
}
// Object-storage media, editor exports and Feishu login are deliberately outside this navigation rule.
export function externalNavigationFeature(url:URL,ownOrigin:string):Feature|null {
 if(url.origin===ownOrigin)return null;
 if(url.hostname==='alidocs.dingtalk.com'||/(^|\.)runninghub\.(ai|cn)$/.test(url.hostname)||/(^|\.)(?:discord\.com|discord\.gg|twitter\.com|x\.com|facebook\.com|t\.me|youtube\.com|bilibili\.com|weibo\.com)$/.test(url.hostname))return 'externalLinks';
 return null;
}
export function controlFeature(label:string):Feature|null {
 const text=label.replace(/\s+/g,' ').trim();
 if(/^(?:充值|去开通|升级会员|开通会员|购买会员|续费|钱包余额|RH\s*币余额|账户明细|按\s*Token\s*计费|开票管理|兑换码|我的收益|余额预警(?:设置)?|会员|创作套餐修改|创作套餐管理|取消订阅|订阅管理|订单支付|购买记录|我的订单|价格详情|Recharge|Top up|Upgrade membership|Subscription|Subscribe|Wallet balance|Account statement|Token billing|Token-based billing|Invoice management|Invoices|Redeem code|My earnings|(?:Wallet )?Balance Alert(?: Settings)?|Balance warning|Creator Plan Management|Cancel subscription|Manage subscription|Order payment|Purchase history|My orders|Pricing details)$/i.test(text))return 'billing';
 if(/^(?:分享|分享画布|分享项目|分享链接|复制公开链接|公开分享|发布作品|发布到社区|发布工作流|发布到灵感库|共有|공유|Share|Share canvas|Share project|Publish|Publish workflow|Publish on TapTV|Share by link)$/i.test(text))return 'publicSharing';
 if(/^(?:社区|发现作品|Community|Discover creations)$/i.test(text))return 'community';
 if(/^(?:联系我们|联系官方|加入社群|加入Discord|用户手册|反馈|Feedback|反馈与帮助|控制台|团队中心|团队项目|团队资产|创建团队|选择账户|邀请码|Contact us|Contact support|Join community|User manual|Console|Team center|Create team|Switch account|Invite code)$/i.test(text))return 'externalLinks';
 return null;
}

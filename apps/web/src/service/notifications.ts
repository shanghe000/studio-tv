import {ApiError} from '../api/client';
import {randomUuid} from '../browser-compat';
import type {ProductClient} from './product-client';

/** Enabled native inbox mapped to frozen STUDIO notification APIs, including their real501s. */
export class NotificationAdapter {
 private epoch=0;
 constructor(readonly api:ProductClient){}
 clear(){this.epoch++;}
 private check(epoch:number){if(epoch!==this.epoch)throw new ApiError(401,'SESSION_CHANGED','登录状态已变更，消息读取已取消。');}
 private localized(value:any){if(typeof value==='string')return value;if(!value||typeof value!=='object')throw new ApiError(502,'INVALID_RESPONSE','通知文本格式无效。');return String(value['zh-CN']??value.zhCN??value.zh??value.en??value['en-US']??Object.values(value)[0]??'');}
 async handle(path:string,body:any={},_method='POST'):Promise<any|undefined>{
  const epoch=this.epoch;
  if(path==='/canvas/notice/page'||path==='/api/message/list/v2'){
   const type=path==='/canvas/notice/page'?'UPDATE_RECORD':'OFFICIAL_MESSAGE',query=new URLSearchParams({type,page:String(body.current||body.page||1),pageSize:String(body.size||20)});
   const result=(await this.api.request<any>('/notifications?'+query)).data;this.check(epoch);
   if(!Array.isArray(result.items))throw new ApiError(502,'INVALID_RESPONSE','通知目录响应格式无效。');
   const records=result.items.map((row:any)=>{const common={id:row.id,title:this.localized(row.title),content:this.localized(row.body),hasRead:row.read,publishTime:row.createdAt,jumpUrl:row.targetUrl};return type==='UPDATE_RECORD'?{...common,noticeId:row.id}:{...common,messageType:type,sendTime:row.createdAt};});
   return{records,current:result.page,size:result.pageSize,total:result.total,pages:Math.ceil(result.total/result.pageSize),hasNext:result.hasMore};
  }
  if(path==='/api/message/user/unreadCount'){const counts=(await this.api.request<any>('/notifications/unread-count')).data;this.check(epoch);if(typeof counts.officialMessages!=='number')throw new ApiError(502,'INVALID_RESPONSE','未读消息响应格式无效。');return{...counts,officialMessageCount:counts.officialMessages};}
  if(path==='/canvas/notice/read'||path==='/api/message/updateReadStatus'){
   const ids=path==='/canvas/notice/read'?[body.noticeId]:body.msgId;if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'||!id))throw new ApiError(400,'INVALID_NOTIFICATION_IDS','缺少通知标识。');
   const result=(await this.api.request('/notifications/read',{method:'POST',body:{ids},idempotencyKey:randomUuid()})).data;this.check(epoch);return result;
  }
  return undefined;
 }
}

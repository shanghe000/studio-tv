import {expect,it,vi} from 'vitest';
import {NotificationAdapter} from '../../apps/web/src/service/notifications';
import {ProductClient} from '../../apps/web/src/service/product-client';
const json=(data:any,status=200)=>new Response(JSON.stringify({code:0,data}),{status});
const setup=(route:(path:string,init:any)=>Response|Promise<Response>)=>{const transport=vi.fn().mockImplementation(route),api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');return{adapter:new NotificationAdapter(api),transport};};

it('projects actual persisted notices and real unread counts without fabricated covers or balances',async()=>{
 const {adapter,transport}=setup(path=>path.includes('unread-count')?json({officialMessages:3,updateRecords:1,generations:0,total:4}):json({items:[{id:'n',title:{'zh-CN':'通知'},body:{en:'Body'},read:false,targetUrl:null,createdAt:'2026-10-05T00:00:00Z'}],page:2,pageSize:10,total:13,hasMore:false}));
 const page=await adapter.handle('/canvas/notice/page',{current:2,size:10});expect(transport.mock.calls[0][0]).toBe('/api/v1/notifications?type=UPDATE_RECORD&page=2&pageSize=10');expect(page.records[0]).toMatchObject({noticeId:'n',title:'通知',content:'Body',hasRead:false});expect(page.records[0]).not.toHaveProperty('coverImageUrl');expect(page).toMatchObject({current:2,total:13,hasNext:false});expect(await adapter.handle('/api/message/user/unreadCount')).toMatchObject({officialMessageCount:3,total:4});
});

it('marks actual requested IDs read with a UUID and propagates backend501',async()=>{
 const {adapter,transport}=setup(()=>json({officialMessages:0}));await adapter.handle('/api/message/updateReadStatus',{msgId:['n']});expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual({ids:['n']});expect(transport.mock.calls[0][1].headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
 const blocked=setup(()=>new Response(JSON.stringify({error:{code:'NOT_IMPLEMENTED',message:'pending'}}),{status:501}));await expect(blocked.adapter.handle('/canvas/notice/page')).rejects.toMatchObject({status:501,code:'NOT_IMPLEMENTED'});
});

it('rejects a late notification page after identity cleanup',async()=>{
 let done!:(r:Response)=>void;const {adapter}=setup(()=>new Promise<Response>(resolve=>done=resolve));const pending=adapter.handle('/api/message/list/v2'),rejected=expect(pending).rejects.toMatchObject({code:'SESSION_CHANGED'});adapter.clear();done(json({items:[],page:1,pageSize:20,total:0,hasMore:false}));await rejected;
});

import {readFileSync} from 'node:fs';

export const collaborationContract=JSON.parse(readFileSync(new URL('../../contracts/collaboration-extension.json',import.meta.url),'utf8'));
/** Fake transports must recognize the actual registered extension namespace,
 * methods and response shape, so a plausible-but-missing endpoint cannot pass. */
export function collaborationOperation(target:string,method='GET'){
 const url=new URL(target,'http://studio.test'),prefix=collaborationContract.servers[0].url;
 if(!url.pathname.startsWith(prefix+'/'))throw new Error('Not a collaboration contract route: '+target);
 const path=url.pathname.slice(prefix.length),entry=Object.entries<any>(collaborationContract.paths).find(([template])=>new RegExp('^'+template.replace(/\{[^}]+\}/g,'[^/]+')+'$').test(path));
 const operation=entry?.[1][method.toLowerCase()];if(!operation)throw new Error('Unregistered collaboration route: '+method+' '+target);
 return{template:entry![0],operation};
}
export function contractResponse(target:string,method:string,data:any,status=200,etag?:string){
 const {operation}=collaborationOperation(target,method),schema=operation.responses[String(status)]?.content?.['application/json']?.schema;
 if(status===204)return new Response(null,{status});
 if(status>=400)return new Response(JSON.stringify({code:'VERSION_CONFLICT',message:'权限或内容版本已更新'}),{status});
 if(!schema)throw new Error('Response status not declared: '+status+' '+target);
 const envelope=!!schema.properties?.code;
 return new Response(JSON.stringify(envelope?{code:0,message:'OK',requestId:'fixture',data}:data),{status,headers:etag?{ETag:etag}:{}});
}

// Browser-local implementation of the native asset library contract.
const KEY='rhtv-preview-asset-library';
const uid=()=>String(BigInt(Date.now())*1000000n+BigInt(crypto.getRandomValues(new Uint32Array(1))[0]%1000000));
const read=()=>{try{return JSON.parse(localStorage.getItem(KEY)||'{"folders":[],"items":[]}');}catch{return{folders:[],items:[]};}};
const save=s=>localStorage.setItem(KEY,JSON.stringify(s));
const id=value=>String(value??'');
const parent=f=>id(f.parentCode??f.parentGroupId);
function paginate(records,b){const size=Math.min(100,Math.max(1,Number(b.size)||30)),current=Math.max(1,Number(b.page||b.current)||1);return{records:records.slice((current-1)*size,current*size),current,size,total:records.length,pages:Math.ceil(records.length/size),hasNext:current*size<records.length};}
export function assetReply(path,b,{success,encode,decode,types}){
 if(!path.startsWith('/canvas/asset/'))return undefined;
 const s=read(),rootCodes=new Set(types.map(t=>id(t.code))),folderId=id(b.groupId||b.folderId||b.parentGroupId);
 const descendants=group=>{const found=new Set([id(group)]);let changed=true;while(changed){changed=false;for(const f of s.folders)if(found.has(parent(f))&&!found.has(f.id)){found.add(f.id);changed=true;}}return found;};
 const folder=f=>{const ids=descendants(f.id),items=s.items.filter(x=>ids.has(id(x.groupId)));return decode({...f,groupId:f.id,code:f.id,type:'FOLDER',nodeKind:'FOLDER',nodeType:'FOLDER',isFolder:true,itemCount:items.length,thumbnails:f.thumbnails?.length?f.thumbnails:items.map(x=>x.thumbnail).filter(Boolean).slice(0,4)});};
 const item=x=>decode({...x,itemId:x.id,itemName:x.name,type:'ITEM',nodeKind:'ITEM',isFolder:false});
 const filtered=records=>records.filter(x=>(!b.keyword||String(x.name).toLowerCase().includes(String(b.keyword).toLowerCase()))&&(!b.nodeType||x.nodeType===b.nodeType)&&(!b.nodeTypes?.length||b.nodeTypes.includes(x.nodeType))&&(!b.afterTime||Number(x.createTime)>=Number(b.afterTime))&&(!b.beforeTime||Number(x.createTime)<=Number(b.beforeTime)));
 if(path==='/canvas/asset/type/list')return success(types);
 if(path==='/canvas/asset/user/folder/first-level/list')return success(paginate(s.folders.filter(f=>!s.folders.some(p=>p.id===parent(f))&&(!b.code||parent(f)===id(b.code))).map(folder),b));
 if(path==='/canvas/asset/user/folder/second-level/list'){const records=[...s.folders.filter(f=>parent(f)===folderId).map(folder),...filtered(s.items.filter(x=>id(x.groupId)===folderId)).map(item)];return success(paginate(b.nodeKind==='ITEM'?records.filter(x=>x.type==='ITEM'):records,b));}
 if(path==='/canvas/asset/user/folder/second-level/item/list'||path==='/canvas/asset/user/group/item/list')return success(paginate(filtered(s.items.filter(x=>id(x.groupId)===folderId)).map(item),b));
 if(path==='/canvas/asset/user/folder/item/search')return success(paginate(filtered(s.items).map(item),b));
 if(path==='/canvas/asset/user/group/list')return success(paginate(s.folders.map(folder),b));
 if(path==='/canvas/asset/user/folder/create'||path==='/canvas/asset/user/group/create'){const newId=uid(),parentCode=id(b.parentCode||b.code||types[0]?.code||'IMAGE'),now=Date.now();const f={id:newId,name:String(b.name||'新建文件夹'),parentCode,parentGroupId:s.folders.some(x=>x.id===parentCode)?parentCode:null,createTime:now,updateTime:now,thumbnails:[]};s.folders.push(f);save(s);return success({...folder(f),failedItems:[]});}
 if(path==='/canvas/asset/user/folder/item/batch-add'||path==='/canvas/asset/user/group/item/batch-add'){const group=id(b.folderId||b.groupId);if(!s.folders.some(f=>f.id===group))return{code:1,msg:'请选择一个已保存的素材文件夹。',data:null};for(const n of b.nodes||b.items||[]){let content=n.content;try{if(typeof content==='string')content=JSON.parse(content);}catch{content={text:content};}const url=content?.url||n.url||'',now=Date.now();s.items.push(encode({id:uid(),groupId:group,name:String(n.itemName||n.name||content?.fileName||'素材'),nodeType:n.nodeType||'IMAGE',content:content||{url},url,thumbnail:n.thumbnail||n.thumbnailUrl||(n.nodeType==='IMAGE'?url:''),createTime:now,updateTime:now}));}save(s);return success({failedItems:[]});}
 if(path==='/canvas/asset/user/group/rename'){const f=s.folders.find(f=>f.id===id(b.groupId));if(f){f.name=String(b.name);f.updateTime=Date.now();save(s);}return success({failedItems:[]});}
 if(path==='/canvas/asset/user/group/item/rename'){const x=s.items.find(x=>x.id===id(b.itemId));if(x){x.name=String(b.itemName||b.name);x.updateTime=Date.now();save(s);}return success({failedItems:[]});}
 if(path==='/canvas/asset/user/folder/batch-delete'){const groups=new Set((b.groupIds||[]).flatMap(g=>[...descendants(g)])),items=new Set((b.itemIds||[]).map(id));s.folders=s.folders.filter(f=>!groups.has(f.id));s.items=s.items.filter(x=>!groups.has(id(x.groupId))&&!items.has(x.id));save(s);return success({failedItems:[]});}
 if(path==='/canvas/asset/user/folder/move'){const target=id(b.targetCode),groups=new Set((b.groupIds||[]).map(id));if([...groups].some(g=>descendants(g).has(target)))return{code:1,msg:'不能将文件夹移入自身或子文件夹。',data:null};if(!rootCodes.has(target)&&!s.folders.some(f=>f.id===target))return{code:1,msg:'目标文件夹不存在。',data:null};for(const f of s.folders)if(groups.has(f.id)){f.parentCode=target;f.parentGroupId=rootCodes.has(target)?null:target;}for(const x of s.items)if((b.itemIds||[]).map(id).includes(x.id))x.groupId=target;save(s);return success({failedItems:[]});}
 if(path==='/canvas/asset/user/folder/thumbnail/update'){const f=s.folders.find(f=>f.id===id(b.groupId));if(f){f.thumbnails=encode(b.thumbnails||[]);save(s);}return success({failedItems:[]});}
 return undefined;
}

import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {Window} from 'happy-dom';
import {expect,it,vi} from 'vitest';
import {installMediaDownloads,mediaDownloadFilename} from '../../apps/web/src/service/media-downloads';

const signature='SyntheticSignatureSegmentForDownloadRegression1234';
it.each([
 ['角色三视图生成（1）.'+signature,'image/png','角色三视图生成（1）.png'],
 ['角色三视图生成（1）.'+signature.replace('I','|'),'image/png','角色三视图生成（1）.png'],
 ['  角色 三视图（1）.'+signature+'  ','image/jpeg','角色 三视图（1）.jpg'],
 ['角色.v2.'+signature,'image/webp','角色.v2.webp'],
 ['角色.v2','image/png','角色.v2.png'],
 ['角色（1）.PNG','image/png','角色（1）.PNG'],
 ['角色（1）.jpeg','image/jpeg','角色（1）.jpeg'],
 ['角色.png','image/jpeg; charset=utf-8','角色.jpg'],
 ['视频（1）.mp4','video/mp4','视频（1）.mp4'],
 ['音频.'+signature,'audio/x-wav','音频.wav'],
 ['角色.'+signature,'','角色.'+signature],
 ['角色.'+signature,'application/octet-stream','角色.'+signature],
 ['项目.zip','application/zip','项目.zip'],
 ['文档.html','text/html','文档.html'],
])('names %s from actual %s media', (name,type,result)=>expect(mediaDownloadFilename(name,type)).toBe(result));

function surface(){
 const window=new Window({url:'https://fixture.invalid/projects/'}),doc=window.document,clicked:string[]=[],blobs=new Map<string,Blob>();let next=0;
 const urls={createObjectURL:vi.fn((blob:Blob)=>{const url='blob:https://fixture.invalid/'+(++next);blobs.set(url,blob);return url;}),revokeObjectURL:vi.fn((url:string)=>{blobs.delete(url);})};
 const observe=(event:any)=>{const anchor=event.target.closest?.('a[download]');if(anchor){clicked.push(anchor.download);event.preventDefault();}};
 doc.addEventListener('click',observe);
 return{doc,urls,clicked,blobs};
}
it('repairs the real frozen image download with a dotted STUDIO signature, preserving downloaded bytes',async()=>{
 const frozen=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),start=frozen.indexOf('function dat('),end=frozen.indexOf('function xp(',start);expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
 const s=surface(),originalCreate=s.urls.createObjectURL,originalRevoke=s.urls.revokeObjectURL,bytes=new Uint8Array([137,80,78,71]),fetch=vi.fn(async()=>new Response(bytes,{headers:{'Content-Type':'image/png'}})),dispose=installMediaDownloads(s.doc as unknown as Document,s.urls as any);
 const native=runInNewContext(frozen.slice(start,end)+';({image:fat,video:H1e})',{document:s.doc,URL:s.urls,fetch,Blob,Z1:(node:any)=>node.data.imageUrl,Uy:(node:any)=>node.data.videoUrl,rg:(value:any)=>value,P1e:()=>false});
 await native.image({data:{label:'角色三视图生成（1）',imageUrl:'https://fixture.invalid/storage/assets/ast_one?token=fixture.'+signature}});
 expect(s.clicked).toEqual(['角色三视图生成（1）.png']);expect(fetch).toHaveBeenCalledTimes(1);expect(originalCreate).toHaveBeenCalledOnce();expect(new Uint8Array(await originalCreate.mock.calls[0][0].arrayBuffer())).toEqual(bytes);expect(originalRevoke).toHaveBeenCalledOnce();expect(s.blobs.size).toBe(0);
 dispose();expect(s.urls.createObjectURL).toBe(originalCreate);expect(s.urls.revokeObjectURL).toBe(originalRevoke);
});
it('uses the real downloaded MIME for original JPEG/WebP images even when the native URL fallback calls them PNG',async()=>{
 const frozen=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),start=frozen.indexOf('function dat('),end=frozen.indexOf('function xp(',start),s=surface(),dispose=installMediaDownloads(s.doc as unknown as Document,s.urls as any);
 for(const [mime,extension]of [['image/jpeg','jpg'],['image/webp','webp']]){
  const native=runInNewContext(frozen.slice(start,end)+';fat',{document:s.doc,URL:s.urls,fetch:async()=>new Response('image-bytes',{headers:{'Content-Type':mime}}),Blob,Z1:(node:any)=>node.data.imageUrl,rg:(value:any)=>value,P1e:()=>false});
  await native({data:{label:'角色.v2',imageUrl:'https://fixture.invalid/storage/assets/ast_one?token=fixture.signature-with-hyphens'}});expect(s.clicked.at(-1)).toBe('角色.v2.'+extension);
 }
 dispose();
});

it('reproduces the immutable downloader naming bug before the compatibility boundary is installed',async()=>{
 const frozen=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),start=frozen.indexOf('function dat('),end=frozen.indexOf('function xp(',start),s=surface();
 const image=runInNewContext(frozen.slice(start,end)+';fat',{document:s.doc,URL:s.urls,fetch:async()=>new Response('image-bytes',{headers:{'Content-Type':'image/png'}}),Blob,Z1:(node:any)=>node.data.imageUrl,rg:(value:any)=>value,P1e:()=>false});
 await image({data:{label:'角色三视图生成（1）',imageUrl:'https://fixture.invalid/storage/assets/ast_one?token=fixture.'+signature}});expect(s.clicked).toEqual(['角色三视图生成（1）.'+signature]);
});
it('keeps transformed images on the frozen PNG branch and corrects single-asset library downloads through the same blob boundary',async()=>{
 const frozen=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),slice=(start:string,end:string)=>{const a=frozen.indexOf(start),b=frozen.indexOf(end,a+start.length);if(a<0||b<0)throw new Error('Frozen download seam changed');return frozen.slice(a,b);},s=surface(),dispose=installMediaDownloads(s.doc as unknown as Document,s.urls as any),adjust=vi.fn(async()=>new Blob(['adjusted-image'],{type:'image/png'})),fetch=vi.fn(async()=>new Response('jpeg-bytes',{headers:{'Content-Type':'image/jpeg'}}));
 const native=runInNewContext(slice('function dat(','function xp(')+slice('async function Zge(','function Lbt(')+';({image:fat,library:Zge})',{document:s.doc,URL:s.urls,fetch,Blob,Z1:(node:any)=>node.data.imageUrl,rg:(value:any)=>value,P1e:(value:any)=>!!value,_dn:adjust,Ydt:(item:any)=>item.url,Xdt:()=>null,Xge:(item:any)=>item.title+'.png'});
 await native.image({data:{label:'角色.v2',imageAdjustments:{brightness:1},imageUrl:'https://fixture.invalid/storage/assets/ast_one?token=fixture.'+signature}});expect(adjust).toHaveBeenCalledOnce();expect(fetch).not.toHaveBeenCalled();expect(s.clicked.at(-1)).toBe('角色.v2.png');
 await expect(native.library({title:'角色.v2（1）',url:'https://fixture.invalid/storage/assets/ast_two?token=fixture.'+signature})).resolves.toMatchObject({ok:true});expect(s.clicked.at(-1)).toBe('角色.v2（1）.jpg');expect(fetch).toHaveBeenCalledOnce();dispose();
});
it('ignores unrelated links, unknown media, ZIP/HTML blobs and stale URLs, then fully releases its hooks',()=>{
 const s=surface(),create=s.urls.createObjectURL,revoke=s.urls.revokeObjectURL,dispose=installMediaDownloads(s.doc as unknown as Document,s.urls as any);
 const click=(href:string,download='原名.'+signature)=>{const a=s.doc.createElement('a');a.href=href;a.download=download;s.doc.body.append(a);a.click();a.remove();};
 for(const mime of ['application/zip','text/html','','application/octet-stream'])click(s.urls.createObjectURL(new Blob(['bytes'],{type:mime})));
 click('https://fixture.invalid/storage/assets/one?token=fixture.'+signature);
 const stale=s.urls.createObjectURL(new Blob(['bytes'],{type:'image/png'}));s.urls.revokeObjectURL(stale);click(stale);
 expect(s.clicked).toEqual(Array(6).fill('原名.'+signature));
 const live=s.urls.createObjectURL(new Blob(['bytes'],{type:'image/png'}));dispose();click(live);expect(s.clicked.at(-1)).toBe('原名.'+signature);expect(s.urls.createObjectURL).toBe(create);expect(s.urls.revokeObjectURL).toBe(revoke);
});

/** File extensions come from downloaded media, never from a signed URL's token. */
const mediaExtensions:Record<string,readonly string[]>={
 'image/png':['png'],'image/jpeg':['jpg','jpeg'],'image/webp':['webp'],'image/gif':['gif'],'image/avif':['avif'],'image/bmp':['bmp'],'image/svg+xml':['svg'],
 'video/mp4':['mp4'],'video/webm':['webm'],'video/quicktime':['mov'],'video/x-msvideo':['avi'],'video/x-matroska':['mkv'],
 'audio/wav':['wav'],'audio/x-wav':['wav'],'audio/mpeg':['mp3'],'audio/mp4':['m4a'],'audio/aac':['aac'],'audio/ogg':['ogg'],'audio/flac':['flac'],
};
const knownExtensions=new Set(Object.values(mediaExtensions).flat());
function extensions(type:string){const mime=type.split(';',1)[0].trim().toLowerCase();return Object.hasOwn(mediaExtensions,mime)?mediaExtensions[mime]:undefined;}
export function mediaDownloadFilename(filename:string,type:string):string {
 const supported=extensions(type);if(!supported)return filename;
 const name=filename.trim(),suffix=name.match(/\.([^.]*)$/),extension=suffix?.[1].toLowerCase();
 if(extension&&supported.includes(extension))return name;
 // The immutable image downloader applies /\.(\w+)(?:\?|$)/ to the full URL.
 // On STUDIO asset URLs it can mistake the signature's final segment for an
 // extension. Ordinary title fragments such as "角色.v2" must stay intact.
 const inferredSignature=!!suffix&&/^[A-Za-z0-9_|-]{24,}$/.test(suffix[1]);
 const base=suffix&&(knownExtensions.has(extension??'')||inferredSignature)?name.slice(0,-suffix[0].length):name;
 return `${base.trim()||'media'}.${supported[0]}`;
}

/** Narrow compatibility boundary for the frozen native single-media download.
 * Its temporary Blob already carries STUDIO's verified Content-Type; neither the
 * signed URL nor query string participates in the chosen extension. */
export function installMediaDownloads(doc:Document=document,objectURLs:Pick<typeof URL,'createObjectURL'|'revokeObjectURL'>=URL){
 const create=objectURLs.createObjectURL,revoke=objectURLs.revokeObjectURL;
 if(typeof create!=='function'||typeof revoke!=='function')return()=>{};
 const mediaTypes=new Map<string,string>();let active=true;
 const createMediaURL=function(this:typeof objectURLs,object:Blob|MediaSource){
  const href=create.call(this,object),type=(object as Blob)?.type;
  if(active&&typeof type==='string'&&extensions(type))mediaTypes.set(href,type);
  return href;
 };
 const revokeMediaURL=function(this:typeof objectURLs,href:string){mediaTypes.delete(href);return revoke.call(this,href);};
 const download=(event:MouseEvent)=>{
  const anchor=(event.target as Element)?.closest?.('a[download]') as HTMLAnchorElement|null;
  if(!anchor)return;const type=mediaTypes.get(anchor.href);if(type)anchor.download=mediaDownloadFilename(anchor.download,type);
 };
 objectURLs.createObjectURL=createMediaURL;objectURLs.revokeObjectURL=revokeMediaURL;doc.addEventListener('click',download,true);
 return()=>{active=false;mediaTypes.clear();doc.removeEventListener('click',download,true);if(objectURLs.createObjectURL===createMediaURL)objectURLs.createObjectURL=create;if(objectURLs.revokeObjectURL===revokeMediaURL)objectURLs.revokeObjectURL=revoke;};
}

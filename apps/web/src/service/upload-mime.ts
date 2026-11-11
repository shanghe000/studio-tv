// Supported by the asset-upload service. File inputs may also report either
// audio alias, but signed headers and model checks use the canonical MIME.
export const uploadMediaTypes=[
 'image/png','image/jpeg','image/webp','image/gif','image/avif',
 'video/mp4','video/webm','video/quicktime',
 'audio/mpeg','audio/wav','audio/ogg','audio/flac','audio/mp4','audio/webm',
 'audio/x-wav','audio/mp3',
] as const;
export function uploadMimeType(mime:string):string {
 if(mime==='audio/x-wav')return 'audio/wav';
 if(mime==='audio/mp3')return 'audio/mpeg';
 return mime||'application/octet-stream';
}

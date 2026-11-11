export const nativeFrameShells=['opencut/index.html','labs/rhhyperframes/index.html','hyperframes-studio/index.html'];
export function gateFrameShellHtml(path,html){
 if(!nativeFrameShells.includes(path))return html;
 if(html.includes('data-studiotv-native-entry='))return html;
 const modules=[...html.matchAll(/<script\b(?=[^>]*\btype\s*=\s*["']module["'])[^>]*>\s*<\/script>/gi)].filter(match=>/\bsrc\s*=\s*["'][^"']+["']/i.test(match[0]));
 if(modules.length!==1)throw new Error('Expected one native module entry in '+path);
 const original=modules[0][0],source=original.match(/\bsrc\s*=\s*["']([^"']+)["']/i)[1],escape=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
 const replacement=original.replace(/\bsrc\s*=\s*["'][^"']+["']/i,'src="/frame-shell-entry.js"').replace(/>/,' data-studiotv-native-entry="'+escape(source)+'">');
 const pending='<script src="/runtime-config.js"></script><style id="studiotv-frame-pending-style">html[data-studiotv-frame-pending] body>:not(#studio-tv-login-gate):not(#studiotv-frame-shell-error):not(script):not(style){display:none!important}</style>';
 return html.replace(original,replacement).replace(/<html\b/,'<html data-studiotv-frame-pending').replace(/<head\b[^>]*>/,match=>match+pending);
}

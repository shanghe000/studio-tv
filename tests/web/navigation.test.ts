import {expect,it,vi} from 'vitest';
import {installStudioNavigation,embeddedEditorURL} from '../../apps/web/src/service/navigation';
it('keeps the published LAN port and embedded project parameters while avoiding cached directory redirects',()=>{
 const origin='http://192.0.2.10:18880';expect(embeddedEditorURL('/labs/rhhyperframes?embedded=1&canvasId=owned',origin)).toBe(origin+'/labs/rhhyperframes/?embedded=1&canvasId=owned');expect(embeddedEditorURL('/hyperframes-studio?projectId=owned',origin)).toBe(origin+'/hyperframes-studio/?projectId=owned');
 expect(embeddedEditorURL(origin+'/labs/rhhyperframes/',origin)).toBeUndefined();expect(embeddedEditorURL('http://192.0.2.10/labs/rhhyperframes',origin)).toBeUndefined();expect(embeddedEditorURL('/studio-api/projects/owned/preview',origin)).toBeUndefined();
});
function setup(){let clear!:()=>void,finish!:(value:string)=>void;const popup={closed:false,opener:{},location:{href:'about:blank',replace:vi.fn()},close:vi.fn(()=>{popup.closed=true;})},surface={location:{origin:'https://studio.invalid',href:'https://studio.invalid/hyperframes-studio/'},open:vi.fn(()=>popup)},resolveNavigation=vi.fn(()=>new Promise<string>(resolve=>finish=resolve)),runtime={auth:{user:{id:'owner'},onClear:(callback:()=>void)=>{clear=callback;return vi.fn();}},studio:{resolveNavigation}},notice=vi.fn(),dispose=installStudioNavigation(runtime,notice,surface);return{surface,popup,runtime,notice,dispose,clear:()=>clear(),finish:(value:string)=>finish(value)};}
it('opens the actual user tab and navigates only after a persisted Studio output grant resolves',async()=>{
 const {surface,popup,runtime,finish,dispose}=setup(),source='/studio-api/projects/hf/renders/file/task.mp4';expect(surface.open(source,'_blank')).toBe(popup);expect(runtime.studio.resolveNavigation).toHaveBeenCalledWith(source);finish('https://studio.invalid/storage/assets/a?token=scoped');await vi.waitFor(()=>expect(popup.location.replace).toHaveBeenCalledWith('https://studio.invalid/storage/assets/a?token=scoped'));expect(popup.opener).toBeNull();dispose();
});
it('leaves unrelated, other-origin and local OpenCut navigation on the actual native browser path',()=>{
 const {surface,runtime,dispose}=setup();surface.open('/opencut/','_blank');surface.open('https://other.invalid/studio-api/projects/hf/preview','_blank');surface.open('/studio-api/projects/hf/preview','_self');expect(runtime.studio.resolveNavigation).not.toHaveBeenCalled();dispose();
});
it('closes pending output navigation and rejects a late grant after logout',async()=>{
 const {surface,popup,clear,finish,notice,dispose}=setup();surface.open('/studio-api/projects/hf/preview','_blank');clear();finish('https://studio.invalid/api/v2/studio/preview/hf/grant/index.html');await Promise.resolve();await Promise.resolve();expect(popup.close).toHaveBeenCalledOnce();expect(popup.location.replace).not.toHaveBeenCalled();expect(notice).not.toHaveBeenCalled();dispose();
});
it('does not overwrite a tab the user navigated while the grant was loading',async()=>{
 const {surface,popup,finish,dispose}=setup();surface.open('/studio-api/projects/hf/preview','_blank');popup.location.href='https://studio.invalid/projects/';finish('https://studio.invalid/api/v2/studio/preview/hf/grant/index.html');await Promise.resolve();await Promise.resolve();expect(popup.location.replace).not.toHaveBeenCalled();dispose();
});
it('keeps denied output navigation as a visible failure and closes its blank tab',async()=>{
 const {surface,popup,runtime,notice,dispose}=setup();runtime.studio.resolveNavigation.mockRejectedValue(new Error('revoked asset'));surface.open('/studio-api/projects/hf/preview','_blank');await vi.waitFor(()=>expect(notice).toHaveBeenCalledWith('revoked asset'));expect(popup.close).toHaveBeenCalledOnce();expect(popup.location.replace).not.toHaveBeenCalled();dispose();
});

import {config} from './config';
import {installFeatureUi} from './features/internal-ui';
import {installUserGuideEntry} from './features/user-guide';
import {installStudioBrand} from './brand/install';
import {installStudioPet} from './brand/pet';
import {installBrowserCompatibility} from './browser-compat';
import {installMinimapNavigation} from './canvas/minimap-navigation';
import {recoverBootstrapChunk,completeBootstrapRecovery} from './runtime/bootstrap-recovery';
import {ServiceLoginGate} from './api/login-gate';
import {createServiceShellLoading,preloadNativeEntry} from './runtime/service-shell-loading';
import {prepareServiceBootstrap} from './runtime/bootstrap-readiness';
installBrowserCompatibility();
window.__RHTV_CONFIG__=config;
const announce=(message:string)=>{if(window.__RHTV_PREVIEW__)window.__RHTV_PREVIEW__.notice(message);else window.dispatchEvent(new CustomEvent('rhtv:feature-notice',{detail:message}));};
// Native error/placeholder DOM is not an editable canvas. A manual retry is
// safe there, but never once a document attachment or unfinished save exists.
const canReloadUnopenedPage=()=>!window.__RHTV_SERVICE__?.canvasAttachment?.()&&!window.__RHTV_SERVICE__?.storage?.hasPending?.();
const loading=config.mode==='service'?createServiceShellLoading({canReload:canReloadUnopenedPage}):null;
let admission:AbortController|null=null,releaseIdentity:(()=>void)|undefined,releasePreload:(()=>void)|undefined;
// Service mode admits a real session before either a feature-disabled page or
// an immutable native route can render. Preview retains its original shell.
try{
 if(config.mode==='service'){
  const runtime=(await import('./service/runtime')).serviceRuntime;
  const gate=new ServiceLoginGate(runtime);runtime.bindLoginGate(gate);
  await gate.waitForSession();
  admission=new AbortController();
  releaseIdentity=runtime.auth.onClear(()=>{admission!.abort();loading?.cancel();});
  loading!.authorized();
  // Fetch/compile static bytes while a canvas snapshot is restored. Execution
  // still begins only after both the session and application grant are live.
  releasePreload=preloadNativeEntry();
  const identity=runtime.auth.user?.id,route=location.pathname;
  await prepareServiceBootstrap(()=>runtime.ready(),{signal:admission.signal,current:()=>runtime.auth.user?.id===identity,retryCurrent:()=>location.pathname===route,waiting:retry=>loading!.retryConnection(retry),attempting:()=>loading!.preparing()});
  if(admission.signal.aborted||!runtime.auth.user)throw new Error('Service session ended before page initialization');
 }
 installStudioBrand();installStudioPet();installMinimapNavigation();installUserGuideEntry();
 const policyUi=installFeatureUi(config.features,announce);
 if(policyUi.blocked)loading?.disconnect();
 else{
  await import('./runtime/native-bootstrap.js');
  await loading?.waitForRootMount(admission?.signal);
  loading?.finish();
 }
 completeBootstrapRecovery();
}catch(error){
 if(admission?.signal.aborted||error instanceof DOMException&&error.name==='AbortError'){loading?.cancel();}
 else if(!recoverBootstrapChunk(error,window,()=>!document.getElementById('root')?.childElementCount&&canReloadUnopenedPage())){
  if(loading)loading.fail(error);
  else{const root=document.getElementById('root');if(root){root.textContent='页面暂时无法加载，请刷新后重试。';root.style.cssText='padding:32px;color:#ddd;background:#111;min-height:100vh;font:14px system-ui';}}
  console.error('STUDIOTV bootstrap failed',error instanceof Error?error.message:'unknown failure');
 }
}finally{releaseIdentity?.();releasePreload?.();}

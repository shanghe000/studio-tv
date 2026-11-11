import {expect,it} from 'vitest';
import {viewportPreviewProps} from '../../apps/web/src/service/canvas-viewport-previews';
const origin='https://studio.invalid',url=origin+'/storage/canvas-media/'+'a'.repeat(32)+'/ast_1';
const source={nodeId:'n',url,fallbackSourceUrl:url,skipIntrinsicSizePatch:false,onRecognitionMediaLoad:()=>{},data:{width:5000,height:2500}};
const viewport={imageMediaVirtualizationEnabled:true,imageMediaWindowNodeIds:new Set(['n']),imageResolutionTargetWidths:new Map([['n',384]]),selectedNodeIds:[]};
it('requests a visible display tier without feeding preview dimensions to the graph or recognition',()=>{
 const props=viewportPreviewProps(source,viewport,origin);
 expect(props.url).toBe(url+'?previewWidth=384');expect(props.skipIntrinsicSizePatch).toBe(true);expect(props.onRecognitionMediaLoad).toBeUndefined();
 expect(props.fallbackSourceUrl).toBe(url);expect(props.data).toBe(source.data);expect(source.url).toBe(url);
 expect(viewportPreviewProps(source,{...viewport,imageResolutionTargetWidths:new Map()},origin).url).toBe(url+'?previewWidth=256');
});
it('keeps the original for selection, editing, expansion, foreign media and the small canvas',()=>{
 for(const v of [{selectedNodeIds:['n']},{expandedNodeId:'n'},{outputHistoryOpenNodeId:'n'},{imageMediaVirtualizationEnabled:false},{imageMediaWindowNodeIds:new Set()}])expect(viewportPreviewProps(source,{...viewport,...v},origin)).toBe(source);
 for(const value of ['https://other.invalid'+new URL(url).pathname,url+'?token=x',url+'#frame','/storage/assets/asset']){const p={...source,url:value,fallbackSourceUrl:value};expect(viewportPreviewProps(p,viewport,origin)).toBe(p);}
});

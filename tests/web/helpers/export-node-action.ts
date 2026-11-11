// Optional cross-language hand-off for the offline STUDIO application/Router audit.
// Only test transport bodies from synthetic canvases are exported.
import {appendFileSync} from 'node:fs';
export function exportNodeAction(init:any,expected?:{expectedAssetIds:string[];expectedPortraitRecipeId:string}){
 const file=process.env.STUDIO_CANVAS_ACTIONS_EXPORT;if(!file)return;
 const body=JSON.parse(init.body),node=body.graph.nodes.find((n:any)=>n.id===body.targetId),data=node.data;
 const name=data.capabilityRef+':'+(data.sceneCode??(data.isPortraitAdjustResult?'portrait':data.toolsType)??node.type);
 appendFileSync(file,JSON.stringify({name,body,...expected})+'\n');
}

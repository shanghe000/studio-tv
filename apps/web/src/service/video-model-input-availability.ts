import {nodeReadinessMaterials,readinessModelInputReason} from './connection-readiness';

const cache=new WeakMap<object,{signature:string;groups:any[]}>();
/** The native cascade checks broad video modes. Different profiles in the same
 * mode still have different reference counts. Keep the original selected model
 * and only project its menu, so removing a reference can enable it again. */
export function videoModelInputAvailability(props:any,node:any){
 const groups=props?.videoModelGroups;
 if(node?.type!=='rh-video'||!Array.isArray(groups)||!groups.length||!Array.isArray(props.nodes)||!Array.isArray(props.edges)||!props.nodes.some((row:any)=>row.id===node.id))return props;
 const materials=nodeReadinessMaterials(node,{nodes:props.nodes,edges:props.edges});
 if(!materials.length)return props;
 const signature=JSON.stringify([node.data?.capabilityRef,node.data?.capabilityVersion,materials]);
 let entry=cache.get(groups);
 if(!entry||entry.signature!==signature){
  const project=(rows:any[]):any[]=>{
   let touched=false;const result=rows.map(group=>{
    let mapped=group;
    if(Array.isArray(group.nodeModelList)){
     const nodeModelList=group.nodeModelList.map((row:any)=>{
      if(!Array.isArray(row.modelList))return row;
      const modelList=row.modelList.map((model:any)=>{
       if(!model?.available||model.disabled||!model.capabilityRef)return model;
       const reason=readinessModelInputReason(model,materials);
       return reason?{...model,disabled:true,studioInputDisabledReason:reason,reason,description:reason,descriptionEn:reason}:model;
      });return modelList.some((value:any,i:number)=>value!==row.modelList[i])?{...row,modelList}:row;
     });if(nodeModelList.some((value:any,i:number)=>value!==group.nodeModelList[i]))mapped={...mapped,nodeModelList};
    }
    if(Array.isArray(group.modelGroupList)){const children=project(group.modelGroupList);if(children!==group.modelGroupList)mapped={...mapped,modelGroupList:children};}
    touched||=mapped!==group;return mapped;
   });
   return touched?result:rows;
  };
  entry={signature,groups:project(groups)};cache.set(groups,entry);
 }
 return entry.groups===groups?props:{...props,videoModelGroups:entry.groups};
}

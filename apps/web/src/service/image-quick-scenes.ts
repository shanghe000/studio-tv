import {nativePortraitAlias,nativePanoramaAlias} from './image-semantic-tools';
export const nativeQuickSceneAlias='image-imagerhart-image-g-2-official-image-to-image';
/** Frozen T7e and Go quickSceneTasks share this exact operation boundary. */
export const quickSceneCodes=new Set([
 'canvas-image-quick-create-multi-camera-9-grid',
 'canvas-image-quick-create-story-board-4-grid',
 'canvas-image-quick-create-story-board-25-grid',
 'canvas-image-quick-create-cinematic-lighting-key-light',
 'canvas-image-quick-create-cinematic-lighting-fill-light',
 'canvas-image-quick-create-cinematic-lighting-back-light',
 'canvas-image-quick-create-cinematic-lighting-hair-light',
 'canvas-image-quick-create-cinematic-lighting-side-light',
 'canvas-image-quick-create-cinematic-lighting-edge-light',
 'canvas-image-quick-create-cinematic-lighting-top-light',
 'canvas-image-quick-create-cinematic-lighting-bottom-light',
 'canvas-image-quick-create-cinematic-lighting-eye-light',
 'canvas-image-quick-create-cinematic-lighting-chiaroscuro',
 'canvas-image-quick-create-cinematic-lighting-rembrandt',
 'canvas-image-quick-create-cinematic-lighting-butterfly',
 'canvas-image-quick-create-cinematic-lighting-loop-lighting',
 'canvas-image-quick-create-cinematic-lighting-split-lighting',
 'canvas-image-quick-create-cinematic-lighting-high-key',
 'canvas-image-quick-create-cinematic-lighting-flat-lighting',
 'canvas-image-quick-create-character-tri-view',
 'canvas-image-quick-create-predict-3-s-after',
 'canvas-image-quick-create-predict-5-s-before',
 'canvas-image-quick-create-camera-motion-control-push-in',
 'canvas-image-quick-create-camera-motion-control-pull-out',
 'canvas-image-quick-create-camera-motion-control-pan',
 'canvas-image-quick-create-camera-motion-control-dolly',
 'canvas-image-quick-create-camera-motion-control-tracking',
 'canvas-image-quick-create-camera-motion-control-static',
 'canvas-image-quick-create-camera-motion-control-orbit',
 'canvas-image-quick-create-camera-motion-control-arc-shot',
 'canvas-image-quick-create-emotion-reshape-anger',
 'canvas-image-quick-create-emotion-reshape-smile',
 'canvas-image-quick-create-emotion-reshape-thinking',
 'canvas-image-quick-create-emotion-reshape-confused',
 'canvas-image-quick-create-emotion-reshape-scared',
 'canvas-image-quick-create-emotion-reshape-peeking',
 'canvas-image-quick-create-emotion-reshape-evil',
 'canvas-image-quick-create-emotion-reshape-crying',
 'canvas-image-quick-create-depth-parallax',
 'canvas-image-quick-create-dynamic-scene-effects-rain',
 'canvas-image-quick-create-dynamic-scene-effects-snow',
 'canvas-image-quick-create-dynamic-scene-effects-sandstorm',
 'canvas-image-quick-create-dynamic-scene-effects-tyndall',
 'canvas-image-quick-create-dynamic-scene-effects-embers',
 'canvas-image-quick-create-dynamic-scene-effects-bioluminescence',
]);

const modelViews=new WeakMap<object,{lower:any;upper:any;candidate:any;view:any}>();
const contextViews=new WeakMap<object,{models:any;view:any}>();
const panoramaModelViews=new WeakMap<object,any>();
const imageModel=(row:any)=>row?.available===true&&row.testMode===false&&row.kind==='IMAGE_TO_IMAGE'
 &&typeof row.capabilityRef==='string'&&!!row.capabilityRef.trim()&&row.capabilityRef!==nativeQuickSceneAlias&&row.modelCode===row.capabilityRef
 &&row.model&&typeof row.model==='object'&&!Array.isArray(row.model)
 &&['providerRef','modelRef','title','version'].every(key=>typeof row.model[key]==='string'&&!!row.model[key].trim())
 &&Array.isArray(row.inputKinds)&&row.inputKinds.includes('IMAGE')&&Array.isArray(row.outputKinds)&&row.outputKinds.includes('IMAGE');

/** Only the image toolbar's private default lookup sees this alias. Its normal
 * params/menu models, user data and callbacks remain the original references. */
export function nativeImageToolbarProps(props:any,componentName:string){
 // The panorama composer hard-codes its old default even after the user has
 // selected a real capability. Keep that compatibility alias inside this
 // active panorama view only; execution still requires its exact scene/shape.
 if(componentName==='P1t'&&props?.targetNode?.type==='rh-image'&&props.targetNode.data?.panorama?.isPanoramaNode===true&&Array.isArray(props.nodes)&&Array.isArray(props.edges)&&props.models){
  const cached=panoramaModelViews.get(props.models);if(cached)return{...props,models:cached};
  let changed=false;const models={...props.models};for(const bucket of ['image-image','IMAGE_IMAGE','text-image','TEXT_IMAGE']){
   const rows=models[bucket];if(!Array.isArray(rows)||rows.some((row:any)=>row.modelCode===nativePanoramaAlias))continue;
   const candidate=rows.find((row:any)=>imageModel(row)||row?.available===true&&row.testMode===false&&row.kind==='TEXT_TO_IMAGE'&&row.model&&row.modelCode===row.capabilityRef&&row.outputKinds?.includes('IMAGE'));
   if(candidate){models[bucket]=[...rows,{...candidate,modelCode:nativePanoramaAlias}];changed=true;}
  }if(changed)panoramaModelViews.set(props.models,models);return changed?{...props,models}:props;
 }
 if(componentName!=='N2r'&&componentName!=='skr')return props;
 const node=props?.targetNode,context=props?.toolbarContext,models=context?.models;
 if(node?.type!=='rh-image'||!Array.isArray(props.nodes)||!Array.isArray(props.edges)
  ||!context||typeof context.canvasId!=='string'||!context.canvasId.trim()
  ||!models||typeof models!=='object'||Array.isArray(models))return props;
 const lower=models['image-image'],upper=models.IMAGE_IMAGE;
 const candidate=[...Array.isArray(lower)?lower:[],...Array.isArray(upper)?upper:[]].find(imageModel);
 if(!candidate)return props;
 let cached=modelViews.get(models);
 if(!cached||cached.lower!==lower||cached.upper!==upper||cached.candidate!==candidate){
  const aliases=[nativeQuickSceneAlias,nativePortraitAlias,nativePanoramaAlias],entries=aliases.map(modelCode=>({...candidate,modelCode})),view={...models,
   'image-image':[...(Array.isArray(lower)?lower:[]).filter((row:any)=>!aliases.includes(row?.modelCode)),...entries]};
  if(Array.isArray(upper))view.IMAGE_IMAGE=[...upper.filter((row:any)=>!aliases.includes(row?.modelCode)),...entries];
  cached={lower,upper,candidate,view};modelViews.set(models,cached);
 }
 let scoped=contextViews.get(context);
 if(!scoped||scoped.models!==cached.view){scoped={models:cached.view,view:{...context,models:cached.view}};contextViews.set(context,scoped);}
 return{...props,toolbarContext:scoped.view};
}


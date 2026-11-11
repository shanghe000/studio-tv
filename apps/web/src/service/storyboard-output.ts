import {ApiError} from '../api/client';

const scenes=new Set(['film','comic','shortDrama','mv','knowledge','ecommerce']);
const stageBadges=new Set([
 'Generating the storyboard table, please wait…','Detecting the scene type, please wait…',
 '分鏡表を生成しています。しばらくお待ちください…','シーンタイプを判定しています。しばらくお待ちください…',
 '스토리보드 표를 생성하는 중입니다. 잠시만 기다려 주세요…','장면 유형을 판별하는 중입니다. 잠시만 기다려 주세요…',
 '正在生成分镜表，请稍后','正在识别应用场景，请稍候…',
]);
export function scriptTerminalFields(data:any){
 const patch:Record<string,any>={};
 if(stageBadges.has(data?.customBadgeText))patch.customBadgeText='';
 if(scenes.has(data?.pendingOutputScene))patch.pendingOutputScene=null;
 return patch;
}
export function legacyStoryboardResult(node:any){return node?.type==='rh-script'&&node.data?.status==='finished'&&Array.isArray(node.data?.output)&&node.data.output.some((part:any)=>part?.outputType==='structured'||part?.type==='STRUCTURED');}

const object=(value:any):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=(value:any)=>typeof value==='string'?value:'';
function invalid(message='成功回执的分镜格式暂无法显示，原始结果已保留。'):never{throw new ApiError(502,'STORYBOARD_PRESENTATION_UNSUPPORTED',message);}
interface Entity {id:string;name:string;desc:string;imageUrl:string}
type Kind='characters'|'scenes'|'props'|'products';
const imageFields:Record<Kind,string>={characters:'角色图',scenes:'场景图',props:'道具图',products:'商品图'};
function soundText(sound:any):string {
 if(typeof sound==='string')return sound;
 if(sound===undefined||sound===null)return '';
 if(!object(sound))return invalid();
 const labels:Record<string,string>={dialogue:'对白',ambience:'环境声',foley:'拟音',music:'音乐'};
 return Object.entries(sound).map(([key,value])=>`${labels[key]||key}：${typeof value==='string'?value:JSON.stringify(value)}`).join('\n');
}

/** Display projection for the STUDIO v1 storyboard data. Raw outputs remain separate
 * and unchanged. Frozen hLe reads object.rows before its Chinese shots parser.
 * Inline entities deliberately omit native reference IDs: TA would delete them.
 */
export function storyboardOutput(outputs:any[],nodeData:any){
	if(!object(nodeData))return invalid('生成时的分镜配置不可验证，原始结果已保留。');
 if(outputs.length!==1||outputs[0]?.outputType!=='structured'||outputs[0]?.schemaVersion!=='1'||!object(outputs[0]?.data))return invalid();
 const raw=outputs[0].data;
 if(!Array.isArray(raw.shots)||raw.shots.length===0||raw.shots.length>500)return invalid();
 const code=String(nodeData?.sceneCode??'').replace(/^storyboard-prompt-/,'');
 const aliases:Record<string,string>={'short-drama':'shortDrama'};
 const fromCode=aliases[code]??code,fromStyle=String(nodeData?.styleName??'').split('::')[0];
 const scene=scenes.has(fromCode)?fromCode:scenes.has(nodeData?.params?.scene)?nodeData.params.scene:scenes.has(nodeData?.pendingOutputScene)?nodeData.pendingOutputScene:fromStyle;
 if(!scenes.has(scene))return invalid('分镜应用场景尚未确认，原始结果已保留。');
 const registry:Record<Kind,Entity[]>={characters:[],scenes:[],props:[],products:[]};
 const register=(kind:Kind,value:any):Entity=>{
  if(!object(value)||!text(value.name))return invalid();
  const id=text(value.id)||`studio-${kind}-${registry[kind].length+1}`;
  const entry={id,name:value.name,desc:text(value.desc)||text(value.description)||text(value.appearance),imageUrl:''};
  const prior=registry[kind].find(item=>item.id===id);
  if(prior){if(prior.name!==entry.name||prior.desc!==entry.desc)return invalid();return prior;}
  registry[kind].push(entry);return entry;
 };
 for(const kind of Object.keys(registry) as Kind[]){if(raw[kind]!==undefined&&!Array.isArray(raw[kind]))return invalid();for(const item of raw[kind]||[])register(kind,item);}
 const resolve=(kind:Kind,value:any):Entity=>{
  if(object(value))return register(kind,value);
  if(typeof value!=='string'||!value)return invalid();
  const found=registry[kind].filter(item=>item.id===value||item.name===value);
  if(found.length!==1)return invalid('分镜引用的实体无法唯一解析，原始结果已保留。');
  return found[0];
 };
 const inline=(kind:Kind,entity:Entity)=>({名称:entity.name,描述:entity.desc,[imageFields[kind]]:entity.imageUrl});
 const list=(kind:Kind,value:any)=>{if(value===undefined)return [];if(!Array.isArray(value))return invalid();return value.map(ref=>inline(kind,resolve(kind,ref)));};
 const ids=new Set<string>();
 const rows=raw.shots.map((shot:any,index:number)=>{
  if(!object(shot))return invalid();
  const duration=shot.duration_seconds??shot.durationSeconds??shot.duration;
  // Frozen IA rounds to 0.1s and clamps to 4..30s. Refuse a lossy projection.
  if(typeof duration!=='number'||!Number.isFinite(duration)||duration<4||duration>30||Math.abs(duration*10-Math.round(duration*10))>1e-8)return invalid('原生分镜表仅支持 4–30 秒、0.1 秒精度；原始时长已保留。');
  const visual=text(shot.visual_description);
  const action=text(shot.action)||text(shot.description)||(visual.trim()?visual:''),image=text(shot.image_prompt)||text(shot.imagePrompt)||text(shot.storyboard_prompt),video=text(shot.video_prompt)||text(shot.videoPrompt);
  if(!action||!image||!video||shot.camera!==undefined&&typeof shot.camera!=='string')return invalid();
  const id=text(shot.id)||`studio-shot-${index+1}`;if(ids.has(id))return invalid();ids.add(id);
  const rowScene=shot.scene===undefined?{名称:'',描述:'',场景图:''}:inline('scenes',resolve('scenes',shot.scene));
  const styleField:Record<string,string>={film:'film_style',shortDrama:'film_style',comic:'art_style',mv:'mv_style',knowledge:'video_style'};
  return {id,shot:String(index+1),duration:String(duration),description:action+(shot.camera?`\n【镜头】${shot.camera}`:''),sound_effect:soundText(shot.sound??shot.sound_effect),storyboard_prompt:image,video_prompt:video,scene:rowScene,characters:list('characters',shot.characters),props:list('props',shot.props),products:list('products',shot.products),...(styleField[scene]&&text(nodeData?.globalStyles)?{[styleField[scene]]:nodeData.globalStyles}:{})};
 });
 return {...raw,outputScene:scene,rows,storyboardEntities:registry,...(text(nodeData?.globalStyles)?{globalStyles:nodeData.globalStyles}:{}),...(text(nodeData?.stylePrompt)?{stylePrompt:nodeData.stylePrompt}:{})};
}

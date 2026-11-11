import {ApiError} from '../api/client';

const exact:Record<string,string>={
 '/canvas/remake/config/story-voice-presets':'分镜配音预设',
 '/canvas/price/estimate':'模型价格估算',
 '/api/workflow/webapp-price-estimate':'工作流价格估算',
 '/aivideo/runninghub-models/options':'视频模型列表',
 '/canvas/model/group/list':'模型分组列表',
 '/canvas/model/list':'模型列表',
 '/canvas/task/run':'画布节点生成',
 '/canvas/task/batchStatus':'生成进度查询',
 '/canvas/task/cancel':'取消生成',
 '/api/system/getConfig':'系统配置读取',
 '/uc/client/ipAndCountry':'地区信息查询',
};
const families:[string,string][]=[
 ['/canvas/remake/','视频重拍'],['/canvas/node-history/','节点生成历史'],['/canvas/his/','生成历史'],
 ['/canvas/node/tag/','节点标签'],['/canvas/model/voice/','音频声音选择'],['/canvas/model/','模型选择'],
 ['/canvas/sketchboard/','画板'],['/canvas/director/','导演台'],['/canvas/media/','媒体处理'],
 ['/canvas/asset/','资产库'],['/canvas/prompt/','提示词'],['/canvas/character-library/','角色库'],
 ['/canvas/agent/','画布助手'],['/canvas/share/','作品分享'],['/canvas/folder/','项目文件夹'],
 ['/api/workflow/','工作流'],['/api/webapp/','AI 应用'],['/aivideo/','视频创作'],
];
/** Only a static operation path is echoed. Request parameters, identifiers,
 * credentials and URL queries never enter the notice or diagnostic label. */
export function unsupportedNativeOperation(path:string){
 const clean=path.split(/[?#]/,1)[0],safe=/^\/[A-Za-z][A-Za-z/-]{0,139}$/.test(clean)?clean:undefined;
 const label=exact[clean]??families.find(([prefix])=>clean.startsWith(prefix))?.[1];
 const pricing=/price|calculate/.test(clean),feature=label??(pricing?'模型价格估算':'当前请求的功能');
 const detail=safe?`（功能标识：${safe}）`:'';
 return new ApiError(501,'NOT_IMPLEMENTED',`“${feature}”${pricing?'服务尚未配置':'暂未接入服务'}，暂时无法使用。${detail}`);
}

/** The storyboard video composer preloads this optional catalog on selection
 * and handles its rejection itself. A transport-wide toast turns that passive
 * read into a misleading action failure. Keep the actual rejection intact;
 * never silence generation, remake commands, authentication or outages. */
export function shouldAnnounceNativeFailure(path:string,method:string,error:{status?:number;code?:string}){
 if(error.code==='FEATURE_DISABLED')return false;
 return !(path==='/canvas/remake/config/story-voice-presets'&&method.toUpperCase()==='POST'&&error.status===501&&error.code==='NOT_IMPLEMENTED');
}

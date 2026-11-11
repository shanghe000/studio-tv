import {expect,it} from 'vitest';
import {unsupportedNativeOperation} from '../../apps/web/src/service/unsupported-operation';
it('identifies the storyboard voice catalog separately from video reshoot',()=>{
 const error=unsupportedNativeOperation('/canvas/remake/config/story-voice-presets');
 expect(error).toMatchObject({status:501,code:'NOT_IMPLEMENTED'});
 expect(error.message).toContain('分镜配音预设');expect(error.message).not.toContain('视频重拍');
});
it.each([['/canvas/remake/shots/video-history','视频重拍'],['/canvas/node-history/unknown','节点生成历史'],['/canvas/task/run','画布节点生成'],['/canvas/model/list','模型列表'],['/api/workflow/webapp-price-estimate','工作流价格估算'],['/canvas/price/estimate','模型价格估算'],['/new/function','当前请求的功能']])('names the failing native feature and its exact safe operation: %s',(path,label)=>{const error=unsupportedNativeOperation(path);expect(error).toMatchObject({status:501,code:'NOT_IMPLEMENTED'});expect(error.message).toContain(label);expect(error.message).toContain('功能标识：'+path);});
it('does not include query, body, unsafe identifier or encoded credential data in the notice',()=>{
 expect(unsupportedNativeOperation('/canvas/remake/shots/video-history?access_token=private#secret').message).toContain('视频重拍');
 expect(unsupportedNativeOperation('/canvas/remake/shots/video-history?access_token=private#secret').message).not.toMatch(/private|secret|access_token/);
 expect(unsupportedNativeOperation('/canvas/remake/user-123/private%20data').message).not.toContain('user-123');
});

import {ApiError} from '../api/client';

export type CollaborationRole='OWNER'|'EDITOR'|'VIEWER';
export interface ProjectAccess {
 projectId:string;ownerId:string;storageOwnerId:string;role:CollaborationRole;
 canRead:boolean;canEdit:boolean;canRun:boolean;canManageMembers:boolean;revision:number;
}
export type ProjectAction='canRead'|'canEdit'|'canRun'|'canManageMembers';
export function validateProjectAccess(value:any,projectId:string):ProjectAccess {
 const role=value?.role,edit=role==='OWNER'||role==='EDITOR',owner=role==='OWNER';
 if(!value||value.projectId!==projectId||typeof value.ownerId!=='string'||!value.ownerId||value.storageOwnerId!==value.ownerId||!['OWNER','EDITOR','VIEWER'].includes(role)||!Number.isSafeInteger(value.revision)||value.revision<1||value.canRead!==true||value.canEdit!==edit||value.canRun!==edit||value.canManageMembers!==owner)throw new ApiError(502,'INVALID_PROJECT_ACCESS','服务未返回有效的项目权限。');
 return{projectId,ownerId:value.ownerId,storageOwnerId:value.storageOwnerId,role,canRead:true,canEdit:edit,canRun:edit,canManageMembers:owner,revision:value.revision};
}
export const roleLabel=(role:CollaborationRole)=>({OWNER:'所有者',EDITOR:'可编辑',VIEWER:'只读'})[role];

/** Only a denial decoded from the service can revoke a previously verified
 * role. A proxy error page or a failed parse leaves that role unconfirmed. */
export function projectAccessDenied(error:unknown){
 return error instanceof ApiError && [401,403,404].includes(error.status) && error.code!=='INVALID_RESPONSE';
}

export function retryableCanvasRead(error:unknown){
 return error instanceof TypeError || error instanceof ApiError && (error.status>=500||[408,429].includes(error.status)||error.code==='INVALID_RESPONSE');
}

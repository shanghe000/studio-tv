import type {CollaborationRole,ProjectAccess} from '../../apps/web/src/service/project-access';
export const verifiedAccess=(projectId='p',role:CollaborationRole='OWNER',ownerId='owner',revision=1):ProjectAccess=>({projectId,ownerId,storageOwnerId:ownerId,role,canRead:true,canEdit:role!=='VIEWER',canRun:role!=='VIEWER',canManageMembers:role==='OWNER',revision});

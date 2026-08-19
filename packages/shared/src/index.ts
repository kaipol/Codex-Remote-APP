export const PRODUCT = 'codex' as const;
export type SessionStatus = 'active' | 'paused' | 'archived';
export interface ProjectInfo { id:string; name:string; rootPaths:string[]; createdAt?:number; updatedAt?:number }
export interface Session {
  session_id: string;
  title: string;
  status: SessionStatus;
  pinned: boolean;
  cwd: string;
  created_at: string;
  updated_at: string;
  rollout_path?: string;
  project_name?: string;
  project_id?: string;
  message_count?: number;
  user_message_count?: number;
  /** True when the thread is currently locked by another Codex writer (e.g. the local Desktop app has it open). */
  occupied?: boolean;
}
export interface MessageReference { type:'file'|'skill'|'annotation'; label:string; path?:string; detail?:string; url?:string }
export interface Message { msg_id:string; client_id?:string; turn_id?:string; session_id:string; role:'user'|'assistant'; content:string; references?:MessageReference[]; timestamp:string; seq:number }
export type EventType='user_message'|'assistant_delta'|'assistant_message'|'turn_started'|'turn_completed'|'turn_failed'|'command_execution'|'file_change'|'reasoning_status'|'context_compaction'|'tool_call'|'web_search'|'approval_requested'|'session_updated'|'provider_error';
export interface BridgeEvent { id:string; type:EventType; session:string; timestamp:string; seq:number; role?:string; content?:string; metadata?:Record<string,unknown> }
export interface SessionDetail extends Session { messages:Message[]; events:BridgeEvent[] }
export interface AuthTokens { access_token:string; refresh_token:string; expires_in:number; device_id:string }
export type CapabilityKind='models'|'skills'|'apps'|'defaults';
export interface WsEnvelope { type:'hello'|'event'|'sync'|'capabilities'|'error'; event?:BridgeEvent; events?:BridgeEvent[]; capabilities?:CapabilityKind[]; cursor?:number; stream_id?:string; message?:string }
export interface PendingApproval { request_id:string; session_id:string; turn_id?:string; item_id?:string; kind:string; payload:unknown; status:'pending'; created_at:string; updated_at:string }
export type ApprovalDecision='accept'|'decline'|'cancel';
export interface ApprovalResolution { request_id:string;session_id:string;decision:ApprovalDecision;status:'resolved' }
export interface SyncResponse { cursor:number; events:BridgeEvent[]; stream_id?:string; reset?:boolean; has_more?:boolean }
export interface TurnAccepted { thread_id:string; turn_id:string; status:'started'|'interrupt_requested' }
export type ReasoningEffort='none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'|'ultra';
export type ApprovalPolicy='untrusted'|'on-failure'|'on-request'|'never';
export type SandboxMode='read-only'|'workspace-write'|'danger-full-access';

export function isSuppressedRuntimeNotice(value:string):boolean{
  const lines=value.replace(/\r\n?/g,'\n').split('\n').map(line=>line.replace(/^\s*\u26a0\ufe0f?\s*/,'').trim()).filter(Boolean);
  if(!lines.length)return true;
  return lines.every(line=>/^Reconnecting\.\.\.\s*\d+\/\d+$/i.test(line)
    ||/^unexpected status\s+\d{3}\s+Bad Gateway\b/i.test(line)
    ||/^Model metadata for .+ not found\. Defaulting to fallback metadata; this can degrade performance and cause issues\.?$/i.test(line));
}

export interface RuntimeConfig { model?:string; effort?:ReasoningEffort; approvalPolicy?:ApprovalPolicy; sandbox?:SandboxMode }
export interface CodexDefaults extends RuntimeConfig { allowDangerFullAccess?:boolean }
export type UserInput=
  | {type:'text';text:string}
  | {type:'image';url:string;name?:string}
  | {type:'localImage';path:string;name?:string}
  | {type:'skill';name:string;path:string}
  | {type:'mention';name:string;path:string};
export interface ModelOption { id:string;model:string;displayName:string;description?:string;isDefault?:boolean;defaultReasoningEffort?:ReasoningEffort;supportedReasoningEfforts:ReasoningEffort[];inputModalities:string[] }
export interface SkillOption { name:string;description:string;path:string;scope?:string;enabled:boolean }
export interface AppOption { id:string;name:string;description?:string;logoUrl?:string;isAccessible:boolean;isEnabled:boolean }
export interface FileSearchResult { path:string;file_name:string;match_type:'file'|'directory';score:number;root:string }

export type RpcId = number | string;
export interface RpcRequest { id: RpcId; method: string; params?: unknown }
export interface RpcNotification { method: string; params?: unknown }
export interface RpcResponse { id: RpcId; result?: unknown; error?: { code?: number; message: string; data?: unknown } }
export interface CodexThread { id:string; preview?:string; name?:string|null; cwd:string; createdAt:number; updatedAt:number; status?:unknown; path?:string|null; turns?:CodexTurn[] }
export interface CodexTurn { id:string; status?:string; items?:CodexItem[]; error?:unknown }
export interface CodexItem { id:string; type:string; text?:string; content?:unknown; command?:string; cwd?:string; status?:string; aggregatedOutput?:string|null; exitCode?:number|null; changes?:unknown; summary?:string[]; [key:string]:unknown }
export interface ThreadListResponse { data:CodexThread[]; nextCursor?:string|null }
export interface ThreadResponse { thread:CodexThread }
export interface TurnResponse { turn:CodexTurn }
export const METHODS = { initialize:'initialize', initialized:'initialized', threadList:'thread/list', threadRead:'thread/read', threadStart:'thread/start', threadResume:'thread/resume', threadArchive:'thread/archive', threadUnarchive:'thread/unarchive', threadNameSet:'thread/name/set', turnStart:'turn/start', turnInterrupt:'turn/interrupt', modelList:'model/list', skillsList:'skills/list', appList:'app/list', configRead:'config/read', fuzzyFileSearch:'fuzzyFileSearch', fsReadDirectory:'fs/readDirectory' } as const;
export const APPROVAL_METHODS = {
  commandExecution:'item/commandExecution/requestApproval',
  fileChange:'item/fileChange/requestApproval',
  permissions:'item/permissions/requestApproval',
  requestUserInput:'item/tool/requestUserInput',
  elicitation:'mcpServer/elicitation/request',
  legacyExec:'execCommandApproval',
  legacyPatch:'applyPatchApproval',
} as const;
export const APPROVAL_KINDS:ReadonlySet<string> = new Set<string>(Object.values(APPROVAL_METHODS));
export type ApprovalDecision = 'accept'|'decline'|'cancel';
export class ApprovalNotSupportedError extends Error { status=422 }
/**
 * Result shapes come from `codex app-server generate-json-schema` (codex-cli
 * 0.147.0). Every server-request family has its own response contract, so the
 * client decision verb must be translated per method instead of echoed back.
 */
export function approvalResult(method:string,decision:ApprovalDecision,answers?:Record<string,string[]>):Record<string,unknown>{
  switch(method){
    case APPROVAL_METHODS.commandExecution:
    case APPROVAL_METHODS.fileChange:
      return {decision};
    case APPROVAL_METHODS.legacyExec:
    case APPROVAL_METHODS.legacyPatch:
      return {decision:decision==='accept'?'approved':decision==='cancel'?'abort':{denied:{rejection:'declined from Codex Remote'}}};
    case APPROVAL_METHODS.elicitation:
      return {action:decision};
    case APPROVAL_METHODS.permissions:
      if(decision==='accept')throw new ApprovalNotSupportedError('granting extra permissions must be done on the Codex host');
      return {permissions:{}};
    case APPROVAL_METHODS.requestUserInput:
      if(decision!=='accept'||!answers)throw new ApprovalNotSupportedError('request_user_input requires answers');
      return {answers:Object.fromEntries(Object.entries(answers).map(([id,values])=>[id,{answers:values}]))};
    default:
      throw new ApprovalNotSupportedError(`unsupported approval request ${method}`);
  }
}
export function record(value:unknown):Record<string,unknown>{return value && typeof value==='object' ? value as Record<string,unknown> : {}}
export function text(value:unknown):string { if(typeof value==='string')return value;if(Array.isArray(value))return value.map(text).filter(Boolean).join('\n');const r=record(value);return text(r.text??r.content??r.message??r.input_text??r.output_text) }

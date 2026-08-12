import { randomUUID } from 'node:crypto';
import type { BridgeEvent,EventType } from '@remote/shared';
import { record,text } from './protocol.js';
export interface RoutedEvent extends Omit<BridgeEvent,'seq'>{raw?:unknown}
export function routeNotification(method:string,params:unknown):RoutedEvent|undefined {const p=record(params),thread=String(p.threadId??record(p.thread).id??'');if(!thread)return undefined;const turn=String(p.turnId??record(p.turn).id??'')||undefined;const item=record(p.item);const itemId=String(p.itemId??item.id??'')||undefined;let type:EventType|undefined,content:string|undefined,metadata:Record<string,unknown>={method,turn_id:turn,item_id:itemId};
 if(method==='item/agentMessage/delta'){type='assistant_delta';content=String(p.delta??'')}
 else if(method==='turn/started')type='turn_started';
 else if(method==='turn/completed'){const status=String(record(p.turn).status??'completed');type=status==='failed'?'turn_failed':'turn_completed';metadata.status=status;metadata.error=record(p.turn).error}
 else if(method==='item/completed'||method==='item/started'){const kind=String(item.type??'');metadata.item_type=kind;metadata.phase=method.endsWith('started')?'started':'completed';if(kind==='agentMessage'){type='assistant_message';content=String(item.text??'')}else if(kind==='commandExecution'){type='command_execution';content=String(item.aggregatedOutput??'');metadata={...metadata,command:item.command,status:item.status,exit_code:item.exitCode,cwd:item.cwd}}else if(kind==='fileChange'){type='file_change';metadata={...metadata,changes:item.changes,status:item.status}}else if(kind==='reasoning'||kind==='plan'){type='reasoning_status';content=text(item.summary??item.text??item.content)}else if(kind==='mcpToolCall'||kind==='collabAgentToolCall'){type='tool_call';content=text(item.result??item.error);metadata={...metadata,server:item.server,tool:item.tool,status:item.status,arguments:item.arguments,duration_ms:item.durationMs}}else if(kind==='webSearch'){type='web_search';content=String(item.query??'');metadata={...metadata,action:item.action}}}
 else if(method.includes('reasoning')||method.includes('plan')){content=String(p.delta??'');if(content.trim())type='reasoning_status';}
 else if(method.includes('compaction'))type='context_compaction';
 else if(method==='error'||method==='warning'||method==='configWarning'){type='provider_error';content=text(p.error??p.message??p);}
 if(!type)return undefined;return {id:randomUUID(),type,session:thread,timestamp:new Date().toISOString(),content,metadata,raw:params}
}

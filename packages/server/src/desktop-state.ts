import { statSync } from 'node:fs';
import { readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import type { ProjectInfo, Session } from '@remote/shared';

interface ProjectAssignment { projectKind?: string; projectId?: string; path?: string; cwd?: string; pendingCoreUpdate?: boolean }
interface ThreadOrder { threadIds?: string[] }

interface DesktopState {
  'local-projects'?: Record<string, { id: string; name: string; rootPaths?: string[]; createdAt?: number; updatedAt?: number }>;
  'project-order'?: string[];
  'thread-project-assignments'?: Record<string, ProjectAssignment>;
  'sidebar-project-thread-orders'?: Record<string, ThreadOrder>;
  'projectless-thread-ids'?: string[];
  'thread-workspace-root-hints'?: Record<string, string>;
  'thread-projectless-output-directories'?: Record<string, string>;
}


export class DesktopStateReader {
  private codexHome: string;
  private statePath: string;
  private dbPath: string;
  private cache: { data: DesktopState; mtime: number } | null = null;
  private tombstoneCache: { ids: Set<string>; mtime: number } | null = null;
  private dbThreadCache: { threads: Array<{ id: string; cwd: string | null; title: string | null; name: string | null; archived: number; created_at_ms: number | null; updated_at_ms: number | null; recency_at_ms: number | null }>; mtime: number } | null = null;

  constructor(codexHome: string) {
    this.codexHome = codexHome;
    this.statePath = join(codexHome, '.codex-global-state.json');
    this.dbPath = join(codexHome, 'state_5.sqlite');
  }

  /**
   * Reads deleted session IDs from .codex-session-delete/backups/*.json.
   * Each backup JSON has a top-level `session_id` field.
   */
  async getDeletedThreadIds(): Promise<Set<string>> {
    const backupsDir = join(dirname(this.codexHome), '.codex-session-delete', 'backups');
    try {
      const st = await stat(backupsDir);
      const mtime = st.mtimeMs;
      if (this.tombstoneCache && this.tombstoneCache.mtime === mtime) return this.tombstoneCache.ids;
      const files = await readdir(backupsDir);
      const ids = new Set<string>();
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await readFile(join(backupsDir, file), 'utf8');
          const data = JSON.parse(raw) as { session_id?: string };
          if (data.session_id) ids.add(data.session_id);
        } catch { /* skip malformed backup */ }
      }
      this.tombstoneCache = { ids, mtime };
      return ids;
    } catch {
      this.tombstoneCache = null;
      return new Set();
    }
  }

  private async load(): Promise<DesktopState> {
    try {
      const raw = await readFile(this.statePath, 'utf8');
      return JSON.parse(raw) as DesktopState;
    } catch {
      return {};
    }
  }

  /**
   * mtime-based cache: only re-reads the file when it has changed on disk.
   * This avoids re-parsing the ~60KB JSON on every API call.
   */
  private async getState(): Promise<DesktopState> {
    try {
      const st = await stat(this.statePath);
      const mtime = st.mtimeMs;
      if (this.cache && this.cache.mtime === mtime) return this.cache.data;
      const data = await this.load();
      this.cache = { data, mtime };
      return data;
    } catch {
      this.cache = null;
      return this.load();
    }
  }

  async registerThread(threadId:string,cwd:string):Promise<boolean>{
    const normalizedCwd=normalizePath(cwd);
    if(!threadId||!isAbsolute(normalizedCwd))return false;
    for(let attempt=0;attempt<3;attempt++){
      let raw:string;
      let beforeMtime=0;
      try{const [content,fileStat]=await Promise.all([readFile(this.statePath,'utf8'),stat(this.statePath)]);raw=content;beforeMtime=fileStat.mtimeMs}catch{return false}
      let data:DesktopState;
      try{data=JSON.parse(raw) as DesktopState}catch{return false}
      const projects=data['local-projects']||{};
      const project=Object.values(projects)
        .flatMap(value=>(value.rootPaths||[]).map(root=>({value,root:normalizePath(root)})))
        .filter(candidate=>containsPath(candidate.root,normalizedCwd))
        .sort((a,b)=>b.root.length-a.root.length)[0]?.value;
      const originalAssignments=data['thread-project-assignments']||{};
      const originalOrders=data['sidebar-project-thread-orders']||{};
      const originalProjectless=data['projectless-thread-ids']||[];
      const originalHints=data['thread-workspace-root-hints']||{};
      if(project&&originalAssignments[threadId]?.projectId===project.id&&originalOrders[project.id]?.threadIds?.[0]===threadId&&normalizePath(originalHints[threadId]||normalizedCwd)===normalizedCwd)return false;
      if(!project&&!originalAssignments[threadId]&&originalProjectless[0]===threadId&&normalizePath(originalHints[threadId]||normalizedCwd)===normalizedCwd)return false;
      const assignments={...originalAssignments};
      const orders=Object.fromEntries(Object.entries(originalOrders).map(([id,order])=>[id,{...order,threadIds:(order.threadIds||[]).filter(value=>value!==threadId)}]));
      const projectless=originalProjectless.filter(value=>value!==threadId);
      const hints={...originalHints};
      hints[threadId]=normalizedCwd;
      if(project){
        const currentOrder=orders[project.id]?.threadIds||[];
        assignments[threadId]={projectKind:'local',projectId:project.id};
        orders[project.id]={...(orders[project.id]||{}),threadIds:[threadId,...currentOrder]};
      }else{
        delete assignments[threadId];
        projectless.unshift(threadId);
      }
      data['thread-project-assignments']=assignments;
      data['sidebar-project-thread-orders']=orders;
      data['projectless-thread-ids']=projectless;
      data['thread-workspace-root-hints']=hints;
      const formatted=raw.includes('\n')?`${JSON.stringify(data,null,2)}\n`:JSON.stringify(data);
      const tempPath=`${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tempPath,formatted,'utf8');
      try{
        if((await stat(this.statePath)).mtimeMs!==beforeMtime){await unlink(tempPath).catch(()=>{});continue}
        await rename(tempPath,this.statePath);
        this.cache=null;
        return true;
      }catch(error){await unlink(tempPath).catch(()=>{});if(attempt===2)throw error}
    }
    return false;
  }

  private getDbMtime(): number {
    let mtime = statSync(this.dbPath).mtimeMs;
    for (const suffix of ['-wal', '-shm']) {
      try { mtime = Math.max(mtime, statSync(this.dbPath + suffix).mtimeMs); } catch { /* optional */ }
    }
    return mtime;
  }

  async getProjectsAsync(): Promise<ProjectInfo[]> {
    const data = await this.getState();
    const projects = data['local-projects'] || {};
    const order = data['project-order'] || [];
    return order
      .map(pid => {
        const p = projects[pid];
        if (!p) return null;
        return { id: p.id, name: p.name, rootPaths: p.rootPaths || [], createdAt: p.createdAt, updatedAt: p.updatedAt } as ProjectInfo;
      })
      .filter((p): p is ProjectInfo => p !== null);
  }

  async getThreadProjectMap(): Promise<Map<string, { projectId: string; projectName: string; cwd?: string }>> {
    const data = await this.getState();
    const projects = data['local-projects'] || {};
    const assignments = data['thread-project-assignments'] || {};
    const sidebarOrders = data['sidebar-project-thread-orders'] || {};

    const result = new Map<string, { projectId: string; projectName: string; cwd?: string }>();

    // From thread-project-assignments
    for (const [threadId, assignment] of Object.entries(assignments)) {
      const pid = assignment.projectId;
      if (!pid) continue;
      const project = projects[pid];
      if (!project) continue;
      result.set(threadId, { projectId: pid, projectName: project.name, cwd: assignment.cwd });
    }

    // From sidebar-project-thread-orders (for threads not in assignments)
    for (const [pid, order] of Object.entries(sidebarOrders)) {
      const project = projects[pid];
      if (!project) continue;
      for (const threadId of order.threadIds || []) {
        if (!result.has(threadId)) {
          result.set(threadId, { projectId: pid, projectName: project.name });
        }
      }
    }

    return result;
  }

  async getProjectRootMap(): Promise<Array<{ projectId: string; projectName: string; rootPath: string }>> {
    const data = await this.getState();
    const projects = data['local-projects'] || {};
    const result: Array<{ projectId: string; projectName: string; rootPath: string }> = [];
    for (const project of Object.values(projects)) {
      for (const rootPath of project.rootPaths || []) {
        result.push({ projectId: project.id, projectName: project.name, rootPath });
      }
    }
    return result;
  }

  /**
   * Returns full thread records from the Codex Desktop SQLite database.
   * Used to include sessions that exist in the DB but have no rollout file
   * and are not tracked by the app-server.
   */
  getDbThreads(): Array<{ id: string; cwd: string | null; title: string | null; name: string | null; archived: number; created_at_ms: number | null; updated_at_ms: number | null; recency_at_ms: number | null }> {
    try {
      const mtime = this.getDbMtime();
      if (this.dbThreadCache && this.dbThreadCache.mtime === mtime) return this.dbThreadCache.threads;
      const db = new Database(this.dbPath, { readonly: true });
      const rows = db.prepare('SELECT id, cwd, title, name, archived, created_at_ms, updated_at_ms, recency_at_ms FROM threads').all();
      db.close();
      this.dbThreadCache = { threads: rows as any, mtime };
      return this.dbThreadCache.threads;
    } catch {
      return [];
    }
  }

  async getProjectlessThreadIds(): Promise<Set<string>> {
    const data = await this.getState();
    return new Set(data['projectless-thread-ids'] || []);
  }

  async getProjectOrder(): Promise<string[]> {
    const data = await this.getState();
    return data['project-order'] || [];
  }

  async getSidebarThreadOrder(): Promise<Map<string, string[]>> {
    const data = await this.getState();
    const result = new Map<string, string[]>();
    const orders = data['sidebar-project-thread-orders'] || {};
    for (const [pid, order] of Object.entries(orders)) {
      result.set(pid, order.threadIds || []);
    }
    return result;
  }

  /**
   * Returns a map of threadId -> cwd for threads that have no project assignment.
   * Source: `thread-workspace-root-hints` in the Codex Desktop global state.
   * These cwds are used to populate the cwd field for projectless/active threads
   * that come from the Codex app-server but have no rollout file.
   */
  async getThreadCwdHints(): Promise<Map<string, string>> {
    const data = await this.getState();
    const hints = data['thread-workspace-root-hints'] || {};
    const result = new Map<string, string>();
    for (const [threadId, cwd] of Object.entries(hints)) {
      if (cwd) result.set(threadId, cwd);
    }
    return result;
  }

  /**
   * Constructs minimal Session objects for projectless threads that exist in
   * the Codex Desktop state. Only threads that are verified as live (present
   * in state_5.sqlite) are included — stale IDs from deleted threads are
   * filtered out. These appear in the "最近" (Recent) group in the sidebar.
   *
   * @param knownSessionIds - Set of session IDs already known from rollouts/app-server.
   *   Threads in this set are skipped to avoid duplicates.
   * @param nameIndex - Map of threadId -> display name from session_index.jsonl.
   */
  async getProjectlessSessions(
    knownSessionIds: Set<string>,
    nameIndex: Map<string, string>,
  ): Promise<Session[]> {
    const data = await this.getState();
    const projectlessIds = data['projectless-thread-ids'] || [];
    const hints = data['thread-workspace-root-hints'] || {};
    const dbThreads = this.getDbThreads();
    const dbThreadById = new Map(dbThreads.map(thread => [thread.id, thread]));
    const hasDbThreadIndex = dbThreads.length > 0;
    const deletedIds = await this.getDeletedThreadIds();
    const result: Session[] = [];
    for (const threadId of projectlessIds) {
      // Skip client-side thread IDs (local: prefix) that are not real threads
      if (threadId.startsWith('local:')) continue;
      if (knownSessionIds.has(threadId)) continue;
      // Skip threads that have been explicitly deleted
      if (deletedIds.has(threadId)) continue;
      const dbThread = dbThreadById.get(threadId);
      if (dbThread?.archived) continue;
      // Skip threads that have been deleted (not in state_5.sqlite)
      if (hasDbThreadIndex && !dbThread) continue;
      const name = nameIndex.get(threadId);
      const cwd = hints[threadId] || '';
      result.push({
        session_id: threadId,
        title: name || `Codex ${threadId}`,
        status: 'active' as const,
        pinned: false,
        cwd,
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
      });
    }
    return result;
  }

  /**
   * Constructs minimal Session objects for project-assigned threads that appear
   * in sidebar-project-thread-orders but were NOT returned by the app-server
   * or rollout files. Codex Desktop still displays them in its sidebar.
   *
   * @param knownSessionIds - Set of session IDs already known from rollouts/app-server.
   * @param nameIndex - Map of threadId -> display name from session_index.jsonl.
   */
  async getSidebarOnlySessions(
    knownSessionIds: Set<string>,
    nameIndex: Map<string, string>,
  ): Promise<Session[]> {
    const data = await this.getState();
    const sidebarOrders = data['sidebar-project-thread-orders'] || {};
    const assignments = data['thread-project-assignments'] || {};
    const projects = data['local-projects'] || {};
    const result: Session[] = [];
    const dbThreads = this.getDbThreads();
    const dbThreadById = new Map(dbThreads.map(thread => [thread.id, thread]));
    const hasDbThreadIndex = dbThreads.length > 0;
    const deletedIds = await this.getDeletedThreadIds();

    for (const [pid, order] of Object.entries(sidebarOrders)) {
      const project = projects[pid];
      if (!project) continue;
      for (const threadId of order.threadIds || []) {
        if (knownSessionIds.has(threadId)) continue;
        if (deletedIds.has(threadId)) continue;
        const assignment = assignments[threadId];
        const dbThread = dbThreadById.get(threadId);
        if (dbThread?.archived) continue;
        // A sidebar-only ID with no backing DB thread is a stale sidebar entry:
        // it was deleted or never materialized, has no cwd or rollout, and so
        // cannot be authorized or rendered correctly. When the DB index is
        // available, drop these instead of surfacing them as "Codex <id>" ghosts.
        if (hasDbThreadIndex && !dbThread) continue;
        const name = nameIndex.get(threadId);
        const cwd = assignment?.cwd || assignment?.path || project.rootPaths?.[0] || '';
        result.push({
          session_id: threadId,
          title: name || `Codex ${threadId}`,
          status: 'active' as const,
          pinned: false,
          cwd,
          created_at: new Date(0).toISOString(),
          updated_at: new Date(0).toISOString(),
          ...(project.id ? { project_id: project.id, project_name: project.name } : {}),
        });
      }
    }
    return result;
  }
}

function normalizePath(value:string){return resolve(value.replace(/^\\\\\?\\/,''))}
function containsPath(root:string,candidate:string){const value=relative(root,candidate);return value===''||value!=='..'&&!value.startsWith(`..${sep}`)&&!isAbsolute(value)}

#!/usr/bin/env python3
"""Remove archived and deleted Codex Desktop conversations after Codex is closed."""

from __future__ import annotations

import argparse
import gzip
import json
import os
import shutil
import sqlite3
import sys
import time
from collections.abc import Iterable
from datetime import datetime
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Remove archived/deleted Codex Desktop conversations from local list sources."
    )
    parser.add_argument("--dry-run", action="store_true", help="Report changes without writing files.")
    parser.add_argument(
        "--keep-rollouts",
        action="store_true",
        help="Keep matching rollout files under .codex/sessions instead of moving them to the backup.",
    )
    return parser.parse_args()


def require_file(path: Path) -> None:
    if not path.is_file():
        raise RuntimeError(f"Required file is missing: {path}")


def atomic_write(path: Path, content: str) -> None:
    temporary = path.with_name(f".{path.name}.cleanup-{os.getpid()}-{time.time_ns()}")
    temporary.write_text(content, encoding="utf-8")
    os.replace(temporary, path)


def backup_sqlite(source_path: Path, destination_path: Path) -> None:
    source = sqlite3.connect(source_path)
    destination = sqlite3.connect(destination_path)
    try:
        source.backup(destination)
    finally:
        destination.close()
        source.close()


def backup_sources(codex_home: Path, backup_dir: Path) -> None:
    backup_dir.mkdir(parents=True, exist_ok=False)
    for filename in (".codex-global-state.json", "session_index.jsonl", "history.jsonl"):
        source = codex_home / filename
        if source.is_file():
            shutil.copy2(source, backup_dir / filename)
    process_manager = codex_home / "process_manager" / "chat_processes.json"
    if process_manager.is_file():
        destination = backup_dir / "process_manager" / "chat_processes.json"
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(process_manager, destination)
    for filename in ("state_5.sqlite", "thread_history_1.sqlite"):
        source = codex_home / filename
        if source.is_file():
            backup_sqlite(source, backup_dir / filename)


def read_deleted_ids(backups_dir: Path) -> set[str]:
    if not backups_dir.is_dir():
        return set()
    result: set[str] = set()
    for backup_path in backups_dir.glob("*.json"):
        try:
            data = json.loads(backup_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        session_id = data.get("session_id") if isinstance(data, dict) else None
        if isinstance(session_id, str) and session_id:
            result.add(session_id)
    return result


def read_archived_ids(state_db_path: Path) -> set[str]:
    connection = sqlite3.connect(state_db_path)
    try:
        return {
            row[0]
            for row in connection.execute("SELECT id FROM threads WHERE COALESCE(archived, 0) <> 0")
            if isinstance(row[0], str)
        }
    finally:
        connection.close()


def read_current_thread_ids(state_db_path: Path) -> set[str]:
    connection = sqlite3.connect(state_db_path)
    try:
        return {
            row[0]
            for row in connection.execute("SELECT id FROM threads WHERE id IS NOT NULL")
            if isinstance(row[0], str) and row[0]
        }
    finally:
        connection.close()


def read_previous_archived_ids(repair_root: Path) -> set[str]:
    if not repair_root.is_dir():
        return set()
    result: set[str] = set()
    for state_db_path in repair_root.glob("*/state_5.sqlite"):
        try:
            result.update(read_archived_ids(state_db_path))
        except sqlite3.Error:
            continue
    return result


def prune_list(value: Any, hidden_ids: set[str]) -> tuple[Any, int]:
    if not isinstance(value, list):
        return value, 0
    retained = [item for item in value if item not in hidden_ids]
    return retained, len(value) - len(retained)


def prune_map(value: Any, hidden_ids: set[str]) -> int:
    if not isinstance(value, dict):
        return 0
    removed = 0
    for thread_id in list(value):
        if thread_id in hidden_ids:
            del value[thread_id]
            removed += 1
    return removed


def clean_global_state(state_path: Path, hidden_ids: set[str], dry_run: bool) -> int:
    state = json.loads(state_path.read_text(encoding="utf-8"))
    if not isinstance(state, dict):
        raise RuntimeError(f"Global state is not a JSON object: {state_path}")
    removed = 0
    state["projectless-thread-ids"], count = prune_list(state.get("projectless-thread-ids"), hidden_ids)
    removed += count
    sidebar_orders = state.get("sidebar-project-thread-orders")
    if isinstance(sidebar_orders, dict):
        for order in sidebar_orders.values():
            if isinstance(order, dict):
                order["threadIds"], count = prune_list(order.get("threadIds"), hidden_ids)
                removed += count
    for key in (
        "thread-project-assignments",
        "thread-workspace-root-hints",
        "thread-projectless-output-directories",
    ):
        removed += prune_map(state.get(key), hidden_ids)
    electron_state = state.get("electron-persisted-atom-state")
    if isinstance(electron_state, dict):
        for key in ("heartbeat-thread-permissions-by-id", "prompt-history"):
            removed += prune_map(electron_state.get(key), hidden_ids)
    if removed and not dry_run:
        atomic_write(state_path, json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    return removed


def clean_jsonl(path: Path, id_key: str, hidden_ids: set[str], dry_run: bool) -> int:
    if not path.is_file():
        return 0
    original = path.read_text(encoding="utf-8")
    newline = "\r\n" if "\r\n" in original else "\n"
    retained: list[str] = []
    removed = 0
    for line in original.splitlines():
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            retained.append(line)
            continue
        if isinstance(entry, dict) and entry.get(id_key) in hidden_ids:
            removed += 1
            continue
        retained.append(line)
    if removed and not dry_run:
        atomic_write(path, (newline.join(retained) + newline) if retained else "")
    return removed


def remove_hidden_process_entries(value: Any, hidden_ids: set[str]) -> tuple[Any, int]:
    if isinstance(value, list):
        retained = []
        removed = 0
        for entry in value:
            cleaned, count = remove_hidden_process_entries(entry, hidden_ids)
            removed += count
            if cleaned is not None:
                retained.append(cleaned)
        return retained, removed
    if isinstance(value, dict):
        if value.get("conversationId") in hidden_ids:
            return None, 1
        removed = 0
        cleaned: dict[str, Any] = {}
        for key, entry in value.items():
            next_entry, count = remove_hidden_process_entries(entry, hidden_ids)
            removed += count
            if next_entry is not None:
                cleaned[key] = next_entry
        return cleaned, removed
    return value, 0


def clean_process_manager(path: Path, hidden_ids: set[str], dry_run: bool) -> int:
    if not path.is_file():
        return 0
    value = json.loads(path.read_text(encoding="utf-8"))
    cleaned, removed = remove_hidden_process_entries(value, hidden_ids)
    if removed and not dry_run:
        atomic_write(path, json.dumps(cleaned, ensure_ascii=False, indent=2) + "\n")
    return removed


def read_process_manager_conversation_ids(path: Path) -> set[str]:
    if not path.is_file():
        return set()
    value = json.loads(path.read_text(encoding="utf-8"))
    result: set[str] = set()

    def walk(entry: Any) -> None:
        if isinstance(entry, list):
            for child in entry:
                walk(child)
        elif isinstance(entry, dict):
            conversation_id = entry.get("conversationId")
            if isinstance(conversation_id, str) and conversation_id:
                result.add(conversation_id)
            for child in entry.values():
                walk(child)

    walk(value)
    return result


def table_has_column(connection: sqlite3.Connection, table: str, column: str) -> bool:
    return any(row[1] == column for row in connection.execute(f'PRAGMA table_info("{table}")'))


def delete_ids(connection: sqlite3.Connection, table: str, column: str, thread_ids: Iterable[str]) -> int:
    if not table_has_column(connection, table, column):
        return 0
    values = list(thread_ids)
    if not values:
        return 0
    removed = 0
    for start in range(0, len(values), 900):
        batch = values[start : start + 900]
        placeholders = ",".join("?" for _ in batch)
        removed += connection.execute(
            f'DELETE FROM "{table}" WHERE "{column}" IN ({placeholders})', batch
        ).rowcount
    return removed


def clean_state_database(state_db_path: Path, deleted_ids: set[str], hidden_ids: set[str], dry_run: bool) -> int:
    connection = sqlite3.connect(state_db_path)
    try:
        if dry_run:
            query = "SELECT COUNT(*) FROM threads WHERE COALESCE(archived, 0) <> 0"
            archived = connection.execute(query).fetchone()[0]
            existing_deleted = connection.execute(
                f"SELECT COUNT(*) FROM threads WHERE id IN ({','.join('?' for _ in deleted_ids)})",
                list(deleted_ids),
            ).fetchone()[0] if deleted_ids else 0
            return archived + existing_deleted
        with connection:
            removed = 0
            removed += delete_ids(connection, "thread_dynamic_tools", "thread_id", hidden_ids)
            removed += delete_ids(connection, "thread_spawn_edges", "parent_thread_id", hidden_ids)
            removed += delete_ids(connection, "thread_spawn_edges", "child_thread_id", hidden_ids)
            removed += delete_ids(connection, "threads", "id", hidden_ids)
        return removed
    finally:
        connection.close()


def clean_thread_history(history_db_path: Path, hidden_ids: set[str], dry_run: bool) -> int:
    if not history_db_path.is_file():
        return 0
    connection = sqlite3.connect(history_db_path)
    try:
        tables = ("thread_turns", "thread_items", "thread_history_projection_state")
        if dry_run:
            total = 0
            for table in tables:
                if not table_has_column(connection, table, "thread_id") or not hidden_ids:
                    continue
                placeholders = ",".join("?" for _ in hidden_ids)
                total += connection.execute(
                    f'SELECT COUNT(*) FROM "{table}" WHERE thread_id IN ({placeholders})', list(hidden_ids)
                ).fetchone()[0]
            return total
        with connection:
            return sum(delete_ids(connection, table, "thread_id", hidden_ids) for table in tables)
    finally:
        connection.close()


def rollout_session_id(path: Path) -> str | None:
    try:
        opener = gzip.open if path.name.lower().endswith(".gz") else open
        with opener(path, "rt", encoding="utf-8") as stream:
            for _ in range(100):
                line = stream.readline()
                if not line:
                    break
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("type") != "session_meta" or not isinstance(entry.get("payload"), dict):
                    continue
                payload = entry["payload"]
                for key in ("id", "session_id", "thread_id"):
                    value = payload.get(key)
                    if isinstance(value, str) and value:
                        return value
    except (OSError, UnicodeDecodeError):
        return None
    return None


def clean_rollouts(rollout_roots: dict[str, Path], backup_dir: Path, hidden_ids: set[str], dry_run: bool) -> tuple[int, int]:
    moved = 0
    unsupported = 0
    for root_name, rollout_root in rollout_roots.items():
        if not rollout_root.is_dir():
            continue
        for rollout in rollout_root.rglob("rollout-*.jsonl*"):
            if rollout.name.lower().endswith(".zst"):
                unsupported += 1
                continue
            if rollout_session_id(rollout) not in hidden_ids:
                continue
            moved += 1
            if not dry_run:
                destination = backup_dir / "rollouts" / root_name / rollout.relative_to(rollout_root)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(rollout), str(destination))
    return moved, unsupported


def state_reference_count(state_path: Path, hidden_ids: set[str]) -> int:
    state = json.loads(state_path.read_text(encoding="utf-8"))
    values: list[str] = []
    values.extend(state.get("projectless-thread-ids") or [])
    for order in (state.get("sidebar-project-thread-orders") or {}).values():
        if isinstance(order, dict):
            values.extend(order.get("threadIds") or [])
    for key in (
        "thread-project-assignments",
        "thread-workspace-root-hints",
        "thread-projectless-output-directories",
    ):
        values.extend((state.get(key) or {}).keys())
    electron_state = state.get("electron-persisted-atom-state") or {}
    if isinstance(electron_state, dict):
        for key in ("heartbeat-thread-permissions-by-id", "prompt-history"):
            values.extend((electron_state.get(key) or {}).keys())
    return sum(value in hidden_ids for value in values)


def process_manager_reference_count(path: Path, hidden_ids: set[str]) -> int:
    if not path.is_file():
        return 0
    value = json.loads(path.read_text(encoding="utf-8"))
    count = 0

    def walk(entry: Any) -> None:
        nonlocal count
        if isinstance(entry, list):
            for child in entry:
                walk(child)
        elif isinstance(entry, dict):
            if entry.get("conversationId") in hidden_ids:
                count += 1
            for child in entry.values():
                walk(child)

    walk(value)
    return count


def main() -> int:
    args = parse_args()
    codex_home = Path.home() / ".codex"
    state_path = codex_home / ".codex-global-state.json"
    state_db_path = codex_home / "state_5.sqlite"
    index_path = codex_home / "session_index.jsonl"
    history_path = codex_home / "history.jsonl"
    thread_history_db_path = codex_home / "thread_history_1.sqlite"
    rollout_roots = {
        "sessions": codex_home / "sessions",
        "archived_sessions": codex_home / "archived_sessions",
    }
    process_manager_path = codex_home / "process_manager" / "chat_processes.json"
    deleted_root = codex_home.parent / ".codex-session-delete"
    deleted_backups_dir = deleted_root / "backups"
    repair_root = deleted_root / "repair-backups"
    require_file(state_path)
    require_file(state_db_path)

    deleted_ids = read_deleted_ids(deleted_backups_dir)
    archived_ids = read_archived_ids(state_db_path)
    previous_archived_ids = read_previous_archived_ids(repair_root)
    current_thread_ids = read_current_thread_ids(state_db_path)
    process_manager_ids = read_process_manager_conversation_ids(process_manager_path)
    stale_process_manager_ids = process_manager_ids - current_thread_ids
    hidden_ids = deleted_ids | archived_ids | previous_archived_ids | stale_process_manager_ids
    if not hidden_ids:
        print("No archived, deleted, or stale Codex conversations were found.")
        return 0

    timestamp = datetime.now().strftime("manual-cleanup-%Y%m%d-%H%M%S")
    backup_dir = repair_root / timestamp
    if not args.dry_run:
        backup_sources(codex_home, backup_dir)

    summary = {
        "archivedThreadIds": len(archived_ids),
        "previousArchivedThreadIds": len(previous_archived_ids),
        "deletedThreadIds": len(deleted_ids),
        "staleProcessManagerThreadIds": len(stale_process_manager_ids),
        "hiddenThreadIds": len(hidden_ids),
        "globalStateReferencesRemoved": clean_global_state(state_path, hidden_ids, args.dry_run),
        "sessionIndexRowsRemoved": clean_jsonl(index_path, "id", hidden_ids, args.dry_run),
        "historyRowsRemoved": clean_jsonl(history_path, "session_id", hidden_ids, args.dry_run),
        "processManagerEntriesRemoved": clean_process_manager(process_manager_path, hidden_ids, args.dry_run),
        "stateDatabaseRowsRemoved": clean_state_database(state_db_path, deleted_ids, hidden_ids, args.dry_run),
        "threadHistoryRowsRemoved": clean_thread_history(thread_history_db_path, hidden_ids, args.dry_run),
    }
    if args.keep_rollouts:
        summary["rolloutFilesMoved"] = 0
        summary["zstdRolloutsSkipped"] = 0
    else:
        moved, skipped = clean_rollouts(rollout_roots, backup_dir, hidden_ids, args.dry_run)
        summary["rolloutFilesMoved"] = moved
        summary["zstdRolloutsSkipped"] = skipped

    if not args.dry_run:
        connection = sqlite3.connect(state_db_path)
        try:
            summary["stateDatabaseIntegrity"] = connection.execute("PRAGMA integrity_check").fetchone()[0]
            summary["remainingArchivedRows"] = connection.execute(
                "SELECT COUNT(*) FROM threads WHERE COALESCE(archived, 0) <> 0"
            ).fetchone()[0]
            summary["remainingDeletedRows"] = connection.execute(
                f"SELECT COUNT(*) FROM threads WHERE id IN ({','.join('?' for _ in deleted_ids)})",
                list(deleted_ids),
            ).fetchone()[0] if deleted_ids else 0
        finally:
            connection.close()
        summary["remainingHiddenStateReferences"] = state_reference_count(state_path, hidden_ids)
        summary["remainingHiddenProcessManagerReferences"] = process_manager_reference_count(
            process_manager_path, hidden_ids
        )
        summary["backupDir"] = str(backup_dir)

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Cleanup failed: {error}", file=sys.stderr)
        raise SystemExit(1)

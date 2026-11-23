import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export interface D1Row {
  [key: string]: unknown;
}

export interface D1PreparedStatement {
  bind(...params: unknown[]): D1PreparedStatement;
  first<T = D1Row>(): Promise<T | null>;
  all<T = D1Row>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta: { changes: number | bigint; last_row_id: number | bigint } }>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  exec(sql: string): void;
}

function toSqlValue(v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Uint8Array) return v;
  return String(v);
}

export function createLocalD1(dbPath?: string): D1Database {
  let sqlite: DatabaseSync;
  const target = dbPath ?? path.join(process.cwd(), '.data', 'termufix.sqlite');
  try {
    if (target !== ':memory:') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
    }
    sqlite = new DatabaseSync(target);
  } catch {
    sqlite = new DatabaseSync(':memory:');
  }

  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA busy_timeout = 5000;');

  function makePrepared(sql: string, bound: SQLInputValue[] = []): D1PreparedStatement {
    const stmt = sqlite.prepare(sql);
    return {
      bind(...params: unknown[]) {
        return makePrepared(sql, params.map(toSqlValue));
      },
      async first<T = D1Row>(): Promise<T | null> {
        const row = stmt.get(...bound) as T | undefined;
        return row ?? null;
      },
      async all<T = D1Row>(): Promise<{ results: T[] }> {
        const rows = stmt.all(...bound) as T[];
        return { results: rows };
      },
      async run() {
        const res = stmt.run(...bound);
        return {
          success: true,
          meta: {
            changes: res.changes,
            last_row_id: res.lastInsertRowid,
          },
        };
      },
    };
  }

  return {
    prepare(sql: string) {
      return makePrepared(sql);
    },
    exec(sql: string) {
      sqlite.exec(sql);
    },
  };
}

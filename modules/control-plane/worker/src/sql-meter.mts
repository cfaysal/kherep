// Counts the SQLite rows a Durable Object reads and writes (issue #308).
// Durable Object SQLite storage is billed by rows read and rows written; every
// cursor reports both in rowsRead and rowsWritten, which grow while the cursor
// is consumed (toArray, one, iteration).
// https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#cursor

export interface SqlRows { rowsRead: number; rowsWritten: number }

type Cursor = SqlStorageCursor<Record<string, SqlStorageValue>>;

export class SqlMeter {
  // The storage to hand to the stores: exec is counted, the rest passes through.
  readonly sql: SqlStorage;
  private readonly totals: SqlRows = { rowsRead: 0, rowsWritten: 0 };
  private cursors: Cursor[] = [];
  private depth = 0;

  constructor(raw: SqlStorage) {
    const exec = (query: string, ...bindings: unknown[]): Cursor => {
      const cursor = raw.exec(query, ...bindings);
      this.cursors.push(cursor);
      return cursor;
    };
    this.sql = new Proxy(raw, {
      get: (target, key) => {
        if (key === "exec") return exec;
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  // Runs one request path and logs the rows its cursors read and wrote. run
  // must be synchronous: a Durable Object runs one synchronous segment at a
  // time, so every cursor opened in it belongs to this request and no row is
  // counted twice. A nested call (one Registry method calling another) counts
  // toward the outer path. SQL outside any measured path, such as the schema
  // set-up in a constructor, counts only toward the totals.
  measure<T>(path: string, run: () => T): T {
    if (this.depth > 0) return run();
    this.settle();
    this.depth++;
    try {
      return run();
    } finally {
      this.depth--;
      console.log({ event: "registry.sql", path, ...this.settle() });
    }
  }

  // Rows read and written since this object was constructed.
  stats(): SqlRows {
    this.settle();
    return { ...this.totals };
  }

  private settle(): SqlRows {
    const rows: SqlRows = { rowsRead: 0, rowsWritten: 0 };
    for (const cursor of this.cursors) {
      rows.rowsRead += cursor.rowsRead;
      rows.rowsWritten += cursor.rowsWritten;
    }
    this.cursors = [];
    this.totals.rowsRead += rows.rowsRead;
    this.totals.rowsWritten += rows.rowsWritten;
    return rows;
  }
}

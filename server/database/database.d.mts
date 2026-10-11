export interface DatabaseResult<T = Record<string, unknown>> {
  success: boolean;
  results: T[];
  meta: {
    duration: number;
    changes: number;
    last_row_id: number;
    rows_read: number;
    rows_written: number;
  };
}

export interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<DatabaseResult<T>>;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<DatabaseResult<T>>;
  raw(options?: { columnNames?: boolean }): Promise<unknown[][]>;
}

export interface Database {
  readonly dialect: 'postgres';
  prepare(query: string): PreparedStatement;
  batch<T = Record<string, unknown>>(statements: PreparedStatement[]): Promise<Array<DatabaseResult<T>>>;
  exec(query: string): Promise<{ count: number; duration: number }>;
  transaction<T>(work: (database: Database) => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>;
  close(): void | Promise<void>;
}

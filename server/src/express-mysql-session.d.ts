declare module 'express-mysql-session' {
  import type { Store } from 'express-session';
  interface MySQLSessionOptions {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    clearExpired?: boolean;
    expiration?: number;
    createDatabaseTable?: boolean;
  }
  interface MySQLSessionStore extends Store {
    onReady(): Promise<void>;
    close(): Promise<void>;
  }
  function connectMySQLSession(session: typeof import('express-session')): new (options: MySQLSessionOptions) => MySQLSessionStore;
  export = connectMySQLSession;
}

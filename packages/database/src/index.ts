/** No provider is registered until an adapter is implemented. */
export const DATABASE = Symbol('faultline.database');

export interface Entity {
  id: string;
}

export interface Repository<T extends Entity> {
  findById(id: string): Promise<T | null>;
  /** Persist the entity by ID (insert or replace). */
  save(entity: T): Promise<void>;
  /** Return whether an entity was removed. */
  deleteById(id: string): Promise<boolean>;
}

/** Lifecycle and repository boundary only; no connection or storage implementation. */
export interface Database {
  connect(): Promise<void>;
  repository<T extends Entity>(name: string): Repository<T>;
  disconnect(): Promise<void>;
}

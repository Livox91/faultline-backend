import type { PostgresConnection } from './index';

/**
 * A project, as the API presents it.
 *
 * A project *is* a cluster: `clusters` is the table the whole control plane already
 * keys incidents, baselines and telemetry by, so assignment at this level authorizes
 * every existing read path by a column those queries already carry. The name kept here
 * is "project" because that is the word the product and the UI use.
 */
export interface RegisteredCluster {
  id: string;
  name: string;
  environment: string;
  kubernetesContext?: string;
  workloadNamespace?: string;
  workloadSelector?: string;
  createdAt: string;
  updatedAt: string;
  total: number;
  open: number;
  critical: number;
  lastSeen?: string;
  /** Engineers assigned to this project. Only populated for admin reads. */
  assignedUserIds?: readonly string[];
}

export interface ProjectChanges {
  name?: string;
  environment?: string;
  kubernetesContext?: string | null;
  workloadNamespace?: string | null;
  workloadSelector?: string | null;
}

export interface NewProject extends ProjectChanges {
  id: string;
  name: string;
}

/**
 * Project reads and writes.
 *
 * `list` takes the ids a caller may see rather than filtering afterwards: the
 * restriction belongs in the SQL, so a forgotten `.filter()` in a controller cannot
 * leak a row. `undefined` means unrestricted and is only ever passed for an Admin.
 */
export interface ClusterDirectory {
  list(projectIds?: readonly string[]): Promise<readonly RegisteredCluster[]>;
  get(id: string): Promise<RegisteredCluster | undefined>;
  create(project: NewProject): Promise<RegisteredCluster>;
  update(
    id: string,
    changes: ProjectChanges,
  ): Promise<RegisteredCluster | undefined>;
  remove(id: string): Promise<boolean>;
}

interface ClusterRow {
  id: string;
  name: string;
  environment: string;
  kubernetes_context: string | null;
  workload_namespace: string | null;
  workload_selector: string | null;
  created_at: Date;
  updated_at: Date;
  total: string;
  open: string;
  critical: string;
  last_seen: Date | null;
  assigned_user_ids: string[] | null;
}

const present = (row: ClusterRow): RegisteredCluster => ({
  id: row.id,
  name: row.name,
  environment: row.environment,
  ...(row.kubernetes_context ? { kubernetesContext: row.kubernetes_context } : {}),
  ...(row.workload_namespace ? { workloadNamespace: row.workload_namespace } : {}),
  ...(row.workload_selector ? { workloadSelector: row.workload_selector } : {}),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  total: Number(row.total),
  open: Number(row.open),
  critical: Number(row.critical),
  ...(row.last_seen ? { lastSeen: row.last_seen.toISOString() } : {}),
  assignedUserIds: row.assigned_user_ids ?? [],
});

const selectClusters = `
  SELECT c.id, COALESCE(c.name, c.id) AS name, c.environment,
         c.kubernetes_context, c.workload_namespace, c.workload_selector,
         c.created_at, c.updated_at,
         count(i.id)::text AS total,
         count(i.id) FILTER (WHERE i.status <> 'RESOLVED')::text AS open,
         count(i.id) FILTER (WHERE i.severity = 'CRITICAL')::text AS critical,
         max(i.last_seen) AS last_seen,
         COALESCE(
           (SELECT array_agg(pu.user_id::text ORDER BY pu.assigned_at)
              FROM project_users pu WHERE pu.project_id = c.id),
           '{}'::text[]
         ) AS assigned_user_ids
    FROM clusters c
    LEFT JOIN incidents i ON i.cluster_id = c.id`;

export class PostgresClusterDirectory implements ClusterDirectory {
  constructor(private readonly connection: PostgresConnection) {}

  async list(
    projectIds?: readonly string[],
  ): Promise<readonly RegisteredCluster[]> {
    // An engineer with no assignments is restricted to the empty set, never to
    // "unrestricted": the difference between [] and undefined is the whole check.
    if (projectIds && projectIds.length === 0) return [];
    const result = await this.connection.pool.query<ClusterRow>(
      `${selectClusters}
        ${projectIds ? 'WHERE c.id = ANY($1::text[])' : ''}
        GROUP BY c.id
        ORDER BY COALESCE(c.name, c.id), c.id`,
      projectIds ? [[...projectIds]] : [],
    );
    return result.rows.map(present);
  }

  async get(id: string): Promise<RegisteredCluster | undefined> {
    const result = await this.connection.pool.query<ClusterRow>(
      `${selectClusters} WHERE c.id = $1 GROUP BY c.id`,
      [id],
    );
    return result.rows[0] ? present(result.rows[0]) : undefined;
  }

  async create(project: NewProject): Promise<RegisteredCluster> {
    await this.connection.pool.query(
      `INSERT INTO clusters (id, name, environment, kubernetes_context, workload_namespace, workload_selector)
       VALUES ($1, $2, COALESCE($3, 'production'), $4, $5, $6)`,
      [
        project.id,
        project.name,
        project.environment ?? null,
        project.kubernetesContext ?? null,
        project.workloadNamespace ?? null,
        project.workloadSelector ?? null,
      ],
    );
    return (await this.get(project.id))!;
  }

  async update(
    id: string,
    changes: ProjectChanges,
  ): Promise<RegisteredCluster | undefined> {
    const result = await this.connection.pool.query(
      `UPDATE clusters SET
         name = COALESCE($2, name),
         environment = COALESCE($3, environment),
         kubernetes_context = COALESCE($4, kubernetes_context),
         workload_namespace = COALESCE($5, workload_namespace),
         workload_selector = COALESCE($6, workload_selector),
         updated_at = now()
       WHERE id = $1`,
      [
        id,
        changes.name ?? null,
        changes.environment ?? null,
        changes.kubernetesContext ?? null,
        changes.workloadNamespace ?? null,
        changes.workloadSelector ?? null,
      ],
    );
    return (result.rowCount ?? 0) > 0 ? this.get(id) : undefined;
  }

  /**
   * Deletes the project and, by cascade, its assignments.
   *
   * Incidents reference `clusters(id)` without a cascade, so a project that has
   * recorded history refuses to delete (foreign-key violation) rather than taking the
   * incident record with it. The controller turns that into a 409.
   */
  async remove(id: string): Promise<boolean> {
    const result = await this.connection.pool.query(
      `DELETE FROM clusters WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

/** PostgreSQL reports a foreign-key violation with SQLSTATE 23503. */
export function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23503'
  );
}

/** And a duplicate primary key with 23505. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  );
}

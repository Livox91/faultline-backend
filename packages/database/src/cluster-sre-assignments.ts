import type {
  ClusterSreAssignment,
  ClusterSreAssignmentRepository,
} from '@faultline/notifications';
import type { PostgresConnection } from './index';

interface AssignmentRow {
  cluster_id: string;
  user_id: string;
  assigned_by: string | null;
  assigned_at: Date;
}

const present = (row: AssignmentRow): ClusterSreAssignment => ({
  clusterId: row.cluster_id,
  userId: row.user_id,
  ...(row.assigned_by ? { assignedBy: row.assigned_by } : {}),
  assignedAt: row.assigned_at.toISOString(),
});

export class PostgresClusterSreAssignmentRepository
  implements ClusterSreAssignmentRepository
{
  constructor(private readonly db: PostgresConnection) {}

  async listForCluster(clusterId: string) {
    const result = await this.db.pool.query<AssignmentRow>(
      `SELECT cluster_id, user_id, assigned_by, assigned_at
         FROM cluster_sre_assignments
        WHERE cluster_id=$1
        ORDER BY assigned_at, user_id`,
      [clusterId],
    );
    return result.rows.map(present);
  }

  async assign(clusterId: string, userId: string, assignedBy: string) {
    const result = await this.db.pool.query<AssignmentRow>(
      `INSERT INTO cluster_sre_assignments
         (cluster_id, user_id, assigned_by)
       SELECT c.id, u.id, $3::uuid
         FROM clusters c
         JOIN users u ON u.id=$2::uuid
        WHERE c.id=$1
          AND c.organization_id=u.organization_id
          AND u.role='onsiteengineer'
          AND u.status='active'
       ON CONFLICT (cluster_id, user_id) DO UPDATE SET
         assigned_by=EXCLUDED.assigned_by,
         assigned_at=now()
       RETURNING cluster_id, user_id, assigned_by, assigned_at`,
      [clusterId, userId, assignedBy],
    );
    return result.rows[0] ? present(result.rows[0]) : undefined;
  }

  async remove(clusterId: string, userId: string) {
    const result = await this.db.pool.query(
      `DELETE FROM cluster_sre_assignments
        WHERE cluster_id=$1 AND user_id=$2::uuid`,
      [clusterId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

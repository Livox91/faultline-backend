import { Controller, Get, Header, Inject } from '@nestjs/common';

export const CLUSTER_DIRECTORY = Symbol('faultline.cluster-directory');

export interface RegisteredCluster {
  id: string;
  name: string;
  kubernetesContext?: string;
  workloadNamespace?: string;
  workloadSelector?: string;
  createdAt: string;
  updatedAt: string;
  total: number;
  open: number;
  critical: number;
  lastSeen?: string;
}

export interface ClusterDirectory {
  list(): Promise<readonly RegisteredCluster[]>;
}

@Controller('clusters')
export class ClustersController {
  constructor(
    @Inject(CLUSTER_DIRECTORY) private readonly clusters: ClusterDirectory,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list() {
    return this.clusters.list();
  }
}

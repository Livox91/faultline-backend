import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';

export type ClusterOnboardingStatus = 'running' | 'succeeded' | 'failed';

export interface ClusterOnboardingJob {
  id: string;
  operation: 'onboard' | 'uninstall';
  clusterName?: string;
  controlPlaneIp?: string;
  clusterId?: string;
  status: ClusterOnboardingStatus;
  output: readonly string[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

interface StoredClusterOnboardingJob extends ClusterOnboardingJob {
  ownerUserId: string;
}

/**
 * Runs the existing operator-grade onboarding command without holding an HTTP request
 * open for its several-minute Kubernetes verification cycle.
 */
@Injectable()
export class ClusterOnboardingService {
  private readonly jobs = new Map<string, StoredClusterOnboardingJob>();
  private activeJobId?: string;

  start(
    clusterName: string,
    controlPlaneIp: string,
    ownerUserId: string,
  ): ClusterOnboardingJob {
    const active = this.activeJobId ? this.jobs.get(this.activeJobId) : undefined;
    if (active?.status === 'running')
      throw new Error('A cluster onboarding job is already running');

    const id = randomUUID();
    const job: StoredClusterOnboardingJob = {
      id,
      ownerUserId,
      operation: 'onboard',
      clusterName,
      controlPlaneIp,
      status: 'running',
      output: [],
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(id, job);
    this.activeJobId = id;

    const repositoryRoot = resolve(__dirname, '../../..');
    const child = spawn(
      process.execPath,
      [
        resolve(repositoryRoot, 'scripts/cluster.cjs'),
        'onboard',
        '--yes',
        '--name',
        clusterName,
        '--control-plane',
        controlPlaneIp,
        '--owner-user-id',
        ownerUserId,
      ],
      { cwd: repositoryRoot, env: process.env, windowsHide: true },
    );
    this.capture(child, job);
    return this.present(job);
  }

  uninstall(clusterId: string, ownerUserId: string): ClusterOnboardingJob {
    const active = this.activeJobId ? this.jobs.get(this.activeJobId) : undefined;
    if (active?.status === 'running')
      throw new Error('A cluster operation is already running');

    const id = randomUUID();
    const job: StoredClusterOnboardingJob = {
      id,
      ownerUserId,
      operation: 'uninstall',
      clusterId,
      status: 'running',
      output: [],
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(id, job);
    this.activeJobId = id;

    const repositoryRoot = resolve(__dirname, '../../..');
    const child = spawn(
      process.execPath,
      [
        resolve(repositoryRoot, 'scripts/cluster.cjs'),
        'uninstall',
        '--id',
        clusterId,
      ],
      { cwd: repositoryRoot, env: process.env, windowsHide: true },
    );
    this.capture(child, job);
    return this.present(job);
  }

  get(id: string, ownerUserId: string): ClusterOnboardingJob | undefined {
    const job = this.jobs.get(id);
    return job?.ownerUserId === ownerUserId ? this.present(job) : undefined;
  }

  private capture(child: ChildProcessWithoutNullStreams, job: StoredClusterOnboardingJob) {
    const append = (chunk: Buffer) => {
      const lines = chunk
        .toString('utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const output = [...job.output, ...lines].slice(-120);
      this.jobs.set(job.id, { ...job, output });
      job.output = output;
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', (error) => this.finish(job, 'failed', error.message));
    child.once('close', (code) => {
      if (job.status !== 'running') return;
      this.finish(
        job,
        code === 0 ? 'succeeded' : 'failed',
        code === 0 ? undefined : `Onboarding command exited with code ${code ?? 'unknown'}`,
      );
    });
  }

  private finish(
    job: StoredClusterOnboardingJob,
    status: Exclude<ClusterOnboardingStatus, 'running'>,
    error?: string,
  ) {
    job.status = status;
    job.finishedAt = new Date().toISOString();
    if (error) job.error = error;
    this.jobs.set(job.id, job);
    if (this.activeJobId === job.id) this.activeJobId = undefined;
  }

  private present(job: StoredClusterOnboardingJob): ClusterOnboardingJob {
    const { ownerUserId: _ownerUserId, ...visible } = job;
    return { ...visible, output: [...job.output] };
  }
}

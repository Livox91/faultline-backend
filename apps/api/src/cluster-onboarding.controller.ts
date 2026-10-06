import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { isIP } from 'node:net';
import { PERMISSIONS, ROLES, hasProjectAccess } from '@faultline/auth';
import type { AuthenticatedUser } from '@faultline/auth';
import type { ClusterDirectory } from '@faultline/database';
import { CurrentUser, RequirePermission, Roles } from './auth/context';
import { PlanEntitlements } from './billing/entitlements';
import { ClusterOnboardingService } from './cluster-onboarding.service';
import { CLUSTER_DIRECTORY } from './clusters.controller';

export function clusterName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z0-9][a-z0-9 ._-]{0,62}$/i.test(value.trim())
  )
    throw new BadRequestException(
      'Cluster name must be 1-63 characters and use letters, digits, spaces, dash, underscore or dot',
    );
  return value.trim();
}

export function controlPlaneIp(value: unknown): string {
  if (typeof value !== 'string')
    throw new BadRequestException(
      'Control plane address must be a valid IPv4 or IPv6 address with an optional port',
    );
  const address = value.trim();
  if (isIP(address) !== 0) return address;

  const bracketed = /^\[([^\]]+)](?::(\d{1,5}))?$/.exec(address);
  if (bracketed && isIP(bracketed[1]!) === 6) {
    if (!bracketed[2] || validPort(bracketed[2])) return address;
  }

  const ipv4WithPort = /^([^:]+):(\d{1,5})$/.exec(address);
  if (
    ipv4WithPort &&
    isIP(ipv4WithPort[1]!) === 4 &&
    validPort(ipv4WithPort[2]!)
  )
    return address;

  throw new BadRequestException(
    'Control plane address must be a valid IPv4 or IPv6 address with an optional port',
  );
}

export function ingestionEndpoint(value: unknown): string {
  if (typeof value !== 'string')
    throw new BadRequestException(
      'Faultline ingestion address must be an HTTP or HTTPS URL reachable from the cluster',
    );
  try {
    const endpoint = new URL(value.trim());
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error();
    if (['localhost', '127.0.0.1', '::1'].includes(endpoint.hostname))
      throw new BadRequestException(
        'The cluster cannot reach Faultline through localhost; use the Faultline machine LAN address',
      );
    return endpoint.toString().replace(/\/$/, '');
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException(
      'Faultline ingestion address must be an HTTP or HTTPS URL reachable from the cluster',
    );
  }
}

export function portableKubeconfig(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestException('Select the kubeconfig exported by the cluster');
  if (Buffer.byteLength(value, 'utf8') > 64 * 1024)
    throw new BadRequestException('The kubeconfig is larger than the 64 KB limit');

  const config = value.trim();
  const required = [
    /^apiVersion:\s*v1\s*$/m,
    /^current-context:\s*\S+/m,
    /^\s*server:\s*https:\/\/\S+\s*$/m,
    /^\s*certificate-authority-data:\s*\S+\s*$/m,
    /^\s*client-certificate-data:\s*\S+\s*$/m,
    /^\s*client-key-data:\s*\S+\s*$/m,
  ];
  if (required.some((pattern) => !pattern.test(config)))
    throw new BadRequestException(
      'The file must be a portable kubeconfig with an HTTPS server and embedded certificates',
    );

  // kubectl kubeconfigs can execute credential plugins or reference host files. The
  // browser flow accepts only inert, self-contained certificate credentials.
  if (
    /^\s*(?:exec|auth-provider|proxy-url|tokenFile):/m.test(config) ||
    /^\s*(?:certificate-authority|client-certificate|client-key):\s*(?!data:)/m.test(
      config,
    ) ||
    /^\s*insecure-skip-tls-verify:\s*true\s*$/im.test(config)
  )
    throw new BadRequestException(
      'Executable plugins, external credential files, proxies, and disabled TLS verification are not allowed',
    );
  return `${config}\n`;
}

function validPort(value: string): boolean {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function clusterId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(value.trim())
  )
    throw new BadRequestException('Invalid cluster id');
  return value.trim();
}

@Controller('cluster-onboarding')
export class ClusterOnboardingController {
  constructor(
    private readonly onboarding: ClusterOnboardingService,
    private readonly entitlements: PlanEntitlements,
    @Inject(CLUSTER_DIRECTORY) private readonly clusters: ClusterDirectory,
  ) {}

  @Post()
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @Roles(ROLES.ADMIN)
  @RequirePermission(PERMISSIONS.PROJECT_CREATE)
  async start(
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const name = clusterName(body?.clusterName);
    const address =
      body?.controlPlaneIp === undefined || body.controlPlaneIp === ''
        ? undefined
        : controlPlaneIp(body.controlPlaneIp);
    const endpoint = ingestionEndpoint(body?.ingestionEndpoint);
    const kubeconfig =
      body?.kubeconfig === undefined
        ? undefined
        : portableKubeconfig(body.kubeconfig);
    // Before the job starts, so a refused cluster never gets collectors installed.
    await this.entitlements.assertClusterCapacity(actor, this.clusters);
    try {
      return this.onboarding.start(
        name,
        address,
        endpoint,
        kubeconfig,
        actor.id,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'A cluster onboarding job is already running'
      )
        throw new ConflictException(error.message);
      throw error;
    }
  }

  @Delete('clusters/:clusterId')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @Roles(ROLES.ADMIN)
  @RequirePermission(PERMISSIONS.PROJECT_DELETE)
  uninstall(
    @Param('clusterId') value: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const id = clusterId(value);
    if (!hasProjectAccess(actor, id))
      throw new ForbiddenException('You do not have access to this cluster');
    try {
      return this.onboarding.uninstall(id, actor.id);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'A cluster operation is already running'
      )
        throw new ConflictException(error.message);
      throw error;
    }
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @Roles(ROLES.ADMIN)
  @RequirePermission(PERMISSIONS.PROJECT_CREATE)
  get(
    @Param('id') id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const job = this.onboarding.get(id, actor.id);
    if (!job) throw new NotFoundException('Onboarding job not found');
    return job;
  }
}

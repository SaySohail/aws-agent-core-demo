import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  agentConfigurationSchema,
  agentSchema,
  validateAgentDefinitionForDeployment,
  type Agent,
  type AgentConfiguration,
  type AgentTemplate,
  type AwsConnection
} from '@agent-launchpad/schemas';
import {
  customerArtifactBucketName,
  type AssumedCustomerRoleCredentials,
  type CustomerRoleAssumer
} from './customer-connection.js';

export const AGENTCORE_RUNTIME = 'NODE_22' as const;
export const AGENT_ARTIFACT_APPLICATION_ENTRY_POINT = 'dist/app.js' as const;
export const AGENT_ARTIFACT_ENTRY_POINT = [
  'opentelemetry-instrument',
  AGENT_ARTIFACT_APPLICATION_ENTRY_POINT
] as const;
export const ADOT_PACKAGE = '@aws/aws-distro-opentelemetry-node-autoinstrumentation' as const;
export const ADOT_PACKAGE_VERSION = '0.12.0' as const;
export const AGENT_ARTIFACT_MAX_COMPRESSED_BYTES = 250 * 1024 * 1024;
export const AGENT_ARTIFACT_MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;

export class AgentArtifactError extends Error {
  public constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export interface AgentArtifactSnapshot {
  readonly agent: Agent;
  readonly template: AgentTemplate | undefined;
  readonly connection: AwsConnection | undefined;
}
export interface BuiltAgentArtifact {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly uncompressedSizeBytes: number;
  readonly runtime: typeof AGENTCORE_RUNTIME;
  readonly entryPoint: readonly [
    (typeof AGENT_ARTIFACT_ENTRY_POINT)[0],
    (typeof AGENT_ARTIFACT_ENTRY_POINT)[1]
  ];
  readonly configurationVersion: number;
  readonly manifest: Readonly<Record<string, unknown>>;
}

/** Server-only pure build boundary. It accepts one already-read, immutable domain snapshot. */
export class AgentArtifactBuilder {
  public constructor(private readonly runtimeSourcePath: string) {}

  async build(snapshot: AgentArtifactSnapshot): Promise<BuiltAgentArtifact> {
    const agent = agentSchema.parse(snapshot.agent);
    const configuration = agentConfigurationSchema.parse(agent.configuration);
    const readiness = validateAgentDefinitionForDeployment(
      agent,
      snapshot.template,
      snapshot.connection
    );
    if (readiness.length)
      throw new AgentArtifactError('ARTIFACT_NOT_READY', readiness.map((x) => x.code).join(','));
    if (!this.runtimeSourcePath.endsWith('.ts'))
      throw new AgentArtifactError('INVALID_ENTRY_POINT', 'Runtime source must be TypeScript.');
    const staging = await mkdtemp(join(tmpdir(), 'agent-launchpad-artifact-'));
    try {
      const appPath = join(staging, 'dist', 'app.js');
      await build({
        entryPoints: [resolve(this.runtimeSourcePath)],
        outfile: appPath,
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node22',
        logLevel: 'silent'
      });
      const app = await readFile(appPath);
      this.assertNoNativeDependencies([
        { path: AGENT_ARTIFACT_APPLICATION_ENTRY_POINT, data: app }
      ]);
      const config = canonicalJson(runtimeConfiguration(configuration));
      const manifest = {
        schemaVersion: 1,
        packagingSchemaVersion: 1,
        templateId: agent.templateId,
        templateVersion: agent.templateVersion,
        configurationVersion: agent.revision,
        agentConfigurationSchemaVersion: configuration.configurationVersion,
        runtime: AGENTCORE_RUNTIME,
        entryPoint: [...AGENT_ARTIFACT_ENTRY_POINT],
        observability: { adotPackage: ADOT_PACKAGE, adotPackageVersion: ADOT_PACKAGE_VERSION },
        enabledCapabilities: [...configuration.capabilities].sort()
      };
      const entries = [
        { path: 'config/agent-config.json', data: Buffer.from(canonicalJson(config), 'utf8') },
        { path: AGENT_ARTIFACT_APPLICATION_ENTRY_POINT, data: app },
        ...(await this.adotEntries()),
        { path: 'manifest.json', data: Buffer.from(canonicalJson(manifest), 'utf8') }
      ];
      const zip = deterministicZip(entries);
      const inspected = inspectZip(zip);
      this.validatePackage(inspected, manifest);
      const uncompressedSizeBytes = inspected.reduce(
        (total, entry) => total + entry.uncompressedSize,
        0
      );
      if (
        zip.length > AGENT_ARTIFACT_MAX_COMPRESSED_BYTES ||
        uncompressedSizeBytes > AGENT_ARTIFACT_MAX_UNCOMPRESSED_BYTES
      )
        throw new AgentArtifactError(
          'ARTIFACT_TOO_LARGE',
          'AgentCore direct-code package size limit exceeded.'
        );
      return {
        bytes: zip,
        sha256: sha256(zip),
        sizeBytes: zip.length,
        uncompressedSizeBytes,
        runtime: AGENTCORE_RUNTIME,
        entryPoint: [...AGENT_ARTIFACT_ENTRY_POINT],
        configurationVersion: agent.revision,
        manifest
      };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private validatePackage(entries: readonly ZipEntry[], manifest: Record<string, unknown>): void {
    const paths = entries.map((entry) => entry.path);
    if (
      !paths.includes('config/agent-config.json') ||
      !paths.includes(AGENT_ARTIFACT_APPLICATION_ENTRY_POINT) ||
      !paths.includes('manifest.json') ||
      !paths.includes('node_modules/.bin/opentelemetry-instrument') ||
      !paths.includes(`node_modules/${ADOT_PACKAGE}/package.json`)
    )
      throw new AgentArtifactError(
        'INVALID_PACKAGE_STRUCTURE',
        'Artifact is missing the ADOT instrumentation executable or dependency.'
      );
    if (!isInstrumentedEntryPoint(manifest.entryPoint) || manifest.runtime !== AGENTCORE_RUNTIME)
      throw new AgentArtifactError(
        'INVALID_PACKAGE_STRUCTURE',
        'Artifact entry point/runtime is invalid.'
      );
    this.assertNoNativeDependencies(
      entries.map((entry) => ({ path: entry.path, data: entry.data }))
    );
    for (const entry of entries)
      if (
        /(^|\/)\.env|\.(pem|key)$/i.test(entry.path) ||
        (entry.path !== AGENT_ARTIFACT_APPLICATION_ENTRY_POINT &&
          /AKIA[0-9A-Z]{16}|aws_secret_access_key|sessiontoken/i.test(entry.data.toString('utf8')))
      )
        throw new AgentArtifactError(
          'FORBIDDEN_ARTIFACT_CONTENT',
          'Artifact contains forbidden content.'
        );
  }
  private assertNoNativeDependencies(entries: readonly { path: string; data: Buffer }[]): void {
    if (
      entries.some(
        (entry) =>
          /\.node$|\.so$/i.test(entry.path) ||
          entry.data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      )
    )
      throw new AgentArtifactError(
        'NATIVE_DEPENDENCY_UNSUPPORTED',
        'Native dependencies are unsupported for Linux ARM64 direct code.'
      );
  }

  private async adotEntries(): Promise<ArtifactFile[]> {
    const runtimeRequire = createRequire(resolve(this.runtimeSourcePath));
    let registerModule: string;
    try {
      registerModule = runtimeRequire.resolve(`${ADOT_PACKAGE}/register`);
    } catch {
      throw new AgentArtifactError(
        'ADOT_DEPENDENCY_MISSING',
        `The pinned ${ADOT_PACKAGE}@${ADOT_PACKAGE_VERSION} runtime dependency is unavailable.`
      );
    }
    const packageRoot = await packageRootFor(registerModule);
    const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };
    if (metadata.version !== ADOT_PACKAGE_VERSION)
      throw new AgentArtifactError(
        'ADOT_DEPENDENCY_VERSION_INVALID',
        `Expected ${ADOT_PACKAGE}@${ADOT_PACKAGE_VERSION}.`
      );
    // pnpm stores the production dependency closure beside the resolved package. Copy that
    // logical node_modules tree rather than the monorepo root or just ADOT itself: register()
    // loads ADOT dependencies lazily after Runtime startup.
    const files = await collectFiles(dirname(dirname(packageRoot)), 'node_modules');
    files.push({
      path: 'node_modules/.bin/opentelemetry-instrument',
      data: Buffer.from(
        '#!/bin/sh\nexec node --require @aws/aws-distro-opentelemetry-node-autoinstrumentation/register "$@"\n',
        'utf8'
      ),
      mode: 0o100755
    });
    return files;
  }
}

function isInstrumentedEntryPoint(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value[0] === AGENT_ARTIFACT_ENTRY_POINT[0] &&
    value[1] === AGENT_ARTIFACT_APPLICATION_ENTRY_POINT
  );
}

export interface AgentArtifactUploaderInput {
  readonly tenantId: string;
  readonly agentId: string;
  readonly sha256: string;
  readonly configurationVersion: number;
  readonly templateVersion: string;
  readonly bytes: Buffer;
  readonly connection: AwsConnection;
}
export interface UploadedAgentArtifact {
  readonly bucket: string;
  readonly key: string;
  readonly versionId?: string;
  readonly etag?: string;
}
/** Uses a fresh customer role session. Bucket and KMS selection are derived only from trusted connection metadata. */
export class AgentArtifactUploader {
  public constructor(private readonly assumer: CustomerRoleAssumer) {}
  async upload(input: AgentArtifactUploaderInput): Promise<UploadedAgentArtifact> {
    if (input.connection.tenantId !== input.tenantId || input.connection.status !== 'VERIFIED')
      throw new AgentArtifactError(
        'CONNECTION_NOT_VERIFIED',
        'Customer connection is not verified.'
      );
    const bucket = customerArtifactBucketName(input.connection.accountId, input.connection.region);
    const credentials = await this.assumer.assumeCustomerRole({
      roleArn: input.connection.roleArn,
      externalId: input.connection.externalId,
      sessionName: `artifact-${input.agentId.slice(-12)}`
    });
    const identity = await this.assumer.getCallerIdentity(credentials);
    if (identity.account !== input.connection.accountId)
      throw new AgentArtifactError(
        'CUSTOMER_ACCOUNT_MISMATCH',
        'Assumed role account did not match connection.'
      );
    const key = `agents/${input.agentId}/artifacts/${input.sha256}/agent.zip`;
    const response = await new S3Client({
      region: input.connection.region,
      credentials: credentials as AssumedCustomerRoleCredentials
    }).send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: input.bytes,
        ExpectedBucketOwner: input.connection.accountId,
        ContentType: 'application/zip',
        Metadata: {
          sha256: input.sha256,
          agentid: input.agentId,
          templateversion: input.templateVersion,
          configurationversion: String(input.configurationVersion)
        }
      })
    );
    return {
      bucket,
      key,
      ...(response.VersionId ? { versionId: response.VersionId } : {}),
      ...(response.ETag ? { etag: response.ETag } : {})
    };
  }
}

/** Coordinates the two boundaries without exposing an HTTP route or any AgentCore creation operation. */
export class AgentArtifactPackagingService {
  public constructor(
    private readonly builder: AgentArtifactBuilder,
    private readonly uploader: AgentArtifactUploader,
    private readonly reloadConnection: (
      tenantId: string,
      connectionId: string
    ) => Promise<AwsConnection | undefined>
  ) {}
  async packageAndUpload(
    snapshot: AgentArtifactSnapshot
  ): Promise<{ built: BuiltAgentArtifact; uploaded: UploadedAgentArtifact }> {
    // `build` parses/copies the snapshot once; never read mutable Agent state again.
    const built = await this.builder.build(snapshot);
    const freshConnection = await this.reloadConnection(
      snapshot.agent.tenantId,
      snapshot.agent.configuration.deploymentTarget.awsConnectionId
    );
    if (!freshConnection || freshConnection.status !== 'VERIFIED')
      throw new AgentArtifactError(
        'CONNECTION_NOT_VERIFIED',
        'Customer connection was revoked before upload.'
      );
    const uploaded = await this.uploader.upload({
      tenantId: snapshot.agent.tenantId,
      agentId: snapshot.agent.id,
      sha256: built.sha256,
      configurationVersion: built.configurationVersion,
      templateVersion: snapshot.agent.templateVersion,
      bytes: built.bytes,
      connection: freshConnection
    });
    return { built, uploaded };
  }
}

function runtimeConfiguration(configuration: AgentConfiguration) {
  return {
    schemaVersion: configuration.configurationVersion,
    template: configuration.template,
    model: configuration.model,
    capabilities: [...configuration.capabilities].sort(),
    guardrails: configuration.guardrails
  };
}
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sort(item)])
    );
  return value;
}
export function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

interface ArtifactFile {
  readonly path: string;
  readonly data: Buffer;
  readonly mode?: number;
}
interface ZipEntry extends ArtifactFile {
  readonly uncompressedSize: number;
}
async function collectFiles(sourceRoot: string, destinationRoot: string): Promise<ArtifactFile[]> {
  const files: ArtifactFile[] = [];
  const visit = async (source: string, destination: string): Promise<void> => {
    const stat = await lstat(source);
    if (stat.isSymbolicLink()) {
      await visit(await realpath(source), destination);
      return;
    }
    if (stat.isDirectory()) {
      for (const name of (await readdir(source)).sort((a, b) => a.localeCompare(b))) {
        // Package tests and VCS metadata are neither executable runtime dependencies nor safe
        // deployment payload. Excluding them also keeps the artifact boundary deterministic.
        if (['.git', 'test', 'tests', 'fixture', 'fixtures'].includes(name)) continue;
        await visit(join(source, name), `${destination}/${name}`);
      }
      return;
    }
    if (!stat.isFile()) return;
    const normalized = relative(destinationRoot, destination).replaceAll('\\', '/');
    if (normalized.startsWith('../') || normalized === '')
      throw new AgentArtifactError('INVALID_PACKAGE_STRUCTURE', 'Unsafe dependency path.');
    files.push({ path: destination, data: await readFile(source), mode: 0o100644 });
  };
  await visit(sourceRoot, destinationRoot);
  return files;
}
async function packageRootFor(source: string): Promise<string> {
  let current = dirname(source);
  while (dirname(current) !== current) {
    try {
      await lstat(join(current, 'package.json'));
      return await realpath(current);
    } catch {
      current = dirname(current);
    }
  }
  throw new AgentArtifactError('ADOT_DEPENDENCY_MISSING', 'The ADOT package root is unavailable.');
}
function deterministicZip(source: readonly ArtifactFile[]): Buffer {
  const entries = [...source].sort((a, b) => a.path.localeCompare(b.path));
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const item of entries) {
    if (
      !/^[A-Za-z0-9@._/-]+$/.test(item.path) ||
      item.path.startsWith('/') ||
      item.path.split('/').some((part) => part === '..' || part === '')
    )
      throw new AgentArtifactError('INVALID_PACKAGE_STRUCTURE', 'Unsafe ZIP path.');
    const name = Buffer.from(item.path);
    const crc = crc32(item.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(item.data.length, 18);
    local.writeUInt32LE(item.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, item.data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(0x0314, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(item.data.length, 20);
    c.writeUInt32LE(item.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(0, 30);
    c.writeUInt16LE(0, 32);
    c.writeUInt16LE(0, 34);
    c.writeUInt16LE(0, 36);
    c.writeUInt32LE(((item.mode ?? 0o100644) << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + item.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
function inspectZip(zip: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;
  while (offset < zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const method = zip.readUInt16LE(offset + 8),
      size = zip.readUInt32LE(offset + 22),
      nameLength = zip.readUInt16LE(offset + 26),
      extra = zip.readUInt16LE(offset + 28);
    if (method !== 0)
      throw new AgentArtifactError('INVALID_PACKAGE_STRUCTURE', 'Unexpected ZIP compression.');
    const path = zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extra;
    entries.push({ path, data: zip.subarray(start, start + size), uncompressedSize: size });
    offset = start + size;
  }
  if (!entries.length)
    throw new AgentArtifactError('INVALID_PACKAGE_STRUCTURE', 'ZIP has no entries.');
  return entries;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = crcTable[(c ^ byte) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

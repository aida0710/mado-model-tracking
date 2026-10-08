import type {
  Dataset,
  DatasetVersion,
  PluginConnection,
  PluginDataset,
  PluginManifest,
} from '@mmt/contracts';
import { createPluginClient, type PluginClient } from '@mmt/platform';
import type { Principal } from '../auth/principal.js';
import { first, rows, transaction, type Connection, type Database } from '../db/database.js';
import { conflict, DomainError, notFound } from '../domain/errors.js';
import { datasetVersionSelect } from '../repositories/registryRepository.js';
import { requireGlobalAdmin, requireProject } from './accessService.js';
import type { PluginPatch } from '../domain/validation.js';
import type { RegistryService } from './registryService.js';

export type PluginClientFactory = typeof createPluginClient;

export class PluginService {
  private readonly database: Database;
  private readonly registry: RegistryService;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly clientFactory: PluginClientFactory;

  constructor(options: {
    database: Database;
    registry: RegistryService;
    environment?: NodeJS.ProcessEnv;
    clientFactory?: PluginClientFactory;
  }) {
    this.database = options.database;
    this.registry = options.registry;
    this.environment = options.environment ?? process.env;
    this.clientFactory = options.clientFactory ?? createPluginClient;
  }

  async list(principal: Principal, projectId: string): Promise<PluginConnection[]> {
    await requireProject(this.database, principal, {
      projectId,
      role: 'admin',
      scope: 'admin',
    });
    return rows(
      this.database,
      'SELECT * FROM plugin_connections WHERE project_id=$1 ORDER BY created_at DESC',
      [projectId],
    );
  }

  async create(
    principal: Principal,
    projectId: string,
    input: {
      name: string;
      baseUrl: string;
      tokenEnv: string;
      enabled: boolean;
    },
  ): Promise<PluginConnection> {
    // Only the server administrator may choose where a server-side secret is sent.
    requireGlobalAdmin(principal);
    await requireProject(this.database, principal, {
      projectId,
      role: 'admin',
      scope: 'admin',
    });
    return (await first<PluginConnection>(
      this.database,
      'INSERT INTO plugin_connections(project_id,name,base_url,token_env,enabled) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [projectId, input.name, input.baseUrl.replace(/\/$/, ''), input.tokenEnv, input.enabled],
    ))!;
  }

  async check(principal: Principal, projectId: string, pluginId: string): Promise<PluginManifest> {
    const plugin = await this.authorizedConnection(principal, {
      projectId,
      pluginId,
    });
    const manifest = await this.callPlugin(() => this.client(plugin).manifest());
    const saved = await first(
      this.database,
      `UPDATE plugin_connections SET manifest=$2 WHERE id=$1 AND project_id=$3 AND enabled
      AND base_url=$4 AND token_env=$5 RETURNING id`,
      [plugin.id, JSON.stringify(manifest), projectId, plugin.baseUrl, plugin.tokenEnv],
    );
    if (!saved) conflict('Pluginの接続設定が変更されています。再確認してください');
    return manifest;
  }

  async patch(
    principal: Principal,
    projectId: string,
    request: { pluginId: string; input: PluginPatch },
  ): Promise<PluginConnection> {
    requireGlobalAdmin(principal);
    return transaction(this.database, async (connection) => {
      await requireProject(connection, principal, { projectId, role: 'admin', scope: 'admin' });
      const plugin = await first<PluginConnection>(
        connection,
        'SELECT * FROM plugin_connections WHERE project_id=$1 AND id=$2 FOR UPDATE',
        [projectId, request.pluginId],
      );
      if (!plugin) notFound('Plugin');
      const updated = { ...plugin, ...request.input };
      updated.baseUrl = updated.baseUrl.replace(/\/$/, '');
      const manifest =
        plugin.baseUrl !== updated.baseUrl || plugin.tokenEnv !== updated.tokenEnv
          ? null
          : plugin.manifest;
      return (await first<PluginConnection>(
        connection,
        'UPDATE plugin_connections SET name=$2,base_url=$3,token_env=$4,enabled=$5,manifest=$6::jsonb WHERE id=$1 RETURNING *',
        [
          plugin.id,
          updated.name,
          updated.baseUrl,
          updated.tokenEnv,
          updated.enabled,
          manifest ? JSON.stringify(manifest) : null,
        ],
      ))!;
    });
  }

  async search(
    principal: Principal,
    projectId: string,
    request: { pluginId: string; query: string },
  ): Promise<{ items: PluginDataset[] }> {
    const plugin = await this.authorizedConnection(principal, {
      projectId,
      pluginId: request.pluginId,
    });
    return this.callPlugin(() => this.client(plugin).searchDatasets(request.query));
  }

  async metrics(
    principal: Principal,
    projectId: string,
    pluginId: string,
  ): Promise<{ prometheus: string }> {
    const plugin = await this.authorizedConnection(principal, {
      projectId,
      pluginId,
    });
    const client = this.client(plugin);
    const manifest = plugin.manifest ?? (await this.callPlugin(() => client.manifest()));
    if (!manifest.capabilities.includes('storage:metrics'))
      throw new DomainError(
        422,
        'Pluginはstorage:metricsに対応していません',
        'plugin_capability_unsupported',
      );
    return this.callPlugin(() => client.metrics());
  }

  async importDataset(
    principal: Principal,
    projectId: string,
    request: { pluginId: string; dataset: PluginDataset },
  ): Promise<DatasetVersion> {
    return transaction(this.database, async (connection) => {
      await this.authorizedConnection(
        principal,
        { projectId, pluginId: request.pluginId, lock: true },
        connection,
      );
      // Serialize imports of the same remote version, including first-time dataset creation.
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        JSON.stringify([projectId, request.dataset.namespace, request.dataset.name]),
      ]);
      const imported = request.dataset;
      let dataset = await first<Dataset>(
        connection,
        'SELECT * FROM datasets WHERE project_id=$1 AND namespace=$2 AND name=$3',
        [projectId, imported.namespace, imported.name],
      );
      dataset ??= (await first<Dataset>(
        connection,
        'INSERT INTO datasets(project_id,name,namespace,description) VALUES($1,$2,$3,$4) RETURNING *',
        [projectId, imported.name, imported.namespace, 'Pluginから取り込んだデータセット'],
      ))!;
      const existing = await first<DatasetVersion>(
        connection,
        `${datasetVersionSelect} WHERE v.dataset_id=$1 AND v.version=$2`,
        [dataset.id, imported.version],
      );
      if (existing) {
        if (
          existing.externalRef?.pluginId !== request.pluginId ||
          existing.externalRef.externalId !== imported.externalId ||
          existing.digest !== imported.digest ||
          existing.uri !== imported.uri
        )
          conflict('既存のDatasetVersionとpluginの版が一致しません');
        return existing;
      }
      return this.registry.insertDatasetVersion(connection, projectId, {
        datasetId: dataset.id,
        input: {
          ...imported,
          sourceRunId: null,
          parentDatasetVersionIds: [],
          externalRef: {
            pluginId: request.pluginId,
            externalId: imported.externalId,
            namespace: imported.namespace,
            name: imported.name,
            version: imported.version,
          },
        },
      });
    });
  }

  async retryEvents(
    principal: Principal,
    projectId: string,
    pluginId: string,
  ): Promise<{ queued: number }> {
    return transaction(this.database, async (connection) => {
      await this.authorizedConnection(principal, { projectId, pluginId, lock: true }, connection);
      const queued = await connection.query(
        "UPDATE plugin_outbox SET next_attempt_at=now(),last_error=NULL WHERE plugin_id=$1 AND status='pending' RETURNING id",
        [pluginId],
      );
      return { queued: queued.rowCount ?? 0 };
    });
  }

  client(plugin: Pick<PluginConnection, 'baseUrl' | 'tokenEnv'>): PluginClient {
    const token = this.environment[plugin.tokenEnv];
    if (!token)
      throw new DomainError(
        503,
        'Pluginのtoken環境変数が設定されていません',
        'plugin_token_unavailable',
      );
    return this.clientFactory({ baseUrl: plugin.baseUrl, token });
  }

  private async authorizedConnection(
    principal: Principal,
    reference: { projectId: string; pluginId: string; lock?: boolean },
    connection: Connection = this.database,
  ): Promise<PluginConnection> {
    await requireProject(connection, principal, {
      projectId: reference.projectId,
      role: 'admin',
      scope: 'admin',
    });
    const plugin = await first<PluginConnection>(
      connection,
      `SELECT * FROM plugin_connections WHERE project_id=$1 AND id=$2 ${reference.lock ? 'FOR SHARE' : ''}`,
      [reference.projectId, reference.pluginId],
    );
    if (!plugin) notFound('Plugin');
    if (!plugin.enabled) throw new DomainError(422, 'Pluginは無効です', 'plugin_disabled');
    return plugin;
  }

  private async callPlugin<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(502, 'Pluginとの通信に失敗しました', 'plugin_request_failed');
    }
  }
}

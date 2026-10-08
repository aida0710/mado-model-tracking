---
title: Plugins and Mado integration
description: How plugins connect external services, and how to set up the Mado plugin to use Mado datasets as Run inputs and send lineage to Mado.
---

# Plugins and Mado integration

A plugin is an HTTP service that runs separately from this application. It never connects to this application's database; it only talks through a fixed HTTP API. The first plugin is the Mado plugin, which integrates with Mado.

With the Mado plugin you can:

- Search Mado datasets and import a fixed version as a DatasetVersion in this application
- Send Run starts, finishes, failures, and cancellations, with their input and output dataset versions, to Mado as OpenLineage
- View the storage capacity metrics of Mado

Plugin UI components and arbitrary JavaScript are never run in the browser. The screens are the same for every plugin.

## Roles

| Operation | Who |
| --- | --- |
| Register a plugin, change its URL or token variable name, enable or disable it | Global administrators |
| Check the connection, search and import datasets, resend events, view capacity metrics | Project Admins |

Plugins are registered per Project. Register the plugin in each Project that uses it.

## Run the Mado plugin

The Mado plugin lives in a separate repository (`mado-model-tracking-plugin-mado`) and needs Node.js 22.12 or later. On Ubuntu, install Node.js 22 with:

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

Install the dependencies in the plugin repository and prepare `.env`:

```sh
npm ci
cp .env.example .env
chmod 600 .env
```

### Issue keys in Mado

In Mado's Settings → Access → Service Accounts, issue a separate key for each use.

| Key scope | Used for | Plugin `.env` |
| --- | --- | --- |
| `lineage:read` | Searching datasets and versions | `MADO_READ_TOKEN` |
| `lineage:write` | Sending lineage | `MADO_LINEAGE_TOKEN` |
| `metrics:read` (optional) | Capacity metrics | `MADO_METRICS_TOKEN` |

Limit the `lineage:read` and `lineage:write` keys to the namespaces you use. Capacity metrics cover the whole storage, so do not set a namespace for that key.

### Plugin `.env`

| Variable | Value | Example |
| --- | --- | --- |
| `MMT_PLUGIN_TOKEN` | A dedicated secret this application uses to connect to the plugin. Different from the Mado keys | Generate with `openssl rand -hex 32` |
| `MADO_BASE_URL` | Origin of the Mado UI and API | `https://mado.example.com/` |
| `MADO_LINEAGE_URL` | Origin of the OpenLineage API. Optional if the same | `https://mado-api.example.com/` |
| `MADO_NAMESPACES` | Namespaces to search, comma-separated | `speech` |
| `MADO_JOB_NAMESPACE` | Namespace where this application's experiments are registered in Mado | `mado-model-tracking` |
| `MADO_STORAGE_SYSTEM_KEY` | StorageSystem identifier for outputs created in this application | `mado-model-tracking` |
| `PLUGIN_LEDGER_DIRECTORY` | Where records of delivered events are kept. Use a persistent volume | `./var/events` |
| `HOST`, `PORT` | Listening address and port | `127.0.0.1`, `4190` |

Start the plugin:

```sh
npm start
```

### Put the same secret on the API server

Put the same value as the plugin's `MMT_PLUGIN_TOKEN` in the API server's `.env`. You can choose any variable name and give that name when registering the plugin. The value is never stored in the database.

```sh
# API server .env
MMT_MADO_PLUGIN_TOKEN=<same value as the plugin's MMT_PLUGIN_TOKEN>
```

Restart the API after the change.

## Register the plugin (global administrators)

1. Open the Project's **Plugins** and click **Pluginを登録** (Register plugin).
2. Enter the following and save.

| Field | Example |
| --- | --- |
| Name | `Mado` |
| Service URL | `http://127.0.0.1:4190`; use the service name for another container (`http://mado-plugin:4190`) |
| Variable name holding the token | `MMT_MADO_PLUGIN_TOKEN` (uppercase letters, digits, `_`) |
| Enabled | Selected |

3. Click **接続を確認** (Check connection) and check that the plugin version and capabilities are shown.

Changing the URL or the token variable name clears the checked information; click **接続を確認** again. If the API process has no such variable, the error is `plugin_token_unavailable`.

Requests to plugins use a Bearer token, accept responses up to 1 MiB, and time out after 5 seconds. Only global administrators can register service URLs.

## Import Mado datasets (Project Admins)

1. Type a search term in **データセットを検索** (Search datasets) under **Plugins**.
2. Pick a version from the results and click **インポート** (Import).

The imported version appears in **Datasets** as a DatasetVersion that keeps Mado's external ID. Importing the same version again returns the same DatasetVersion. When used as a Run input, the Run records which Mado version it used. See [Datasets](/en/data/datasets) for datasets.

## Lineage delivery and resending

When a Run's state changes, an event is queued in the same transaction as the change. A stopped plugin never fails a Run. Failed deliveries are retried at increasing intervals.

- Events: `run.started`, `run.finished`, `run.failed`, `run.canceled`, with the Run and its input and output DatasetVersions.
- If an output DatasetVersion is registered to a finished Run later, a completion event including that output is sent again.
- The plugin treats resends of the same event ID as duplicates.

**イベントの送信状況** (Event delivery status) under **Plugins** shows the number of undelivered events, the oldest undelivered, the most attempts, the last error, and the last delivery. After fixing the plugin, click **イベントを再送** (Resend events) to resend immediately without waiting.

An undelivered event older than 15 minutes, or one that failed 5 or more times, opens the operations alert Plugin delivery stalled ([Notifications and operations alerts](/en/admin/notifications)).

While a plugin is disabled, deliveries stop and no new events are queued. Undelivered events queued before disabling remain and are sent after re-enabling. Run changes that happened while the plugin was disabled are not sent later.

## Write your own plugin

A plugin is a service with the following HTTP API (plugin protocol 1.0), authenticated with a Bearer token.

| Method and path | Content |
| --- | --- |
| `GET /manifest` | `id`, `name`, `version`, `protocolVersion: "1.0"`, `capabilities` |
| `POST /datasets/search` | Receives `{query}` and returns `{items: PluginDataset[]}` |
| `POST /events` | Receives a Run event and returns `{accepted: true}` |
| `GET /metrics` | Only with the `storage:metrics` capability. Prometheus text format |

`PluginDataset` has `externalId`, `namespace`, `name`, `version`, `uri`, `digest`, `schema`, and `metadata`. Do not return datasets without versions. Remove duplicate events by ID, and do not return `accepted` for an event you could not process.

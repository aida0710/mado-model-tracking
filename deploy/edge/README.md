# runner用APIの公開hostname（edge）

スパコンの計算ノードなど、LANの外で動くrunnerは、trackingへ直接報告します（[設計案](../../docs/design/external-execution.md)「runner用API」）。そのために、intranetのhostnameとは別の公開hostname（例: `mmt-runner.example.org`）を用意し、[runner-api.conf.template](runner-api.conf.template)をTLSのedge nginxに組み込みます。書き方はMadoのedge（`nginx/edge.conf.template`、`docs/mdx-tls.md`）に合わせています。

## 公開するもの

| 受け付けるもの | 条件 |
|---|---|
| `GET`・`HEAD` `/api/health`、`/api/auth/token` | Job token |
| `GET`・`HEAD` `/api/projects/{p}/...`（入力、ファイル、上流のRun、子Job、upload session） | Job token |
| `POST` `/api/projects/{p}/jobs/{j}/runner/{start,heartbeat,logs,metrics,outputs,finish}` | Job token |
| `POST` `/api/projects/{p}/jobs/{j}/children`（ドライバーの子Job） | Job token |
| 自分のRunへの書き込み: `PATCH` `/runs/{r}`、`POST` `/runs/{r}/{metrics,logs,media,checkpoints}`、`PUT` `/runs/{r}/artifacts`、`/artifact-uploads`（作成・部品・完了・中止）、`POST` `/models`、`/models/{m}/versions`、`/datasets/{d}/versions`、`/runs/search`、`/media/compare` | Job token |
| MLflow互換API（`/api/mlflow/projects/{p}/...`）のうち、Job tokenで使えるもの | Job token |
| `POST` `/api/hooks/{id}/webhook` | tokenなし（APIが署名を確かめる） |

- 表に無いmethodとpathは、すべて404 `not_found`です。画面、SSO（`/api/auth/oidc/*`）、管理API、worker・launcherのAPI（`/api/worker/*`、`/api/manual-submissions`）は届きません。
- Job token（`Authorization: Bearer mmtj_...`）でない要求は、401 `job_token_required`です。API token（`mmt_`）、Basic認証、session cookieは使えません。cookieはAPIへ渡しません。
- webhookは`Authorization`を外して渡します。本文は1 MiBまで（APIの上限は256 KiB）、送信元のアドレスごとに毎秒10件（一時的に20件まで）で、超えると429です。
- 解釈が分かれうるpath（`%2e`・`%2f`・`%5c`、`\`、`//`、`/./`、`/../`）は400 `invalid_path`です。nginxとAPIで別のpathとして読まれるのを防ぐためです。query（`?`の後ろ）は調べません。
- 平文のHTTP（80番）は、Let's Encryptの確認だけに答え、ほかは403です。HTTPSへのredirectもしません。`http://`でtokenを送った時点で、tokenは平文で流れているためです。runnerのURLは`https://`で設定します。
- アクセスログにqueryを残しません。

## なぜこれだけを公開するか

- Job tokenは、そのJobのRunにしか書けず、ほかはProjectの中を読むだけです（`apps/api/src/http/jobTokenGuard.ts`）。計算ノードで漏れても、被害はそのJobの範囲に留まります。
- 人のAPI tokenやsessionは、このhostnameでは使えません。サイトの共用ディレクトリなどから漏れても、インターネットからは使えません。
- 画面、SSO、管理APIをインターネットに出さないため、hostnameを分けます。firewall（UFWなど）はhostname（SNI・Host）を見分けられないので、hostnameごとの制限はnginxで行います。
- 表は、APIのJob tokenの規則とrunnerのrouteに合わせています。APIにJob token用のrouteを足したら、template の`$mmt_runner_route`にも足してください。足すまでは404のまま閉じています。最終的な認可は、いつもAPIが行います。

## 前提

- DNS: 公開hostnameのA recordを、edgeのglobal IPv4へ向けます。AAAA recordは、IPv6の443番を開けるときだけ公開します。
- 証明書: Let's EncryptのHTTP-01で取ります（webrootは`/var/www/letsencrypt`）。公開hostnameなので、HTTP-01が使えます。
- 転送先: `compose.yml`の`web`（`127.0.0.1:5182`）です。`web`のnginxが`/api/`をAPIへ渡します。API自体のportは公開しません。
- runner: 各サイトの`runner_api_url`（[launcherのサイト設定](../sites/README.md)）を`https://<公開hostname>`にします。計算ノードがproxy経由でしか外へ出られないサイトでは、batch scriptで`https_proxy`を設定します。

## edgeへの組み込み

templateは、nginx公式imageのtemplate機能（`/etc/nginx/templates/*.template`をenvsubstで`/etc/nginx/conf.d/`へ書き出す）で使います。

| 環境変数 | 例 | 内容 |
|---|---|---|
| `MMT_RUNNER_API_HOSTNAME` | `mmt-runner.example.org` | 公開hostname。証明書のpath（`/etc/letsencrypt/live/<hostname>/`）にも使います |
| `MMT_RUNNER_API_UPSTREAM` | `127.0.0.1:5182` | trackingの`web`のhost:port |
| `NGINX_ENVSUBST_FILTER` | `^(MADO\|MMT_RUNNER_API)_` | 置き換える変数名を限ります。nginx自身の`$uri`などを残すために必要です |

### Madoのedgeに足す

`compose.mdx.yaml`の`edge`（host network）に、templateと変数を足します。

```yaml
    environment:
      MMT_RUNNER_API_HOSTNAME: "${MMT_RUNNER_API_HOSTNAME:-mmt-runner.example.org}"
      MMT_RUNNER_API_UPSTREAM: "127.0.0.1:5182"
      NGINX_ENVSUBST_FILTER: "^(MADO|MMT_RUNNER_API)_"
    volumes:
      - /path/to/mado-ml-tracking/deploy/edge/runner-api.conf.template:/etc/nginx/templates/mmt-runner-api.conf.template:ro
```

Madoのedgeには、未知のHostを拒む`default_server`（80番と443番）があります。このtemplateは`default_server`を持たないので、そのまま並べられます。

### 単独のnginxで動かす

`nginx:1.28-alpine`をhost networkで動かし、templateを`/etc/nginx/templates/`へ、`/etc/letsencrypt`と`/var/www/letsencrypt`をread-onlyでmountします。未知のHostに421を返す`default_server`を別に置きます（Madoの`edge.conf.template`の最初と5番目の`server`と同じもの）。置かないと、最初に読まれたserverが既定になります。

IPv6の無いhost（kernelでIPv6を切っているもの）では、`listen [::]:...`の行を消します。残すとnginxが起動しません。

## firewall

```bash
sudo ufw allow 80/tcp comment 'ACME HTTP-01 for the runner API hostname'
sudo ufw allow 443/tcp comment 'Public runner API (Job tokens only)'
```

- 計算ノードの送信元アドレスが分かっているなら、templateの`allow`・`deny`（443番のserverの中、コメント）で絞ります。webhookを外部サービスから受けるときは、その送信元も入れます。
- Job tokenのrouteには回数の制限を付けていません。スパコンでは、多くの計算ノードが同じNATのアドレスから来るためです。

## 証明書の取得と更新

```bash
sudo certbot certonly --webroot --webroot-path /var/www/letsencrypt --domain "$MMT_RUNNER_API_HOSTNAME"
```

更新の後は、edgeで`nginx -t`を確かめてから`nginx -s reload`します（Madoの`scripts/certbot-deploy-hook.sh`と同じ手順です）。

## 確かめる

```bash
H=mmt-runner.example.org
curl -s "https://$H/api/health"                                   # 401 job_token_required
curl -s "https://$H/api/auth/config"                              # 404 not_found
curl -s "https://$H/"                                             # 404 not_found
curl -s -o /dev/null -w '%{http_code}\n' "http://$H/api/health"   # 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST -d '{}' "https://$H/api/hooks/<id>/webhook"   # 401 invalid_signature（APIの応答）
```

Job tokenは動いているJobにしか無いので、200の確認は小さいJobを1つ動かし、runnerのheartbeatがtrackingに届くことで確かめます。

## 制限

- MLflowのmultipart upload（`MLFLOW_ENABLE_PROXY_MULTIPART_UPLOAD=true`）は使えません。部品のPUTが`Authorization`を持たないためです。サイトで動かすコードでは、既定（無効）のままにします。
- 大きな出力も、今はこのhostnameとAPIを通ります（署名付きURLでの直接のuploadは、[設計案](../../docs/design/external-execution.md)の後の段階です）。
- 内側の`web`のnginxは`X-Forwarded-Proto`を`http`に書き換えます。APIがこの値を使うのはMLflowのmultipartの部品URLだけで、それは公開していないので影響はありません。

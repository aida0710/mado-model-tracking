# フックとドライバー

フックは、Projectで何かが起きたときにJobを起動します。モデル登録後の自動実行ruleを広げたもので、登録だけでなくRunの終了、arrayの終了、学習中のcheckpointの保存、外部からのwebhook、手動の起動をきっかけにできます。ドライバーは、Job内のコードが自分のJob tokenで子Jobを作り、待ち、結果を読む仕組みです。パイプラインの定義を書く代わりに、段階のつなぎ方をコードで書きます。

APIの詳細は[api-contract.md](api-contract.md)の「フックとドライバー」、型の正本は[contracts](../packages/contracts/src/hooks.ts)です。自動実行ruleは今までどおり使えます（[containers-automation.md](containers-automation.md)）。

## フックを作る

フックはProjectのeditorが作り、所有者（作成時は作った人）として動きます。所有者がProjectのeditorでなくなると、起動は`skipped`（`owner_access_revoked`）になります。設定は作成後に変えられません（有効・無効と所有者だけを変えられます）。変えたいときは新しいフックを作り、古いものを無効にします。

```bash
curl -sS -X POST "$MMT_API_URL/api/projects/$PROJECT_ID/hooks" \
  -H "Authorization: Bearer $MMT_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "name": "学習後の評価",
    "trigger": "run_finished",
    "filter": {"runKinds": ["training"], "runStatuses": ["finished"]},
    "template": {
      "experimentId": "<Experiment ID>",
      "kind": "evaluation",
      "codeVersionId": "<評価のCodeVersion ID>",
      "inheritModelVersion": true,
      "inheritOutputDatasets": true,
      "targetId": "<site ID>",
      "gpuCount": 1,
      "walltimeSeconds": 7200
    }
  }'
```

`template`は1回の起動で作るJobです。作成時に、Code・実行先・runtime・GPU・入力を起動と同じように確かめるので、起動できないフックは作成の時点で422になります。

| trigger | 起動するとき | Jobへ渡すもの |
|---|---|---|
| `manual` | `POST /projects/:p/hooks/:id/trigger` | 起動時の`payload` |
| `model_registered` | ModelVersionの登録。学習中の登録は学習Runの成功を待つ | 登録されたバージョン |
| `run_finished` | Runの終了（失敗・取消を含む。`runStatuses`で絞る） | `inheritModelVersion`・`inheritOutputDatasets`でRunのバージョンと出力 |
| `array_finished` | arrayの全員の最後の試行が終わったとき | 全員の出力DatasetVersion |
| `checkpoint_saved` | `POST /projects/:p/runs/:r/checkpoints`でのcheckpointの保存 | そのcheckpoint（`/mmt/inputs/checkpoint`） |
| `webhook` | 署名の合う外部からのPOST | 送られた本文 |

`filter`の`modelFamilies`・`experimentIds`・`runKinds`・`runStatuses`・`tags`は、全部に合う出来事だけで起動します。合わない出来事は記録も残しません。`manual`と`webhook`には条件を付けられず、`model_registered`と`checkpoint_saved`には`runStatuses`を付けられません（その時点で学習Runは終わっていないため）。`template.arraySize`を指定するとarrayを起動します（siteだけ）。

### 所有者をService Accountへ移す

作った人がProjectを離れると、その人のフックは止まります。長く使うフックは、Project adminがService Accountへ移します（フックの詳細の「Service Accountへ移す」か`PUT /projects/:p/hooks/:id/owner`、SDKの`transfer_hook_owner`）。移管先は同じProjectの有効なService Accountで、roleがeditorかadminのものです。以後の起動はそのService Accountの権限で動き、作るRunの作成者もそのService Accountになります。作った人の記録（`createdBy`）は残ります。

SSOのgroup同期の期限（[operations.md](operations.md)の「SSOユーザーのAPI tokenの同期期限」）は、フックの所有者に掛けません。所有者がしばらくログインしなくてもフックは動き続け、フックのJobのJob tokenも使えます。止まるのは、所有者がProjectのeditorでなくなったときです。Authentikでgroupから外しても、次にgroupが同期される（その人のログインか、使用中のsessionの再確認）まではgroup由来のProject権限が残るので、すぐ止めたいときは全体管理者がユーザーを無効化するか、フックを無効にします。

## 起動の記録

起動ごとに記録（HookExecution）が残ります。`GET /projects/:p/hook-executions?hookId=<id>`で新しい順に読めます。

| status | 意味 |
|---|---|
| `queued` | JobかarrayのJobを作りました（`jobId`か`arrayGroupId`） |
| `pending` | 待っています（`waitingRunId`のRunの終了） |
| `skipped` | 起動しませんでした（`reason`） |
| `failed` | JobやRunを作れませんでした（`error`）。出来事そのものは取り消しません |

`skipped`の`reason`は次のどれかです。

- `loop_detected`: 同じ連鎖に同じフックがもういます。フックが自分の起動したJobの終了で起動し続けることはありません。
- `chain_too_deep`: フックとドライバーの連鎖が10段を超えました。
- `rate_limited`: 直近1時間の起動が`maxStartsPerHour`（既定60）に達しました。
- `already_running`: `concurrency: "skip_if_running"`（または`checkpointMode: "skip_if_running"`）で、このフックのJobがまだ終わっていません。
- `superseded`: `checkpointMode: "latest"`で、より新しいcheckpointが来ました。
- `source_run_unsuccessful`・`source_run_timeout`: 学習中に登録されたバージョンで、学習Runが成功しなかった、または7日待っても終わりませんでした。
- `owner_access_revoked`・`hook_disabled`: 所有者の権限が無くなった、待っている間にフックが無効にされた。

同じ出来事では1回だけ起動します。webhookの再送、終わったRunの再開と再終了でも、Jobは増えません。

## 学習中のcheckpointで評価する

`checkpoint_saved`のフックは、学習Runが保存したcheckpointごとにJobを起動します。評価のJobにはcheckpointがread-onlyで置かれ、場所は`MMT_INPUT_CHECKPOINT_DIR`（ふつうは`/mmt/inputs/checkpoint`、再開のcheckpointも持つJobでは`/mmt/inputs/input-checkpoint`）、内容の説明は`MMT_INPUT_CHECKPOINT_FILE`で分かります。

| checkpointMode | 動き |
|---|---|
| `every`（既定） | 保存のたびに起動します |
| `every_k` | そのRunのk個ごと（`checkpointEvery`）に起動します |
| `latest` | 評価が動いている間に来たcheckpointは、最新の1つだけが待ち、前の評価が終わると起動します |
| `skip_if_running` | 評価が動いている間に来たcheckpointは起動しません |

MLflowの`checkpoints/step-N/`に置いたcheckpointでは起動しません（ファイルが揃った時点が分からないため）。SDKのcheckpoint APIを使ってください。

## 外部のwebhookで起動する

`trigger: "webhook"`のフックには、サーバーに`MMT_HOOK_SECRET_KEY`（base64の32 byte。`openssl rand -base64 32`）が要ります。作成の応答の`webhookSecret`は一度だけ表示されるので、送り手の設定にすぐ写します。サーバーはsecretを暗号化して保存します。

| webhookSignature | 署名 | 重複の判定 |
|---|---|---|
| `github` | `X-Hub-Signature-256: sha256=<HMAC-SHA256(secret, 本文)>` | `X-GitHub-Delivery` |
| `mmt` | `X-MMT-Signature: t=<unix秒>,v1=<HMAC-SHA256(secret, "<t>.<本文>")>`（時刻のずれは5分まで） | `X-MMT-Delivery` |

GitHubでは、repositoryのWebhooksに`<APIのURL>/api/hooks/<フックのID>/webhook`、Content typeに`application/json`、Secretに`webhookSecret`を設定します。LANの中の送り手からは`mmt`の署名を使えます。

```bash
body='{"dataset":"speech-v3"}'
t=$(date +%s)
sig=$(printf '%s.%s' "$t" "$body" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | sed 's/^.* //')
curl -sS -X POST "$MMT_API_URL/api/hooks/$HOOK_ID/webhook" \
  -H 'Content-Type: application/json' -H "X-MMT-Signature: t=$t,v1=$sig" \
  -H "X-MMT-Delivery: $(uuidgen)" -d "$body"
```

受け付けると202で`executionId`を返します。署名が合わなければ401、無効なフックは409です。本文は256KiBまでです。webhookのURLを外へ公開するときは、edgeで`/api/hooks/*/webhook`だけを通します。

## Jobから見えるもの

フックのJobのWorkerJobには`triggerPayload`が入り、コンテナには`/mmt/context/trigger-payload.json`（`MMT_TRIGGER_PAYLOAD_FILE`）として渡ります。manualは起動時の`payload`、webhookは本文（JSONのobject。それ以外は`{"body": "<本文>"}`）、それ以外のtriggerは`{"event": "run_finished", "runId": …}`のような出来事の説明です。起動したRunは出来事のRunの下に入り（`parentRunId`）、予約tag `mmt.hookId`・`mmt.hookExecutionId`を持ちます。

## ドライバー（子Job）

Jobを`allowChildJobs: true`で作ると、そのJobのコードは自分のJob tokenで子Jobを作れます。音声の生成→品質の判定→学習のように、段階ごとに別の実行先やGPU数を使う処理を、1つのコードで順に進められます。

- `POST /projects/:p/jobs/:j/children`で子Jobを作ります。`idempotencyKey`は必須で、同じkeyの再送（ドライバーの再起動を含む）は作成済みのJobを返します。`arraySize`を指定するとarrayを作ります。
- `GET /projects/:p/jobs/:j/children/wait?timeoutSeconds=60`で、子が全部終わるまで（最長60秒）待ちます。終わっていなければ`done: false`なので、もう一度呼びます。
- 子のRunは親のRunの下に入り、作成者は親のRunの作成者です。子の出力は、子のRunのArtifactとして読めます（Job tokenはProject内のRunを読めます）。
- 1つの親が作れる子は全部で10000件、同時に2000件までです。連鎖（フックと子Jobのつながり）は10段までです。
- 親Jobを取り消すと、終わっていない子Jobも取り消されます。

`allowChildJobs`の無いJobのtokenでは子Jobを作れません（403 `child_jobs_not_allowed`）。

SDKでは`ChildJobSpec`と`submit_child_job`・`wait_for_child_jobs`・`map_shards`を使います（[python/README.md](../python/README.md)の「ドライバー・フック・array」）。Jobの中では`Client()`がJob token（`MMT_API_TOKEN`）と`MMT_PROJECT_ID`・`MMT_JOB_ID`を読むので、IDを渡す必要はありません。

```python
from mado_tracking import ChildJobSpec, Client, map_shards

with Client() as client:
    spec = ChildJobSpec(name="generate", kind="processing", code_version_id="<CodeVersion ID>",
                        target_id="<site ID>", gpu_count=1)
    # shardごとに子Jobを作り（keyは "<key>:<番号>"）、全部終わるまで待つ
    jobs = map_shards(client, spec, [{"shard": index} for index in range(64)], key="generate-v1")
```

フックの手動起動（`client.trigger_hook`）は、人のAPI tokenで使います。Job tokenではフックを起動できません。Jobが起動したフックは新しい連鎖になり、循環の判定が効かなくなるためです。

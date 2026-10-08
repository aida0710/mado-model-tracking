---
title: Mado Model Trackingとは
description: MLflowの内製版として、学習の記録、モデルの登録、推論・評価の自動実行、昇格を1つのアプリで扱う。Madoとの関係も説明する。
---

# Mado Model Trackingとは

Mado Model Trackingは、機械学習の実験とモデルを管理するWebアプリです。MLflowを社内で運用しやすい形に作り直したもので、学習の記録、モデルの登録、推論と評価の自動実行、評価結果による昇格までを同じ記録の上で扱います。

公式のMLflow 3 SDKからそのまま記録でき、独自のPython SDKとAPIも用意しています。音声や重みのような大きなファイルは、ファイルシステムかS3互換ストレージに保存します。

![実験ごとにRunを並べたRunsの一覧画面](/images/guide-runs.png)

## こんなときに向いています

- 学習の結果をMLflowの書き方のまま記録したいが、保存先と権限は自分たちで管理したい
- 学習が終わってモデルを登録したら、推論と評価まで自動で回したい
- どのモデル版・コード・データセットで推論や評価をしたのかを、あとから確実にたどりたい
- 音声の出力をstepごと・版ごとに聴き比べたい
- AuthentikのgroupでProjectの権限を管理し、worker用には人に紐付かないtokenを使いたい

## 学習から昇格までの流れ

学習Runが出力したモデルを登録してから、推論と評価を経て`production`などのaliasを移すまでを、次の流れで自動化できます。

<ol class="mmt-flow">
  <li><strong>学習Run</strong><span>params・メトリクス・Artifactを記録</span></li>
  <li><strong>モデル版</strong><span>学習の出力を登録</span></li>
  <li><strong>推論Run</strong><span>自動実行ルールが起動</span></li>
  <li><strong>評価Run</strong><span>推論の出力を受け取る</span></li>
  <li><strong>昇格</strong><span>判定に合格したらaliasを移す</span></li>
</ol>

1. **学習**: Python SDKやMLflow 3 SDKから、params、メトリクス、ログ、Artifactを記録します。workerで実行したJobの学習Runは、出力を宣言しておくと、成功時にモデル版として登録されます。
2. **自動登録**: 版の番号はMLflowと同じく整数で自動採番します。登録した版の中身は後から変わりません。
3. **自動推論**: モデル系列に合う自動実行ルールが、推論のJobを登録します。workerがSSH先やコンテナでコードを実行します。
4. **自動評価**: 上流に推論ルールを指定した評価ルールが、推論Runの出力を受け取って評価します。
5. **昇格**: 昇格policyが評価の指標を基準の版（既定はalias `production`の版）と比べ、合格なら判定を残します。自動昇格を有効にしたpolicyでは、aliasも新しい版へ移します。

モデル版の画面では、学習Runから版、推論・評価Runまでのつながりと、自動実行の結果を確認できます。

![学習Run、モデル版、推論Run、評価Runのつながりと自動実行の一覧](/images/guide-model-version-automation.png)

## 管理するもの

| 対象 | 内容 |
| --- | --- |
| Project | 記録と権限の単位。メンバー、Authentikのgroup、Service Accountを設定します |
| Experiment・Run | 1回の学習・推論・評価の記録。params、メトリクス、ログ、system metrics、Artifact |
| モデルと版 | モデル系列、alias、生成元Run、重みのArtifact。版は不変です |
| Taskとコード版 | 実行するコード（Gitのcommit、単体のコード、コンテナ）と起動コマンド |
| Job・Compute target | workerが実行する要求と、その実行先（SSH、GPU、Docker、Singularity/Apptainer） |
| データセット版 | 推論・評価の入力や、Runの出力として登録するデータ |
| Artifact | 重み、音声、画像、表などのファイル。ファイルシステムかS3互換ストレージに保存します |

## Madoとの関係

Mado Model TrackingはMadoとは別のアプリとして動き、データベースも分かれています。Madoとはpluginを通して連携します。

- Madoで管理しているデータセットの版を検索し、データセット版として取り込む
- Runの開始と終了を、入出力のデータセット版と一緒にMadoのlineageへ送る
- Madoの容量のメトリクスを画面に表示する

ログイン方式はMadoと同じ構成です。Authentikのgroupでログインできる人と全体管理者を決め、ローカルアカウントとの併用や切り替えもできます。

## しないこと

- MLflowのTracing、GenAIの評価、Gateway、Prompt Registryは提供していません。
- presigned URLによるストレージとの直接転送はしません。アップロードとダウンロードはAPIを経由します。
- API serverからworkerホストへSSHしません。workerはworkerホスト上で導入・常駐させます。

## 次に読む

まず[インストール](/guide/install)でサーバーを起動し、[クイックスタート](/guide/quickstart)で最初のRunを記録してください。

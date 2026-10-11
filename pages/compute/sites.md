---
title: 外部のコンピュータ（site）
description: スーパーコンピュータ、研究室のGPUサーバー、自分のPCをWebからコンピュータとして足し、Jobを投入する。job shellの雛形、自分の設定、ランチャーが作る鍵、手動の投入。
---

# 外部のコンピュータ（site）

![全体設定の「コンピュータ」で開いたsiteの詳細。job shellとバージョンの履歴、自分の設定](/images/compute-site-details.png)

siteは、スーパーコンピュータ、SSHで入るGPUサーバー、研究者のPCのようなコンピュータです。ランチャーがsiteに入ってjob shellを実行し、スケジューラへJobを投入します（自分で投入するコンピュータでは、Jobを依頼した本人の`mado-tracking submit`が投入します）。計算ノードのrunnerは、Job tokenでtrackingへ直接報告します。

## 誰が足せて、誰が使えるか

siteは誰でも足せます。足した人が、そのコンピュータの所有者になります。

| 誰が | 足せるもの |
| --- | --- |
| 全体管理者 | site。SSH・Localも足せます（[Compute target](/compute/targets)） |
| 研究者 | siteだけ |

誰のJobが動くかは、コンピュータごとの公開範囲で決まります（[コンピュータと公開範囲](/compute/computers#visibility)）。

| 公開範囲 | Jobを動かせる人 |
| --- | --- |
| Public | どのProjectの人も |
| Private（既定） | 所有者と、所有者が作ったService Account |

Jobを作る画面の実行先には、自分が使えるコンピュータだけが出ます。公開範囲が入る前に研究者が足したsiteはPrivateになり、Projectへの共有はなくなりました。ほかの人にも使ってもらうときは、所有者がPublicにします。

## コンピュータを足す {#add-a-computer}

1. 右上のユーザーメニューの［全体設定］から、サイドバーの［コンピュータ］を開き（`/settings/computers`）、［コンピュータを追加］を押します。全体管理者は［Executor］で「Site」を選びます。研究者のダイアログはsite用だけです。
2. ［公開範囲］を選びます。既定のPrivateでは、自分と自分が作ったService AccountのJobだけが動きます。ほかの人にも使ってもらうならPublicにします。
3. 投入方式を選びます。
   - 自動: ランチャーがSSHでsiteに入って投入します。ランチャーと、接続先（host、port、経由するホスト、known_hosts）を入れます。known_hostsは、`ssh-keyscan`の出力をホスト鍵の指紋で確かめてから貼ります。
   - 手動: Jobを依頼した本人が、そのコンピュータの上で`mado-tracking submit`を実行して投入します。ログインに一時パスワードが要るsiteや、ランチャーから入れないPCで使います。
4. 自動のときは、ログインするアカウントを選びます。全員が1つのアカウントで動く「共用のアカウント」か、依頼した人のアカウントで動く「本人のアカウント」です。
5. 作業ディレクトリ（計算ノードからも同じパスで見える場所）、runnerのPython（3.11以上）、runnerから見たAPIのURL、変数（`NAME=VALUE`）などを入れます。
6. job shellの雛形（PBS、Slurm、Grid Engine、Fujitsu TCS、スケジューラのないDocker・Apptainerのホスト）を選び、キュー名・資源・グループをsiteの資料に合わせて直します。
7. ［保存］を押します。一覧の下に、そのコンピュータの詳細（job shell、鍵、自分の設定）が開きます。

job shellは内容を変えて保存するたびに新しいバージョンになり、Jobには投入に使ったバージョンが残ります。job shellと設定を変えられるのは、コンピュータの所有者と全体管理者です。

## 鍵と接続確認 {#keys-and-connection-checks}

自動のコンピュータでは、ランチャーがログイン用の鍵を作り、公開鍵をコンピュータの詳細に出します。秘密鍵はランチャーのホストから出ません。

- **共用のアカウント**: 所有者が、出た公開鍵を共用アカウントの`~/.ssh/authorized_keys`に登録します。利用者がすることはありません。
- **本人のアカウント**: 各自がコンピュータの［自分の設定］でアカウント名（と`GROUP`などの変数）を保存すると、ランチャーがその人用の鍵を作ります。出た公開鍵を、サイトの方法（利用者ポータルなど）で自分のアカウントに登録します。保存するまで、そのコンピュータにはJobを作れません。Service Accountは自分の設定を持てないので、本人のアカウントのsiteは使えません。
- ［接続を確認］で、ランチャーがその鍵とアカウントで実際にログインできるかを確かめます。
- サイトの利用規程で、他のホストからの自動ログインや公開鍵の追加が許されるか確かめてください。許されないsiteは手動にします。

## 手動で投入する

手動のコンピュータにJobを作ると、Jobsに手動投入待ちの案内が出ます。そのコンピュータの上（ログインノードや自分のPC）で実行します。

```bash
export MMT_API_URL=https://tracking.example.org MMT_API_TOKEN=<自分のAPI token>
mado-tracking submit --site <コンピュータのID> --dry-run      # 待っている件数と設定を見る
mado-tracking submit --site <コンピュータのID>                # 待っている自分のJobを1回投入する
mado-tracking submit --site <コンピュータのID> --watch        # 止めるまで繰り返す（自分のPC）
mado-tracking submit --site <コンピュータのID> --watch --all  # 所有者: Publicにしたとき、ほかの人のJobも投入する
```

他の人が足した手動投入のコンピュータのJobは、自分のアカウントで入れるコンピュータ（Publicのスパコンなど）なら、自分でそこから`mado-tracking submit`を実行して投入します。所有者のPCのように、所有者が`--watch --all`で待ち受けているコンピュータでは、所有者の側で投入されます。

tokenは、`jobs:write`（件数の表示には`read`も）を持つ本人のAPI tokenです。`--watch`を使わなければ何も常駐しません。`--all`のJobも、実行した人のアカウントで動きます。`--all`で受け取るのは、使ったtokenのProjectのJobだけです（書き込みのtokenはProjectごとに作るため）。複数のProjectのJobを受け取るときは、Projectごとにそのtokenで`--watch --all`を動かします。

## ほかの人のコンピュータを使う前に {#before-you-use-someone-elses-computer}

Publicのコンピュータを使うことは、その所有者を信頼することです。コンピュータの所有者と全体管理者は、job shellとrunnerの報告先を決めます。本人のアカウントで動くコンピュータ（自動の本人アカウント、手動）では、そのjob shellがあなたのアカウントで動きます。公開鍵を登録したり`mado-tracking submit`を実行したりする前に、所有者を信頼できるか確かめてください。

## 権限

| 操作 | 必要な権限 |
| --- | --- |
| 自分のコンピュータ（site）を足す | ログインしている人 |
| コンピュータの変更・公開範囲の変更、job shellの保存、共用アカウントの鍵 | 所有者か全体管理者 |
| そのコンピュータでJobを動かす | Publicは誰でも。Privateは所有者と、所有者が作ったService Account |
| 自分の設定の保存、自分の鍵の作り直し、自分のアカウントの接続確認 | そのコンピュータを使える人 |
| ランチャーの登録・tokenの作り直し・失効（「全体管理」→［ランチャー］） | 全体管理者 |

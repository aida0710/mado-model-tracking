---
title: 外部の計算機（site）
description: スーパーコンピュータ、研究室のGPUサーバー、自分のPCをWebから計算機として足し、Jobを投入する。job shellの雛形、自分の設定、launcherが作る鍵、手動の投入。
---

# 外部の計算機（site）

siteは、スーパーコンピュータ、SSHで入るGPUサーバー、研究者のPCのような計算機です。launcherがsiteに入ってjob shellを実行し、スケジューラへJobを投入します（自分で投入する計算機では、Jobを依頼した本人の`mado-tracking submit`が投入します）。計算ノードのrunnerは、Job tokenでtrackingへ直接報告します。

## 誰が足せるか

| 誰が | 足せるもの | 使える人 |
| --- | --- | --- |
| 全体管理者 | 全体の計算機 | どのProjectの人も |
| 研究者 | 自分の計算機（siteだけ） | 本人と、本人が共有したProject（本人がEditor以上のもの）のメンバー |

Jobを作る画面の実行先には、そのProjectで自分が使える計算機だけが出ます。

## 計算機を足す

1. Computeを開き、［計算機を追加］を押します。
2. 投入方式を選びます。
   - 自動: launcherがSSHでsiteに入って投入します。launcherと、接続先（host、port、経由するホスト、known_hosts）を入れます。known_hostsは、`ssh-keyscan`の出力をホスト鍵の指紋で確かめてから貼ります。
   - 手動: Jobを依頼した本人が、その計算機の上で`mado-tracking submit`を実行して投入します。ログインに一時パスワードが要るsiteや、launcherから入れないPCで使います。
3. 自動のときは、ログインするアカウントを選びます。全員が1つのアカウントで動く「共用のアカウント」か、依頼した人のアカウントで動く「本人のアカウント」です。
4. 作業ディレクトリ（計算ノードからも同じパスで見える場所）、runnerのPython（3.11以上）、runnerから見たAPIのURL、変数（`NAME=VALUE`）などを入れます。
5. job shellの雛形（PBS、Slurm、Grid Engine、Fujitsu TCS、スケジューラのないDocker・Apptainerのホスト）を選び、キュー名・資源・グループをsiteの資料に合わせて直します。
6. 自分の計算機は、共有するProjectを選べます。

job shellは保存のたびに新しい版になり、Jobには投入に使った版が残ります。job shellと設定を変えられるのは、計算機の所有者と全体管理者です。

## 鍵と接続確認

自動の計算機では、launcherがログイン用の鍵を作り、公開鍵を計算機の詳細に出します。秘密鍵はlauncherのホストから出ません。

- **共用のアカウント**: 所有者が、出た公開鍵を共用アカウントの`~/.ssh/authorized_keys`に登録します。利用者がすることはありません。
- **本人のアカウント**: 各自が計算機の［自分の設定］でアカウント名（と`GROUP`などの変数）を保存すると、launcherがその人用の鍵を作ります。出た公開鍵を、サイトの方法（利用者ポータルなど）で自分のアカウントに登録します。保存するまで、その計算機にはJobを作れません。
- ［接続確認］で、launcherがその鍵とアカウントで実際にログインできるかを確かめます。
- サイトの利用規程で、他のホストからの自動ログインや公開鍵の追加が許されるか確かめてください。許されないsiteは手動にします。

## 手動で投入する

手動の計算機にJobを作ると、Jobsに手動投入待ちの案内が出ます。その計算機の上（ログインノードや自分のPC）で実行します。

```bash
export MMT_API_URL=https://tracking.example.org MMT_API_TOKEN=<自分のAPI token>
mado-tracking submit --site <計算機のID> --dry-run      # 待っている件数と設定を見る
mado-tracking submit --site <計算機のID>                # 待っている自分のJobを1回投入する
mado-tracking submit --site <計算機のID> --watch        # 止めるまで繰り返す（自分のPC）
mado-tracking submit --site <計算機のID> --watch --all  # 所有者: 共有した人のJobも投入する
```

tokenは、`jobs:write`（件数の表示には`read`も）を持つ本人のAPI tokenです。`--watch`を使わなければ何も常駐しません。`--all`のJobも、実行した人のアカウントで動きます。

## 共有された計算機を使う前に

計算機の所有者と全体管理者は、job shellとrunnerの報告先を決めます。本人のアカウントで動く計算機（自動の本人アカウント、手動）では、そのjob shellがあなたのアカウントで動きます。公開鍵を登録したり`mado-tracking submit`を実行したりする前に、所有者を信頼できるか確かめてください。

## 権限

| 操作 | 必要な権限 |
| --- | --- |
| 自分の計算機（site）を足す | ログインしている人 |
| 計算機の変更・共有、job shellの保存、共用アカウントの鍵 | 所有者か全体管理者 |
| 自分の設定の保存、自分の鍵の作り直し、自分のアカウントの接続確認 | その計算機を使える人 |
| launcherの登録・tokenの作り直し・失効（［全体管理］→［launcher］） | 全体管理者 |

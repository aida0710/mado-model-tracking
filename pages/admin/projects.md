---
title: Projectの作成と管理
description: Projectの切り替えと作成、公開範囲（Public・Private）、アーカイブと元に戻す方法、完全に削除する方法。
---

# Projectの作成と管理

Projectは、実験、モデル、データセット、Artifactをまとめる単位です。メンバーの権限とArtifactの保存先も、Projectごとに決まります。

| 操作 | できる人 | 場所 |
| --- | --- | --- |
| 作成 | 無効化されていないユーザー全員 | Projectの切り替えの［＋ プロジェクトを作成］。全体管理者は「全体管理」→［プロジェクト］からも |
| 説明・公開範囲・保存先の変更 | ProjectのAdmin | ［プロジェクト設定］の「プロジェクト」 |
| アーカイブ | ProjectのAdmin、全体管理者 | ［プロジェクト設定］の最下部、「全体管理」→［プロジェクト］ |
| 元に戻す・完全に削除 | 全体管理者 | 「全体管理」→［プロジェクト］ |

## Projectを切り替える

サイドバーの上の「プロジェクト」で、今のProjectの名前を押します。幅の狭い画面では、上部バーの下にあります。

![Projectの切り替え。名前、Private、自分のRoleが並び、一番下に「プロジェクトを作成」がある](/images/admin-project-switcher.png)

一覧には、自分が見られるProject（PublicのProjectと、メンバーになっているPrivateのProject）が出ます。各行には名前と自分のRoleが並び、Privateには鍵の印が付きます。今のProjectには印が付きます。

- ↑↓で選んでEnterで開きます。Escで閉じます。
- Projectが8件以上あると、上に絞り込みの入力欄が出ます。
- 一番下の［＋ プロジェクトを作成］から、新しいProjectを作れます。

## Projectを作成する

1. Projectの切り替えを開き、一番下の［＋ プロジェクトを作成］を押します。全体管理者は、「全体管理」→［プロジェクト］の［プロジェクトを作成］からも作れます。
2. 次の値を入力します。
3. ［作成］を押します。

| 項目 | 入力する値 |
| --- | --- |
| 名前 | 必須。例: `音声認識の実験` |
| 説明（任意） | Projectの目的など |
| 公開範囲 | 「Public」（既定）か「Private」。違いは次の節 |
| メンバー（任意） | Privateを選んだときだけ出ます。下の手順で追加します |
| Artifact保存先 | 既定の保存先が選ばれています（[保存先の設定](/data/storage)） |

作成すると、そのProjectが開きます。作成した人は、そのProjectのAdminになります。

![Privateを選び、メンバーを2人追加したプロジェクトの作成画面](/images/admin-project-create.png)

Privateで、ほかに使う人がいるときは「メンバー（任意）」で追加します。

1. ［メンバーを追加］の欄に、名前、メールアドレス、ユーザー名の先頭を入力し、候補からユーザーを選びます。SSOのユーザーは、一度ログインするまで候補に出ません。
2. 行ごとにRoleを選びます。既定はEditorです。
3. 外すときは、その行の［外す］を押します。

候補には、有効な人のアカウントだけが出ます。自分、Service Account、無効化したユーザーは出ません。メンバーは、あとから［プロジェクト設定］の「Members」でも追加できます（[権限とRole](/admin/permissions)）。

見られるProjectが1つも無いときは、ログインすると「プロジェクト」の画面が出ます。［プロジェクトを作成］から最初のProjectを作ります。

## 公開範囲（PublicとPrivate） {#visibility}

| 公開範囲 | 見られる人 | Role |
| --- | --- | --- |
| Public | ログインできる全員 | メンバーに追加しなくても、Editorとして使えます |
| Private | メンバー（直接付与、groupへの付与）だけ | メンバーに付けたRole |

- PublicのProjectでも、Adminはメンバー（直接付与、groupへの付与）にだけ付きます。
- Publicでは、ログインできる全員がEditor以上になります。メンバーにViewerを付けても、その人はEditorとして使えます。見るだけにしたい人がいるときは、Privateにします。
- Publicの権限が付くのは、有効な人のアカウントだけです。Service Accountとランチャーには付きません。
- 「Members」の一覧と、「全体管理」→［プロジェクト］の「メンバー数」には、Publicで使っているだけの人は出ません。

公開範囲は、ProjectのAdminが［プロジェクト設定］の「プロジェクト」で変えます。［公開範囲］で選び、［保存］を押します。

公開範囲の機能が入る前からあるProjectは、更新したときにPrivateになります。それまでと同じく、メンバーだけが見られます。

### 全体管理者

全体管理者は、ブラウザでログインしていれば、PrivateのProjectもメンバーでないProjectも、Adminとして扱われます。Projectの切り替えには、アーカイブしていないすべてのProjectが出ます。

API tokenで操作するときは、全体管理者でも、そのProjectのRoleが必要です（[権限とRole](/admin/permissions)）。

## アーカイブする

使わなくなったProjectは、アーカイブすると一覧から消えます。データは消えず、全体管理者があとから元に戻せます。

1. ［プロジェクト設定］の一番下の「プロジェクトをアーカイブ」で、［アーカイブ］を押します。全体管理者は、「全体管理」→［プロジェクト］の行の［アーカイブ］からもできます。
2. 確認のダイアログで［アーカイブ］を押します。

アーカイブしたProjectは、Projectの切り替えから消え、誰も開けなくなります。Run、モデル、Artifactなどのデータは残ります。

- 待機中・実行中のJobがあると、アーカイブできません（409 `project_has_active_jobs`）。［Jobs］でJobが終わるのを待つか、止めてからもう一度アーカイブします。
- アーカイブの間は、そのProjectに限定したAPI token（workerやService Accountのものを含む）が401になります。SDKで記録中のRunも、それ以降は記録できません。
- Sweep、フック、推論・評価の自動実行、自動の昇格も止まります。

## 元に戻す

全体管理者が戻します。

![アーカイブ済みのProjectも表示した「全体管理」の「プロジェクト」](/images/admin-projects.png)

1. サイドバーの「全体管理」で［プロジェクト］を開きます。
2. 「アーカイブ済みも表示」を選びます。アーカイブしたProjectが「アーカイブ済み」として出ます。
3. その行の［元に戻す］を押し、確認のダイアログで［元に戻す］を押します。

メンバーとデータは、アーカイブする前のまま使えます。Projectに限定したAPI tokenも、また使えるようになります。

## 完全に削除する

アーカイブしたProjectを、データごと消します。元に戻せません。全体管理者だけが、アーカイブ済みのProjectだけを削除できます。

1. 「全体管理」→［プロジェクト］で、「アーカイブ済みも表示」を選びます。
2. 削除するProjectの行で［完全に削除］を押します。
3. 「確認のため、プロジェクト名を入力してください」にProjectの名前を入力し、［完全に削除］を押します。

削除すると、次のようになります。

- Run、モデル、データセット、Artifact、Job、レポート、メンバーとgroupへの付与など、Projectに属するものがすべて消えます。
- Artifactの保存先のファイルは、猶予（`MMT_ARTIFACT_DELETE_GRACE_DAYS`、既定7日）が過ぎてから、ガベージコレクタが消します。猶予の間は保存先にファイルが残ります。
- そのProjectに限定したAPI tokenは失効し、Service Accountは無効になります。
- 監査ログは残ります。「全体管理」→［監査ログ］で読めます。
- 外部の計算機に置いたデータセットのキャッシュなど、mado ML Trackingの外にあるものは消えません。

アーカイブしていないProjectは削除できません（409 `project_not_archived`）。

## 監査ログ

Projectの作成と管理の操作は、監査ログに残ります（[監査ログ](/admin/audit)）。

| 操作 | 監査ログの操作名 |
| --- | --- |
| 作成 | `project.create`。作成時に追加したメンバーは`project.member.set` |
| 説明・公開範囲・保存先の変更 | `project.update` |
| アーカイブ | `project.archive` |
| 元に戻す | `project.restore` |
| 完全に削除 | `project.purge` |

## APIで操作する

| 操作 | API | 必要な権限 |
| --- | --- | --- |
| 作成 | `POST /api/projects`（`name`、`description`、`visibility`、`artifactBackend`、`members`） | ログインしたユーザー。API tokenは`admin` scopeで、Projectに限定されていないもの |
| 変更 | `PATCH /api/projects/<Project ID>`（`description`、`visibility`、`artifactBackend`） | ProjectのAdmin |
| アーカイブ | `POST /api/projects/<Project ID>/archive` | ProjectのAdmin |
| 一覧（アーカイブ済みを含める） | `GET /api/admin/projects?includeArchived=true` | 全体管理者 |
| 元に戻す | `POST /api/admin/projects/<Project ID>/restore` | 全体管理者 |
| 完全に削除 | `DELETE /api/admin/projects/<Project ID>` | 全体管理者 |
| メンバーの候補の検索 | `GET /api/users?query=<名前の先頭>` | Projectを作れる人。Projectに限定したtokenでは、そのProjectのAdminと`admin` scope |

`visibility`は`public`か`private`、`members`は`{"userId": "<ユーザーID>", "role": "editor"}`の配列です。同じユーザーを2回書くと400、存在しないユーザーは404、Service Accountや無効なユーザーは400になり、Projectは作られません。詳しくは[独自API](/reference/api)を参照してください。

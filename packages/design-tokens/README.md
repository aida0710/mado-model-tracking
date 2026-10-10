# @mado/design-tokens

MadoとMado Model Trackingの画面が共有するCSSとIBM Plexの書体ファイルです。色・書体・角丸の変数のほか、要素の既定、共通の部品、画面の枠（上部バー・サイドバー・ドロワー・ログイン画面）を持ち、両アプリが同じclass名で使います。

| ファイル | 内容 |
|---|---|
| `tokens.css` | ライトとダークの配色、状態バッジ、上部バー、ログ表示、影、角丸、書体の並び、タップ領域の最小サイズ（`--tap-target`） |
| `fonts.css` | IBM Plex Sans・IBM Plex MonoのLatin subset（`fonts/`、SIL OFL 1.1） |
| `base.css` | 要素の既定（本文の書体と大きさ、入力欄、リンク、フォーカスの枠、見出し、コード）と小さな補助class（`.muted`・`.mono`・`.sr-only`など） |
| `components.css` | ボタン（`.button`・`.icon-button`・`.link-button`）、通知（`.notice`）、ページの見出し（`.page-header`）、区切りの見出し（`.section-heading`）、項目と値の一覧（`.details-list`）、JSONの表示（`.json-view`）、タブ（`.tabs`・`.tab`）、入力欄（`.field`）、ダイアログ（`.dialog`）、表、状態バッジ（`.status-badge`）、ポップオーバー、狭い幅で列を減らす表（`.responsive-table`） |
| `shell.css` | 上部バー（`.topbar`）、サイドバー（`.navigation-sidebar`）とアイコンだけの列、幅を変える境目、ドロワー（`.navigation-drawer`）、ログイン画面（`.login-page`） |

日本語の書体（Noto Sans JP）は各アプリが`@fontsource/noto-sans-jp`で同梱します。

## 使い方

各アプリの入口で、ほかのスタイルより先に、この順に読み込みます。

```ts
import '@mado/design-tokens/fonts.css';
import '@mado/design-tokens/tokens.css';
import '@mado/design-tokens/base.css';
import '@mado/design-tokens/components.css';
import '@mado/design-tokens/shell.css';
```

ダークテーマは`<html data-theme="dark">`のときに有効になります。

- Mado Model Tracking: npm workspaceのパッケージとして`apps/web`が依存し、`main.tsx`で上の順に読み込みます。
- Mado: `npm pack`で作ったtarballを`front/vendor/`に置き、`file:`で依存します（置き場所が決まるまでの暫定）。`base.css`・`components.css`・`shell.css`は、3つとも`@layer components`に入れて読み込みます（`@import "@mado/design-tokens/base.css" layer(components);`）。Tailwind v4のpreflight（`@layer base`）より強く、ユーティリティclassより弱くなり、共通のCSSどうしの優先順位はlayerを使わないMado Model Trackingと同じになります（要素の指定より`.numeric`などのclassが勝つ）。

### 画面の枠のclassと属性

- `.app-shell[data-navigation]`: サイドバーの形。`sidebar`（名前とアイコン）、`rail`（アイコンだけ）、`drawer`（上部バーのメニューボタンから開く）のどれかをアプリが入れます。`sidebar`のときは`.brand`（アプリ名）がサイドバーと同じ幅になります。
- `.navigation-sidebar[data-collapsed='true']`: アイコンだけの列にします。名前は`.navigation-label`に入れて読み上げ用に残し、`title`でツールチップにします。
- `.navigation-resize-handle`: サイドバーの右の境目。幅はアプリが`.app-shell`に`--navigation-width`を書いて変えます。ドラッグ中は`data-dragging='true'`を付けます。
- 切り替える幅は両アプリで同じにします。1200px以上は`sidebar`（手で`rail`に畳める）、900px以上1200px未満は`rail`、900px未満は`drawer`です。

## 変数と部品を足す・変えるときの決まり

- 名前は見た目でなく役割で付けます（`--teal`ではなく`--accent`）。
- 色は値で書かず、`tokens.css`の変数を使います。文字色は、置かれる面（`--background`〜`--selected`、tintの地）のすべてで4.5:1以上にします（WCAG AA）。線や印は3:1以上にします。
- ライトだけで足した色は、ダークでも見えるかを確かめ、必要なら`:root[data-theme='dark']`にも書きます。
- 角丸は`--radius-none`（入力・ボタン・表）、`--radius-sm`（小さな部品・パネル）、`--radius-pill`（バッジ）の3段です。円は`50%`を使います。
- メディアクエリは640px・900px・1200pxの3つだけを、範囲の書き方（`@media (width < 900px)`）で書きます。Mado Model Trackingの`designTokens.test.ts`が、色の値、未定義の変数、ほかの幅のメディアクエリが無いことを確かめます。
- 部品のclassを足すときは、片方のアプリだけで使うものは各アプリに置き、両方で使うものだけをここに置きます。
- MadoはTailwind v4を使います。Tailwindの既定テーマと同じ名前の変数（今は`--radius-sm`）は、layerの外に書く`tokens.css`の値が優先されます。新しい名前はTailwindの既定テーマ（`--color-*`、`--text-*`、`--shadow-sm`など）と重ならないものにします。

## 版を上げてMadoへ配る

1. `package.json`の`version`を上げ、`apps/web/package.json`の依存の版も合わせます。
2. `npm pack --workspace @mado/design-tokens --pack-destination <madoのfront/vendor>`でtarballを作ります。
3. Madoの`front/package.json`の依存を新しいtarballのパスに替えて`npm install`を実行し、古いtarballを消します。

別リポジトリかpackage registryへ移すときは、`private`を外し、両アプリの依存の書き方だけを替えます。

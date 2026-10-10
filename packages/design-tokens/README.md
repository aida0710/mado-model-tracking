# @mado/design-tokens

MadoとMado Model Trackingの画面が共有する色・書体・角丸の変数（CSS custom properties）と、IBM Plexの書体ファイルです。画面の幅や余白など、アプリごとに違う値はここに置きません。

| ファイル | 内容 |
|---|---|
| `tokens.css` | ライトとダークの配色、状態バッジ、上部バー、ログ表示、影、角丸、書体の並び |
| `fonts.css` | IBM Plex Sans・IBM Plex MonoのLatin subset（`fonts/`、SIL OFL 1.1） |

日本語の書体（Noto Sans JP）は各アプリが`@fontsource/noto-sans-jp`で同梱します。

## 使い方

各アプリの入口で、ほかのスタイルより先に読み込みます。

```ts
import '@mado/design-tokens/fonts.css';
import '@mado/design-tokens/tokens.css';
```

ダークテーマは`<html data-theme="dark">`のときに有効になります。

- Mado Model Tracking: npm workspaceのパッケージとして`apps/web`が依存します。
- Mado: `npm pack`で作ったtarballを`front/vendor/`に置き、`file:`で依存します（置き場所が決まるまでの暫定）。

## 変数を足す・変えるときの決まり

- 名前は見た目でなく役割で付けます（`--teal`ではなく`--accent`）。
- 文字色は、置かれる面（`--background`〜`--selected`、tintの地）のすべてで4.5:1以上にします（WCAG AA）。線や印は3:1以上にします。
- ライトだけで足した色は、ダークでも見えるかを確かめ、必要なら`:root[data-theme='dark']`にも書きます。
- 角丸は`--radius-none`（入力・ボタン・表）、`--radius-sm`（小さな部品・パネル）、`--radius-pill`（バッジ）の3段です。円は`50%`を使います。
- MadoはTailwind v4を使います。Tailwindの既定テーマと同じ名前の変数（今は`--radius-sm`）は、layerの外に書くこのファイルの値が優先されます。新しい名前はTailwindの既定テーマ（`--color-*`、`--text-*`、`--shadow-sm`など）と重ならないものにします。

## 版を上げてMadoへ配る

1. `package.json`の`version`を上げます。
2. `npm pack --workspace @mado/design-tokens --pack-destination <madoのfront/vendor>`でtarballを作ります。
3. Madoの`front`で`npm install ./vendor/mado-design-tokens-<version>.tgz`を実行し、古いtarballを消します。

別リポジトリかpackage registryへ移すときは、`private`を外し、両アプリの依存の書き方だけを替えます。

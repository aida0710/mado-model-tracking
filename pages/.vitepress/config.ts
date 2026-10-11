import { defineConfig } from "vitepress";

const repository = "https://github.com/aida0710/mado-ml-tracking";
const siteUrl = "https://aida0710.github.io/mado-ml-tracking/";
const base = process.env.MMT_DOCS_BASE ?? "/mado-ml-tracking/";

const jaDescription =
  "MLflow 3互換の実験管理アプリ。学習結果の登録、推論・評価の自動実行、音声などのArtifact、Authentikのgroupによる権限管理に対応。";
const enDescription =
  "An experiment tracking app compatible with MLflow 3: register training results, run inference and evaluation automatically, store audio and other Artifacts, and manage access with Authentik groups.";

const jaSidebar = [
  { text: "はじめる", items: [
    { text: "mado ML Trackingとは", link: "/guide/getting-started" },
    { text: "インストール", link: "/guide/install" },
    { text: "クイックスタート", link: "/guide/quickstart" },
  ] },
  { text: "実験の記録と分析", items: [
    { text: "Runの記録と一覧", link: "/tracking/runs" },
    { text: "Python SDK", link: "/tracking/sdk" },
    { text: "MLflow 3 SDKから記録", link: "/tracking/mlflow" },
    { text: "メトリクスの図", link: "/tracking/charts" },
    { text: "音声・画像・表の記録", link: "/tracking/media" },
    { text: "Runの比較", link: "/tracking/compare" },
    { text: "Sweep", link: "/tracking/sweeps" },
    { text: "メモとコメント", link: "/tracking/notes" },
  ] },
  { text: "モデルと自動実行", items: [
    { text: "モデルと版", link: "/models/registry" },
    { text: "Taskとコード版", link: "/models/tasks" },
    { text: "推論・評価の自動実行", link: "/models/automation" },
    { text: "評価と昇格", link: "/models/promotion" },
    { text: "学習の途中再開", link: "/models/checkpoints" },
  ] },
  { text: "実行環境", items: [
    { text: "Compute target", link: "/compute/targets" },
    { text: "外部の計算機（site）", link: "/compute/sites" },
    { text: "workerの導入", link: "/compute/worker" },
  ] },
  { text: "データと保存先", items: [
    { text: "Artifacts", link: "/data/artifacts" },
    { text: "大きなファイルのアップロード", link: "/data/uploads" },
    { text: "音声ビューア", link: "/data/audio" },
    { text: "データセット", link: "/data/datasets" },
    { text: "保存先の設定", link: "/data/storage" },
    { text: "共有レポート", link: "/data/reports" },
  ] },
  { text: "管理と権限", items: [
    { text: "認証方式とローカルアカウント", link: "/admin/auth" },
    { text: "AuthentikでSSO", link: "/admin/sso" },
    { text: "Projectの作成と管理", link: "/admin/projects" },
    { text: "権限", link: "/admin/permissions" },
    { text: "API tokenとService Account", link: "/admin/tokens" },
    { text: "監査ログ", link: "/admin/audit" },
    { text: "通知", link: "/admin/notifications" },
    { text: "pluginとMado連携", link: "/admin/plugins" },
  ] },
  { text: "リファレンス", items: [
    { text: "API", link: "/reference/api" },
    { text: "CLI", link: "/reference/cli" },
    { text: "環境変数", link: "/reference/environment" },
    { text: "セキュリティ", link: "/reference/security" },
    { text: "トラブルシューティング", link: "/reference/troubleshooting" },
  ] },
];

const enSidebar = [
  { text: "Get started", items: [
    { text: "What is mado ML Tracking?", link: "/en/guide/getting-started" },
    { text: "Install", link: "/en/guide/install" },
    { text: "Quickstart", link: "/en/guide/quickstart" },
  ] },
  { text: "Track and analyze experiments", items: [
    { text: "Record and list Runs", link: "/en/tracking/runs" },
    { text: "Python SDK", link: "/en/tracking/sdk" },
    { text: "Record from the MLflow 3 SDK", link: "/en/tracking/mlflow" },
    { text: "Metric charts", link: "/en/tracking/charts" },
    { text: "Audio, images, and tables", link: "/en/tracking/media" },
    { text: "Compare Runs", link: "/en/tracking/compare" },
    { text: "Sweeps", link: "/en/tracking/sweeps" },
    { text: "Notes and comments", link: "/en/tracking/notes" },
  ] },
  { text: "Models and automation", items: [
    { text: "Models and versions", link: "/en/models/registry" },
    { text: "Tasks and code versions", link: "/en/models/tasks" },
    { text: "Automatic inference and evaluation", link: "/en/models/automation" },
    { text: "Evaluation and promotion", link: "/en/models/promotion" },
    { text: "Resume training", link: "/en/models/checkpoints" },
  ] },
  { text: "Compute", items: [
    { text: "Compute targets", link: "/en/compute/targets" },
    { text: "External computers (sites)", link: "/en/compute/sites" },
    { text: "Install a worker", link: "/en/compute/worker" },
  ] },
  { text: "Data and storage", items: [
    { text: "Artifacts", link: "/en/data/artifacts" },
    { text: "Upload large files", link: "/en/data/uploads" },
    { text: "Audio viewer", link: "/en/data/audio" },
    { text: "Datasets", link: "/en/data/datasets" },
    { text: "Storage settings", link: "/en/data/storage" },
    { text: "Shared reports", link: "/en/data/reports" },
  ] },
  { text: "Administration and access", items: [
    { text: "Authentication modes and local accounts", link: "/en/admin/auth" },
    { text: "SSO with Authentik", link: "/en/admin/sso" },
    { text: "Create and manage Projects", link: "/en/admin/projects" },
    { text: "Permissions", link: "/en/admin/permissions" },
    { text: "API tokens and Service Accounts", link: "/en/admin/tokens" },
    { text: "Audit log", link: "/en/admin/audit" },
    { text: "Notifications", link: "/en/admin/notifications" },
    { text: "Plugins and Mado integration", link: "/en/admin/plugins" },
  ] },
  { text: "Reference", items: [
    { text: "API", link: "/en/reference/api" },
    { text: "CLI", link: "/en/reference/cli" },
    { text: "Environment variables", link: "/en/reference/environment" },
    { text: "Security", link: "/en/reference/security" },
    { text: "Troubleshooting", link: "/en/reference/troubleshooting" },
  ] },
];

export default defineConfig({
  title: "mado ML Tracking",
  description: jaDescription,
  lang: "ja",
  base,
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: siteUrl },
  head: [
    // 上部バーと同じ暗い色（@mado/design-system の --header）。
    ["meta", { name: "theme-color", content: "#151515" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "mado ML Tracking" }],
    ["meta", { property: "og:description", content: jaDescription }],
    ["meta", { property: "og:image", content: `${siteUrl}images/guide-model-version.png` }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["link", { rel: "icon", href: `${base}logo.svg`, type: "image/svg+xml" }],
  ],
  locales: {
    root: {
      label: "日本語",
      lang: "ja",
      themeConfig: {
        nav: [
          { text: "はじめる", link: "/guide/getting-started" },
          { text: "実験の記録", link: "/tracking/runs" },
          { text: "モデルと自動実行", link: "/models/registry" },
          { text: "管理", link: "/admin/auth" },
          { text: "リファレンス", link: "/reference/api" },
        ],
        sidebar: jaSidebar,
        editLink: { pattern: `${repository}/edit/main/pages/:path`, text: "このページを編集" },
        outlineTitle: "このページの内容",
        lastUpdatedText: "最終更新",
        docFooter: { prev: "前のページ", next: "次のページ" },
        sidebarMenuLabel: "メニュー",
        returnToTopLabel: "ページの先頭へ",
      },
    },
    en: {
      label: "English",
      lang: "en",
      link: "/en/",
      description: enDescription,
      head: [
        ["meta", { property: "og:title", content: "mado ML Tracking" }],
        ["meta", { property: "og:description", content: enDescription }],
      ],
      themeConfig: {
        nav: [
          { text: "Get started", link: "/en/guide/getting-started" },
          { text: "Tracking", link: "/en/tracking/runs" },
          { text: "Models", link: "/en/models/registry" },
          { text: "Administration", link: "/en/admin/auth" },
          { text: "Reference", link: "/en/reference/api" },
        ],
        sidebar: enSidebar,
        editLink: { pattern: `${repository}/edit/main/pages/:path`, text: "Edit this page" },
        outlineTitle: "On this page",
        lastUpdatedText: "Last updated",
        docFooter: { prev: "Previous page", next: "Next page" },
      },
    },
  },
  themeConfig: {
    // 名前はテーマの ProductLogo.vue で、印と太さを付けて組む。
    siteTitle: false,
    search: {
      provider: "local",
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: "検索", buttonAriaLabel: "検索" },
              modal: {
                displayDetails: "詳しく表示",
                resetButtonTitle: "検索をリセット",
                backButtonTitle: "検索を閉じる",
                noResultsText: "一致するページがありません",
                footer: { selectText: "選択", navigateText: "移動", closeText: "閉じる" },
              },
            },
          },
        },
      },
    },
    socialLinks: [{ icon: "github", link: repository }],
    footer: {
      copyright: "Copyright © www.aida0710.work",
    },
  },
  // mado のドキュメントと同じく、アプリの暗い枠と白い本文の一つの見た目にそろえ、テーマの切替は置かない。
  appearance: false,
});

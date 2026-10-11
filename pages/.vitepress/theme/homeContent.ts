// トップページ（Home.vue）の文言・目的別の入口・機能の紹介。日本語と英語で同じ構成にする。

export interface Feature {
  label: string
  title: string
  description: string
  /** public/images/ の画像名（拡張子なし）。 */
  image: string
  alt: string
  link: string
  action: string
}

export interface Entry {
  label: string
  title: string
  description: string
  link: string
}

export interface HomeContent {
  eyebrow: string
  title: string
  lead: string
  primaryAction: { text: string; link: string }
  secondaryAction: { text: string; link: string }
  hero: { image: string; alt: string; caption: string }
  entriesLabel: string
  entries: Entry[]
  featuresHeading: string
  features: Feature[]
}

const ja: HomeContent = {
  eyebrow: 'MLflow 3互換の実験管理',
  title: '学習の記録から、モデルの評価と昇格まで',
  lead: '公式のMLflow 3 SDKからそのまま記録でき、モデルバージョンの登録をきっかけに推論と評価を自動で実行します。音声などの大きなArtifactは、ファイルシステムかS3互換ストレージに保存します。',
  primaryAction: { text: '使い方を見る', link: '/guide/getting-started' },
  secondaryAction: { text: 'インストール', link: '/guide/install' },
  hero: { image: 'guide-runs', alt: '実験ごとにRunを並べたRunsの一覧', caption: '実験ごとにRunを並べ、メトリクスとパラメータで絞り込む。画面は見本データです。' },
  entriesLabel: '目的から探す',
  entries: [
    { label: 'Quickstart', title: '初めて使う', description: 'ログインから、最初のRunの記録まで', link: '/guide/quickstart' },
    { label: 'MLflow 3', title: '今の学習コードから記録する', description: '接続先を変えるだけで同じProjectへ', link: '/tracking/mlflow' },
    { label: 'Reference', title: '困ったときは', description: 'ログイン、記録、Job、保存先を確認', link: '/reference/troubleshooting' },
  ],
  featuresHeading: '画面で見る、mado ML Trackingの使い方',
  features: [
    { label: 'Tracking', title: 'Runを記録して比べる', description: 'params、メトリクス、ログ、GPU使用率を記録し、図を並べて比べます。全履歴から検索してCSVにも出せます。', image: 'tracking-charts', alt: '複数のRunのメトリクスを並べた図', link: '/tracking/charts', action: '図とRunの比較' },
    { label: 'Automation', title: '登録をきっかけに推論と評価', description: '学習の出力をモデルバージョンとして登録すると、モデル系列に合うルールが推論と評価のJobを順に実行します。使ったバージョン・コード・データは固定して残ります。', image: 'guide-model-version-automation', alt: 'モデルバージョンと自動実行の履歴', link: '/models/automation', action: '推論・評価の自動実行' },
    { label: 'Audio', title: '音声のArtifactを聴き比べる', description: '波形とスペクトログラムで音声を確認し、stepごとの出力を並べて聴き比べられます。', image: 'data-audio-viewer', alt: '波形とスペクトログラムを表示した音声ビューア', link: '/data/audio', action: '音声の確認' },
    { label: 'Lineage', title: 'データとモデルの来歴を辿る', description: 'どのデータセットのバージョンから、どのRunを経て、どのモデルバージョンができたか。入力と出力のつながりをグラフで確認します。', image: 'models-lineage', alt: 'データセットからRunとモデルバージョンへつながるLineageのグラフ', link: '/models/registry', action: 'モデルの登録とバージョン' },
    { label: 'Projects', title: 'プロジェクトと権限を分ける', description: 'Publicはログインできる全員がEditorとして使え、Privateはメンバーだけが使えます。Authentikのgroupにも権限を付けられます。', image: 'admin-projects', alt: '全体管理のプロジェクトの一覧', link: '/admin/projects', action: 'プロジェクトの管理' },
  ],
}

const en: HomeContent = {
  eyebrow: 'Experiment tracking compatible with MLflow 3',
  title: 'From training records to model evaluation and promotion',
  lead: 'Record from the official MLflow 3 SDK as is. Registering a model version starts inference and evaluation automatically. Large Artifacts such as audio are stored on a file system or in S3-compatible storage.',
  primaryAction: { text: 'Read the guide', link: '/en/guide/getting-started' },
  secondaryAction: { text: 'Install', link: '/en/guide/install' },
  hero: { image: 'guide-runs', alt: 'The Runs list grouped by experiment', caption: 'Runs grouped by experiment, filtered by metrics and parameters. The screen shows sample data.' },
  entriesLabel: 'Find by purpose',
  entries: [
    { label: 'Quickstart', title: 'First steps', description: 'From signing in to recording your first Run', link: '/en/guide/quickstart' },
    { label: 'MLflow 3', title: 'Record from existing training code', description: 'Change the endpoint to record to the same Project', link: '/en/tracking/mlflow' },
    { label: 'Reference', title: 'Troubleshooting', description: 'Sign-in, recording, Jobs and storage', link: '/en/reference/troubleshooting' },
  ],
  featuresHeading: 'See mado ML Tracking at work',
  features: [
    { label: 'Tracking', title: 'Record and compare Runs', description: 'Record params, metrics, logs and GPU usage, and compare Runs side by side in charts. Search the whole history and export it as CSV.', image: 'tracking-charts', alt: 'Charts comparing metrics of several Runs', link: '/en/tracking/charts', action: 'Charts and Run comparison' },
    { label: 'Automation', title: 'Inference and evaluation on registration', description: 'Registering a training output as a model version runs the inference and evaluation Jobs of the matching rule in order. The versions, code and data used stay fixed.', image: 'guide-model-version-automation', alt: 'A model version and its automation history', link: '/en/models/automation', action: 'Automated inference and evaluation' },
    { label: 'Audio', title: 'Listen to audio Artifacts side by side', description: 'Check audio with waveforms and spectrograms, and compare the outputs of each step by ear.', image: 'data-audio-viewer', alt: 'Audio viewer with a waveform and a spectrogram', link: '/en/data/audio', action: 'Audio viewer' },
    { label: 'Lineage', title: 'Trace data and model lineage', description: 'See which dataset version led through which Run to which model version, as a graph of inputs and outputs.', image: 'models-lineage', alt: 'Lineage graph from datasets through Runs to model versions', link: '/en/models/registry', action: 'Model registry and versions' },
    { label: 'Projects', title: 'Separate Projects and permissions', description: 'Public Projects are open to every signed-in user as an Editor; private ones only to their members. Roles can also be given to Authentik groups.', image: 'admin-projects', alt: 'The Project list in global administration', link: '/en/admin/projects', action: 'Managing Projects' },
  ],
}

/** 言語（VitePress の lang）ごとのトップページの内容。 */
export function homeContent(lang: string): HomeContent {
  return lang === 'en' ? en : ja
}

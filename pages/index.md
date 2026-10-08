---
layout: home
title: Mado Model Tracking
description: MLflow 3互換の実験管理アプリ。学習結果の登録、推論・評価の自動実行、音声などのArtifact、Authentikのgroupによる権限管理に対応。
sidebar: false
outline: false
---

<main class="mmt-home">
  <section class="mmt-hero">
    <div>
      <h1 class="mmt-title">Mado Model Tracking</h1>
      <p class="mmt-lead">学習の記録から、モデルの登録、推論と評価の自動実行、昇格までを1つの画面で扱う実験管理アプリです。公式のMLflow 3 SDKからそのまま記録でき、音声などの大きなArtifactは手元のファイルシステムかS3互換ストレージに保存します。</p>
      <div class="mmt-actions">
        <a class="mmt-action primary" href="./guide/getting-started">はじめる</a>
        <a class="mmt-action" href="./guide/install">インストール</a>
        <a class="mmt-action" href="./guide/quickstart">クイックスタート</a>
        <a class="mmt-action" href="https://github.com/aida0710/mado-model-tracking">GitHub</a>
      </div>
    </div>
    <div class="mmt-preview">
      <img src="/images/guide-runs.png" alt="実験ごとにRunを並べたRunsの一覧画面" width="1440" height="900">
    </div>
  </section>

  <section class="mmt-home-section">
    <div class="mmt-section-heading">
      <h2>学習から昇格までの流れ</h2>
      <p>学習Runが出力したモデルを版として登録すると、モデル系列に合うルールが推論と評価のJobを登録します。評価の結果が基準を満たせば、aliasを新しい版へ移せます。</p>
    </div>
    <ol class="mmt-flow">
      <li><strong>学習</strong><span>SDKやMLflowからparams・メトリクス・Artifactを記録</span></li>
      <li><strong>自動登録</strong><span>学習の出力をモデル版として登録。版は自動で採番</span></li>
      <li><strong>自動推論</strong><span>登録をきっかけに、推論コードのJobをworkerが実行</span></li>
      <li><strong>自動評価</strong><span>推論の出力を評価コードへ渡し、指標を記録</span></li>
      <li><strong>昇格</strong><span>基準の版と比べて合格なら<code>production</code>などのaliasを移す</span></li>
    </ol>
  </section>

  <section class="mmt-home-section">
    <div class="mmt-section-heading">
      <h2>主な機能</h2>
    </div>
    <div class="mmt-feature-grid">
      <article class="mmt-feature"><a href="./tracking/runs"><h3>Runの記録と検索</h3></a><p>params、メトリクス、ログ、GPU使用率などのsystem metricsを記録し、全履歴から検索・比較・CSV出力できます。</p></article>
      <article class="mmt-feature"><a href="./tracking/mlflow"><h3>MLflow 3互換API</h3></a><p>公式の<code>mlflow</code> SDKの記録、autolog、モデル登録、大きなファイルのmultipart uploadをそのまま使えます。</p></article>
      <article class="mmt-feature"><a href="./models/automation"><h3>推論・評価の自動実行</h3></a><p>モデル版の登録をきっかけに推論と評価を順に実行し、どの版・コード・データで動いたかを固定して残します。</p></article>
      <article class="mmt-feature"><a href="./data/audio"><h3>音声のArtifact</h3></a><p>波形とスペクトログラムで音声を確認し、stepごとの出力を聴き比べられます。</p></article>
      <article class="mmt-feature"><a href="./data/storage"><h3>ファイルシステムとS3</h3></a><p>保存先は全体設定で選びます。S3互換ストレージは署名v4とv2、path-style、独自のCAに対応しています。</p></article>
      <article class="mmt-feature"><a href="./admin/sso"><h3>Authentikのgroupで権限管理</h3></a><p>SSOとローカルアカウントを切り替えられます。groupにProjectのroleを付け、workerにはService Accountのtokenを渡します。</p></article>
    </div>
  </section>
</main>

---
layout: home
title: Mado Model Tracking
description: An experiment tracking app compatible with MLflow 3. Register training results, run inference and evaluation automatically, store audio and other Artifacts, and manage access with Authentik groups.
sidebar: false
outline: false
---

<main class="mmt-home">
  <section class="mmt-hero">
    <div>
      <h1 class="mmt-title">Mado Model Tracking</h1>
      <p class="mmt-lead">An experiment tracking app that covers training records, model registration, automatic inference and evaluation, and promotion in one place. Record with the official MLflow 3 SDK as is, and keep large Artifacts such as audio on a filesystem or S3-compatible storage you run.</p>
      <div class="mmt-actions">
        <a class="mmt-action primary" href="./guide/getting-started">Get started</a>
        <a class="mmt-action" href="./guide/install">Install</a>
        <a class="mmt-action" href="./guide/quickstart">Quickstart</a>
        <a class="mmt-action" href="https://github.com/aida0710/mado-model-tracking">GitHub</a>
      </div>
    </div>
    <div class="mmt-preview">
      <img src="/images/guide-runs.png" alt="The Runs list showing the Runs of one experiment" width="1440" height="900">
    </div>
  </section>

  <section class="mmt-home-section">
    <div class="mmt-section-heading">
      <h2>From training to promotion</h2>
      <p>When the model a training Run produced is registered as a version, the rules that match its model family queue inference and evaluation Jobs. If the evaluation meets the criteria, an alias can move to the new version.</p>
    </div>
    <ol class="mmt-flow">
      <li><strong>Train</strong><span>Record params, metrics, and Artifacts from the SDK or MLflow</span></li>
      <li><strong>Register</strong><span>The training output becomes a model version with an automatic number</span></li>
      <li><strong>Infer</strong><span>The registration queues an inference Job that a worker runs</span></li>
      <li><strong>Evaluate</strong><span>The inference outputs go to the evaluation code, which records metrics</span></li>
      <li><strong>Promote</strong><span>A passing comparison with the baseline moves an alias such as <code>production</code></span></li>
    </ol>
  </section>

  <section class="mmt-home-section">
    <div class="mmt-section-heading">
      <h2>Features</h2>
    </div>
    <div class="mmt-feature-grid">
      <article class="mmt-feature"><a href="./tracking/runs"><h3>Record and search Runs</h3></a><p>Record params, metrics, logs, and system metrics such as GPU utilization, then search, compare, and export the whole history to CSV.</p></article>
      <article class="mmt-feature"><a href="./tracking/mlflow"><h3>MLflow 3 compatible API</h3></a><p>Use the official <code>mlflow</code> SDK for tracking, autolog, model registration, and multipart uploads of large files.</p></article>
      <article class="mmt-feature"><a href="./models/automation"><h3>Automatic inference and evaluation</h3></a><p>A model version registration runs inference and then evaluation, and pins the model version, code, and data each Run used.</p></article>
      <article class="mmt-feature"><a href="./data/audio"><h3>Audio Artifacts</h3></a><p>Check audio with waveforms and spectrograms, and listen to the outputs of each step side by side.</p></article>
      <article class="mmt-feature"><a href="./data/storage"><h3>Filesystem and S3</h3></a><p>Choose the storage in the global settings. S3-compatible storage supports signature v4 and v2, path-style access, and a custom CA.</p></article>
      <article class="mmt-feature"><a href="./admin/sso"><h3>Access by Authentik group</h3></a><p>Switch between SSO and local accounts. Grant Project roles to groups, and give workers Service Account tokens.</p></article>
    </div>
  </section>
</main>

import { describe, expect, it } from 'vitest';
import { addWorkspaceFile, buildGitOverlay, buildWorkspaceSource, createCodeWorkspace,
  deleteWorkspaceFile, getWorkspaceSignature, loadWorkspaceRepository, restoreWorkspaceFile,
  validateFilePath, validateFilePaths, validateGitRepository } from './codeWorkspace';

const repository = { url: 'https://example.invalid/code.git', commit: 'a'.repeat(40) };
const base = { 'main.py': 'original', 'src/keep.py': 'unchanged', 'remove.py': 'old' };
const load = (workspace = createCodeWorkspace()) => loadWorkspaceRepository({ workspace, repository,
  response: { commit: repository.commit, files: base, omittedPaths: ['weights.bin'] } });

describe('Gitのコード編集', () => {
  it('Gitを読むと保存済みoverlayと削除を適用し、変更していないファイルを送らない', () => {
    const workspace = load(createCodeWorkspace({ kind: 'git', ...repository,
      files: { 'main.py': 'edited', 'new.py': 'new' }, deletedFiles: ['remove.py'] }));
    expect(workspace.files).toEqual({ 'main.py': 'edited', 'src/keep.py': 'unchanged', 'new.py': 'new' });
    expect(buildWorkspaceSource(repository, workspace)).toEqual({ kind: 'git', ...repository,
      files: { 'main.py': 'edited', 'new.py': 'new' }, deletedFiles: ['remove.py'] });
  });
  it('新規ファイルを追加してから削除するとGitへの差分は残らない', () => {
    const workspace = deleteWorkspaceFile(addWorkspaceFile(load(), 'new.py'), 'new.py');
    expect(buildGitOverlay(workspace)).toEqual({ files: {}, deletedFiles: [] });
  });
  it('元のファイルを削除すると削除パスを保存する', () => {
    expect(buildGitOverlay(deleteWorkspaceFile(load(), 'remove.py'))).toEqual({ files: {}, deletedFiles: ['remove.py'] });
  });
  it.each<[Record<string, string>, string[]]>([
    [{ 'src/main.py': 'new' }, ['src']],
    [{ src: 'new' }, ['src/main.py']],
    [{}, ['src', 'src/main.py']],
  ])('編集・削除のパスが親子で衝突するとGit overlayを保存しない（%j, %j）', (files, deletedFiles) => {
    const workspace = { ...createCodeWorkspace(), files, deletedFiles };
    expect(() => buildGitOverlay(workspace)).toThrow();
    expect(() => buildWorkspaceSource(repository, workspace)).toThrow();
  });
  it('同じディレクトリの別ファイルは編集と削除を一緒に保存できる', () => {
    const workspace = { ...createCodeWorkspace(), files: { 'src/main.py': 'edited' }, deletedFiles: ['src/old.py'] };
    expect(buildGitOverlay(workspace)).toEqual({ files: { 'src/main.py': 'edited' }, deletedFiles: ['src/old.py'] });
  });
  it('保存できない親子pathが編集中でも未保存の判定は継続する', () => {
    const values = { sourceKind: 'git' };
    const initial = { ...createCodeWorkspace(), deletedFiles: ['src'] };
    const edited = { ...initial, files: { 'src/main.py': 'new' } };
    expect(getWorkspaceSignature(values, edited)).not.toBe(getWorkspaceSignature(values, initial));
  });
  it('編集済みの内容で削除を取り消せて、親子pathが衝突すると復元しない', () => {
    const workspace = deleteWorkspaceFile(load(), 'remove.py');
    expect(restoreWorkspaceFile(workspace, 'remove.py', 'edited').files['remove.py']).toBe('edited');
    const nested = addWorkspaceFile(workspace, 'remove.py/main.py');
    expect(() => restoreWorkspaceFile(nested, 'remove.py')).toThrow();
  });
  it('Gitのbaseを読み込んだだけでは未保存の変更と見なさない', () => {
    const workspace = createCodeWorkspace({ kind: 'git', ...repository, files: { 'main.py': 'edited' }, deletedFiles: ['remove.py'] });
    const values = { sourceKind: 'git' };
    expect(getWorkspaceSignature(values, load(workspace))).toBe(getWorkspaceSignature(values, workspace));
    expect(getWorkspaceSignature({ ...values, artifactSearch: 'model.sif' }, workspace)).toBe(getWorkspaceSignature(values, workspace));
  });
  it('別repoを読むと旧repoの未変更ファイルをoverlayにせず、編集した内容を引き継ぐ', () => {
    const workspace = load();
    workspace.files['main.py'] = 'edited';
    const nextRepository = { ...repository, url: 'https://example.invalid/other.git', commit: 'b'.repeat(40) };
    const next = loadWorkspaceRepository({ workspace, repository: nextRepository,
      response: { commit: nextRepository.commit, files: { 'main.py': 'other', 'README.md': 'readme' }, omittedPaths: [] } });
    expect(next.files).toEqual({ 'main.py': 'edited', 'README.md': 'readme' });
    expect(buildGitOverlay(next).files).toEqual({ 'main.py': 'edited' });
    expect(() => buildWorkspaceSource(nextRepository, workspace)).toThrow();
  });
  it('取得したcommitが違うと編集元として取り込まない', () => {
    expect(() => loadWorkspaceRepository({ workspace: createCodeWorkspace(), repository,
      response: { commit: 'b'.repeat(40), files: base, omittedPaths: [] } })).toThrow();
  });
  it('Gitの編集対象外pathを新規ファイルで置き換えない', () => {
    expect(() => addWorkspaceFile(load(), 'weights.bin')).toThrow();
  });
  it.each(['/absolute', '../outside', 'src/../main.py', '.git/config', 'src/.GIT/config', 'C:/tmp/x', 'a\\b', 'a//b', 'x\0y'])('%sを拒否する', (path) => {
    expect(() => validateFilePath(path)).toThrow();
  });
  it('ファイル重複と隣り合わない親子pathの衝突も拒否する', () => {
    expect(() => validateFilePaths(['a.py', 'a.py'])).toThrow();
    expect(() => validateFilePaths(['a', 'a-b', 'a/b.py'])).toThrow();
  });
  it('短縮hashと認証情報付きURLを拒否する', () => {
    expect(() => validateGitRepository({ ...repository, commit: 'main' })).toThrow();
    expect(() => validateGitRepository({ ...repository, url: 'https://user:secret@example.invalid/code.git' })).toThrow();
    expect(() => validateGitRepository({ ...repository, url: 'git@example.invalid:code.git' })).not.toThrow();
  });
});

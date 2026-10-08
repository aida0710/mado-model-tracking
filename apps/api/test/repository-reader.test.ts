import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GitRepositoryReader } from '../src/services/repositoryReader.js';
import { runRepositoryCommand, type RepositoryCommand } from '../src/services/repositoryProcess.js';
import {
  decodeRepositoryBlobs,
  parseRepositoryTree,
  selectRepositoryBlobs,
} from '../src/domain/repositoryObjects.js';
import {
  MAX_CODE_FILE_BYTES,
  MAX_CODE_FILES,
  MAX_CODE_TEXT_BYTES,
} from '../src/domain/codeSourceValidation.js';
import { DomainError } from '../src/domain/errors.js';

const executeFile = promisify(execFile);
const directories: string[] = [];
const URL = 'https://example.test/fixture.git';
const OBJECT_ID = 'a'.repeat(40);
// Enough for a Node child and descendant to start even on a busy test machine.
const CHILD_START_DEADLINE_MS = 1000;
// These fixtures never need more than 4 MiB or 3 seconds.
const FIXTURE_DIRECTORY_BYTES = 4 * 1024 * 1024;
const FIXTURE_TIMEOUT_MS = 3000;

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'mmt-repository-fixture-'));
  directories.push(directory);
  return directory;
}

async function repositoryFixture() {
  const directory = await temporaryDirectory();
  const environment = {
    PATH: '/usr/bin:/bin',
    HOME: directory,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@localhost',
    GIT_COMMITTER_EMAIL: 'fixture@localhost',
  };
  const git = async (arguments_: string[]) =>
    (
      await executeFile('/usr/bin/git', arguments_, { cwd: directory, env: environment })
    ).stdout.trim();
  await git(['init', '--template=']);
  await writeFile(path.join(directory, 'main.py'), 'print("repository")\n');
  await chmod(path.join(directory, 'main.py'), 0o755);
  await writeFile(path.join(directory, 'binary.bin'), Buffer.from([0, 1, 2]));
  await git(['add', '--', 'main.py', 'binary.bin']);
  await git(['commit', '-m', 'test: 検証用repositoryを保存']);
  const commit = await git(['rev-parse', 'HEAD']);
  return { directory, commit, git };
}

function localRepositoryRunner(directory: string, observed: RepositoryCommand[] = []) {
  return async (command: RepositoryCommand): Promise<Buffer> => {
    observed.push(command);
    const fetchIndex = command.arguments.indexOf('fetch');
    if (fetchIndex === -1) return runRepositoryCommand(command);
    // Only the test transport is replaced. All object reads and process limits are production code.
    const arguments_ = [...command.arguments];
    const urlIndex = arguments_.indexOf('--', fetchIndex) + 1;
    arguments_[urlIndex] = directory;
    arguments_.unshift('-c', 'protocol.file.allow=always');
    return runRepositoryCommand({ ...command, arguments: arguments_ });
  };
}

function nodeCommand(
  directory: string,
  script: string,
  arguments_: string[] = [],
): RepositoryCommand {
  return {
    executable: process.execPath,
    arguments: ['-e', script, ...arguments_],
    directory,
    environment: { PATH: '/usr/bin:/bin' },
    timeoutMs: FIXTURE_TIMEOUT_MS,
    maxOutputBytes: 4096,
    maxDirectoryBytes: FIXTURE_DIRECTORY_BYTES,
  };
}

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe('固定commitのrepository preview', () => {
  it('実Git objectsからtextを読み、binaryを省略し、checkoutせず一時領域を消す', async () => {
    const fixture = await repositoryFixture();
    const observed: RepositoryCommand[] = [];
    const reader = new GitRepositoryReader({
      execute: localRepositoryRunner(fixture.directory, observed),
    });
    expect(await reader.read({ url: URL, commit: fixture.commit })).toEqual({
      commit: fixture.commit,
      files: { 'main.py': 'print("repository")\n' },
      omittedPaths: ['binary.bin'],
    });
    expect(
      observed.some(
        (command) => command.arguments.includes('checkout') || command.arguments.includes('clone'),
      ),
    ).toBe(false);
    expect(
      observed.every(
        (command) =>
          command.arguments.includes('credential.helper=') &&
          command.arguments.includes('core.hooksPath=/dev/null'),
      ),
    ).toBe(true);
    expect(
      observed.every(
        (command) =>
          !command.arguments.includes('http.sslCert=') &&
          !command.arguments.includes('http.sslKey='),
      ),
    ).toBe(true);
    const environment = observed[0]!.environment;
    expect(environment).toMatchObject({
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    });
    for (const name of [
      'SSH_AUTH_SOCK',
      'GITHUB_TOKEN',
      'HTTPS_PROXY',
      'MMT_API_TOKEN',
      'GIT_CONFIG_PARAMETERS',
    ])
      expect(environment).not.toHaveProperty(name);
    expect(environment.HOME).toBe(observed[0]!.directory);
    await expect(stat(observed[0]!.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('symlinkを含む固定commitは実Git treeから拒否し、一時領域を消す', async () => {
    const fixture = await repositoryFixture();
    await symlink('/etc/passwd', path.join(fixture.directory, 'linked'));
    await fixture.git(['add', '--', 'linked']);
    await fixture.git(['commit', '-m', 'test: symlinkの拒否を検証']);
    const commit = await fixture.git(['rev-parse', 'HEAD']);
    const observed: RepositoryCommand[] = [];
    const reader = new GitRepositoryReader({
      execute: localRepositoryRunner(fixture.directory, observed),
    });
    await expect(reader.read({ url: URL, commit })).rejects.toMatchObject({
      code: 'unsafe_repository',
      status: 422,
    });
    await expect(stat(observed[0]!.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('指定commitとの不一致と取得失敗で一時領域を消し、エラー詳細を公開しない', async () => {
    let directory = '';
    const reader = new GitRepositoryReader({
      execute: async (command) => {
        directory = command.directory;
        if (command.arguments.includes('rev-parse')) return Buffer.from('b'.repeat(40) + '\n');
        return Buffer.alloc(0);
      },
    });
    await expect(reader.read({ url: URL, commit: OBJECT_ID })).rejects.toMatchObject({
      code: 'repository_commit_mismatch',
    });
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    const failing = new GitRepositoryReader({
      execute: async (command) => {
        directory = command.directory;
        throw new Error('https://fixture:credential@example.test/private');
      },
    });
    await expect(failing.read({ url: URL, commit: OBJECT_ID })).rejects.toMatchObject({
      code: 'repository_read_failed',
      message: 'Repositoryを読み込めません',
    });
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('URLのcredentials/file schemeを取得前に拒否する', async () => {
    let wasExecuted = false;
    const reader = new GitRepositoryReader({
      execute: async () => {
        wasExecuted = true;
        return Buffer.alloc(0);
      },
    });
    for (const url of ['https://fixture:credential@example.test/private', 'file:///tmp/repo'])
      await expect(reader.read({ url, commit: OBJECT_ID })).rejects.toMatchObject({
        code: 'invalid_repository',
      });
    expect(wasExecuted).toBe(false);
  });

  it('operator指定SSH鍵/known_hostsだけを使い、pathをshell quoteする', async () => {
    let sshCommand = '';
    const reader = new GitRepositoryReader({
      ssh: { keyPath: "/fixture/read key'file", knownHostsPath: '/fixture/known hosts' },
      execute: async (command) => {
        sshCommand = command.environment.GIT_SSH_COMMAND!;
        throw new DomainError(502, 'Fixture stop', 'repository_read_failed');
      },
    });
    await expect(
      reader.read({ url: 'ssh://git@example.test/repo', commit: OBJECT_ID }),
    ).rejects.toMatchObject({ code: 'repository_read_failed' });
    expect(sshCommand).toContain("'-oIdentityAgent=none'");
    expect(sshCommand).toContain("'-oStrictHostKeyChecking=yes'");
    expect(sshCommand).toContain("'-oPreferredAuthentications=publickey'");
    expect(sshCommand).toContain("'\\''");
    const sshSettings = (
      await executeFile('/bin/sh', ['-c', `${sshCommand} -G fixture.example.test`], {
        env: { PATH: '/usr/bin:/bin' },
      })
    ).stdout;
    expect(sshSettings).toContain("identityfile /fixture/read key'file\n");
    expect(sshSettings).toContain('userknownhostsfile /fixture/known hosts\n');
    expect(sshSettings).not.toContain('identityfile ~/.ssh/');
  });

  it.each([
    `120000 blob ${OBJECT_ID} 5\tlinked\0`,
    `160000 commit ${OBJECT_ID} -\tsubmodule\0`,
    `100644 blob ${OBJECT_ID} 5\t.git/config\0`,
    `040000 tree ${OBJECT_ID} -\t.GIT\0`,
    `100644 blob ${OBJECT_ID} 5\t../escape\0`,
    `100644 blob ${OBJECT_ID} 5\tbad\nname\0`,
  ])('特殊file/unsafe treeを拒否する', (entry) => {
    expect(() => parseRepositoryTree(Buffer.from(entry))).toThrow(DomainError);
  });

  it('大きいfileと合計/件数の上限を超えるblobを省略し、元repoのパスを返す', () => {
    const blobs = [
      { path: 'large', objectId: OBJECT_ID, size: MAX_CODE_FILE_BYTES + 1 },
      { path: 'first', objectId: OBJECT_ID, size: MAX_CODE_TEXT_BYTES / 2 },
      { path: 'second', objectId: OBJECT_ID, size: MAX_CODE_TEXT_BYTES / 2 },
      { path: 'third', objectId: OBJECT_ID, size: 1 },
    ];
    expect(selectRepositoryBlobs(blobs).omittedPaths).toEqual(['large', 'third']);
    expect(
      selectRepositoryBlobs(
        Array.from({ length: MAX_CODE_FILES + 1 }, (_, index) => ({
          path: `file-${index}`,
          objectId: OBJECT_ID,
          size: 0,
        })),
      ).omittedPaths,
    ).toEqual([`file-${MAX_CODE_FILES}`]);
  });

  it('不正UTF8やNULのblobは省略し、batchサイズ偽装は拒否する', () => {
    const selected = [{ path: 'invalid', objectId: OBJECT_ID, size: 1 }];
    const contents = Buffer.concat([
      Buffer.from(`${OBJECT_ID} blob 1\n`),
      Buffer.from([0xff]),
      Buffer.from('\n'),
    ]);
    expect(
      decodeRepositoryBlobs({ commit: OBJECT_ID, selected, omittedPaths: [], contents }),
    ).toMatchObject({ files: {}, omittedPaths: ['invalid'] });
    expect(() =>
      decodeRepositoryBlobs({
        commit: OBJECT_ID,
        selected,
        omittedPaths: [],
        contents: Buffer.from(`${OBJECT_ID} blob 2\nxy\n`),
      }),
    ).toThrow(DomainError);
  });
});

describe('repository child processの停止と上限', () => {
  it('timeoutでgit相当のprocess groupと子processを停止する', async () => {
    const directory = await temporaryDirectory();
    const pidPath = path.join(directory, 'pids.json');
    const command = nodeCommand(
      directory,
      `const {spawn}=require('node:child_process'); const fs=require('node:fs');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      fs.writeFileSync(process.argv[1],JSON.stringify({parent:process.pid,child:child.pid})); setInterval(()=>{},1000);`,
      [pidPath],
    );
    await expect(
      runRepositoryCommand({ ...command, timeoutMs: CHILD_START_DEADLINE_MS }),
    ).rejects.toMatchObject({ code: 'repository_timeout' });
    const pids = JSON.parse(await readFile(pidPath, 'utf8')) as { parent: number; child: number };
    expect(() => process.kill(pids.parent, 0)).toThrow();
    try {
      // An orphan can briefly be a reaped-pending zombie; it cannot execute or retain the workspace.
      expect((await readFile(`/proc/${pids.child}/stat`, 'utf8')).split(' ')[2]).toBe('Z');
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
    }
  });

  it('stdout上限を超えたprocessを停止する', async () => {
    const directory = await temporaryDirectory();
    await expect(
      runRepositoryCommand({
        ...nodeCommand(
          directory,
          'process.stdout.write("a".repeat(8192));setInterval(()=>{},1000)',
        ),
        maxOutputBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: 'repository_too_large', status: 413 });
  });

  it('増加中のdownloadサイズを監視し、上限を超えたprocessを停止する', async () => {
    const directory = await temporaryDirectory();
    await expect(
      runRepositoryCommand({
        ...nodeCommand(
          directory,
          'require("node:fs").writeFileSync("pack",Buffer.alloc(8192));setInterval(()=>{},1000)',
        ),
        maxDirectoryBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: 'repository_too_large', status: 413 });
  });

  it('stderr内のURL/secretを公開せず、nonzeroと起動失敗を安全なエラーにする', async () => {
    const directory = await temporaryDirectory();
    await expect(
      runRepositoryCommand(
        nodeCommand(
          directory,
          'process.stderr.write("https://fixture:secret@example.test");process.exit(1)',
        ),
      ),
    ).rejects.toMatchObject({
      message: 'Repositoryの固定commitを読み込めません',
      code: 'repository_read_failed',
    });
    await expect(
      runRepositoryCommand({ ...nodeCommand(directory, ''), executable: '/nonexistent/git' }),
    ).rejects.toMatchObject({ code: 'repository_read_failed' });
  });
});

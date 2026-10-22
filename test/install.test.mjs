import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, rm, readFile, writeFile} from 'node:fs/promises';
import {join, resolve, dirname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(process.env.AGENT_WAKE_TEST_ROOT || 'work/tests');

test('Windows installation is repeatable, preserves config and refuses unrelated launchers',
  {skip:process.platform !== 'win32'}, async t => {
    await mkdir(root, {recursive:true});
    const scratch = await mkdtemp(join(root, 'wake-install-'));
    t.after(async () => {
      const target = resolve(scratch);
      if (!target.startsWith(root + sep) || !target.slice(root.length+1).startsWith('wake-install-')) throw new Error('Unsafe cleanup target');
      await rm(target, {recursive:true, force:true});
    });
    const codex = join(scratch, 'codex');
    const launchers = join(scratch, 'bin');
    const env = {...process.env, CODEX_HOME:codex, AGENT_WAKE_CONFIG:join(scratch, 'unused.json')};
    const install = () => spawnSync('pwsh', ['-NoProfile','-NonInteractive','-File',join(repo,'install.ps1'),'-LauncherDirectory',launchers], {env,encoding:'utf8',windowsHide:true});
    let result = install();
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout.trim());
    assert.equal(receipt.installed, join(codex, 'agent-wake'));
    assert.equal(JSON.parse(await readFile(join(receipt.installed, 'package.json'))).name, 'agent-wake');
    assert.match(await readFile(join(codex,'skills','agent-wake','agents','openai.yaml'),'utf8'), /Agent Wake/);
    const config = join(receipt.installed, 'shared-desktop.json');
    const original = JSON.stringify({port:45003});
    await writeFile(config, original);
    result = install();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(config,'utf8'), original);
    const help = spawnSync('pwsh', ['-NoProfile','-NonInteractive','-File',join(launchers,'agent-wake.ps1'),'help'], {env,encoding:'utf8',windowsHide:true});
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /agent-wake run/);
    const unrelated = join(launchers,'agent-wake.ps1');
    await writeFile(unrelated, '# unrelated launcher');
    result = install();
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(unrelated,'utf8'), '# unrelated launcher');
  });

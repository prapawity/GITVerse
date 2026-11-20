import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { runUpdate } from './runUpdate';

test('automatic updates download before installing; manual installers wait for the next click', async () => {
  const calls: string[] = [];
  const download = async () => {
    calls.push('download');
  };
  const install = async () => {
    calls.push('install');
  };
  await runUpdate(false, false, download, install);
  assert.deepEqual(calls.splice(0), ['download', 'install']);
  await runUpdate(false, true, download, install);
  assert.deepEqual(calls.splice(0), ['download']);
  await runUpdate(true, true, download, install);
  assert.deepEqual(calls, ['install']);
  await assert.rejects(
    runUpdate(
      false,
      false,
      async () => {
        throw new Error('download failed');
      },
      install,
    ),
  );
  assert.deepEqual(calls, ['install']);
});

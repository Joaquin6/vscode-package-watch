import { resolve, join } from 'path';
import * as assert from 'assert';
import { getDependenciesFromYarnLock } from '../extension';

suite('Package Watch Tests', () => {
  let projectRoot;

  setup(() => {
    projectRoot = resolve(__dirname, '../..');
  });

  suite('getDependenciesFromYarnLock', () => {
    test('should return "null" if yarn.lock file is non-existent', () =>
      assert.equal(getDependenciesFromYarnLock(process.cwd(), [['test-dep', '1.2']]), null));
    test('should return "null" if path is not part of the yarn workspace', () =>
      assert.equal(getDependenciesFromYarnLock(join(projectRoot, '..'), [['dep', '1']]), null));
  });
});
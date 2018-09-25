import { resolve, join } from 'path';
import * as assert from 'assert';
import {
  checkYarnWorkspace,
  getDependenciesFromPackageLock,
  getDependenciesFromYarnLock,
  readFile,
} from '../extension';

suite('Package Watch Tests', () => {
  let projectRoot;

  setup(() => {
    projectRoot = resolve(__dirname, '../..');
  });

  suite('getDependenciesFromPackageLock', () => {
    test('should return "null" if package-lock.json file is non-existent', () =>
      assert.equal(getDependenciesFromPackageLock(process.cwd(), [['test-dep', '1.2']]), null));
  });

  suite('getDependenciesFromYarnLock', () => {
    test('should return "null" if yarn.lock file is non-existent', () =>
      assert.equal(getDependenciesFromYarnLock(process.cwd(), [['test-dep', '1.2']]), null));
    test('should return "null" if path is not part of the yarn workspace', () =>
      assert.equal(getDependenciesFromYarnLock(join(projectRoot, '..'), [['dep', '1']]), null));
  });

  suite('checkYarnWorkspace', () => {
    test('should return falsy if package.json path is not provided', () =>
      assert.equal(checkYarnWorkspace(undefined, projectRoot), false));
    test('should return falsy if yarn.lock path is not provided', () =>
      assert.equal(checkYarnWorkspace(projectRoot, undefined), false));
  });

  suite('readFile', () => {
    test('should return "null" if lock file is non-existent', () => {
      assert.equal(readFile(join(projectRoot, 'package-lock.json')), null);
      assert.equal(readFile(join(projectRoot, 'src/test/yarn.lock')), null);
    });
  });
});

import * as semver from 'semver';

export function isScoped(name: string): boolean {
  return name.startsWith('@');
}

export function version(raw: string): string {
  return raw.replace(/[~^<>=]/g, '');
}

export const isValidVersion = (src: string) => semver.valid(version(src));
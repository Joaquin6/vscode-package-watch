import { spawn, spawnSync } from 'child_process';
import { basename, dirname, extname, join, sep } from 'path';

import { sync } from 'glob';
import { parse as yarnParse } from '@yarnpkg/lockfile';
import { satisfies, valid, validRange } from 'semver';
import { existsSync, readFileSync, removeSync } from 'fs-extra';
import { chain, compact, debounce, difference, get, has, includes, isEmpty, isEqual, find, findLast, fromPairs, mapValues, some, toPairs, uniq } from 'lodash';
import { window, workspace, commands, CancellationToken, CancellationTokenSource, ExtensionContext, FileSystemWatcher, OutputChannel, ProgressLocation } from 'vscode';

import { defaultConfiguration, getConfiguration } from './helpers/config';
import * as logger from './helpers/logger';

logger.logInfo('Extension module is loaded');

type Report = {
    packageJsonPath: string,
    problems: Array<{
        toString: () => string,
        moduleCheckingNeeded?: boolean,
        modulePathForCleaningUp?: string,
    }>
};

const queue: Array<string> = [];
const lastCheckedDependencies = new Map();
const cmdCheck: string = 'joaquinsPackageWatch.checkDependencies';
const cmdInstall: string = 'joaquinsPackageWatch.installDependencies';
const watchingFiles: string = '**/{package.json,package-lock.json,yarn.lock}';

class CheckingOperation extends CancellationTokenSource {}
class InstallationOperation extends CancellationTokenSource {}

let outputChannel: OutputChannel;
let fileWatcher: FileSystemWatcher;
let pendingOperation: CancellationTokenSource;
let configuration = defaultConfiguration();

const getPackageJsonPathList = async ({ include, exclude }) =>
    (await workspace.findFiles(include, exclude))
    .map(({ fsPath }) => fsPath);

function getHashDifference(oldHash, newHash) {
    const diffs = [];

    for (const key in oldHash) {
        if (oldHash.hasOwnProperty(key)
            && newHash.hasOwnProperty(key)
            && oldHash[key] === newHash[key]) {
                continue;
        }

        if (oldHash.hasOwnProperty(key) && !newHash.hasOwnProperty(key)) {
            diffs.push([key, oldHash[key]]);
            continue;
        }

        if (oldHash.hasOwnProperty(key)
            && newHash.hasOwnProperty(key)
            && oldHash[key] !== newHash[key]) {
                diffs.push([key, newHash[key]]);
        }
    }

    for (const key in newHash) {
        if (newHash.hasOwnProperty(key)
            && oldHash.hasOwnProperty(key)
            && newHash[key] === oldHash[key]) {
                continue;
        }

        if (newHash.hasOwnProperty(key) && !oldHash.hasOwnProperty(key)) {
            diffs.push([key, newHash[key]]);
        }
    }

    return diffs;
}

const createReports = (
    packageJsonPathList: Array<string>,
    skipUnchanged: boolean,
    token: CancellationToken,
): Array<Report> => packageJsonPathList
    .filter(packageJsonPath => basename(packageJsonPath) === 'package.json')
    .map(packageJsonPath => {
        if (token.isCancellationRequested) { return; }

        const expectedDependencies = chain(readFile(packageJsonPath) as object)
            .pick(['dependencies', 'devDependencies', 'peerDependencies'])
            .values()
            .map(item => toPairs<string>(item))
            .flatten()
            .value();

        // Skip this file as there is no dependencies written in the file
        if (isEmpty(expectedDependencies)) {
            logger.logInfo('Creating Reports - No expected packages found.');
            return;
        }

        const packageJsonHash = fromPairs(expectedDependencies);
        const lastPackageJsonHash = lastCheckedDependencies.has(packageJsonPath)
            ? lastCheckedDependencies.get(packageJsonPath)
            : false;
        const equalHashes = lastPackageJsonHash
            ? isEqual(lastPackageJsonHash, packageJsonHash)
            : false;

        if (skipUnchanged && equalHashes) {
            logger.logInfo('Creating Reports - The package json hash did not change.');
            return;
        }

        let packageJsonHashDiff;
        if (lastPackageJsonHash && !equalHashes) {
            const hashDiff = getHashDifference(lastPackageJsonHash, packageJsonHash);

            if (!isEmpty(hashDiff)) {
                logger.logInfo(`Hash Difference => ${JSON.stringify(hashDiff, null, 2)}`);

                packageJsonHashDiff = hashDiff.map(pkghash => {
                    const depName: string = pkghash[0];
                    const msgStart = `Dependency "${depName}"`;

                    let action: string;
                    let msgBody: string;

                    if (has(lastPackageJsonHash, depName) && has(packageJsonHash, depName)) {
                        const newVersion = packageJsonHash[depName];
                        const oldVersion = lastPackageJsonHash[depName];
                        action = 'version change';
                        msgBody = `version was changed from "${oldVersion}" to "${newVersion}"`;
                    } else if (!has(lastPackageJsonHash, depName) && has(packageJsonHash, depName)) {
                        action = 'added';
                        msgBody = `is being added`;
                    } else if (has(lastPackageJsonHash, depName) && !has(packageJsonHash, depName)) {
                        action = 'removed';
                        msgBody = `is being removed`;
                    }

                    const message = `${msgStart} ${msgBody}.`;

                    logger.logInfo(message);

                    return {
                        action,
                        message,
                        name: depName,
                    };
                });
            }

        }

        lastCheckedDependencies.set(packageJsonPath, packageJsonHash);

        const dependencies = (
            getDependenciesFromYarnLock(packageJsonPath, expectedDependencies) ||
            getDependenciesFromPackageLock(packageJsonPath, expectedDependencies)
        );

        let msg = 'The lock file was missing.';

        if (!dependencies) {
            return {
                packageJsonPath,
                problems: [{ toString: () => msg }]
            };
        }

        const report = {
            packageJsonPath,
            problems: compact(dependencies.map(({
                name,
                lockedVersion,
                actualVersion,
                expectedVersion,
                path: modulePathForCleaningUp,
            }) => {
                if (!lockedVersion) {
                    msg = `"${name}" was not found in the lock file.`;

                    if (!actualVersion) {
                        msg = `"${name}" was not installed.`;
                    }

                    return { toString: () => msg };
                }

                const foundInHashDiff = !isEmpty(packageJsonHashDiff)
                    ? find(packageJsonHashDiff, dep => dep.name === name)
                    : undefined;

                if (foundInHashDiff && foundInHashDiff.action === 'removed') {
                    msg = `"${name}@${lockedVersion}" was found in the lock file`;
                    msg += ` but it needs to be removed.`;
                    return { toString: () => msg };
                }

                if (
                    validRange(expectedVersion) &&
                    valid(lockedVersion) &&
                    satisfies(lockedVersion, expectedVersion) === false
                ) {
                    msg = `"${name}" was expected to be ${expectedVersion}`;
                    msg += ` but got ${lockedVersion} in the lock file.`;
                    return { toString: () => msg };
                }

                if (!actualVersion) {
                    msg = `"${name}" was not found in /node_module/ directory.`;
                    return { toString: () => msg, moduleCheckingNeeded: true };
                }

                if (lockedVersion !== actualVersion) {
                    msg = `"${name}" was expected to be ${lockedVersion}`;
                    msg += ` but got ${actualVersion} in /node_module/ directory.`;
                    return {
                        toString: () => msg,
                        modulePathForCleaningUp,
                        moduleCheckingNeeded: true,
                    };
                }
            }))
        };

        return report;
    })
    .filter(report => report && report.problems.length > 0);

async function installDependencies(reports: Array<Report> = [], secondTry = false) {
    if (pendingOperation instanceof InstallationOperation) {
        logger.logInfo('Installation Operation already in progress');
        return;
    }
    if (pendingOperation instanceof CheckingOperation) {
        pendingOperation.cancel();
    }

    logger.logInfo('Installing Dependencies');

    pendingOperation = new InstallationOperation();

    const { token } = pendingOperation;

    outputChannel.clear();

    if (token.isCancellationRequested) { return; }
    if (workspace.workspaceFolders === undefined) {
        window.showErrorMessage('No workspaces opened.', { modal: true });
        pendingOperation = null;
        return;
    }

    if (!configuration) {
        configuration = await getConfiguration();
    }

    const packageJsonPathList = reports.length === 0
        ? await getPackageJsonPathList(configuration)
        : reports.map(({ packageJsonPath }) => packageJsonPath);

    if (token.isCancellationRequested) { return; }
    if (packageJsonPathList.length === 0) {
        window.showErrorMessage('No "package.json" found.', { modal: true });
        pendingOperation = null;
        return;
    }

    const success = await window.withProgress({
        location: ProgressLocation.Notification,
        title: 'Installing node dependencies...',
        cancellable: true,
    }, async (progress, progressToken) => {
        progressToken.onCancellationRequested(() => {
            if (token === pendingOperation.token) {
                pendingOperation.cancel();
                pendingOperation = null;
            }
        });

        const problems = chain(reports).map(({ problems }) => problems).flatten().value();
        // Remove the problematic modules from /node_module/ so `--check-files` will work
        for (const problem of problems) {
            if (
                problem.modulePathForCleaningUp &&
                existsSync(problem.modulePathForCleaningUp) &&
                basename(dirname(problem.modulePathForCleaningUp)) === 'node_modules'
            ) {
                try {
                    removeSync(problem.modulePathForCleaningUp);
                } catch (error) {}
            }
        }

        const moduleCheckingNeeded = some(problems, ({ moduleCheckingNeeded: m }) => m);

        const commands = chain(packageJsonPathList)
            .map(packageJsonPath => {
                if (token.isCancellationRequested) { return; }

                const yarnLockPath = findFileInParentDirectory(dirname(packageJsonPath), 'yarn.lock');
                const isRunningchildYarnProcess = spawnSync('which', ['yarn']).status === 0
                    && existsSync(join(dirname(packageJsonPath), 'package-lock.json')) === false;

                if (
                    existsSync(join(dirname(packageJsonPath), 'yarn.lock')) ||
                    checkYarnWorkspace(packageJsonPath, yarnLockPath) ||
                    isRunningchildYarnProcess
                ) {
                    return {
                        packageJsonPath,
                        command: 'yarn install',
                        directory: dirname(yarnLockPath || packageJsonPath),
                        parameters: [
                            (moduleCheckingNeeded || secondTry) && '--check-files',
                            secondTry && '--force',
                        ],
                    };
                }

                return {
                    packageJsonPath,
                    command: 'npm install',
                    directory: dirname(packageJsonPath),
                    parameters: [secondTry && '--force'],
                };
            })
            .compact().map(item => ({ ...item, parameters: compact(item.parameters) }))
            .uniqBy(({ directory }) => directory)
            .sortBy(({ directory }) => directory.length)
            .value();

        const progressWidth = 100 / commands.length;

        for (const { command, parameters, directory, packageJsonPath } of commands) {
            if (token.isCancellationRequested) { return; }

            outputChannel.appendLine('');
            outputChannel.appendLine(packageJsonPath.replace(/\\/g, '/'));

            let nowStep = 0;
            let maxStep = 1;

            const exitCode = await new Promise<number>(resolve => {
                const worker = spawn(command, parameters, {
                    cwd: directory,
                    shell: true,
                });

                worker.stdout.on('data', text => {
                    outputChannel.append(`  ${text}`);

                    if (command === 'yarn install') {
                        const steps = text.toString().match(/^\[(\d)\/(\d)\]\s/);

                        if (steps) {
                            maxStep = +steps[2];
                            progress.report({ increment: Math.floor((+steps[1] - nowStep) / maxStep * progressWidth) });
                            nowStep = +steps[1];
                        }
                    }
                });

                worker.stderr.on('data', text => { outputChannel.append(`  ${text}`); });

                worker.on('exit', code => {
                    progress.report({
                        increment: Math.floor((maxStep - nowStep) / maxStep * progressWidth),
                    });
                    resolve(code);
                });

                token.onCancellationRequested(() => { worker.kill(); });
            });

            if (token.isCancellationRequested) { return; }
            if (exitCode !== 0) {
                const errMsg = `There was an error running "${command}".`;
                const showErrs = { title: 'Show Errors', action: () => { outputChannel.show(); } };

                return window.showErrorMessage(errMsg, showErrs)
                    .then(selectOption => selectOption && selectOption.action());
            }
        }

        return true;
    });

    if (token === pendingOperation.token) { pendingOperation = null; }
    if (token.isCancellationRequested || !success || secondTry) { return; }

    const reviews = await createReports(packageJsonPathList, false, token);

    printReports(reviews, token);

    if (reviews.length > 0) {
        const outdatedMsg = 'There were still some problems regarding the node dependencies.';
        const reInstallDeps = {
            title: 'Reinstall Dependencies',
            action: () => { installDependencies(reviews, true); },
        };
        const showProblems = {
            title: 'Show Problems',
            action: () => { outputChannel.show(); },
        };

        logger.logError(outdatedMsg);

        return window.showWarningMessage(outdatedMsg, reInstallDeps, showProblems)
            .then(selectOption => selectOption && selectOption.action());
    }

    const successMsg: string = 'Successfully installed node dependencies.';
    logger.logInfo(successMsg);
    return window.showInformationMessage(successMsg);
}

async function checkDependencies(
    packageJsonPathList: Array<string>,
    skipUnchanged: boolean,
    token: CancellationToken,
) {
    logger.logInfo('Checking Dependencies');

    const reports = createReports(packageJsonPathList, skipUnchanged, token);

    if (token.isCancellationRequested) {
        logger.logInfo('Cancelling Dependency Check - Token Cancellation was Requested');
        return;
    }
    if (isEmpty(reports)) {
        logger.logInfo('Dependency Check - No Problems Reported');
        return true;
    }

    printReports(reports, token);

    if (token.isCancellationRequested) {
        logger.logInfo('Cancelling Dependency Check - Token Cancellation was Requested');
        return;
    }

    if (!configuration) {
        configuration = await getConfiguration();
    }

    /** Only prompt if option is set to true */
    if (configuration.promptForUpdate) {
        const outdatedMsg = 'Detected outdated node dependencies.';
        const installDeps = {
            title: 'Install Dependencies',
            action: () => { installDependencies(reports); },
        };
        const showProblems = {
            title: 'Show Problems',
            action: () => { outputChannel.show(); },
        };

        logger.logInfo(`Dependency Update Prompt - ${outdatedMsg}`);

        return window.showWarningMessage(outdatedMsg, installDeps, showProblems)
            .then(selectOption => {
                if (selectOption) {
                    logger.logInfo(`Dependency Update Prompt - Selected ${selectOption.title}`);
                    selectOption.action();
                } else {
                    logger.logInfo('Dependency Update Prompt - No Option was Selected');
                }
            });
    }

    /** Otherwise just run the dependency installation script */
    return installDependencies(reports);
}

function printReports(reports: Array<Report>, token: CancellationToken) {
    for (const { packageJsonPath, problems } of reports) {
        if (token.isCancellationRequested) { return; }

        outputChannel.appendLine('');
        outputChannel.appendLine(packageJsonPath);

        for (const problem of problems) {
            if (token.isCancellationRequested) { return; }
            outputChannel.appendLine(`  ${problem}`);
        }
    }
}

function findFileInParentDirectory(path: string, name: string, stop?: string) {
    const pathList = path.split(sep);

    while (pathList.length > 1) {
        const workPath = [...pathList, name].join(sep);
        if (stop && workPath.startsWith(stop) === false) { break; }
        if (existsSync(workPath)) { return workPath; }
        pathList.pop();
    }
}

export function getDependenciesFromPackageLock(
    packageJsonPath: string,
    expectedDependencies: Array<[string, string]>,
) {
    const packageLockPath = join(dirname(packageJsonPath), 'package-lock.json');

    if (!existsSync(packageLockPath)) { return null; }

    const nameObjectHash = get(readFile(packageLockPath), 'dependencies', {}) as {
        [key: string]: { version: string },
    };
    const nameVersionHash = mapValues(nameObjectHash, ({ version }) => version);

    return expectedDependencies.map(([name, expectedVersion]) => {
        const modulePath = join(dirname(packageJsonPath), 'node_modules', name, 'package.json');
        const actualVersion = get(readFile(modulePath), 'version') as string;

        return {
            name,
            actualVersion,
            expectedVersion,
            path: dirname(modulePath),
            lockedVersion: nameVersionHash[name],
        };
    });
}

export function getDependenciesFromYarnLock(
    packageJsonPath: string,
    expectedDependencies: Array<[string, string]>,
) {
    const yarnLockPath = findFileInParentDirectory(dirname(packageJsonPath), 'yarn.lock');
    if (!yarnLockPath) { return null; }
    /** Stop processing if the current directory is not part of the Yarn Workspace */
    if (
        dirname(yarnLockPath) !== dirname(packageJsonPath) &&
        !checkYarnWorkspace(packageJsonPath, yarnLockPath)
    ) { return null; }

    const nameObjectHash = get(readFile(yarnLockPath), 'object', {}) as {
        [key: string]: { version: string },
    };
    const nameVersionHash = mapValues(nameObjectHash, ({ version }) => version);

    return expectedDependencies.map(([name, expectedVersion]) => {
        const modulePath = findFileInParentDirectory(
            dirname(packageJsonPath),
            join('node_modules', name, 'package.json'),
            dirname(yarnLockPath),
        );

        return {
            name,
            expectedVersion,
            path: modulePath ? dirname(modulePath) : undefined,
            actualVersion: get(readFile(modulePath), 'version') as string,
            lockedVersion: (nameVersionHash[`${name}@${expectedVersion}`] ||
                findLast(nameVersionHash, (version, atVersion) =>
                    atVersion.startsWith(`${name}@${version}`))),
        };
    });
}

export function checkYarnWorkspace(packageJsonPath: string, yarnLockPath: string) {
    if (!packageJsonPath || !yarnLockPath) { return false; }

    // See https://yarnpkg.com/lang/en/docs/workspaces/
    const packageJsonForYarnWorkspace = readFile(join(dirname(yarnLockPath), 'package.json')) as {
        private?: boolean,
        workspaces?: Array<string>,
    };

    if (
        !packageJsonForYarnWorkspace ||
        packageJsonForYarnWorkspace.private !== true ||
        !packageJsonForYarnWorkspace.workspaces
    ) { return false; }

    const yarnWorkspacePathList = chain(packageJsonForYarnWorkspace.workspaces)
        .map(pathOrGlob => sync(pathOrGlob, { cwd: dirname(yarnLockPath), absolute: true }))
        .flatten()
        .map(path => path.replace(/\//g, sep))
        .value();

    if (includes(yarnWorkspacePathList, dirname(packageJsonPath))) { return true; }

    return false;
}

export function readFile(filePath: string): object | string {
    let test;
    try {
        test = readFileSync(filePath, 'utf-8');
        if (extname(filePath) === '.json') { test = JSON.parse(test); }
        if (basename(filePath) === 'yarn.lock') { test = yarnParse(test); }
    } catch (error) {
        test = null;
    }
    return test;
}

export async function activate(context: ExtensionContext) {
    outputChannel = window.createOutputChannel('Joaquin\'s Package Watcher');
    logger.logInfo('Activating Joaquins Package Watch');

    configuration = await getConfiguration();

    const defer = debounce(async () => {
        logger.logInfo('Running Defer');

        if (pendingOperation) {
            logger.logInfo('Defer Return - Operation Pending');
            return;
        }

        pendingOperation = new CheckingOperation();
        const { token } = pendingOperation;

        if (isEmpty(queue)) {
            logger.logInfo('Defer Return - Nothing in the queue');
            return;
        }

        const packageJsonPathList = uniq(queue);
        queue.splice(0, queue.length);


        if (isEmpty(packageJsonPathList)) {
            logger.logInfo('Defer Return - Nothing in the package json path list');
            return;
        }

        logger.logInfo(`Defer - Check Dependencies in paths => ${JSON.stringify(packageJsonPathList, null, 2)}`);
        logger.logInfo(`Defer - Check Dependencies with token => ${token}`);

        await checkDependencies(packageJsonPathList, true, token);

        if (token === pendingOperation.token) { pendingOperation = null; }
        if (!isEmpty(queue)) { defer(); }
    }, 300);

    const batch = async (path: string | Array<string>) => {
        logger.logInfo(`Running Batch on Path<${typeof path}> - ${typeof path === 'string' ? path : JSON.stringify(path, null, 2)}`);
        if (pendingOperation instanceof InstallationOperation) {
            logger.logInfo('Batch Return - "pendingOperation" is an instance of "InstallationOperation"');
            return;
        }
        if (typeof path === 'string') {
            if (!configuration) {
                configuration = await getConfiguration(path);
            }
            if (!includes(queue, path)) {
                queue.push(path);
            }
        } else {
            queue.push(...path);
        }
        defer();
    };

    fileWatcher = workspace.createFileSystemWatcher(watchingFiles, false, false, true);

    context.subscriptions.push(fileWatcher.onDidCreate(async ({ fsPath }) => {
        logger.logInfo(`fileWatcher.onDidCreate - Checking Dependencies in ${fsPath}`);
        if (basename(fsPath) === 'package.json') { batch(fsPath); }
    }));

    context.subscriptions.push(fileWatcher.onDidChange(async ({ fsPath }) => {
        logger.logInfo(`fileWatcher.onDidChange - Checking Dependencies in ${fsPath}`);
        if (basename(fsPath) === 'package.json') {
            return batch(fsPath);
        }
        if (basename(fsPath) === 'package-lock.json') {
            return batch(join(dirname(fsPath), 'package.json'));
        }
        batch(await getPackageJsonPathList(configuration));
    }));

    context.subscriptions.push(commands.registerCommand(cmdCheck, async () => {
        if (pendingOperation) { pendingOperation.cancel(); }

        pendingOperation = new CheckingOperation();
        const { token } = pendingOperation;
        outputChannel.clear();
        const success = await checkDependencies(await getPackageJsonPathList(configuration), false, token);

        if (success) { window.showInformationMessage('The node dependencies are in-sync.'); }
        if (token === pendingOperation.token) { pendingOperation = null; }
    }));

    context.subscriptions.push(commands.registerCommand(cmdInstall, installDependencies));

    batch(await getPackageJsonPathList(configuration));

    logger.logInfo('Successfully Activated Joaquins Package Watch');
}

export function deactivate() {
    logger.logInfo('Deactivating Joaquins Package Watch');
    if (pendingOperation) { pendingOperation.cancel(); }
    if (fileWatcher) { fileWatcher.dispose(); }
    if (outputChannel) { outputChannel.dispose(); }
    logger.logInfo('Successfully Deactivated Joaquins Package Watch');
}
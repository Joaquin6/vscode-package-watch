import { join } from 'path';
import { existsSync, readFile } from 'fs';
import { workspace } from 'vscode';

import * as logger from './logger';

let configuration: null | object = null;

const CONFIG_FILE_NAME: string = '.joaquinsPackageWatch.config.json';
const defaultConfiguration: object = {
    enable: true,
    maximumNumberOfNotification: 10,
};

const logConfigObject = () =>
    logger.logInfo(`Configuration Object - ${JSON.stringify(configuration, null, 2)}`);

export function getConfiguration(folderPath: string) {
    if (configuration) {
        logConfigObject();
        return Promise.resolve(configuration);
    }

    return new Promise((resolve) => {
        const configFilePath: string = join(folderPath, CONFIG_FILE_NAME);

        if (existsSync(configFilePath)) {
			logger.logInfo(`Configuration file is found at '${configFilePath}'`);

            return readFile(configFilePath, { encoding: 'utf8' }, (err, data) => {
                if (err) {
                    logger.logError(`Error reading configuration file at '${configFilePath}': ${err}`);
                    resolve(defaultConfiguration);
                } else {
                    try {
                        configuration = Object.assign({}, defaultConfiguration, JSON.parse(data));
                        logConfigObject();
                        resolve(configuration);
                    } catch (error) {
						logger.logError(`Error converting configuration file at '${configFilePath}' to JSON`);
						logger.logError(error);
                        resolve(defaultConfiguration);
                    }
                }
			});
		}

        logger.logInfo(`Configuration file is not found at '${configFilePath}'`);
        configuration = Object.assign({}, defaultConfiguration, workspace.getConfiguration('joaquinsPackageWatch'));
        logConfigObject();
		resolve(configuration);
    });
}
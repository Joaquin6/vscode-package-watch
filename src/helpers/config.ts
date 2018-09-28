import { join } from 'path';
import { existsSync, readFile } from 'fs';
import { workspace } from 'vscode';

import * as logger from './logger';

type Config = {
    enable: boolean,
    configFileName: string,
    promptForUpdate: boolean,
    maximumNumberOfNotification: number,
};

let configuration: Config;

const DEFAULT_CONFIG_FILE_NAME: string = '.jpwrc';

function logConfigObject(c: Config = configuration) {
    logger.logInfo(`Config Object - ${JSON.stringify(c, null, 2)}`);
}

export const defaultConfiguration = (): Config => ({
    enable: true,
    promptForUpdate: false,
    maximumNumberOfNotification: 10,
    configFileName: DEFAULT_CONFIG_FILE_NAME,
});

export function getConfiguration(folderPath?: string): Promise<Config> {
    if (configuration) {
        logConfigObject();
        return Promise.resolve(configuration);
    }

    return new Promise((resolve) => {
        if (folderPath) {
            const configFilePath: string = join(folderPath, DEFAULT_CONFIG_FILE_NAME);

            if (existsSync(configFilePath)) {
                logger.logInfo(`Configuration file is found at '${configFilePath}'`);

                return readFile(configFilePath, { encoding: 'utf8' }, (err, data) => {
                    if (err) {
                        logger.logError(`Error reading configuration file at '${configFilePath}': ${err}`);
                        resolve(defaultConfiguration());
                    } else {
                        try {
                            configuration = Object.assign(
                                defaultConfiguration(),
                                JSON.parse(data),
                            );
                            logConfigObject();
                            resolve(configuration);
                        } catch (error) {
                            logger.logError(`Error converting config file at '${configFilePath}' to JSON`);
                            logger.logError(error);
                            resolve(defaultConfiguration());
                        }
                    }
                });
            }

            logger.logInfo(`Configuration file is not found at '${configFilePath}'`);
        }

        configuration = Object.assign(
            defaultConfiguration(),
            workspace.getConfiguration('joaquinsPackageWatch'),
        );

        logConfigObject();
		resolve(configuration);
    });
}
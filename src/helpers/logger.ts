const logger = console;
const MESSAGE_PREFIX = 'joaquins-package-watch:';

const generateLogOutput = (data: string | object): string => typeof data === 'string'
    ? `${MESSAGE_PREFIX} ${data}`
    : `${MESSAGE_PREFIX} - ${JSON.stringify(data, null, 2)}`;

export function logError(data: string | object) {
    logger.error(generateLogOutput(data));
}

export function logInfo(data: string | object) {
    logger.info(generateLogOutput(data));
}
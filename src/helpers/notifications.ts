import { window, workspace } from 'vscode';

let numberOfDisplayedNotifications: number = 0;

export function resetNumberOfDisplayedNotifications() {
    numberOfDisplayedNotifications = 0;
}

export function maximumNumberOfNotificationIsNotExceeded(
	numberOfDisplayedNotifications,
	maximumNumberOfNotification,
) {
    if (maximumNumberOfNotification < 0) { return true; }
    return numberOfDisplayedNotifications < maximumNumberOfNotification;
}

export function displayNotification(currentFolder, packagesToUpdate) {
    if (packagesToUpdate.length === 0) { return; }

    const maximumNumberOfNotification = workspace.getConfiguration('joaquinsPackageWatch')['maximumNumberOfNotification'];
    if (maximumNumberOfNotificationIsNotExceeded(numberOfDisplayedNotifications, maximumNumberOfNotification)) {
        numberOfDisplayedNotifications++;
        if (packagesToUpdate.length === 1) {
            window.showInformationMessage(`There is a newer version of the '${packagesToUpdate[0]}' package in the '${currentFolder}' folder. Execute 'npm update'.`);
        } else {
            window.showInformationMessage(`There are newer versions of packages in the '${currentFolder}' folder. Execute 'npm update'.`);
        }
    }
}
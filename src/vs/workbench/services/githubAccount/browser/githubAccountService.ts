/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IUserDataProfile, IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IUserDataProfileManagementService, IUserDataProfileService } from '../../userDataProfile/common/userDataProfile.js';
import { IGitHubAccount, IGitHubAccountService, IGitHubSession } from '../common/githubAccount.js';

/** Commands of the isomorphic-git extension, which owns the OAuth flow. */
const SIGN_IN_COMMAND = 'isomorphic-git.githubSignIn';
const SIGN_OUT_COMMAND = 'isomorphic-git.githubSignOut';

/** Maps GitHub account ids to profile ids. Holds no credentials. */
const ACCOUNT_PROFILES_KEY = 'vsprocessing.githubAccountProfiles';

/** Where the virtual file system extension keeps its folders, relative to a profile's global storage. */
const VIRTUAL_FOLDERS_PATH = ['vsprocessing.vscode-virtualfs', 'folders'];

/** Virtual folders from before they belonged to an account. */
const LEGACY_VIRTUAL_FOLDERS = URI.from({ scheme: Schemas.vscodeUserData, path: '/vfs' });

export class GitHubAccountService extends Disposable implements IGitHubAccountService {

	declare readonly _serviceBrand: undefined;

	private session: IGitHubSession | undefined;

	private readonly _onDidChangeAccount = this._register(new Emitter<IGitHubAccount | undefined>());
	readonly onDidChangeAccount = this._onDidChangeAccount.event;

	private readonly profileSwitches = new Sequencer();

	constructor(
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService,
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@IUserDataProfileManagementService private readonly userDataProfileManagementService: IUserDataProfileManagementService,
		@IStorageService private readonly storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IDialogService private readonly dialogService: IDialogService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	get account(): IGitHubAccount | undefined {
		return this.session ? { id: this.session.account.id, label: this.session.account.label, avatarUrl: this.session.avatarUrl } : undefined;
	}

	getSession(): IGitHubSession | undefined {
		return this.session;
	}

	setSession(session: IGitHubSession): void {
		const previous = this.session;
		this.session = session;
		if (previous?.account.id !== session.account.id || previous.account.label !== session.account.label) {
			this._onDidChangeAccount.fire(this.account);
		}

		// Switch after the call returns: switching restarts the extension that is signing in
		setTimeout(() => this.profileSwitches.queue(() => this.enterAccountProfile(session)));
	}

	clearSession(): void {
		if (!this.session) {
			return;
		}
		this.session = undefined;
		this._onDidChangeAccount.fire(undefined);
		setTimeout(() => this.profileSwitches.queue(() => this.switchTo(this.userDataProfilesService.defaultProfile)));
	}

	async signIn(): Promise<void> {
		await this.commandService.executeCommand(SIGN_IN_COMMAND);
	}

	async signOut(): Promise<void> {
		try {
			await this.commandService.executeCommand(SIGN_OUT_COMMAND);
		} finally {
			this.clearSession();
		}
	}

	private async enterAccountProfile(session: IGitHubSession): Promise<void> {
		if (this.session?.account.id !== session.account.id) {
			return; // signed out or into another account in the meantime
		}
		try {
			const profile = await this.getProfile(session.account);
			if (this.userDataProfileService.currentProfile.isDefault) {
				await this.offerToMoveVirtualFolders(profile, session.account.label);
			}
			await this.switchTo(profile);
		} catch (error) {
			this.logService.error('[github account] Could not switch to the account profile', error);
		}
	}

	private async switchTo(profile: IUserDataProfile): Promise<void> {
		if (this.userDataProfileService.currentProfile.id !== profile.id) {
			await this.userDataProfileManagementService.switchProfile(profile);
		}
	}

	/** Finds the profile of an account, creating it the first time the account signs in. */
	private async getProfile(account: { id: string; label: string }): Promise<IUserDataProfile> {
		const profileIds = this.getAccountProfiles();
		const existing = this.userDataProfilesService.profiles.find(profile => profile.id === profileIds[account.id]);
		if (existing) {
			if (existing.name !== account.label && !this.userDataProfilesService.profiles.some(profile => profile.name === account.label)) {
				return this.userDataProfilesService.updateProfile(existing, { name: account.label }); // the account was renamed
			}
			return existing;
		}

		const taken = this.userDataProfilesService.profiles.some(profile => profile.name === account.label);
		const profile = await this.userDataProfilesService.createNamedProfile(taken ? `${account.label} (${account.id})` : account.label);
		this.storageService.store(ACCOUNT_PROFILES_KEY, JSON.stringify({ ...profileIds, [account.id]: profile.id }), StorageScope.APPLICATION, StorageTarget.MACHINE);
		return profile;
	}

	private getAccountProfiles(): Record<string, string> {
		try {
			return JSON.parse(this.storageService.get(ACCOUNT_PROFILES_KEY, StorageScope.APPLICATION, '{}'));
		} catch {
			return {};
		}
	}

	/** Offers to move virtual folders that belong to no account into the account signing in. */
	private async offerToMoveVirtualFolders(profile: IUserDataProfile, accountLabel: string): Promise<void> {
		const sources = [joinPath(this.userDataProfilesService.defaultProfile.globalStorageHome, ...VIRTUAL_FOLDERS_PATH), LEGACY_VIRTUAL_FOLDERS];
		const folders: URI[] = [];
		for (const source of sources) {
			const stat = await this.fileService.resolve(source).catch(() => undefined);
			for (const child of stat?.children ?? []) {
				if (child.isDirectory) {
					folders.push(child.resource);
				}
			}
		}
		if (!folders.length) {
			return;
		}

		const names = folders.map(folder => folder.path.substring(folder.path.lastIndexOf('/') + 1));
		const { confirmed } = await this.dialogService.confirm({
			message: localize('moveVirtualFolders', "Move your virtual folders to {0}?", accountLabel),
			detail: localize('moveVirtualFoldersDetail', "These virtual folders are not linked to an account yet: {0}. Moving them makes them part of {1}'s virtual folders. Otherwise, folders created as a guest are gone when the page closes.", names.join(', '), accountLabel),
			primaryButton: localize({ key: 'moveVirtualFoldersButton', comment: ['&& denotes a mnemonic'] }, "&&Move"),
			cancelButton: localize('keepVirtualFolders', "Don't Move"),
		});
		if (!confirmed) {
			return;
		}

		const target = joinPath(profile.globalStorageHome, ...VIRTUAL_FOLDERS_PATH);
		await this.fileService.createFolder(target).catch(() => undefined);
		for (let i = 0; i < folders.length; i++) {
			let destination = joinPath(target, names[i]);
			for (let n = 1; await this.fileService.exists(destination); n++) {
				destination = joinPath(target, `${names[i]}-${n}`);
			}
			try {
				await this.fileService.move(folders[i], destination);
			} catch (error) {
				this.logService.error(`[github account] Could not move ${folders[i].toString()}`, error);
			}
		}
	}
}

registerSingleton(IGitHubAccountService, GitHubAccountService, InstantiationType.Delayed);

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { commands, Disposable, EventEmitter, ExtensionContext, FileChangeEvent, FileChangeType, FileStat, FileSystemError, FileSystemProvider, FileType, l10n, QuickInputButton, QuickPickItem, ThemeIcon, Uri, window, workspace } from 'vscode';

const SCHEME = 'vfs';

/**
 * `vfs:` file system for folders that live in the browser. Content is persisted in the user data
 * file system under a hidden `/vfs` folder; `vfs:/project` is stored at `vscode-userdata:/vfs/project`.
 */
class VirtualFileSystemProvider implements FileSystemProvider, Disposable {

	private readonly onDidChangeFileEmitter = new EventEmitter<FileChangeEvent[]>();
	readonly onDidChangeFile = this.onDidChangeFileEmitter.event;

	constructor(private readonly storageRoot: Uri) { }

	dispose(): void {
		this.onDidChangeFileEmitter.dispose();
	}

	private toStorage(uri: Uri): Uri {
		return Uri.joinPath(this.storageRoot, uri.path);
	}

	private fire(type: FileChangeType, uri: Uri): void {
		this.onDidChangeFileEmitter.fire([{ type, uri }]);
	}

	watch(): Disposable {
		// All changes go through this provider, which fires events for them.
		return new Disposable(() => { });
	}

	stat(uri: Uri): Thenable<FileStat> {
		return workspace.fs.stat(this.toStorage(uri));
	}

	readDirectory(uri: Uri): Thenable<[string, FileType][]> {
		return workspace.fs.readDirectory(this.toStorage(uri));
	}

	async createDirectory(uri: Uri): Promise<void> {
		await workspace.fs.createDirectory(this.toStorage(uri));
		this.fire(FileChangeType.Created, uri);
	}

	readFile(uri: Uri): Thenable<Uint8Array> {
		return workspace.fs.readFile(this.toStorage(uri));
	}

	async writeFile(uri: Uri, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean }): Promise<void> {
		const target = this.toStorage(uri);
		const exists = await workspace.fs.stat(target).then(() => true, () => false);
		if (!exists && !options.create) {
			throw FileSystemError.FileNotFound(uri);
		}
		if (exists && !options.overwrite) {
			throw FileSystemError.FileExists(uri);
		}
		await workspace.fs.writeFile(target, content);
		this.fire(exists ? FileChangeType.Changed : FileChangeType.Created, uri);
	}

	async delete(uri: Uri, options: { readonly recursive: boolean }): Promise<void> {
		await workspace.fs.delete(this.toStorage(uri), { recursive: options.recursive, useTrash: false });
		this.fire(FileChangeType.Deleted, uri);
	}

	async rename(oldUri: Uri, newUri: Uri, options: { readonly overwrite: boolean }): Promise<void> {
		await workspace.fs.rename(this.toStorage(oldUri), this.toStorage(newUri), { overwrite: options.overwrite });
		this.fire(FileChangeType.Deleted, oldUri);
		this.fire(FileChangeType.Created, newUri);
	}

	async copy(source: Uri, destination: Uri, options: { readonly overwrite: boolean }): Promise<void> {
		await workspace.fs.copy(this.toStorage(source), this.toStorage(destination), { overwrite: options.overwrite });
		this.fire(FileChangeType.Created, destination);
	}
}

interface FolderItem extends QuickPickItem {
	readonly uri?: Uri;
	readonly action?: 'new';
}

const rootUri = Uri.from({ scheme: SCHEME, path: '/' });

async function listFolders(): Promise<Uri[]> {
	await workspace.fs.createDirectory(rootUri);
	const entries = await workspace.fs.readDirectory(rootUri);
	return entries
		.filter(([name, type]) => (type & FileType.Directory) !== 0 && !name.startsWith('.'))
		.map(([name]) => Uri.joinPath(rootUri, name))
		.sort((a, b) => a.path.localeCompare(b.path));
}

function isOpen(uri: Uri): boolean {
	return (workspace.workspaceFolders ?? []).some(folder => folder.uri.toString() === uri.toString());
}

function openFolder(uri: Uri): void {
	const folders = workspace.workspaceFolders ?? [];
	if (!isOpen(uri)) {
		workspace.updateWorkspaceFolders(folders.length, 0, { uri });
	}
	commands.executeCommand('workbench.view.explorer');
}

function validateName(existing: readonly string[], current?: string) {
	return (value: string): string | undefined => {
		const name = value.trim();
		if (!name) {
			return l10n.t('Enter a folder name.');
		}
		if (/[\\/:*?"<>|]/.test(name) || name.startsWith('.')) {
			return l10n.t('The name contains characters that are not allowed.');
		}
		if (name !== current && existing.includes(name)) {
			return l10n.t('A virtual folder named "{0}" already exists.', name);
		}
		return undefined;
	};
}

function basename(uri: Uri): string {
	return uri.path.split('/').filter(Boolean).pop() ?? uri.path;
}

async function newFolder(open: boolean): Promise<Uri | undefined> {
	const existing = (await listFolders()).map(basename);
	const name = await window.showInputBox({
		title: l10n.t('New Virtual Folder'),
		prompt: l10n.t('Name of the folder to create in the virtual file system'),
		validateInput: validateName(existing),
	});
	if (!name) {
		return undefined;
	}
	const uri = Uri.joinPath(rootUri, name.trim());
	await workspace.fs.createDirectory(uri);
	if (open) {
		openFolder(uri);
	}
	return uri;
}

async function pickFolder(): Promise<void> {
	const folders = await listFolders();
	const items: FolderItem[] = [
		{ label: `$(new-folder) ${l10n.t('New Virtual Folder...')}`, action: 'new', alwaysShow: true },
		...folders.map(uri => ({ label: `$(folder) ${basename(uri)}`, description: isOpen(uri) ? l10n.t('open') : undefined, uri })),
	];
	const pick = await window.showQuickPick(items, {
		title: l10n.t('Open Virtual Folder'),
		placeHolder: folders.length ? l10n.t('Select a virtual folder to open') : l10n.t('No virtual folders yet'),
	});
	if (pick?.action === 'new') {
		await newFolder(true);
	} else if (pick?.uri) {
		openFolder(pick.uri);
	}
}

const renameButton: QuickInputButton = { iconPath: new ThemeIcon('edit'), tooltip: l10n.t('Rename') };
const deleteButton: QuickInputButton = { iconPath: new ThemeIcon('trash'), tooltip: l10n.t('Delete') };

async function manageFolders(): Promise<void> {
	const picker = window.createQuickPick<FolderItem>();
	picker.title = l10n.t('Manage Virtual Folders');
	picker.placeholder = l10n.t('Select a folder to open it, or use the buttons to rename or delete');

	const refresh = async () => {
		const folders = await listFolders();
		picker.items = [
			{ label: `$(new-folder) ${l10n.t('New Virtual Folder...')}`, action: 'new', alwaysShow: true },
			...folders.map(uri => ({ label: `$(folder) ${basename(uri)}`, description: isOpen(uri) ? l10n.t('open') : undefined, uri, buttons: [renameButton, deleteButton] })),
		];
	};

	// Rename/delete dialogs hide the picker; `busy` keeps those hides from ending the session.
	let busy = false;
	const done = new EventEmitter<void>();
	const disposables: Disposable[] = [
		done,
		picker.onDidAccept(async () => {
			const [item] = picker.selectedItems;
			picker.hide();
			if (item?.action === 'new') {
				await newFolder(true);
			} else if (item?.uri) {
				openFolder(item.uri);
			}
		}),
		picker.onDidTriggerItemButton(async ({ item, button }) => {
			if (!item.uri) {
				return;
			}
			busy = true;
			try {
				const name = basename(item.uri);
				if (button === renameButton) {
					const existing = (await listFolders()).map(basename);
					const newName = await window.showInputBox({ title: l10n.t('Rename Virtual Folder'), value: name, validateInput: validateName(existing, name) });
					if (newName && newName.trim() !== name) {
						await closeFolder(item.uri);
						await workspace.fs.rename(item.uri, Uri.joinPath(rootUri, newName.trim()));
					}
				} else if (button === deleteButton) {
					const confirm = l10n.t('Delete');
					const choice = await window.showWarningMessage(
						l10n.t('Delete the virtual folder "{0}" and everything in it?', name),
						{ modal: true, detail: l10n.t('This cannot be undone.') },
						confirm
					);
					if (choice === confirm) {
						await closeFolder(item.uri);
						await workspace.fs.delete(item.uri, { recursive: true });
					}
				}
				await refresh();
				picker.show();
			} finally {
				busy = false;
			}
		}),
		picker.onDidHide(() => {
			if (!busy) {
				done.fire();
			}
		}),
	];

	await refresh();
	picker.show();
	await new Promise<void>(resolve => disposables.push(done.event(() => resolve())));
	disposables.forEach(disposable => disposable.dispose());
	picker.dispose();
}

async function closeFolder(uri: Uri): Promise<void> {
	const index = (workspace.workspaceFolders ?? []).findIndex(folder => folder.uri.toString() === uri.toString());
	if (index !== -1) {
		workspace.updateWorkspaceFolders(index, 1);
	}
}

export async function activate(context: ExtensionContext): Promise<void> {
	const storageRoot = Uri.from({ scheme: 'vscode-userdata', path: '/vfs' });
	await workspace.fs.createDirectory(storageRoot).then(undefined, () => undefined);

	const provider = new VirtualFileSystemProvider(storageRoot);
	context.subscriptions.push(
		provider,
		workspace.registerFileSystemProvider(SCHEME, provider, { isCaseSensitive: true }),
		commands.registerCommand('vfs.openFolder', pickFolder),
		commands.registerCommand('vfs.newFolder', () => newFolder(true)),
		commands.registerCommand('vfs.manage', manageFolders),
	);
}

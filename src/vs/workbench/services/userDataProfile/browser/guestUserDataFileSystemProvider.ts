/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { posix } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { FileSystemProviderCapabilities, FileType, IFileChange, IFileDeleteOptions, IFileOverwriteOptions, IFileSystemProviderWithFileReadWriteCapability, IFileWriteOptions, IStat, IWatchOptions } from '../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../platform/files/common/inMemoryFilesystemProvider.js';

type DirEntry = [string, FileType];

/**
 * User data file system that keeps the default profile in memory. The default profile is the
 * guest profile: its settings, extension state and other files live for the session only, while
 * named profiles (one per signed in account) and everything outside the user home are persisted
 * by the given provider.
 */
export class GuestUserDataFileSystemProvider extends Disposable implements IFileSystemProviderWithFileReadWriteCapability {

	readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileAppend | FileSystemProviderCapabilities.PathCaseSensitive;
	readonly onDidChangeCapabilities: Event<void> = Event.None;

	private readonly guest = this._register(new InMemoryFileSystemProvider());

	private readonly _onDidChangeFile = this._register(new Emitter<readonly IFileChange[]>());
	readonly onDidChangeFile = this._onDidChangeFile.event;

	private readonly profilesHome: string;

	/**
	 * @param persisted provider for everything that outlives the session
	 * @param userHome path of the default profile, e.g. `/User`
	 */
	constructor(
		private readonly persisted: IFileSystemProviderWithFileReadWriteCapability,
		private readonly userHome: string,
	) {
		super();
		this.profilesHome = posix.join(userHome, 'profiles');
		this._register(this.guest.onDidChangeFile(changes => this._onDidChangeFile.fire(changes)));
		this._register(persisted.onDidChangeFile(changes => this._onDidChangeFile.fire(changes)));
	}

	/** Whether the path belongs to the guest (default) profile and so only lives in memory. */
	private isGuest(path: string): boolean {
		if (path === this.userHome) {
			return false; // shared by both, handled explicitly
		}
		return path.startsWith(this.userHome + '/') && path !== this.profilesHome && !path.startsWith(this.profilesHome + '/');
	}

	private target(resource: URI): IFileSystemProviderWithFileReadWriteCapability {
		return this.isGuest(resource.path) ? this.guest : this.persisted;
	}

	watch(resource: URI, opts: IWatchOptions): IDisposable {
		return this.target(resource).watch(resource, opts);
	}

	async stat(resource: URI): Promise<IStat> {
		if (resource.path === this.userHome) {
			return this.persisted.stat(resource).catch(() => this.guest.stat(resource));
		}
		return this.target(resource).stat(resource);
	}

	async mkdir(resource: URI): Promise<void> {
		if (resource.path === this.userHome) {
			await Promise.all([this.persisted.mkdir(resource).catch(() => undefined), this.guest.mkdir(resource).catch(() => undefined)]);
			return;
		}
		if (this.isGuest(resource.path)) {
			await this.ensureGuestParents(resource);
		}
		return this.target(resource).mkdir(resource);
	}

	async readdir(resource: URI): Promise<DirEntry[]> {
		if (resource.path === this.userHome) {
			const [persisted, guest] = await Promise.all([
				this.persisted.readdir(resource).catch(() => [] as DirEntry[]),
				this.guest.readdir(resource).catch(() => [] as DirEntry[]),
			]);
			return [...persisted.filter(([name]) => name === 'profiles'), ...guest.filter(([name]) => name !== 'profiles')];
		}
		return this.target(resource).readdir(resource);
	}

	readFile(resource: URI): Promise<Uint8Array> {
		return this.target(resource).readFile(resource);
	}

	async writeFile(resource: URI, content: Uint8Array, opts: IFileWriteOptions): Promise<void> {
		if (this.isGuest(resource.path)) {
			await this.ensureGuestParents(resource);
		}
		return this.target(resource).writeFile(resource, content, opts);
	}

	delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
		return this.target(resource).delete(resource, opts);
	}

	async rename(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> {
		const source = this.target(from);
		const destination = this.target(to);
		if (source === destination) {
			if (source === this.guest) {
				await this.ensureGuestParents(to);
			}
			return source.rename(from, to, opts);
		}

		// Moving between the session and persisted storage
		await this.copyAcross(from, to, source, destination);
		await source.delete(from, { recursive: true, useTrash: false, atomic: false });
	}

	private async copyAcross(from: URI, to: URI, source: IFileSystemProviderWithFileReadWriteCapability, destination: IFileSystemProviderWithFileReadWriteCapability): Promise<void> {
		const stat = await source.stat(from);
		if (stat.type & FileType.Directory) {
			await destination.mkdir(to).catch(() => undefined);
			for (const [name] of await source.readdir(from)) {
				await this.copyAcross(from.with({ path: posix.join(from.path, name) }), to.with({ path: posix.join(to.path, name) }), source, destination);
			}
		} else {
			await destination.writeFile(to, await source.readFile(from), { create: true, overwrite: true, unlock: false, atomic: false });
		}
	}

	/** The in-memory provider does not create parent folders on its own. */
	private async ensureGuestParents(resource: URI): Promise<void> {
		const missing: URI[] = [];
		for (let parent = resource.with({ path: posix.dirname(resource.path) }); parent.path !== '/'; parent = parent.with({ path: posix.dirname(parent.path) })) {
			try {
				await this.guest.stat(parent);
				break;
			} catch {
				missing.unshift(parent);
			}
		}
		for (const folder of missing) {
			await this.guest.mkdir(folder).catch(() => undefined);
		}
	}
}

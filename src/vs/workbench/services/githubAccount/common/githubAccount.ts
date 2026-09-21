/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** A GitHub account as shown in the workbench. */
export interface IGitHubAccount {
	readonly id: string;
	readonly label: string;
	readonly avatarUrl?: string;
}

/** A GitHub sign-in, as created by the isomorphic-git extension. */
export interface IGitHubSession {
	readonly id: string;
	readonly accessToken: string;
	readonly account: { readonly id: string; readonly label: string };
	readonly avatarUrl?: string;
	readonly scopes: readonly string[];
}

export const IGitHubAccountService = createDecorator<IGitHubAccountService>('githubAccountService');

/**
 * The GitHub account of this page. Each account has its own profile, which holds its settings,
 * recently opened folders and virtual folders; without an account the page uses the guest
 * (default) profile, which only lives for the session.
 *
 * The session, including its token, is only ever held in memory here. Extensions restart when the
 * profile changes, so the extension that signs in hands its session over and picks it up again
 * after the restart. Nothing is written to storage, and the session is gone with the page.
 */
export interface IGitHubAccountService {
	readonly _serviceBrand: undefined;

	readonly account: IGitHubAccount | undefined;
	readonly onDidChangeAccount: Event<IGitHubAccount | undefined>;

	getSession(): IGitHubSession | undefined;
	setSession(session: IGitHubSession): void;
	clearSession(): void;

	signIn(): Promise<void>;
	signOut(): Promise<void>;
}

/** Whether a GitHub account is signed in on this page. */
export const GitHubAccountSignedInContext = new RawContextKey<boolean>('githubAccountSignedIn', false, localize('githubAccountSignedIn', "Whether a GitHub account is signed in"));

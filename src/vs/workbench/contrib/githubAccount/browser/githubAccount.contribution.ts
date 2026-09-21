/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution2, WorkbenchPhase, IWorkbenchContribution } from '../../../common/contributions.js';
import { GitHubAccountSignedInContext, IGitHubAccountService, IGitHubSession } from '../../../services/githubAccount/common/githubAccount.js';

// Hand-over of the session with the extension that signs in (see IGitHubAccountService)

CommandsRegistry.registerCommand('_vsprocessing.githubSession.get', (accessor: ServicesAccessor): IGitHubSession | undefined => {
	return accessor.get(IGitHubAccountService).getSession();
});

CommandsRegistry.registerCommand('_vsprocessing.githubSession.set', (accessor: ServicesAccessor, session: IGitHubSession): void => {
	accessor.get(IGitHubAccountService).setSession(session);
});

CommandsRegistry.registerCommand('_vsprocessing.githubSession.clear', (accessor: ServicesAccessor): void => {
	accessor.get(IGitHubAccountService).clearSession();
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vsprocessing.github.signIn',
			title: localize2('signInWithGitHub', "Sign in with GitHub"),
			f1: true,
			precondition: GitHubAccountSignedInContext.negate(),
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IGitHubAccountService).signIn();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vsprocessing.github.signOut',
			title: localize2('signOutOfGitHub', "Sign Out of GitHub"),
			f1: true,
			precondition: ContextKeyExpr.has(GitHubAccountSignedInContext.key),
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IGitHubAccountService).signOut();
	}
});

class GitHubAccountContextContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.githubAccountContext';

	constructor(
		@IGitHubAccountService githubAccountService: IGitHubAccountService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		const signedIn = GitHubAccountSignedInContext.bindTo(contextKeyService);
		signedIn.set(!!githubAccountService.account);
		this._register(githubAccountService.onDidChangeAccount(account => signedIn.set(!!account)));
	}
}

registerWorkbenchContribution2(GitHubAccountContextContribution.ID, GitHubAccountContextContribution, WorkbenchPhase.BlockStartup);

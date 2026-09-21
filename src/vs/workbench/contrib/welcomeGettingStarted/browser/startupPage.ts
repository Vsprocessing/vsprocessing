/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { Disposable, } from '../../../../base/common/lifecycle.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { GettingStartedEditorOptions, GettingStartedInput, gettingStartedInputTypeId } from './gettingStartedInput.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { getTelemetryLevel } from '../../../../platform/telemetry/common/telemetryUtils.js';
import { TelemetryLevel } from '../../../../platform/telemetry/common/telemetry.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { localize } from '../../../../nls.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { AuxiliaryBarMaximizedContext } from '../../../common/contextkeys.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { getActiveElement } from '../../../../base/browser/dom.js';

export const restoreWalkthroughsConfigurationKey = 'workbench.welcomePage.restorableWalkthroughs';
export type RestoreWalkthroughsConfigurationValue = { folder: string; category?: string; step?: string };

const telemetryOptOutStorageKey = 'workbench.telemetryOptOutShown';

export class StartupPageEditorResolverContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.startupPageEditorResolver';

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorResolverService editorResolverService: IEditorResolverService
	) {
		super();

		this._register(editorResolverService.registerEditor(
			`${GettingStartedInput.RESOURCE.scheme}:/**`,
			{
				id: GettingStartedInput.ID,
				label: localize('welcome.displayName', "Welcome Page"),
				priority: RegisteredEditorPriority.builtin,
			},
			{
				singlePerResource: true,
				canSupportResource: uri => uri.scheme === GettingStartedInput.RESOURCE.scheme,
			},
			{
				createEditorInput: ({ options }) => {
					return {
						editor: this.instantiationService.createInstance(GettingStartedInput, options as GettingStartedEditorOptions),
						options: {
							...options,
							pinned: false
						}
					};
				}
			}
		));
	}
}

export class StartupPageRunnerContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.startupPageRunner';
	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IProductService private readonly productService: IProductService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IStorageService private readonly storageService: IStorageService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super();

		this.run().then(undefined, onUnexpectedError);
		this._register(this.editorService.onDidCloseEditor((e) => {
			if (e.editor instanceof GettingStartedInput) {
				e.editor.selectedCategory = undefined;
				e.editor.selectedStep = undefined;
			}
		}));
	}

	private async run() {

		// Wait for resolving startup editor until we are restored to reduce startup pressure
		await this.lifecycleService.when(LifecyclePhase.Restored);

		if (AuxiliaryBarMaximizedContext.getValue(this.contextKeyService)) {
			// If the auxiliary bar is maximized, we do not show the welcome page.
			return;
		}

		// Always open Welcome page for first-launch, no matter what is open or which startupEditor is set.
		if (
			this.productService.enableTelemetry
			&& this.productService.showTelemetryOptOut
			&& getTelemetryLevel(this.configurationService) !== TelemetryLevel.NONE
			&& !this.environmentService.skipWelcome
			&& !this.storageService.get(telemetryOptOutStorageKey, StorageScope.PROFILE)
		) {
			this.storageService.store(telemetryOptOutStorageKey, true, StorageScope.PROFILE, StorageTarget.USER);
		}

		// Every page load that does not open a folder from the URL starts on the welcome page
		if (this.contextService.getWorkspace().folders.length === 0) {
			await this.openGettingStarted(true);
		}
	}

	private async openGettingStarted(showTelemetryNotice?: boolean) {
		const startupEditorTypeID = gettingStartedInputTypeId;
		const editor = this.editorService.activeEditor;

		// Ensure that the welcome editor won't get opened more than once
		if (editor?.typeId === startupEditorTypeID || this.editorService.editors.some(e => e.typeId === startupEditorTypeID)) {
			return;
		}

		if (startupEditorTypeID === gettingStartedInputTypeId) {
			this.editorService.openEditor({
				resource: GettingStartedInput.RESOURCE,
				options: {
					index: editor ? 0 : undefined,
					pinned: false,
					preserveFocus: this.shouldPreserveFocus(),
					...{ showTelemetryNotice }
				},
			});
		}
	}

	private shouldPreserveFocus(): boolean {
		const activeElement = getActiveElement();
		if (!activeElement || activeElement === mainWindow.document.body || this.layoutService.hasFocus(Parts.EDITOR_PART)) {
			return false; // steal focus if nothing meaningful is focused or editor area has focus
		}

		return true; // do not steal focus
	}

}

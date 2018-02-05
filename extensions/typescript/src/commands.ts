/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import { TypeScriptServiceClientHost } from './typescriptMain';
import { Command } from './utils/commandManager';
import { Lazy } from './utils/lazy';

export class ReloadTypeScriptProjectsCommand implements Command {
	public readonly id = 'typescript.reloadProjects';

	public constructor(
		private readonly lazyClientHost: Lazy<TypeScriptServiceClientHost>
	) { }

	public execute() {
		this.lazyClientHost.value.reloadProjects();
	}
}

export class ReloadJavaScriptProjectsCommand implements Command {
	public readonly id = 'javascript.reloadProjects';

	public constructor(
		private readonly lazyClientHost: Lazy<TypeScriptServiceClientHost>
	) { }

	public execute() {
		this.lazyClientHost.value.reloadProjects();
	}
}

export class SelectTypeScriptVersionCommand implements Command {
	public readonly id = 'typescript.selectTypeScriptVersion';

	public constructor(
		private readonly lazyClientHost: Lazy<TypeScriptServiceClientHost>
	) { }

	public execute() {
		this.lazyClientHost.value.serviceClient.onVersionStatusClicked();
	}
}

export class OpenTsServerLogCommand implements Command {
	public readonly id = 'typescript.openTsServerLog';

	public constructor(
		private readonly lazyClientHost: Lazy<TypeScriptServiceClientHost>
	) { }

	public execute() {
		this.lazyClientHost.value.serviceClient.openTsServerLogFile();
	}
}

export class RestartTsServerCommand implements Command {
	public readonly id = 'typescript.restartTsServer';

	public constructor(
		private readonly lazyClientHost: Lazy<TypeScriptServiceClientHost>
	) { }

	public execute() {
		this.lazyClientHost.value.serviceClient.restartTsServer();
	}
}

export class TypeScriptGoToProjectConfigCommand implements Command {
	public readonly id = 'typescript.goToProjectConfig';

	public constructor(
		private readonly lazyClientHost: Lazy<TypeScriptServiceClientHost>,
	) { }

	public execute() {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			this.lazyClientHost.value.goToProjectConfig(true, editor.document.uri);
		}
	}
}

export class JavaScriptGoToProjectConfigCommand implements Command {
	public readonly id = 'javascript.goToProjectConfig';

	public constructor(
		private readonly lazyClientHost: Lazy<TypeScriptServiceClientHost>,
	) { }

	public execute() {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			this.lazyClientHost.value.goToProjectConfig(false, editor.document.uri);
		}
	}
}
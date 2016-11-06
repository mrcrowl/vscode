/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { TextDocument, Disposable, TextDocumentWillSaveEvent, window, workspace } from 'vscode';

// import * as fs from 'fs';
import * as Proto from '../protocol';
import { ITypescriptServiceClient } from '../typescriptService';

let nextBatchId: number = 0;

/** Maximum time allowed between receiving willSaves and didSave notifications for a batch */
const BATCH_ISOLATION_TIME = 2000;
const BATCH_EXPIRY_TIME = 15000;
const COMPILED_MESSAGE_DURATION = 3000;

export default class TypeScriptCompileOnSaveSupport {
	private client: ITypescriptServiceClient;
	private modeIds: Map<boolean>;
	private disposables: Disposable[] = [];
	private activeBatches: CompileOnSaveMultipleFileBatcher[];

	constructor(client: ITypescriptServiceClient, modeIds: string[]) {
		this.client = client;
		this.activeBatches = [];
		this.modeIds = Object.create(null);
		modeIds.forEach(modeId => this.modeIds[modeId] = true);
	}

	public listen() {
		workspace.onWillSaveTextDocument(this.onWillSaveTextDocument, this, this.disposables);
		workspace.onDidSaveTextDocument(this.onDidSaveTextDocument, this, this.disposables);
	}

	public dispose(): void {
		while (this.disposables.length) {
			this.disposables.pop().dispose();
		}
	}

	// public clearCachedEnabledStatuses() {
	// 	this.enabledCache.clear();
	// }

	public onWillSaveTextDocument(e: TextDocumentWillSaveEvent) {
		let {document} = e;

		// optimised early exit: no doc, doc not TS, compileOnSave disabled for file
		if (!document ||
			!(document.languageId in this.modeIds)) {
			return;
		}

		let openBatch: CompileOnSaveMultipleFileBatcher;
		for (let activeBatch of this.activeBatches) {
			if (activeBatch.open && !activeBatch.expired) {
				openBatch = activeBatch;
				break;
			}
		}

		if (!openBatch) {
			let newBatch = new CompileOnSaveMultipleFileBatcher(nextBatchId++);
			this.activeBatches.push(newBatch);
			openBatch = newBatch;
		}

		openBatch.addPendingSave(document);
		//console.log(`Will save: ${document.fileName}`);
		// }, reason => {
		// 	console.error(reason);
		// });
		// e.waitUntil(enabledChecked);
	}

	public onDidSaveTextDocument(document: TextDocument) {
		if (!document ||
			!(document.languageId in this.modeIds)) {
			return;
		}

		// console.log(`Did save: ${document.fileName}`);

		let batch = this.getBatchForDocument(document);
		if (batch) {
			let { first } = batch.notifyDocumentDidSave(document);
			if (first) {
				batch.compileMessage = window.setStatusBarMessage(`$(zap) Compiling ts`);
			}
			this.pruneBatchIfComplete(batch);
		}
		// else { no batch... expired? }

		const affectedFileArgs: Proto.CompileOnSaveEmitFileRequestArgs = {
			file: document.fileName,
			forced: false
		};

		this.client.execute('compileOnSaveAffectedFileList', affectedFileArgs).then(response => {
			const { body } = response;
			if (body.length === 0) {
				if (batch.compileMessage) {
					batch.compileMessage.dispose();
					batch.compileMessage = null;
				}
				return;
			}

			let affectedFiles: AffectedFile[] = [];
			for (let project of body) {
				for (let filename of project.fileNames) {
					affectedFiles.push({
						key: hashAffectedFile(filename, project.projectFileName),
						projectFileName: project.projectFileName,
						filename: filename
					});
				}
			}

			if (batch) {
				batch.provideAffectedFiles(affectedFiles);
			}

			for (let file of affectedFiles) {
				let emit: boolean = true;
				if (batch) {
					emit = batch.shouldRequestEmitForAffectedFile(file);
				}
				// else { no batch... emit everything }

				if (emit) {
					const emitArgs: Proto.CompileOnSaveEmitFileRequestArgs = { file: file.filename, projectFileName: file.projectFileName };
					this.client.execute('compileOnSaveEmitFile', emitArgs).then(emitResponse => {
						if (batch) {
							batch.notifyEmitComplete(file);
						}
					}, reason => {
						console.error(`Emit failed: ${file.filename}`);
						if (batch) {
							batch.notifyEmitComplete(file);
						}
					});
				}
			}
		});
	}

	private pruneBatchIfComplete(batch: CompileOnSaveMultipleFileBatcher) {
		if (batch.savesComplete && this.activeBatches.indexOf(batch) >= 0) {
			this.activeBatches = this.activeBatches.filter(b => b !== batch);
			// console.log(`Batch #${batch.id} complete: ${batch.elapsed}ms`);

			this.pruneExpiredBatches();
		}
	}

	private pruneExpiredBatches() {
		if (this.activeBatches.length > 0) {
			let expiredBatches = this.activeBatches.filter(batch => batch.expired);
			this.activeBatches = this.activeBatches.filter(batch => expiredBatches.indexOf(batch) === -1);

			for (let expiredBatch of expiredBatches) {
				if (expiredBatch.compileMessage) {
					expiredBatch.compileMessage.dispose();
				}
				// console.log(`Pruned batch #${expiredBatch.id}: Elapsed = ${expiredBatch.elapsed}ms`);
			}
		}
	}

	private getBatchForDocument(document: TextDocument): CompileOnSaveMultipleFileBatcher | undefined {
		for (let batch of this.activeBatches) {
			if (batch.containsPendingDocumentSave(document)) {
				return batch;
			}
		}

		return undefined;
	}
}

// class CompileOnSaveEnabledCache {
// 	private client: ITypescriptServiceClient;
// 	private enabledPerFile: Map<boolean>;
// 	private enabledPerConfig: Map<boolean>;

// 	constructor(client: ITypescriptServiceClient) {
// 		this.client = client;
// 		this.clear();
// 	}

// 	public clear() {
// 		this.enabledPerFile = Object.create(null);
// 		this.enabledPerConfig = Object.create(null);
// 	}

// 	public isDisabledForFile(file: string): boolean {
// 		return this.enabledPerFile[file] === false;
// 	}

// 	public getStatusForFile(file: string): Promise<boolean> {
// 		if (file in this.enabledPerFile) {
// 			let enabled = this.enabledPerFile[file];
// 			return Promise.resolve(enabled);
// 		} else {
// 			let projectInfo = this.client.execute('projectInfo', { file: file, needFileNameList: false });
// 			projectInfo.then(response => {
// 				console.log("projectInfo returned: " + response.body.configFileName);
// 				let configFileName = response.body.configFileName;
// 				if (configFileName) {
// 					if (configFileName in this.enabledPerConfig) {
// 						let enabled = this.enabledPerConfig[configFileName];
// 						this.enabledPerFile[file] = enabled;
// 						return enabled;
// 					}

// 					let enabled = this.readConfigFileCompileOnSaveOption(configFileName);
// 					if (enabled !== undefined) {
// 						this.enabledPerFile[file] = enabled;
// 						this.enabledPerConfig[configFileName] = enabled;
// 						return enabled;
// 					}
// 				}
// 				return false;
// 			}, reason => {
// 				console.error("getStatusForFile", reason);
// 				return false
// 			});
// 		}
// 	}

// 	private readConfigFileCompileOnSaveOption(configFileName: string): boolean | undefined {
// 		try {
// 			let tsconfig = JSON.parse(fs.readFileSync(configFileName, 'utf8'));
// 			return tsconfig.compileOnSave || false;
// 		}
// 		catch (e) {
// 			return undefined;
// 		}
// 	}
// }

class CompileOnSaveMultipleFileBatcher {
	public readonly id: number;
	public compileMessage: Disposable;

	private creationTimestamp: number;
	private firstDidSaveTimestamp: number;
	private pendingSavedDocuments: Map<boolean>;
	private affectedFilesStatusHash: Map<AffectedFileStatus>;
	private affectedFilesRemainingEmitCount: number;
	private allPendingSavesCompleted: boolean;
	private receivedDidSavesNotifications: boolean;

	constructor(id: number) {
		this.id = id;
		this.creationTimestamp = Date.now();
		this.pendingSavedDocuments = Object.create(null);
		this.affectedFilesStatusHash = Object.create(null);
		this.allPendingSavesCompleted = false;
		this.receivedDidSavesNotifications = false;
	}

	public addPendingSave(document: TextDocument) {
		if (!this.receivedDidSavesNotifications) {
			this.pendingSavedDocuments[document.fileName] = true;
		} else {
			console.error('Can\'t add pending save to batch that has received didSave notifications.');
		}
	}

	public containsPendingDocumentSave(document: TextDocument): boolean {
		return document.fileName in this.pendingSavedDocuments;
	}

	public notifyDocumentDidSave(document: TextDocument): { first: boolean } {
		let first: boolean = false;
		this.receivedDidSavesNotifications = true; // once we've received a "did-save" no more pending saves can be added
		if (!this.firstDidSaveTimestamp) {
			this.firstDidSaveTimestamp = Date.now();
			first = true;
		}

		delete this.pendingSavedDocuments[document.fileName];
		if (Object.keys(this.pendingSavedDocuments).length === 0) {
			this.allPendingSavesCompleted = true;
		}

		return { first };
	}

	public provideAffectedFiles(affectedFiles: AffectedFile[]) {
		let affectedFilesHash = Object.create(null);
		for (let file of affectedFiles) {
			affectedFilesHash[file.key] = { emmitted: false, requested: false };
		}
		this.affectedFilesStatusHash = affectedFilesHash;
		this.affectedFilesRemainingEmitCount = affectedFiles.length;
	}

	public shouldRequestEmitForAffectedFile(file: AffectedFile): boolean {
		if (!(file.key in this.affectedFilesStatusHash)) {
			console.warn(`shouldRequestEmitForAffectedFile called for unknown AffectedFile ${file.key}`);
			return false;
		}

		let affectedFileStatus = this.affectedFilesStatusHash[file.key];
		if (affectedFileStatus.requested) {
			console.log(`Already emitted: ${file}`);
			return false;
		}

		return true;
	}

	public notifyEmitComplete(file: AffectedFile) {
		if (!(file.key in this.affectedFilesStatusHash)) {
			console.warn(`notifyEmitComplete called for unknown hash '${file.key}'`);
			return;
		}

		let affectedFile = this.affectedFilesStatusHash[file.key];

		if (affectedFile.emmitted) {
			console.warn(`notifyEmitComplete called for already-emmitted file '${file.key}'`);
			return;
		}
		this.affectedFilesRemainingEmitCount--;

		if (this.affectedFilesRemainingEmitCount === 0) {
			if (this.compileMessage) {
				this.compileMessage.dispose();
				this.compileMessage = null;
			}
			let elapsed = Date.now() - this.firstDidSaveTimestamp;
			window.setStatusBarMessage(`$(check) Compiled in ${elapsed} ms`, COMPILED_MESSAGE_DURATION);
		}
	}

	/** Batch is open for more pending saves, i.e. Save All (i.e. hasn't received any didSave notifications yet) */
	public get open(): boolean {
		return !this.receivedDidSavesNotifications && this.elapsed < BATCH_ISOLATION_TIME;
	}

	/** All pending document saves for this batch have completed */
	public get savesComplete(): boolean {
		return this.allPendingSavesCompleted;
	}

	public get emitComplete(): boolean {
		return this.affectedFilesRemainingEmitCount === 0;
	}

	/** Elapsed time since this batch was created */
	public get elapsed(): number {
		return Date.now() - this.creationTimestamp;
	}

	public get expired(): boolean {
		return this.elapsed > BATCH_EXPIRY_TIME;
	}
}

interface AffectedFile {
	key: string;
	projectFileName: string;
	filename: string;
}

interface AffectedFileStatus {
	requested: boolean;
	emmitted: boolean;
}

const hashAffectedFile = (filename: string, projectFileName: string): string => `${projectFileName || ''}|${filename}`;
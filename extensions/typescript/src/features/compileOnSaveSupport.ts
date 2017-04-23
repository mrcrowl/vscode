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
	private watchedLanguageModeIds: Map<string, boolean>;
	private disposables: Disposable[] = [];
	private activeBatches: CompileOnSaveMultipleFileBatcher[];

	constructor(client: ITypescriptServiceClient, languageModeIds: string[]) {
		this.client = client;
		this.activeBatches = [];
		this.watchedLanguageModeIds = hash(languageModeIds);
	}

	private watchingLanguage(languageId: string): boolean {
		return this.watchedLanguageModeIds.has(languageId)
	}

	public listen() {
		workspace.onWillSaveTextDocument(this.onWillSaveTextDocument, this, this.disposables);
		workspace.onDidSaveTextDocument(this.onDidSaveTextDocument, this, this.disposables);
	}

	public dispose(): void {
		while (this.disposables.length) {
			this.disposables.pop()!.dispose();
		}
	}

	// public clearCachedEnabledStatuses() {
	// 	this.enabledCache.clear();
	// }

	public onWillSaveTextDocument(e: TextDocumentWillSaveEvent) {
		// optimised early exit: no doc, doc not TS, compileOnSave disabled for file
		if (!(e.document && this.watchingLanguage(e.document.languageId))) {
			return;
		}

		let openBatch: CompileOnSaveMultipleFileBatcher | undefined;
		for (const activeBatch of this.activeBatches) {
			if (activeBatch.open && !activeBatch.expired) {
				openBatch = activeBatch;
				break;
			}
		}

		if (!openBatch) {
			const newBatch = new CompileOnSaveMultipleFileBatcher(nextBatchId++);
			this.activeBatches.push(newBatch);
			openBatch = newBatch;
		}

		openBatch.addPendingSave(e.document);
		//console.log(`Will save: ${document.fileName}`);
		// }, reason => {
		// 	console.error(reason);
		// });
		// e.waitUntil(enabledChecked);
	}

	public async onDidSaveTextDocument(document: TextDocument) {
		if (!(document && this.watchingLanguage(document.languageId))) {
			return;
		}

		// console.log(`Did save: ${document.fileName}`);

		const batch = this.getBatchForDocument(document);
		if (batch) {
			batch.notifyDocumentDidSave(document);
			this.pruneBatchIfComplete(batch);
		}
		// else { no batch... expired? }

		const affectedFileArgs: Proto.CompileOnSaveEmitFileRequestArgs = {
			file: document.fileName,
			forced: false
		};

		const response = await this.client.execute('compileOnSaveAffectedFileList', affectedFileArgs);
		const { body } = response;
		if (body.length === 0 && batch) {
			batch.dispose();
			return;
		}

		const affectedFiles: AffectedFile[] = [];
		for (const project of body) {
			for (const filename of project.fileNames) {
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

		for (const file of affectedFiles) {
			const emit: boolean = batch ? batch.shouldRequestEmitForAffectedFile(file) : true;

			if (emit) {
				const emitArgs: Proto.CompileOnSaveEmitFileRequestArgs = { file: file.filename, projectFileName: file.projectFileName };
				try {
					await this.client.execute('compileOnSaveEmitFile', emitArgs);
					if (batch) {
						batch.notifyEmitComplete(file);
					}
				}
				catch (e) {
					console.error(`Emit failed: ${file.filename}`);
					if (batch) {
						batch.notifyEmitComplete(file);
					}
				}
			}
		}
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
			const [expiredBatches, activeBatches] = partition(this.activeBatches, batch => batch.expired);
			this.activeBatches = activeBatches;

			for (const expiredBatch of expiredBatches) {
				expiredBatch.dispose();
				// console.log(`Pruned batch #${expiredBatch.id}: Elapsed = ${expiredBatch.elapsed}ms`);
			}
		}
	}

	private getBatchForDocument(document: TextDocument): CompileOnSaveMultipleFileBatcher | undefined {
		for (const batch of this.activeBatches) {
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
// 			const enabled = this.enabledPerFile[file];
// 			return Promise.resolve(enabled);
// 		} else {
// 			const projectInfo = this.client.execute('projectInfo', { file: file, needFileNameList: false });
// 			projectInfo.then(response => {
// 				console.log("projectInfo returned: " + response.body.configFileName);
// 				const configFileName = response.body.configFileName;
// 				if (configFileName) {
// 					if (configFileName in this.enabledPerConfig) {
// 						const enabled = this.enabledPerConfig[configFileName];
// 						this.enabledPerFile[file] = enabled;
// 						return enabled;
// 					}

// 					const enabled = this.readConfigFileCompileOnSaveOption(configFileName);
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
// 			const tsconfig = JSON.parse(fs.readFileSync(configFileName, 'utf8'));
// 			return tsconfig.compileOnSave || false;
// 		}
// 		catch (e) {
// 			return undefined;
// 		}
// 	}
// }

class CompileOnSaveMultipleFileBatcher {
	public readonly id: number;
	private compileStatusBarMessage: Disposable | null;

	private creationTimestamp: number;
	private firstDidSaveTimestamp: number;
	private pendingSavedDocuments: Map<string, boolean>;
	private affectedFilesStatusMap: Map<string, AffectedFileStatus>;
	private affectedFilesRemainingEmitCount: number;
	private allPendingSavesCompleted: boolean;
	private receivedDidSavesNotifications: boolean;

	/** Batch is open for more pending saves (i.e. hasn't received any didSave notifications yet) */
	public get open(): boolean { return !this.receivedDidSavesNotifications && this.elapsed < BATCH_ISOLATION_TIME; }

	/** All pending document saves for this batch have completed */
	public get savesComplete(): boolean { return this.allPendingSavesCompleted; }

	/** All emits have been completed */	
	public get emitComplete(): boolean { return this.affectedFilesRemainingEmitCount === 0; }

	/** Elapsed time since this batch was created */
	public get elapsed(): number { return Date.now() - this.creationTimestamp; }

	/** Batch has passed expiry threshold */	
	public get expired(): boolean { return this.elapsed > BATCH_EXPIRY_TIME; }

	constructor(id: number) {
		this.id = id;
		this.creationTimestamp = Date.now();
		this.pendingSavedDocuments = new Map();
		this.affectedFilesStatusMap = new Map();
		this.allPendingSavesCompleted = false;
		this.receivedDidSavesNotifications = false;
	}

	public addPendingSave(document: TextDocument) {
		if (this.receivedDidSavesNotifications) {
			console.error('Can\'t add pending save to batch that has received didSave notifications.');
		}
		else {
			this.pendingSavedDocuments.set(document.fileName, true);
		}
	}

	public containsPendingDocumentSave(document: TextDocument): boolean {
		return this.pendingSavedDocuments.has(document.fileName);
	}

	private updateStatusBarMessage(message: string, duration?: number) {
		if (this.compileStatusBarMessage) {
			this.compileStatusBarMessage.dispose();
		}
		if (duration) {
			this.compileStatusBarMessage = window.setStatusBarMessage(message, duration);
		}
		else {
			this.compileStatusBarMessage = window.setStatusBarMessage(message);
		}
	}

	public notifyDocumentDidSave(document: TextDocument): { isFirstSave: boolean } {
		let first: boolean = false;
		this.receivedDidSavesNotifications = true; // once we've received a "did-save" no more pending saves can be added
		if (!this.firstDidSaveTimestamp) {
			this.firstDidSaveTimestamp = Date.now();
			this.updateStatusBarMessage(`$(zap) Compiling ts`);
			first = true;
		}

		this.pendingSavedDocuments.delete(document.fileName);
		if (this.pendingSavedDocuments.size === 0) {
			this.allPendingSavesCompleted = true;
		}

		return { isFirstSave: first };
	}

	public provideAffectedFiles(affectedFiles: AffectedFile[]) {
		const affectedFilesMap = new Map<string, AffectedFileStatus>();
		for (const file of affectedFiles) {
			affectedFilesMap.set(file.key, { emmitted: false, requested: false });
		}
		this.affectedFilesStatusMap = affectedFilesMap;
		this.affectedFilesRemainingEmitCount = affectedFiles.length;
	}

	public shouldRequestEmitForAffectedFile(file: AffectedFile): boolean {
		if (!this.affectedFilesStatusMap.has(file.key)) {
			console.warn(`shouldRequestEmitForAffectedFile called for unknown AffectedFile ${file.key}`);
			return false;
		}

		const affectedFileStatus = this.affectedFilesStatusMap.get(file.key);
		if (affectedFileStatus && affectedFileStatus.requested) {
			console.log(`Already emitted: ${file}`);
			return false;
		}

		return true;
	}

	public notifyEmitComplete(file: AffectedFile) {
		if (!this.affectedFilesStatusMap.has(file.key)) {
			console.warn(`notifyEmitComplete called for unknown hash '${file.key}'`);
			return;
		}

		const affectedFile = this.affectedFilesStatusMap.get(file.key);

		if (affectedFile && affectedFile.emmitted) {
			console.warn(`notifyEmitComplete called for already-emmitted file '${file.key}'`);
			return;
		}
		this.affectedFilesRemainingEmitCount--;

		if (this.affectedFilesRemainingEmitCount === 0) {
			const elapsed = Date.now() - this.firstDidSaveTimestamp;
			this.updateStatusBarMessage(`$(check) Compiled in ${elapsed} ms`, COMPILED_MESSAGE_DURATION);
		}
	}

	public dispose() {
		if (this.compileStatusBarMessage) {
			this.compileStatusBarMessage.dispose();
			this.compileStatusBarMessage = null;
		}
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

function partition<T>(this: void, array: T[], fn: (el: T, i: number, ary: T[]) => boolean): [T[], T[]] {
	return array.reduce((result: [T[], T[]], element: T, i: number) => {
		if (fn(element, i, array)) {
			result[0].push(element)
		}
		else {
			result[1].push(element);
		}
		return result;
	}, <[T[], T[]]>[[], []]);
};

function hash<T>(this: void, array: T[]): Map<T, boolean> {
	const map = new Map<T, boolean>();
	for (const item of array) {
		map.set(item, true);
	}
	return map;
}

const hashAffectedFile = (filename: string, projectFileName: string): string => `${projectFileName || ''}|${filename}`;
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { TextDocument, Disposable, TextDocumentWillSaveEvent, window, workspace, StatusBarItem, StatusBarAlignment } from 'vscode';

// import * as fs from 'fs';
import * as protocol from '../protocol';
import { ITypescriptServiceClient } from '../typescriptService';
import * as path from "path";
import * as fs from 'fs';

let nextBatchId: number = 0;

/** Maximum time allowed between receiving willSaves and didSave notifications for a batch */
const BATCH_ISOLATION_TIME = 2000;
const BATCH_EXPIRY_TIME = 15000;
const COMPILED_MESSAGE_DURATION = 3000;
const MAX_WILL_SAVE_WAIT_TIME = 1000;

export default class TypeScriptCompileOnSaveSupport {
	private client: ITypescriptServiceClient;
	private watchedLanguageModeIds: Map<string, boolean>;
	private disposables: Disposable[] = [];
	private batches: CompileOnSaveMultipleFileBatcher[];
	private enabledCache: CompileOnSaveEnabledCache;
	private get openBatches() { return this.batches.filter(b => b.open); }

	constructor(client: ITypescriptServiceClient, languageModeIds: string[]) {
		this.client = client;
		this.batches = [];
		this.watchedLanguageModeIds = hash(languageModeIds);
		this.enabledCache = new CompileOnSaveEnabledCache(client);
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

	public clearCachedEnabledStatuses() {
		this.enabledCache.clear();
	}

	private async isCompileOnSaveEnabledForFile(filename: string, timeout: number, timeoutDefault: boolean = false): Promise<boolean> {
		// make sure that checking for compileOnSave enabled doesn't take
		// longer than 1500ms (we allow max of 1s)
		// see: https://code.visualstudio.com/docs/extensionAPI/vscode-api#workspace.onWillSaveTextDocument
		const enabled = await Promise.race([
			this.enabledCache.isEnabledForFile(filename),
			new Promise<boolean>(resolve => setTimeout(() => resolve(timeoutDefault), timeout))
		]);

		return enabled;
	}

	public async onWillSaveTextDocument(e: TextDocumentWillSaveEvent) {
		// optimised early exit: no doc, doc not TS, compileOnSave disabled for file
		if (!(e.document && this.watchingLanguage(e.document.languageId))) {
			return;
		}

		const enabled = await this.isCompileOnSaveEnabledForFile(e.document.fileName, MAX_WILL_SAVE_WAIT_TIME);
		if (!enabled) {
			return;
		}

		let openBatch: CompileOnSaveMultipleFileBatcher | undefined;
		for (const activeBatch of this.openBatches) {
			openBatch = activeBatch;
			break;
		}

		if (!openBatch) {
			const newBatch = new CompileOnSaveMultipleFileBatcher(nextBatchId++);
			this.batches.push(newBatch);
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
			console.log(`${path.basename(document.fileName)}: Batch #${batch.id}`);
			batch.notifyDocumentDidSave(document);
			this.pruneBatchIfSavesComplete(batch);
		}
		else {
			console.log(`${path.basename(document.fileName)}: NO Batch`);
		}
		// else { no batch... expired? }

		const affectedFileArgs: protocol.CompileOnSaveEmitFileRequestArgs = {
			file: document.fileName,
			forced: false
		};

		const response = await this.client.execute('compileOnSaveAffectedFileList', affectedFileArgs);
		const projects: protocol.CompileOnSaveAffectedFileListSingleProject[] = response.body;
		const affectedFiles: AffectedFile[] = flattenProjectsFileList(projects);

		if (batch) {
			batch.addAffectedFiles(affectedFiles);
			batch.notifyAffectedFilesCalculated(document);
		}

		for (const file of affectedFiles) {
			this.emitFile(file, batch);
		}
	}

	private async emitFile(file: AffectedFile, batch: CompileOnSaveMultipleFileBatcher | undefined) {
		if (batch && !batch.shouldRequestEmitForAffectedFile(file)) {
			return;
		}

		const emitArgs: protocol.CompileOnSaveEmitFileRequestArgs = {
			file: file.filename,
			projectFileName: file.projectFileName
		};

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

	private pruneBatchIfSavesComplete(batch: CompileOnSaveMultipleFileBatcher) {
		if (batch.savesComplete && this.batches.includes(batch)) {
			this.batches = this.batches.filter(b => b !== batch);
			// console.log(`Batch #${batch.id} complete: ${batch.elapsed}ms`);

			this.pruneExpiredBatches();
		}
	}

	private pruneExpiredBatches() {
		if (this.batches.length > 0) {
			const [expiredBatches, activeBatches] = partition(this.batches, batch => batch.expired);
			this.batches = activeBatches;
			expiredBatches.forEach(batch => batch.notifyExpired());
		}
	}

	private getBatchForDocument(document: TextDocument): CompileOnSaveMultipleFileBatcher | undefined {
		for (const batch of this.openBatches) {
			if (batch.containsPendingDocumentSave(document)) {
				return batch;
			}
		}

		return undefined;
	}
}

class CompileOnSaveEnabledCache {
	private client: ITypescriptServiceClient;
	private enabledPerFile: Map<string, boolean>;
	private enabledPerConfig: Map<string, boolean>;

	constructor(client: ITypescriptServiceClient) {
		this.client = client;
		this.clear();
	}

	public clear() {
		this.enabledPerFile = new Map();
		this.enabledPerConfig = new Map();
	}

	public async isEnabledForFile(file: string): Promise<boolean> {
		return await this.getStatusForFile(file) === true;
	}

	private async getStatusForFile(file: string): Promise<boolean> {
		let enabled: boolean | undefined = this.enabledPerFile.get(file);

		if (enabled !== undefined) {
			return enabled;
		} else {
			try {
				const eventualProjectInfo = await this.client.execute('projectInfo', { file: file, needFileNameList: false });
				const projectInfo = eventualProjectInfo.body;

				if (projectInfo) {
					const configFileName = projectInfo.configFileName;
					console.log("projectInfo returned: " + projectInfo.configFileName);

					enabled = this.enabledPerConfig.get(configFileName);
					if (enabled !== undefined) {
						this.enabledPerFile.set(file, enabled);
						return enabled;
					}

					enabled = this.readConfigFileCompileOnSaveOption(configFileName);
					if (enabled !== undefined) {
						this.enabledPerFile.set(file, enabled);
						this.enabledPerConfig.set(configFileName, enabled);
						return enabled;
					}
				}

				return false;
			}
			catch (e) {
				console.error("getStatusForFile", e);
				return false;
			}
		}
	}

	private readConfigFileCompileOnSaveOption(configFileName: string): boolean | undefined {
		try {
			const tsconfig = JSON.parse(fs.readFileSync(configFileName, 'utf8'));
			return tsconfig.compileOnSave || false;
		}
		catch (e) {
			return undefined;
		}
	}
}

class CompileOnSaveMultipleFileBatcher {
	public readonly id: number;
	private compileStatusBarItem: StatusBarItem | null;

	private creationTimestamp: number;
	private firstDidSaveTimestamp: number;
	private pendingSavesEmitted: boolean;
	private pendingSaves: Map<string, PendingFileStatus>;
	private pendingSavesDescription: string;
	private affectedFilesStatusMap: Map<string, AffectedFileStatus>;
	private affectedFilesRemainingEmitCount: number;
	private allPendingSavesCompleted: boolean;
	private allAffectedFilesCalculated: boolean;
	private receivedDidSavesNotifications: boolean;

	/** Batch is open for more pending saves */
	public get open(): boolean { return this.elapsed < BATCH_ISOLATION_TIME; }

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
		this.pendingSaves = new Map();
		this.affectedFilesStatusMap = new Map();
		this.allPendingSavesCompleted = false;
		this.allAffectedFilesCalculated = false;
		this.receivedDidSavesNotifications = false;
		this.affectedFilesRemainingEmitCount = 0;
	}

	public addPendingSave(document: TextDocument) {
		if (this.receivedDidSavesNotifications) {
			console.error('Can\'t add pending save to batch that has received didSave notifications.');
		}
		else {
			this.pendingSaves.set(document.fileName, { didSave: false, affectedFilesCalculated: false });
		}
	}

	public containsPendingDocumentSave(document: TextDocument): boolean {
		return this.pendingSaves.has(document.fileName);
	}

	private updateStatusBarMessage(message: string, duration?: number) {
		if (!this.compileStatusBarItem) {
			this.compileStatusBarItem = window.createStatusBarItem(StatusBarAlignment.Left);
		}

		if (duration) {
			this.compileStatusBarItem.text = message;
			setTimeout(() => this.dismissStatusBarMessage(), duration);
			this.compileStatusBarItem.show();
		}
		else {
			this.compileStatusBarItem.text = message;
			this.compileStatusBarItem.show();
		}
	}

	private dismissStatusBarMessage() {
		if (this.compileStatusBarItem) {
			this.compileStatusBarItem.dispose();
			this.compileStatusBarItem = null;
		}
	}

	private haveAllPendingsBeenSaved(): boolean {
		return Array.from(this.pendingSaves.values()).every(save => save.didSave);
	}

	private haveAllPendingsHadFilesCalculated(): boolean {
		return Array.from(this.pendingSaves.values()).every(save => save.affectedFilesCalculated);
	}

	public notifyDocumentDidSave(document: TextDocument) {
		const pendingSave = this.pendingSaves.get(document.fileName);
		if (!pendingSave) {
			return;
		}

		this.receivedDidSavesNotifications = true; // once we've received a "did-save" no more pending saves can be added
		if (!this.firstDidSaveTimestamp) {
			this.firstDidSaveTimestamp = Date.now();
			this.updateStatusBarMessage(`$(zap) Compiling ts`);
		}

		pendingSave.didSave = true;

		if (this.haveAllPendingsBeenSaved()) {
			this.allPendingSavesCompleted = true;
		}
	}

	public addAffectedFiles(affectedFiles: AffectedFile[]) {
		const affectedFilesMap = this.affectedFilesStatusMap || new Map<string, AffectedFileStatus>();
		let newFiles = 0;
		for (const file of affectedFiles) {
			if (!affectedFilesMap.has(file.key)) {
				affectedFilesMap.set(file.key, { requested: false, emmitted: false });
				newFiles++;
			}
		}
		this.affectedFilesStatusMap = affectedFilesMap;
		this.affectedFilesRemainingEmitCount += newFiles;
	}

	public notifyAffectedFilesCalculated(document: TextDocument) {
		const pendingSave = this.pendingSaves.get(document.fileName);
		if (!pendingSave) {
			return;
		}

		pendingSave.affectedFilesCalculated = true;

		if (this.haveAllPendingsHadFilesCalculated()) {
			this.allAffectedFilesCalculated = true;
			const numPendings = this.pendingSaves.size;
			if (numPendings === 1) {
				const filename = this.pendingSaves.keys().next().value!;
				this.pendingSavesDescription = path.basename(filename);
			}
			else {
				this.pendingSavesDescription = `${numPendings} saved documents`;
			}

			// potentially all saves results in no files changed?			
			if (this.affectedFilesRemainingEmitCount === 0) {
				this.dispose();
			}
		}
	}

	public shouldRequestEmitForAffectedFile(file: AffectedFile): boolean {
		const affectedFileStatus = this.affectedFilesStatusMap.get(file.key);
		if (!affectedFileStatus) {
			console.warn(`shouldRequestEmitForAffectedFile called for unknown AffectedFile ${file.key}`);
			return false;
		}

		if (affectedFileStatus.requested) {
			console.log(`Already emitted: ${file}`);
			return false;
		}

		affectedFileStatus.requested = true;
		return true;
	}

	public notifyEmitComplete(file: AffectedFile) {
		const affectedFile = this.affectedFilesStatusMap.get(file.key);
		if (!affectedFile) {
			console.warn(`notifyEmitComplete called for unknown hash '${file.key}'`);
			return;
		}

		if (affectedFile.emmitted) {
			console.warn(`notifyEmitComplete called for already-emmitted file '${file.key}'`);
			return;
		}

		affectedFile.emmitted = true;
		this.affectedFilesRemainingEmitCount--;

		if (this.affectedFilesRemainingEmitCount === 0 && this.allPendingSavesCompleted) {
			const elapsed = Date.now() - this.firstDidSaveTimestamp;
			this.updateStatusBarMessage(`$(check) Compiled in ${elapsed} ms`, COMPILED_MESSAGE_DURATION);
		} else {
			if (this.pendingSavesEmitted || this.allPendingSavesCompleted) {
				this.pendingSavesEmitted = true;
				this.updateStatusBarMessage(`$(checklist) Compiled ${this.pendingSavesDescription}. ${this.affectedFilesRemainingEmitCount} affected files remaining...`);
			}
		}
	}

	public notifyExpired() {
		this.dismissStatusBarMessage();
	}

	public dispose() {
		this.dismissStatusBarMessage();
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

interface PendingFileStatus {
	didSave: boolean;
	affectedFilesCalculated: boolean;
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

function flattenProjectsFileList(this: void, projects: protocol.CompileOnSaveAffectedFileListSingleProject[]) {
	const fileList: AffectedFile[] = [];
	for (const project of projects) {
		for (const filename of project.fileNames) {
			fileList.push({
				key: hashAffectedFile(filename, project.projectFileName),
				projectFileName: project.projectFileName,
				filename: filename
			});
		}
	}
	return fileList;
}

const hashAffectedFile = (filename: string, projectFileName: string): string => `${projectFileName || ''}|${filename}`;
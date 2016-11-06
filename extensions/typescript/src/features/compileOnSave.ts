/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { TextDocument } from 'vscode';

import * as Proto from '../protocol';
import { ITypescriptServiceClient } from '../typescriptService';

let nextBatchId: number = 0;

/** Maximum time allowed between receiving willSaves and didSave notifications for a batch */
const BATCH_ISOLATION_TIME = 2000;
const BATCH_EXPIRY_TIME = 15000;

export default class TypeScriptCompileOnSave {
	private client: ITypescriptServiceClient;
	private modeIds: Map<boolean>;
	private activeBatches: CompileOnSaveMultipleFileBatcher[];

	public tokens: string[] = [];

	constructor(client: ITypescriptServiceClient, modeIds: string[]) {
		this.client = client;
		this.modeIds = Object.create(null);
		this.activeBatches = [];
		modeIds.forEach(modeId => this.modeIds[modeId] = true);
	}

	public willSaveTextDocument(document: TextDocument) {
		if (!document || !(document.languageId in this.modeIds)) {
			return;
		}

		console.log(`Will save: ${document.fileName}`);

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
	}

	public didSaveTextDocument(document: TextDocument) {
		console.log(`Did save: ${document.fileName}`);

		if (!document || !(document.languageId in this.modeIds)) {
			return;
		}

		let batch = this.getBatchForDocument(document);
		if (batch) {
			batch.notifyDocumentDidSave(document);
			this.pruneBatchIfComplete(batch);
		}
		// else { no batch... expired? }

		const affectedFileArgs: Proto.CompileOnSaveEmitFileRequestArgs = {
			file: document.fileName,
			forced: false
		};

		this.client.execute('compileOnSaveAffectedFileList', affectedFileArgs).then(response => {

			const { body } = response;
			for (let project of body) {
				for (let file of project.fileNames) {
					let emit: boolean = true;
					if (batch) {
						emit = batch.shouldEmitAffectedFile(file);
					}
					// else { no batch... emit everything }

					if (emit) {
						const emitArgs: Proto.CompileOnSaveEmitFileRequestArgs = { file };
						this.client.execute('compileOnSaveEmitFile', emitArgs).then(emitResponse => {
							console.log('Emit done');
						});
					}
				}
			}
		});
	}

	private pruneBatchIfComplete(batch: CompileOnSaveMultipleFileBatcher) {
		if (batch.complete && this.activeBatches.indexOf(batch) >= 0) {
			this.activeBatches = this.activeBatches.filter(b => b !== batch);
			console.log(`Batch #${batch.id} complete: ${batch.elapsed}ms`);

			this.pruneExpiredBatches();
		}
	}

	private pruneExpiredBatches() {
		if (this.activeBatches.length > 0) {
			let expiredBatches = this.activeBatches.filter(batch => batch.expired);
			this.activeBatches = this.activeBatches.filter(batch => expiredBatches.indexOf(batch) === -1);

			for (let expiredBatch of expiredBatches) {
				console.log(`Pruned batch #${expiredBatch.id}: Elapsed = ${expiredBatch.elapsed}ms`);
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

class CompileOnSaveMultipleFileBatcher {
	public readonly id: number;
	private startTimestamp: number;
	private pendingSavedDocuments: Map<boolean>;
	private emittedFilesHash: Map<boolean>;
	private allPendingSavesCompleted: boolean;
	private receivedDidSavesNotifications: boolean;

	constructor(id: number) {
		this.id = id;
		this.startTimestamp = Date.now();
		this.pendingSavedDocuments = Object.create(null);
		this.emittedFilesHash = Object.create(null);
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

	public notifyDocumentDidSave(document: TextDocument) {
		this.receivedDidSavesNotifications = true; // once we've received a "did-save" no more pending saves can be added

		delete this.pendingSavedDocuments[document.fileName];
		if (Object.keys(this.pendingSavedDocuments).length === 0) {
			this.allPendingSavesCompleted = true;
		}
	}

	public shouldEmitAffectedFile(file: string): boolean {
		if (file in this.emittedFilesHash) {
			console.log(`Already emitted: ${file}`);
			return false;
		}

		this.emittedFilesHash[file] = true;
		return true;
	}

	/** Batch is open for more pending saves, i.e. Save All (i.e. hasn't received any didSave notifications yet) */
	public get open(): boolean {
		return !this.receivedDidSavesNotifications && this.elapsed < BATCH_ISOLATION_TIME;
	}

	/** All pending saves for this batch have completed */
	public get complete(): boolean {
		return this.allPendingSavesCompleted;
	}

	/** Elapsed time since this batch was created */
	public get elapsed(): number {
		return Date.now() - this.startTimestamp;
	}

	public get expired(): boolean {
		return this.elapsed > BATCH_EXPIRY_TIME;
	}
}
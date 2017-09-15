/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// This is the place for API experiments and proposal.

declare module 'vscode' {

	export interface OpenDialogOptions {
		defaultResource?: Uri;
		openLabel?: string;
		openFiles?: boolean;
		openFolders?: boolean;
		openMany?: boolean;
	}

	export interface SaveDialogOptions {
		defaultResource?: Uri;
		saveLabel?: string;
	}

	export namespace window {
		export function showOpenDialog(options: OpenDialogOptions): Thenable<Uri[]>;
		export function showSaveDialog(options: SaveDialogOptions): Thenable<Uri>;
	}

	// todo@joh discover files etc
	export interface FileSystemProvider {
		// todo@joh -> added, deleted, renamed, changed
		onDidChange: Event<Uri>;

		resolveContents(resource: Uri): string | Thenable<string>;
		writeContents(resource: Uri, contents: string): void | Thenable<void>;

		// -- search
		// todo@joh - extract into its own provider?
		findFiles(query: string, progress: Progress<Uri>, token?: CancellationToken): Thenable<void>;
	}

	export namespace workspace {
		export function registerFileSystemProvider(authority: string, provider: FileSystemProvider): Disposable;
	}

	export namespace window {

		export function sampleFunction(): Thenable<any>;
	}

	/**
	 * The contiguous set of modified lines in a diff.
	 */
	export interface LineChange {
		readonly originalStartLineNumber: number;
		readonly originalEndLineNumber: number;
		readonly modifiedStartLineNumber: number;
		readonly modifiedEndLineNumber: number;
	}

	export namespace commands {

		/**
		 * Registers a diff information command that can be invoked via a keyboard shortcut,
		 * a menu item, an action, or directly.
		 *
		 * Diff information commands are different from ordinary [commands](#commands.registerCommand) as
		 * they only execute when there is an active diff editor when the command is called, and the diff
		 * information has been computed. Also, the command handler of an editor command has access to
		 * the diff information.
		 *
		 * @param command A unique identifier for the command.
		 * @param callback A command handler function with access to the [diff information](#LineChange).
		 * @param thisArg The `this` context used when invoking the handler function.
		 * @return Disposable which unregisters this command on disposal.
		 */
		export function registerDiffInformationCommand(command: string, callback: (diff: LineChange[], ...args: any[]) => any, thisArg?: any): Disposable;
	}

	/**
	 * Represents a color in RGBA space.
	 */
	export class Color {

		/**
		 * The red component of this color in the range [0-1].
		 */
		readonly red: number;

		/**
		 * The green component of this color in the range [0-1].
		 */
		readonly green: number;

		/**
		 * The blue component of this color in the range [0-1].
		 */
		readonly blue: number;

		/**
		 * The alpha component of this color in the range [0-1].
		 */
		readonly alpha: number;

		constructor(red: number, green: number, blue: number, alpha: number);
	}

	/**
	 * Represents a color format
	 */
	export enum ColorFormat {
		RGB = 0,
		HEX = 1,
		HSL = 2
	}

	/**
	 * Represents a color range from a document.
	 */
	export class ColorRange {

		/**
		 * The range in the document where this color appers.
		 */
		range: Range;

		/**
		 * The actual color value for this color range.
		 */
		color: Color;

		/**
		 * Creates a new color range.
		 *
		 * @param range The range the color appears in. Must not be empty.
		 * @param color The value of the color.
		 * @param format The format in which this color is currently formatted.
		 */
		constructor(range: Range, color: Color);
	}

	/**
	 * The document color provider defines the contract between extensions and feature of
	 * picking and modifying colors in the editor.
	 */
	export interface DocumentColorProvider {
		/**
		 * Provide colors for the given document.
		 *
		 * @param document The document in which the command was invoked.
		 * @param token A cancellation token.
		 * @return An array of [color ranges](#ColorRange) or a thenable that resolves to such. The lack of a result
		 * can be signaled by returning `undefined`, `null`, or an empty array.
		 */
		provideDocumentColors(document: TextDocument, token: CancellationToken): ProviderResult<ColorRange[]>;
		/**
		 * Provide the string representation for a color.
		 */
		resolveDocumentColor(color: Color, colorFormat: ColorFormat): ProviderResult<string>;
	}

	export namespace languages {
		export function registerColorProvider(selector: DocumentSelector, provider: DocumentColorProvider): Disposable;
	}
}

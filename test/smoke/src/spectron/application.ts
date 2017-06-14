/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Application } from 'spectron';
import { SpectronClient } from './client';
import { Screenshot } from "../helpers/screenshot";
var fs = require('fs');
var path = require('path');

export const LATEST_PATH = process.env.VSCODE_LATEST_PATH;
export const STABLE_PATH = process.env.VSCODE_STABLE_PATH;
export const WORKSPACE_PATH = process.env.SMOKETEST_REPO;
export const USER_DIR = 'test_data/temp_user_dir';
export const EXTENSIONS_DIR = 'test_data/temp_extensions_dir';

/**
 * Wraps Spectron's Application instance with its used methods.
 */
export class SpectronApplication {
	public client: SpectronClient;

	private spectron: Application;
	private readonly pollTrials = 5;
	private readonly pollTimeout = 3; // in secs
	private keybindings: any[];
	private screenshot: Screenshot;

	constructor(electronPath: string, testName: string, private testRetry: number, args?: string[], chromeDriverArgs?: string[]) {
		if (!args) {
			args = [];
		}

		this.spectron = new Application({
			path: electronPath,
			args: args.concat(['--skip-getting-started']), // prevent 'Getting Started' web page from opening on clean user-data-dir
			chromeDriverArgs: chromeDriverArgs
		});
		this.screenshot = new Screenshot(this, testName);
		this.client = new SpectronClient(this.spectron, this.screenshot);
		this.testRetry += 1; // avoid multiplication by 0 for wait times
		this.retrieveKeybindings();
	}

	public get app(): Application {
		return this.spectron;
	}

	public async start(): Promise<any> {
		try {
			await this.spectron.start();
			await this.focusOnWindow(1); // focuses on main renderer window
			return this.checkWindowReady();
		} catch (err) {
			throw err;
		}
	}

	public async stop(): Promise<any> {
		if (this.spectron && this.spectron.isRunning()) {
			return await this.spectron.stop();
		}
	}

	public waitFor(func: (...args: any[]) => any, args: any): Promise<any> {
		return this.callClientAPI(func, args, 0);
	}

	public wait(): Promise<any> {
		return new Promise(resolve => setTimeout(resolve, this.testRetry * this.pollTimeout * 1000));
	}

	public focusOnWindow(index: number): Promise<any> {
		return this.client.windowByIndex(index);
	}

	private checkWindowReady(): Promise<any> {
		return this.waitFor(this.spectron.client.getHTML, '[id="workbench.main.container"]');
	}

	private retrieveKeybindings() {
		fs.readFile(path.join(process.cwd(), `test_data/keybindings.json`), 'utf8', (err, data) => {
			if (err) {
				throw err;
			}
			try {
				this.keybindings = JSON.parse(data);
			} catch (e) {
				throw new Error(`Error parsing keybindings JSON: ${e}`);
			}
		});
	}

	private callClientAPI(func: (...args: any[]) => Promise<any>, args: any, trial: number): Promise<any> {
		if (trial > this.pollTrials) {
			return Promise.reject(`Could not retrieve the element in ${this.testRetry * this.pollTrials * this.pollTimeout} seconds.`);
		}

		return new Promise(async (res, rej) => {
			let resolved = false, capture = false;

			const tryCall = async (resolve: any, reject: any): Promise<any> => {
				await this.wait();
				try {
					const result = await this.callClientAPI(func, args, ++trial);
					res(result);
				} catch (error) {
					rej(error);
				}
			}

			try {
				const result = await func.call(this.client, args, capture);
				if (!resolved && result === '') {
					resolved = true;
					await tryCall(res, rej);
				} else if (!resolved) {
					resolved = true;
					await this.screenshot.capture();
					res(result);
				}
			} catch (e) {
				if (!resolved) {
					resolved = true;
					await tryCall(res, rej);
				}
			}
		});
	}

	/**
	 * Retrieves the command from keybindings file and executes it with WebdriverIO client API
	 * @param command command (e.g. 'workbench.action.files.newUntitledFile')
	 */
	public command(command: string, capture?: boolean): Promise<any> {
		const binding = this.keybindings.find(x => x['command'] === command);
		const keys: string = binding.key;
		let keysToPress: string[] = [];

		const chords = keys.split(' ');
		chords.forEach((chord) => {
			const keys = chord.split('+');
			keys.forEach((key) => keysToPress.push(this.transliterate(key)));
			keysToPress.push('NULL');
		});

		return this.client.keys(keysToPress, capture);
	}

	/**
	 * Transliterates key names from keybindings file to WebdriverIO keyboard actions defined in:
	 * https://w3c.github.io/webdriver/webdriver-spec.html#keyboard-actions
	 */
	private transliterate(key: string): string {
		switch (key) {
			case 'ctrl':
				return 'Control';
			case 'cmd':
				return 'Meta';
			default:
				return key.length === 1 ? key : key.charAt(0).toUpperCase() + key.slice(1);
		};
	}
}

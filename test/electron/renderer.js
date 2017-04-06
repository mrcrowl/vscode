/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*eslint-env mocha*/

const { ipcRenderer } = require('electron');
const assert = require('assert');
const glob = require('glob');
const path = require('path');
const loader = require('../../src/vs/loader');
const cwd = path.join(__dirname, '../../out');

loader.require.config({
	baseUrl: cwd,
	catchError: true,
	nodeRequire: require,
	nodeMain: __filename
});

function loadTestModules(opts) {

	if (opts.run) {
		const files = Array.isArray(opts.run) ? opts.run : [opts.run];
		const modules = files.map(file => {
			return path.relative(cwd, file).replace(/\.js$/, '');
		});
		return new Promise((resolve, reject) => {
			loader.require(modules, resolve, reject);
		});
	}

	return new Promise((resolve, reject) => {
		glob('**/test/**/*.test.js', { cwd }, (err, files) => {
			if (err) {
				reject(err);
				return;
			}
			const modules = files.map(file => file.replace(/\.js$/, ''));
			resolve(modules);
		});
	}).then(modules => {
		return new Promise((resolve, reject) => {
			loader.require(modules, resolve, reject);
		});
	});
}

function loadTests(opts) {

	const _unexpectedErrors = [];
	const _loaderErrors = [];

	// collect loader errors
	loader.require.config({
		onError(err) {
			_loaderErrors.push(err);
			console.error(err);
		}
	});

	// collect unexpected errors
	loader.require(['vs/base/common/errors'], function (errors) {
		errors.setUnexpectedErrorHandler(function (err) {
			try {
				throw new Error('oops');
			} catch (e) {
				_unexpectedErrors.push((err && err.message ? err.message : err) + '\n' + e.stack);
			}
		});
	});

	return loadTestModules(opts).then(() => {
		suite('Unexpected Errors & Loader Errors', function () {
			test('should not have unexpected errors', function () {
				const errors = _unexpectedErrors.concat(_loaderErrors);
				if (errors.length) {
					errors.forEach(function (stack) {
						console.error('');
						console.error(stack);
					});
					assert.ok(false);
				}
			});
		});
	});
}

function runTests(opts) {

	return loadTests(opts).then(() => {

		if (opts.grep) {
			mocha.grep(opts.grep);
		}

		const runner = mocha.run(() => {
			ipcRenderer.send('done');
		});

		runner.on('fail', function (test) {
			ipcRenderer.send('fail', {
				title: test.fullTitle(),
				stack: test.err.stack
			});
			console.error(test.fullTitle());
			console.error(test.err.stack);
		});

		runner.on('pass', function () {
			ipcRenderer.send('pass');
		});
	});
}

ipcRenderer.on('run', (e, opts) => {
	runTests(opts).catch(err => console.error(err));
});

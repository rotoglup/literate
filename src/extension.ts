// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { rmdir, writeFile } from 'fs';
import StateCore = require('markdown-it/lib/rules_core/state_core');
import Token = require('markdown-it/lib/token');
import { TextDecoder, TextEncoder } from 'util';
import * as vscode from 'vscode';
import { posix } from 'path';

import { grabber_plugin } from './grabber';
import { pathToFileURL } from 'url';

import MarkdownIt = require("markdown-it");
import Renderer = require('markdown-it/lib/renderer');


/**
 * Interface for environment to hold the Markdown file name and the StateCore
 * grabbed by the grabber_plugin.
 * The gstate we use to access all the tokens generated by the MarkdownIt parser.
 *
 * @see StateCore
 */
interface GrabbedState {
	/**
	 * File name of the Markdown document to which the state belongs.
	 */
	filename: string;
	/**
	 * Uri for the Markdown document.
	 */
	uri: vscode.Uri;
	/**
	 * State grabbed from the MarkdownIt parser.
	 */
	gstate: StateCore;
}

let FRAGMENT_RE = /(.*):.*<<(.*)>>(=)?(\+)?/;
let FRAGMENTS_RE = /<<(.*)>>(=)?(\+)?/g;
let FRAGMENT_IN_CODE = /(&lt;&lt.*?&gt;&gt;)/g;
let CLEAN_FRAGMENT_IN_CODE = /(&lt;&lt.*?&gt;&gt;)/g;
let oldFence : Renderer.RenderRule | undefined;

export function activate(context: vscode.ExtensionContext) {
	console.log('Ready to do some Literate Programming');
	const diagnostics = vscode.languages.createDiagnosticCollection('literate');
	setupLanguageMapping();

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	let disposable = vscode.commands.registerCommand('literate.process', async function () {
		/**
		 * MarkdownIt instance with grabber_plugin in use.
		 */
		const md = new MarkdownIt()
			.use(grabber_plugin);

		oldFence = md.renderer.rules.fence;
		md.renderer.rules.fence = renderCodeFence;

		diagnostics.clear();

		if (!vscode.workspace.workspaceFolders) {
			return vscode.window.showInformationMessage("No workspace or folder opened");
		}

		/**
		 * Contains environments for each Markup document parsed and rendered.
		 */
		const envList: Array<GrabbedState> = new Array<GrabbedState>();
		/**
		 * The URI for the workspace folder that will be searched for .literate
		 * files to generate code and documentation for.
		 */
		const folderUri = vscode.workspace.workspaceFolders[0].uri;
		/** The Uri for the parent path where generated code is saved. */
		const sourceUri = vscode.Uri.joinPath(folderUri, "src");

		// ensure the path exists.
		vscode.workspace.fs.createDirectory(sourceUri);

		/** All .literate files found in our workspace */
		const foundLiterateFiles = await vscode.workspace
			.findFiles('**/*.literate', undefined, undefined)
			.then(files => Promise.all(files.map(file => file)));

		// handle all .literate file, extract code and write out.
		for (let fl of foundLiterateFiles) {
			const uri = vscode.Uri.file(fl.path);
			const content = await vscode.workspace.fs.readFile(uri );
			let fname = fl.path.replace(folderUri.path, '');
			/** Environment where we can grab the state. */
			const env: GrabbedState = { filename: fname, uri: uri, gstate: new StateCore('', md, {}) };
			const text = new TextDecoder('utf-8').decode(content);
			envList.push(env);
			const _ = md.render(text, env);
		}

		/**
		 * Map of fragment names and tuples of code fragments for these. The
		 * tuples contain code language identifier followed by the actual code
		 * fragment.
		 */
		const fragments = new Map<string, [string, string]>();
		// Now we have the state, we have access to the tokens
		// over which we can iterate to extract all the code
		// fragments and build up the table with the fragments concatenated
		// where necessary. We'll extrapolate all fragments in the second
		// pass.
		for (let env of envList) {
			for (let token of env.gstate.tokens) {
				if (token.type === 'fence') {
					const linenumber = locationOfFragment(token);
					const match = token.info.match(FRAGMENT_RE);
					if (match) {
						let [_, lang, name, root, add, ...__] = match;
						lang = lang.trim();
						// =+ in the fragment name, we're adding to an existing fragment
						if (root && add) {
							if (fragments.has(name)) {
								let code = fragments.get(name);
								if(code) {
									let additionalCode = decorateCodeWithLine(token, env);
									code[1] = `${code[1]}\n${additionalCode}`;
								}
							} else {
								let msg = `Trying to add to non-existant fragment ${name}. ${env.filename}:${linenumber}`;
								const diag = createErrorDiagnostic(token, msg);
								updateDiagnostics(env.uri, diagnostics, diag);
								return vscode.window.showErrorMessage(msg);
							}
						} else if (root && !add) {
							if (fragments.has(name)) {
								let msg = `Trying to overwrite existing fragment fragment ${name}. ${env.filename}${linenumber}`;
								const diag = createErrorDiagnostic(token, msg);
								updateDiagnostics(env.uri, diagnostics, diag);
								return vscode.window.showErrorMessage(msg);
							}
							let code = decorateCodeWithLine(token, env);
							fragments.set(name, [lang, code]);
						}
					}
				}
			}
		}

		// for now do several passes
		let pass: number = 0;
		do {
			pass++;
			let fragmentReplaced = false;
			for (let fragmentName of fragments.keys()) {
				let fragment = fragments.get(fragmentName);
				if (!fragment) {
					continue;
				}
				let lang = fragment[0];
				let codeFromFragment = fragment[1];

				const casesToReplace = [...codeFromFragment.matchAll(FRAGMENTS_RE)];
				for (let match of casesToReplace) {
					let [tag, tagName, root, add, ...rest] = match;
					if (root || add) {
						console.log(`incorrect fragment tag in fragment: ${tag}`);
					}
					if (!fragments.has(tagName)) {
						console.log(`could not find fragment ${tag} (${tagName})`);
					}
					let code = fragments.get(tagName);
					if (code) {
						fragmentReplaced = true;
						codeFromFragment = codeFromFragment.replace(tag, code[1]);
					}
					fragments.set(fragmentName, [lang, codeFromFragment]);
				}
			}
			if(!fragmentReplaced) {
				break;
			}
		}
		while (pass < 25);

		for(const name of fragments.keys()) {
			if (name.indexOf(".*") >= 0) {
				let fragment = fragments.get(name);
				if (fragment) {
					const extension = extensionForLanguage(fragment[0].trim());
					const fileName = name.replace(".*", "").trim() + `.${extension}`;
					const encoded = Buffer.from(fragment[1], 'utf-8');
					const fileUri = folderUri.with({ path: posix.join(sourceUri.path, fileName) });
					await vscode.workspace.fs.writeFile(fileUri, encoded);
				}
			}
		}

		// Display a message box to the user
		return vscode.window.showInformationMessage("Code generated");
	});

	if (vscode.window.activeTextEditor) {
		updateDiagnostics(vscode.window.activeTextEditor.document.uri, diagnostics, undefined);
	}
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
		if (editor) {
			updateDiagnostics(editor.document.uri, diagnostics, undefined);
		}
	}))
	context.subscriptions.push(disposable);

	return {
		extendMarkdownIt(md: any) {
			md.use(grabber_plugin);
			oldFence = md.renderer.rules.fence;
			md.renderer.rules.fence = renderCodeFence;
			return md;
		}
	};
};

function codeFragmentCleanup(_: string, p1 : string, __: number, ___: string) {
	let cleaned = p1.replaceAll(/<.*?>/g, '');
	return `<span class="fragmentuse">${cleaned}</span>`;
}

function renderCodeFence(tokens : Token[], idx : number, options : MarkdownIt.Options, env : any, slf : Renderer) {
	let rendered = '';
	if (oldFence) {
		rendered = oldFence(tokens, idx, options, env, slf);

		let token = tokens[idx];
		if (token.info) {
			const match = token.info.match(FRAGMENT_RE);
			if (match) {
				let [_, lang, name, root, add, ...__] = match;
				lang = lang.trim();
				if (name) {
					root = root || '';
					add = add || '';
					rendered = `<div class="codefragment"><div class="fragmentname">&lt;&lt;${name}&gt;&gt;${root}${add}</div><div class="code">${rendered}</div></div>`;
					rendered = rendered.replaceAll(FRAGMENT_IN_CODE, codeFragmentCleanup);
				}
			}
		}
	}

	return rendered;
};

function updateDiagnostics(uri: vscode.Uri, collection: vscode.DiagnosticCollection, diagnostic : vscode.Diagnostic | undefined): void {
	if (uri) {
		if (diagnostic) {
			const diags = Array.from(collection.get(uri) || []);
			diags.push(diagnostic);
			collection.set(uri, diags);
		}
	} else {
		collection.clear();
	}
}

/**
 * Get from the token the code fragment, with a `#line linenmbr "file"\n` string
 * prepended.
 * @param token Token with code
 * @param env GrabbedState environment the token belongs to, for the filename
 */
function decorateCodeWithLine(token: Token, env: GrabbedState) : string {
	// line number we want is tag location plus one, since code starts on that
	// next line.
	/*
	let linenumber = locationOfFragment(token) + 1;
	let code = '';
	if (linenumber>=0) {
		code = `#line ${linenumber} "${env.filename}"`;
	}
	code = `${code}\n${token.content.trim()}`;
	*/
	return token.content.trim();
}

/**
 * Create diagnostic for a given token with message.
 * @param token Token that carries the faulty code fragment
 * @param message Error message
 */
function createErrorDiagnostic(token: Token, message: string) : vscode.Diagnostic {
	let range = fragmentRange(token);
	let diagnostic: vscode.Diagnostic = {
		severity: vscode.DiagnosticSeverity.Error,
		message: message,
		range: range
	};

	return diagnostic;

}

/**
 * Give the location of the line in the Markup document that contains the
 * tag declaration.
 * @param token Token to extract code location from
 */
function locationOfFragment(token: Token): number {
	let linenumber = token.map ? (token.map[0]) : -1;
	return linenumber;
}

/**
 * Give the location of the last line in the Markup document that contains the
 * code fragment.
 * @param token Token to extract code location from
 */
function locationOfFragmentEnd(token: Token): number {
	let linenumber = token.map ? (token.map[1] ) : -1;
	return linenumber;
}


/**
 * Give range for the code fragment, including tag.
 * @param token Token to create range for
 */
function fragmentRange(token: Token): vscode.Range {
	let startTagName = token.info.indexOf("<<") + 2;
	let endTagName = token.info.indexOf(">>") - 1;
	let start = new vscode.Position(locationOfFragment(token), startTagName);
	let end = new vscode.Position(locationOfFragmentEnd(token), endTagName);
	let range: vscode.Range = new vscode.Range(start, end);
	return range;
}

let languageMapping = new Map<string, string>();
function setupLanguageMapping() {
	languageMapping.set("csharp", "cs");
}

function extensionForLanguage(lang: string): string
{
	lang = lang.trim();
	if (lang.length <= 2) return lang;

	if (languageMapping.has(lang)) {
		let extension = languageMapping.get(lang);
		if (extension) {
			return extension;
		}
	}

	return 'xx';
}

// this method is called when your extension is deactivated
export function deactivate() {}

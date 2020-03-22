import * as path from 'path';
import { workspace, ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind,
	NotificationType
} from 'vscode-languageclient';

const DIAGNOSTICS_COLLECTION_NAME = 'GroovyLint';
let diagnosticsCollection: vscode.DiagnosticCollection;

let client: LanguageClient;
let statusBarItem: vscode.StatusBarItem;
let statusList: StatusParams[] = [];

interface StatusParams {
	id: number;
	state: string;
	documents: [
		{
			documentUri: string,
			updatedSource?: string
		}];
	lastFileName?: string
	lastLintTimeMs?: number
}
namespace StatusNotification {
	export const type = new NotificationType<StatusParams, void>('groovylint/status');
}

export function activate(context: ExtensionContext) {

	// Create diagnostics collection
	diagnosticsCollection = vscode.languages.createDiagnosticCollection(DIAGNOSTICS_COLLECTION_NAME);

	///////////////////////////////////////////////
	/////////////// Server + client ///////////////
	///////////////////////////////////////////////

	// The server is implemented in node
	let serverModule = context.asAbsolutePath(path.join('server', 'out', 'server.js'));
	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	let serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: {
				execArgv: ['--nolazy', '--inspect=6009'],
				env: { "DEBUG": "vscode-groovy-lint,npm-groovy-lint" }
			}
		}
	};
	// Options to control the language client
	let clientOptions: LanguageClientOptions = {
		// Register the server for groovy documents
		documentSelector: [{ scheme: 'file', language: 'groovy' }],
		diagnosticCollectionName: DIAGNOSTICS_COLLECTION_NAME,
		progressOnInitialization: true,
		synchronize: {
			// Notify the server about file changes to '.clientrc files contained in the workspace
			fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
		}
	};
	// Create the language client and start the client.
	client = new LanguageClient(
		'groovyLint',
		'Groovy Lint',
		serverOptions,
		clientOptions
	);


	// Manage status bar item (with loading icon)
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.text = 'GroovyLint $(clock~spin)';
	statusBarItem.show();

	client.registerProposedFeatures();

	// Start the client. This will also launch the server
	context.subscriptions.push(
		client.start(),
	);

	// Actions after client is ready
	client.onReady().then(() => {

		// Show status bar item to display & run groovy lint
		refreshStatusBar();

		// Manage status notifications
		client.onNotification(StatusNotification.type, async (status) => {
			await updateStatus(status);
		});

		// Open file in workspace when language server requests it
		client.onNotification("vscode-groovy-lint/openDocument", async (notifParams: any) => {
			const openPath = vscode.Uri.parse("file:///" + notifParams.file); //A request file path
			const doc = await vscode.workspace.openTextDocument(openPath);
			await vscode.window.showTextDocument(doc);
		});

	});
}

// Stop client when extension is deactivated
export function deactivate(): Thenable<void> {
	// Remove status bar
	if (statusBarItem) {
		statusBarItem.dispose();
	}
	return client.stop();
}

// Update status list
async function updateStatus(status: StatusParams): Promise<any> {
	// Start linting / fixing, or notify error
	if (['lint.start', 'lint.start.fix', 'lint.error'].includes(status.state)) {
		statusList.push(status);
		// Really open document, so tab will not be replaced by next preview
		for (const docDef of status.documents) {
			const docs = vscode.workspace.textDocuments.filter(txtDoc => txtDoc.uri.toString() === docDef.documentUri);
			if (docs && docs[0]) {
				await vscode.window.showTextDocument(docs[0], { preview: false });
			}
		}
	}
	// End linting/fixing: remove frrom status list, and remove previous errors on same file if necessary
	else if (status.state === 'lint.end') {
		statusList = statusList.filter(statusObj => statusObj.id !== status.id);
		statusList = statusList.filter(statusObj => !(statusObj.state === 'lint.error' && statusObj.lastFileName === status.lastFileName));
		// If document has been closed, to not display its diagnostics
		for (const docDef of status.documents) {
			const docs = vscode.workspace.textDocuments.filter(txtDoc => txtDoc.uri.toString() === docDef.documentUri);
			if (!(docs && docs[0])) {
				diagnosticsCollection.set(vscode.Uri.parse(docDef.documentUri), []);
			}
		}
	}
	// Show GroovyLint status bar as ready
	await refreshStatusBar();
}

// Update text editor & status bar
async function refreshStatusBar(): Promise<any> {

	// Fix running
	if (statusList.filter(status => status.state === 'lint.start.fix').length > 0) {
		statusBarItem.text = `GroovyLint $(debug-step-over~spin)`;
		statusBarItem.color = new vscode.ThemeColor('statusBar.debuggingForeground');
	}
	// Lint running
	else if (statusList.filter(status => status.state === 'lint.start').length > 0) {
		statusBarItem.text = 'GroovyLint $(sync~spin)';
		statusBarItem.color = new vscode.ThemeColor('statusBar.debuggingForeground');
	}
	// No lint running but pending error(s)
	else if (statusList.filter(status => status.state === 'lint.error').length > 0) {
		statusBarItem.text = 'GroovyLint $(error)';
		statusBarItem.color = new vscode.ThemeColor('errorForeground');
	}
	else {
		statusBarItem.text = 'GroovyLint $(zap)';
		statusBarItem.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
	}

	// Compute and display job statuses
	const tooltips = statusList.map((status) => {
		return (status.state === 'lint.start') ? 'Analyzing ' + status.lastFileName :
			(status.state === 'lint.start.fix') ? 'Fixing ' + status.lastFileName :
				(status.state === 'lint.start.error') ? 'Error while processing ' + status.lastFileName :
					'ERROR in GroovyLint: unknown status (plz contact developers if you see that';
	});
	statusBarItem.tooltip = tooltips.join('\n');

}
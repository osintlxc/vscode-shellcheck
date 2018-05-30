import { spawn } from 'child_process';
import * as vscode from 'vscode';
import * as wsl from './utils/wslSupport';

import { ThrottledDelayer } from './utils/async';


enum RunTrigger {
    onSave,
    onType
}

namespace RunTrigger {
    export const strings = {
        onSave: 'onSave',
        onType: 'onType'
    };

    export let from = function (value: string): RunTrigger {
        switch (value) {
            case strings.onSave:
                return RunTrigger.onSave;
            case strings.onType:
                return RunTrigger.onType;
        }
    };
}

interface ShellCheckItem {
    file: string;
    line: number;
    endLine: number | undefined;
    column: number;
    endColumn: number | undefined;
    level: string;
    code: number;
    message: string;
}

function escapeRegexp(s: string): string {
    // Shamelessly stolen from https://github.com/atom/underscore-plus/blob/130913c179fe1d718a14034f4818adaf8da4db12/src/underscore-plus.coffee#L138
    return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}

const NON_WORD_CHARACTERS = escapeRegexp('/\\()"\':,.;<>~!@#$%^&*|+=[]{}`?-…');
const WORD_REGEXP = new RegExp(`^[\t ]*$|[^\\s${NON_WORD_CHARACTERS}]+`);

function fixPosition(textDocument: vscode.TextDocument, pos: vscode.Position): vscode.Position {
    // Since json format treats tabs as **8** characters, we need to offset it.
    let charPos = pos.character;
    const s = textDocument.getText(new vscode.Range(pos.with({ character: 0 }), pos));
    for (const ch of s) {
        if (ch === '\t') {
            charPos -= 7;
        }
    }

    return pos.with({ character: charPos });
}

function asDiagnostic(textDocument: vscode.TextDocument, item: ShellCheckItem): vscode.Diagnostic {
    let startPos = new vscode.Position(item.line - 1, item.column - 1);
    const endLine = item.endLine ? item.endLine - 1 : startPos.line;
    const endCharacter = item.endColumn ? item.endColumn - 1 : startPos.character;
    let endPos = new vscode.Position(endLine, endCharacter);
    if (startPos.isEqual(endPos)) {
        startPos = fixPosition(textDocument, startPos);
        endPos = startPos;
    } else {
        startPos = fixPosition(textDocument, startPos);
        endPos = fixPosition(textDocument, endPos);
    }
    const range = new vscode.Range(startPos, endPos);

    const severity = asDiagnosticSeverity(item.level);
    const diagnostic = new vscode.Diagnostic(range, `${item.message} [SC${item.code}]`, severity);
    diagnostic.source = 'shellcheck';
    diagnostic.code = item.code;
    return diagnostic;
}

function asDiagnosticSeverity(level: string): vscode.DiagnosticSeverity {
    switch (level) {
        case 'error':
            return vscode.DiagnosticSeverity.Error;
        case 'style':
        /* falls through */
        case 'info':
            return vscode.DiagnosticSeverity.Information;
        case 'warning':
        /* falls through */
        default:
            return vscode.DiagnosticSeverity.Warning;
    }
}


export default class ShellCheckProvider {

    private static languageId = 'shellscript';
    private enabled: boolean;
    private trigger: RunTrigger;
    private executable: string;
    private executableNotFound: boolean;
    private exclude: string[];
    private customArgs: string[];
    private documentListener: vscode.Disposable;
    private diagnosticCollection: vscode.DiagnosticCollection;
    private delayers: { [key: string]: ThrottledDelayer<void> };
    private useWSL: boolean;

    constructor() {
        this.enabled = true;
        this.trigger = null;
        this.executable = null;
        this.executableNotFound = false;
        this.exclude = [];
        this.customArgs = [];
        this.useWSL = false;
    }

    public activate(subscriptions: vscode.Disposable[]): void {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection();
        subscriptions.push(this);

        vscode.workspace.onDidChangeConfiguration(this.loadConfiguration, this, subscriptions);
        this.loadConfiguration();

        vscode.workspace.onDidOpenTextDocument(this.triggerLint, this, subscriptions);
        vscode.workspace.onDidCloseTextDocument((textDocument) => {
            this.diagnosticCollection.delete(textDocument.uri);
            delete this.delayers[textDocument.uri.toString()];
        }, null, subscriptions);

        // Shellcheck all open shell documents
        vscode.workspace.textDocuments.forEach(this.triggerLint, this);
    }

    public dispose(): void {
        this.disposeDocumentListener();
        this.diagnosticCollection.clear();
        this.diagnosticCollection.dispose();
    }

    private disposeDocumentListener(): void {
        if (this.documentListener) {
            this.documentListener.dispose();
        }
    }

    private loadConfiguration(): void {
        const section = vscode.workspace.getConfiguration('shellcheck');
        if (section) {
            this.enabled = section.get('enable', true);
            this.trigger = RunTrigger.from(section.get('run', RunTrigger.strings.onType));
            this.executable = section.get('executablePath', 'shellcheck');
            this.exclude = section.get('exclude', []);
            this.customArgs = section.get('customArgs', []);
            this.useWSL = section.get('useWSL', false);
        }

        this.delayers = Object.create(null);

        this.disposeDocumentListener();
        this.diagnosticCollection.clear();
        if (this.enabled) {
            if (this.trigger === RunTrigger.onType) {
                this.documentListener = vscode.workspace.onDidChangeTextDocument((e) => {
                    this.triggerLint(e.document);
                });
            } else if (this.trigger === RunTrigger.onSave) {
                this.documentListener = vscode.workspace.onDidSaveTextDocument(this.triggerLint, this);
            }
        }

        // Configuration has changed. Re-evaluate all documents
        this.executableNotFound = false;
        vscode.workspace.textDocuments.forEach(this.triggerLint, this);
    }

    private isAllowedTextDocument(textDocument: vscode.TextDocument): boolean {
        if (textDocument.languageId !== ShellCheckProvider.languageId) {
            return false;
        }

        const scheme = textDocument.uri.scheme;
        return (scheme === 'file' || scheme === 'untitled');
    }

    private triggerLint(textDocument: vscode.TextDocument): void {
        if (this.executableNotFound || !this.isAllowedTextDocument(textDocument)) {
            return;
        }

        if (!this.enabled) {
            this.diagnosticCollection.delete(textDocument.uri);
            return;
        }

        const key = textDocument.uri.toString();
        let delayer = this.delayers[key];
        if (!delayer) {
            delayer = new ThrottledDelayer<void>(this.trigger === RunTrigger.onType ? 250 : 0);
            this.delayers[key] = delayer;
        }

        delayer.trigger(() => this.runLint(textDocument));
    }

    private runLint(textDocument: vscode.TextDocument): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (this.useWSL && !wsl.subsystemForLinuxPresent()) {
                if (!this.executableNotFound) {
                    vscode.window.showErrorMessage('Got told to use WSL, but cannot find installation. Bailing out.');
                }
                this.executableNotFound = true;
                resolve();
                return;
            }

            const executable = this.executable || 'shellcheck';
            const diagnostics: vscode.Diagnostic[] = [];
            let processShellCheckItem = (item: ShellCheckItem) => {
                if (item) {
                    diagnostics.push(asDiagnostic(textDocument, item));
                }
            };

            const options = vscode.workspace.rootPath ? { cwd: vscode.workspace.rootPath } : undefined;
            let args = ['-f', 'json'];

            if (this.exclude.length) {
                args = args.concat(['-e', this.exclude.join(',')]);
            }

            if (this.customArgs.length) {
                args = args.concat(this.customArgs);
            }

            args.push('-');

            const childProcess = wsl.spawn(this.useWSL, executable, args, options);
            childProcess.on('error', (error: Error) => {
                if (!this.executableNotFound) {
                    this.showError(error, executable);
                }

                this.executableNotFound = true;
                resolve();
                return;
            });

            if (childProcess.pid) {
                childProcess.stdout.setEncoding('utf-8');

                let script = textDocument.getText();
                if (this.useWSL) {
                    script = script.replace(/\r\n/g, '\n'); // shellcheck doesn't likes CRLF, although this is caused by a git checkout on Windows.
                }
                childProcess.stdin.write(script);
                childProcess.stdin.end();

                const output = [];
                childProcess.stdout
                    .on('data', (data: Buffer) => {
                        output.push(data.toString());
                    })
                    .on('end', () => {
                        if (output.length) {
                            JSON.parse(output.join('')).forEach(processShellCheckItem);
                        }

                        this.diagnosticCollection.set(textDocument.uri, diagnostics);
                        resolve();
                    });
            } else {
                resolve();
            }
        });
    }

    private showError(error: any, executable: string): void {
        let message: string = null;
        if (error.code === 'ENOENT') {
            message = `Cannot shellcheck the shell script. The shellcheck program was not found. Use the 'shellcheck.executablePath' setting to configure the location of 'shellcheck' or enable WSL integration with 'shellcheck.useWSL'`;
        } else {
            message = error.message ? error.message : `Failed to run shellcheck using path: ${executable}. Reason is unknown.`;
        }

        vscode.window.showInformationMessage(message);
    }
}

// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import '../../common/extensions';

import * as fs from 'fs-extra';
import { injectable, unmanaged } from 'inversify';
import * as os from 'os';
import * as path from 'path';
import * as uuid from 'uuid/v4';
import { ConfigurationTarget, Event, EventEmitter, Position, Range, Selection, TextEditor, Uri, ViewColumn } from 'vscode';
import { Disposable } from 'vscode-jsonrpc';
import * as vsls from 'vsls/vscode';

import {
    IApplicationShell,
    IDocumentManager,
    ILiveShareApi,
    IWebPanelProvider,
    IWorkspaceService
} from '../../common/application/types';
import { CancellationError } from '../../common/cancellation';
import { EXTENSION_ROOT_DIR, PYTHON_LANGUAGE } from '../../common/constants';
import { traceInfo, traceWarning } from '../../common/logger';
import { IFileSystem } from '../../common/platform/types';
import { IConfigurationService, IDisposableRegistry, ILogger } from '../../common/types';
import { createDeferred, Deferred } from '../../common/utils/async';
import * as localize from '../../common/utils/localize';
import { StopWatch } from '../../common/utils/stopWatch';
import { IInterpreterService, PythonInterpreter } from '../../interpreter/contracts';
import { captureTelemetry, sendTelemetryEvent } from '../../telemetry';
import { generateCellRanges } from '../cellFactory';
import { Identifiers, Telemetry } from '../constants';
import { ColumnWarningSize } from '../data-viewing/types';
import {
    IAddedSysInfo,
    ICopyCode,
    IGotoCode,
    IInteractiveWindowMapping,
    InteractiveWindowMessages,
    IRemoteAddCode,
    IShowDataViewer,
    ISubmitNewCell,
    SysInfoReason
} from '../interactive-common/interactiveWindowTypes';
import { JupyterInstallError } from '../jupyter/jupyterInstallError';
import { JupyterKernelPromiseFailedError } from '../jupyter/jupyterKernelPromiseFailedError';
import { JupyterSelfCertsError } from '../jupyter/jupyterSelfCertsError';
import { CssMessages } from '../messages';
import {
    CellState,
    ICell,
    ICodeCssGenerator,
    IConnection,
    IDataViewerProvider,
    IInteractiveBase,
    IInteractiveWindowInfo,
    IInteractiveWindowListener,
    IJupyterDebugger,
    IJupyterExecution,
    IJupyterVariable,
    IJupyterVariables,
    IJupyterVariablesResponse,
    IMessageCell,
    INotebookExporter,
    INotebookServer,
    INotebookServerOptions,
    InterruptResult,
    IStatusProvider,
    IThemeFinder
} from '../types';
import { WebViewHost } from '../webViewHost';
import { InteractiveWindowMessageListener } from './interactiveWindowMessageListener';

@injectable()
export abstract class InteractiveBase extends WebViewHost<IInteractiveWindowMapping> implements IInteractiveBase {
    private interpreterChangedDisposable: Disposable;
    private unfinishedCells: ICell[] = [];
    private restartingKernel: boolean = false;
    private potentiallyUnfinishedStatus: Disposable[] = [];
    private addSysInfoPromise: Deferred<boolean> | undefined;
    private waitingForExportCells: boolean = false;
    private jupyterServer: INotebookServer | undefined;
    private _id: string;
    private executeEvent: EventEmitter<string> = new EventEmitter<string>();
    private variableRequestStopWatch: StopWatch | undefined;
    private variableRequestPendingCount: number = 0;
    private loadPromise: Promise<void> | undefined;

    constructor(
        @unmanaged() private readonly listeners: IInteractiveWindowListener[],
        @unmanaged() private liveShare: ILiveShareApi,
        @unmanaged() protected applicationShell: IApplicationShell,
        @unmanaged() private documentManager: IDocumentManager,
        @unmanaged() private interpreterService: IInterpreterService,
        @unmanaged() provider: IWebPanelProvider,
        @unmanaged() private disposables: IDisposableRegistry,
        @unmanaged() cssGenerator: ICodeCssGenerator,
        @unmanaged() themeFinder: IThemeFinder,
        @unmanaged() private logger: ILogger,
        @unmanaged() private statusProvider: IStatusProvider,
        @unmanaged() private jupyterExecution: IJupyterExecution,
        @unmanaged() protected fileSystem: IFileSystem,
        @unmanaged() protected configuration: IConfigurationService,
        @unmanaged() private jupyterExporter: INotebookExporter,
        @unmanaged() workspaceService: IWorkspaceService,
        @unmanaged() private dataExplorerProvider: IDataViewerProvider,
        @unmanaged() private jupyterVariables: IJupyterVariables,
        @unmanaged() private jupyterDebugger: IJupyterDebugger,
        @unmanaged() indexPath: string,
        @unmanaged() title: string,
        @unmanaged() viewColumn: ViewColumn
    ) {
        super(
            configuration,
            provider,
            cssGenerator,
            themeFinder,
            workspaceService,
            (c, v, d) => new InteractiveWindowMessageListener(liveShare, c, v, d),
            indexPath,
            title,
            viewColumn);

        // Create our unique id. We use this to skip messages we send to other interactive windows
        this._id = uuid();

        // Sign up for configuration changes
        this.interpreterChangedDisposable = this.interpreterService.onDidChangeInterpreter(this.onInterpreterChanged);

        // Listen for active text editor changes. This is the only way we can tell that we might be needing to gain focus
        const handler = this.documentManager.onDidChangeActiveTextEditor(() => this.onViewStateChanged(this.viewState.visible, this.viewState.active).ignoreErrors());
        this.disposables.push(handler);

        // If our execution changes its liveshare session, we need to close our server
        this.jupyterExecution.sessionChanged(() => this.loadPromise = this.reloadAfterShutdown());

        // For each listener sign up for their post events
        this.listeners.forEach(l => l.postMessage((e) => this.postMessageInternal(e.message, e.payload)));
    }

    public get id(): string {
        return this._id;
    }

    public async show(): Promise<void> {
        if (!this.isDisposed) {
            // Make sure we're loaded first
            await this.loadPromise;

            // Make sure we have at least the initial sys info
            await this.addSysInfo(SysInfoReason.Start);

            // Then show our web panel.
            return super.show(true);
        }
    }

    public get onExecutedCode(): Event<string> {
        return this.executeEvent.event;
    }

    // tslint:disable-next-line: no-any no-empty cyclomatic-complexity max-func-body-length
    public onMessage(message: string, payload: any) {
        switch (message) {
            case InteractiveWindowMessages.GotoCodeCell:
                this.dispatchMessage(message, payload, this.gotoCode);
                break;

            case InteractiveWindowMessages.CopyCodeCell:
                this.dispatchMessage(message, payload, this.copyCode);
                break;

            case InteractiveWindowMessages.RestartKernel:
                this.restartKernel().ignoreErrors();
                break;

            case InteractiveWindowMessages.ReturnAllCells:
                this.dispatchMessage(message, payload, this.handleReturnAllCells);
                break;

            case InteractiveWindowMessages.Interrupt:
                this.interruptKernel().ignoreErrors();
                break;

            case InteractiveWindowMessages.Export:
                this.dispatchMessage(message, payload, this.export);
                break;

            case InteractiveWindowMessages.SendInfo:
                this.dispatchMessage(message, payload, this.updateContexts);
                break;

            case InteractiveWindowMessages.SubmitNewCell:
                this.dispatchMessage(message, payload, this.submitNewCell);
                break;

            case InteractiveWindowMessages.DeleteAllCells:
                this.logTelemetry(Telemetry.DeleteAllCells);
                break;

            case InteractiveWindowMessages.DeleteCell:
                this.logTelemetry(Telemetry.DeleteCell);
                break;

            case InteractiveWindowMessages.Undo:
                this.logTelemetry(Telemetry.Undo);
                break;

            case InteractiveWindowMessages.Redo:
                this.logTelemetry(Telemetry.Redo);
                break;

            case InteractiveWindowMessages.ExpandAll:
                this.logTelemetry(Telemetry.ExpandAll);
                break;

            case InteractiveWindowMessages.CollapseAll:
                this.logTelemetry(Telemetry.CollapseAll);
                break;

            case InteractiveWindowMessages.VariableExplorerToggle:
                this.variableExplorerToggle(payload);
                break;

            case InteractiveWindowMessages.AddedSysInfo:
                this.dispatchMessage(message, payload, this.onAddedSysInfo);
                break;

            case InteractiveWindowMessages.RemoteAddCode:
                this.dispatchMessage(message, payload, this.onRemoteAddedCode);
                break;

            case InteractiveWindowMessages.ShowDataViewer:
                this.dispatchMessage(message, payload, this.showDataViewer);
                break;

            case InteractiveWindowMessages.GetVariablesRequest:
                this.dispatchMessage(message, payload, this.requestVariables);
                break;

            case InteractiveWindowMessages.GetVariableValueRequest:
                this.dispatchMessage(message, payload, this.requestVariableValue);
                break;

            case InteractiveWindowMessages.LoadTmLanguageRequest:
                this.dispatchMessage(message, payload, this.requestTmLanguage);
                break;

            case InteractiveWindowMessages.LoadOnigasmAssemblyRequest:
                this.dispatchMessage(message, payload, this.requestOnigasm);
                break;

            default:
                break;
        }

        // Let our listeners handle the message too
        if (this.listeners) {
            this.listeners.forEach(l => l.onMessage(message, payload));
        }

        // Pass onto our base class.
        super.onMessage(message, payload);

        // After our base class handles some stuff, handle it ourselves too.
        switch (message) {
            case CssMessages.GetCssRequest:
                // Update the jupyter server if we have one:
                if (this.jupyterServer) {
                    this.isDark().then(d => this.jupyterServer ? this.jupyterServer.setMatplotLibStyle(d) : Promise.resolve()).ignoreErrors();
                }
                break;

            default:
                break;
        }

    }

    public dispose() {
        super.dispose();
        this.listeners.forEach(l => l.dispose());
        if (this.interpreterChangedDisposable) {
            this.interpreterChangedDisposable.dispose();
        }
        this.updateContexts(undefined);
    }

    public startProgress() {
        this.postMessage(InteractiveWindowMessages.StartProgress).ignoreErrors();
    }

    public stopProgress() {
        this.postMessage(InteractiveWindowMessages.StopProgress).ignoreErrors();
    }

    @captureTelemetry(Telemetry.Undo)
    public undoCells() {
        this.postMessage(InteractiveWindowMessages.Undo).ignoreErrors();
    }

    @captureTelemetry(Telemetry.Redo)
    public redoCells() {
        this.postMessage(InteractiveWindowMessages.Redo).ignoreErrors();
    }

    @captureTelemetry(Telemetry.DeleteAllCells)
    public removeAllCells() {
        this.postMessage(InteractiveWindowMessages.DeleteAllCells).ignoreErrors();
    }

    public exportCells() {
        // First ask for all cells. Set state to indicate waiting for result
        this.waitingForExportCells = true;

        // Telemetry will fire when the export function is called.
        this.postMessage(InteractiveWindowMessages.GetAllCells).ignoreErrors();
    }

    @captureTelemetry(Telemetry.RestartKernel)
    public async restartKernel(): Promise<void> {
        if (this.jupyterServer && !this.restartingKernel) {
            if (this.shouldAskForRestart()) {
                // Ask the user if they want us to restart or not.
                const message = localize.DataScience.restartKernelMessage();
                const yes = localize.DataScience.restartKernelMessageYes();
                const dontAskAgain = localize.DataScience.restartKernelMessageDontAskAgain();
                const no = localize.DataScience.restartKernelMessageNo();

                const v = await this.applicationShell.showInformationMessage(message, yes, dontAskAgain, no);
                if (v === dontAskAgain) {
                    this.disableAskForRestart();
                    await this.restartKernelInternal();
                } else if (v === yes) {
                    await this.restartKernelInternal();
                }
            } else {
                await this.restartKernelInternal();
            }
        }

        return Promise.resolve();
    }

    @captureTelemetry(Telemetry.Interrupt)
    public async interruptKernel(): Promise<void> {
        if (this.jupyterServer && !this.restartingKernel) {
            const status = this.statusProvider.set(localize.DataScience.interruptKernelStatus());

            const settings = this.configuration.getSettings();
            const interruptTimeout = settings.datascience.jupyterInterruptTimeout;

            try {
                const result = await this.jupyterServer.interruptKernel(interruptTimeout);
                status.dispose();

                // We timed out, ask the user if they want to restart instead.
                if (result === InterruptResult.TimedOut) {
                    const message = localize.DataScience.restartKernelAfterInterruptMessage();
                    const yes = localize.DataScience.restartKernelMessageYes();
                    const no = localize.DataScience.restartKernelMessageNo();
                    const v = await this.applicationShell.showInformationMessage(message, yes, no);
                    if (v === yes) {
                        await this.restartKernelInternal();
                    }
                } else if (result === InterruptResult.Restarted) {
                    // Uh-oh, keyboard interrupt crashed the kernel.
                    this.addSysInfo(SysInfoReason.Interrupt).ignoreErrors();
                }
            } catch (err) {
                status.dispose();
                this.logger.logError(err);
                this.applicationShell.showErrorMessage(err);
            }
        }
    }

    @captureTelemetry(Telemetry.CopySourceCode, undefined, false)
    public copyCode(args: ICopyCode) {
        this.copyCodeInternal(args.source).catch(err => {
            this.applicationShell.showErrorMessage(err);
        });
    }

    protected async onViewStateChanged(visible: boolean, active: boolean) {
        // Only activate if the active editor is empty. This means that
        // vscode thinks we are actually supposed to have focus. It would be
        // nice if they would more accurrately tell us this, but this works for now.
        // Essentially the problem is the webPanel.active state doesn't track
        // if the focus is supposed to be in the webPanel or not. It only tracks if
        // it's been activated. However if there's no active text editor and we're active, we
        // can safely attempt to give ourselves focus. This won't actually give us focus if we aren't
        // allowed to have it.
        if (visible && active && !this.documentManager.activeTextEditor) {
            // Force the webpanel to reveal and take focus.
            await super.show(false);

            // Send this to the react control
            await this.postMessage(InteractiveWindowMessages.Activate);
        }
    }

    // Submits a new cell to the window
    protected abstract submitNewCell(info: ISubmitNewCell): void;

    // Starts a server for this window
    protected abstract getNotebookOptions(): Promise<INotebookServerOptions>;

    protected abstract updateContexts(info: IInteractiveWindowInfo | undefined): void;

    protected async submitCode(code: string, file: string, line: number, id?: string, _editor?: TextEditor, debug?: boolean): Promise<boolean> {
        this.logger.logInformation(`Submitting code for ${this.id}`);
        let result = true;

        // Start a status item
        const status = this.setStatus(localize.DataScience.executingCode());

        // Transmit this submission to all other listeners (in a live share session)
        if (!id) {
            id = uuid();
            this.shareMessage(InteractiveWindowMessages.RemoteAddCode, { code, file, line, id, originator: this.id, debug: debug !== undefined ? debug : false });
        }

        // Create a deferred object that will wait until the status is disposed
        const finishedAddingCode = createDeferred<void>();
        const actualDispose = status.dispose.bind(status);
        status.dispose = () => {
            finishedAddingCode.resolve();
            actualDispose();
        };

        try {

            // Make sure we're loaded first.
            try {
                this.logger.logInformation('Waiting for jupyter server and web panel ...');
                await this.loadPromise;
            } catch (exc) {
                // We should dispose ourselves if the load fails. Othewise the user
                // updates their install and we just fail again because the load promise is the same.
                this.dispose();

                throw exc;
            }

            // Then show our webpanel
            await this.show();

            // Add our sys info if necessary
            if (file !== Identifiers.EmptyFileName) {
                await this.addSysInfo(SysInfoReason.Start);
            }

            if (this.jupyterServer) {
                // Before we try to execute code make sure that we have an initial directory set
                // Normally set via the workspace, but we might not have one here if loading a single loose file
                if (file !== Identifiers.EmptyFileName) {
                    await this.jupyterServer.setInitialDirectory(path.dirname(file));
                }

                if (debug) {
                    // Attach our debugger
                    await this.jupyterDebugger.startDebugging(this.jupyterServer);
                }

                // Attempt to evaluate this cell in the jupyter notebook
                const observable = this.jupyterServer.executeObservable(code, file, line, id, false);

                // Indicate we executed some code
                this.executeEvent.fire(code);

                // Sign up for cell changes
                observable.subscribe(
                    (cells: ICell[]) => {
                        this.sendCellsToWebView(cells, undefined);

                        // Any errors will move our result to false (if allowed)
                        if (this.configuration.getSettings().datascience.stopOnError) {
                            result = result && cells.find(c => c.state === CellState.error) === undefined;
                        }
                    },
                    (error) => {
                        status.dispose();
                        if (!(error instanceof CancellationError)) {
                            this.applicationShell.showErrorMessage(error.toString());
                        }
                    },
                    () => {
                        // Indicate executing until this cell is done.
                        status.dispose();
                    });

                // Wait for the cell to finish
                await finishedAddingCode.promise;
                traceInfo(`Finished execution for ${id}`);
            }
        } catch (err) {
            const message = localize.DataScience.executingCodeFailure().format(err);
            this.applicationShell.showErrorMessage(message);
        } finally {
            status.dispose();

            if (debug) {
                if (this.jupyterServer) {
                    await this.jupyterDebugger.stopDebugging(this.jupyterServer);
                }
            }
        }

        return result;
    }

    protected addMessageImpl(message: string, type: 'preview' | 'execute'): void {
        const cell: ICell = {
            id: uuid(),
            file: Identifiers.EmptyFileName,
            line: 0,
            state: CellState.finished,
            type,
            data: {
                cell_type: 'messages',
                messages: [message],
                source: [],
                metadata: {}
            }
        };

        // Do the same thing that happens when new code is added.
        this.sendCellsToWebView([cell]);
    }

    protected sendCellsToWebView = (cells: ICell[], editor?: TextEditor) => {
        // Send each cell to the other side
        cells.forEach((cell: ICell) => {
            switch (cell.state) {
                case CellState.init:
                    // Tell the react controls we have a new cell
                    this.postMessage(InteractiveWindowMessages.StartCell, cell).ignoreErrors();

                    // Keep track of this unfinished cell so if we restart we can finish right away.
                    this.unfinishedCells.push(cell);
                    break;

                case CellState.executing:
                    // Tell the react controls we have an update
                    this.postMessage(InteractiveWindowMessages.UpdateCell, cell).ignoreErrors();
                    break;

                case CellState.error:
                case CellState.finished:
                    // Tell the react controls we're done
                    this.postMessage(InteractiveWindowMessages.FinishCell, cell).ignoreErrors();

                    // Remove from the list of unfinished cells
                    this.unfinishedCells = this.unfinishedCells.filter(c => c.id !== cell.id);
                    break;

                default:
                    break; // might want to do a progress bar or something
            }
        });

        // If we have more than one cell, the second one should be a code cell. After it finishes, we need to inject a new cell entry
        if (cells.length > 1 && cells[1].state === CellState.finished) {
            // If we have an active editor, do the edit there so that the user can undo it, otherwise don't bother
            if (editor) {
                editor.edit((editBuilder) => {
                    editBuilder.insert(new Position(cells[1].line, 0), '#%%\n');
                });
            }
        }
    }

    protected startServer(): Promise<void> {
        this.loadPromise = this.startServerImpl();
        return this.loadPromise;
    }

    private async startServerImpl(): Promise<void> {
        // Status depends upon if we're about to connect to existing server or not.
        const status = (await this.jupyterExecution.getServer(await this.getNotebookOptions())) ?
            this.setStatus(localize.DataScience.connectingToJupyter()) : this.setStatus(localize.DataScience.startingJupyter());

        // Check to see if we support ipykernel or not
        try {
            const usable = await this.checkUsable();
            if (!usable) {
                // Not loading anymore
                status.dispose();
                this.dispose();

                // Indicate failing.
                throw new JupyterInstallError(localize.DataScience.jupyterNotSupported(), localize.DataScience.pythonInteractiveHelpLink());
            }
            // Then load the jupyter server
            await this.loadJupyterServer();
        } catch (e) {
            if (e instanceof JupyterSelfCertsError) {
                // On a self cert error, warn the user and ask if they want to change the setting
                const enableOption: string = localize.DataScience.jupyterSelfCertEnable();
                const closeOption: string = localize.DataScience.jupyterSelfCertClose();
                this.applicationShell.showErrorMessage(localize.DataScience.jupyterSelfCertFail().format(e.message), enableOption, closeOption).then(value => {
                    if (value === enableOption) {
                        sendTelemetryEvent(Telemetry.SelfCertsMessageEnabled);
                        this.configuration.updateSetting('dataScience.allowUnauthorizedRemoteConnection', true, undefined, ConfigurationTarget.Workspace).ignoreErrors();
                    } else if (value === closeOption) {
                        sendTelemetryEvent(Telemetry.SelfCertsMessageClose);
                    }
                    // Don't leave our Interactive Window open in a non-connected state
                    this.dispose();
                });
                throw e;
            } else {
                throw e;
            }
        } finally {
            status.dispose();
        }
    }

    private shouldAskForRestart(): boolean {
        const settings = this.configuration.getSettings();
        return settings && settings.datascience && settings.datascience.askForKernelRestart === true;
    }

    private disableAskForRestart() {
        const settings = this.configuration.getSettings();
        if (settings && settings.datascience) {
            settings.datascience.askForKernelRestart = false;
            this.configuration.updateSetting('dataScience.askForKernelRestart', false, undefined, ConfigurationTarget.Global).ignoreErrors();
        }
    }

    private async checkPandas(): Promise<boolean> {
        const pandasVersion = await this.dataExplorerProvider.getPandasVersion();
        if (!pandasVersion) {
            sendTelemetryEvent(Telemetry.PandasNotInstalled);
            // Warn user that there is no pandas.
            this.applicationShell.showErrorMessage(localize.DataScience.pandasRequiredForViewing());
            return false;
        } else if (pandasVersion.major < 1 && pandasVersion.minor < 20) {
            sendTelemetryEvent(Telemetry.PandasTooOld);
            // Warn user that we cannot start because pandas is too old.
            const versionStr = `${pandasVersion.major}.${pandasVersion.minor}.${pandasVersion.build}`;
            this.applicationShell.showErrorMessage(localize.DataScience.pandasTooOldForViewingFormat().format(versionStr));
            return false;
        }
        return true;
    }

    private shouldAskForLargeData(): boolean {
        const settings = this.configuration.getSettings();
        return settings && settings.datascience && settings.datascience.askForLargeDataFrames === true;
    }

    private disableAskForLargeData() {
        const settings = this.configuration.getSettings();
        if (settings && settings.datascience) {
            settings.datascience.askForLargeDataFrames = false;
            this.configuration.updateSetting('dataScience.askForLargeDataFrames', false, undefined, ConfigurationTarget.Global).ignoreErrors();
        }
    }

    private async checkColumnSize(columnSize: number): Promise<boolean> {
        if (columnSize > ColumnWarningSize && this.shouldAskForLargeData()) {
            const message = localize.DataScience.tooManyColumnsMessage();
            const yes = localize.DataScience.tooManyColumnsYes();
            const no = localize.DataScience.tooManyColumnsNo();
            const dontAskAgain = localize.DataScience.tooManyColumnsDontAskAgain();

            const result = await this.applicationShell.showWarningMessage(message, yes, no, dontAskAgain);
            if (result === dontAskAgain) {
                this.disableAskForLargeData();
            }
            return result === yes;
        }
        return true;
    }

    private async showDataViewer(request: IShowDataViewer): Promise<void> {
        try {
            if (await this.checkPandas() && await this.checkColumnSize(request.columnSize)) {
                await this.dataExplorerProvider.create(request.variableName);
            }
        } catch (e) {
            this.applicationShell.showErrorMessage(e.toString());
        }
    }

    // tslint:disable-next-line:no-any
    private dispatchMessage<M extends IInteractiveWindowMapping, T extends keyof M>(_message: T, payload: any, handler: (args: M[T]) => void) {
        const args = payload as M[T];
        handler.bind(this)(args);
    }

    // tslint:disable-next-line:no-any
    private onAddedSysInfo(sysInfo: IAddedSysInfo) {
        // See if this is from us or not.
        if (sysInfo.id !== this.id) {

            // Not from us, must come from a different interactive window. Add to our
            // own to keep in sync
            if (sysInfo.sysInfoCell) {
                this.sendCellsToWebView([sysInfo.sysInfoCell]);
            }
        }
    }

    // tslint:disable-next-line:no-any
    private onRemoteAddedCode(args: IRemoteAddCode) {
        // Make sure this is valid
        if (args && args.id && args.file && args.originator !== this.id) {
            // Indicate this in our telemetry.
            sendTelemetryEvent(Telemetry.RemoteAddCode);

            // Submit this item as new code.
            this.submitCode(args.code, args.file, args.line, args.id, undefined, args.debug).ignoreErrors();
        }
    }

    private finishOutstandingCells() {
        this.unfinishedCells.forEach(c => {
            c.state = CellState.error;
            this.postMessage(InteractiveWindowMessages.FinishCell, c).ignoreErrors();
        });
        this.unfinishedCells = [];
        this.potentiallyUnfinishedStatus.forEach(s => s.dispose());
        this.potentiallyUnfinishedStatus = [];
    }

    private async restartKernelInternal(): Promise<void> {
        this.restartingKernel = true;

        // First we need to finish all outstanding cells.
        this.finishOutstandingCells();

        // Set our status
        const status = this.statusProvider.set(localize.DataScience.restartingKernelStatus());

        try {
            if (this.jupyterServer) {
                await this.jupyterServer.restartKernel(this.generateDataScienceExtraSettings().jupyterInterruptTimeout);
                await this.addSysInfo(SysInfoReason.Restart);

                // Compute if dark or not.
                const knownDark = await this.isDark();

                // Before we run any cells, update the dark setting
                await this.jupyterServer.setMatplotLibStyle(knownDark);
            }
        } catch (exc) {
            // If we get a kernel promise failure, then restarting timed out. Just shutdown and restart the entire server
            if (exc instanceof JupyterKernelPromiseFailedError && this.jupyterServer) {
                await this.jupyterServer.dispose();
                await this.loadJupyterServer(true);
                await this.addSysInfo(SysInfoReason.Restart);
            } else {
                // Show the error message
                this.applicationShell.showErrorMessage(exc);
                this.logger.logError(exc);
            }
        } finally {
            status.dispose();
            this.restartingKernel = false;
        }
    }

    // tslint:disable-next-line:no-any
    private handleReturnAllCells(cells: ICell[]) {
        // See what we're waiting for.
        if (this.waitingForExportCells) {
            this.export(cells);
        }
    }

    private setStatus = (message: string): Disposable => {
        const result = this.statusProvider.set(message);
        this.potentiallyUnfinishedStatus.push(result);
        return result;
    }

    private logTelemetry = (event: Telemetry) => {
        sendTelemetryEvent(event);
    }

    private onInterpreterChanged = () => {
        // Update our load promise. We need to restart the jupyter server
        this.loadPromise = this.reloadWithNew();
    }

    private async reloadWithNew(): Promise<void> {
        const status = this.setStatus(localize.DataScience.startingJupyter());
        try {
            // Not the same as reload, we need to actually dispose the server.
            if (this.loadPromise) {
                await this.loadPromise;
                if (this.jupyterServer) {
                    const server = this.jupyterServer;
                    this.jupyterServer = undefined;
                    await server.dispose();
                }
            }
            await this.startServer();
            await this.addSysInfo(SysInfoReason.New);
        } finally {
            status.dispose();
        }
    }

    private async reloadAfterShutdown(): Promise<void> {
        try {
            if (this.loadPromise) {
                await this.loadPromise;
                if (this.jupyterServer) {
                    const server = this.jupyterServer;
                    this.jupyterServer = undefined;
                    server.shutdown().ignoreErrors(); // Don't care what happens as we're disconnected.
                }
            }
        } catch {
            // We just switched from host to guest mode. Don't really care
            // if closing the host server kills it.
            this.jupyterServer = undefined;
        }
        return this.startServer();
    }

    @captureTelemetry(Telemetry.GotoSourceCode, undefined, false)
    private gotoCode(args: IGotoCode) {
        this.gotoCodeInternal(args.file, args.line).catch(err => {
            this.applicationShell.showErrorMessage(err);
        });
    }

    private async gotoCodeInternal(file: string, line: number) {
        let editor: TextEditor | undefined;

        if (await fs.pathExists(file)) {
            editor = await this.documentManager.showTextDocument(Uri.file(file), { viewColumn: ViewColumn.One });
        } else {
            // File URI isn't going to work. Look through the active text documents
            editor = this.documentManager.visibleTextEditors.find(te => te.document.fileName === file);
            if (editor) {
                editor.show();
            }
        }

        // If we found the editor change its selection
        if (editor) {
            editor.revealRange(new Range(line, 0, line, 0));
            editor.selection = new Selection(new Position(line, 0), new Position(line, 0));
        }
    }

    private async copyCodeInternal(source: string) {
        let editor = this.documentManager.activeTextEditor;
        if (!editor || editor.document.languageId !== PYTHON_LANGUAGE) {
            // Find the first visible python editor
            const pythonEditors = this.documentManager.visibleTextEditors.filter(
                e => e.document.languageId === PYTHON_LANGUAGE || e.document.isUntitled);

            if (pythonEditors.length > 0) {
                editor = pythonEditors[0];
            }
        }
        if (editor && (editor.document.languageId === PYTHON_LANGUAGE || editor.document.isUntitled)) {
            // Figure out if any cells in this document already.
            const ranges = generateCellRanges(editor.document, this.generateDataScienceExtraSettings());
            const hasCellsAlready = ranges.length > 0;
            const line = editor.selection.start.line;
            const revealLine = line + 1;
            let newCode = `${source}${os.EOL}`;
            if (hasCellsAlready) {
                // See if inside of a range or not.
                const matchingRange = ranges.find(r => r.range.start.line <= line && r.range.end.line >= line);

                // If in the middle, wrap the new code
                if (matchingRange && matchingRange.range.start.line < line && line < editor.document.lineCount - 1) {
                    newCode = `#%%${os.EOL}${source}${os.EOL}#%%${os.EOL}`;
                } else {
                    newCode = `#%%${os.EOL}${source}${os.EOL}`;
                }
            } else if (editor.document.lineCount <= 0 || editor.document.isUntitled) {
                // No lines in the document at all, just insert new code
                newCode = `#%%${os.EOL}${source}${os.EOL}`;
            }

            await editor.edit((editBuilder) => {
                editBuilder.insert(new Position(line, 0), newCode);
            });
            editor.revealRange(new Range(revealLine, 0, revealLine + source.split('\n').length + 3, 0));

            // Move selection to just beyond the text we input so that the next
            // paste will be right after
            const selectionLine = line + newCode.split('\n').length - 1;
            editor.selection = new Selection(new Position(selectionLine, 0), new Position(selectionLine, 0));
        }
    }

    @captureTelemetry(Telemetry.ExportNotebook, undefined, false)
    // tslint:disable-next-line: no-any no-empty
    private export(cells: ICell[]) {
        // Should be an array of cells
        if (cells && this.applicationShell) {

            const filtersKey = localize.DataScience.exportDialogFilter();
            const filtersObject: Record<string, string[]> = {};
            filtersObject[filtersKey] = ['ipynb'];

            // Bring up the open file dialog box
            this.applicationShell.showSaveDialog(
                {
                    saveLabel: localize.DataScience.exportDialogTitle(),
                    filters: filtersObject
                }).then(async (uri: Uri | undefined) => {
                    if (uri) {
                        await this.exportToFile(cells, uri.fsPath);
                    }
                });
        }
    }

    private showInformationMessage(message: string, question?: string): Thenable<string | undefined> {
        if (question) {
            return this.applicationShell.showInformationMessage(message, question);
        } else {
            return this.applicationShell.showInformationMessage(message);
        }
    }

    private exportToFile = async (cells: ICell[], file: string) => {
        // Take the list of cells, convert them to a notebook json format and write to disk
        if (this.jupyterServer) {
            let directoryChange;
            const settings = this.configuration.getSettings();
            if (settings.datascience.changeDirOnImportExport) {
                directoryChange = file;
            }

            const notebook = await this.jupyterExporter.translateToNotebook(cells, directoryChange);

            try {
                // tslint:disable-next-line: no-any
                await this.fileSystem.writeFile(file, JSON.stringify(notebook), { encoding: 'utf8', flag: 'w' });
                const openQuestion = (await this.jupyterExecution.isSpawnSupported()) ? localize.DataScience.exportOpenQuestion() : undefined;
                this.showInformationMessage(localize.DataScience.exportDialogComplete().format(file), openQuestion).then((str: string | undefined) => {
                    if (str && this.jupyterServer) {
                        // If the user wants to, open the notebook they just generated.
                        this.jupyterExecution.spawnNotebook(file).ignoreErrors();
                    }
                });
            } catch (exc) {
                this.logger.logError('Error in exporting notebook file');
                this.applicationShell.showInformationMessage(localize.DataScience.exportDialogFailed().format(exc));
            }
        }
    }

    private async loadJupyterServer(_restart?: boolean): Promise<void> {
        this.logger.logInformation('Getting jupyter server options ...');

        // Wait for the webpanel to pass back our current theme darkness
        const knownDark = await this.isDark();

        // Extract our options
        const options = await this.getNotebookOptions();

        this.logger.logInformation('Connecting to jupyter server ...');

        // Now try to create a notebook server
        this.jupyterServer = await this.jupyterExecution.connectToNotebookServer(options);

        // Before we run any cells, update the dark setting
        if (this.jupyterServer) {
            await this.jupyterServer.setMatplotLibStyle(knownDark);
        }

        this.logger.logInformation('Connected to jupyter server.');
    }

    private generateSysInfoCell = async (reason: SysInfoReason): Promise<ICell | undefined> => {
        // Execute the code 'import sys\r\nsys.version' and 'import sys\r\nsys.executable' to get our
        // version and executable
        if (this.jupyterServer) {
            const message = await this.generateSysInfoMessage(reason);

            // The server handles getting this data.
            const sysInfo = await this.jupyterServer.getSysInfo();
            if (sysInfo) {
                // Connection string only for our initial start, not restart or interrupt
                let connectionString: string = '';
                if (reason === SysInfoReason.Start) {
                    connectionString = this.generateConnectionInfoString(this.jupyterServer.getConnectionInfo());
                }

                // Update our sys info with our locally applied data.
                const cell = sysInfo.data as IMessageCell;
                if (cell) {
                    cell.messages.unshift(message);
                    if (connectionString && connectionString.length) {
                        cell.messages.unshift(connectionString);
                    }
                }

                return sysInfo;
            }
        }
    }

    private async generateSysInfoMessage(reason: SysInfoReason): Promise<string> {
        switch (reason) {
            case SysInfoReason.Start:
                // Message depends upon if ipykernel is supported or not.
                if (!(await this.jupyterExecution.isKernelCreateSupported())) {
                    return localize.DataScience.pythonVersionHeaderNoPyKernel();
                }
                return localize.DataScience.pythonVersionHeader();
                break;
            case SysInfoReason.Restart:
                return localize.DataScience.pythonRestartHeader();
                break;
            case SysInfoReason.Interrupt:
                return localize.DataScience.pythonInterruptFailedHeader();
                break;
            case SysInfoReason.New:
                return localize.DataScience.pythonNewHeader();
                break;
            default:
                this.logger.logError('Invalid SysInfoReason');
                return '';
                break;
        }
    }

    private generateConnectionInfoString(connInfo: IConnection | undefined): string {
        if (!connInfo) {
            return '';
        }

        const tokenString = connInfo.token.length > 0 ? `?token=${connInfo.token}` : '';
        const urlString = `${connInfo.baseUrl}${tokenString}`;

        return `${localize.DataScience.sysInfoURILabel()}${urlString}`;
    }

    private addSysInfo = async (reason: SysInfoReason): Promise<void> => {
        if (!this.addSysInfoPromise || reason !== SysInfoReason.Start) {
            this.logger.logInformation(`Adding sys info for ${this.id} ${reason}`);
            const deferred = createDeferred<boolean>();
            this.addSysInfoPromise = deferred;

            // Generate a new sys info cell and send it to the web panel.
            const sysInfo = await this.generateSysInfoCell(reason);
            if (sysInfo) {
                this.sendCellsToWebView([sysInfo]);
            }

            // For anything but start, tell the other sides of a live share session
            if (reason !== SysInfoReason.Start && sysInfo) {
                this.shareMessage(InteractiveWindowMessages.AddedSysInfo, { type: reason, sysInfoCell: sysInfo, id: this.id });
            }

            // For a restart, tell our window to reset
            if (reason === SysInfoReason.Restart || reason === SysInfoReason.New) {
                this.postMessage(InteractiveWindowMessages.RestartKernel).ignoreErrors();
                if (this.jupyterServer) {
                    this.jupyterDebugger.onRestart(this.jupyterServer);
                }
            }

            this.logger.logInformation(`Sys info for ${this.id} ${reason} complete`);
            deferred.resolve(true);
        } else if (this.addSysInfoPromise) {
            this.logger.logInformation(`Wait for sys info for ${this.id} ${reason}`);
            await this.addSysInfoPromise.promise;
        }
    }

    private async checkUsable(): Promise<boolean> {
        let activeInterpreter: PythonInterpreter | undefined;
        try {
            activeInterpreter = await this.interpreterService.getActiveInterpreter();
            const usableInterpreter = await this.jupyterExecution.getUsableJupyterPython();
            if (usableInterpreter) {
                // See if the usable interpreter is not our active one. If so, show a warning
                // Only do this if not the guest in a liveshare session
                const api = await this.liveShare.getApi();
                if (!api || (api.session && api.session.role !== vsls.Role.Guest)) {
                    const active = await this.interpreterService.getActiveInterpreter();
                    const activeDisplayName = active ? active.displayName : undefined;
                    const activePath = active ? active.path : undefined;
                    const usableDisplayName = usableInterpreter ? usableInterpreter.displayName : undefined;
                    const usablePath = usableInterpreter ? usableInterpreter.path : undefined;
                    if (activePath && usablePath && !this.fileSystem.arePathsSame(activePath, usablePath) && activeDisplayName && usableDisplayName) {
                        this.applicationShell.showWarningMessage(localize.DataScience.jupyterKernelNotSupportedOnActive().format(activeDisplayName, usableDisplayName));
                    }
                }
            }

            return usableInterpreter ? true : false;

        } catch (e) {
            // Can't find a usable interpreter, show the error.
            if (activeInterpreter) {
                const displayName = activeInterpreter.displayName ? activeInterpreter.displayName : activeInterpreter.path;
                throw new Error(localize.DataScience.jupyterNotSupportedBecauseOfEnvironment().format(displayName, e.toString()));
            } else {
                throw new JupyterInstallError(localize.DataScience.jupyterNotSupported(), localize.DataScience.pythonInteractiveHelpLink());
            }
        }
    }

    private async requestVariables(requestExecutionCount: number): Promise<void> {
        this.variableRequestStopWatch = new StopWatch();

        // Request our new list of variables
        const vars: IJupyterVariable[] = await this.jupyterVariables.getVariables();
        const variablesResponse: IJupyterVariablesResponse = { executionCount: requestExecutionCount, variables: vars };

        // Tag all of our jupyter variables with the execution count of the request
        variablesResponse.variables.forEach((value: IJupyterVariable) => {
            value.executionCount = requestExecutionCount;
        });

        const settings = this.configuration.getSettings();
        const excludeString = settings.datascience.variableExplorerExclude;

        if (excludeString) {
            const excludeArray = excludeString.split(';');
            variablesResponse.variables = variablesResponse.variables.filter((value) => {
                return excludeArray.indexOf(value.type) === -1;
            });
        }
        this.variableRequestPendingCount = variablesResponse.variables.length;
        this.postMessage(InteractiveWindowMessages.GetVariablesResponse, variablesResponse).ignoreErrors();
        sendTelemetryEvent(Telemetry.VariableExplorerVariableCount, undefined, { variableCount: variablesResponse.variables.length });
    }

    // tslint:disable-next-line: no-any
    private async requestVariableValue(payload?: any): Promise<void> {
        if (payload) {
            const targetVar = payload as IJupyterVariable;
            // Request our variable value
            const varValue: IJupyterVariable = await this.jupyterVariables.getValue(targetVar);
            this.postMessage(InteractiveWindowMessages.GetVariableValueResponse, varValue).ignoreErrors();

            // Send our fetch time if appropriate.
            if (this.variableRequestPendingCount === 1 && this.variableRequestStopWatch) {
                this.variableRequestPendingCount -= 1;
                sendTelemetryEvent(Telemetry.VariableExplorerFetchTime, this.variableRequestStopWatch.elapsedTime);
                this.variableRequestStopWatch = undefined;
            } else {
                this.variableRequestPendingCount = Math.max(0, this.variableRequestPendingCount - 1);
            }

        }
    }

    // tslint:disable-next-line: no-any
    private variableExplorerToggle = (payload?: any) => {
        // Direct undefined check as false boolean will skip code
        if (payload !== undefined) {
            const openValue = payload as boolean;

            // Log the state in our Telemetry
            sendTelemetryEvent(Telemetry.VariableExplorerToggled, undefined, { open: openValue });
        }
    }

    private requestTmLanguage() {
        // Get the contents of the appropriate tmLanguage file.
        traceInfo('Request for tmlanguage file.');
        this.themeFinder.findTmLanguage(PYTHON_LANGUAGE).then(s => {
            this.postMessage(InteractiveWindowMessages.LoadTmLanguageResponse, s).ignoreErrors();
        }).catch(_e => {
            this.postMessage(InteractiveWindowMessages.LoadTmLanguageResponse, undefined).ignoreErrors();
        });
    }

    private async requestOnigasm(): Promise<void> {
        // Look for the file next or our current file (this is where it's installed in the vsix)
        let filePath = path.join(__dirname, 'node_modules', 'onigasm', 'lib', 'onigasm.wasm');
        traceInfo(`Request for onigasm file at ${filePath}`);
        if (this.fileSystem) {
            if (await this.fileSystem.fileExists(filePath)) {
                const contents = await fs.readFile(filePath);
                this.postMessage(InteractiveWindowMessages.LoadOnigasmAssemblyResponse, contents).ignoreErrors();
            } else {
                // During development it's actually in the node_modules folder
                filePath = path.join(EXTENSION_ROOT_DIR, 'node_modules', 'onigasm', 'lib', 'onigasm.wasm');
                traceInfo(`Backup request for onigasm file at ${filePath}`);
                if (await this.fileSystem.fileExists(filePath)) {
                    const contents = await fs.readFile(filePath);
                    this.postMessage(InteractiveWindowMessages.LoadOnigasmAssemblyResponse, contents).ignoreErrors();
                } else {
                    traceWarning('Onigasm file not found. Colorization will not be available.');
                    this.postMessage(InteractiveWindowMessages.LoadOnigasmAssemblyResponse, undefined).ignoreErrors();
                }
            }
        } else {
            // This happens during testing. Onigasm not needed as we're not testing colorization.
            traceWarning('File system not found. Colorization will not be available.');
            this.postMessage(InteractiveWindowMessages.LoadOnigasmAssemblyResponse, undefined).ignoreErrors();
        }
    }
}

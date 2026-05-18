declare module "vscode" {
  export type Disposable = { dispose(): unknown };
  export type ExtensionContext = { subscriptions: Disposable[] };
  export type Uri = {
    scheme: string;
    authority: string;
    path: string;
    fsPath: string;
    with(change: { scheme?: string; authority?: string; path?: string }): Uri;
  };
  export type Tab = {
    input: unknown;
  };

  export class TabInputCustom {
    constructor(uri: Uri, viewType: string);
    uri: Uri;
    viewType: string;
  }

  export const ViewColumn: {
    Active: number;
  };

  export const commands: {
    executeCommand<T = unknown>(command: string, ...rest: unknown[]): PromiseLike<T>;
    registerCommand(command: string, callback: (...args: unknown[]) => unknown): Disposable;
  };

  export const window: {
    showInformationMessage(message: string): PromiseLike<string | undefined>;
    showWarningMessage(message: string): PromiseLike<string | undefined>;
    tabGroups: {
      all: Array<{ tabs: Tab[] }>;
      close(tabs: Tab | Tab[], preserveFocus?: boolean): PromiseLike<boolean>;
    };
  };

  export const Uri: {
    file(path: string): Uri;
  };
}

declare module "vscode" {
  export type Disposable = { dispose(): unknown };
  export type ExtensionContext = { subscriptions: Disposable[] };

  export const commands: {
    executeCommand<T = unknown>(command: string, ...rest: unknown[]): PromiseLike<T>;
    registerCommand(command: string, callback: (...args: unknown[]) => unknown): Disposable;
  };

  export const window: {
    showInformationMessage(message: string): PromiseLike<string | undefined>;
    showWarningMessage(message: string): PromiseLike<string | undefined>;
  };

  export const Uri: {
    file(path: string): unknown;
  };
}

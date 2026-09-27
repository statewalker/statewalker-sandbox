// A VS Code *web* extension: CommonJS, `browser` entry, no Node APIs. It runs in
// Theia's browser-only plugin host (a Web Worker).
const vscode = require("vscode");

exports.activate = (context) => {
  context.subscriptions.push(
    vscode.commands.registerCommand("p6.hello", () =>
      vscode.window.showInformationMessage("Hello from a VS Code web extension"),
    ),
    // Reads through the plugin API's workspace.fs, which ends at the FilesApi.
    vscode.commands.registerCommand("p6.readmeTitle", async () => {
      const [root] = vscode.workspace.workspaceFolders ?? [];
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root.uri, "README.md"));
      const title = new TextDecoder().decode(bytes).split("\n")[0];
      vscode.window.showInformationMessage(`README title: ${title}`);
    }),
  );
};

exports.deactivate = () => {};

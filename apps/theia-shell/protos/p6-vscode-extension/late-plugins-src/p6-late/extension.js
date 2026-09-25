// Not in the build's plugin list: the page deploys it after start-up.
const vscode = require("vscode");

exports.activate = (context) => {
  context.subscriptions.push(
    vscode.commands.registerCommand("p6.late", () =>
      vscode.window.showInformationMessage("Hello from a plugin deployed at runtime"),
    ),
  );
};

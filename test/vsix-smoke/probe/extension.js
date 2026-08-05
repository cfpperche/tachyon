// The probe is a development extension only so that VS Code will start an extension host at all;
// `--extensionTestsPath` alone starts a window and runs nothing (measured, t-e0a0f5). It contributes
// nothing and activates on nothing — every assertion lives in `suite.js`.
exports.activate = function activate() {};
exports.deactivate = function deactivate() {};

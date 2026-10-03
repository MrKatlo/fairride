// Metro needs to know about the monorepo: it must watch the repo root (so edits
// to packages/shared reload the app) and resolve modules from both the app's and
// the root's node_modules.
//
// Deliberately minimal. `expo/metro-config` already understands npm workspaces,
// and overriding its resolver defaults is how people end up with a second copy
// of React. `npx expo-doctor` validates this file.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;

const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.blockList = [/test[/\\]e2e_data/];

// Support packages that use the "exports" field in package.json (e.g. @atproto/*)
config.resolver.unstable_enablePackageExports = true;

// Transform @atproto/* packages (they use modern syntax: static class blocks, etc.)
config.transformer.transformIgnorePatterns = [
  'node_modules/(?!(@atproto)/)',
];

module.exports = config;

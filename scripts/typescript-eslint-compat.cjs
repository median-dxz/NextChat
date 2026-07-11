const Module = require("node:module");

const resolveFilename = Module._resolveFilename;
const compatibilityCompiler = require.resolve("typescript-eslint-compat");

Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "typescript") {
    return compatibilityCompiler;
  }

  return resolveFilename.call(this, request, parent, isMain, options);
};

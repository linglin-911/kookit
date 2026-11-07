const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

module.exports = function createLoader(stubs = {}) {
  const cache = new Map();
  function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file).exports;
    const compiled = new Module(file, module);
    cache.set(file, compiled);
    compiled.filename = file;
    compiled.paths = Module._nodeModulePaths(path.dirname(file));
    compiled.require = (request) => {
      if (Object.hasOwn(stubs, request)) return stubs[request];
      if (request.startsWith(".")) {
        const target = path.resolve(path.dirname(file), request + ".ts");
        if (fs.existsSync(target)) return load(target);
      }
      return Module.prototype.require.call(compiled, request);
    };
    compiled._compile(ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText, file);
    return compiled.exports;
  }
  return load;
};

// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  packageManager: "npm",
  reporters: ["html", "clear-text", "progress", "dashboard"],
  testRunner: "jest",
  jest: {
    projectType: "custom",
    configFile: "jest.config.js",
    enableFindRelatedTests: true,
  },
  coverageAnalysis: "perTest",
  mutate: [
    "src/**/gift.service.ts",
    "src/**/claim.service.ts",
    "src/**/gift-state-machine.ts",
    "src/**/exchange-rate.service.ts",
    "!src/**/*.test.ts",
    "!src/**/*.test.tsx",
    "!src/**/*.d.ts",
  ],
  thresholds: {
    high: 90,
    low: 80,
    break: 80,
  },
  htmlReporter: {
    fileName: "reports/mutation/mutation.html",
  },
  clearTextReporter: {
    reportType: "all",
    allowEmpty: false,
  },
  dashboard: {
    project: "github.com/joekeyz8/Lumigift-lumigift",
    version: "main",
  },
  timeoutMS: 60000,
  concurrency: 2,
};

module.exports = config;
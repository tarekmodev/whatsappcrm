/** @type {import('jest').Config} */
module.exports = {
  rootDir: 'src',
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
  // The application logs for real in these tests — that is the point, it proves the
  // wiring — but the output belongs in an assertion, not in the test report.
  setupFiles: ['<rootDir>/../jest.setup.js'],
};

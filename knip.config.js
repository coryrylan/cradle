/** @type {import('knip').KnipConfig} */
export default {
  ignore: ['examples/**'],
  ignoreDependencies: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    '@semantic-release/github',
    'conventional-changelog-conventionalcommits',
    '@commitlint/cli'
  ],
  workspaces: {
    'projects/cli': {
      entry: ['src/**/*.test.ts'],
      project: ['src/**/*.ts'],
      ignoreExportsUsedInFile: true,
      ignoreDependencies: []
    },
    'projects/docs': {
      entry: ['src/_layouts/index.11ty.js'],
      project: ['src/**/*.{js,ts}'],
      ignoreDependencies: ['@nvidia-elements/styles']
    }
  }
};

import fs from 'node:fs';

const DRY_RUN = false;
const packageFile = JSON.parse(fs.readFileSync(`${process.cwd()}/package.json`));
const unscopedName = packageFile.name.split('/').pop();
const scope = unscopedName === 'cradle' ? 'cli' : unscopedName;

export default {
  dryRun: DRY_RUN,
  tagFormat: `${unscopedName}-v\${version}`,
  branches: ['main'],
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        releaseRules: [
          { breaking: true, release: false },
          { type: 'feat', release: false },
          { type: 'fix', release: false },
          { type: 'chore', release: false },
          { breaking: true, scope, release: 'major' },
          { type: 'feat', scope, release: 'minor' },
          { type: 'fix', scope, release: 'patch' }
        ]
      }
    ],
    [
      '@semantic-release/release-notes-generator',
      {
        preset: 'conventionalcommits',
        presetConfig: {
          ignoreCommits: `^(?![^]*\\(${scope}\\))(?![^]*\\[${scope}\\]).*$`
        }
      }
    ],
    [
      '@semantic-release/changelog',
      {
        changelogFile: 'CHANGELOG.md'
      }
    ],
    [
      '@semantic-release/exec',
      {
        prepareCmd: 'bun pm pkg set version=${nextRelease.version} && bun pm pack',
        publishCmd: `npm publish ./*.tgz --registry=https://registry.npmjs.org ${DRY_RUN ? '--dry-run' : ''} --access=public`
      }
    ],
    [
      '@semantic-release/git',
      {
        assets: ['package.json', 'CHANGELOG.md'],
        message: `chore(release): ${unscopedName}` + '-v${nextRelease.version} [skip ci]\n\n${nextRelease.notes}'
      }
    ],
    [
      '@semantic-release/github',
      {
        successComment: '🎉 This issue has been resolved in version ${nextRelease.version} 🎉'
      }
    ]
  ]
};

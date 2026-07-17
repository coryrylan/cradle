import { EleventyRenderPlugin } from '@11ty/eleventy';
import EleventyPluginVite from '@11ty/eleventy-plugin-vite';
import markdownIt from 'markdown-it';

const BASE_URL = process.env.PAGES_BASE_URL ?? '/';

const CODEBLOCK_LANGUAGE_ALIASES = {
  sh: 'bash',
  bash: 'bash',
  ts: 'typescript',
  js: 'javascript',
  md: 'markdown',
  yml: 'yaml'
};

const SUPPORTED_CODEBLOCK_LANGUAGES = new Set([
  'bash',
  'css',
  'go',
  'html',
  'javascript',
  'json',
  'markdown',
  'python',
  'shell',
  'toml',
  'typescript',
  'xml',
  'yaml'
]);

function getCodeblockLanguage(fenceInfo) {
  const raw = fenceInfo.trim().split(/\s+/)[0] ?? '';
  const language = CODEBLOCK_LANGUAGE_ALIASES[raw] ?? raw;
  return SUPPORTED_CODEBLOCK_LANGUAGES.has(language) ? language : undefined;
}

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(EleventyRenderPlugin);
  eleventyConfig.setFrontMatterParsingOptions({ language: 'js' });
  eleventyConfig.addPassthroughCopy('src/**/*.ts');
  eleventyConfig.addPassthroughCopy('src/**/*.css');
  eleventyConfig.addPassthroughCopy('src/favicon.svg');
  eleventyConfig.addPlugin(EleventyPluginVite, {
    viteOptions: {
      base: BASE_URL,
      build: {
        target: 'esnext',
        sourcemap: false,
        reportCompressedSize: false
      }
    }
  });

  if (BASE_URL !== '/') {
    eleventyConfig.setServerOptions({
      onRequest: {
        '/': () => ({
          status: 307,
          headers: {
            Location: BASE_URL
          }
        })
      }
    });
  }

  const markdown = markdownIt({
    html: true,
    breaks: true,
    linkify: true
  });

  const formats = {
    h1: 'display lg',
    h2: 'heading xl',
    h3: 'heading lg',
    h4: 'heading sm',
    h5: 'heading',
    h6: 'heading',
    p: 'body',
    a: 'link'
  };

  function renderer(tokens, idx, options, env, slf) {
    if (
      tokens[idx].type === 'heading_open' ||
      tokens[idx].type === 'link_open' ||
      tokens[idx].type === 'paragraph_open'
    ) {
      tokens[idx].attrSet('nve-text', formats[tokens[idx].tag]);
    }

    if (tokens[idx].type === 'bullet_list_open' || tokens[idx].type === 'ordered_list_open') {
      tokens[idx].attrSet('nve-text', 'list');
      tokens[idx].attrSet('nve-layout', 'column gap:xs');
    }

    return slf.renderToken(tokens, idx, options, env, slf);
  }

  markdown.renderer.rules.heading_open = renderer;
  markdown.renderer.rules.link_open = renderer;
  markdown.renderer.rules.paragraph_open = renderer;
  markdown.renderer.rules.bullet_list_open = renderer;
  markdown.renderer.rules.ordered_list_open = renderer;

  markdown.renderer.rules.code_inline = function codeInline(tokens, idx, options, env, slf) {
    tokens[idx].attrSet('nve-text', 'code');
    return `<code${slf.renderAttrs(tokens[idx])}>${markdown.utils.escapeHtml(tokens[idx].content)}</code>`;
  };

  markdown.renderer.rules.fence = function fence(tokens, idx) {
    const token = tokens[idx];
    const language = getCodeblockLanguage(token.info || '');
    const languageAttr = language ? ` language="${language}"` : '';
    const code = markdown.utils.escapeHtml(token.content.replace(/\n$/, ''));
    return `<nve-codeblock${languageAttr}>${code}</nve-codeblock>\n`;
  };

  markdown.renderer.rules.table_open = () => '<nve-grid container="flat">\n';
  markdown.renderer.rules.table_close = () => '</nve-grid>\n';
  markdown.renderer.rules.thead_open = (tokens, idx, options, env) => {
    env.insideThead = true;
    return '<nve-grid-header>\n';
  };
  markdown.renderer.rules.thead_close = (tokens, idx, options, env) => {
    env.insideThead = false;
    return '</nve-grid-header>\n';
  };
  markdown.renderer.rules.tbody_open = () => '';
  markdown.renderer.rules.tbody_close = () => '';
  markdown.renderer.rules.tr_open = (tokens, idx, options, env) => (env.insideThead ? '' : '<nve-grid-row>\n');
  markdown.renderer.rules.tr_close = (tokens, idx, options, env) => (env.insideThead ? '' : '</nve-grid-row>\n');
  markdown.renderer.rules.th_open = () => '<nve-grid-column><span>';
  markdown.renderer.rules.th_close = () => '</span></nve-grid-column>\n';
  markdown.renderer.rules.td_open = () => '<nve-grid-cell><span>';
  markdown.renderer.rules.td_close = () => '</span></nve-grid-cell>\n';

  eleventyConfig.setLibrary('md', markdown);

  return {
    dir: {
      input: 'src',
      output: 'dist',
      layouts: '_layouts'
    }
  };
}

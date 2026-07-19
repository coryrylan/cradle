const BASE_URL = process.env.PAGES_BASE_URL ?? '/';

const NAV_ITEMS = [
  { label: 'Introduction', href: './', url: '/' },
  { label: 'Getting Started', href: 'getting-started/', url: '/getting-started/' },
  { label: 'Agent Folders', href: 'agent-folders/', url: '/agent-folders/' },
  { label: 'Commands', href: 'commands/', url: '/commands/' },
  { label: 'Aliases', href: 'aliases/', url: '/aliases/' },
  { label: 'Sandbox', href: 'sandbox/', url: '/sandbox/' }
];

export function render(data) {
  const title = data.title ?? 'cradle';
  const description = data.description ?? 'A runtime for portable agents defined as folders.';
  const currentUrl = data.page?.url ?? '/';

  const menuItems = NAV_ITEMS.map(item => {
    const openTag = item.url === currentUrl ? '<nve-menu-item selected>' : '<nve-menu-item>';
    return `${openTag}<a href="${item.href}">${item.label}</a></nve-menu-item>`;
  }).join('\n                  ');

  return /* html */ `
    <!DOCTYPE html>
      <html lang="en" nve-theme="dark" nve-transition="auto">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta name="description" content="${description}">
          <meta http-equiv="X-UA-Compatible" content="ie=edge">
          <base href="${BASE_URL}" />
          <title>${title}</title>
          <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
          <link rel="stylesheet" href="/_layouts/index.css" />
          <script type="module" src="/_layouts/index.ts"></script>
        </head>
        <body>
          <nve-page>
            <!-- UI built with https://nvidia.github.io/elements/ -->
            <nve-page-header slot="header">
              <a slot="prefix" href="./" nve-text="heading sm">@coryrylan/cradle</a>
              <nve-button slot="suffix" container="flat"><a href="https://github.com/coryrylan/cradle" target="_blank">GitHub</a></nve-button>
              <nve-icon-button
                slot="suffix"
                container="flat"
                icon-name="menu"
                popovertarget="nav-drawer"
                aria-label="menu"
                class="nav-drawer-toggle"
              ></nve-icon-button>
            </nve-page-header>
            <nve-page-panel slot="left" size="sm" class="nav-page-panel">
              <nve-page-panel-content>
                <nve-menu>
                  ${menuItems}
                </nve-menu>
              </nve-page-panel-content>
            </nve-page-panel>
            <main nve-layout="column gap:lg pad:lg align:horizontal-stretch">
              ${data.content}
            </main>
          </nve-page>
          <nve-drawer id="nav-drawer" position="left" size="sm" closable modal>
            <nve-drawer-header>
              <h3 nve-text="heading sm">Navigation</h3>
            </nve-drawer-header>
            <nve-drawer-content>
              <nve-menu>
                ${menuItems}
              </nve-menu>
            </nve-drawer-content>
          </nve-drawer>
        </body>
      </html>
  `;
}

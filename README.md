# panda97

LightPanda browser automation for [pi coding agent](https://pi.dev). Lightweight, fast alternative to [browse97](https://www.npmjs.com/package/browse97) — no Chrome required.

Each tab runs its own LightPanda instance via CDP. Zero npm dependencies. Pages load in milliseconds.

## Prerequisites

Install [LightPanda](https://lightpanda.io):

```bash
curl -fsSL https://get.lightpanda.io | bash
```

Verify it's available:

```bash
lightpanda version
```

Custom binary path via environment variable:

```bash
PANDA97_BINARY=/path/to/lightpanda
```

## Install

```bash
pi install npm:panda97
```

## Tools

| Tool | Description |
|---|---|
| `panda97_start` | Open a new browser tab (launches a LightPanda instance). Call this first. |
| `panda97_alltabs` | List all open tabs (id, url, title) |
| `panda97_switchtab` | Switch to an existing tab by id |
| `panda97_closetab` | Close a tab and shut down its instance |
| `panda97_navigate` | Navigate the active tab to a URL |
| `panda97_snapshot` | List interactive elements. Scope with `container`, filter with `filter` |
| `panda97_click` | Click by CSS selector or visible text |
| `panda97_fill` | Fill multiple form fields by fuzzy matching name/id/placeholder/label |
| `panda97_upload` | Upload file to a file input (blob injection) |
| `panda97_eval` | Evaluate JavaScript in the page context |
| `panda97_wait` | Wait for an element or text to appear |

## How It Works

Unlike browse97 (which connects to a single shared Chrome instance), panda97 launches a **separate LightPanda process per tab** on sequential ports starting at 9400. This means:

- Tabs are fully isolated — no shared state, cookies, or sessions
- No Chrome installation needed
- Sub-second startup per instance
- Cleanup is automatic — closing a tab kills its process

## Usage Examples

```
Open a page and inspect it:
  → panda97_start({url: "https://example.com"})
  → panda97_snapshot()
  → panda97_eval({expression: "document.body.innerText"})

Fill and submit a form:
  → panda97_start({url: "https://httpbin.org/forms/post"})
  → panda97_snapshot({filter: "input,textarea,select,button"})
  → panda97_fill({fields: {"custname": "Jane", "custtel": "555-1234"}})
  → panda97_click({target: "Submit"})

Work with multiple tabs:
  → panda97_start({url: "https://example.com"})
  → panda97_start({url: "https://httpbin.org/html"})
  → panda97_alltabs()
  → panda97_switchtab({id: "00000001"})
  → panda97_closetab({id: "00000002"})

Extract data:
  → panda97_eval({expression: "[...document.querySelectorAll('a')].map(a => a.href).join('\\n')"})

Wait for dynamic content:
  → panda97_wait({target: ".results-loaded", timeout: 5000})
```

## snapshot Parameters

| Parameter | Example | Description |
|---|---|---|
| (none) | `{}` | All interactive elements on page |
| `container` | `{container: ".main"}` | Scope to elements inside `.main` |
| `filter` | `{filter: "a,button"}` | Only show links and buttons |
| both | `{container: ".form", filter: "input,select"}` | Inputs and selects inside `.form` |

## click Auto-Detection

- Starts with `.` `#` `[` `(` or contains `>` `+` `~` `*` → CSS selector
- Otherwise → matches visible text of buttons, links, submit inputs

## fill Fuzzy Matching

Field keys are matched case-insensitively against: `name`, `id`, `placeholder`, `aria-label`, associated `<label>` text.

```
panda97_fill({fields: {"email": "x@y.com"}})
  → matches: name="email", id="email", placeholder="Email address", label "Email"
```

## Context Safety

`panda97_snapshot` and `panda97_eval` truncate results at **5000 characters** by default to protect your context window.

```
panda97_snapshot({container: ".main", filter: "a"})    // scoped → likely fits
panda97_snapshot({allowWhole: true})                    // no truncation
panda97_eval({expression: "...", allowWhole: true})     // no truncation
```

## panda97 vs browse97

| | panda97 | browse97 |
|---|---|---|
| Browser | LightPanda (Zig) | Chrome |
| Install | `curl` one-liner | Chrome + launch flags |
| Startup | ~1s per tab | Connects to running Chrome |
| JS engine | zig-js (partial V8 compat) | Full V8 |
| Isolation | Full — separate process per tab | Shared Chrome instance |
| Cloudflare/bot detection | Blocked | Works (real Chrome) |
| CSS/images | Not rendered | Full rendering |
| Best for | Fast scraping, API testing, form automation | Sites needing real browser |

## Limitations

- **No visual rendering** — LightPanda is headless-only with no CSS/image rendering
- **Partial JS support** — zig-js covers most web APIs but not all. Complex SPAs may not work.
- **Bot detection** — Sites with Cloudflare or similar anti-bot will block LightPanda
- **One target per instance** — Multi-tab is achieved via multiple processes, not browser tabs

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PANDA97_BINARY` | `lightpanda` | Path to LightPanda binary |

Ports are auto-assigned starting at 9400.

## License

MIT

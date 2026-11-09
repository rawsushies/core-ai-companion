# Research: permissioned integrations (Phase 5) and Android companion (Phase 6)

Status: research and design. One proof of concept is implemented (Archicad, read-only, see below). Nothing
here has been validated against real Archicad, Revit or Windows UI Automation, because this environment
has none of them.

## 1. Skill architecture (target)

Today's skills are a fixed set (notes, timer, weather, music, apps, search, calendar), project tools
(read/list/find, approved writes), and declarative URL-template plugins. Every new integration should
declare a **manifest** before it gets code:

| Field | Meaning |
|---|---|
| `id`, `name`, `version` | identity |
| `capabilities` | e.g. `read:project`, `write:project`, `net:localhost:19723`, `ui:app:revit.exe` |
| `permissions` | what the user must grant (per app / per folder), default **off** |
| `inputs` / `outputs` | validated schemas; model text is only ever data |
| `limits` | timeouts, max calls per turn, max output size |
| `consequential` | actions needing a preview + explicit confirmation (like file Apply) |
| `audit` | what is logged (`logs/tools.log`) |

Rules carried over from the existing tools: least privilege, no shell built from model text, localhost
only for local app APIs, visible indicator while active, confirmation for anything that changes state,
reversible where possible.

## 2. BIM / CAD

| Application | Interface | Notes | Fit |
|---|---|---|---|
| **Archicad** | Built-in **JSON API** over HTTP on `localhost`, default port **19723** (instances use 19723–19743). Official Python binding wraps it; names of Python methods = JSON command names. Extra commands (e.g. publishing, project info) come from the **Tapir** add-on. | Local HTTP: COre's main process can call it directly, no plug-in needed for basics. Commands vary by version. | **Best first PoC** (implemented read-only) |
| **Revit** | Native add-ins (`IExternalApplication`/`IExternalCommand`, .NET). Practical bridge: **pyRevit Routes**, a REST API running inside Revit on `localhost:48884`, handlers in IronPython 2.7. | Routes is beta: no built-in auth, can crash Revit on pyRevit reload. Any COre use must stay localhost-only and read-first. | Second PoC (needs pyRevit on the user's PC) |
| AutoCAD | COM / .NET API in-process; AutoLISP. | Needs a plug-in; heavier. | Later |

What COre must **not** claim: understanding a BIM model from screenshots alone. Real answers ("how many
fire doors on level 2") need the application's API.

**PoC implemented: Archicad, read-only** (`src/main/archicad.js`, skill `archicad`, off by default):
- Finds a running Archicad by asking `API.IsAlive` on ports 19723–19743 (127.0.0.1 only).
- `status`: product info (`API.GetProductInfo`). `count TYPE`: number of elements of a type
  (`API.GetElementsByType`, e.g. Wall, Door, Window, Slab, Column).
- No commands that change the model are exposed. Command names follow Graphisoft's JSON interface docs.
  Exact availability differs by Archicad version, and this is untested against a real Archicad.

## 3. Windows UI Automation

- Reachable without native Node modules via PowerShell + `System.Windows.Automation` (UIAutomationClient).
  It can read the element tree and use control patterns (`InvokePattern` for buttons; `TogglePattern` /
  `SelectionItemPattern` for checkboxes and radios). Target elements by **AutomationId**, not Name (Name
  changes with language). Accessibility Insights for Windows shows ids and patterns.
- Design, not built:
  1. Per-application permission (process name allowlist), off by default, granted in Settings.
  2. A visible "COre is controlling <app>" indicator while active, with one-click stop.
  3. Read-only first: list windows/controls of the allowed app (helps pointing and answers).
  4. Actions only from a fixed set (invoke button, toggle, set text) on elements the user can see in a
     preview, each confirmed. Never keystroke macros built from model text.
  5. A fixed, signed PowerShell script with parameters passed as data (no string-built commands).

## 4. Android remote companion

Goal: notifications, chat/voice instructions, task monitoring, approve/reject actions, cancel tasks, view
results. The desktop app must stay fully useful without it.

Recommended architecture (no public exposure of localhost services):
- **Pairing:** the desktop shows a QR code with a one-time pairing secret + the desktop's public key.
  The phone generates its own key pair. Both sides prove possession (Noise XX or TLS with pinned
  self-signed certificates). The user confirms a short code on both screens (protects against a
  photographed QR).
- **Transport:** same-network only at first (mDNS discovery, TLS with pinned keys). Remote access later
  only through an end-to-end-encrypted relay that sees ciphertext, never via port forwarding.
- **Authorization:** per-device keys, short-lived session tokens derived after the handshake, monotonic
  message counters + timestamps (replay protection), a per-device permission set (view / approve /
  instruct).
- **Device management:** list, rename and revoke devices in Settings. Revocation deletes the device key and
  invalidates its sessions immediately.
- **Safety:** the phone sends intents ("approve proposal X", "cancel task Y", "message to Scout"), never
  commands. Consequential approvals still go through the same preview/confirm path, and the phone sees
  the same diff card.
- **Feasibility:** a separate app (Kotlin or React Native) plus a small desktop service in the main
  process. Estimate: several milestones. Start with a read-only, LAN-only "task monitor" to prove pairing
  and revocation before any approve/instruct features.

## Sources
- Archicad JSON API and Python binding: https://archicadapi.graphisoft.com/archicadPythonPackage/archicad.html ,
  https://pypi.org/project/archicad/25.1100 , Tapir/MCP projects: https://pypi.org/project/archicad-mcp/
- pyRevit Routes: https://pyrevitlabs.notion.site/pyRevit-Routes-HTTP-API-79ef6d4a77b04aca9be6f4e46ffa728e ,
  https://compaec.github.io/news/2020/04/30/pyRevitRoutes.html , https://www.github.com/pyrevitlabs/pyRevit/issues/2156
- UI Automation InvokePattern: https://learn.microsoft.com/pt-br/dotnet/api/system.windows.automation.invokepattern ,
  PowerShell example: https://scriptagc.wasmer.app/https_powershellone_wordpress_com/2021/02/03/automate-guis-with-uiautomation-in-powershell

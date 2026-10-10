# Universe

A desktop worldbuilding app: build universes, galaxies, star systems and
worlds, give them histories on a timeline, and let Claude Code help through
a local API and MCP server. See [PLAN.md](PLAN.md) for the full design and roadmap.

**Status:** M0 to M12 are done (up to phone access and sync between your
devices); M13 (Polish & release) is under way. New here? On the start screen,
**Explore a sample universe** opens Calder, a world with fifteen centuries of
history to look around in. Press `?` for the keyboard shortcuts.

You can create `.universe` project files and build the universe tree
(cluster → galaxy → star system → planet → moon / world surface). Each world
surface is generated from a seed: type any word and you get a whole planet
(land type, water, islands, mountains, climate, colors), the same planet every
time. Or customize every option yourself; either way a world code recreates
that exact planet anywhere. View it as a 3D globe or a flat map, sculpt the
terrain, paint biomes, change the sea level, draw named regions, and write
rich-text notes.

Every world (and every other node) has a timeline: past on the left, future
on the right. Add events and eras, drag them around, link causes to effects,
group events, and place them on the map. Move the playhead and the map shows
the world as of then: regions founded, renamed and dissolved over time.

Place structures from a library of detailed prebuilt blueprints (castles, a
vast walled city, villages, slums, war camps, nomad camps, harbours,
cathedrals, palaces and more), build your own from simple shapes, or import
glTF models. Each structure is maintained or left to weather from any moment
on; weathered ones crumble at the pace of their materials until they erode
away, and events can build, damage, repair, rename or destroy everything in
a radius, a region, or a list.

Zoom all the way in and you're on the ground: hills, woods, meadows and rocks
of the local biome in 1 km chunks, buildings at their real size, and your
characters life-size. Characters have a lifespan and a journey; send them
from place to place, or to an event, and they walk there over time. From
orbit, each planet and moon shows its real surface.

Star systems are simulated: give the star a mass and each planet and moon an
orbit and a spin, and watch them go round as the timeline plays. A world's
calendar follows from its day, year and moon; the timeline shows the moon's
phases and the eclipses; and the star and distance set the world's climate,
which its biomes follow. Each world has a species library and food web.
Structures now weather material by material in the local climate: the
thatched roof goes long before the stone walls.

The whole universe is one continuous zoom. Each universe's seed strings
galaxy clusters along a cosmic web; each cluster holds its galaxies (spiral,
barred, elliptical or irregular), each galaxy its stars, generated a patch at a time as
you get close, and each star its planets. Scroll in on anything to go there
and out to come back up (or use the breadcrumb or Esc). Claim whatever you
find, a cluster, a galaxy, a star, a planet as a world, and it becomes yours,
keeping its seed and place; or right-click to put something of your own
anywhere.

Give a world's ages their own look and tone with themes: a palette, a
lighting preset, how hazy the air is, a typeface, mood words, ambience and a
prose style guide (start from presets such as Golden Age or Plague Years).
Lay them on the timeline's theme band over any span of time, for the whole
world or one region, fading in and out; where they overlap, priorities decide
what shows. As the playhead moves the globe, the map and the ground blend
from one theme into the next (light, sky, haze, sea and land), and the app's
accent and title type follow.

Describe how a world's powers work on its **Powers** page: magic, divine
gifts, psionics, technology, politics or anything else, each started from a
template with the questions it should answer (its source, rules, costs, who
can use it…). Answer them once for every age, then again for any era where
things are different, and say how strong it is in each; the age under the
playhead is marked. Everything can be undone, and everything stays on your
computer.

## Connect Claude Code

Universe runs a local API and MCP server while it's open (on 127.0.0.1 only,
behind a token). Open **Connect AI** in the top bar and copy one of its
commands:

```bash
# Through the running app: changes show at once and undo in one click.
claude mcp add --transport http universe http://127.0.0.1:47615/mcp --header "Authorization: Bearer <token>"

# Or as a stdio server, which also works while the app is closed
# (it goes through the app whenever the app has the project open).
claude mcp add universe -- "<path to the Universe executable>" --mcp --project "<path to your .universe file>"
```

Claude can then read your worlds (a world at any moment, its history and
causes, structures' condition and why, the theme and prose style of an age, the
sky, the food web, how its powers work in each age), add to them (events,
links, structures, characters, species, themes, power systems, regions, notes)
and check them for mistakes. Every change it
makes is tagged as the AI's: a note shows what it did, **Undo AI** takes its
latest changes back in one click, and with **Review AI changes** on they wait
for you to accept or reject them. The same operations are a REST API under
`/v1` (described at `/v1/openapi.json`), with a change feed at `/v1/changes`.
Any world exports as a Markdown world bible from its inspector.

Claude can also check a world for what doesn't fit. On a world's **Warnings**
page, copy the request for Claude and paste it into Claude (on the computer or
your phone): it reads the world as a whole and reports each problem it finds
(someone in two places at once, magic used in an age that doesn't allow it,
notes at odds with the history), with what it's about and a suggested fix.
Each one shows on the Warnings page next to the app's own checks, with an
amber mark on what it's about in the tree, the timeline and the lists; mark
it resolved, or dismiss it as not a problem so it isn't raised again. Findings
are advice, so they show even with **Review AI changes** on.

## From your phone

Claude on your phone can reach the universe open on your computer. The
Claude app gets it as a **custom connector**, which claude.ai calls from
Anthropic's servers, so the computer needs a public HTTPS address. Universe
uses [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) for that; the
app itself still listens on 127.0.0.1 only.

1. Install Tailscale on the computer and sign in. Funnel has to be allowed
   for your tailnet; if it isn't, Universe shows Tailscale's link to allow it.
2. In Universe, open **Connect AI → From your phone** and turn on
   **Let Claude on my phone connect**. It turns on Funnel for the API and
   shows the address, `https://<computer>.<tailnet>.ts.net/mcp`.
3. On claude.ai (Settings → Connectors → Add custom connector), add that
   address. claude.ai opens Universe's sign-in page: type the code Universe
   shows on the computer.
4. The connector is now in the Claude app on your phone, too.

Changes from the phone show in the app like any AI client's, undo in one
click, and wait for review with **Review AI changes** on. Each connected
client is listed under **From your phone**, where **Remove** disconnects it
at once. From outside, only signed-in clients get in: the app's own token
works on this computer only. The computer has to be on with Universe running.

### Universe on your phone

The whole app can open in your phone's browser too, from your computer (which
has to be on), through your own tailnet only: install Tailscale on the phone
and sign in to the same account. In **Connect AI → From your phone**, turn on
**Use Universe on my phone** and open the address it shows on the phone. The
first time, type the code
the computer shows; the phone then shows the universe open on the computer,
one panel at a time, and a change on either shows on the other. Remove it from
the connected list to sign it out.

To keep it on the phone like an app, add it to the home screen: in Safari on
an iPhone, **Share → Add to Home Screen**; in Chrome on Android, the **⋮** menu
→ **Add to Home screen** (or **Install app**). It gets Universe's icon and opens
full screen, without the browser around it, as long as the computer is on.

### The same universe on your other computers

Universe can keep a universe in step across your own computers, directly over
your tailnet (no cloud): install Tailscale on each, signed in to the same
account, and turn on **Sync with my other devices** on each (in **Connect AI**,
or on the start screen). Each lists your other devices online and what they
have open. To start, open the universe on one, and on the other choose **Copy
“…” here**: it makes a copy in a new file. From then on, while both have it
open, a change on either shows on the other within seconds; a device that was
off catches up when it's back. When both changed the same thing, the later
change wins.

## Download and run

Every push to `dev`, `staging` or `main` builds and tests the app for every OS.
New work goes to `dev`, is tried out on `staging` (its builds are on the
[**staging-build** release](https://github.com/Gabetd/universe.me/releases/tag/staging-build)),
then goes on to `main`. Get the newest released build from the
[**latest-build** release](https://github.com/Gabetd/universe.me/releases/tag/latest-build):

| OS | File | How to run |
|---|---|---|
| Windows | `Universe-…-windows-portable.exe` | Double-click. No install needed. If SmartScreen appears: **More info → Run anyway**. |
| Windows (installer) | `Universe-…-win-x64.exe` | Installs to Program Files and adds a Start menu entry. |
| macOS, Apple Silicon | `Universe-…-mac-arm64.dmg` | Drag to Applications. The first time, open it, then **System Settings → Privacy & Security → Open Anyway**. |
| macOS, Intel | `Universe-…-mac-x64.dmg` | Same as above. |
| Linux | `Universe-…-linux-x86_64.AppImage` | `chmod +x` it, then run it. Or install the `.deb`. |

The builds aren't code-signed yet, which is why the OS asks for confirmation.
Once installed, Universe updates itself from `main`'s builds, and only installs
one whose manifest is signed with the project's key (an Ed25519 key kept as a
GitHub secret; the app has its public half).

## Develop

Requires Node.js 22.13+ (24 recommended) and pnpm 10 (`corepack enable`).

```bash
pnpm install
pnpm dev          # launch the app with hot reload
pnpm check        # lint + typecheck + unit tests
pnpm test:e2e     # build, then drive the real app with Playwright
pnpm dist         # package an installer for the current OS into apps/desktop/release/
```

Electron downloads its binary the first time it runs.

## Layout

```
apps/desktop/      Electron app: main process, preload bridge, React renderer
packages/core/     Domain model, Zod schemas, command bus with undo/redo, queries
packages/db/       .universe project files on SQLite (Node's built-in node:sqlite)
packages/procgen/  Seeded terrain generation, biomes, brushes, map rendering (pure TS)
```

All edits go through the command bus in `packages/core`, so the UI and
(later) the REST API and MCP server share validation, undo and the history log.

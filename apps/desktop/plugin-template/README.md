# Writing a Universe plugin

A plugin is a folder with two files in it:

- **plugin.json** says what the plugin offers.
- **main.js** is the code that does it.

This folder is a working plugin to start from. It has a generator that founds villages, a name generator, and exporters for wiki pages and a map image. Edit it and run it again from the Plugins page (Tools → Plugins). The app reads the folder afresh each time a plugin runs.

## What a plugin can offer

**Generators** add to the universe: villages, a history, a dynasty, a road network.
- They run on a world (`"on": "world"`) or on the whole universe (`"on": "universe"`).
- They change things only through the app's operations, the same ones Claude uses over MCP.
- Everything one run changes is a single step to undo. If the run fails part way, nothing it did is kept.

**Exporters** take a world (or the universe) out to files: a wiki, a map image, a game engine's data.
- They can read everything but change nothing.
- Their files are saved where the user chooses.

**Name generators** give names to things.
- In `"for"`, list what they name: `character`, `faction`, `region`, `structure`, `node`, `species`, `event`.
- They show up under **Name it…** in the right-click menu of those things.

## plugin.json

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "description": "What it does, in a line",
  "main": "main.js",
  "generators": [{ "id": "villages", "title": "Scatter villages", "on": "world", "options": [] }],
  "exporters": [{ "id": "wiki", "title": "Wiki pages", "on": "world" }],
  "names": [{ "id": "people", "title": "Northern names", "for": ["character"] }]
}
```

The `id` fields:
- The plugin's `id` uses lowercase letters, digits and `-`.
- Each contribution's `id` is the name of its function in main.js.

**Options** are asked for in a form before a contribution runs. Each one has an `id`, a `label` and a `type`:

| `type` | What it is |
|---|---|
| `text` | A line of text. |
| `number` | A number, with optional `min`, `max` and `step`. |
| `choice` | One of its `choices`. |
| `flag` | Yes or no. |

Any of them can have a `default`.

## main.js

main.js is an ES module. It exports an object for each kind of contribution, with one function for each `id`:

```js
export const generators = {
  async villages({ worldId, options, seed }, universe) {
    const { places } = await universe.call('get_terrain_at', { worldId, places: [{ lat: 10, lon: 20 }] })
    // …
    return 'Founded 3 villages' // What it did, shown in the app.
  }
}
export const exporters = {
  async wiki({ worldId }, universe) {
    return [{ name: 'index.md', text: '# …' }] // Or { name, bytes } for binary files.
  }
}
export const names = {
  people({ count, seed, options }, universe) {
    return ['Aldric', 'Edda'] // As many as `count`.
  }
}
```

Each function is given what it runs on:
- `worldId`, if it runs on a world.
- `universeId`.
- Its `options`.
- A random `seed`.

A name generator is also given `for` (what's being named) and `count`.

A plugin can `import` its own files (`./lib/names.js`) and nothing else.

## `universe`

Everything a plugin can do goes through `universe`.

### `universe.call(operation, input)`

Calls one of the app's operations and returns a promise of its answer. These are the operations Claude has through Universe's MCP server; their full descriptions are in the REST API's OpenAPI document (`/v1/openapi.json`). Some to start with:

**Reading**
- `list_worlds`, `get_world`, `get_world_snapshot`.
- `list_events`, `list_structures`, `list_characters`, `list_factions`, `list_waterways`.
- `get_terrain_at`: what the land is like at places.
- `get_world_map`: the map's pixels.
- `export_world_bible` with `format: "json"`: everything about a world at once.

**Changing** (generators only)
- `create_event`, `create_region`, `create_structure`, `create_character`, `create_faction`.
- `set_relationship`, `name_waterway`, `update_note`.
- `run_commands`, for anything else the app can do (`describe_commands` lists those).

Dates are written in the world's calendar: `"1204"`, `"15 Mar 1204"` or a number.

### Other helpers

| Helper | What it does |
|---|---|
| `universe.random(seed)` | A function giving numbers from 0 to 1, the same ones for the same seed. |
| `universe.pickFile({ title, extensions })` | Asks the user for a text file. Gives `{ name, text }`, or `null` if they don't pick one. |
| `universe.png(width, height, rgba)` | Encodes RGBA pixels as PNG bytes. |
| `universe.fromBase64(text)`, `universe.toBase64(bytes)` | Converts between base64 and bytes. `get_world_map` gives its pixels in base64. |
| `universe.log(…)` (also `console.log`) | Writes a line to the plugin's log on the Plugins page. |

## The sandbox

A plugin runs in a JavaScript engine of its own (QuickJS) and reaches only what `universe` gives it:
- no network;
- no files except the ones the user picks;
- no Node, and no access to the page.

Each run has limits:
- 120 seconds;
- 256 MB of memory;
- 20,000 calls into the app;
- 10,000 changes to the universe.

Code that loops forever is stopped.

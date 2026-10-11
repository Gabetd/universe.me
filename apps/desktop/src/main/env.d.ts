/// <reference types="electron-vite/node" />

/** The bundled English dictionary's files (electron.vite.config.ts aliases them), as text. */
declare module 'dictionary-en-files/*?raw' {
  const text: string
  export default text
}

/** The plugin template's files (plugin-template/), as text. */
declare module '*?raw' {
  const text: string
  export default text
}

/** WebAssembly as the main process uses it (QuickJS compiled once for plugins' workers): Node has it, the types here don't. */
declare namespace WebAssembly {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- an opaque compiled module
  interface Module {}
  function compile(bytes: Uint8Array): Promise<Module>
}

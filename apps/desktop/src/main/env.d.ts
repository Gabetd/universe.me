/// <reference types="electron-vite/node" />

/** The bundled English dictionary's files (electron.vite.config.ts aliases them), as text. */
declare module 'dictionary-en-files/*?raw' {
  const text: string
  export default text
}

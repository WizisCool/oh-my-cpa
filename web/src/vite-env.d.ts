/// <reference types="vite/client" />

declare module '*?worker' {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}

declare module 'monaco-editor/esm/vs/languages/definitions/yaml/yaml.js' {
  import type { languages } from 'monaco-editor';
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}

// `country-flag-icons` ships types for its `string/3x2` index only; each
// per-country module this app imports default-exports that flag's SVG markup.
declare module 'country-flag-icons/string/3x2/*' {
  const flagMarkup: string;
  export default flagMarkup;
}

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker(_moduleId: unknown, label: string): Worker;
    };
  }
}

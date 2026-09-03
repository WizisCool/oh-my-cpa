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

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker(_moduleId: unknown, label: string): Worker;
    };
  }
}

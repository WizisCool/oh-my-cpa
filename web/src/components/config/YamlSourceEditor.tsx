import React, { useEffect, useRef } from 'react';
import Editor, { loader, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import 'monaco-editor/esm/vs/features/find/register.js';
import 'monaco-editor/esm/vs/editor/contrib/format/browser/formatActions.js';
import 'monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter.js';
import 'monaco-editor/esm/vs/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestInlineCompletions.js';
import { conf as yamlConf, language as yamlLanguage } from 'monaco-editor/esm/vs/languages/definitions/yaml/yaml.js';
import { configureMonacoYaml, type MonacoYaml } from 'monaco-yaml';
import { parseDocument } from 'yaml';
import { THEME_PRESETS, type ThemeId, type ThemePalette } from '../../theme/themeConfig';

// ── Configure Local Monaco Environment (Strict Offline / Zero CDN) ───────────
if (typeof window !== 'undefined') {
  window.MonacoEnvironment = {
    getWorker(_moduleId: unknown, label: string) {
      if (label === 'yaml') {
        return new Worker(
          new URL('monaco-yaml/yaml.worker.js', import.meta.url),
          { type: 'module' }
        );
      }
      return new Worker(
        new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
        { type: 'module' }
      );
    },
  };
}

loader.config({ monaco });

let monacoYamlInstance: MonacoYaml | null = null;

const withAlpha = (hex: string, alpha: string) => `${hex}${alpha}`;

function ensureMonacoConfigured() {
  // Explicitly register YAML language & Monarch tokenizer
  const registeredLanguages = monaco.languages.getLanguages();
  if (!registeredLanguages.some((lang) => lang.id === 'yaml')) {
    monaco.languages.register({
      id: 'yaml',
      extensions: ['.yaml', '.yml'],
      aliases: ['YAML', 'yaml', 'YML', 'yml'],
      mimetypes: ['application/x-yaml', 'text/x-yaml'],
    });
  }
  monaco.languages.setMonarchTokensProvider('yaml', yamlLanguage);
  monaco.languages.setLanguageConfiguration('yaml', yamlConf);

  if (!monacoYamlInstance) {
    monacoYamlInstance = configureMonacoYaml(monaco, {
      enableSchemaRequest: false, // Strict offline: no external network schema fetching
      validate: false,
      format: { enable: true },
      hover: true,
      completion: true,
      yamlVersion: '1.2',
    });
  }

  const darkRules = [
      { token: 'comment', foreground: '7F858A', fontStyle: 'italic' },
      { token: 'comment.yaml', foreground: '7F858A', fontStyle: 'italic' },
      { token: 'type', foreground: '79A8D8' }, // YAML Keys (host:, port:, etc.)
      { token: 'type.yaml', foreground: '79A8D8' },
      { token: 'string', foreground: 'B7A7D8' }, // Strings (soft lavender)
      { token: 'string.yaml', foreground: 'B7A7D8' },
      { token: 'number', foreground: '72A7A0' }, // Numbers (soft sage/teal)
      { token: 'number.yaml', foreground: '72A7A0' },
      { token: 'keyword', foreground: 'C58FB0' }, // true, false, null (soft dusky rose)
      { token: 'keyword.yaml', foreground: 'C58FB0' },
      { token: 'operators', foreground: 'A6A3A1' },
      { token: 'operators.yaml', foreground: 'A6A3A1' },
      { token: 'delimiter', foreground: 'A6A3A1' },
      { token: 'delimiter.bracket', foreground: 'A6A3A1' },
      { token: 'delimiter.square', foreground: 'A6A3A1' },
      { token: 'tag', foreground: 'A890D0' },
      { token: 'namespace', foreground: 'A890D0' },
      { token: 'attribute.name', foreground: '79A8D8' },
    ];
  const lightRules = [
      { token: 'comment', foreground: '6E7378', fontStyle: 'italic' },
      { token: 'comment.yaml', foreground: '6E7378', fontStyle: 'italic' },
      { token: 'type', foreground: '185FA5' }, // YAML Keys in light mode
      { token: 'type.yaml', foreground: '185FA5' },
      { token: 'string', foreground: '5D4B8B' }, // Strings in light mode
      { token: 'string.yaml', foreground: '5D4B8B' },
      { token: 'number', foreground: '1B7F75' }, // Numbers in light mode
      { token: 'number.yaml', foreground: '1B7F75' },
      { token: 'keyword', foreground: '8E3E6F' }, // true, false in light mode
      { token: 'keyword.yaml', foreground: '8E3E6F' },
      { token: 'operators', foreground: '4F4D4B' },
      { token: 'operators.yaml', foreground: '4F4D4B' },
      { token: 'delimiter', foreground: '4F4D4B' },
      { token: 'delimiter.bracket', foreground: '4F4D4B' },
      { token: 'delimiter.square', foreground: '4F4D4B' },
      { token: 'tag', foreground: '6B4699' },
      { token: 'namespace', foreground: '6B4699' },
      { token: 'attribute.name', foreground: '185FA5' },
    ];
  for (const preset of THEME_PRESETS) {
    monaco.editor.defineTheme(preset.id, {
      base: preset.mode === 'dark' ? 'vs-dark' : 'vs',
      inherit: true,
      rules: preset.mode === 'dark' ? darkRules : lightRules,
      colors: monacoColors(preset.palette, preset.mode),
    });
  }
}

function monacoColors(palette: ThemePalette, mode: 'dark' | 'light'): Record<string, string> {
  // The editor sits inside a `var(--bg)` shell. The shipped dark theme used
  // `bg` for the editor itself and `surface` for the active line; keep that
  // relationship for every preset rather than swapping the two surfaces.
  const editorBackground = mode === 'dark' ? palette.bg : palette.surface;
  const lineHighlight = mode === 'dark' ? palette.surface : palette.bg;
  return {
    'editor.background': editorBackground,
    'editor.foreground': palette.fg,
    'editorLineNumber.foreground': palette.meta,
    'editorLineNumber.activeForeground': palette.fg,
    'editor.lineHighlightBackground': lineHighlight,
    'editor.selectionBackground': withAlpha(palette.border, '80'),
    'editorCursor.foreground': palette.fg,
    'editorWhitespace.foreground': palette.border,
    'editorIndentGuide.background': palette.borderSoft,
    'editorIndentGuide.activeBackground': palette.border,
    'editorGutter.background': editorBackground,
    'editorWidget.background': palette.elevated,
    'editorWidget.border': palette.border,
    'input.background': palette.bg,
    'input.border': palette.border,
    'input.foreground': palette.fg,
    'minimap.background': editorBackground,
    'minimapSlider.background': withAlpha(palette.meta, '40'),
    'minimapSlider.hoverBackground': withAlpha(palette.muted, '60'),
    'minimapSlider.activeBackground': withAlpha(palette.fg2, '80'),
    'scrollbarSlider.background': withAlpha(palette.meta, '40'),
    'scrollbarSlider.hoverBackground': withAlpha(palette.muted, '60'),
    'scrollbarSlider.activeBackground': withAlpha(palette.fg2, '80'),
    'editorOverviewRuler.border': '#00000000',
  };
}

ensureMonacoConfigured();

export interface YamlSourceEditorRef {
  formatDocument: () => Promise<void>;
  find: () => void;
  focus: () => void;
}

export interface YamlSourceEditorProps {
  value: string;
  onChange: (value: string) => void;
  loadingText: string;
  onSave?: () => void;
  themeId?: ThemeId;
  editorRef?: React.MutableRefObject<YamlSourceEditorRef | null>;
}

export const YamlSourceEditor: React.FC<YamlSourceEditorProps> = ({
  value,
  onChange,
  loadingText,
  onSave,
  themeId = 'omc-dark',
  editorRef,
}) => {
  const innerEditorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const activeTheme = themeId;

  const handleMount: OnMount = (editor) => {
    innerEditorRef.current = editor;

    // Explicitly associate model language with 'yaml'
    const model = editor.getModel();
    if (model) {
      monaco.editor.setModelLanguage(model, 'yaml');
    }

    // Register Ctrl+S / Cmd+S shortcut inside Monaco
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current?.();
    });

    // Register Ctrl+Shift+F / Cmd+Shift+F shortcut for format
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF,
      () => {
        void formatAction();
      }
    );
  };

  const formatAction = async () => {
    if (!innerEditorRef.current) return;
    const editor = innerEditorRef.current;
    const current = editor.getValue();
    const doc = parseDocument(current);
    if (doc.errors && doc.errors.length > 0) {
      throw new Error(doc.errors[0].message);
    }
    const action = editor.getAction('editor.action.formatDocument');
    if (action && action.isSupported()) {
      try {
        await action.run();
        return;
      } catch {
        // Fallback to YAML parseDocument toString
      }
    }

    const formatted = doc.toString();
    if (formatted !== current) {
      editor.setValue(formatted);
    }
  };

  const findAction = () => {
    const editor = innerEditorRef.current;
    if (!editor) return;
    editor.focus();
    const action = editor.getAction('actions.find');
    if (action) {
      void action.run();
    }
  };

  const focusAction = () => {
    innerEditorRef.current?.focus();
  };

  // Expose methods to parent ref
  useEffect(() => {
    if (editorRef) {
      editorRef.current = {
        formatDocument: formatAction,
        find: findAction,
        focus: focusAction,
      };
    }
  }, [editorRef]);

  return (
    <div className="config-monaco-shell">
      <Editor
        path="config.yaml"
        height="100%"
        language="yaml"
        theme={activeTheme}
        value={value}
        onChange={(val) => onChange(val ?? '')}
        onMount={handleMount}
        loading={
          <div className="config-monaco-loading">
            <span>{loadingText}</span>
          </div>
        }
        options={{
          fontFamily:
            '"Sarasa Mono SC", "Sarasa UI SC", "Sarasa Term SC", "更纱黑体 SC", monospace',
          fontSize: 13,
          lineHeight: 21,
          tabSize: 2,
          insertSpaces: true,
          detectIndentation: false,
          automaticLayout: true,
          scrollBeyondLastLine: false,
          wordWrap: 'off',
          minimap: {
            enabled: true,
            side: 'right',
            size: 'proportional',
            showSlider: 'always',
            renderCharacters: true,
            scale: 1,
            maxColumn: 100,
          },
          lineNumbers: 'on',
          lineNumbersMinChars: 4,
          folding: true,
          renderWhitespace: 'selection',
          renderLineHighlight: 'line',
          overviewRulerLanes: 2,
          overviewRulerBorder: false,
          hideCursorInOverviewRuler: false,
          bracketPairColorization: { enabled: true },
          guides: {
            indentation: true,
            bracketPairs: true,
          },
          scrollbar: {
            vertical: 'visible',
            horizontal: 'visible',
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10,
            useShadows: false,
            alwaysConsumeMouseWheel: false,
          },
          fixedOverflowWidgets: true,
        }}
      />
    </div>
  );
};

export default YamlSourceEditor;

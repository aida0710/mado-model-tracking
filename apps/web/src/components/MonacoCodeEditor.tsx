import { useEffect, useId, useRef, useState } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import { getFileLanguage } from '../lib/codeWorkspace';
import { text } from '../i18n/catalog';

self.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === 'json') return new JsonWorker();
    if (['css', 'scss', 'less'].includes(label)) return new CssWorker();
    if (['html', 'handlebars', 'razor'].includes(label)) return new HtmlWorker();
    if (['typescript', 'javascript'].includes(label)) return new TypeScriptWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });

export default function MonacoCodeEditor({ path, value, onChange, readOnly = false }: {
  path: string; value: string; onChange: (path: string, content: string) => void; readOnly?: boolean;
}) {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme);
  const [failure, setFailure] = useState(false);
  const editorId = useId();
  // Keep Undo inside each file, then release every model owned by this dialog.
  const visitedModelPaths = useRef(new Set<string>());
  const modelPath = monaco.Uri.from({ scheme: 'mmt-code', path: `/${editorId}/${path}` }).toString();
  visitedModelPaths.current.add(modelPath);
  useEffect(() => () => {
    for (const visitedPath of visitedModelPaths.current)
      monaco.editor.getModel(monaco.Uri.parse(visitedPath))?.dispose();
  }, []);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    void loader.init().catch(() => setFailure(true));
    return () => observer.disconnect();
  }, []);
  return failure ? <p className="notice error" role="alert">{text.editorUnavailable}</p> : (
    // A model switch can notify the previous onChange listener; keep each Editor bound to one path.
    <Editor key={modelPath} height="100%" path={modelPath} keepCurrentModel saveViewState={false}
      language={getFileLanguage(path)} value={value}
      theme={theme === 'dark' ? 'vs-dark' : 'light'} loading={text.loading}
      onChange={(content) => onChange(path, content ?? '')}
      options={{ readOnly, automaticLayout: true, minimap: { enabled: false },
        fontSize: 13, scrollBeyondLastLine: false, wordWrap: 'on',
        ariaLabel: `${text.codeEditor}: ${path}` }} />
  );
}

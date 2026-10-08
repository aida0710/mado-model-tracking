import { File, Folder } from 'lucide-react';
import { text } from '../i18n/catalog';

// One indentation step per directory keeps long nested paths readable.
const FILE_TREE_INDENT_PX = 14;

export function CodeFileTree({ paths, activePath, onSelect }: {
  paths: string[]; activePath: string; onSelect: (path: string) => void;
}) {
  const directories = new Set<string>();
  return (
    <nav className="code-file-tree" aria-label={text.files}>
      {paths.flatMap((path) => {
        const segments = path.split('/');
        const rows = [];
        for (let depth = 1; depth < segments.length; depth++) {
          const directory = segments.slice(0, depth).join('/');
          if (directories.has(directory)) continue;
          directories.add(directory);
          rows.push(<div key={`${directory}/`} className="code-directory"
            style={{ paddingInlineStart: `${(depth - 1) * FILE_TREE_INDENT_PX + 8}px` }}>
            <Folder size={13} /><span>{segments[depth - 1]}</span>
          </div>);
        }
        rows.push(<button type="button" key={path} title={path} aria-label={`${text.files}: ${path}`}
          aria-current={path === activePath ? 'true' : undefined} data-file-path={path}
          onClick={() => onSelect(path)} style={{ paddingInlineStart: `${(segments.length - 1) * FILE_TREE_INDENT_PX + 8}px` }}>
          <File size={13} /><span>{segments.at(-1)}</span>
        </button>);
        return rows;
      })}
    </nav>
  );
}

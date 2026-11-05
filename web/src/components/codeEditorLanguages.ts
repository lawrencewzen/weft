import type { Extension } from '@codemirror/state';

export function getFileExtension(path: string): string {
  const name = path.split('/').pop() || path;
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : '';
}

const langCache = new Map<string, Extension>();

export async function getLanguageExtension(filePath: string): Promise<Extension | null> {
  const ext = getFileExtension(filePath);
  if (!ext) return null;

  if (langCache.has(ext)) {
    return langCache.get(ext) ?? null;
  }

  let extension: Extension | null = null;
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs': {
      const { javascript } = await import('@codemirror/lang-javascript');
      extension = javascript();
      break;
    }
    case 'jsx': {
      const { javascript } = await import('@codemirror/lang-javascript');
      extension = javascript({ jsx: true });
      break;
    }
    case 'ts':
    case 'mts':
    case 'cts': {
      const { javascript } = await import('@codemirror/lang-javascript');
      extension = javascript({ typescript: true });
      break;
    }
    case 'tsx': {
      const { javascript } = await import('@codemirror/lang-javascript');
      extension = javascript({ jsx: true, typescript: true });
      break;
    }
    case 'json': {
      const { json } = await import('@codemirror/lang-json');
      extension = json();
      break;
    }
    case 'css': {
      const { css } = await import('@codemirror/lang-css');
      extension = css();
      break;
    }
    case 'html':
    case 'htm': {
      const { html } = await import('@codemirror/lang-html');
      extension = html();
      break;
    }
    case 'md':
    case 'markdown':
    case 'mdown':
    case 'mkd': {
      const { markdown } = await import('@codemirror/lang-markdown');
      extension = markdown();
      break;
    }
    case 'py': {
      const { python } = await import('@codemirror/lang-python');
      extension = python();
      break;
    }
    case 'yaml':
    case 'yml': {
      const { yaml } = await import('@codemirror/lang-yaml');
      extension = yaml();
      break;
    }
    default:
      return null;
  }

  if (extension) {
    langCache.set(ext, extension);
  }
  return extension;
}

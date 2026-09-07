import { useEffect } from 'react';

/** Sets `document.title` to `"<title> — AutoGenBook Studio"` for the lifetime of the calling route. */
export function useDocumentTitle(title?: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = title ? `${title} — AutoGenBook Studio` : 'AutoGenBook Studio';
    return () => {
      document.title = previous;
    };
  }, [title]);
}

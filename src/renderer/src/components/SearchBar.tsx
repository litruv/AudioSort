import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type SyntheticEvent
} from 'react';

type SuggestionType = 'author';

interface MetadataSuggestionPayload {
  authors: string[];
}

export interface SearchBarProps {
  value: string;
  onChange(value: string): void;
  onRescan(): Promise<void>;
  onFindDuplicates(): void;
  onOpenSettings(): void;
  metadataSuggestionsVersion: number;
}

/**
 * Top level search bar with quick access to rescanning and settings.
 */
export function SearchBar({ value, onChange, onRescan, onFindDuplicates, onOpenSettings, metadataSuggestionsVersion }: SearchBarProps): JSX.Element {
  const [draft, setDraft] = useState(value);
  const [caretIndex, setCaretIndex] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<MetadataSuggestionPayload>({ authors: [] });
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [rescanBusy, setRescanBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const refreshSuggestions = useCallback(async () => {
    setLoadingSuggestions(true);
    try {
      const result = await window.api.listMetadataSuggestions();
      setSuggestions({
        authors: result.authors
      });
    } catch (error) {
      console.error('Failed to load search suggestions', error);
    } finally {
      setLoadingSuggestions(false);
    }
  }, []);

  useEffect(() => {
    setSuggestions({ authors: [] });
    void refreshSuggestions();
  }, [refreshSuggestions, metadataSuggestionsVersion]);

  const analysisTarget = useMemo(() => {
    const cursor = caretIndex ?? draft.length;
    return draft.slice(0, cursor);
  }, [caretIndex, draft]);

  const activeToken = useMemo(() => {
    const match = analysisTarget.match(/(author):([^\s]*)$/i);
    if (!match) {
      return null;
    }
    const type = match[1].toLowerCase() as SuggestionType;
    return {
      type,
      term: match[2] ?? ''
    };
  }, [analysisTarget]);

  const filteredSuggestions = useMemo(() => {
    if (!activeToken) {
      return [] as string[];
    }
    const pool = suggestions.authors;
    const trimmedTerm = activeToken.term.trim();
    if (trimmedTerm.length === 0) {
      return pool.slice(0, 6);
    }
    const needle = trimmedTerm.toLowerCase();
    return pool
      .filter((entry) => entry.toLowerCase().includes(needle))
      .slice(0, 6);
  }, [activeToken, suggestions]);

  const activeSuggestions = useMemo(() => {
    if (!activeToken) {
      return [] as Array<{ type: SuggestionType; value: string }>;
    }
    return filteredSuggestions.map((value) => ({ type: activeToken.type, value }));
  }, [activeToken, filteredSuggestions]);

  const showSuggestions = activeToken !== null && activeSuggestions.length > 0;
  const showLoading = loadingSuggestions && activeToken !== null;

  const handleCaretUpdate = (event: SyntheticEvent<HTMLInputElement>) => {
    const target = event.currentTarget;
    setCaretIndex(target.selectionStart ?? target.value.length);
  };

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextValue = event.target.value;
    setDraft(nextValue);
    setCaretIndex(event.target.selectionStart ?? nextValue.length);
    onChange(nextValue);
  };

  const applySuggestion = (type: SuggestionType, suggestionValue: string) => {
    const previousValue = inputRef.current?.value ?? draft;
    const cursor = caretIndex ?? previousValue.length;
    const head = previousValue.slice(0, cursor);
    const tail = previousValue.slice(cursor);
    const pattern = new RegExp(`(${type}:)[^\s]*$`, 'i');
    let nextHead: string;
    if (pattern.test(head)) {
      nextHead = head.replace(pattern, `${type}:${suggestionValue}`);
    } else {
      const prefix = head.length === 0 || /\s$/.test(head) ? '' : ' ';
      nextHead = `${head}${prefix}${type}:${suggestionValue}`;
    }
    let nextValue = `${nextHead}${tail}`;
    let nextCursor = nextHead.length;
    if (tail.length > 0 && !/^\s/.test(tail)) {
      nextValue = `${nextHead} ${tail}`;
      nextCursor += 1;
    }
    setDraft(nextValue);
    setCaretIndex(nextCursor);
    onChange(nextValue);
    requestAnimationFrame(() => {
      const node = inputRef.current;
      if (node) {
        node.focus();
        node.setSelectionRange(nextCursor, nextCursor);
      }
    });
  };

  const handleSuggestionClick = (type: SuggestionType, suggestionValue: string) => {
    applySuggestion(type, suggestionValue);
  };

  const handleInputFocus = () => {
    if (!loadingSuggestions) {
      void refreshSuggestions();
    }
  };

  const handleRescanClick = async () => {
    setRescanBusy(true);
    try {
      await onRescan();
      await refreshSuggestions();
    } finally {
      setRescanBusy(false);
    }
  };

  return (
    <header className="search-bar">
      <div className="search-input-wrapper">
        <input
          ref={inputRef}
          className="search-input"
          placeholder="Search by name, tag, category, or author:"
          value={draft}
          onChange={handleInputChange}
          onSelect={handleCaretUpdate}
          onKeyUp={handleCaretUpdate}
          onFocus={handleInputFocus}
        />
        <div className="search-suggestions" aria-live="polite">
          {showLoading && <span className="search-suggestions__status">Loading suggestions…</span>}
          {showSuggestions && (
            <span className="search-suggestions__label">Suggestions:</span>
          )}
          {showSuggestions &&
            activeSuggestions.map((suggestion) => (
              <button
                key={`${suggestion.type}:${suggestion.value}`}
                type="button"
                className="search-suggestion"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => handleSuggestionClick(suggestion.type, suggestion.value)}
              >
                <span className="search-suggestion__type">{suggestion.type}:</span>
                <span className="search-suggestion__value">{suggestion.value}</span>
              </button>
            ))}
        </div>
      </div>
      <div className="search-actions">
        <button type="button" onClick={handleRescanClick} className="ghost-button" disabled={rescanBusy}>
          {rescanBusy ? 'Rescanning…' : 'Rescan'}
        </button>
        <button type="button" onClick={onFindDuplicates} className="ghost-button">
          Find Duplicates
        </button>
        <button type="button" onClick={onOpenSettings} className="ghost-button">
          Settings
        </button>
      </div>
    </header>
  );
}

export default SearchBar;

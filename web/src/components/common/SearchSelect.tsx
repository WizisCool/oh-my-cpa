import React from 'react';
import { Combobox, type ComboboxOption, type ComboboxProps, type ComboboxValue } from '@/components/ui/combobox';
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import clsx from 'clsx';
import { useT } from '../../i18n';
import { useIsNarrowViewport } from '../../hooks/useIsNarrowViewport';
import { useVisibleViewport } from '../../hooks/useVisibleViewport';
import { CheckOutlined, PlusOutlined } from '../icons';
import { SearchInput } from './SearchInput';
import styles from './SearchSelect.module.css';

type OptionValue = ComboboxValue;

type OptionGroup<OptionType> = { label?: React.ReactNode; options: OptionType[] };

function optionGroups<OptionType extends ComboboxOption>(options: OptionType[]): OptionGroup<OptionType>[] {
  if (!options.some((option) => Array.isArray(option.options))) return [{ options }];
  return options.map((option) =>
    Array.isArray(option.options)
      ? { label: option.label, options: option.options as OptionType[] }
      : { options: [option] },
  );
}

export type SearchSelectProps<
  ValueType = OptionValue | OptionValue[],
  OptionType extends ComboboxOption = ComboboxOption,
> = ComboboxProps<ValueType, OptionType> & {
  /** Names the field: the trigger's accessible name unless `aria-label` says otherwise, and the sheet's title. */
  label: string;
};

/** A sheet stops short of the top of what the reader can see, so the page it covers still shows. */
const SHEET_MAX_SHARE = 0.85;

/**
 * SearchSelect is a searchable select on every screen size.
 *
 * On desktop it renders `Combobox` anchored below its trigger. Below the narrow breakpoint it opens
 * a bottom sheet without raising the software keyboard on first tap; the keyboard appears only when
 * the reader taps the search field inside the sheet.
 */
export function SearchSelect<
  ValueType = OptionValue | OptionValue[],
  OptionType extends ComboboxOption = ComboboxOption,
>({
  label,
  'aria-label': ariaLabel,
  ...props
}: SearchSelectProps<ValueType, OptionType>) {
  const t = useT();
  const isSheet = useIsNarrowViewport();
  const [isOpen, setIsOpen] = React.useState(false);
  const [openedHeight, setOpenedHeight] = React.useState<number | null>(null);
  const viewport = useVisibleViewport(isSheet && isOpen);

  const isOpenRef = React.useRef(isOpen);
  isOpenRef.current = isOpen;
  const notifyOpenChangeRef = React.useRef(props.onOpenChange);
  notifyOpenChangeRef.current = props.onOpenChange;

  React.useEffect(() => {
    if (isSheet || !isOpenRef.current) return;
    setIsOpen(false);
    notifyOpenChangeRef.current?.(false);
  }, [isSheet]);

  const commonI18nProps = {
    searchPlaceholder: t('common.search'),
    emptyText: t('common.no_matches'),
    formatAddLabel: (val: string) => t('common.add_value', { value: val }),
  };

  if (!isSheet) {
    return (
      <Combobox<ValueType, OptionType>
        {...commonI18nProps}
        {...props}
        aria-label={ariaLabel ?? label}
      />
    );
  }

  const open = () => {
    setOpenedHeight(null);
    setIsOpen(true);
  };
  const close = () => {
    setIsOpen(false);
    props.onOpenChange?.(false);
    const search = typeof props.showSearch === 'object' ? props.showSearch : undefined;
    if (search?.searchValue) search.onSearch?.('');
  };
  const fit = Math.round(viewport.height * SHEET_MAX_SHARE);

  return (
    <>
      <Combobox<ValueType, OptionType>
        {...commonI18nProps}
        {...props}
        aria-label={ariaLabel ?? label}
        open={false}
        showSearch={false}
        onOpenChange={(next) => {
          if (!next) return;
          props.onOpenChange?.(true);
          open();
        }}
      />
      <Sheet
        open={isOpen}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <SheetContent
          side="bottom"
          zIndex={1055}
          destroyOnHidden
          className={styles['sheet']}
          style={{
            height: 'auto',
            maxHeight: fit,
            minHeight: openedHeight === null ? undefined : Math.min(openedHeight, fit),
            bottom: viewport.bottom,
          }}
        >
          <SheetHeader title={label} closeLabel={t('common.close')} />
          <SheetBody>
            <SheetPanel {...props} label={label} onOpened={setOpenedHeight} onPicked={close} />
          </SheetBody>
          {props.mode && (
            <SheetFooter>
              <SheetDone onDone={close} />
            </SheetFooter>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function SheetDone({ onDone }: { onDone: () => void }) {
  const t = useT();
  return (
    <Button variant="primary" block className={styles['done']} onClick={onDone}>
      {t('common.done')}
    </Button>
  );
}

type SheetPanelProps<ValueType, OptionType extends ComboboxOption> = SearchSelectProps<
  ValueType,
  OptionType
> & {
  onOpened: (height: number) => void;
  onPicked: () => void;
};

function SheetPanel<ValueType, OptionType extends ComboboxOption>({
  label,
  mode,
  value,
  options = [],
  showSearch,
  optionRender,
  notFoundContent,
  maxCount,
  open,
  tokenSeparators,
  onChange,
  onSelect,
  onDeselect,
  onOpened,
  onPicked,
}: SheetPanelProps<ValueType, OptionType>) {
  const t = useT();
  const search = typeof showSearch === 'object' ? showSearch : {};
  const [ownQuery, setOwnQuery] = React.useState('');
  const query = search.searchValue ?? ownQuery;
  const setQuery = (next: string) => {
    setOwnQuery(next);
    search.onSearch?.(next);
  };
  const isMultiple = mode === 'multiple' || mode === 'tags';
  const isSearchable = showSearch ?? true;
  const isInteractive = open !== false;
  const selected = React.useMemo<OptionValue[]>(
    () => (value === undefined || value === null ? [] : ([value].flat() as OptionValue[])),
    [value],
  );
  const groups = React.useMemo(() => optionGroups(options), [options]);

  const listed = React.useMemo(() => {
    if (mode !== 'tags') return groups;
    const known = new Set(options.map((option) => option.value));
    const typed = selected
      .filter((entry) => !known.has(entry))
      .map((entry) => ({ value: entry, label: String(entry) }) as OptionType);
    if (typed.length === 0) return groups;
    const [first, ...rest] = groups;
    return first ? [{ ...first, options: [...typed, ...first.options] }, ...rest] : [{ options: typed }];
  }, [groups, mode, options, selected]);

  const listedOptions = React.useMemo(() => listed.flatMap((group) => group.options), [listed]);
  const matchesQuery = React.useCallback(
    (option: OptionType) => {
      const trimmed = query.trim();
      if (!trimmed || search.filterOption === false) return true;
      if (typeof search.filterOption === 'function') return search.filterOption(query, option);
      const lower = trimmed.toLowerCase();
      const properties = search.optionFilterProp
        ? [search.optionFilterProp].flat()
        : ['label', 'value', 'title', 'searchText', 'search'];
      return properties.some((property) => String(option[property] ?? '').toLowerCase().includes(lower));
    },
    [query, search.filterOption, search.optionFilterProp],
  );

  const shownGroups = React.useMemo(
    () =>
      listed
        .map((group) => ({ ...group, options: group.options.filter(matchesQuery) }))
        .filter((group) => group.options.length > 0),
    [listed, matchesQuery],
  );

  const typed = query.trim();
  const isFull = maxCount !== undefined && selected.length >= maxCount;
  const canAdd =
    mode === 'tags' &&
    typed !== '' &&
    !isFull &&
    !listedOptions.some((option) => String(option.value) === typed);

  const pick = (option: OptionType) => {
    const picked = option.value as OptionValue;
    if (!isMultiple) {
      onChange?.(picked as ValueType, option);
      onSelect?.(picked as never, option);
      onPicked();
      return;
    }
    const isRemoval = selected.includes(picked);
    const next = isRemoval ? selected.filter((entry) => entry !== picked) : [...selected, picked];
    const byValue = new Map(listedOptions.map((entry) => [entry.value, entry]));
    onChange?.(
      next as ValueType,
      next.map((entry) => byValue.get(entry) ?? ({ value: entry, label: String(entry) } as OptionType)),
    );
    if (isRemoval) onDeselect?.(picked as never, option);
    else {
      onSelect?.(picked as never, option);
      if (search.autoClearSearchValue !== false) setQuery('');
    }
  };

  const add = () => {
    const parts =
      typeof tokenSeparators === 'function'
        ? tokenSeparators(typed)
        : (tokenSeparators ?? []).reduce(
            (pieces, separator) => pieces.flatMap((piece) => piece.split(separator)),
            [typed],
          );
    const added = [
      ...new Set(parts.map((part) => part.trim()).filter((part) => part !== '' && !selected.includes(part))),
    ];
    const room = maxCount === undefined ? Infinity : Math.max(0, maxCount - selected.length);
    const next = [...selected, ...added.slice(0, room)];
    onChange?.(
      next as ValueType,
      next.map((entry) => ({ value: entry, label: String(entry) }) as OptionType),
    );
    setQuery('');
  };

  const panelRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    const list = listRef.current;
    const wrapper = panelRef.current?.closest<HTMLElement>('[data-slot="sheet-content"]');
    if (!list || !wrapper) return undefined;
    const observer = new ResizeObserver(() => {
      if (list.clientHeight === 0) return;
      observer.disconnect();
      onOpened(wrapper.offsetHeight);
      const current = list.querySelector<HTMLElement>('[aria-selected="true"]');
      if (current) list.scrollTop = current.offsetTop - (list.clientHeight - current.offsetHeight) / 2;
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [onOpened]);

  return (
    <div ref={panelRef} className={styles['panel']}>
      {isInteractive && isSearchable && (
        <SearchInput
          className={styles['search']}
          label={t('common.search')}
          value={query}
          onChange={setQuery}
          onPressEnter={() => {
            if (canAdd) add();
          }}
        />
      )}
      <div
        ref={listRef}
        className={styles['list']}
        role="listbox"
        aria-label={label}
        aria-multiselectable={isMultiple || undefined}
      >
        {isInteractive && canAdd && (
          <button
            type="button"
            role="option"
            aria-selected={false}
            className={styles['option']}
            onClick={add}
          >
            <span className={styles['option-label']}>{t('common.add_value', { value: typed })}</span>
            <PlusOutlined className={styles['option-mark']} aria-hidden="true" />
          </button>
        )}
        {shownGroups.map((group, groupIndex) => (
          <React.Fragment key={groupIndex}>
            {group.label !== undefined && group.label !== null && (
              <div className={styles['group']} role="presentation">
                {group.label}
              </div>
            )}
            {group.options.map((option, index) => {
              const isSelected = selected.includes(option.value as OptionValue);
              return (
                <button
                  key={String(option.value)}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={!isInteractive || option.disabled || (isFull && !isSelected)}
                  className={clsx(styles['option'], isSelected && styles['option-selected'])}
                  onClick={() => pick(option)}
                >
                  <span className={styles['option-label']}>
                    {optionRender
                      ? optionRender(
                          {
                            key: String(option.value),
                            label: option.label,
                            value: option.value as OptionValue,
                            data: option,
                          },
                          { index },
                        )
                      : option.label}
                  </span>
                  {isSelected && <CheckOutlined className={styles['option-mark']} aria-hidden="true" />}
                </button>
              );
            })}
          </React.Fragment>
        ))}
        {shownGroups.length === 0 && !canAdd && (
          <div className={styles['empty']}>{notFoundContent ?? t('common.no_matches')}</div>
        )}
      </div>
    </div>
  );
}

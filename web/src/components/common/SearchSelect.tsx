import React from 'react';
import { Button, Drawer, Select } from 'antd';
import type { SelectProps } from 'antd';
import type { DefaultOptionType } from 'antd/es/select';
import clsx from 'clsx';
import { useT } from '../../i18n';
import { useIsNarrowViewport } from '../../hooks/useIsNarrowViewport';
import { useVisibleViewport } from '../../hooks/useVisibleViewport';
import { CheckOutlined, PlusOutlined } from '../icons';
import { SearchInput } from './SearchInput';
import styles from './SearchSelect.module.css';

type OptionValue = string | number;

/**
 * The antd props a sheet cannot honour are refused at the type, so a caller meets them when it
 * builds rather than as a blank row on a phone: an object-valued selection (`labelInValue`), a
 * selection the caller never sees (`defaultValue`), and options read through renamed fields.
 */
export type SearchSelectProps<ValueType, OptionType extends DefaultOptionType> =
  Omit<SelectProps<ValueType, OptionType>, 'labelInValue' | 'defaultValue' | 'fieldNames'> & {
    /** Names the field: the trigger's accessible name unless `aria-label` says otherwise, and the sheet's title. */
    label: string;
  };

/** A sheet stops short of the top of what the reader can see, so the page it covers still shows. */
const SHEET_MAX_SHARE = 0.85;

/**
 * SearchSelect is a `Select` the reader can narrow by typing, on every screen size.
 *
 * On a desktop it is antd's `Select` as given. Below the shell's narrow breakpoint it opens a bottom
 * sheet instead of a popup. The popup is anchored under its field and sized for a pointer: on a
 * touch screen the tap that opens it also focuses its search field, the software keyboard rises
 * over the list it just opened, and what is left can be neither read nor scrolled. The sheet opens
 * without the keyboard; its list is an ordinary scroller at finger height, and the keyboard comes
 * only when the reader taps the search field, with the sheet riding above it.
 */
export function SearchSelect<ValueType = OptionValue | OptionValue[], OptionType extends DefaultOptionType = DefaultOptionType>({
  label,
  'aria-label': ariaLabel,
  ...props
}: SearchSelectProps<ValueType, OptionType>) {
  const t = useT();
  const isSheet = useIsNarrowViewport();
  const [isOpen, setIsOpen] = React.useState(false);
  // The sheet keeps the height it opened at while the reader narrows the list, so the search field
  // does not slide under their thumb with every letter; it gives way only to the keyboard.
  const [openedHeight, setOpenedHeight] = React.useState<number | null>(null);
  const viewport = useVisibleViewport(isSheet && isOpen);
  if (!isSheet) return <Select<ValueType, OptionType> {...props} aria-label={ariaLabel ?? label} />;

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
  return <>
    <Select<ValueType, OptionType>
      {...props}
      aria-label={ariaLabel ?? label}
      // The field only names the value here. Without its own search it focuses no editable input,
      // so the tap that opens the sheet raises no keyboard.
      open={false}
      showSearch={false}
      // The caller's open is still its own: a picker refreshes what it lists when the reader opens it.
      onOpenChange={(next) => {
        if (!next) return;
        props.onOpenChange?.(true);
        open();
      }}
    />
    <Drawer
      rootClassName={styles['sheet']}
      placement="bottom"
      title={label}
      open={isOpen}
      onClose={close}
      destroyOnHidden
      closable={{ placement: 'end', 'aria-label': t('common.close') }}
      footer={props.mode ? <SheetDone onDone={close} /> : undefined}
      styles={{
        // The sheet is as tall as its list, up to most of the visible viewport. Once open it holds
        // that height as a floor, and iOS leaves the layout viewport under the keyboard, so it
        // stands on the visible one.
        wrapper: {
          height: 'auto',
          maxHeight: fit,
          minHeight: openedHeight === null ? undefined : Math.min(openedHeight, fit),
          bottom: viewport.bottom,
        },
      }}
    >
      <SheetPanel {...props} label={label} onOpened={setOpenedHeight} onPicked={close} />
    </Drawer>
  </>;
}

function SheetDone({ onDone }: { onDone: () => void }) {
  const t = useT();
  return <Button type="primary" block className={styles['done']} onClick={onDone}>{t('common.done')}</Button>;
}

type SheetPanelProps<ValueType, OptionType extends DefaultOptionType> = SearchSelectProps<ValueType, OptionType> & {
  /** Receives the sheet's height once the drawer first shows it. */
  onOpened: (height: number) => void;
  onPicked: () => void;
};

function SheetPanel<ValueType, OptionType extends DefaultOptionType>({
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
  // antd searches a multiple or tags select unless told otherwise.
  const isSearchable = showSearch ?? isMultiple;
  // A field without a list of its own - the free-form tag editor - has nothing to pick; nothing
  // here may open or select on it.
  const isInteractive = open !== false;
  const selected = React.useMemo<OptionValue[]>(() => (value === undefined || value === null ? [] : [value].flat() as OptionValue[]), [value]);

  // A value typed in tags mode has no option of its own, and antd lists it with the options.
  const listed = React.useMemo(() => {
    if (mode !== 'tags') return options;
    const known = new Set(options.map((option) => option.value));
    return [...selected.filter((entry) => !known.has(entry)).map((entry) => ({ value: entry, label: String(entry) }) as OptionType), ...options];
  }, [mode, options, selected]);
  const shown = React.useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed || search.filterOption === false) return listed;
    if (typeof search.filterOption === 'function') {
      const filter = search.filterOption;
      return listed.filter((option) => filter(query, option));
    }
    // antd's default: the named properties, or the value, contain the text in any case.
    const lower = trimmed.toLowerCase();
    const properties = [search.optionFilterProp ?? 'value'].flat();
    return listed.filter((option) => properties.some((property) => String(option[property] ?? '').toLowerCase().includes(lower)));
  }, [listed, query, search.filterOption, search.optionFilterProp]);
  const typed = query.trim();
  const isFull = maxCount !== undefined && selected.length >= maxCount;
  const canAdd = mode === 'tags' && typed !== '' && !isFull && !listed.some((option) => String(option.value) === typed);

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
    const byValue = new Map(listed.map((entry) => [entry.value, entry]));
    onChange?.(next as ValueType, next.map((entry) => byValue.get(entry) ?? ({ value: entry, label: String(entry) } as OptionType)));
    if (isRemoval) onDeselect?.(picked as never, option);
    else {
      onSelect?.(picked as never, option);
      // A pick finishes in the same way it does in the popup: the search is spent, and the next
      // choice starts from the full list rather than from the text that found the last one.
      if (search.autoClearSearchValue !== false) setQuery('');
    }
  };
  const add = () => {
    const parts = typeof tokenSeparators === 'function'
      ? tokenSeparators(typed)
      : (tokenSeparators ?? []).reduce((pieces, separator) => pieces.flatMap((piece) => piece.split(separator)), [typed]);
    const added = [...new Set(parts.map((part) => part.trim()).filter((part) => part !== '' && !selected.includes(part)))];
    const room = maxCount === undefined ? Infinity : Math.max(0, maxCount - selected.length);
    const next = [...selected, ...added.slice(0, room)];
    onChange?.(next as ValueType, next.map((entry) => ({ value: entry, label: String(entry) }) as OptionType));
    setQuery('');
  };

  const panelRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  // The content mounts before the drawer shows it, so both readings wait for the list's first size:
  // the sheet's height, measured once on the unfiltered list, and the current choice brought into
  // view mid-list rather than wherever the list starts. Both land before that frame is painted.
  React.useLayoutEffect(() => {
    const list = listRef.current;
    const wrapper = panelRef.current?.closest<HTMLElement>('.ant-drawer-content-wrapper');
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
  }, []);

  return <div ref={panelRef} className={styles['panel']}>
    {isInteractive && isSearchable && <SearchInput className={styles['search']} label={t('common.search')} value={query} onChange={setQuery} />}
    <div ref={listRef} className={styles['list']} role="listbox" aria-label={label} aria-multiselectable={isMultiple || undefined}>
      {isInteractive && canAdd && <button type="button" role="option" aria-selected={false} className={styles['option']} onClick={add}>
        <span className={styles['option-label']}>{t('common.add_value', { value: typed })}</span>
        <PlusOutlined className={styles['option-mark']} aria-hidden="true" />
      </button>}
      {shown.map((option, index) => {
        const isSelected = selected.includes(option.value as OptionValue);
        return <button
          key={String(option.value)}
          type="button"
          role="option"
          aria-selected={isSelected}
          disabled={!isInteractive || option.disabled || (isFull && !isSelected)}
          className={clsx(styles['option'], isSelected && styles['option-selected'])}
          onClick={() => pick(option)}
        >
          <span className={styles['option-label']}>
            {optionRender ? optionRender({ key: String(option.value), label: option.label, value: option.value as OptionValue, data: option }, { index }) : option.label}
          </span>
          {isSelected && <CheckOutlined className={styles['option-mark']} aria-hidden="true" />}
        </button>;
      })}
      {shown.length === 0 && !canAdd && <div className={styles['empty']}>{notFoundContent ?? t('common.no_matches')}</div>}
    </div>
  </div>;
}

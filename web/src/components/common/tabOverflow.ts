import type { TabsProps } from 'antd';

/**
 * A tab strip's overflow menu, opened by a press. On hover it opened under a tap too, and a menu that
 * appears on the hover a tap produces is a change iOS answers by dropping the tap's click. Passed to
 * every `Tabs`: Ant Design's `ConfigProvider` takes only the menu's icon, not its trigger.
 */
export const TAB_OVERFLOW: TabsProps['more'] = { trigger: ['click'] };

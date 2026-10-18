import { Select, type SelectOption } from '../../components/ui/Select';
export type SortOption = SelectOption;

export function SortSelect({ options, value, disabled, hint }: { options: SortOption[]; value: string; disabled?: boolean; hint?: string }) {
  return <Select key={value} name="sort" label="Sort" options={options} defaultValue={value} disabled={disabled} hint={hint} autoSubmit />;
}

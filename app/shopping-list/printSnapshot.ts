export const SHOPPING_PRINT_SNAPSHOT_KEY = "planotto:shopping-print-snapshot";

export interface ShoppingPrintItem {
  id: string;
  name: string;
  amountLabel: string;
  purchased: boolean;
}

export interface ShoppingPrintSection {
  id: string;
  title: string;
  items: ShoppingPrintItem[];
}

export interface ShoppingPrintSnapshot {
  title: string;
  periodLabel: string;
  sourceLabel: string;
  generatedAt: string;
  sections: ShoppingPrintSection[];
}

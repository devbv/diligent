import { describe, expect, test } from "bun:test";
import type { ListPickerItem } from "../list-picker";
import { ListPicker } from "../list-picker";

// Key sequences from packages/cli/src/tui/framework/keys.ts
const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_ENTER = "\r";
const KEY_ESCAPE = "\x1b";
const KEY_CTRL_C = "\x03";
const KEY_BACKSPACE = "\x7f";

function makeItems(count: number): ListPickerItem[] {
  return Array.from({ length: count }, (_, i) => ({
    label: `Item ${i + 1}`,
    value: `val-${i + 1}`,
  }));
}

function makeItemsWithDesc(): ListPickerItem[] {
  return [
    { label: "Alpha", description: "First letter", value: "alpha" },
    { label: "Beta", description: "Second letter", value: "beta" },
    { label: "Gamma", description: "Third letter", value: "gamma" },
  ];
}

describe("ListPicker", () => {
  describe("rendering", () => {
    test("renders with title and items", () => {
      const picker = new ListPicker({ title: "Pick one", items: makeItems(3) }, () => {});
      const lines = picker.render(80);
      const text = lines.join("\n");
      expect(text).toContain("Pick one");
      expect(text).toContain("Item 1");
      expect(text).toContain("Item 2");
      expect(text).toContain("Item 3");
    });

    test("shows selected item with marker", () => {
      const picker = new ListPicker({ title: "Pick", items: makeItems(3) }, () => {});
      const lines = picker.render(80);
      const text = lines.join("\n");
      // First item should be selected by default (has ▸ marker)
      expect(text).toContain("▸");
    });

    test("empty items show 'No items'", () => {
      const picker = new ListPicker({ title: "Empty", items: [] }, () => {});
      const lines = picker.render(80);
      const text = lines.join("\n");
      expect(text).toContain("No items");
    });

    test("renders item descriptions", () => {
      const picker = new ListPicker({ title: "Described", items: makeItemsWithDesc() }, () => {});
      const lines = picker.render(120);
      const text = lines.join("\n");
      expect(text).toContain("Alpha");
      expect(text).toContain("First letter");
    });

    test("has top and bottom borders", () => {
      const picker = new ListPicker({ title: "Borders", items: makeItems(2) }, () => {});
      const lines = picker.render(80);
      expect(lines[0]).toContain("┌");
      expect(lines[lines.length - 1]).toContain("└");
    });
  });

  describe("navigation", () => {
    test("down arrow moves selection down", () => {
      const picker = new ListPicker({ title: "Nav", items: makeItems(3) }, () => {});

      // Initially first item selected
      let lines = picker.render(80);
      // Find the line with the marker
      const markerLine1 = lines.find((l) => l.includes("▸"));
      expect(markerLine1).toContain("Item 1");

      // Press down
      picker.handleInput(KEY_DOWN);
      lines = picker.render(80);
      const markerLine2 = lines.find((l) => l.includes("▸"));
      expect(markerLine2).toContain("Item 2");
    });

    test("up arrow moves selection up", () => {
      const picker = new ListPicker({ title: "Nav", items: makeItems(3), selectedIndex: 2 }, () => {});

      let lines = picker.render(80);
      const markerLine1 = lines.find((l) => l.includes("▸"));
      expect(markerLine1).toContain("Item 3");

      picker.handleInput(KEY_UP);
      lines = picker.render(80);
      const markerLine2 = lines.find((l) => l.includes("▸"));
      expect(markerLine2).toContain("Item 2");
    });

    test("does not go below last item", () => {
      const picker = new ListPicker({ title: "Nav", items: makeItems(3), selectedIndex: 2 }, () => {});

      picker.handleInput(KEY_DOWN);
      const lines = picker.render(80);
      const markerLine = lines.find((l) => l.includes("▸"));
      expect(markerLine).toContain("Item 3");
    });

    test("does not go above first item", () => {
      const picker = new ListPicker({ title: "Nav", items: makeItems(3), selectedIndex: 0 }, () => {});

      picker.handleInput(KEY_UP);
      const lines = picker.render(80);
      const markerLine = lines.find((l) => l.includes("▸"));
      expect(markerLine).toContain("Item 1");
    });
  });

  describe("selection", () => {
    test("enter selects current item and calls onResult with value", () => {
      let result: string | null | undefined;
      const picker = new ListPicker({ title: "Select", items: makeItems(3) }, (val) => {
        result = val;
      });

      picker.handleInput(KEY_ENTER);
      expect(result).toBe("val-1");
    });

    test("enter after navigation selects correct item", () => {
      let result: string | null | undefined;
      const picker = new ListPicker({ title: "Select", items: makeItems(3) }, (val) => {
        result = val;
      });

      picker.handleInput(KEY_DOWN);
      picker.handleInput(KEY_DOWN);
      picker.handleInput(KEY_ENTER);
      expect(result).toBe("val-3");
    });

    test("escape cancels and calls onResult with null", () => {
      let result: string | null | undefined;
      const picker = new ListPicker({ title: "Cancel", items: makeItems(3) }, (val) => {
        result = val;
      });

      picker.handleInput(KEY_ESCAPE);
      expect(result).toBeNull();
    });

    test("ctrl+c cancels and calls onResult with null", () => {
      let result: string | null | undefined;
      const picker = new ListPicker({ title: "Cancel", items: makeItems(3) }, (val) => {
        result = val;
      });

      picker.handleInput(KEY_CTRL_C);
      expect(result).toBeNull();
    });

    test("enter with no items calls onResult with null", () => {
      let result: string | null | undefined;
      const picker = new ListPicker({ title: "Empty", items: [] }, (val) => {
        result = val;
      });

      picker.handleInput(KEY_ENTER);
      expect(result).toBeNull();
    });
  });

  describe("filtering", () => {
    test("typing characters filters items", () => {
      const items: ListPickerItem[] = [
        { label: "Apple", value: "apple" },
        { label: "Banana", value: "banana" },
        { label: "Cherry", value: "cherry" },
      ];
      const picker = new ListPicker({ title: "Fruit", items }, () => {});

      picker.handleInput("a"); // Filter by "a"
      const lines = picker.render(80);
      const text = lines.join("\n");
      expect(text).toContain("Apple");
      expect(text).toContain("Banana"); // "Banana" contains "a"
      expect(text).not.toContain("Cherry"); // "Cherry" does not contain "a"
      expect(text).toContain("Filter: a");
    });

    test("backspace removes filter character", () => {
      const items: ListPickerItem[] = [
        { label: "Apple", value: "apple" },
        { label: "Banana", value: "banana" },
        { label: "Cherry", value: "cherry" },
      ];
      const picker = new ListPicker({ title: "Fruit", items }, () => {});

      picker.handleInput("c");
      picker.handleInput("h");
      let lines = picker.render(80);
      let text = lines.join("\n");
      expect(text).toContain("Cherry");
      expect(text).not.toContain("Apple");

      // Backspace to "c"
      picker.handleInput(KEY_BACKSPACE);
      lines = picker.render(80);
      text = lines.join("\n");
      expect(text).toContain("Cherry"); // still matches "c"
    });

    test("shows 'No matches' when filter eliminates all items", () => {
      const items: ListPickerItem[] = [
        { label: "Apple", value: "apple" },
        { label: "Banana", value: "banana" },
      ];
      const picker = new ListPicker({ title: "Fruit", items }, () => {});

      picker.handleInput("z");
      picker.handleInput("z");
      picker.handleInput("z");
      const lines = picker.render(80);
      const text = lines.join("\n");
      expect(text).toContain("No matches");
    });

    test("selection resets when filter changes", () => {
      const items: ListPickerItem[] = [
        { label: "Alpha", value: "alpha" },
        { label: "Beta", value: "beta" },
        { label: "Gamma", value: "gamma" },
      ];
      let result: string | null | undefined;
      const picker = new ListPicker({ title: "Greek", items, selectedIndex: 2 }, (val) => {
        result = val;
      });

      // selectedIndex=2 means Gamma is selected; filtering resets selection
      picker.handleInput("b"); // Only "Beta" matches
      picker.handleInput(KEY_ENTER);
      expect(result).toBe("beta");
    });

    test("filters by description too", () => {
      const items: ListPickerItem[] = [
        { label: "Model A", description: "fast", value: "a" },
        { label: "Model B", description: "slow", value: "b" },
      ];
      const picker = new ListPicker({ title: "Models", items }, () => {});

      picker.handleInput("s");
      picker.handleInput("l");
      picker.handleInput("o");
      picker.handleInput("w");
      const lines = picker.render(120);
      const text = lines.join("\n");
      expect(text).toContain("Model B");
      expect(text).not.toContain("Model A");
    });
  });

  describe("scrolling", () => {
    test("scrolls when items exceed maxVisible", () => {
      const picker = new ListPicker({ title: "Scroll", items: makeItems(6), maxVisible: 3 }, () => {});

      // Initially items 1-3 visible, no scroll indicator up
      let lines = picker.render(80);
      let text = lines.join("\n");
      expect(text).toContain("Item 1");
      expect(text).toContain("Item 2");
      expect(text).toContain("Item 3");
      expect(text).toContain("↓"); // scroll-down indicator
      expect(text).not.toContain("↑"); // no scroll-up indicator

      // Navigate down past visible range
      picker.handleInput(KEY_DOWN); // select Item 2
      picker.handleInput(KEY_DOWN); // select Item 3
      picker.handleInput(KEY_DOWN); // select Item 4, triggers scroll

      lines = picker.render(80);
      text = lines.join("\n");
      expect(text).toContain("Item 4");
      expect(text).toContain("↑"); // now has scroll-up indicator
    });

    test("scrolls up when navigating above visible range", () => {
      const picker = new ListPicker(
        { title: "Scroll", items: makeItems(6), maxVisible: 3, selectedIndex: 5 },
        () => {},
      );

      // Start at bottom, should show items 4-6
      let lines = picker.render(80);
      let text = lines.join("\n");
      expect(text).toContain("Item 6");

      // Navigate up past visible range
      picker.handleInput(KEY_UP); // Item 5
      picker.handleInput(KEY_UP); // Item 4
      picker.handleInput(KEY_UP); // Item 3, triggers scroll up

      lines = picker.render(80);
      text = lines.join("\n");
      expect(text).toContain("Item 3");
    });
  });
});
